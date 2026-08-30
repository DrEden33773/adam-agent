import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
} from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
  ModelDriver,
  ModelEvent,
  ModelMessage,
  ModelRequest,
} from "./agent-session-contracts.js";
import { modelMessagesWithApprovedPlanProjectionV1 } from "./approved-plan-projection.js";
import { ModelDriverError } from "./model-driver-error.js";
import { projectModelToolDefinitions } from "./model-tool-schema-projection.js";

const maximumNormalizedTextBytes = 512 * 1024;
const maximumNormalizedReasoningBytes = 512 * 1024;
const maximumToolArgumentBytes = 2 * 1024 * 1024;
const maximumToolCallCount = 128;
const maximumToolCallIdBytes = 1_024;
const maximumToolNameBytes = 256;
const maximumStreamChunkCount = 100_000;

export type OpenAICompatibleModelDriverOptions = {
  readonly profile: "deepseek";
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly maximumOutputTokens: number;
  readonly deadlineMs?: number;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export class OpenAICompatibleModelDriver implements ModelDriver {
  readonly #client: OpenAI;
  readonly #deadlineMs: number;
  readonly #maximumOutputTokens: number;
  readonly #model: string;
  readonly #sensitiveValues: readonly string[];

  constructor(options: OpenAICompatibleModelDriverOptions) {
    if (options.profile !== "deepseek") {
      throw new RangeError("The OpenAI-compatible provider profile is not supported.");
    }
    const deadlineMs = options.deadlineMs ?? 120_000;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError("The model request deadline must be a positive safe integer.");
    }
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: options.fetch,
      logLevel: "off",
      maxRetries: 0,
      timeout: deadlineMs,
    });
    this.#deadlineMs = deadlineMs;
    this.#maximumOutputTokens = options.maximumOutputTokens;
    this.#model = options.model;
    this.#sensitiveValues = [options.apiKey];
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const attemptController = new AbortController();
    let deadlineExpired = false;
    const abortFromCaller = () => attemptController.abort(request.signal.reason);
    if (request.signal.aborted) {
      abortFromCaller();
    } else {
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      attemptController.abort(new Error("The model provider request reached its deadline."));
    }, this.#deadlineMs);
    try {
      yield* this.#stream({ ...request, signal: attemptController.signal });
      if (deadlineExpired) {
        throw createDeadlineError();
      }
      if (request.signal.aborted) {
        throw createAbortedError();
      }
    } catch (error) {
      if (deadlineExpired) {
        throw createDeadlineError(error);
      }
      if (request.signal.aborted) {
        throw createAbortedError(error);
      }
      if (error instanceof ModelDriverError) {
        throw error;
      }
      throw classifyModelDriverError(error, this.#sensitiveValues);
    } finally {
      clearTimeout(deadlineTimer);
      request.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async *#stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const messages = modelMessagesWithApprovedPlanProjectionV1(request).map((message) =>
      mapMessage(message, this.#model.startsWith("deepseek-v4-")),
    );
    const tools: ChatCompletionTool[] = projectModelToolDefinitions(
      request.tools,
      "deepseek-function-parameters-v1",
    ).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    const stream = await this.#client.chat.completions.create(
      {
        messages,
        model: this.#model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: Math.min(request.maximumOutputTokens, this.#maximumOutputTokens),
        ...(tools.length === 0 ? {} : { tools }),
      },
      { signal: request.signal },
    );
    let finishReason:
      | "stop"
      | "tool_calls"
      | "length"
      | "content_filter"
      | "resource_exhausted"
      | "unknown"
      | undefined;
    let rawFinishReason: string | undefined;
    let usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
    let chunkCount = 0;
    let normalizedTextBytes = 0;
    let normalizedReasoningBytes = 0;
    let reasoningStarted = false;
    let toolArgumentBytes = 0;
    const toolCalls = new Map<
      number,
      {
        id: string;
        name: string;
        readonly argumentFragments: string[];
      }
    >();

    for await (const chunk of stream) {
      chunkCount += 1;
      assertWithinLimit(chunkCount, maximumStreamChunkCount);
      assertCanonicalChoicePayload(chunk);
      if (chunk.usage !== null && chunk.usage !== undefined) {
        const detailedUsage = chunk.usage as typeof chunk.usage & {
          readonly prompt_cache_hit_tokens?: unknown;
          readonly prompt_cache_miss_tokens?: unknown;
          readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
        };
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          ...(typeof detailedUsage.completion_tokens_details?.reasoning_tokens === "number"
            ? { reasoningTokens: detailedUsage.completion_tokens_details.reasoning_tokens }
            : {}),
          ...(typeof detailedUsage.prompt_cache_hit_tokens === "number"
            ? { cachedInputTokens: detailedUsage.prompt_cache_hit_tokens }
            : {}),
          ...(typeof detailedUsage.prompt_cache_miss_tokens === "number"
            ? { cacheMissInputTokens: detailedUsage.prompt_cache_miss_tokens }
            : {}),
        };
      }
      for (const choice of chunk.choices) {
        const reasoningContent = (
          choice.delta as typeof choice.delta & { readonly reasoning_content?: unknown }
        ).reasoning_content;
        if (typeof reasoningContent === "string") {
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield {
              type: "reasoning_start",
              id: "provider-reasoning-0",
              artifactType: "provider_reasoning",
            };
          }
          normalizedReasoningBytes = addBytesWithinLimit(
            normalizedReasoningBytes,
            reasoningContent,
            maximumNormalizedReasoningBytes,
          );
          yield { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoningContent };
        }
        if (choice.delta.content !== null && choice.delta.content !== undefined) {
          normalizedTextBytes = addBytesWithinLimit(
            normalizedTextBytes,
            choice.delta.content,
            maximumNormalizedTextBytes,
          );
          yield { type: "text_delta", text: choice.delta.content };
        }
        const providerFinishReason = choice.finish_reason as string | null;
        if (
          providerFinishReason === "stop" ||
          providerFinishReason === "tool_calls" ||
          providerFinishReason === "length" ||
          providerFinishReason === "content_filter"
        ) {
          finishReason = providerFinishReason;
          rawFinishReason = providerFinishReason.slice(0, 128);
        } else if (providerFinishReason === "insufficient_system_resource") {
          finishReason = "resource_exhausted";
          rawFinishReason = providerFinishReason.slice(0, 128);
        } else if (providerFinishReason !== null) {
          finishReason = "unknown";
          rawFinishReason = providerFinishReason.slice(0, 128);
        }
        for (const fragment of choice.delta.tool_calls ?? []) {
          if (!toolCalls.has(fragment.index)) {
            assertWithinLimit(toolCalls.size + 1, maximumToolCallCount);
          }
          const call = toolCalls.get(fragment.index) ?? {
            id: "",
            name: "",
            argumentFragments: [],
          };
          call.id += fragment.id ?? "";
          call.name += fragment.function?.name ?? "";
          assertWithinLimit(Buffer.byteLength(call.id, "utf8"), maximumToolCallIdBytes);
          assertWithinLimit(Buffer.byteLength(call.name, "utf8"), maximumToolNameBytes);
          if (fragment.function?.arguments !== undefined) {
            toolArgumentBytes = addBytesWithinLimit(
              toolArgumentBytes,
              fragment.function.arguments,
              maximumToolArgumentBytes,
            );
            call.argumentFragments.push(fragment.function.arguments);
          }
          toolCalls.set(fragment.index, call);
        }
      }
    }

    const orderedToolCalls = [...toolCalls].sort(([left], [right]) => left - right);
    if (orderedToolCalls.some(([, call]) => call.id.length === 0 || call.name.length === 0)) {
      throw new ModelDriverError(
        "protocol_incompatibility",
        "The model provider returned an incomplete tool call.",
        { cause: undefined },
      );
    }
    for (const [, call] of orderedToolCalls) {
      yield { type: "tool_call_start", id: call.id, name: call.name };
      for (const json of call.argumentFragments) {
        yield { type: "tool_call_delta", id: call.id, json };
      }
      yield { type: "tool_call_end", id: call.id };
    }
    if (reasoningStarted) {
      yield { type: "reasoning_end", id: "provider-reasoning-0" };
    }
    if (usage !== undefined) {
      yield { type: "usage", ...usage };
    }
    if (finishReason !== undefined) {
      yield { type: "finish", reason: finishReason, rawReason: rawFinishReason };
    }
  }
}

