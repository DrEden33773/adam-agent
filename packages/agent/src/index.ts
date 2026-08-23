import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type {
  ArtifactReference,
  ArtifactStore,
  ChangePreviewArtifactSource,
  ModelResponseArtifactSource,
} from "./artifact-store.js";
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
  assemblePromptMessagesV1,
  createPromptContextV1,
  digestPromptMessagePrefixV1,
  digestPromptRequestV1,
  estimatePromptTokensV1,
  hasSkillPromptContext,
  isPromptContextRecordCompatible,
  type PromptContextRecord,
  type PromptContextRecordV1,
  type PromptContextRecordV2,
  type PromptContextRecordV3,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import {
  loadRepositoryInstructions,
  RepositoryInstructionsError,
} from "./repository-instructions.js";
import {
  type AgentSessionDurableContext,
  type AgentSessionDurableOutputLimits,
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";
import { sessionTitleFallback } from "./session-naming.js";
import {
  activateSkillContextV1,
  buildSkillResourceManifestV1,
  type ExtensionSkillSourceV1,
  extendSkillContextWithProjectScopesV1,
  readSkillResourcePageV1,
  type SkillContextRecordV1,
  SkillResourceError,
  SkillsError,
} from "./skills.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";

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
export {
  createPresentationPreferences,
  type PresentationPreferences,
  type PresentationPreferencesDiagnostic,
  type PresentationPreferencesSnapshot,
} from "./presentation-preferences.js";
export {
  type CreatePresentationSessionOptions,
  createPresentationSession,
} from "./presentation-session.js";
export {
  resolveThinkingPolicy,
  type ThinkingCapabilityV1,
  ThinkingPolicyError,
  type ThinkingPolicyMappingV1,
  type ThinkingPolicySelectionV1,
  type ThinkingPolicySnapshotV1,
} from "./thinking-policy.js";

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
  type McpCloseResult,
  type McpConfigurationCommand,
  type McpConfigurationResult,
  type McpSessionSnapshot,
  type RepositoryInstructionsReloadResult,
  type SessionBranchInput,
  type SessionCommand,
  type SessionContextSnapshot,
  type SessionContinueResult,
  type SessionLifecycle,
  SessionLifecycleError,
  type SessionLifecycleOptions,
  type SessionMetadataEvent,
  type SessionMetadataListener,
  type SessionNamingResult,
  type SessionResumeResult,
  type SessionRuntimeNotification,
  type SessionRuntimeNotificationListener,
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
  readonly skills?: readonly string[];
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
  readonly purpose?: "ordinary" | "title" | "compaction";
  readonly signal: AbortSignal;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
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
              | "turn_limit_exceeded"
              | "token_limit_exceeded"
              | "token_usage_missing"
              | "context_compaction_input_unrecoverable"
              | "context_compaction_invalid"
              | "context_window_unrecoverable";
            readonly message: string;
          }
        | {
            readonly code: "tool_effect_indeterminate";
            readonly reason:
              | "mcp_request_timeout"
              | "mcp_caller_cancelled"
              | "mcp_connection_closed"
              | "mcp_protocol_error"
              | "process_restart";
            readonly message: string;
          }
        | {
            readonly code: "skill_activation_failed";
            readonly message: string;
            readonly ambiguity?:
              | {
                  readonly selection: string;
                  readonly candidates: readonly string[];
                  readonly omittedCount: number;
                }
              | undefined;
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
  | {
      readonly type: "repository_instructions_activated";
      readonly revision: number;
      readonly effectiveDigest: `sha256:${string}`;
      readonly reason: "path_scope_activation";
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
      readonly changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource> | undefined;
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
      readonly changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource> | undefined;
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
  | {
      readonly type: "mcp_catalog_state_changed";
      readonly generationId: string;
      readonly serverId: string;
      readonly catalogDigest: `sha256:${string}`;
      readonly status: "stale";
      readonly reason: "list_changed";
    }
  | { readonly type: "session_interrupted"; readonly reason: "cancelled" }
  | { readonly type: "session_settled"; readonly result: RunResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type RuntimeEventNotification = {
  readonly notificationId: string;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly throughSequence: number;
  readonly event: RuntimeEvent;
};

export type RuntimeEventNotificationListener = (notification: RuntimeEventNotification) => void;

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
  readonly #notificationListeners = new Set<RuntimeEventNotificationListener>();
  #nextNotification = 1;
  readonly #artifactStore: ArtifactStore | undefined;
  readonly #model: ModelDriver;
  readonly #tools: ToolRegistry | undefined;
  readonly #permissions: PermissionPolicy | undefined;
  #promptContext: PromptContextRecord | undefined;
  #skillContext: SkillContextRecordV1 | undefined;
  readonly #activeSkillContents = new Map<string, string>();
  readonly #repositoryWorkspaceRoot: string | undefined;
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
  #hasUncheckpointedInheritedMessages: boolean;
  #terminalResult: RunResult | undefined;
  #latestDurableResponse:
    | { readonly sequence: number; readonly artifactBacked: boolean }
    | undefined;
  #referencedModelResponseArtifactBytes: number;
  #skillResourceRunBytes: number;
  #skillResourceLineageBytes: number;
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
    this.#skillResourceRunBytes = this.#durableContext?.skillResourceRunBytes ?? 0;
    this.#skillResourceLineageBytes = this.#durableContext?.skillResourceLineageBytes ?? 0;
    this.#contextProfile = dependencies.contextProfile;
    const maximumOutputTokens =
      dependencies.contextProfile?.maximumOutputTokens ?? dependencies.maximumOutputTokens;
    if (maximumOutputTokens === undefined || !isPositiveSafeInteger(maximumOutputTokens)) {
      throw new RangeError("The model output limit must be a positive safe integer.");
    }
    this.#maximumOutputTokens = maximumOutputTokens;
    this.#model = dependencies.model;
    const durablePromptContext = this.#durableContext?.promptContext;
    const selectedToolNames =
      durablePromptContext === undefined
        ? ["read_file", "write_file", "edit_file", "run_shell"]
        : durablePromptContext.toolProfile.definitions.map((definition) => definition.name);
    this.#tools =
      this.#durableContext !== undefined && durablePromptContext === undefined
        ? filterLiveToolRegistry(dependencies.tools, [
            "read_file",
            "write_file",
            "edit_file",
            "run_shell",
          ])
        : captureToolRegistry(dependencies.tools, selectedToolNames);
    this.#permissions = dependencies.permissions;
    this.#promptContext =
      this.#durableContext === undefined
        ? createPromptContextV1(this.#tools)
        : this.#durableContext.promptContext;
    this.#skillContext = this.#durableContext?.skillContext;
    for (const [qualifiedId, content] of this.#durableContext?.activeSkillContents ?? []) {
      this.#activeSkillContents.set(qualifiedId, content);
    }
    this.#repositoryWorkspaceRoot = this.#durableContext?.repositoryWorkspaceRoot;
    if (
      this.#promptContext !== undefined &&
      !isPromptContextRecordCompatible(this.#promptContext, this.#tools)
    ) {
      throw new TypeError("The exact recorded prompt and tool profile is not supported.");
    }
    if (hasSkillPromptContext(this.#promptContext) !== (this.#skillContext !== undefined)) {
      throw new TypeError("The exact recorded Skill profile is not supported.");
    }
    this.#hasUncheckpointedInheritedMessages = this.#durableContext?.hasInheritedMessages === true;
    this.#store = dependencies.store as unknown as SessionStore<SessionRecord>;
    this.#nextSequence = this.#durableContext?.nextSequence ?? 1;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeNotifications(listener: RuntimeEventNotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
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
    if (!areSkillSelectionsValid(input.skills)) {
      return {
        status: "failed",
        error: {
          code: "skill_activation_failed",
          message: "Explicit Skill selections must be a bounded list of nonempty ASCII handles.",
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
    this.#activeRunId =
      this.#durableContext?.resume?.runId ?? this.#durableContext?.newRunId ?? randomUUID();
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
        const explicitSkills = (input.skills ?? []).map((selection, index) => ({
          selection,
          requestId: `${this.#activeRunId}:skill:${index + 1}`,
        }));
        if (this.#durableContext !== undefined && this.#durableContext.resume === undefined) {
          const isFirstLogicalRun = !(await this.#store.read()).some(
            (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
          );
          const genesisHasFallback = (await this.#store.read()).some(
            (record) =>
              record.schemaVersion === 3 &&
              record.record.type === "session_genesis" &&
              record.record.naming !== undefined,
          );
          const logicalRunStartedSequence = this.#nextSequence;
          await this.#appendRecord({
            schemaVersion: 3,
            sequence: logicalRunStartedSequence,
            record: {
              type: "logical_run_started",
              runId: this.#activeRunId,
              userMessage: input.text,
              ...(isFirstLogicalRun && !genesisHasFallback
                ? {
                    naming: {
                      profileVersion: 1 as const,
                      fallbackTitle: sessionTitleFallback(input.text),
                    },
                  }
                : {}),
              ...(explicitSkills.length === 0 ? {} : { skills: explicitSkills }),
              ...(options.limits === undefined ? {} : { limits: options.limits }),
              ...(this.#durableContext.thinkingPolicy === undefined
                ? {}
                : { thinkingPolicy: this.#durableContext.thinkingPolicy }),
            },
          });
          const sessionId = this.#durableContext.sessionId;
          if (sessionId !== undefined) {
            await this.#durableContext.afterLogicalRunStarted?.({
              sessionId,
              runId: this.#activeRunId,
              sequence: logicalRunStartedSequence,
            });
          }
        }
        return await this.#run(input, abortController.signal, options.limits, explicitSkills);
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
    explicitSkills: readonly { readonly selection: string; readonly requestId: string }[],
  ): Promise<RunResult> {
    const resume = this.#durableContext?.resume;
    if (resume === undefined) {
      await this.#emit({ type: "user_message", text: input.text });
      if (signal.aborted) {
        return this.#settleCancelled();
      }
      const activationFailure = await this.#activateExplicitSkills(explicitSkills, signal);
      if (activationFailure !== undefined) {
        return this.#settle(activationFailure);
      }
    } else if ((resume.pendingExplicitSkills?.length ?? 0) > 0) {
      const activationFailure = await this.#activateExplicitSkills(
        resume.pendingExplicitSkills ?? [],
        signal,
        new Map(
          (resume.explicitSkillPermissions ?? []).map((permission) => [
            permission.requestId,
            permission.decision,
          ]),
        ),
      );
      if (activationFailure !== undefined) {
        return this.#settle(activationFailure);
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
      | {
          readonly assemblyIdentity: string;
          readonly inputTokens: number;
          readonly messageCount: number;
          readonly messagePrefixDigest: string;
        }
      | undefined;

    if (resume?.compactionUsageUnknown === true && limits?.maxTokens !== undefined) {
      return this.#settleTokenUsageMissing();
    }

    for (const pending of resume?.pendingToolCalls ?? []) {
      if (pending.replayResult !== undefined) {
        toolResultsById.set(pending.call.id, {
          call: pending.call,
          result: pending.replayResult,
        });
      }
      const terminal = await this.#dispatchToolCall({
        call: pending.call,
        emitRequested: !pending.requested,
        emitStarted: !pending.started,
        messages,
        ...(pending.repositoryActivation === undefined
          ? {}
          : { repositoryActivation: pending.repositoryActivation }),
        ...(pending.repositoryDisposition === undefined
          ? {}
          : { repositoryDisposition: pending.repositoryDisposition }),
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
      let requestMessages = this.#assemblePromptMessages(messages);
      const requestTools = this.#tools?.definitions() ?? [];
      let activeEstimate =
        this.#contextProfile === undefined
          ? undefined
          : activeProviderSample === undefined ||
              activeProviderSample.assemblyIdentity !==
                (this.#promptContext?.assemblyIdentityDigest ?? "prompt-profile-v0") ||
              activeProviderSample.messageCount > requestMessages.length ||
              activeProviderSample.messagePrefixDigest !==
                digestPromptMessagePrefixV1(
                  requestMessages.slice(0, activeProviderSample.messageCount),
                )
            ? this.#estimatePromptTokens(requestMessages, requestTools)
            : activeProviderSample.inputTokens +
              estimateActiveContextTokens(
                requestMessages.slice(activeProviderSample.messageCount),
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
        requestMessages = this.#assemblePromptMessages(messages);
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
        activeEstimate = this.#estimatePromptTokens(requestMessages, requestTools);
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
              activeEstimate ?? this.#estimatePromptTokens(requestMessages, requestTools),
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
        const targetIdentity = this.#durableContext.targetIdentity;
        const appendAttempt = async () => {
          await this.#appendRecord({
            schemaVersion: 3,
            sequence: this.#nextSequence,
            record: {
              type: "provider_attempt_started",
              runId: this.#activeRunId as string,
              turn: modelTurns,
              attempt: attemptNumber,
              targetIdentity,
              ...(this.#promptContext === undefined
                ? {}
                : {
                    promptProjection: {
                      version: 1 as const,
                      assemblyIdentityDigest: this.#promptContext.assemblyIdentityDigest,
                      requestProjectionDigest: digestPromptRequestV1(requestMessages, requestTools),
                    },
                  }),
            },
          });
          this.#activeProviderAttempt = {
            runId: this.#activeRunId as string,
            turn: modelTurns,
            attempt: attemptNumber,
          };
        };
        const attemptCommitted =
          this.#skillContext === undefined
            ? { status: "current" as const, value: await appendAttempt() }
            : await this.#withCurrentExtensionSkills(
                this.#skillContext,
                this.#skillContext.active.map((activation) => activation.qualifiedId),
                appendAttempt,
              );
        if (attemptCommitted.status === "stale") {
          return this.#settle(
            skillActivationFailure("An active extension Agent Skill became unavailable."),
          );
        }
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
      const requestMessageCount = requestMessages.length;

      try {
        for await (const event of this.#model.stream({
          messages: requestMessages,
          tools: requestTools,
          maximumOutputTokens,
          purpose: "ordinary",
          signal,
          ...(this.#durableContext?.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: this.#durableContext.thinkingPolicy }),
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
                assemblyIdentity:
                  this.#promptContext?.assemblyIdentityDigest ?? "prompt-profile-v0",
                inputTokens: event.inputTokens,
                messageCount: requestMessageCount,
                messagePrefixDigest: digestPromptMessagePrefixV1(requestMessages),
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
            tokens: this.#estimatePromptTokens(
              this.#assemblePromptMessages(messages),
              requestTools,
            ),
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

  #assemblePromptMessages(transcript: readonly ModelMessage[]): readonly ModelMessage[] {
    return this.#promptContext === undefined
      ? [...transcript]
      : assemblePromptMessagesV1(
          transcript,
          this.#promptContext,
          this.#skillContext,
          this.#activeSkillContents,
        );
  }

  #estimatePromptTokens(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
  ): number {
    const profile = this.#contextProfile;
    if (profile === undefined) {
      throw new TypeError("Prompt token estimation requires a context profile.");
    }
    return this.#promptContext === undefined
      ? estimateActiveContextTokens(messages, profile)
      : estimatePromptTokensV1(messages, tools, profile);
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
              attemptNumber === 1 && !this.#hasUncheckpointedInheritedMessages
                ? contextProfile.retainedTargetTokens
                : 0,
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
        this.#estimatePromptTokens(
          this.#assemblePromptMessages(replacementMessages),
          this.#tools?.definitions() ?? [],
        ) >= contextProfile.postCompactTargetTokens;
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
      this.#hasUncheckpointedInheritedMessages = false;
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

  #extensionSourcesForSkills(
    context: SkillContextRecordV1,
    qualifiedIds: readonly string[],
  ): readonly ExtensionSkillSourceV1[] | undefined {
    const sources: ExtensionSkillSourceV1[] = [];
    for (const qualifiedId of qualifiedIds) {
      const candidate = context.registry.candidates.find(
        (entry) => entry.qualifiedId === qualifiedId,
      );
      if (candidate?.locator.source !== "extension") {
        continue;
      }
      const locator = candidate.locator;
      const source = this.#durableContext?.extensionSkillSources?.find(
        (entry) =>
          entry.locator.extensionId === locator.extensionId &&
          entry.locator.packageName === locator.packageName &&
          entry.locator.packageVersion === locator.packageVersion &&
          entry.lifecycleRevision === candidate.sourceEpoch?.lifecycleRevision &&
          entry.lifecycleDigest === candidate.sourceEpoch?.lifecycleDigest,
      );
      if (source === undefined) {
        return undefined;
      }
      if (!sources.includes(source)) {
        sources.push(source);
      }
    }
    return sources;
  }

  async #withCurrentExtensionSkills<T>(
    context: SkillContextRecordV1,
    qualifiedIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<{ readonly status: "current"; readonly value: T } | { readonly status: "stale" }> {
    const sources = this.#extensionSourcesForSkills(context, qualifiedIds);
    if (sources === undefined) {
      return { status: "stale" };
    }
    if (sources.length === 0) {
      return { status: "current", value: await operation() };
    }
    const guard = this.#durableContext?.withCurrentExtensionSkillSources;
    return guard === undefined ? { status: "stale" } : guard(sources, operation);
  }

  async #activateExplicitSkills(
    selections: readonly { readonly selection: string; readonly requestId: string }[],
    signal: AbortSignal,
    reusablePermissions = new Map<string, "allow" | "deny">(),
  ): Promise<Extract<RunResult, { readonly status: "failed" }> | undefined> {
    if (selections.length === 0) {
      return undefined;
    }
    const skillContext = this.#skillContext;
    const promptContext = this.#promptContext;
    const runId = this.#activeRunId;
    if (
      skillContext === undefined ||
      !hasSkillPromptContext(promptContext) ||
      runId === undefined
    ) {
      return skillActivationFailure("Agent Skills are unavailable in this session.");
    }
    const resolved: Array<{
      readonly selection: string;
      readonly qualifiedId: string;
      readonly requestId: string;
    }> = [];
    const resolvedSelections: Array<{
      readonly selection: string;
      readonly qualifiedId: string;
      readonly requestId: string;
      readonly duplicate: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const [index, persistedSelection] of selections.entries()) {
      const { selection, requestId } = persistedSelection;
      if (requestId !== `${runId}:skill:${index + 1}`) {
        return skillActivationFailure("Explicit Agent Skill selection identity is invalid.");
      }
      const exact = skillContext.registry.candidates.find(
        (candidate) => candidate.qualifiedId === selection,
      );
      const shortMatches = skillContext.registry.candidates.filter(
        (candidate) => candidate.name === selection,
      );
      if (exact === undefined && shortMatches.length > 1) {
        const candidates = shortMatches.slice(0, 8).map((candidate) => candidate.qualifiedId);
        return skillActivationFailure("The explicit Agent Skill name is ambiguous.", {
          selection,
          candidates,
          omittedCount: shortMatches.length - candidates.length,
        });
      }
      const candidate = exact ?? (shortMatches.length === 1 ? shortMatches[0] : undefined);
      if (candidate === undefined) {
        return skillActivationFailure("One explicit Agent Skill selection is unavailable.");
      }
      const duplicate = seen.has(candidate.qualifiedId);
      resolvedSelections.push({
        selection,
        qualifiedId: candidate.qualifiedId,
        requestId,
        duplicate,
      });
      if (duplicate) {
        continue;
      }
      seen.add(candidate.qualifiedId);
      resolved.push({
        selection,
        qualifiedId: candidate.qualifiedId,
        requestId,
      });
    }
    let stagedContext = skillContext;
    const stagedContents = new Map(this.#activeSkillContents);
    for (const selection of resolved) {
      if (stagedContext.active.some((entry) => entry.qualifiedId === selection.qualifiedId)) {
        continue;
      }
      let activation: ReturnType<typeof activateSkillContextV1>;
      try {
        const candidate = stagedContext.registry.candidates.find(
          (entry) => entry.qualifiedId === selection.qualifiedId,
        );
        if (candidate === undefined || this.#repositoryWorkspaceRoot === undefined) {
          return skillActivationFailure("Explicit Agent Skill content is unavailable.");
        }
        const manifest =
          this.#durableContext?.preparedExplicitSkillManifests?.get(selection.requestId) ??
          (await buildSkillResourceManifestV1({
            candidate,
            workspaceRoot: this.#repositoryWorkspaceRoot,
            userHome: homedir(),
            userHomeDigest: stagedContext.userHomeDigest,
            ...(this.#durableContext?.extensionSkillSources === undefined
              ? {}
              : { extensionSources: this.#durableContext.extensionSkillSources }),
          }));
        activation = activateSkillContextV1({
          context: stagedContext,
          qualifiedId: selection.qualifiedId,
          reason: "user_explicit",
          runId,
          requestId: selection.requestId,
          manifest,
        });
      } catch (error) {
        if (error instanceof SkillsError) {
          return skillActivationFailure("Explicit Agent Skill activation exceeds its limits.");
        }
        throw error;
      }
      const bytes = await this.#artifactStore?.read(activation.activation.artifact.id, {
        maximumBytes: activation.activation.byteCount,
      });
      if (
        bytes === undefined ||
        bytes.byteLength !== activation.activation.byteCount ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
          activation.activation.skillMdDigest
      ) {
        return skillActivationFailure("Explicit Agent Skill content is unavailable.");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return skillActivationFailure("Explicit Agent Skill content is invalid.");
      }
      stagedContext = activation.context;
      stagedContents.set(selection.qualifiedId, content);
    }
    const newActivationIds = new Set(
      stagedContext.active
        .slice(skillContext.active.length)
        .map((activation) => activation.qualifiedId),
    );
    for (const selection of resolved) {
      if (!newActivationIds.has(selection.qualifiedId)) {
        continue;
      }
      const permissionInput: PermissionPolicyInput = {
        callId: selection.requestId,
        name: "activate_skill",
        effect: "read",
        scope: "call",
        subject: {
          type: "skill",
          operation: "activate",
          qualifiedId: selection.qualifiedId,
        },
      };
      const policyDecision =
        this.#durableContext?.preparedExplicitSkillPolicies?.get(selection.requestId) ??
        this.#permissions?.decide(permissionInput) ??
        "deny";
      let decision: "allow" | "deny";
      const reusableDecision = reusablePermissions.get(selection.requestId);
      if (reusableDecision !== undefined && policyDecision !== "deny") {
        decision = reusableDecision;
      } else if (policyDecision === "ask") {
        const pendingDecision = this.#createPendingPermissionDecision(selection.requestId, signal);
        try {
          await this.#emit({
            type: "tool_permission_requested",
            requestId: selection.requestId,
            ...permissionInput,
          });
          const userDecision = await pendingDecision.promise;
          if (userDecision === undefined) {
            return skillActivationFailure("Explicit Agent Skill activation was cancelled.");
          }
          decision = userDecision;
          await this.#emit({
            type: "tool_permission_decided",
            requestId: selection.requestId,
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
      if (decision !== "allow") {
        return skillActivationFailure("Explicit Agent Skill activation was denied.");
      }
    }
    const outcomes = resolvedSelections.map((selection) => {
      const activation = stagedContext.active.find(
        (entry) => entry.qualifiedId === selection.qualifiedId,
      );
      if (activation === undefined) {
        throw new SkillsError("skill_catalog_unavailable");
      }
      return {
        selection: selection.selection,
        requestId: selection.requestId,
        qualifiedId: selection.qualifiedId,
        status: selection.duplicate
          ? ("already_selected" as const)
          : skillContext.active.some((entry) => entry.qualifiedId === selection.qualifiedId)
            ? ("already_active" as const)
            : ("activated" as const),
        activationIndex: activation.activationIndex,
      };
    });
    const nextPromptContext = replacePromptSkillsV2(promptContext, stagedContext);
    const newActivations = stagedContext.active.slice(skillContext.active.length);
    const committed = await this.#withCurrentExtensionSkills(
      stagedContext,
      stagedContext.active.map((activation) => activation.qualifiedId),
      async () => {
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "skill_activation_batch_committed",
            recordVersion: 1,
            runId,
            previousActivationDigest: skillContext.activationDigest,
            skillContext: stagedContext,
            assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
            outcomes,
          },
        });
        for (const activation of newActivations) {
          await this.#appendRecord({
            schemaVersion: 3,
            sequence: this.#nextSequence,
            record: {
              type: "skill_activated",
              recordVersion: 1,
              runId,
              catalogRevision: activation.catalogRevision,
              activationIndex: activation.activationIndex,
              qualifiedId: activation.qualifiedId,
              reason: activation.reason,
              skillMdDigest: activation.skillMdDigest,
              manifestDigest: activation.manifest.digest,
            },
          });
        }
      },
    );
    if (committed.status === "stale") {
      return skillActivationFailure("Explicit Agent Skill content is unavailable.");
    }
    this.#skillContext = stagedContext;
    this.#promptContext = nextPromptContext;
    this.#activeSkillContents.clear();
    for (const [qualifiedId, content] of stagedContents) {
      this.#activeSkillContents.set(qualifiedId, content);
    }
    return undefined;
  }

  async #dispatchToolCall(options: {
    readonly call: ToolCall;
    readonly emitRequested: boolean;
    readonly emitStarted: boolean;
    readonly messages: ModelMessage[];
    readonly repositoryActivation?: {
      readonly revision: number;
      readonly effectiveDigest: `sha256:${string}`;
      readonly publishEvent: boolean;
    };
    readonly repositoryDisposition?: "mutation_retry_required" | "read_continue" | "unavailable";
    readonly reusablePermission?: PermissionPolicyInput | undefined;
    readonly signal: AbortSignal;
    readonly toolResultsById: Map<string, { readonly call: ToolCall; readonly result: ToolResult }>;
  }): Promise<RunResult | undefined> {
    const { call, messages, signal, toolResultsById } = options;
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    if (options.repositoryActivation?.publishEvent === true) {
      await this.#emit({
        type: "repository_instructions_activated",
        revision: options.repositoryActivation.revision,
        effectiveDigest: options.repositoryActivation.effectiveDigest,
        reason: "path_scope_activation",
      });
    }
    if (
      options.repositoryDisposition === "mutation_retry_required" ||
      options.repositoryDisposition === "unavailable"
    ) {
      const combinedProjectContext = hasSkillPromptContext(this.#promptContext);
      const result: Extract<ToolResult, { readonly status: "failed" }> =
        options.repositoryDisposition === "mutation_retry_required"
          ? {
              status: "failed",
              error: {
                code: combinedProjectContext
                  ? "project_context_changed"
                  : "repository_context_changed",
                message: combinedProjectContext
                  ? "Project path context changed; reconsider this mutation with a new call ID."
                  : "Repository instructions changed; reconsider this mutation with a new call ID.",
              },
            }
          : {
              status: "failed",
              error: {
                code: combinedProjectContext
                  ? "project_context_unavailable"
                  : "repository_instructions_unavailable",
                message: combinedProjectContext
                  ? "Project path context could not be loaded safely."
                  : "Repository instructions for the requested path are unavailable.",
              },
            };
      toolResultsById.set(call.id, { call, result });
      await this.#appendToolResult(messages, call, result);
      return undefined;
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
    const preparedPermissionSubject = preparedCall.permissionSubject;
    const visibleModelSkillSelection =
      preparedPermissionSubject.type === "skill" &&
      preparedPermissionSubject.operation === "activate" &&
      this.#skillContext?.catalog.entries.some(
        (entry) => entry.qualifiedId === preparedPermissionSubject.qualifiedId,
      );
    if (call.name === "activate_skill" && visibleModelSkillSelection !== true) {
      const result: ToolResult = {
        status: "failed",
        error: {
          code: "skill_unavailable",
          message: "The requested Agent Skill is unavailable in the visible catalog.",
        },
      };
      toolResultsById.set(call.id, { call, result });
      await this.#appendToolResult(messages, call, result);
      return undefined;
    }
    const repositoryPreflight = await this.#preflightRepositoryInstructions(
      call,
      preparedCall.permissionSubject,
    );
    if (repositoryPreflight !== undefined) {
      toolResultsById.set(call.id, { call, result: repositoryPreflight });
      await this.#appendToolResult(messages, call, repositoryPreflight);
      return undefined;
    }
    let changePreviewRef: ArtifactReference<ChangePreviewArtifactSource> | undefined;
    if (preparedCall.changePreview !== undefined) {
      const runId = this.#activeRunId;
      const durableContext = this.#durableContext;
      const previewBytes = Buffer.from(preparedCall.changePreview.text, "utf8");
      if (
        this.#artifactStore !== undefined &&
        durableContext?.projectId !== undefined &&
        durableContext.sessionId !== undefined &&
        runId !== undefined
      ) {
        if (
          (call.name !== "write_file" && call.name !== "edit_file") ||
          previewBytes.byteLength > 64 * 1024
        ) {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "artifact_store_failed",
              message: "The canonical change preview could not be made durable.",
            },
          };
          toolResultsById.set(call.id, { call, result });
          await this.#appendToolResult(messages, call, result);
          return undefined;
        }
        try {
          changePreviewRef = await this.#artifactStore.write<ChangePreviewArtifactSource>({
            bytes: previewBytes,
            mediaType: "text/x-diff; charset=utf-8",
            source: {
              type: "change_preview",
              schemaVersion: 1,
              projectId: durableContext.projectId,
              sessionId: durableContext.sessionId,
              runId,
              callId: call.id,
              toolName: call.name,
              argumentsDigest: `sha256:${createHash("sha256")
                .update(call.argumentsJson, "utf8")
                .digest("hex")}`,
              provenance: "prepared_tool_change",
            },
          });
        } catch {
          const result: ToolResult = {
            status: "failed",
            error: {
              code: "artifact_store_failed",
              message: "The canonical change preview could not be made durable.",
            },
          };
          toolResultsById.set(call.id, { call, result });
          await this.#appendToolResult(messages, call, result);
          return undefined;
        }
      }
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
        await this.#emit({
          type: "tool_permission_requested",
          requestId,
          ...permissionInput,
          ...(changePreviewRef === undefined ? {} : { changePreviewRef }),
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
          ...(changePreviewRef === undefined ? {} : { changePreviewRef }),
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
        ...(changePreviewRef === undefined ? {} : { changePreviewRef }),
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
      return undefined;
    }
    const preDispatchFailure = preparedCall.validateBeforeDispatch?.();
    if (preDispatchFailure !== undefined) {
      toolResultsById.set(call.id, { call, result: preDispatchFailure });
      await this.#appendToolResult(messages, call, preDispatchFailure);
      return undefined;
    }
    if (options.emitStarted) {
      await this.#emit({ type: "tool_started", callId: call.id, name: call.name });
    }
    if (signal.aborted) {
      return this.#settleCancelled();
    }
    const result =
      call.name === "activate_skill"
        ? await this.#activateModelSelectedSkill(call)
        : call.name === "read_skill_resource"
          ? await this.#readSkillResource(call)
          : await preparedCall.execute({ signal, callId: call.id, toolName: call.name });
    toolResultsById.set(call.id, { call, result });
    await this.#appendToolResult(messages, call, result);
    if (result.status === "failed" && result.error.code === "tool_effect_indeterminate") {
      return this.#settle({
        status: "failed",
        error: result.error,
      });
    }
    return undefined;
  }

  async #activateModelSelectedSkill(call: ToolCall): Promise<ToolResult> {
    const skillContext = this.#skillContext;
    const promptContext = this.#promptContext;
    const runId = this.#activeRunId;
    let qualifiedId: string | undefined;
    try {
      const parsed = JSON.parse(call.argumentsJson) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 1 &&
        typeof (parsed as { qualifiedId?: unknown }).qualifiedId === "string"
      ) {
        qualifiedId = (parsed as { qualifiedId: string }).qualifiedId;
      }
    } catch {
      qualifiedId = undefined;
    }
    if (
      qualifiedId === undefined ||
      skillContext === undefined ||
      !hasSkillPromptContext(promptContext) ||
      runId === undefined ||
      !skillContext.catalog.entries.some((entry) => entry.qualifiedId === qualifiedId)
    ) {
      return {
        status: "failed",
        error: {
          code: "skill_unavailable",
          message: "The requested Agent Skill is unavailable in the visible catalog.",
        },
      };
    }
    const existing = skillContext.active.find((entry) => entry.qualifiedId === qualifiedId);
    if (existing !== undefined) {
      return {
        status: "completed",
        output: {
          status: "already_active",
          qualifiedId,
          activationIndex: existing.activationIndex,
        },
      };
    }
    let activation: ReturnType<typeof activateSkillContextV1>;
    try {
      const candidate = skillContext.registry.candidates.find(
        (entry) => entry.qualifiedId === qualifiedId,
      );
      if (candidate === undefined || this.#repositoryWorkspaceRoot === undefined) {
        throw new SkillsError("skill_catalog_unavailable");
      }
      const manifest = await buildSkillResourceManifestV1({
        candidate,
        workspaceRoot: this.#repositoryWorkspaceRoot,
        userHome: homedir(),
        userHomeDigest: skillContext.userHomeDigest,
        ...(this.#durableContext?.extensionSkillSources === undefined
          ? {}
          : { extensionSources: this.#durableContext.extensionSkillSources }),
      });
      activation = activateSkillContextV1({
        context: skillContext,
        qualifiedId,
        reason: "model_selected",
        runId,
        requestId: call.id,
        manifest,
      });
    } catch (error) {
      if (error instanceof SkillsError) {
        return {
          status: "failed",
          error: {
            code: "skill_unavailable",
            message: "The Agent Skill activation limits would be exceeded.",
          },
        };
      }
      throw error;
    }
    const bytes = await this.#artifactStore?.read(activation.activation.artifact.id, {
      maximumBytes: activation.activation.byteCount,
    });
    if (
      bytes === undefined ||
      bytes.byteLength !== activation.activation.byteCount ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        activation.activation.skillMdDigest
    ) {
      return {
        status: "failed",
        error: {
          code: "skill_unavailable",
          message: "The requested Agent Skill content is unavailable.",
        },
      };
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        status: "failed",
        error: {
          code: "skill_unavailable",
          message: "The requested Agent Skill content is invalid.",
        },
      };
    }
    const nextPromptContext = replacePromptSkillsV2(promptContext, activation.context);
    const committed = await this.#withCurrentExtensionSkills(
      activation.context,
      activation.context.active.map((entry) => entry.qualifiedId),
      async () => {
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "skill_activation_batch_committed",
            recordVersion: 1,
            runId,
            previousActivationDigest: skillContext.activationDigest,
            skillContext: activation.context,
            assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
            outcomes: [
              {
                selection: qualifiedId,
                requestId: call.id,
                qualifiedId,
                status: "activated",
                activationIndex: activation.activation.activationIndex,
              },
            ],
          },
        });
        await this.#appendRecord({
          schemaVersion: 3,
          sequence: this.#nextSequence,
          record: {
            type: "skill_activated",
            recordVersion: 1,
            runId,
            catalogRevision: activation.activation.catalogRevision,
            activationIndex: activation.activation.activationIndex,
            qualifiedId: activation.activation.qualifiedId,
            reason: activation.activation.reason,
            skillMdDigest: activation.activation.skillMdDigest,
            manifestDigest: activation.activation.manifest.digest,
          },
        });
      },
    );
    if (committed.status === "stale") {
      return {
        status: "failed",
        error: {
          code: "skill_unavailable",
          message: "The requested Agent Skill content is unavailable.",
        },
      };
    }
    this.#skillContext = activation.context;
    this.#promptContext = nextPromptContext;
    this.#activeSkillContents.set(qualifiedId, content);
    return {
      status: "completed",
      output: {
        status: "activated",
        qualifiedId,
        activationIndex: activation.activation.activationIndex,
      },
    };
  }

  async #readSkillResource(call: ToolCall): Promise<ToolResult> {
    const context = this.#skillContext;
    const runId = this.#activeRunId;
    const workspaceRoot = this.#repositoryWorkspaceRoot;
    let input:
      | {
          readonly qualifiedId: string;
          readonly path: string;
          readonly offset: number;
          readonly maxByteCount: number;
        }
      | undefined;
    try {
      const parsed = JSON.parse(call.argumentsJson) as {
        qualifiedId?: unknown;
        path?: unknown;
        offset?: unknown;
        maxByteCount?: unknown;
      };
      if (
        typeof parsed.qualifiedId === "string" &&
        typeof parsed.path === "string" &&
        (parsed.offset === undefined || Number.isSafeInteger(parsed.offset)) &&
        (parsed.maxByteCount === undefined || Number.isSafeInteger(parsed.maxByteCount))
      ) {
        input = {
          qualifiedId: parsed.qualifiedId,
          path: parsed.path,
          offset: (parsed.offset as number | undefined) ?? 0,
          maxByteCount: (parsed.maxByteCount as number | undefined) ?? 65_536,
        };
      }
    } catch {
      input = undefined;
    }
    if (
      context === undefined ||
      runId === undefined ||
      workspaceRoot === undefined ||
      input === undefined
    ) {
      return skillResourceFailure(
        "skill_resource_unavailable",
        "The requested Agent Skill resource is unavailable in this session.",
      );
    }
    let page: Awaited<ReturnType<typeof readSkillResourcePageV1>>;
    try {
      page = await readSkillResourcePageV1({
        context,
        qualifiedId: input.qualifiedId,
        path: input.path,
        offset: input.offset,
        maxByteCount: input.maxByteCount,
        workspaceRoot,
        userHome: homedir(),
        userHomeDigest: context.userHomeDigest,
        ...(this.#durableContext?.extensionSkillSources === undefined
          ? {}
          : { extensionSources: this.#durableContext.extensionSkillSources }),
      });
    } catch (error) {
      if (error instanceof SkillResourceError) {
        return skillResourceFailure(error.code, error.message);
      }
      return skillResourceFailure(
        "skill_resource_unavailable",
        "The requested Agent Skill resource is unavailable in this session.",
      );
    }
    if (
      this.#skillResourceRunBytes + page.byteCount > 1024 * 1024 ||
      this.#skillResourceLineageBytes + page.byteCount > 8 * 1024 * 1024
    ) {
      return skillResourceFailure(
        "skill_resource_quota_exceeded",
        "The Agent Skill resource quota for this run or session lineage would be exceeded.",
      );
    }
    const committed = await this.#withCurrentExtensionSkills(context, [page.qualifiedId], () =>
      this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "skill_resource_read_committed",
          recordVersion: 1,
          runId,
          callId: call.id,
          qualifiedId: page.qualifiedId,
          activationIndex: page.activationIndex,
          catalogRevision: page.catalogRevision,
          manifestRevision: page.manifestRevision,
          path: page.path,
          offset: page.offset,
          byteCount: page.byteCount,
          totalByteCount: page.totalByteCount,
          eof: page.eof,
          fileDigest: page.fileDigest,
          pageDigest: page.pageDigest,
          content: page.content,
          ...(page.executionToken === undefined ? {} : { executionToken: page.executionToken }),
        },
      }),
    );
    if (committed.status === "stale") {
      return skillResourceFailure(
        "skill_resource_unavailable",
        "The requested Agent Skill resource is unavailable in this session.",
      );
    }
    this.#skillResourceRunBytes += page.byteCount;
    this.#skillResourceLineageBytes += page.byteCount;
    return {
      status: "completed",
      output: {
        qualifiedId: page.qualifiedId,
        activationIndex: page.activationIndex,
        catalogRevision: page.catalogRevision,
        manifestRevision: page.manifestRevision,
        path: page.path,
        offset: page.offset,
        byteCount: page.byteCount,
        totalByteCount: page.totalByteCount,
        eof: page.eof,
        fileDigest: page.fileDigest,
        pageDigest: page.pageDigest,
        content: page.content,
        ...(page.executionToken === undefined ? {} : { executionToken: page.executionToken }),
      },
    };
  }

  async #preflightRepositoryInstructions(
    call: ToolCall,
    subject: PermissionSubject,
  ): Promise<Extract<ToolResult, { readonly status: "failed" }> | undefined> {
    const context = this.#promptContext;
    const workspaceRoot = this.#repositoryWorkspaceRoot;
    if (
      context === undefined ||
      workspaceRoot === undefined ||
      (call.name !== "read_file" && call.name !== "write_file" && call.name !== "edit_file")
    ) {
      return undefined;
    }
    const requestedScopes = repositoryScopesFromPermissionSubject(subject);
    const activeScopes = new Set(context.repository.activeScopes);
    if (hasSkillPromptContext(context) && this.#skillContext !== undefined) {
      const activeSkillScopes = new Set(this.#skillContext.activeProjectScopes);
      if (
        requestedScopes.every((scope) => activeScopes.has(scope) && activeSkillScopes.has(scope))
      ) {
        return undefined;
      }
      return this.#preflightPathContextV2(call, requestedScopes);
    }
    if (requestedScopes.every((scope) => activeScopes.has(scope))) {
      return undefined;
    }
    const unionScopes = [...activeScopes, ...requestedScopes];
    let repository: PromptContextRecordV1["repository"];
    try {
      repository = await loadRepositoryInstructions({
        workspaceRoot,
        activeScopes: unionScopes,
        revision: context.repository.revision + 1,
        loadReason: "path_scope_activation",
      });
    } catch (error) {
      const runId = this.#activeRunId;
      if (runId === undefined) {
        throw new TypeError("Repository preflight failure requires one active run.");
      }
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "repository_instructions_failed",
          recordVersion: 1,
          activeRevision: context.repository.revision,
          activeEffectiveDigest: context.repository.effectiveDigest,
          error: {
            code:
              error instanceof RepositoryInstructionsError
                ? error.code
                : "repository_instruction_unreadable",
          },
          trigger: {
            runId,
            callId: call.id,
            name: call.name,
            argumentsDigest: `sha256:${createHash("sha256")
              .update(call.argumentsJson, "utf8")
              .digest("hex")}`,
            disposition: "unavailable",
          },
        },
      });
      return {
        status: "failed",
        error: {
          code: "repository_instructions_unavailable",
          message: "Repository instructions for the requested path are unavailable.",
        },
      };
    }
    const nextContext = replacePromptRepositoryV1(context, repository);
    const runId = this.#activeRunId;
    if (runId === undefined) {
      throw new TypeError("Repository activation requires one active run.");
    }
    const mutation = call.name !== "read_file";
    await this.#appendRecord({
      schemaVersion: 3,
      sequence: this.#nextSequence,
      record: {
        type: "repository_instructions_committed",
        recordVersion: 1,
        previousRevision: context.repository.revision,
        previousEffectiveDigest: context.repository.effectiveDigest,
        repository,
        assemblyIdentityDigest: nextContext.assemblyIdentityDigest,
        trigger: {
          runId,
          callId: call.id,
          name: call.name,
          argumentsDigest: `sha256:${createHash("sha256")
            .update(call.argumentsJson, "utf8")
            .digest("hex")}`,
          disposition: mutation ? "mutation_retry_required" : "read_continue",
        },
      },
    });
    this.#promptContext = nextContext;
    await this.#emit({
      type: "repository_instructions_activated",
      revision: repository.revision,
      effectiveDigest: repository.effectiveDigest,
      reason: "path_scope_activation",
    });
    return mutation
      ? {
          status: "failed",
          error: {
            code: "repository_context_changed",
            message:
              "Repository instructions changed; reconsider this mutation with a new call ID.",
          },
        }
      : undefined;
  }

  async #preflightPathContextV2(
    call: ToolCall,
    requestedScopes: readonly string[],
  ): Promise<Extract<ToolResult, { readonly status: "failed" }> | undefined> {
    const promptContext = this.#promptContext;
    const skillContext = this.#skillContext;
    const workspaceRoot = this.#repositoryWorkspaceRoot;
    const runId = this.#activeRunId;
    const projectId = this.#durableContext?.projectId;
    const sessionId = this.#durableContext?.sessionId;
    if (
      !hasSkillPromptContext(promptContext) ||
      skillContext === undefined ||
      workspaceRoot === undefined ||
      runId === undefined ||
      projectId === undefined ||
      sessionId === undefined ||
      this.#artifactStore === undefined
    ) {
      return skillResourceFailure(
        "project_context_unavailable",
        "Project path context is unavailable.",
      );
    }
    const repositoryScopes = [
      ...new Set([...promptContext.repository.activeScopes, ...requestedScopes]),
    ];
    let repository: PromptContextRecordV1["repository"];
    let nextSkillContext: SkillContextRecordV1;
    try {
      repository = await loadRepositoryInstructions({
        workspaceRoot,
        activeScopes: repositoryScopes,
        revision: promptContext.repository.revision + 1,
        loadReason: "path_scope_activation",
      });
      nextSkillContext = await extendSkillContextWithProjectScopesV1({
        artifactStore: this.#artifactStore,
        context: skillContext,
        projectId,
        sessionId,
        scopes: requestedScopes,
        workspaceRoot,
      });
    } catch {
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "path_context_failed",
          recordVersion: 1,
          activeRepositoryRevision: promptContext.repository.revision,
          activeRepositoryDigest: promptContext.repository.effectiveDigest,
          activeSkillRevision: skillContext.registry.revision,
          activeSkillRegistryDigest: skillContext.registry.digest,
          error: { code: "project_context_unavailable" },
          trigger: {
            runId,
            callId: call.id,
            name: call.name as "read_file" | "write_file" | "edit_file",
            argumentsDigest: `sha256:${createHash("sha256")
              .update(call.argumentsJson, "utf8")
              .digest("hex")}`,
            disposition: "unavailable",
          },
        },
      });
      return skillResourceFailure(
        "project_context_unavailable",
        "Project path context could not be loaded safely.",
      );
    }
    let nextPromptContext = replacePromptRepositoryV1(promptContext, repository) as
      | PromptContextRecordV2
      | PromptContextRecordV3;
    nextPromptContext = replacePromptSkillsV2(nextPromptContext, nextSkillContext);
    const mutation = call.name !== "read_file";
    await this.#appendRecord({
      schemaVersion: 3,
      sequence: this.#nextSequence,
      record: {
        type: "path_context_committed",
        recordVersion: 1,
        previousRepositoryRevision: promptContext.repository.revision,
        previousRepositoryDigest: promptContext.repository.effectiveDigest,
        previousSkillRevision: skillContext.registry.revision,
        previousSkillRegistryDigest: skillContext.registry.digest,
        repository,
        skillContext: nextSkillContext,
        assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
        trigger: {
          runId,
          callId: call.id,
          name: call.name as "read_file" | "write_file" | "edit_file",
          argumentsDigest: `sha256:${createHash("sha256")
            .update(call.argumentsJson, "utf8")
            .digest("hex")}`,
          disposition: mutation ? "mutation_retry_required" : "read_continue",
        },
      },
    });
    this.#promptContext = nextPromptContext;
    this.#skillContext = nextSkillContext;
    await this.#emit({
      type: "repository_instructions_activated",
      revision: repository.revision,
      effectiveDigest: repository.effectiveDigest,
      reason: "path_scope_activation",
    });
    return mutation
      ? skillResourceFailure(
          "project_context_changed",
          "Project path context changed; reconsider this mutation with a new call ID.",
        )
      : undefined;
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
      if (result.error.code === "mcp_catalog_stale") {
        await this.#emit({
          type: "mcp_catalog_state_changed",
          generationId: result.error.generationId,
          serverId: result.error.serverId,
          catalogDigest: result.error.catalogDigest,
          status: "stale",
          reason: "list_changed",
        });
      }
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
    if (event.type === "mcp_catalog_state_changed") {
      const runId = this.#activeRunId;
      if (runId === undefined || this.#durableContext === undefined) {
        throw new Error("Cannot persist an MCP catalog transition without an active durable run.");
      }
      await this.#appendRecord({
        schemaVersion: 3,
        sequence: this.#nextSequence,
        record: {
          type: "mcp_catalog_state_changed",
          recordVersion: 1,
          runId,
          generationId: event.generationId,
          serverId: event.serverId,
          catalogDigest: event.catalogDigest,
          status: event.status,
          reason: event.reason,
        },
      });
      this.#publish(event);
      return;
    }
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
    this.#publish(event);
  }

  #publish(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
    const notification: RuntimeEventNotification = {
      notificationId: `${this.#activeRunId ?? "idle"}:${this.#nextNotification}`,
      sessionId: this.#durableContext?.sessionId ?? null,
      runId: this.#activeRunId ?? null,
      throughSequence: Math.max(0, this.#nextSequence - 1),
      event,
    };
    this.#nextNotification += 1;
    for (const listener of this.#notificationListeners) {
      listener(notification);
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

function repositoryScopesFromPermissionSubject(subject: PermissionSubject): readonly string[] {
  const paths: string[] = [];
  if (subject.type === "file" || subject.type === "workspace_path") {
    paths.push(subject.path);
  } else if (subject.type === "patch") {
    for (const operation of subject.operations) {
      if (operation.kind === "move") {
        paths.push(operation.from, operation.to);
      } else {
        paths.push(operation.path);
      }
    }
  }
  const scopes = new Set<string>(["."]);
  for (const path of paths) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      scopes.add(segments.slice(0, length).join("/"));
    }
  }
  return [...scopes].sort((left, right) => {
    const leftDepth = left === "." ? 0 : left.split("/").length;
    const rightDepth = right === "." ? 0 : right.split("/").length;
    return leftDepth - rightDepth || (left < right ? -1 : left > right ? 1 : 0);
  });
}

