import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore, ModelResponseArtifactSource } from "./artifact-store.js";
import { type ContextProfile, resolveOrdinaryMaximumOutputTokens } from "./context-profile.js";
import {
  type ContextCallUsage,
  ContextCompactionError,
  ContextCompactionInterruptedError,
  ContextCompactionRequestError,
  digestContextMessages,
  digestContextRecordPrefix,
  estimateActiveContextTokens,
  estimateContextSummaryRequestTokens,
  generateContextSummary,
  mergeContextEvidence,
  reduceContextEvidence,
  shrinkContextMessagesForRetry,
  splitContextForCompaction,
} from "./durable-context.js";
import {
  maximumInlineModelResponseFieldBytes,
  maximumModelResponseContentBytes,
  maximumReferencedModelResponseArtifactBytes,
} from "./durable-model-response-policy.js";
import { ModelDriverError, type ModelDriverErrorCategory } from "./model-driver-error.js";
import {
  type AgentSessionDurableContext,
  type AgentSessionDurableOutputLimits,
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";

export {
  type ArtifactReference,
  type ArtifactSource,
  type ArtifactStore,
  createFileArtifactStore,
} from "./artifact-store.js";
export {
  type BiomeExecutionAdapter,
  type BiomeExecutionInput,
  type BiomeExecutionOutput,
  createBiomeExecutionAdapter,
} from "./biome-execution.js";
export type { ContextProfile } from "./context-profile.js";
export {
  type ConfiguredExtension,
  createExtensionHost,
  type ExtensionCapabilityAvailability,
  type ExtensionCapabilityGrant,
  type ExtensionContributionSummary,
  type ExtensionDiagnostic,
  type ExtensionHost,
  ExtensionHostError,
  type ExtensionHostOptions,
  type ExtensionHostSnapshot,
  type ExtensionStateSnapshot,
} from "./extension-host.js";
export { ModelDriverError, type ModelDriverErrorCategory } from "./model-driver-error.js";
export {
  createModelTargets,
  ModelTargetError,
  type ModelTargetIdentity,
  type ModelTargetReadiness,
  type ModelTargetSnapshot,
  type ModelTargets,
  type ModelTargetsOptions,
  selectModelTargetId,
} from "./model-targets.js";
export {
  OpenAICompatibleModelDriver,
  type OpenAICompatibleModelDriverOptions,
} from "./openai-compatible-model-driver.js";
export {
  type OperationHost,
  OperationHostError,
  type OperationReference,
  type OperationSnapshot,
  type OperationStartOptions,
} from "./operation-host.js";
export {
  createInMemoryOperationStore,
  createJsonlOperationStore,
  type OperationArtifactPublishedEvent,
  type OperationCancellationReason,
  type OperationCancelledEvent,
  type OperationCancelRequestedEvent,
  type OperationCompletedEvent,
  type OperationEvent,
  type OperationEventRecord,
  type OperationFailedEvent,
  type OperationFailure,
  type OperationIdempotencyScope,
  type OperationInspectionRequiredEvent,
  type OperationProgressEvent,
  type OperationReconciliationStartedEvent,
  type OperationStartedEvent,
  type OperationStore,
  OperationStoreError,
} from "./operation-store.js";

import {
  type CanonicalRuntimeEvent,
  isSessionRecordWithinSizeLimit,
  type SessionModelResponse,
  type SessionModelResponseField,
  type SessionRecord,
  type SessionStore,
  type SessionToolIntent,
} from "./session-store.js";
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
  type CurrentSessionSnapshot,
  createSessionLifecycle,
  type LegacySessionSnapshot,
  type SessionCommand,
  type SessionContextSnapshot,
  type SessionContinueResult,
  type SessionLifecycle,
  SessionLifecycleError,
  type SessionLifecycleOptions,
  type SessionResumeResult,
  type SessionSnapshot,
} from "./session-lifecycle.js";
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
  type ToolReplayClass,
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
  readonly maximumOutputTokens: number;
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
      readonly status: "incomplete";
      readonly reason: "output_limit";
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
              | "model_response_artifact_quota_exceeded"
              | "model_response_too_large"
              | "replay_envelope_too_large"
              | "invalid_run_limits"
              | "run_already_active"
              | "session_persistence_failed"
              | "tool_effect_indeterminate"
              | "turn_limit_exceeded"
              | "token_limit_exceeded"
              | "token_usage_missing"
              | "context_compaction_input_unrecoverable"
              | "context_compaction_invalid"
              | "context_window_unrecoverable";
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
          }
        | {
            readonly code: "context_compaction_failed";
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

export type ContextUsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheMissInputTokens: number;
  readonly unknownCalls: number;
};