function addBytesWithinLimit(currentBytes: number, value: string, maximumBytes: number): number {
  const nextBytes = currentBytes + Buffer.byteLength(value, "utf8");
  assertWithinLimit(nextBytes, maximumBytes);
  return nextBytes;
}

function assertWithinLimit(value: number, maximum: number): void {
  if (value > maximum) {
    throw new ModelDriverError(
      "protocol_incompatibility",
      "The model provider response exceeded Adam's stream limit.",
      { cause: undefined },
    );
  }
}

function assertCanonicalChoicePayload(chunk: unknown): void {
  if (typeof chunk !== "object" || chunk === null || !("choices" in chunk)) {
    throw invalidChoicePayloadError();
  }
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length > 1) {
    throw invalidChoicePayloadError();
  }
  const choice = choices[0];
  if (choice === undefined) {
    return;
  }
  if (
    typeof choice !== "object" ||
    choice === null ||
    !("index" in choice) ||
    choice.index !== 0 ||
    !("delta" in choice) ||
    typeof choice.delta !== "object" ||
    choice.delta === null ||
    !("finish_reason" in choice) ||
    (choice.finish_reason !== null && typeof choice.finish_reason !== "string")
  ) {
    throw invalidChoicePayloadError();
  }
  const delta = choice.delta as {
    readonly content?: unknown;
    readonly reasoning_content?: unknown;
    readonly tool_calls?: unknown;
  };
  if (
    !isOptionalNullableString(delta.content) ||
    !isOptionalNullableString(delta.reasoning_content)
  ) {
    throw invalidChoicePayloadError();
  }
  const toolCallFragments = delta.tool_calls;
  if (toolCallFragments !== undefined && toolCallFragments !== null) {
    if (!Array.isArray(toolCallFragments) || !toolCallFragments.every(isToolCallFragment)) {
      throw invalidChoicePayloadError();
    }
  }
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isToolCallFragment(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("index" in value) ||
    !Number.isSafeInteger(value.index) ||
    (value.index as number) < 0 ||
    !("id" in value ? isOptionalNullableString(value.id) : true)
  ) {
    return false;
  }
  if (!("function" in value) || value.function === undefined || value.function === null) {
    return true;
  }
  if (typeof value.function !== "object") {
    return false;
  }
  return (
    (!("name" in value.function) || isOptionalNullableString(value.function.name)) &&
    (!("arguments" in value.function) || isOptionalNullableString(value.function.arguments))
  );
}

