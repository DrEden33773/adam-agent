import { randomUUID } from "node:crypto";

import { ModelDriverError, type ModelDriverErrorCategory } from "./model-driver-error.js";

export {
  type ArtifactReference,
  type ArtifactSource,
  type ArtifactStore,
  createFileArtifactStore,
} from "./artifact-store.js";
export { ModelDriverError, type ModelDriverErrorCategory } from "./model-driver-error.js";
export {
  OpenAICompatibleModelDriver,
  type OpenAICompatibleModelDriverOptions,
} from "./openai-compatible-model-driver.js";

import type { CanonicalRuntimeEvent, SessionStore } from "./session-store.js";
import type {
  ModelToolDefinition,
  PermissionPolicy,
  PermissionPolicyInput,
  PermissionSubject,
  ToolCall,
  ToolEffect,
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
  createCodingToolRegistry,
  createMutationToolRegistry,
  createPermissionPolicy,
  createReadToolRegistry,
  type JsonValue,
  type ModelToolDefinition,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionPolicyInput,
  type PermissionSubject,
  type ShellRuntimeLimits,
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
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "developer"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoning?: string;
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
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly json: string }
  | { readonly type: "tool_call_end"; readonly id: string }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens?: number | undefined;
      readonly cachedInputTokens?: number | undefined;
      readonly cacheMissInputTokens?: number | undefined;
    }
  | {
      readonly type: "finish";
      readonly reason:
        | "stop"
        | "tool_calls"
        | "length"
        | "content_filter"
        | "resource_exhausted"
        | "unknown";
      readonly rawReason?: string | undefined;
    };

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
      readonly error:
        | {
            readonly code:
              | "model_stream_incomplete"
              | "model_protocol_invalid"
              | "model_output_truncated"
              | "model_content_filtered"
              | "invalid_run_limits"
              | "run_already_active"
              | "session_persistence_failed"
              | "turn_limit_exceeded"
              | "token_limit_exceeded"
              | "token_usage_missing";
            readonly message: string;
          }
        | {
            readonly code: "model_resource_exhausted" | "model_finish_unknown";
            readonly message: string;
            readonly providerReason?: string | undefined;
          }
        | {
            readonly code: "model_request_failed";
            readonly message: string;
            readonly category: ModelDriverErrorCategory;
            readonly status?: number | undefined;
            readonly providerCode?: string | undefined;
            readonly requestId?: string | undefined;
          };
    };

export type PermissionDecisionCommand = {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
};