export type ActiveContextUsage =
  | {
      readonly source: "provider_reported" | "estimated";
      readonly tokens: number;
      readonly throughSequence: number;
    }
  | {
      readonly source: "unknown";
      readonly throughSequence: number;
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
  | {
      readonly type: "context_compaction_started";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly trigger: "automatic_threshold" | "provider_overflow";
    }
  | {
      readonly type: "context_compaction_committed";
      readonly attemptId: string;
      readonly checkpointId: string;
      readonly windowNumber: number;
      readonly sourceThrough: number;
      readonly retainedFrom: number;
    }
  | {
      readonly type: "context_compaction_failed";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly reason:
        | "replacement_too_large"
        | "context_window_unrecoverable"
        | "summary_invalid"
        | "model_request_failed"
        | "input_unrecoverable";
    }
  | {
      readonly type: "context_compaction_interrupted";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly reason: "caller_cancelled" | "process_restart";
      readonly usage: ContextCallUsage | { readonly status: "unknown" };
    }
  | {
      readonly type: "context_usage";
      readonly ordinary: ContextUsageTotals;
      readonly compaction: ContextUsageTotals;
      readonly active: ActiveContextUsage;
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

type AgentSessionBaseDependencies = {
  readonly artifactStore?: ArtifactStore;
  readonly model: ModelDriver;
  readonly tools?: ToolRegistry;
  readonly permissions?: PermissionPolicy;
  readonly store: SessionStore;
};

export type AgentSessionDependencies = AgentSessionBaseDependencies &
  (
    | {
        readonly contextProfile: ContextProfile;
        readonly maximumOutputTokens?: never;
      }
    | {
        readonly contextProfile?: never;
        readonly maximumOutputTokens: number;
      }
  );

export class AgentSession {
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #artifactStore: ArtifactStore | undefined;
  readonly #model: ModelDriver;
  readonly #tools: ToolRegistry | undefined;
  readonly #permissions: PermissionPolicy | undefined;
  readonly #durableContext: AgentSessionDurableContext | undefined;
  readonly #durableOutputLimits: Required<AgentSessionDurableOutputLimits>;
  readonly #contextProfile: ContextProfile | undefined;
  readonly #maximumOutputTokens: number;
  readonly #store: SessionStore<SessionRecord>;
  #activeAbortController: AbortController | undefined;
  #activeProviderAttempt:
    | { readonly runId: string; readonly turn: number; readonly attempt: number }
    | undefined;
  #activeRunId: string | undefined;
  #nextSequence = 1;
  #contextWindowNumber = 0;
  #lastContextCheckpoint: { readonly checkpointId: string; readonly sequence: number } | undefined;
  #terminalResult: RunResult | undefined;
  #latestDurableResponse:
    | { readonly sequence: number; readonly artifactBacked: boolean }
    | undefined;
  #referencedModelResponseArtifactBytes: number;
  #pendingPermission:
    | {
        readonly requestId: string;
        readonly resolve: (decision: "allow" | "deny") => void;
      }
    | undefined;

  constructor(dependencies: AgentSessionDependencies) {
    this.#artifactStore = dependencies.artifactStore;
    this.#durableContext = (
      dependencies as AgentSessionDependencies & {
        readonly [sessionDurableContext]?: AgentSessionDurableContext;
      }
    )[sessionDurableContext];
    const configuredDurableOutputLimits = (
      dependencies as AgentSessionDependencies & {
        readonly [sessionDurableOutputLimits]?: AgentSessionDurableOutputLimits;
      }
    )[sessionDurableOutputLimits];
    this.#durableOutputLimits = {
      maximumInlineFieldBytes:
        configuredDurableOutputLimits?.maximumInlineFieldBytes ??
        maximumInlineModelResponseFieldBytes,
      maximumReferencedArtifactBytes:
        configuredDurableOutputLimits?.maximumReferencedArtifactBytes ??
        maximumReferencedModelResponseArtifactBytes,
      maximumResponseContentBytes:
        configuredDurableOutputLimits?.maximumResponseContentBytes ??
        maximumModelResponseContentBytes,
    };
    if (!Object.values(this.#durableOutputLimits).every((value) => isPositiveSafeInteger(value))) {
      throw new RangeError("Durable model-response limits must be positive safe integers.");
    }
    this.#referencedModelResponseArtifactBytes =
      this.#durableContext?.referencedModelResponseArtifactBytes ?? 0;
    this.#contextProfile = dependencies.contextProfile;
    const maximumOutputTokens =
      dependencies.contextProfile?.maximumOutputTokens ?? dependencies.maximumOutputTokens;
    if (maximumOutputTokens === undefined || !isPositiveSafeInteger(maximumOutputTokens)) {
      throw new RangeError("The model output limit must be a positive safe integer.");
    }
    this.#maximumOutputTokens = maximumOutputTokens;
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
    this.#permissions = dependencies.permissions;
    this.#store = dependencies.store as unknown as SessionStore<SessionRecord>;
    this.#nextSequence = this.#durableContext?.nextSequence ?? 1;
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
    this.#activeRunId = this.#durableContext?.resume?.runId ?? randomUUID();
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
        if (this.#durableContext !== undefined && this.#durableContext.resume === undefined) {
          await this.#appendRecord({
            schemaVersion: 3,
            sequence: this.#nextSequence,
            record: {
              type: "logical_run_started",
              runId: this.#activeRunId,
              userMessage: input.text,
              ...(options.limits === undefined ? {} : { limits: options.limits }),
            },
          });
        }
        return await this.#run(input, abortController.signal, options.limits);
      } catch (error) {
        if (abortController.signal.aborted && this.#terminalResult === undefined) {
          return await this.#settleCancelled();
        }
        if (error instanceof ModelDriverError) {
          return await this.#settleModelRequestFailed(error);
        }
        if (error instanceof ContextCompactionError) {
          return await this.#settleContextCompactionFailed(error);
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
    const resume = this.#durableContext?.resume;
    if (resume === undefined) {
      await this.#emit({ type: "user_message", text: input.text });
      if (signal.aborted) {
        return this.#settleCancelled();
      }
    }
    const messages: ModelMessage[] =
      resume === undefined
        ? [...(this.#durableContext?.initialMessages ?? []), { role: "user", content: input.text }]
        : resume.messages.map((message) => ({ ...message }));
    const toolResultsById = new Map<
      string,
      { readonly call: ToolCall; readonly result: ToolResult }
    >(resume?.toolResults.map((entry) => [entry.call.id, entry]) ?? []);
    let modelTurns = (resume?.nextTurn ?? 1) - 1;
    let reportedTokens = resume?.reportedTokens ?? 0;
    const ordinaryUsage = createMutableContextUsageTotals();
    const compactionUsage = createMutableContextUsageTotals();
    let continuingSameTurn = false;
    let nextAttemptNumber = resume?.nextAttempt ?? 1;
    let compactionCallsThisTurn = 0;
    let reactiveRetryUsed = false;
    let skipProactiveCompaction = false;
    let activeProviderSample:
      | { readonly inputTokens: number; readonly messageCount: number }
      | undefined;

    if (resume?.compactionUsageUnknown === true && limits?.maxTokens !== undefined) {
      return this.#settleTokenUsageMissing();
    }

    for (const pending of resume?.pendingToolCalls ?? []) {
      const terminal = await this.#dispatchToolCall({
        call: pending.call,
        emitRequested: !pending.requested,
        emitStarted: !pending.started,
        messages,
        reusablePermission: pending.reusablePermission,
        signal,
        toolResultsById,
      });
      if (terminal !== undefined) {
        return terminal;
      }
    }

    while (true) {
      const retryingSameTurn = continuingSameTurn;
      continuingSameTurn = false;
      if (!retryingSameTurn) {
        compactionCallsThisTurn = 0;
        reactiveRetryUsed = false;
      }
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      if (limits?.maxTokens !== undefined && reportedTokens >= limits.maxTokens) {
        return this.#settleTokenLimitExceeded();
      }
      if (!retryingSameTurn && limits?.maxTurns !== undefined && modelTurns >= limits.maxTurns) {
        return this.#settleTurnLimitExceeded();
      }
      let activeEstimate =
        this.#contextProfile === undefined
          ? undefined
          : activeProviderSample === undefined ||
              activeProviderSample.messageCount > messages.length
            ? estimateActiveContextTokens(messages, this.#contextProfile)
            : activeProviderSample.inputTokens +
              estimateActiveContextTokens(
                messages.slice(activeProviderSample.messageCount),
                this.#contextProfile,
              );
      if (
        this.#contextProfile !== undefined &&
        this.#durableContext !== undefined &&
        !skipProactiveCompaction &&
        activeEstimate !== undefined &&
        activeEstimate >= this.#contextProfile.compactAtTokens
      ) {
        this.#publishContextUsage(ordinaryUsage, compactionUsage, {
          source: "estimated",
          tokens: activeEstimate,
          throughSequence: this.#nextSequence - 1,
        });
        const compacted = await this.#compactContext(messages, signal, {
          trigger: "automatic_threshold",
          maximumAttempts: 2,
        });
        compactionCallsThisTurn += compacted.attemptCount;
        messages.splice(0, messages.length, ...compacted.messages);
        activeProviderSample = undefined;
        compactionUsage.unknownCalls += compacted.unknownCalls;
        if (compacted.usage !== undefined) {
          addContextUsage(compactionUsage, compacted.usage);
          reportedTokens += compacted.usage.inputTokens + compacted.usage.outputTokens;
        }
        if (compacted.unknownCalls > 0 && limits?.maxTokens !== undefined) {
          return this.#settleTokenUsageMissing();
        }
        if (limits?.maxTokens !== undefined && reportedTokens >= limits.maxTokens) {
          return this.#settleTokenLimitExceeded();
        }
        activeEstimate = estimateActiveContextTokens(messages, this.#contextProfile);
        this.#publishContextUsage(ordinaryUsage, compactionUsage, {
          source: "estimated",
          tokens: activeEstimate,
          throughSequence: this.#nextSequence - 1,
        });
      }
      skipProactiveCompaction = false;
      const maximumOutputTokens =
        this.#contextProfile === undefined
          ? this.#maximumOutputTokens
          : resolveOrdinaryMaximumOutputTokens(
              this.#contextProfile,
              activeEstimate ?? estimateActiveContextTokens(messages, this.#contextProfile),
            );
      if (!isPositiveSafeInteger(maximumOutputTokens)) {
        return this.#settleContextCompactionFailed(
          new ContextCompactionError(
            "context_window_unrecoverable",
            "The active context leaves no safe output capacity for this model request.",
          ),
        );
      }
      if (!retryingSameTurn) {
        modelTurns += 1;
        nextAttemptNumber =
          resume !== undefined && modelTurns === resume.nextTurn ? resume.nextAttempt : 1;
      }
      const attemptNumber = nextAttemptNumber;
      if (this.#durableContext !== undefined) {
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "provider_attempt_started",
            runId: this.#activeRunId as string,
            turn: modelTurns,
            attempt: attemptNumber,
            targetIdentity: this.#durableContext.targetIdentity,
          },
        });
        this.#activeProviderAttempt = {
          runId: this.#activeRunId as string,
          turn: modelTurns,
          attempt: attemptNumber,
        };
      }
      await this.#emit({ type: "model_message_started" });
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      const answerChunks: string[] = [];
      const reasoningChunks: string[] = [];
      let answerBytes = 0;
      let reasoningBytes = 0;
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
      let replayEnvelopeTooLarge = false;
      let responseContentTooLarge = false;
      let usageWasReported = false;
      let responseUsage:
        | {
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly reasoningTokens?: number;
            readonly cachedInputTokens?: number;
            readonly cacheMissInputTokens?: number;
          }
        | undefined;
      const assemblingCalls = new Map<string, ToolCall>();
      const completedCalls: ToolCall[] = [];
      let streamError: unknown;
      const requestMessageCount = messages.length;

      try {
        for await (const event of this.#model.stream({
          messages: [...messages],
          tools: this.#tools?.definitions() ?? [],
          maximumOutputTokens,
          signal,
        })) {
          if (signal.aborted) {
            break;
          }
          switch (event.type) {
            case "text_delta":
              {
                const deltaBytes = Buffer.byteLength(event.text, "utf8");
                if (
                  answerBytes + reasoningBytes + deltaBytes >
                  this.#durableOutputLimits.maximumResponseContentBytes
                ) {
                  responseContentTooLarge = true;
                  break;
                }
                answerBytes += deltaBytes;
                answerChunks.push(event.text);
                await this.#emit({ type: "model_message_delta", text: event.text });
              }
              break;
            case "reasoning_delta": {
              const deltaBytes = Buffer.byteLength(event.text, "utf8");
              if (
                answerBytes + reasoningBytes + deltaBytes >
                this.#durableOutputLimits.maximumResponseContentBytes
              ) {
                responseContentTooLarge = true;
                break;
              }
              reasoningBytes += deltaBytes;
              reasoningChunks.push(event.text);
              break;
            }
            case "tool_call_start":
              if (
                this.#durableContext !== undefined &&
                assemblingCalls.size + completedCalls.length >= maximumReplayToolCalls
              ) {
                replayEnvelopeTooLarge = true;
              } else if (assemblingCalls.has(event.id)) {
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
                if (
                  this.#durableContext !== undefined &&
                  Buffer.byteLength(call.argumentsJson, "utf8") +
                    Buffer.byteLength(event.json, "utf8") >
                    maximumReplayFieldBytes
                ) {
                  replayEnvelopeTooLarge = true;
                  break;
                }
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
              activeProviderSample = {
                inputTokens: event.inputTokens,
                messageCount: requestMessageCount,
              };
              addContextUsage(ordinaryUsage, event);
              responseUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                ...(event.reasoningTokens === undefined
                  ? {}
                  : { reasoningTokens: event.reasoningTokens }),
                ...(event.cachedInputTokens === undefined
                  ? {}
                  : { cachedInputTokens: event.cachedInputTokens }),
                ...(event.cacheMissInputTokens === undefined
                  ? {}
                  : { cacheMissInputTokens: event.cacheMissInputTokens }),
              };
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
              if (this.#contextProfile !== undefined) {
                this.#publishContextUsage(ordinaryUsage, compactionUsage, {
                  source: "provider_reported",
                  tokens: event.inputTokens,
                  throughSequence: this.#nextSequence - 1,
                });
              }
              break;
            }
            case "finish":
              finishReason = event.reason;
              rawFinishReason = event.rawReason;
              break;
          }
          if (
            signal.aborted ||
            finishReason !== undefined ||
            replayEnvelopeTooLarge ||
            responseContentTooLarge
          ) {
            break;
          }
        }
      } catch (error) {
        streamError = error;
      }
      const answer = answerChunks.join("");
      const reasoning = reasoningChunks.join("");

      if (signal.aborted) {
        return this.#settleCancelled();
      }

      if (streamError !== undefined) {
        const contextProfile = this.#contextProfile;
        const safeContextOverflow =
          contextProfile !== undefined &&
          this.#durableContext !== undefined &&
          isContextLengthError(streamError) &&
          answer.length === 0 &&
          reasoning.length === 0 &&
          completedCalls.length === 0 &&
          assemblingCalls.size === 0;
        if (safeContextOverflow) {
          await this.#interruptProviderAttemptForContextOverflow();
          const remainingCompactionCalls = 2 - compactionCallsThisTurn;
          if (reactiveRetryUsed || remainingCompactionCalls <= 0) {
            return this.#settleContextCompactionFailed(
              new ContextCompactionError(
                "context_window_unrecoverable",
                "The provider still rejected the compacted context window.",
              ),
            );
          }
          const compacted = await this.#compactContext(messages, signal, {
            trigger: "provider_overflow",
            maximumAttempts: remainingCompactionCalls === 1 ? 1 : 2,
          });
          compactionCallsThisTurn += compacted.attemptCount;
          messages.splice(0, messages.length, ...compacted.messages);
          activeProviderSample = undefined;
          compactionUsage.unknownCalls += compacted.unknownCalls;
          if (compacted.usage !== undefined) {
            addContextUsage(compactionUsage, compacted.usage);
            reportedTokens += compacted.usage.inputTokens + compacted.usage.outputTokens;
          }
          if (compacted.unknownCalls > 0 && limits?.maxTokens !== undefined) {
            return this.#settleTokenUsageMissing();
          }
          if (limits?.maxTokens !== undefined && reportedTokens >= limits.maxTokens) {
            return this.#settleTokenLimitExceeded();
          }
          this.#publishContextUsage(ordinaryUsage, compactionUsage, {
            source: "estimated",
            tokens: estimateActiveContextTokens(messages, contextProfile),
            throughSequence: this.#nextSequence - 1,
          });
          reactiveRetryUsed = true;
          nextAttemptNumber = attemptNumber + 1;
          continuingSameTurn = true;
          skipProactiveCompaction = true;
          continue;
        }
        if (streamError instanceof ModelDriverError) {
          return this.#settleModelRequestFailed(streamError);
        }
        throw streamError;
      }

      if (replayEnvelopeTooLarge) {
        return this.#settleReplayEnvelopeTooLarge();
      }

      if (responseContentTooLarge) {
        return this.#settleModelResponseTooLarge();
      }

      if (finishReason === undefined) {
        return this.#settleIncompleteStream();
      }

      if (protocolError !== undefined) {
        return this.#settleProtocolInvalid(protocolError);
      }

      if (finishReason === "length") {
        const persisted = await this.#persistDurableModelResponse({
          answer,
          reasoning,
          answerBytes,
          reasoningBytes,
          toolCalls: [],
          toolIntents: [],
          finishReason,
          usage: responseUsage,
          turn: modelTurns,
          attempt: attemptNumber,
        });
        if (persisted === "artifact_quota_exceeded") {
          return this.#settleModelResponseArtifactQuotaExceeded();
        }
        if (persisted === "replay_envelope_too_large") {
          return this.#settleReplayEnvelopeTooLarge();
        }
        nextAttemptNumber = 1;
        await this.#emit({ type: "model_message_completed", text: answer });
        if (signal.aborted) {
          return this.#settleCancelled();
        }
        return this.#settle({ status: "incomplete", reason: "output_limit", answer });
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

      if (finishReason === "stop") {
        if (completedCalls.length > 0 || assemblingCalls.size > 0) {
          return this.#settleProtocolInvalid(
            completedCalls.length > 0
              ? "The model stopped after completing a tool request."
              : "The model stopped with an incomplete tool request.",
          );
        }
      } else if (assemblingCalls.size > 0) {
        return this.#settleProtocolInvalid("The model finished with an incomplete tool request.");
      } else if (completedCalls.length === 0) {
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
      const toolIntents = completedCalls.map((call) => this.#createToolIntent(call));

      const persisted = await this.#persistDurableModelResponse({
        answer,
        reasoning,
        answerBytes,
        reasoningBytes,
        toolCalls: completedCalls,
        toolIntents,
        finishReason,
        usage: responseUsage,
        turn: modelTurns,
        attempt: attemptNumber,
      });
      if (persisted === "artifact_quota_exceeded") {
        return this.#settleModelResponseArtifactQuotaExceeded();
      }
      if (persisted === "replay_envelope_too_large") {
        return this.#settleReplayEnvelopeTooLarge();
      }
      nextAttemptNumber = 1;
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
        const result: RunResult = { status: "completed", answer };
        return this.#settle(result);
      }

      messages.push({
        role: "assistant",
        content: answer,
        ...(reasoning.length === 0 ? {} : { reasoning }),
        toolCalls: completedCalls,
      });
      for (const call of uniqueCalls.values()) {
        const terminal = await this.#dispatchToolCall({
          call,
          emitRequested: true,
          emitStarted: true,
          messages,
          signal,
          toolResultsById,
        });
        if (terminal !== undefined) {
          return terminal;
        }
      }
    }
  }

  async #compactContext(
    messages: readonly ModelMessage[],
    signal: AbortSignal,
    options: {
      readonly trigger: "automatic_threshold" | "provider_overflow";
      readonly maximumAttempts: 1 | 2;
    },
  ): Promise<{
    readonly messages: readonly ModelMessage[];
    readonly attemptCount: number;
    readonly unknownCalls: number;
    readonly usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens?: number;
      readonly cachedInputTokens?: number;
      readonly cacheMissInputTokens?: number;
    };
  }> {
    const runId = this.#activeRunId;
    const durableContext = this.#durableContext;
    const contextProfile = this.#contextProfile;
    if (runId === undefined || durableContext === undefined || contextProfile === undefined) {
      throw new TypeError("Context compaction requires one active durable run and profile.");
    }
    const existingRecords = await this.#store.read();
    const latestCommitted = existingRecords.findLast(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    );
    if (
      this.#lastContextCheckpoint === undefined &&
      latestCommitted?.schemaVersion === 3 &&
      latestCommitted.record.type === "context_compaction_committed"
    ) {
      this.#contextWindowNumber = latestCommitted.record.windowNumber;
      this.#lastContextCheckpoint = {
        checkpointId: latestCommitted.record.checkpointId,
        sequence: latestCommitted.sequence,
      };
    }
    const latestInterrupted = existingRecords.findLast(
      (record) =>
        record.schemaVersion === 3 &&
        record.record.type === "context_compaction_interrupted" &&
        record.record.reason === "process_restart",
    );
    const interruptedRecord =
      latestInterrupted?.schemaVersion === 3 &&
      latestInterrupted.record.type === "context_compaction_interrupted" &&
      (latestCommitted === undefined || latestInterrupted.sequence > latestCommitted.sequence)
        ? latestInterrupted.record
        : undefined;
    const interruptedStart =
      interruptedRecord === undefined
        ? undefined
        : existingRecords.findLast(
            (record) =>
              record.sequence < (latestInterrupted?.sequence ?? 0) &&
              record.schemaVersion === 3 &&
              record.record.type === "context_compaction_started" &&
              record.record.attemptId === interruptedRecord.attemptId,
          );
    const interruptedStartRecord =
      interruptedStart?.schemaVersion === 3 &&
      interruptedStart.record.type === "context_compaction_started"
        ? interruptedStart.record
        : undefined;
    const currentPrefixDigest =
      interruptedStartRecord !== undefined
        ? digestContextRecordPrefix(
            existingRecords.filter(
              (record) => record.sequence <= interruptedStartRecord.sourceThrough,
            ),
          )
        : undefined;
    const resumedStart =
      interruptedStartRecord !== undefined &&
      interruptedStartRecord.sourceDigest === currentPrefixDigest
        ? interruptedStartRecord
        : undefined;
    const windowNumber = resumedStart?.windowNumber ?? this.#contextWindowNumber + 1;
    const sourceThrough = resumedStart?.sourceThrough ?? this.#nextSequence - 1;
    const sourceDigest =
      resumedStart?.sourceDigest ??
      digestContextRecordPrefix(
        existingRecords.filter((record) => record.sequence <= sourceThrough),
      );
    const previousCheckpointSequence =
      resumedStart?.previousCheckpointSequence ?? this.#lastContextCheckpoint?.sequence;
    const firstAttemptNumber = (resumedStart?.attemptNumber ?? 0) + 1;
    const lastAttemptNumber = Math.min(2, firstAttemptNumber + options.maximumAttempts - 1);
    const accumulatedUsages: Array<
      NonNullable<Awaited<ReturnType<typeof generateContextSummary>>["usage"]>
    > = [];
    let unknownCalls = 0;
    let retryMessages: readonly ModelMessage[] | undefined;
    for (
      let attemptNumber = firstAttemptNumber;
      attemptNumber <= lastAttemptNumber;
      attemptNumber += 1
    ) {
      const attemptId = randomUUID();
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "context_compaction_started",
          recordVersion: 1,
          runId,
          attemptId,
          attemptNumber,
          windowNumber,
          trigger: options.trigger,
          sourceThrough,
          ...(previousCheckpointSequence === undefined ? {} : { previousCheckpointSequence }),
          targetIdentity: durableContext.targetIdentity,
          contextProfile,
          projectionVersion: 1,
          sourceDigest,
        },
      });
      this.#publish({
        type: "context_compaction_started",
        attemptId,
        attemptNumber,
        windowNumber,
        trigger: options.trigger,
      });
      const records = await this.#store.read();
      const evidence = mergeContextEvidence(
        durableContext.inheritedEvidence,
        reduceContextEvidence(records, runId, sourceThrough),
      );
      const { summaryMessages, retainedMessages } =
        retryMessages === undefined
          ? splitContextForCompaction(
              messages,
              attemptNumber === 1 ? contextProfile.retainedTargetTokens : 0,
            )
          : { summaryMessages: retryMessages, retainedMessages: [] };
      let compacted: Awaited<ReturnType<typeof generateContextSummary>>;
      try {
        compacted = await generateContextSummary({
          evidence,
          messages: summaryMessages,
          model: this.#model,
          profile: contextProfile,
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          const interruptionUsage =
            error instanceof ContextCompactionInterruptedError ? error.usage : undefined;
          await this.#appendRecord({
            schemaVersion: 3,
            sequence: this.#nextSequence,
            record: {
              type: "context_compaction_interrupted",
              recordVersion: 1,
              runId,
              attemptId,
              attemptNumber,
              windowNumber,
              trigger: options.trigger,
              sourceThrough,
              reason: "caller_cancelled",
              usage: interruptionUsage ?? { status: "unknown" },
            },
          });
          this.#publish({
            type: "context_compaction_interrupted",
            attemptId,
            attemptNumber,
            windowNumber,
            reason: "caller_cancelled",
            usage: interruptionUsage ?? { status: "unknown" },
          });
          throw new Error("The context compaction request was cancelled.");
        }
        const compactionError =
          error instanceof ContextCompactionRequestError && error.cause instanceof ModelDriverError
            ? new ContextCompactionError(
                "context_compaction_failed",
                "The context compaction model request failed.",
                error.usage,
                error.cause,
              )
            : error instanceof ModelDriverError
              ? new ContextCompactionError(
                  "context_compaction_failed",
                  "The context compaction model request failed.",
                  undefined,
                  error,
                )
              : error;
        if (!(compactionError instanceof ContextCompactionError)) {
          throw compactionError;
        }
        const reason =
          compactionError.code === "context_compaction_failed"
            ? "model_request_failed"
            : compactionError.code === "context_compaction_input_unrecoverable"
              ? "input_unrecoverable"
              : "summary_invalid";
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "context_compaction_failed",
            recordVersion: 1,
            runId,
            attemptId,
            attemptNumber,
            windowNumber,
            trigger: options.trigger,
            sourceThrough,
            reason,
            ...(compactionError.usage === undefined ? {} : { usage: compactionError.usage }),
          },
        });
        this.#publish({
          type: "context_compaction_failed",
          attemptId,
          attemptNumber,
          windowNumber,
          reason,
        });
        throw compactionError;
      }
      if (compacted.usage !== undefined) {
        accumulatedUsages.push(compacted.usage);
      } else {
        unknownCalls += 1;
      }
      const replacementMessages = [...compacted.replacementMessages, ...retainedMessages];
      const replacementTooLarge =
        estimateActiveContextTokens(replacementMessages, contextProfile) >=
        contextProfile.postCompactTargetTokens;
      if (replacementTooLarge) {
        const smallerRetryMessages = shrinkContextMessagesForRetry(replacementMessages);
        const canRetryWithSmallerInput =
          attemptNumber < lastAttemptNumber &&
          estimateContextSummaryRequestTokens({
            evidence,
            messages: smallerRetryMessages,
            profile: contextProfile,
          }) <
            estimateContextSummaryRequestTokens({
              evidence,
              messages: summaryMessages,
              profile: contextProfile,
            });
        const reason = canRetryWithSmallerInput
          ? "replacement_too_large"
          : "context_window_unrecoverable";
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "context_compaction_failed",
            recordVersion: 1,
            runId,
            attemptId,
            attemptNumber,
            windowNumber,
            trigger: options.trigger,
            sourceThrough,
            reason,
            ...(compacted.usage === undefined ? {} : { usage: compacted.usage }),
          },
        });
        this.#publish({
          type: "context_compaction_failed",
          attemptId,
          attemptNumber,
          windowNumber,
          reason,
        });
        if (canRetryWithSmallerInput) {
          retryMessages = smallerRetryMessages;
          continue;
        }
        throw new ContextCompactionError(
          "context_window_unrecoverable",
          "The compacted context still exceeds the target boundary.",
          compacted.usage,
        );
      }
      const checkpointId = randomUUID();
      const retainedFrom =
        findRetainedFromSequence(records, runId, retainedMessages[0]) ?? sourceThrough + 1;
      const committedSequence = this.#nextSequence;
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "context_compaction_committed",
          recordVersion: 1,
          runId,
          attemptId,
          attemptNumber,
          checkpointId,
          windowNumber,
          trigger: options.trigger,
          sourceThrough,
          retainedFrom,
          ...(previousCheckpointSequence === undefined ? {} : { previousCheckpointSequence }),
          targetIdentity: durableContext.targetIdentity,
          contextProfile,
          projectionVersion: 1,
          sourceDigest,
          replacementDigest: digestContextMessages(replacementMessages),
          summary: compacted.summary,
          evidence,
          ...(compacted.usage === undefined ? {} : { usage: compacted.usage }),
        },
      });
      this.#contextWindowNumber = windowNumber;
      this.#lastContextCheckpoint = { checkpointId, sequence: committedSequence };
      this.#publish({
        type: "context_compaction_committed",
        attemptId,
        checkpointId,
        windowNumber,
        sourceThrough,
        retainedFrom,
      });
      const usage = mergeContextCallUsages(accumulatedUsages);
      return {
        messages: replacementMessages,
        attemptCount: attemptNumber,
        unknownCalls,
        ...(usage === undefined ? {} : { usage }),
      };
    }
    throw new TypeError("Context compaction attempt accounting was exhausted.");
  }

  async #dispatchToolCall(options: {
    readonly call: ToolCall;
    readonly emitRequested: boolean;
    readonly emitStarted: boolean;
    readonly messages: ModelMessage[];
    readonly reusablePermission?: PermissionPolicyInput | undefined;
    readonly signal: AbortSignal;
    readonly toolResultsById: Map<string, { readonly call: ToolCall; readonly result: ToolResult }>;
  }): Promise<RunResult | undefined> {
    const { call, messages, signal, toolResultsById } = options;
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    if (options.emitRequested) {
      await this.#emit({ type: "tool_requested", callId: call.id, name: call.name });
    }
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    const recordedCall = toolResultsById.get(call.id);
    if (recordedCall !== undefined) {
      if (
        recordedCall.call.name !== call.name ||
        recordedCall.call.argumentsJson !== call.argumentsJson
      ) {
        return this.#settleProtocolInvalid("The model reused a tool call ID with different input.");
      }
      await this.#appendToolResult(messages, call, recordedCall.result);
      return undefined;
    }
    const adapter = this.#tools?.resolve(call.name);
    if (adapter === undefined) {
      const result: ToolResult = {
        status: "failed",
        error: { code: "unknown_tool", message: `Unknown tool: ${call.name}` },
      };
      toolResultsById.set(call.id, { call, result });
      await this.#appendToolResult(messages, call, result);
      return undefined;
    }
    const preparedCall = adapter.prepare(call.argumentsJson);
    if (preparedCall.status === "failed") {
      toolResultsById.set(call.id, { call, result: preparedCall });
      await this.#appendToolResult(messages, call, preparedCall);
      return undefined;
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
    if (
      options.reusablePermission !== undefined &&
      policyDecision !== "deny" &&
      samePermissionInput(options.reusablePermission, permissionInput)
    ) {
      decision = "allow";
    } else if (policyDecision === "ask") {
      const runId = this.#activeRunId;
      if (runId === undefined) {
        throw new Error("Cannot request permission without an active run ID.");
      }
      const requestId = `${runId}:${call.id}`;
      const pendingDecision = this.#createPendingPermissionDecision(requestId, signal);
      try {
        await this.#emit({ type: "tool_permission_requested", requestId, ...permissionInput });
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
      await this.#emit({ type: "tool_permission_decided", decision, ...permissionInput });
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
      return undefined;
    }
    if (options.emitStarted) {
      await this.#emit({ type: "tool_started", callId: call.id, name: call.name });
    }
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    const result = await preparedCall.execute({ signal, callId: call.id, toolName: call.name });
    toolResultsById.set(call.id, { call, result });
    await this.#appendToolResult(messages, call, result);
    return undefined;
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

  async #settleReplayEnvelopeTooLarge(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "replay_envelope_too_large",
        message: "The complete model response exceeds the durable replay envelope limit.",
      },
    };
    return this.#settle(result);
  }

  async #settleModelResponseTooLarge(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_response_too_large",
        message: "The model response exceeded Adam's 64 MiB text and reasoning limit.",
      },
    };
    return this.#settle(result);
  }

  async #settleModelResponseArtifactQuotaExceeded(): Promise<RunResult> {
    const result: RunResult = {
      status: "failed",
      error: {
        code: "model_response_artifact_quota_exceeded",
        message: "The session exceeded Adam's logical model-response artifact quota.",
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

  async #settleContextCompactionFailed(error: ContextCompactionError): Promise<RunResult> {
    if (error.code === "context_compaction_failed") {
      const providerError = error.cause instanceof ModelDriverError ? error.cause : undefined;
      const result: RunResult = {
        status: "failed",
        error: {
          code: error.code,
          message: error.message,
          category: providerError?.category ?? "unknown",
          ...(providerError?.status === undefined ? {} : { status: providerError.status }),
          ...(providerError?.providerCode === undefined
            ? {}
            : { providerCode: providerError.providerCode }),
          ...(providerError?.requestId === undefined ? {} : { requestId: providerError.requestId }),
        },
      };
      return this.#settle(result);
    }
    const result: RunResult = {
      status: "failed",
      error: { code: error.code, message: error.message },
    };
    return this.#settle(result);
  }

  async #settle(result: RunResult, interrupted = false): Promise<RunResult> {
    if (this.#terminalResult !== undefined) {
      return this.#terminalResult;
    }
    this.#terminalResult = result;
    await this.#interruptActiveProviderAttempt(result);
    if (interrupted) {
      await this.#emit({ type: "session_interrupted", reason: "cancelled" });
    }
    if (
      (result.status === "completed" || result.status === "incomplete") &&
      this.#durableContext !== undefined &&
      this.#latestDurableResponse?.artifactBacked === true
    ) {
      const settlement =
        result.status === "completed"
          ? ({ status: "completed" } as const)
          : ({ status: "incomplete", reason: result.reason } as const);
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "run_settled",
          recordVersion: 1,
          runId: this.#activeRunId as string,
          responseSequence: this.#latestDurableResponse.sequence,
          ...settlement,
        },
      });
      this.#publish({ type: "session_settled", result });
      return result;
    }
    await this.#emit({ type: "session_settled", result });
    return result;
  }

  async #interruptActiveProviderAttempt(result: RunResult): Promise<void> {
    const attempt = this.#activeProviderAttempt;
    if (attempt === undefined) {
      return;
    }
    await this.#appendRecord({
      schemaVersion: 3,
      sequence: this.#nextSequence,
      record: {
        type: "provider_attempt_interrupted",
        runId: attempt.runId,
        turn: attempt.turn,
        attempt: attempt.attempt,
        reason: "run_terminal",
        result,
      },
    });
    this.#activeProviderAttempt = undefined;
  }

  async #interruptProviderAttemptForContextOverflow(): Promise<void> {
    const attempt = this.#activeProviderAttempt;
    if (attempt === undefined) {
      throw new TypeError("A context overflow requires one active provider attempt.");
    }
    await this.#appendRecord({
      schemaVersion: 3,
      sequence: this.#nextSequence,
      record: {
        type: "provider_attempt_interrupted",
        runId: attempt.runId,
        turn: attempt.turn,
        attempt: attempt.attempt,
        reason: "context_overflow",
      },
    });
    this.#activeProviderAttempt = undefined;
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
    if (
      event.type === "model_message_completed" &&
      this.#durableContext !== undefined &&
      this.#latestDurableResponse?.artifactBacked === true
    ) {
      const runId = this.#activeRunId;
      if (runId === undefined) {
        throw new Error("Cannot persist a session event without an active run ID.");
      }
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "model_response_published",
          recordVersion: 1,
          runId,
          responseSequence: this.#latestDurableResponse.sequence,
        },
      });
      this.#publish(event);
      return;
    }
    if (event.type !== "model_message_delta") {
      const canonicalEvent: CanonicalRuntimeEvent = event;
      const runId = this.#activeRunId;
      if (runId === undefined) {
        throw new Error("Cannot persist a session event without an active run ID.");
      }
      try {
        await this.#appendRecord(
          this.#durableContext === undefined
            ? {
                schemaVersion: 2,
                runId,
                sequence: this.#nextSequence,
                event: canonicalEvent,
              }
            : {
                schemaVersion: 3,
                sequence: this.#nextSequence,
                record: { type: "runtime_event", runId, event: canonicalEvent },
              },
        );
      } catch {
        throw new SessionPersistenceError();
      }
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #publish(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #publishContextUsage(
    ordinary: MutableContextUsageTotals,
    compaction: MutableContextUsageTotals,
    active: ActiveContextUsage,
  ): void {
    this.#publish({
      type: "context_usage",
      ordinary: { ...ordinary },
      compaction: { ...compaction },
      active,
    });
  }

  async #appendRecord(record: SessionRecord): Promise<void> {
    try {
      await this.#store.append(record);
    } catch {
      throw new SessionPersistenceError();
    }
    this.#nextSequence += 1;
  }

  async #persistDurableModelResponse(input: {
    readonly answer: string;
    readonly reasoning: string;
    readonly answerBytes: number;
    readonly reasoningBytes: number;
    readonly toolCalls: readonly ToolCall[];
    readonly toolIntents: readonly SessionToolIntent[];
    readonly finishReason: "length" | "stop" | "tool_calls";
    readonly usage:
      | {
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly reasoningTokens?: number;
          readonly cachedInputTokens?: number;
          readonly cacheMissInputTokens?: number;
        }
      | undefined;
    readonly turn: number;
    readonly attempt: number;
  }): Promise<"artifact_quota_exceeded" | "persisted" | "replay_envelope_too_large"> {
    const durableContext = this.#durableContext;
    if (durableContext === undefined) {
      return "persisted";
    }
    const responseSequence = this.#nextSequence;
    const responseFields = {
      toolCalls: input.toolCalls,
      toolIntents: input.toolIntents,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    };
    const inlineResponse: SessionModelResponse =
      input.finishReason === "length"
        ? {
            recordVersion: 2,
            text: { storage: "inline", text: input.answer },
            ...(input.reasoning.length === 0
              ? {}
              : { reasoning: { storage: "inline", text: input.reasoning } as const }),
            ...responseFields,
            finishReason: "length",
          }
        : {
            text: input.answer,
            ...(input.reasoning.length === 0 ? {} : { reasoning: input.reasoning }),
            ...responseFields,
            finishReason: input.finishReason,
          };
    const candidateInlineRecord: SessionRecord = {
      schemaVersion: 3,
      sequence: responseSequence,
      record: {
        type: "model_response_completed",
        runId: this.#activeRunId as string,
        turn: input.turn,
        attempt: input.attempt,
        targetIdentity: durableContext.targetIdentity,
        response: inlineResponse,
      },
    };
    const spillResponseGroup = !isSessionRecordWithinSizeLimit(candidateInlineRecord);
    const useVersionedResponse =
      input.finishReason === "length" ||
      spillResponseGroup ||
      input.answerBytes > this.#durableOutputLimits.maximumInlineFieldBytes ||
      input.reasoningBytes > this.#durableOutputLimits.maximumInlineFieldBytes;
    let response = inlineResponse;
    let referencedArtifactBytes = 0;
    if (useVersionedResponse) {
      referencedArtifactBytes =
        (input.answer.length > 0 &&
        (spillResponseGroup ||
          input.answerBytes > this.#durableOutputLimits.maximumInlineFieldBytes)
          ? input.answerBytes
          : 0) +
        (input.reasoning.length > 0 &&
        (spillResponseGroup ||
          input.reasoningBytes > this.#durableOutputLimits.maximumInlineFieldBytes)
          ? input.reasoningBytes
          : 0);
      if (
        this.#referencedModelResponseArtifactBytes + referencedArtifactBytes >
        this.#durableOutputLimits.maximumReferencedArtifactBytes
      ) {
        return "artifact_quota_exceeded";
      }
      const text = await this.#createDurableResponseField(
        input.answer,
        "text",
        input.turn,
        input.attempt,
        spillResponseGroup && input.answer.length > 0,
      );
      const reasoning =
        input.reasoning.length === 0
          ? undefined
          : await this.#createDurableResponseField(
              input.reasoning,
              "reasoning",
              input.turn,
              input.attempt,
              spillResponseGroup,
            );
      response = {
        recordVersion: 2,
        text,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...responseFields,
        finishReason: input.finishReason,
      };
    }
    const completedResponseRecord: SessionRecord = {
      schemaVersion: 3,
      sequence: responseSequence,
      record: {
        type: "model_response_completed",
        runId: this.#activeRunId as string,
        turn: input.turn,
        attempt: input.attempt,
        targetIdentity: durableContext.targetIdentity,
        response,
      },
    };
    if (!isSessionRecordWithinSizeLimit(completedResponseRecord)) {
      return "replay_envelope_too_large";
    }
    await this.#appendRecord(completedResponseRecord);
    this.#referencedModelResponseArtifactBytes += referencedArtifactBytes;
    this.#latestDurableResponse = {
      sequence: responseSequence,
      artifactBacked:
        response.recordVersion === 2 &&
        (response.text.storage === "artifact" || response.reasoning?.storage === "artifact"),
    };
    this.#activeProviderAttempt = undefined;
    return "persisted";
  }

  async #createDurableResponseField(
    text: string,
    field: ModelResponseArtifactSource["field"],
    turn: number,
    attempt: number,
    forceArtifact = false,
  ): Promise<SessionModelResponseField> {
    const bytes = Buffer.from(text, "utf8");
    if (!forceArtifact && bytes.byteLength <= this.#durableOutputLimits.maximumInlineFieldBytes) {
      return { storage: "inline", text };
    }
    const artifactStore = this.#artifactStore;
    const durableContext = this.#durableContext;
    const runId = this.#activeRunId;
    if (
      artifactStore === undefined ||
      durableContext?.projectId === undefined ||
      durableContext.sessionId === undefined ||
      runId === undefined
    ) {
      throw new SessionPersistenceError();
    }
    try {
      return {
        storage: "artifact",
        reference: await artifactStore.write({
          bytes,
          mediaType: "text/plain; charset=utf-8",
          source: {
            type: "model_response",
            schemaVersion: 1,
            field,
            projectId: durableContext.projectId,
            sessionId: durableContext.sessionId,
            runId,
            turn,
            attempt,
            targetIdentity: durableContext.targetIdentity,
            provenance: "provider_model_response",
          },
        }),
      };
    } catch {
      throw new SessionPersistenceError();
    }
  }

  #createToolIntent(call: ToolCall): SessionToolIntent {
    const adapter = this.#tools?.resolve(call.name);
    return {
      callId: call.id,
      name: call.name,
      argumentsDigest: `sha256:${createHash("sha256").update(call.argumentsJson).digest("hex")}`,
      ...(adapter === undefined
        ? {}
        : {
            effect: adapter.effect,
            definitionDigest: adapter.definitionDigest,
          }),
      replay: adapter?.replay ?? "never",
    };
  }
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

