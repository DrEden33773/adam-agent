import { randomUUID } from "node:crypto";

import type { CanonicalRuntimeEvent, SessionStore } from "./session-store.js";
import type {
  ModelToolDefinition,
  PermissionPolicy,
  ToolCall,
  ToolRegistry,
  ToolResult,
} from "./tool-runtime.js";

export {
  type CanonicalRuntimeEvent,
  createInMemorySessionStore,
  createJsonlSessionStore,
  type SessionEventRecord,
  type SessionStore,
  SessionStoreError,
} from "./session-store.js";

export {
  createPermissionPolicy,
  createReadToolRegistry,
  type JsonValue,
  type ModelToolDefinition,
  type PermissionDecision,
  type PermissionPolicy,
  type ToolCall,
  type ToolEffect,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

export type UserInput = {
  readonly text: string;
};

export type RunOptions = {
  readonly signal?: AbortSignal;
  readonly limits?: {
    readonly maxTurns?: number;
    readonly maxTokens?: number;
  };
};

export type ModelMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolResult;
    };

export type ModelRequest = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly signal: AbortSignal;
};

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly json: string }
  | { readonly type: "tool_call_end"; readonly id: string }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" };

export interface ModelDriver {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export type RunResult =
  | {
      readonly status: "completed";
      readonly answer: string;
    }
  | {
      readonly status: "cancelled";
      readonly error: {
        readonly code: "session_cancelled";
        readonly message: string;
      };
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code:
          | "model_stream_incomplete"
          | "model_protocol_invalid"
          | "invalid_run_limits"
          | "run_already_active"
          | "session_persistence_failed"
          | "turn_limit_exceeded"
          | "token_limit_exceeded"
          | "token_usage_missing";
        readonly message: string;
      };
    };

