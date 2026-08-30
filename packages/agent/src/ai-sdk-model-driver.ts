import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import type { ModelDriver, ModelEvent, ModelRequest } from "./agent-session-contracts.js";
import { modelMessagesWithApprovedPlanProjectionV1 } from "./approved-plan-projection.js";
import { maximumModelResponseContentBytes } from "./durable-model-response-policy.js";
import { ModelDriverError } from "./model-driver-error.js";
import type { ThinkingPolicyMappingV1 } from "./thinking-policy.js";

const maximumToolArgumentBytes = 2 * 1024 * 1024;
const maximumToolCallCount = 128;
const maximumToolCallIdBytes = 1_024;
const maximumToolNameBytes = 256;
const maximumReasoningIdBytes = 1_024;
const maximumStreamPartCount = 2_000_000;

type StreamNormalization = {
  activeReasoningIds: Set<string>;
  pendingReasoningEndIds: Set<string>;
  reasoningIds: Map<string, string>;
  activeToolCallIds: Set<string>;
  contentBytes: number;
  toolArgumentBytes: number;
  toolCallCount: number;
  streamPartCount: number;
};

export class AiSdkModelDriver implements ModelDriver {
  readonly #deadlineMs: number;
  readonly #maximumOutputTokens: number;
  readonly #model: LanguageModelV4;
  readonly #providerOptions: SharedV4ProviderOptions | undefined;
  readonly #sideCallThinkingPolicies:
    | Readonly<Partial<Record<"title" | "compaction", ThinkingPolicyMappingV1>>>
    | undefined;
  readonly #sensitiveValues: readonly string[];

  constructor(options: {
    readonly model: LanguageModelV4;
    readonly maximumOutputTokens: number;
    readonly deadlineMs: number;
    readonly providerOptions?: SharedV4ProviderOptions | undefined;
    readonly sideCallThinkingPolicies?: Readonly<
      Partial<Record<"title" | "compaction", ThinkingPolicyMappingV1>>
    >;
    readonly sensitiveValues: readonly string[];
  }) {
    this.#deadlineMs = options.deadlineMs;
    this.#model = options.model;
    this.#maximumOutputTokens = options.maximumOutputTokens;
    this.#providerOptions = options.providerOptions;
    this.#sideCallThinkingPolicies = options.sideCallThinkingPolicies;
    this.#sensitiveValues = options.sensitiveValues;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const attemptController = new AbortController();
    let deadlineExpired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const abortFromCaller = () => attemptController.abort(request.signal.reason);
    if (request.signal.aborted) {
      abortFromCaller();
    } else {
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const armDeadline = () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        attemptController.abort(new Error("The model provider request reached its deadline."));
      }, this.#deadlineMs);
    };
    armDeadline();
    let normalization: StreamNormalization | undefined;
    try {
      const providerOptions = providerOptionsForRequest(
        this.#providerOptions,
        request,
        this.#sideCallThinkingPolicies,
      );
      const result = await this.#model.doStream({
        prompt: mapPrompt(request),
        maxOutputTokens: Math.min(request.maximumOutputTokens, this.#maximumOutputTokens),
        abortSignal: attemptController.signal,
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map(
                (tool): LanguageModelV4FunctionTool => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
                }),
              ),
            }),
      });

      normalization = {
        activeReasoningIds: new Set(),
        pendingReasoningEndIds: new Set(),
        reasoningIds: new Map(),
        activeToolCallIds: new Set(),
        contentBytes: 0,
        toolArgumentBytes: 0,
        toolCallCount: 0,
        streamPartCount: 0,
      };
      for await (const part of result.stream) {
        normalization.streamPartCount += 1;
        assertWithinLimit(normalization.streamPartCount, maximumStreamPartCount);
        if (isIgnoredStructuralPart(part)) {
          continue;
        }
        const events = [...mapStreamPart(part, normalization)];
        if (part.type === "finish") {
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
          }
        } else if (isAcceptedProgressPart(part)) {
          armDeadline();
        }
        yield* events;
      }
      yield* endActiveReasoning(normalization);
      if (deadlineExpired) {
        throw new ModelDriverError("timeout", "The model provider request reached its deadline.", {
          cause: undefined,
        });
      }
    } catch (error) {
      if (normalization !== undefined) {
        yield* endPendingReasoning(normalization);
      }
      if (deadlineExpired) {
        throw new ModelDriverError("timeout", "The model provider request reached its deadline.", {
          cause: error,
        });
      }
      if (request.signal.aborted) {
        throw new ModelDriverError("aborted", "The model provider request was aborted.", {
          cause: error,
        });
      }
      if (error instanceof ModelDriverError) {
        throw error;
      }
      throw classifyAiSdkError(error, this.#sensitiveValues);
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      request.signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function providerOptionsForRequest(
  configured: SharedV4ProviderOptions | undefined,
  request: ModelRequest,
  sideCallThinkingPolicies:
    | Readonly<Partial<Record<"title" | "compaction", ThinkingPolicyMappingV1>>>
    | undefined,
): SharedV4ProviderOptions | undefined {
  const sideCallMapping =
    request.purpose === "title" || request.purpose === "compaction"
      ? sideCallThinkingPolicies?.[request.purpose]
      : undefined;
  const mapping = sideCallMapping ?? request.thinkingPolicy?.mapping;
  if (mapping === undefined) {
    return configured;
  }
  const { deepseek: configuredDeepSeek } = configured ?? {};
  const deepSeekRecord =
    configuredDeepSeek !== null &&
    typeof configuredDeepSeek === "object" &&
    !Array.isArray(configuredDeepSeek)
      ? configuredDeepSeek
      : {};
  const { thinking: _thinking, reasoningEffort: _reasoningEffort, ...preserved } = deepSeekRecord;
  return {
    ...configured,
    deepseek: {
      ...preserved,
      thinking: { type: mapping.thinkingType },
      ...(mapping.thinkingType === "disabled" ? {} : { reasoningEffort: mapping.reasoningEffort }),
    },
  };
}

function isIgnoredStructuralPart(part: LanguageModelV4StreamPart): boolean {
  switch (part.type) {
    case "response-metadata":
    case "text-start":
    case "text-end":
      return true;
    default:
      return false;
  }
}

function mapPrompt(request: ModelRequest): LanguageModelV4Prompt {
  return modelMessagesWithApprovedPlanProjectionV1(request).map(mapMessage);
}

function mapMessage(message: ModelRequest["messages"][number]): LanguageModelV4Message {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "developer":
      return { role: "system", content: `Developer instruction:\n${message.content}` };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.map((part) =>
                part.type === "text"
                  ? { type: "text" as const, text: part.text }
                  : {
                      type: "file" as const,
                      data: { type: "data" as const, data: part.bytes },
                      mediaType: part.mediaType,
                    },
              ),
      };
    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(message.reasoning === undefined
            ? []
            : [{ type: "reasoning" as const, text: message.reasoning }]),
          { type: "text", text: message.content },
          ...message.toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: parseToolInput(call.argumentsJson),
          })),
        ],
      };
    case "tool":
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.callId,
            toolName: message.name,
            output: { type: "text", value: JSON.stringify(message.result) },
          },
        ],
      };
  }
}

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch (error) {
    throw new ModelDriverError(
      "protocol_incompatibility",
      "Adam could not replay invalid model tool arguments through the Vercel provider.",
      { cause: error },
    );
  }
}