export type PermissionDecisionCommandResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly error: {
        readonly code: "permission_request_not_pending" | "invalid_permission_decision";
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
      readonly reasoningTokens?: number | undefined;
      readonly cachedInputTokens?: number | undefined;
      readonly cacheMissInputTokens?: number | undefined;
    }
  | { readonly type: "tool_requested"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_permission_requested";
      readonly requestId: string;
      readonly callId: string;
      readonly name: string;
      readonly effect: ToolEffect;
      readonly scope: "call";
      readonly subject: PermissionSubject;
    }
  | {
      readonly type: "tool_permission_decided";
      readonly callId: string;
      readonly name: string;
      readonly decision: "allow" | "deny";
      readonly requestId?: string | undefined;
      readonly effect?: ToolEffect | undefined;
      readonly scope?: "call" | undefined;
      readonly subject?: PermissionSubject | undefined;
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
  #pendingPermission:
    | {
        readonly requestId: string;
        readonly resolve: (decision: "allow" | "deny") => void;
      }
    | undefined;

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

  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult {
    if (command.decision !== "allow" && command.decision !== "deny") {
      return {
        status: "rejected",
        error: {
          code: "invalid_permission_decision",
          message: "The permission decision must be allow or deny.",
        },
      };
    }
    const pendingPermission = this.#pendingPermission;
    if (pendingPermission === undefined || pendingPermission.requestId !== command.requestId) {
      return {
        status: "rejected",
        error: {
          code: "permission_request_not_pending",
          message: "The permission request is not pending.",
        },
      };
    }
    pendingPermission.resolve(command.decision);
    return { status: "accepted" };
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
        if (error instanceof ModelDriverError) {
          return await this.#settleModelRequestFailed(error);
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
      let reasoning = "";
      let finishReason:
        | "stop"
        | "tool_calls"
        | "length"
        | "content_filter"
        | "resource_exhausted"
        | "unknown"
        | undefined;
      let rawFinishReason: string | undefined;
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
          case "reasoning_delta":
            reasoning += event.text;
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
              !areOptionalUsageDetailsValid(event) ||
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
              ...(event.reasoningTokens === undefined
                ? {}
                : { reasoningTokens: event.reasoningTokens }),
              ...(event.cachedInputTokens === undefined
                ? {}
                : { cachedInputTokens: event.cachedInputTokens }),
              ...(event.cacheMissInputTokens === undefined
                ? {}
                : { cacheMissInputTokens: event.cacheMissInputTokens }),
            });
            break;
          }
          case "finish":
            finishReason = event.reason;
            rawFinishReason = event.rawReason;
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

      if (finishReason === "length") {
        return this.#settleOutputTruncated();
      }
      if (finishReason === "content_filter") {
        return this.#settleContentFiltered();
      }
      if (finishReason === "resource_exhausted") {
        return this.#settleResourceExhausted(rawFinishReason);
      }
      if (finishReason === "unknown") {
        return this.#settleUnknownFinish(rawFinishReason);
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

      messages.push({
        role: "assistant",
        content: answer,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        toolCalls: completedCalls,
      });
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
        const permissionInput: PermissionPolicyInput = {
          callId: call.id,
          name: call.name,
          effect: adapter.effect,
          scope: "call",
          subject: preparedCall.permissionSubject,
        };
        const policyDecision = this.#permissions?.decide(permissionInput) ?? "deny";
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        let decision: "allow" | "deny";
        if (policyDecision === "ask") {
          const runId = this.#activeRunId;
          if (runId === undefined) {
            throw new Error("Cannot request permission without an active run ID.");
          }
          const requestId = `${runId}:${call.id}`;
          const pendingDecision = this.#createPendingPermissionDecision(requestId, signal);
          try {
            await this.#emit({
              type: "tool_permission_requested",
              requestId,
              ...permissionInput,
            });
            const userDecision = await pendingDecision.promise;
            if (userDecision === undefined) {
              return this.#settleCancelled();
            }
            decision = userDecision;
            await this.#emit({
              type: "tool_permission_decided",
              requestId,
              decision,
              ...permissionInput,
            });
          } finally {
            pendingDecision.cancel();
          }
        } else {
          decision = policyDecision;
          await this.#emit({
            type: "tool_permission_decided",
            decision,
            ...permissionInput,
          });
        }
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
        const result = await preparedCall.execute({ signal, callId: call.id, toolName: call.name });
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

  async #settleModelRequestFailed(error: ModelDriverError): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_request_failed",
        message: error.message,
        category: error.category,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
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

  async #settleOutputTruncated(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_output_truncated",
        message: "The model response reached its output-token limit.",
      },
    };
    return this.#settle(result);
  }

  async #settleContentFiltered(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_content_filtered",
        message: "The provider filtered the model response.",
      },
    };
    return this.#settle(result);
  }

  async #settleResourceExhausted(providerReason: string | undefined): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_resource_exhausted",
        message:
          "The provider could not complete the model response because resources were unavailable.",
        ...(providerReason === undefined ? {} : { providerReason }),
      },
    };
    return this.#settle(result);
  }

  async #settleUnknownFinish(providerReason: string | undefined): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_finish_unknown",
        message: "The provider ended the model response for an unknown reason.",
        ...(providerReason === undefined ? {} : { providerReason }),
      },
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

  #createPendingPermissionDecision(
    requestId: string,
    signal: AbortSignal,
  ): {
    readonly promise: Promise<"allow" | "deny" | undefined>;
    readonly cancel: () => void;
  } {
    let settle: (decision: "allow" | "deny" | undefined) => void = () => {};
    const promise = new Promise<"allow" | "deny" | undefined>((resolve) => {
      let settled = false;
      const finish = (decision: "allow" | "deny" | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abortPending);
        if (this.#pendingPermission?.requestId === requestId) {
          this.#pendingPermission = undefined;
        }
        resolve(decision);
      };
      const abortPending = () => finish(undefined);
      settle = finish;
      this.#pendingPermission = {
        requestId,
        resolve: (decision) => finish(decision),
      };
      if (signal.aborted) {
        abortPending();
      } else {
        signal.addEventListener("abort", abortPending, { once: true });
      }
    });
    return { promise, cancel: () => settle(undefined) };
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

function areOptionalUsageDetailsValid(
  usage: Extract<ModelEvent, { readonly type: "usage" }>,
): boolean {
  return [usage.reasoningTokens, usage.cachedInputTokens, usage.cacheMissInputTokens].every(
    (value) => value === undefined || isNonnegativeSafeInteger(value),
  );
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