export type RuntimeEvent =
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "model_message_started" }
  | { readonly type: "model_message_delta"; readonly text: string }
  | { readonly type: "model_message_completed"; readonly text: string }
  | {
      readonly type: "model_usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | { readonly type: "tool_requested"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_permission_decided";
      readonly callId: string;
      readonly name: string;
      readonly decision: "allow" | "deny";
    }
  | { readonly type: "tool_started"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_completed";
      readonly callId: string;
      readonly name: string;
      readonly output: Extract<ToolResult, { readonly status: "completed" }>["output"];
    }
  | {
      readonly type: "tool_failed";
      readonly callId: string;
      readonly name: string;
      readonly error: Extract<ToolResult, { readonly status: "failed" }>["error"];
    }
  | { readonly type: "session_interrupted"; readonly reason: "cancelled" }
  | { readonly type: "session_settled"; readonly result: RunResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

class SessionPersistenceError extends Error {}

export type AgentSessionDependencies = {
  readonly model: ModelDriver;
  readonly tools?: ToolRegistry;
  readonly permissions?: PermissionPolicy;
  readonly store: SessionStore;
};

export class AgentSession {
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #model: ModelDriver;
  readonly #tools: ToolRegistry | undefined;
  readonly #permissions: PermissionPolicy | undefined;
  readonly #store: SessionStore;
  #activeAbortController: AbortController | undefined;
  #activeRunId: string | undefined;
  #nextSequence = 1;
  #terminalResult: RunResult | undefined;

  constructor(dependencies: AgentSessionDependencies) {
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#permissions = dependencies.permissions;
    this.#store = dependencies.store;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  abort(): void {
    this.#activeAbortController?.abort();
  }

  async run(input: UserInput, options: RunOptions = {}): Promise<RunResult> {
    if (!areRunLimitsValid(options.limits)) {
      return {
        status: "failed",
        error: {
          code: "invalid_run_limits",
          message: "Run limits must be positive safe integers.",
        },
      };
    }
    if (this.#activeAbortController !== undefined) {
      return {
        status: "failed",
        error: {
          code: "run_already_active",
          message: "The session already has an active run.",
        },
      };
    }
    this.#terminalResult = undefined;
    this.#activeRunId = randomUUID();
    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort(options.signal?.reason);
    if (options.signal?.aborted === true) {
      abortFromCaller();
    } else {
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    this.#activeAbortController = abortController;
    try {
      try {
        return await this.#run(input, abortController.signal, options.limits);
      } catch (error) {
        if (abortController.signal.aborted && this.#terminalResult === undefined) {
          return await this.#settleCancelled();
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SessionPersistenceError) {
        return {
          status: "failed",
          error: {
            code: "session_persistence_failed",
            message: "The session event could not be persisted.",
          },
        };
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (this.#activeAbortController === abortController) {
        this.#activeAbortController = undefined;
        this.#activeRunId = undefined;
      }
    }
  }

  async #run(
    input: UserInput,
    signal: AbortSignal,
    limits: RunOptions["limits"],
  ): Promise<RunResult> {
    await this.#emit({ type: "user_message", text: input.text });
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    const messages: ModelMessage[] = [{ role: "user", content: input.text }];
    const toolResultsById = new Map<
      string,
      { readonly call: ToolCall; readonly result: ToolResult }
    >();
    let modelTurns = 0;
    let reportedTokens = 0;

    while (true) {
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      if (limits?.maxTurns !== undefined && modelTurns >= limits.maxTurns) {
        return this.#settleTurnLimitExceeded();
      }
      modelTurns += 1;
      await this.#emit({ type: "model_message_started" });
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      let answer = "";
      let finishReason: "stop" | "tool_calls" | undefined;
      let protocolError: string | undefined;
      let usageWasReported = false;
      const assemblingCalls = new Map<string, ToolCall>();
      const completedCalls: ToolCall[] = [];

      for await (const event of this.#model.stream({
        messages: [...messages],
        tools: this.#tools?.definitions() ?? [],
        signal,
      })) {
        if (signal.aborted) {
          break;
        }
        switch (event.type) {
          case "text_delta":
            answer += event.text;
            await this.#emit({ type: "model_message_delta", text: event.text });
            break;
          case "tool_call_start":
            if (assemblingCalls.has(event.id)) {
              protocolError = "The model started the same tool call more than once.";
            } else {
              assemblingCalls.set(event.id, {
                id: event.id,
                name: event.name,
                argumentsJson: "",
              });
            }
            break;
          case "tool_call_delta": {
            const call = assemblingCalls.get(event.id);
            if (call === undefined) {
              protocolError = "The model sent arguments for a tool call that was not started.";
            } else {
              assemblingCalls.set(event.id, {
                ...call,
                argumentsJson: call.argumentsJson + event.json,
              });
            }
            break;
          }
          case "tool_call_end": {
            const call = assemblingCalls.get(event.id);
            if (call === undefined) {
              protocolError = "The model ended a tool call that was not started.";
            } else {
              completedCalls.push(call);
              assemblingCalls.delete(event.id);
            }
            break;
          }
          case "usage": {
            const totalTokens = event.inputTokens + event.outputTokens;
            const nextReportedTokens = reportedTokens + totalTokens;
            if (
              !isNonnegativeSafeInteger(event.inputTokens) ||
              !isNonnegativeSafeInteger(event.outputTokens) ||
              !Number.isSafeInteger(totalTokens) ||
              !Number.isSafeInteger(nextReportedTokens)
            ) {
              protocolError = "The model reported invalid token usage.";
              break;
            }
            usageWasReported = true;
            reportedTokens = nextReportedTokens;
            await this.#emit({
              type: "model_usage",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens,
            });
            break;
          }
          case "finish":
            finishReason = event.reason;
            break;
        }
        if (signal.aborted || finishReason !== undefined) {
          break;
        }
      }

      if (signal.aborted) {
        return this.#settleCancelled();
      }

      if (finishReason === undefined) {
        return this.#settleIncompleteStream();
      }

      if (protocolError !== undefined) {
        return this.#settleProtocolInvalid(protocolError);
      }

      await this.#emit({ type: "model_message_completed", text: answer });
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      if (limits?.maxTokens !== undefined && !usageWasReported) {
        return this.#settleTokenUsageMissing();
      }
      if (limits?.maxTokens !== undefined && reportedTokens >= limits.maxTokens) {
        return this.#settleTokenLimitExceeded();
      }
      if (finishReason === "stop") {
        if (completedCalls.length > 0 || assemblingCalls.size > 0) {
          return this.#settleProtocolInvalid(
            completedCalls.length > 0
              ? "The model stopped after completing a tool request."
              : "The model stopped with an incomplete tool request.",
          );
        }
        const result: RunResult = { status: "completed", answer };
        return this.#settle(result);
      }

      if (assemblingCalls.size > 0) {
        return this.#settleProtocolInvalid("The model finished with an incomplete tool request.");
      }

      if (completedCalls.length === 0) {
        const result: RunResult = {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model reported tool calls without a completed request.",
          },
        };
        return this.#settle(result);
      }

      const uniqueCalls = new Map<string, ToolCall>();
      for (const call of completedCalls) {
        const priorCall = uniqueCalls.get(call.id);
        if (priorCall !== undefined) {
          return this.#settleProtocolInvalid(
            priorCall.name !== call.name || priorCall.argumentsJson !== call.argumentsJson
              ? "The model reused a tool call ID with different input."
              : "The model repeated a tool call ID within one turn.",
          );
        }
        uniqueCalls.set(call.id, call);
      }

      messages.push({ role: "assistant", content: answer, toolCalls: completedCalls });
      for (const call of uniqueCalls.values()) {
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        await this.#emit({ type: "tool_requested", callId: call.id, name: call.name });
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        const recordedCall = toolResultsById.get(call.id);
        if (recordedCall !== undefined) {
          if (
            recordedCall.call.name !== call.name ||
            recordedCall.call.argumentsJson !== call.argumentsJson
          ) {
            return this.#settleProtocolInvalid(
              "The model reused a tool call ID with different input.",
            );
          }
          await this.#appendToolResult(messages, call, recordedCall.result);
          continue;
        }
        const adapter = this.#tools?.resolve(call.name);
        if (adapter === undefined) {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "unknown_tool",
              message: `Unknown tool: ${call.name}`,
            },
          };
          toolResultsById.set(call.id, { call, result });
          await this.#appendToolResult(messages, call, result);
          continue;
        }
        const preparedCall = adapter.prepare(call.argumentsJson);
        if (preparedCall.status === "failed") {
          toolResultsById.set(call.id, { call, result: preparedCall });
          await this.#appendToolResult(messages, call, preparedCall);
          continue;
        }
        const decision = this.#permissions?.decide(adapter.effect) ?? "deny";
        await this.#emit({
          type: "tool_permission_decided",
          callId: call.id,
          name: call.name,
          decision,
        });
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        if (decision !== "allow") {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "permission_denied",
              message: `Permission denied for tool: ${call.name}`,
            },
          };
          toolResultsById.set(call.id, { call, result });
          await this.#appendToolResult(messages, call, result);
          continue;
        }
        await this.#emit({ type: "tool_started", callId: call.id, name: call.name });
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        const result = await preparedCall.execute();
        toolResultsById.set(call.id, { call, result });
        await this.#appendToolResult(messages, call, result);
      }
    }
  }

  async #settleIncompleteStream(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    };
    return this.#settle(result);
  }

  async #settleProtocolInvalid(message: string): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: { code: "model_protocol_invalid", message },
    };
    return this.#settle(result);
  }

  async #settleCancelled(): Promise<RunResult> {
    const result: RunResult = {
      status: "cancelled",
      error: {
        code: "session_cancelled",
        message: "The session was cancelled.",
      },
    };
    return this.#settle(result, true);
  }

  async #settleTurnLimitExceeded(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "turn_limit_exceeded",
        message: "The run reached its model turn limit.",
      },
    };
    return this.#settle(result);
  }

  async #settleTokenLimitExceeded(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "token_limit_exceeded",
        message: "The run reached its provider-reported token limit.",
      },
    };
    return this.#settle(result);
  }

  async #settleTokenUsageMissing(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "token_usage_missing",
        message: "The provider did not report token usage for an active token limit.",
      },
    };
    return this.#settle(result);
  }

  async #settle(result: RunResult, interrupted = false): Promise<RunResult> {
    if (this.#terminalResult !== undefined) {
      return this.#terminalResult;
    }
    this.#terminalResult = result;
    if (interrupted) {
      await this.#emit({ type: "session_interrupted", reason: "cancelled" });
    }
    await this.#emit({ type: "session_settled", result });
    return result;
  }

  async #appendToolResult(
    messages: ModelMessage[],
    call: ToolCall,
    result: ToolResult,
  ): Promise<void> {
    if (result.status === "completed") {
      await this.#emit({
        type: "tool_completed",
        callId: call.id,
        name: call.name,
        output: result.output,
      });
    } else {
      await this.#emit({
        type: "tool_failed",
        callId: call.id,
        name: call.name,
        error: result.error,
      });
    }
    messages.push({ role: "tool", callId: call.id, name: call.name, result });
  }

  async #emit(event: RuntimeEvent): Promise<void> {
    if (event.type !== "model_message_delta") {
      const canonicalEvent: CanonicalRuntimeEvent = event;
      const runId = this.#activeRunId;
      if (runId === undefined) {
        throw new Error("Cannot persist a session event without an active run ID.");
      }
      try {
        await this.#store.append({
          schemaVersion: 1,
          runId,
          sequence: this.#nextSequence,
          event: canonicalEvent,
        });
      } catch {
        throw new SessionPersistenceError();
      }
      this.#nextSequence += 1;
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function areRunLimitsValid(limits: RunOptions["limits"]): boolean {
  return (
    (limits?.maxTurns === undefined || isPositiveSafeInteger(limits.maxTurns)) &&
    (limits?.maxTokens === undefined || isPositiveSafeInteger(limits.maxTokens))
  );
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