function* mapStreamPart(
  part: LanguageModelV4StreamPart,
  normalization: StreamNormalization,
): Iterable<ModelEvent> {
  switch (part.type) {
    case "stream-start":
      if (part.warnings.length > 0) {
        throw unsupportedPromptError("warning");
      }
      return;
    case "response-metadata":
    case "text-end":
      return;
    case "text-start":
      yield* endActiveReasoning(normalization);
      return;
    case "reasoning-start":
      assertWithinLimit(Buffer.byteLength(part.id, "utf8"), maximumReasoningIdBytes);
      if (normalization.reasoningIds.has(part.id)) {
        if (!normalization.pendingReasoningEndIds.delete(part.id)) {
          throw invalidReasoningStreamError();
        }
        normalization.activeReasoningIds.add(part.id);
        return;
      }
      normalization.reasoningIds.set(
        part.id,
        `provider-reasoning-${normalization.reasoningIds.size}`,
      );
      normalization.activeReasoningIds.add(part.id);
      yield {
        type: "reasoning_start",
        id: normalization.reasoningIds.get(part.id) as string,
        artifactType: "provider_reasoning",
      };
      return;
    case "reasoning-end":
      if (!normalization.activeReasoningIds.delete(part.id)) {
        throw invalidReasoningStreamError();
      }
      normalization.pendingReasoningEndIds.add(part.id);
      return;
    case "text-delta":
      yield* endActiveReasoning(normalization);
      normalization.contentBytes = addBytesWithinLimit(
        normalization.contentBytes,
        part.delta,
        maximumModelResponseContentBytes,
      );
      yield { type: "text_delta", text: part.delta };
      return;
    case "reasoning-delta":
      if (!normalization.activeReasoningIds.has(part.id)) {
        assertWithinLimit(Buffer.byteLength(part.id, "utf8"), maximumReasoningIdBytes);
        if (normalization.reasoningIds.has(part.id)) {
          throw invalidReasoningStreamError();
        }
        normalization.reasoningIds.set(
          part.id,
          `provider-reasoning-${normalization.reasoningIds.size}`,
        );
        normalization.activeReasoningIds.add(part.id);
        yield {
          type: "reasoning_start",
          id: normalization.reasoningIds.get(part.id) as string,
          artifactType: "provider_reasoning",
        };
      }
      normalization.contentBytes = addBytesWithinLimit(
        normalization.contentBytes,
        part.delta,
        maximumModelResponseContentBytes,
      );
      yield {
        type: "reasoning_delta",
        id: normalization.reasoningIds.get(part.id) as string,
        text: part.delta,
      };
      return;
    case "tool-input-start":
      if (part.providerExecuted === true) {
        throw unsupportedPromptError("provider-executed tool");
      }
      normalization.toolCallCount += 1;
      assertWithinLimit(normalization.toolCallCount, maximumToolCallCount);
      assertWithinLimit(Buffer.byteLength(part.id, "utf8"), maximumToolCallIdBytes);
      assertWithinLimit(Buffer.byteLength(part.toolName, "utf8"), maximumToolNameBytes);
      if (normalization.activeToolCallIds.has(part.id)) {
        throw invalidToolStreamError();
      }
      normalization.activeToolCallIds.add(part.id);
      yield { type: "tool_call_start", id: part.id, name: part.toolName };
      return;
    case "tool-input-delta":
      if (!normalization.activeToolCallIds.has(part.id)) {
        throw invalidToolStreamError();
      }
      normalization.toolArgumentBytes = addBytesWithinLimit(
        normalization.toolArgumentBytes,
        part.delta,
        maximumToolArgumentBytes,
      );
      yield { type: "tool_call_delta", id: part.id, json: part.delta };
      return;
    case "tool-input-end":
      if (!normalization.activeToolCallIds.delete(part.id)) {
        throw invalidToolStreamError();
      }
      yield { type: "tool_call_end", id: part.id };
      return;
    case "tool-call":
      if (part.providerExecuted === true) {
        throw unsupportedPromptError("provider-executed tool");
      }
      return;
    case "error":
      throw new ModelDriverError(
        "protocol_incompatibility",
        `The Vercel provider returned an invalid stream part (${errorKind(part.error)}).`,
        { cause: part.error },
      );
    case "finish": {
      yield* endActiveReasoning(normalization);
      const inputTokens = part.usage.inputTokens.total;
      const outputTokens = part.usage.outputTokens.total;
      if (inputTokens !== undefined && outputTokens !== undefined) {
        const reasoningTokens =
          readNestedNumber(part.usage.raw, ["completion_tokens_details", "reasoning_tokens"]) ??
          positiveNumber(part.usage.outputTokens.reasoning);
        const cachedInputTokens =
          readNestedNumber(part.usage.raw, ["prompt_cache_hit_tokens"]) ??
          positiveNumber(part.usage.inputTokens.cacheRead);
        const cacheMissInputTokens = readNestedNumber(part.usage.raw, ["prompt_cache_miss_tokens"]);
        yield {
          type: "usage",
          inputTokens,
          outputTokens,
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
        };
      }
      yield {
        type: "finish",
        reason: mapFinishReason(part.finishReason),
        ...(part.finishReason.raw === undefined
          ? {}
          : { rawReason: part.finishReason.raw.slice(0, 128) }),
      };
      return;
    }
    default:
      throw unsupportedPromptError(part.type);
  }
}