type MutableContextUsageTotals = {
  -readonly [Key in keyof ContextUsageTotals]: ContextUsageTotals[Key];
};

function createMutableContextUsageTotals(): MutableContextUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    unknownCalls: 0,
  };
}

function addContextUsage(
  totals: MutableContextUsageTotals,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number | undefined;
    readonly cachedInputTokens?: number | undefined;
    readonly cacheMissInputTokens?: number | undefined;
  },
): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.reasoningTokens += usage.reasoningTokens ?? 0;
  totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
  totals.cacheMissInputTokens += usage.cacheMissInputTokens ?? 0;
}

function findRetainedFromSequence(
  records: readonly SessionRecord[],
  runId: string,
  firstRetained: ModelMessage | undefined,
): number | undefined {
  if (firstRetained === undefined) {
    return undefined;
  }
  for (const entry of records) {
    if (entry.schemaVersion !== 3 || entry.sequence < 1) {
      continue;
    }
    const record = entry.record;
    if (
      record.type === "logical_run_started" &&
      record.runId === runId &&
      firstRetained.role === "user" &&
      record.userMessage === firstRetained.content
    ) {
      return entry.sequence;
    }
    if (record.type === "model_response_completed" && record.runId === runId) {
      if (
        firstRetained.role === "assistant" &&
        record.response.text === firstRetained.content &&
        JSON.stringify(record.response.toolCalls) === JSON.stringify(firstRetained.toolCalls)
      ) {
        return entry.sequence;
      }
      continue;
    }
    if (record.type !== "runtime_event" || record.runId !== runId) {
      continue;
    }
    const event = record.event;
    if (
      firstRetained.role === "tool" &&
      (event.type === "tool_completed" || event.type === "tool_failed") &&
      event.callId === firstRetained.callId &&
      event.name === firstRetained.name
    ) {
      return entry.sequence;
    }
  }
  return undefined;
}

function mergeContextCallUsages(
  usages: readonly {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheMissInputTokens?: number;
  }[],
):
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens?: number;
      readonly cachedInputTokens?: number;
      readonly cacheMissInputTokens?: number;
    }
  | undefined {
  if (usages.length === 0) {
    return undefined;
  }
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
  };
  for (const usage of usages) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningTokens += usage.reasoningTokens ?? 0;
    totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    totals.cacheMissInputTokens += usage.cacheMissInputTokens ?? 0;
  }
  return totals;
}

const maximumReplayFieldBytes = 512 * 1024;
const maximumReplayToolCalls = 128;

function samePermissionInput(left: PermissionPolicyInput, right: PermissionPolicyInput): boolean {
  return (
    left.callId === right.callId &&
    left.name === right.name &&
    left.effect === right.effect &&
    left.scope === right.scope &&
    JSON.stringify(left.subject) === JSON.stringify(right.subject)
  );
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

function isContextLengthError(error: unknown): error is ModelDriverError {
  return (
    error instanceof ModelDriverError &&
    error.category === "invalid_request" &&
    (error.providerCode === "context_length_exceeded" ||
      error.providerCode === "context_window_exceeded")
  );
}