function captureToolRegistry(
  tools: ToolRegistry | undefined,
  selectedNames?: readonly string[],
): ToolRegistry | undefined {
  if (tools === undefined) {
    return undefined;
  }
  const availableDefinitions = new Map(
    tools.definitions().map((definition) => [definition.name, definition] as const),
  );
  const definitions = (
    selectedNames === undefined
      ? [...availableDefinitions.values()]
      : selectedNames.flatMap((name) => {
          const definition = availableDefinitions.get(name);
          return definition === undefined ? [] : [definition];
        })
  ).map((definition) => structuredClone(definition));
  const adapters = new Map(
    definitions.map((definition) => {
      const adapter = tools.resolve(definition.name);
      if (adapter === undefined || !isDeepStrictEqual(adapter.definition, definition)) {
        throw new TypeError(`Tool definition cannot be resolved exactly: ${definition.name}`);
      }
      return [
        definition.name,
        {
          ...adapter,
          definition,
          prepare: adapter.prepare.bind(adapter),
        },
      ] as const;
    }),
  );
  return {
    definitions: () => definitions,
    resolve: (name) => adapters.get(name),
  };
}

function filterLiveToolRegistry(
  tools: ToolRegistry | undefined,
  selectedNames: readonly string[],
): ToolRegistry | undefined {
  if (tools === undefined) {
    return undefined;
  }
  const selected = new Set(selectedNames);
  return {
    definitions: () => tools.definitions().filter((definition) => selected.has(definition.name)),
    resolve: (name) => (selected.has(name) ? tools.resolve(name) : undefined),
  };
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

function areSkillSelectionsValid(selections: UserInput["skills"]): boolean {
  return (
    selections === undefined ||
    (Array.isArray(selections) &&
      selections.length <= 8 &&
      selections.every(
        (selection) =>
          typeof selection === "string" &&
          selection.length > 0 &&
          Buffer.byteLength(selection, "utf8") <= 16_384 &&
          /^[\x20-\x7e]+$/u.test(selection),
      ))
  );
}

function skillActivationFailure(
  message: string,
  ambiguity?: {
    readonly selection: string;
    readonly candidates: readonly string[];
    readonly omittedCount: number;
  },
): Extract<RunResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    error: {
      code: "skill_activation_failed",
      message,
      ...(ambiguity === undefined ? {} : { ambiguity }),
    },
  };
}

function skillResourceFailure(
  code:
    | "resource_page_too_small"
    | "project_context_changed"
    | "project_context_unavailable"
    | "skill_resource_changed"
    | "skill_resource_quota_exceeded"
    | "skill_resource_unavailable"
    | "unsupported_binary_resource",
  message: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
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