function isAcceptedProgressPart(part: LanguageModelV4StreamPart): boolean {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-delta":
      return Buffer.byteLength(part.delta, "utf8") > 0;
    case "tool-input-start":
    case "tool-input-end":
      return true;
    default:
      return false;
  }
}

function invalidToolStreamError(): ModelDriverError {
  return new ModelDriverError(
    "protocol_incompatibility",
    "The model provider returned an invalid tool-call stream sequence.",
    { cause: undefined },
  );
}

function invalidReasoningStreamError(): ModelDriverError {
  return new ModelDriverError(
    "protocol_incompatibility",
    "The model provider returned an invalid reasoning stream sequence.",
    { cause: undefined },
  );
}

function* endActiveReasoning(normalization: StreamNormalization): Iterable<ModelEvent> {
  yield* endPendingReasoning(normalization);
  for (const providerId of normalization.activeReasoningIds) {
    yield {
      type: "reasoning_end",
      id: normalization.reasoningIds.get(providerId) as string,
    };
  }
  normalization.activeReasoningIds.clear();
}

function* endPendingReasoning(normalization: StreamNormalization): Iterable<ModelEvent> {
  for (const providerId of normalization.pendingReasoningEndIds) {
    yield {
      type: "reasoning_end",
      id: normalization.reasoningIds.get(providerId) as string,
    };
  }
  normalization.pendingReasoningEndIds.clear();
}