function invalidChoicePayloadError(): ModelDriverError {
  return new ModelDriverError(
    "protocol_incompatibility",
    "The model provider returned an invalid choice payload.",
    { cause: undefined },
  );
}

function classifyModelDriverError(
  error: unknown,
  sensitiveValues: readonly string[],
): ModelDriverError {
  if (error instanceof APIUserAbortError) {
    return new ModelDriverError("aborted", "The model provider request was aborted.", {
      cause: error,
    });
  }
  if (error instanceof AuthenticationError) {
    return new ModelDriverError(
      "authentication",
      "The model provider rejected authentication.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIError && error.status === 402) {
    return new ModelDriverError(
      "billing",
      "The model provider account has insufficient balance.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIError && error.status === 403) {
    return new ModelDriverError(
      "authorization",
      "The model provider denied access to the request.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIError && error.status === 429) {
    return new ModelDriverError(
      "rate_limit",
      "The model provider rate limit was reached.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIError && (error.status === 400 || error.status === 422)) {
    return new ModelDriverError(
      "invalid_request",
      "The model provider rejected the request as invalid.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIError && error.status !== undefined && error.status >= 500) {
    return new ModelDriverError(
      "provider",
      "The model provider failed to complete the request.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof APIConnectionError) {
    return new ModelDriverError("transport", "The model provider connection failed.", {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new ModelDriverError(
      "unknown",
      "The model provider returned an unrecognized error response.",
      apiErrorOptions(error, sensitiveValues),
    );
  }
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return new ModelDriverError(
      "protocol_incompatibility",
      "The model provider returned an invalid streaming response.",
      { cause: error },
    );
  }
  return new ModelDriverError("unknown", "The model provider request failed.", {
    cause: error,
  });
}

function createDeadlineError(cause?: unknown): ModelDriverError {
  return new ModelDriverError("timeout", "The model provider request reached its deadline.", {
    cause,
  });
}

function createAbortedError(cause?: unknown): ModelDriverError {
  return new ModelDriverError("aborted", "The model provider request was aborted.", {
    cause,
  });
}

function apiErrorOptions(
  error: APIError,
  sensitiveValues: readonly string[],
): {
  readonly cause: unknown;
  readonly status?: number | undefined;
  readonly providerCode?: string | undefined;
  readonly requestId?: string | undefined;
  readonly responseSummary?: string | undefined;
} {
  return {
    cause: error,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === null || error.code === undefined
      ? {}
      : { providerCode: redactSensitiveValues(error.code, sensitiveValues).slice(0, 128) }),
    ...(error.requestID === null || error.requestID === undefined
      ? {}
      : { requestId: redactSensitiveValues(error.requestID, sensitiveValues).slice(0, 128) }),
    ...summarizeApiError(error, sensitiveValues),
  };
}

function summarizeApiError(
  error: APIError,
  sensitiveValues: readonly string[],
): { readonly responseSummary?: string } {
  if (
    typeof error.error === "object" &&
    error.error !== null &&
    "message" in error.error &&
    typeof error.error.message === "string"
  ) {
    return {
      responseSummary: redactSensitiveValues(error.error.message, sensitiveValues).slice(0, 512),
    };
  }
  return {};
}

function redactSensitiveValues(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues
    .filter((sensitiveValue) => sensitiveValue.length > 0)
    .reduce((redacted, sensitiveValue) => redacted.split(sensitiveValue).join("[REDACTED]"), value);
}

function mapMessage(message: ModelMessage, isDeepSeekV4: boolean): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "developer":
      return {
        role: "system",
        content: `Developer instruction:\n${message.content}`,
      };
    case "user":
      if (typeof message.content !== "string") {
        throw new ModelDriverError(
          "protocol_incompatibility",
          "The selected OpenAI-compatible transport does not accept explicit user images.",
          { cause: undefined },
        );
      }
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.reasoning === undefined
          ? isDeepSeekV4
            ? { reasoning_content: "" }
            : {}
          : { reasoning_content: message.reasoning }),
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.callId,
        content: JSON.stringify(message.result),
      };
  }
}
