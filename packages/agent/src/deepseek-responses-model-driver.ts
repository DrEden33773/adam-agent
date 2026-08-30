import type {
  ModelDriver,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelUserContentPart,
} from "./agent-session-contracts.js";
import { modelMessagesWithApprovedPlanProjectionV1 } from "./approved-plan-projection.js";
import { maximumModelResponseContentBytes } from "./durable-model-response-policy.js";
import { ModelDriverError } from "./model-driver-error.js";
import { projectModelToolDefinitions } from "./model-tool-schema-projection.js";

const maximumSseFrameBytes = 2 * 1024 * 1024;
const maximumToolArgumentBytes = 2 * 1024 * 1024;
const maximumToolCallCount = 128;
const maximumToolItemIdBytes = 1_024;
const maximumToolCallIdBytes = 1_024;
const maximumToolNameBytes = 256;

export type DirectDeepSeekResponsesModelDriverOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly maximumOutputTokens: number;
  readonly deadlineMs?: number;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export class DirectDeepSeekResponsesModelDriver implements ModelDriver {
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #deadlineMs: number;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #maximumOutputTokens: number;
  readonly #model: string;

  constructor(options: DirectDeepSeekResponsesModelDriverOptions) {
    const deadlineMs = options.deadlineMs ?? 120_000;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError("The model request deadline must be a positive safe integer.");
    }
    this.#apiKey = options.apiKey;
    this.#baseURL = options.baseURL.replace(/\/$/u, "");
    this.#deadlineMs = deadlineMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maximumOutputTokens = options.maximumOutputTokens;
    this.#model = options.model;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    let deadlineExpired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) {
      abort();
    } else {
      request.signal.addEventListener("abort", abort, { once: true });
    }
    const armDeadline = () => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        controller.abort(new Error("The model provider request reached its deadline."));
      }, this.#deadlineMs);
    };
    armDeadline();
    try {
      const response = await this.#fetch(`${this.#baseURL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(mapRequest(request, this.#model, this.#maximumOutputTokens)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await responseError(response, this.#apiKey);
      }
      if (response.body === null) {
        throw protocolError("The model provider returned an empty streaming response.");
      }
      for await (const event of normalizeResponsesEvents(
        readServerSentEvents(response.body, controller.signal),
        this.#apiKey,
      )) {
        if (event.type === "finish") {
          if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
          }
        } else if (isAcceptedProgressEvent(event)) {
          armDeadline();
        }
        yield event;
      }
      if (deadlineExpired) {
        throw new ModelDriverError("timeout", "The model provider request reached its deadline.", {
          cause: undefined,
        });
      }
      if (request.signal.aborted) {
        throw abortedError();
      }
    } catch (error) {
      if (deadlineExpired) {
        throw new ModelDriverError("timeout", "The model provider request reached its deadline.", {
          cause: error,
        });
      }
      if (request.signal.aborted) {
        throw abortedError(error);
      }
      if (error instanceof ModelDriverError) {
        throw error;
      }
      if (error instanceof TypeError) {
        throw new ModelDriverError("transport", "The model provider connection failed.", {
          cause: error,
        });
      }
      throw new ModelDriverError("unknown", "The model provider request failed.", {
        cause: error,
      });
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      request.signal.removeEventListener("abort", abort);
    }
  }
}

function mapRequest(request: ModelRequest, model: string, maximumOutputTokens: number) {
  return {
    model,
    input: modelMessagesWithApprovedPlanProjectionV1(request).flatMap(mapMessage),
    max_output_tokens: Math.min(request.maximumOutputTokens, maximumOutputTokens),
    stream: true,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: projectModelToolDefinitions(request.tools, "deepseek-function-parameters-v1").map(
            (tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            }),
          ),
        }),
    ...(request.thinkingPolicy === undefined
      ? {}
      : { reasoning: { effort: mapReasoningEffort(request.thinkingPolicy) } }),
  };
}