function addBytesWithinLimit(current: number, value: string, maximum: number): number {
  const next = current + Buffer.byteLength(value, "utf8");
  assertWithinLimit(next, maximum);
  return next;
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

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

function readNestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return typeof current === "number" && Number.isFinite(current) && current >= 0
    ? current
    : undefined;
}

function errorKind(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) {
    return error.name.slice(0, 64);
  }
  return "unknown";
}

function classifyAiSdkError(error: unknown, sensitiveValues: readonly string[]): ModelDriverError {
  if (APICallError.isInstance(error)) {
    const options = apiCallErrorOptions(error, sensitiveValues);
    if (error.statusCode === 401) {
      return new ModelDriverError(
        "authentication",
        "The model provider rejected authentication.",
        options,
      );
    }
    if (error.statusCode === 402) {
      return new ModelDriverError(
        "billing",
        "The model provider account has insufficient balance.",
        options,
      );
    }
    if (error.statusCode === 403) {
      return new ModelDriverError(
        "authorization",
        "The model provider denied access to the request.",
        options,
      );
    }
    if (error.statusCode === 429) {
      return new ModelDriverError(
        "rate_limit",
        "The model provider rate limit was reached.",
        options,
      );
    }
    if (error.statusCode === 400 || error.statusCode === 422) {
      return new ModelDriverError(
        "invalid_request",
        "The model provider rejected the request as invalid.",
        options,
      );
    }
    if (error.statusCode !== undefined && error.statusCode >= 500) {
      return new ModelDriverError(
        "provider",
        "The model provider failed to complete the request.",
        options,
      );
    }
    if (error.statusCode === undefined) {
      return new ModelDriverError("transport", "The model provider connection failed.", options);
    }
    return new ModelDriverError(
      "unknown",
      "The model provider returned an unrecognized error response.",
      options,
    );
  }
  return new ModelDriverError("unknown", "The model provider request failed.", { cause: error });
}

function apiCallErrorOptions(
  error: APICallError,
  sensitiveValues: readonly string[],
): {
  readonly cause: unknown;
  readonly status?: number | undefined;
  readonly providerCode?: string | undefined;
  readonly requestId?: string | undefined;
  readonly responseSummary?: string | undefined;
} {
  const providerError = readProviderError(error.data);
  const requestId =
    error.responseHeaders?.["x-request-id"] ?? error.responseHeaders?.["request-id"];
  return {
    cause: error,
    ...(error.statusCode === undefined ? {} : { status: error.statusCode }),
    ...(providerError.code === undefined
      ? {}
      : { providerCode: redact(providerError.code, sensitiveValues).slice(0, 128) }),
    ...(requestId === undefined
      ? {}
      : { requestId: redact(requestId, sensitiveValues).slice(0, 128) }),
    ...(providerError.message === undefined
      ? {}
      : { responseSummary: redact(providerError.message, sensitiveValues).slice(0, 512) }),
  };
}

function readProviderError(data: unknown): {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
} {
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return {};
  }
  const error = data.error;
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const code =
    "code" in error && (typeof error.code === "string" || typeof error.code === "number")
      ? String(error.code)
      : undefined;
  const message =
    "message" in error && typeof error.message === "string" ? error.message : undefined;
  return { code, message };
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues
    .filter((sensitiveValue) => sensitiveValue.length > 0)
    .reduce((redacted, sensitiveValue) => redacted.split(sensitiveValue).join("[REDACTED]"), value);
}

function mapFinishReason(finishReason: {
  readonly unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  readonly raw: string | undefined;
}): "stop" | "length" | "content_filter" | "tool_calls" | "resource_exhausted" | "unknown" {
  if (finishReason.raw === "insufficient_system_resource") {
    return "resource_exhausted";
  }
  switch (finishReason.unified) {
    case "stop":
    case "length":
      return finishReason.unified;
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    case "error":
    case "other":
      return "unknown";
  }
}

function unsupportedPromptError(feature?: string): ModelDriverError {
  return new ModelDriverError(
    "protocol_incompatibility",
    feature === undefined
      ? "The Vercel provider returned or required an unsupported model feature."
      : `The Vercel provider returned an unsupported ${feature} stream part.`,
    { cause: undefined },
  );
}