function mapMessage(message: ModelMessage): readonly unknown[] {
  switch (message.role) {
    case "system":
    case "developer":
      return [{ role: message.role, content: message.content }];
    case "user":
      return [
        {
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map(mapInputContentPart),
        },
      ];
    case "assistant":
      return [
        ...(message.reasoning === undefined || message.reasoning.length === 0
          ? []
          : [
              {
                type: "reasoning",
                content: [{ type: "reasoning_text", text: message.reasoning }],
              },
            ]),
        ...(message.content.length === 0
          ? []
          : [
              {
                role: "assistant",
                content: [{ type: "output_text", text: message.content, annotations: [] }],
              },
            ]),
        ...message.toolCalls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.argumentsJson,
        })),
      ];
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: message.callId,
          output:
            message.content === undefined
              ? JSON.stringify(message.result)
              : message.content.map(mapInputContentPart),
        },
      ];
  }
}

function mapInputContentPart(part: ModelUserContentPart) {
  return part.type === "text"
    ? { type: "input_text", text: part.text }
    : {
        type: "input_image",
        detail: "auto",
        image_url: `data:${part.mediaType};base64,${Buffer.from(part.bytes).toString("base64")}`,
      };
}

function mapReasoningEffort(policy: NonNullable<ModelRequest["thinkingPolicy"]>) {
  return policy.mapping.thinkingType === "disabled" ? "none" : policy.mapping.reasoningEffort;
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let eventCount = 0;
  let completed = false;
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => rejectAborted(signal.reason ?? new DOMException("Aborted", "AbortError"));
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      buffered += decoder.decode(value, { stream: !done });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) {
          eventCount += 1;
          if (eventCount > 100_000 || Buffer.byteLength(data, "utf8") > maximumSseFrameBytes) {
            throw protocolError("The model provider response exceeded Adam's stream limit.");
          }
          try {
            yield JSON.parse(data) as unknown;
          } catch (error) {
            throw protocolError("The model provider returned invalid SSE JSON.", error);
          }
        }
        boundary = buffered.indexOf("\n\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > maximumSseFrameBytes) {
        throw protocolError("The model provider response exceeded Adam's stream limit.");
      }
      if (done) {
        completed = true;
        break;
      }
    }
    if (buffered.trim().length > 0) {
      throw protocolError("The model provider ended with an incomplete SSE frame.");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) {
      await reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function* normalizeResponsesEvents(
  events: AsyncIterable<unknown>,
  sensitiveValue: string,
): AsyncIterable<ModelEvent> {
  let reasoningStarted = false;
  let terminal = false;
  const calls = new Map<string, { readonly callId: string; readonly name: string }>();
  const callIds = new Set<string>();
  let contentBytes = 0;
  let toolArgumentBytes = 0;
  let toolCallCount = 0;
  for await (const value of events) {
    if (typeof value !== "object" || value === null || !("type" in value)) {
      throw protocolError("The model provider returned an invalid semantic event.");
    }
    const event = value as {
      readonly type: unknown;
      readonly delta?: unknown;
      readonly item?: unknown;
      readonly item_id?: unknown;
      readonly response?: unknown;
    };
    switch (event.type) {
      case "response.reasoning_text.delta":
        if (typeof event.delta !== "string") {
          throw protocolError("The model provider returned invalid reasoning text.");
        }
        contentBytes = addBoundedBytes(contentBytes, event.delta, maximumModelResponseContentBytes);
        if (!reasoningStarted) {
          reasoningStarted = true;
          yield {
            type: "reasoning_start",
            id: "provider-reasoning-0",
            artifactType: "provider_reasoning",
          };
        }
        yield { type: "reasoning_delta", id: "provider-reasoning-0", text: event.delta };
        break;
      case "response.output_text.delta":
        if (typeof event.delta !== "string") {
          throw protocolError("The model provider returned invalid output text.");
        }
        contentBytes = addBoundedBytes(contentBytes, event.delta, maximumModelResponseContentBytes);
        yield { type: "text_delta", text: event.delta };
        break;
      case "response.output_item.added": {
        const item = event.item as
          | {
              readonly type?: unknown;
              readonly id?: unknown;
              readonly call_id?: unknown;
              readonly name?: unknown;
            }
          | undefined;
        if (
          item?.type === "function_call" &&
          typeof item.id === "string" &&
          typeof item.call_id === "string" &&
          typeof item.name === "string"
        ) {
          if (
            item.id.length === 0 ||
            item.call_id.length === 0 ||
            item.name.length === 0 ||
            Buffer.byteLength(item.id, "utf8") > maximumToolItemIdBytes ||
            Buffer.byteLength(item.call_id, "utf8") > maximumToolCallIdBytes ||
            Buffer.byteLength(item.name, "utf8") > maximumToolNameBytes ||
            calls.has(item.id) ||
            callIds.has(item.call_id)
          ) {
            throw protocolError("The model provider returned invalid function-call identity.");
          }
          toolCallCount += 1;
          if (toolCallCount > maximumToolCallCount) {
            throw protocolError("The model provider response exceeded Adam's tool-call limit.");
          }
          calls.set(item.id, { callId: item.call_id, name: item.name });
          callIds.add(item.call_id);
          yield { type: "tool_call_start", id: item.call_id, name: item.name };
        } else if (item?.type === "function_call") {
          throw protocolError("The model provider returned invalid function-call identity.");
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = typeof event.item_id === "string" ? calls.get(event.item_id) : undefined;
        if (call === undefined || typeof event.delta !== "string") {
          throw protocolError("The model provider returned invalid function arguments.");
        }
        toolArgumentBytes = addBoundedBytes(
          toolArgumentBytes,
          event.delta,
          maximumToolArgumentBytes,
        );
        yield { type: "tool_call_delta", id: call.callId, json: event.delta };
        break;
      }
      case "response.output_item.done": {
        const item = event.item as { readonly id?: unknown; readonly type?: unknown } | undefined;
        const call = typeof item?.id === "string" ? calls.get(item.id) : undefined;
        if (call !== undefined) {
          yield { type: "tool_call_end", id: call.callId };
          calls.delete(item?.id as string);
        } else if (item?.type === "function_call") {
          throw protocolError("The model provider ended an unknown function call.");
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        if (terminal) {
          throw protocolError("The model provider returned more than one terminal response event.");
        }
        terminal = true;
        if (calls.size > 0) {
          throw protocolError("The model provider ended with an incomplete function call.");
        }
        if (reasoningStarted) {
          yield { type: "reasoning_end", id: "provider-reasoning-0" };
        }
        const response = event.response as
          | {
              readonly usage?: unknown;
              readonly status?: unknown;
              readonly error?: unknown;
              readonly incomplete_details?: unknown;
            }
          | undefined;
        if (event.type === "response.failed") {
          const error = response?.error as
            | { readonly code?: unknown; readonly message?: unknown }
            | undefined;
          throw new ModelDriverError("provider", "The model provider failed the response.", {
            cause: undefined,
            ...(typeof error?.code === "string"
              ? {
                  providerCode: error.code.split(sensitiveValue).join("[REDACTED]").slice(0, 128),
                }
              : {}),
            ...(typeof error?.message === "string"
              ? {
                  responseSummary: error.message
                    .split(sensitiveValue)
                    .join("[REDACTED]")
                    .slice(0, 512),
                }
              : {}),
          });
        }
        const usage = response?.usage as
          | {
              readonly input_tokens?: unknown;
              readonly output_tokens?: unknown;
              readonly input_tokens_details?: unknown;
              readonly output_tokens_details?: unknown;
            }
          | undefined;
        if (usage !== undefined) {
          if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
            throw protocolError("The model provider returned invalid usage.");
          }
          yield {
            type: "usage",
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            ...(typeof (
              usage.input_tokens_details as { readonly cached_tokens?: unknown } | undefined
            )?.cached_tokens === "number"
              ? {
                  cachedInputTokens: (
                    usage.input_tokens_details as { readonly cached_tokens: number }
                  ).cached_tokens,
                }
              : {}),
            ...(typeof (
              usage.output_tokens_details as { readonly reasoning_tokens?: unknown } | undefined
            )?.reasoning_tokens === "number"
              ? {
                  reasoningTokens: (
                    usage.output_tokens_details as { readonly reasoning_tokens: number }
                  ).reasoning_tokens,
                }
              : {}),
          };
        }
        const reason =
          event.type === "response.completed"
            ? toolCallCount > 0
              ? "tool_calls"
              : "stop"
            : event.type === "response.incomplete"
              ? (response?.incomplete_details as { readonly reason?: unknown } | undefined)
                  ?.reason === "content_filter"
                ? "content_filter"
                : "length"
              : "unknown";
        const incompleteReason = (
          response?.incomplete_details as { readonly reason?: unknown } | undefined
        )?.reason;
        yield {
          type: "finish",
          reason,
          rawReason: String(incompleteReason ?? response?.status ?? event.type).slice(0, 128),
        };
        return;
      }
      default:
        break;
    }
  }
  if (!terminal) {
    throw protocolError("The model provider stream ended without a terminal response event.");
  }
}

function addBoundedBytes(total: number, value: string, maximum: number): number {
  const next = total + Buffer.byteLength(value, "utf8");
  if (!Number.isSafeInteger(next) || next > maximum) {
    throw protocolError("The model provider response exceeded Adam's semantic content limit.");
  }
  return next;
}

function isAcceptedProgressEvent(event: ModelEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
      return Buffer.byteLength(event.text, "utf8") > 0;
    case "tool_call_delta":
      return Buffer.byteLength(event.json, "utf8") > 0;
    case "tool_call_start":
    case "tool_call_end":
      return true;
    default:
      return false;
  }
}

async function responseError(response: Response, apiKey: string): Promise<ModelDriverError> {
  const raw = await readBoundedErrorBody(response);
  let providerCode: string | undefined;
  let providerMessage: string | undefined;
  try {
    const decoded = JSON.parse(raw) as {
      readonly error?: { readonly code?: unknown; readonly message?: unknown };
    };
    providerCode =
      typeof decoded.error?.code === "string"
        ? decoded.error.code.split(apiKey).join("[REDACTED]").slice(0, 128)
        : undefined;
    providerMessage =
      typeof decoded.error?.message === "string" ? decoded.error.message : undefined;
  } catch {
    providerMessage = undefined;
  }
  const summary = (providerMessage ?? raw).split(apiKey).join("[REDACTED]").slice(0, 512);
  const rawRequestId = response.headers.get("x-request-id");
  const requestId = rawRequestId?.split(apiKey).join("[REDACTED]").slice(0, 128);
  const category =
    response.status === 401
      ? "authentication"
      : response.status === 402
        ? "billing"
        : response.status === 403
          ? "authorization"
          : response.status === 429
            ? "rate_limit"
            : response.status === 400 || response.status === 422
              ? "invalid_request"
              : response.status >= 500
                ? "provider"
                : "unknown";
  return new ModelDriverError(category, "The model provider rejected the Responses request.", {
    cause: undefined,
    status: response.status,
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(summary.length === 0 ? {} : { responseSummary: summary }),
  });
}

async function readBoundedErrorBody(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        throw protocolError("The model provider error response exceeded Adam's limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function protocolError(message: string, cause?: unknown): ModelDriverError {
  return new ModelDriverError("protocol_incompatibility", message, { cause });
}

function abortedError(cause?: unknown): ModelDriverError {
  return new ModelDriverError("aborted", "The model provider request was aborted.", { cause });
}
