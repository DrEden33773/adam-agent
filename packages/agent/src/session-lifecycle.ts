import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentSession, managedAgentPromptSummary } from "./agent-session.js";
import type {
  ModelMessage,
  PermissionDecisionCommand,
  PermissionDecisionCommandResult,
  RunOptions,
  RunResult,
  RuntimeEventListener,
  RuntimeEventNotification,
  UserInput,
} from "./agent-session-contracts.js";
import {
  type ArtifactSource,
  type ArtifactStore,
  createFileArtifactStore,
  readFileArtifact,
} from "./artifact-store.js";
import { type ContextProfile, isContextProfileSupported } from "./context-profile.js";
import {
  maximumModelResponseContentBytes,
  maximumReferencedModelResponseArtifactBytes,
} from "./durable-model-response-policy.js";
import {
  type ExtensionHost,
  loadInternalExtensionSkillSources,
  projectExecutionDomainForExtensionHost,
  withInternalExtensionSkillSourcesCurrent,
} from "./extension-host.js";
import {
  InputResourceError,
  type InputResourceOccurrenceV1,
  type InputResourceSelectionV1,
  ingestLocalInputResourcesV1,
  inputResourceLimitsV1,
} from "./input-resources.js";
import {
  type AgentManager,
  createAgentManager,
  createManagedAgentToolRegistry,
  type ManagedAgentSnapshot,
  type ManagedAgentStore,
  managedAgentSnapshotFromRecords,
  recoverInterruptedManagedAgents,
} from "./managed-agent.js";
import { createJsonlManagedAgentStore } from "./managed-agent-store.js";
import {
  createMcpRuntimeHost,
  inspectMcpConfiguration,
  type McpBeforeToolDispatchBarrier,
  type McpBootstrapScheduler,
  type McpCloseConfirmation,
  McpConfigurationError,
  type McpDiscoveryScheduler,
  McpHostError,
  type McpIdleScheduler,
  type McpRequestScheduler,
  type McpSessionSnapshot,
  type McpTransportFactory,
  mcpBeforeToolDispatchBarrier,
  mcpBootstrapScheduler,
  mcpCloseConfirmation,
  mcpDiscoveryScheduler,
  mcpEffectiveBoundsV1,
  mcpIdleScheduler,
  mcpPackageManagerCliPath,
  mcpPackageRegistryUrl,
  mcpRequestScheduler,
  mcpTransportFactory,
} from "./mcp-host.js";
import type { McpToolProfileV1 } from "./mcp-profile-contracts.js";
import {
  type ModelTargetIdentity,
  type ModelTargets,
  modelTargetUsesContextProfile,
  sameModelTargetIdentity,
} from "./model-targets.js";
import {
  isLargePastedTextV1,
  pastedTextMetricsV1,
  promotePastedTextSelectionsV1,
  type StagedPastedTextSelectionV1,
} from "./pasted-text.js";
import { planGitAutomaticPolicyV1 } from "./plan-git-policy.js";
import {
  type ApprovedPlanProjectionV1,
  createPlanToolProfileV1,
  digestApprovedPlanProjectionV1,
  type PlanApprovalIntentV1,
  type PlanEligibleToolProfileV1,
  type PlanPolicyVersion,
  type PlanRevisionIntentV1,
  type PlanSubmissionSnapshotV1,
  submitPlanToolDefinitionV1,
} from "./plan-mode.js";
import {
  createPlanShellEnvironmentV1,
  type PlanShellEnvironmentV1,
} from "./plan-shell-environment.js";
import {
  createProjectExecutionDomain,
  ProjectExecutionDomainError,
  type ProjectExecutionRootClaim,
  projectRuntimeRootId,
} from "./project-execution-domain.js";
import {
  createProjectLifecycleOwner,
  type ProjectLifecycleOwner,
} from "./project-lifecycle-owner.js";
import {
  assemblePromptMessagesV1,
  commitMcpToolProfileV3,
  createPromptContextV3,
  digestPromptRequestV1,
  hasSkillPromptContext,
  isPromptContextCompatible,
  isPromptContextRecordCompatible,
  type PromptContextRecordV1,
  type PromptContextRecordV3,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import {
  loadInitialRepositoryInstructions,
  loadRepositoryInstructions,
  RepositoryInstructionsError,
} from "./repository-instructions.js";
import {
  createWorkspaceTrust,
  resolveCanonicalWorkspaceIdentity,
  type WorkspaceTrustController,
  type WorkspaceTrustMcpLease,
  WorkspaceTrustMcpLeaseError,
  type WorkspaceTrustSnapshot,
} from "./secure-user-configuration.js";
import {
  type AgentSessionDurableContext,
  type AgentSessionDurableOutputLimits,
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";
import {
  addContextUsageTotals,
  areReplayProfilesCompatible,
  attemptStatus,
  contextSnapshotFromRecords,
  contextUsageSnapshotFromRecords,
  isCompleteBranchBoundary,
  isGenesisRecord,
  type ModelResponseArtifactDegradation,
  type ModelResponseArtifactInspection,
  planCycleSnapshotFromRecords,
  promptContextRecordFromRecords,
  sessionNamingStateFromRecords,
  skillContextRecordFromRecords,
  snapshotFromGenesis,
  snapshotFromRecords,
} from "./session-history-folds.js";
import {
  createLogicalRunUserMessageV1,
  inlineModelResponseField,
  modelMessagesFromCompleteRecords,
} from "./session-history-replay.js";
import {
  hasSuccessfullySettledAssistant,
  validateCurrentSessionHistory,
} from "./session-history-validation.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { createSessionLineageTraversal, type SessionLineageTraversal } from "./session-lineage.js";
import { normalizedSessionTitle, sessionTitleFallback } from "./session-naming.js";
import type {
  CurrentSessionSnapshot,
  SessionContextSnapshot,
  SessionContextUsageSnapshot,
  SessionResumeResult,
  SessionSnapshot,
} from "./session-snapshot-contracts.js";
import {
  createJsonlSessionStoreDirectory,
  isSessionRecordWithinSizeLimit,
  maxSessionRecordBytes,
  type SessionGenesisRecord,
  type SessionMcpWorkspaceConfirmedRecord,
  type SessionModelResponseField,
  type SessionRecord,
  type SessionStore,
  type SessionStoreDirectory,
  type SessionTodoStoreInheritedRecord,
} from "./session-store.js";
import {
  buildSkillResourceManifestV1,
  createInitialSkillContextV1,
  type ExtensionSkillSourceV1,
  reconcileExtensionSkillContextV1,
  reloadSkillContextV1,
  type SkillContextRecordV1,
  type SkillContextSnapshot,
  type SkillResourceManifestV1,
  skillContextSnapshot,
} from "./skills.js";
import {
  attachPastedTextProjectionContentsV1,
  materializeSessionUserContentV1,
  type StagedUserContentElementV1,
} from "./structured-user-content.js";
import {
  resolveThinkingPolicy,
  ThinkingPolicyError,
  type ThinkingPolicySelectionV1,
  type ThinkingPolicySnapshotV1,
} from "./thinking-policy.js";
import {
  getTodoV1,
  hasTodoToolProfileV1,
  listTodosV1,
  modelMessagesWithTodoSummaryV1,
  type TodoGetResultV1,
  type TodoItemV1,
  type TodoListResultV1,
  type TodoStoreSnapshotV1,
  todoLimitsV1,
  todoStoreSnapshotDigestV1,
  todoStoreSnapshotFromRecordsV1,
} from "./todo.js";
import {
  bindInputResourceToolRegistry,
  createCodingToolRegistry,
  createPermissionPolicy,
  type PermissionPolicy,
  type ToolEffect,
  type ToolRegistry,
} from "./tool-runtime.js";
import type { UserModelPolicyResolver } from "./user-model-policy.js";

export type { McpSessionSnapshot } from "./mcp-host.js";
export { SessionLifecycleError } from "./session-lifecycle-error.js";
export type {
  CurrentSessionSnapshot,
  LegacySessionSnapshot,
  SessionContextSnapshot,
  SessionContextUsageSnapshot,
  SessionResumeResult,
  SessionSnapshot,
} from "./session-snapshot-contracts.js";

/** Tests only. Production activation settlement has no artificial publication barrier. */
export const mcpActivationSettlementBarrier = Symbol(
  "adam-agent.mcp-activation-settlement-barrier",
);
export const mcpCatalogStaleObservationBarrier = Symbol(
  "adam-agent.mcp-catalog-stale-observation-barrier",
);
export const mcpCatalogStaleDurableBarrier = Symbol("adam-agent.mcp-catalog-stale-durable-barrier");

export type McpActivationSettlementBarrier = {
  beforeReadySettlement(input: {
    readonly sessionId: string;
    readonly generationId: string;
  }): Promise<void>;
};

export type McpCatalogStaleObservationBarrier = {
  observed(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: `sha256:${string}`;
  }): void;
};
export type McpCatalogStaleDurableBarrier = {
  committed(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: `sha256:${string}`;
  }): void;
};

/** Tests only. Production title deadlines use the Node timer scheduler below. */
export const sessionTitleDeadlineScheduler = Symbol("adam-agent.session-title-deadline-scheduler");

export type SessionTitleDeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): { cancel(): void };
};

/** Tests only. Production runs have no post-fsync crash-observation barrier. */
export const sessionLogicalRunStartedBarrier = Symbol(
  "adam-agent.session-logical-run-started-barrier",
);

export type SessionLogicalRunStartedBarrier = {
  afterDurableRecord(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly sequence: number;
  }): Promise<void>;
};

/** Tests only. Production Plan approval proceeds directly from durable intent to kickoff. */
export const planApprovalIntentBarrier = Symbol("adam-agent.plan-approval-intent-barrier");

export type PlanApprovalIntentBarrier = {
  afterDurableRecord(
    input: PlanApprovalIntentV1 & { readonly sequence: number },
  ): Promise<void> | void;
};

/** Tests only. Production lifecycle instances always default automatic titles on. */
export const sessionAutomaticTitlesEnabled = Symbol("adam-agent.session-automatic-titles-enabled");

/** Tests only. Production Plan entry captures the live shell environment. */
export const planShellEnvironmentFactory = Symbol("adam-agent.plan-shell-environment-factory");

export type PlanShellEnvironmentFactory = () =>
  | PlanShellEnvironmentV1
  | Promise<PlanShellEnvironmentV1>;

/** Tests only. Production lifecycle instances use the OS-backed project owner. */
export const sessionProjectLifecycleOwner = Symbol("adam-agent.session-project-lifecycle-owner");

/** Tests only. Production close draining has no observation barrier. */
export const sessionCloseDrainBarrier = Symbol("adam-agent.session-close-drain-barrier");

export type SessionCloseDrainBarrier = {
  beforeWait(input: {
    readonly activeCount: number;
    readonly kind: "owner" | "title_admission" | "title_settlement";
  }): Promise<void> | void;
};

/** Tests only. Production lifecycle instances use the JSONL session directory. */
export const sessionStoreDirectory = Symbol("adam-agent.session-store-directory");

/** Tests only. Production publishes each exact runtime notification once. */
export const sessionRuntimeNotificationTransform = Symbol(
  "adam-agent.session-runtime-notification-transform",
);

export type SessionRuntimeNotificationTransform = {
  project(notification: SessionRuntimeNotification): readonly SessionRuntimeNotification[];
};

/** Tests only. Production input-resource ingest has no observation barrier. */
export const inputResourceIngestBarrier = Symbol("adam-agent.input-resource-ingest-barrier");

export type InputResourceIngestBarrier = {
  afterResolved?(): Promise<void> | void;
  afterOpened?(): Promise<void> | void;
};

/** Tests only. Production MCP lease transitions have no observation barrier. */
export const workspaceMcpLeaseTransitionBarrier = Symbol(
  "adam-agent.workspace-mcp-lease-transition-barrier",
);

export type WorkspaceMcpLeaseTransitionBarrier = {
  activationLeaseReady?(): Promise<void> | void;
  waitingForRelease(): Promise<void> | void;
};

export type SessionLifecycleOptions = {
  readonly extensionHost?: ExtensionHost;
  readonly modelTargets?: ModelTargets;
  readonly managedAgentTools?: "managed-agent-tools.a1.v1" | "managed-agent-tools.a2-long-lived.v1";
  readonly permissions?: PermissionPolicy;
  readonly preferences?: UserModelPolicyResolver;
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
  readonly tools?: ToolRegistry;
  readonly workspaceTrust?: WorkspaceTrustController;
  readonly [mcpBootstrapScheduler]?: McpBootstrapScheduler;
  readonly [mcpBeforeToolDispatchBarrier]?: McpBeforeToolDispatchBarrier;
  readonly [mcpDiscoveryScheduler]?: McpDiscoveryScheduler;
  readonly [mcpPackageManagerCliPath]?: string;
  readonly [mcpIdleScheduler]?: McpIdleScheduler;
  readonly [mcpPackageRegistryUrl]?: string;
  readonly [mcpRequestScheduler]?: McpRequestScheduler;
  readonly [mcpTransportFactory]?: McpTransportFactory;
  readonly [mcpActivationSettlementBarrier]?: McpActivationSettlementBarrier;
  readonly [mcpCatalogStaleObservationBarrier]?: McpCatalogStaleObservationBarrier;
  readonly [mcpCatalogStaleDurableBarrier]?: McpCatalogStaleDurableBarrier;
  readonly [mcpCloseConfirmation]?: McpCloseConfirmation;
  readonly [sessionTitleDeadlineScheduler]?: SessionTitleDeadlineScheduler;
  readonly [sessionLogicalRunStartedBarrier]?: SessionLogicalRunStartedBarrier;
  readonly [planApprovalIntentBarrier]?: PlanApprovalIntentBarrier;
  readonly [sessionAutomaticTitlesEnabled]?: boolean;
  readonly [planShellEnvironmentFactory]?: PlanShellEnvironmentFactory;
  readonly [sessionCloseDrainBarrier]?: SessionCloseDrainBarrier;
  readonly [sessionProjectLifecycleOwner]?: ProjectLifecycleOwner;
  readonly [sessionStoreDirectory]?: SessionStoreDirectory<SessionRecord>;
  readonly [sessionRuntimeNotificationTransform]?: SessionRuntimeNotificationTransform;
  readonly [inputResourceIngestBarrier]?: InputResourceIngestBarrier;
  readonly [workspaceMcpLeaseTransitionBarrier]?: WorkspaceMcpLeaseTransitionBarrier;
};

export type SessionContinueResult = {
  readonly result: RunResult;
  readonly snapshot: CurrentSessionSnapshot;
};

export type NewSessionDraftSnapshot = {
  readonly targetIdentity: ModelTargetIdentity;
  readonly contextProfile: ContextProfile;
  readonly skillContext: SkillContextSnapshot;
};

export type SessionAdmissionReceipt = {
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
};

export type SessionNamingResult = {
  readonly status: "updated";
  readonly snapshot: CurrentSessionSnapshot;
};

export type ProjectSessionCatalogPage = {
  readonly projectId: string;
  readonly items: readonly SessionSnapshot[];
  readonly nextCursor: string | null;
};

export type SessionMetadataEvent =
  | {
      readonly type: "session_naming_changed";
      readonly sessionId: string;
      readonly throughSequence: number;
    }
  | {
      readonly type: "mcp_configuration_changed";
      readonly sessionId: string;
      readonly throughSequence: number;
    };

export type SessionMetadataListener = (event: SessionMetadataEvent) => void | Promise<void>;

export type SessionRuntimeNotification = RuntimeEventNotification & {
  readonly sessionId: string;
  readonly runId: string;
};

export type SessionRuntimeNotificationListener = (notification: SessionRuntimeNotification) => void;

export type RepositoryInstructionsReloadResult =
  | {
      readonly status: "reloaded" | "unchanged";
      readonly snapshot: CurrentSessionSnapshot;
    }
  | {
      readonly status: "rejected";
      readonly snapshot: CurrentSessionSnapshot;
      readonly error: {
        readonly code: "repository_instructions_unavailable";
        readonly message: string;
      };
    };

export type SkillsReloadResult =
  | { readonly status: "reloaded" | "unchanged"; readonly snapshot: CurrentSessionSnapshot }
  | {
      readonly status: "rejected";
      readonly snapshot: CurrentSessionSnapshot;
      readonly error: {
        readonly code: "skill_catalog_unavailable" | "skill_reload_not_idle";
        readonly message: string;
      };
    };

export type McpConfigurationCommand =
  | {
      readonly type: "confirm_workspace";
      readonly sessionId: string;
      readonly sourceDigest: `sha256:${string}`;
    }
  | {
      readonly type: "approve_server";
      readonly sessionId: string;
      readonly serverId: string;
      readonly definitionDigest: `sha256:${string}`;
    }
  | {
      readonly type: "activate_servers";
      readonly sessionId: string;
      readonly servers: readonly {
        readonly serverId: string;
        readonly definitionDigest: `sha256:${string}`;
      }[];
    }
  | {
      readonly type: "retry_activation";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "revalidate_catalog";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "cancel_configuration";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "commit_tool_profile";
      readonly sessionId: string;
      readonly generationId: string;
      readonly selections: readonly {
        readonly qualifiedName: string;
        readonly definitionDigest: `sha256:${string}`;
        readonly effect: ToolEffect;
      }[];
    };

export type McpConfigurationResult = {
  readonly status: "updated";
  readonly snapshot: CurrentSessionSnapshot;
};

export type WorkspaceTrustCommand = {
  readonly type: "grant" | "revoke";
  readonly projectId: string;
};

export type WorkspaceTrustConfigurationResult = {
  readonly status: "updated";
  readonly snapshot: WorkspaceTrustSnapshot;
};

export type McpCloseResult = {
  readonly status: "closed" | "mcp_shutdown_unconfirmed";
};

export type SessionBranchInput = {
  readonly parentSessionId: string;
  readonly targetId?: string;
} & (
  | { readonly atSequence: number; readonly sourceBoundary?: never }
  | {
      readonly atSequence?: never;
      readonly sourceBoundary: {
        readonly sessionId: string;
        readonly sequence: number;
      };
    }
);

export type SessionCommand =
  | { readonly type: "create"; readonly targetIdentity: ModelTargetIdentity }
  | { readonly type: "resume"; readonly sessionId: string }
  | {
      readonly type: "continue";
      readonly sessionId: string;
      readonly input?: UserInput;
      readonly limits?: RunOptions["limits"];
      readonly runId?: string;
      readonly signal?: AbortSignal;
      readonly thinkingSelection?: ThinkingPolicySelectionV1;
      readonly resourceSelections?: readonly InputResourceSelectionV1[];
      readonly pastedTextSelections?: readonly StagedPastedTextSelectionV1[];
      readonly structuredContent?: readonly StagedUserContentElementV1[];
      readonly planRevision?: {
        readonly cycleId: string;
        readonly revision: number;
        readonly planId: string;
        readonly contentDigest: `sha256:${string}`;
      };
      readonly planApproval?: {
        readonly commandId: string;
        readonly cycleId: string;
        readonly revision: number;
        readonly planId: string;
        readonly contentDigest: `sha256:${string}`;
      };
    }
  | ({
      readonly type: "branch";
    } & SessionBranchInput)
  | { readonly type: "reload_repository_instructions"; readonly sessionId: string }
  | { readonly type: "reload_skills"; readonly sessionId: string }
  | { readonly type: "enter_plan"; readonly sessionId: string }
  | {
      readonly type: "exit_plan";
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
    }
  | McpConfigurationCommand;

export interface SessionLifecycle {
  admit(input: {
    readonly targetIdentity: ModelTargetIdentity;
    readonly input: UserInput;
    readonly limits?: RunOptions["limits"];
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly thinkingSelection?: ThinkingPolicySelectionV1;
    readonly resourceSelections?: readonly InputResourceSelectionV1[];
    readonly pastedTextSelections?: readonly StagedPastedTextSelectionV1[];
    readonly structuredContent?: readonly StagedUserContentElementV1[];
    readonly onAdmitted?: (receipt: SessionAdmissionReceipt) => void;
  }): Promise<SessionContinueResult>;
  branch(input: SessionBranchInput): Promise<CurrentSessionSnapshot>;
  close(): Promise<McpCloseResult>;
  continue(input: {
    readonly sessionId: string;
    readonly input?: UserInput;
    readonly limits?: RunOptions["limits"];
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly thinkingSelection?: ThinkingPolicySelectionV1;
    readonly resourceSelections?: readonly InputResourceSelectionV1[];
    readonly pastedTextSelections?: readonly StagedPastedTextSelectionV1[];
    readonly structuredContent?: readonly StagedUserContentElementV1[];
    readonly planRevision?: {
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    };
    readonly planApproval?: {
      readonly commandId: string;
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    };
  }): Promise<SessionContinueResult>;
  configureMcp(command: McpConfigurationCommand): Promise<McpConfigurationResult>;
  configureWorkspaceTrust(
    command: WorkspaceTrustCommand,
  ): Promise<WorkspaceTrustConfigurationResult>;
  create(input: { readonly targetIdentity: ModelTargetIdentity }): Promise<CurrentSessionSnapshot>;
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
  enableAutomaticTitles(): void;
  ensureAutomaticTitle(input: { readonly sessionId: string }): Promise<SessionNamingResult>;
  enterPlan(input: { readonly sessionId: string }): Promise<CurrentSessionSnapshot>;
  cancelPlan(input: {
    readonly sessionId: string;
    readonly cycleId: string;
    readonly revision: number;
    readonly planId: string;
    readonly contentDigest: `sha256:${string}`;
  }): Promise<CurrentSessionSnapshot>;
  exitPlan(input: {
    readonly sessionId: string;
    readonly cycleId: string;
    readonly revision: number;
  }): Promise<CurrentSessionSnapshot>;
  inspect(input: { readonly sessionId: string }): Promise<SessionSnapshot>;
  inspectManagedAgents(input: { readonly sessionId: string }): Promise<ManagedAgentSnapshot>;
  cancelManagedAgent(input: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly expectedRevision: number;
  }): Promise<ManagedAgentSnapshot>;
  inspectWorkspaceTrust(): Promise<WorkspaceTrustSnapshot>;
  inspectContextUsage(input: {
    readonly sessionId: string;
  }): Promise<SessionContextUsageSnapshot | null>;
  getTodo(input: {
    readonly sessionId: string;
    readonly expectedStoreRevision: number;
    readonly id: string;
  }): Promise<TodoGetResultV1 | { readonly status: "stale" }>;
  listTodos(input: {
    readonly sessionId: string;
    readonly expectedStoreRevision: number;
    readonly status?: "pending" | "in_progress" | "completed";
    readonly titleContains?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<TodoListResultV1 | { readonly status: "stale" }>;
  listProjectSessions(input?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ProjectSessionCatalogPage>;
  previewNewSession(input: {
    readonly targetIdentity: ModelTargetIdentity;
    readonly signal?: AbortSignal;
  }): Promise<NewSessionDraftSnapshot>;
  reloadRepositoryInstructions(input: {
    readonly sessionId: string;
  }): Promise<RepositoryInstructionsReloadResult>;
  reloadSkills(input: { readonly sessionId: string }): Promise<SkillsReloadResult>;
  regenerateSessionTitle(input: { readonly sessionId: string }): Promise<SessionNamingResult>;
  resume(input: { readonly sessionId: string }): Promise<SessionResumeResult>;
  clearSessionManualName(input: { readonly sessionId: string }): Promise<SessionNamingResult>;
  setSessionManualName(input: {
    readonly sessionId: string;
    readonly name: string;
  }): Promise<SessionNamingResult>;
  subscribe(listener: RuntimeEventListener): () => void;
  subscribeSessionEvents(listener: SessionRuntimeNotificationListener): () => void;
  subscribeMetadata(listener: SessionMetadataListener): () => void;
}

function resolveRunThinkingPolicy(
  resolved: Awaited<ReturnType<ModelTargets["resolve"]>>,
  selection: ThinkingPolicySelectionV1 | undefined,
): ThinkingPolicySnapshotV1 | undefined {
  if (resolved.thinkingCapability === undefined) {
    if (selection === undefined) {
      return undefined;
    }
    throw new SessionLifecycleError("session_thinking_policy_unsupported");
  }
  const supportedLevelIds = resolved.thinkingCapability.levels.map((level) => level.id);
  if (
    selection !== undefined &&
    (selection.capability.id !== resolved.thinkingCapability.capabilityId ||
      selection.capability.version !== resolved.thinkingCapability.capabilityVersion ||
      selection.capability.digest !== resolved.thinkingCapability.capabilityDigest)
  ) {
    throw new SessionLifecycleError("session_thinking_policy_unsupported", supportedLevelIds);
  }
  try {
    return resolveThinkingPolicy(
      resolved.thinkingCapability,
      selection?.requestedLevelId,
      resolved.identity,
    );
  } catch (error) {
    if (error instanceof ThinkingPolicyError) {
      throw new SessionLifecycleError(
        "session_thinking_policy_unsupported",
        error.supportedLevelIds,
      );
    }
    throw error;
  }
}

function requireRecoveredThinkingPolicy(
  resolved: Awaited<ReturnType<ModelTargets["resolve"]>>,
  snapshot: ThinkingPolicySnapshotV1,
): ThinkingPolicySnapshotV1 {
  const capability = resolved.thinkingCapability;
  const supportedLevelIds = capability?.levels.map((level) => level.id) ?? [];
  if (
    capability === undefined ||
    capability.capabilityId !== snapshot.capability.id ||
    capability.capabilityVersion !== snapshot.capability.version ||
    capability.capabilityDigest !== snapshot.capability.digest
  ) {
    throw new SessionLifecycleError("session_thinking_policy_unsupported", supportedLevelIds);
  }
  const current = resolveRunThinkingPolicy(resolved, {
    requestedLevelId: snapshot.requestedLevelId,
    capability: snapshot.capability,
  });
  if (current === undefined || !isDeepStrictEqual(current, snapshot)) {
    throw new SessionLifecycleError("session_thinking_policy_unsupported", supportedLevelIds);
  }
  return snapshot;
}

function encodeProjectSessionCatalogCursor(sessionId: string): string {
  return `project-sessions:v1:${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

function decodeProjectSessionCatalogCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const prefix = "project-sessions:v1:";
  if (!cursor.startsWith(prefix)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const sessionId = Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  return sessionId;
}

const nodeMcpIdleScheduler: McpIdleScheduler = {
  schedule(delayMilliseconds, task) {
    const timer = setTimeout(() => {
      void task().catch(() => undefined);
    }, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

const nodeSessionTitleDeadlineScheduler: SessionTitleDeadlineScheduler = {
  schedule(delayMilliseconds, onDeadline) {
    const timer = setTimeout(onDeadline, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export function createSessionLifecycle(providedOptions: SessionLifecycleOptions): SessionLifecycle {
  const storeDirectory =
    providedOptions[sessionStoreDirectory] ??
    createJsonlSessionStoreDirectory<SessionRecord>({
      workspaceRoot: providedOptions.workspaceRoot,
      ...(providedOptions.stateRoot === undefined ? {} : { stateRoot: providedOptions.stateRoot }),
    });
  const options: SessionLifecycleOptions = {
    ...providedOptions,
    workspaceTrust:
      providedOptions.workspaceTrust ??
      createWorkspaceTrust({
        environment: process.env,
        workspaceRoot: providedOptions.workspaceRoot,
      }),
    [sessionStoreDirectory]: storeDirectory,
    tools:
      providedOptions.tools ??
      createCodingToolRegistry({
        artifactStore: createLazyArtifactStore(
          join(effectiveSessionStateRoot(providedOptions.stateRoot), "artifacts"),
        ),
        workspaceRoot: providedOptions.workspaceRoot,
        ...(providedOptions.stateRoot === undefined
          ? {}
          : { stateRoot: providedOptions.stateRoot }),
      }),
  };
  const lineage = createSessionLineageTraversal({
    readRecords: async (sessionId) => {
      const store = await storeDirectory.open(sessionId);
      return store?.read() ?? [];
    },
    workspaceRoot: options.workspaceRoot,
  });
  const listeners = new Set<RuntimeEventListener>();
  const sessionEventListeners = new Set<SessionRuntimeNotificationListener>();
  const metadataListeners = new Set<SessionMetadataListener>();
  let activeSession: AgentSession | undefined;
  let activeSessionSettlement: Promise<void> | undefined;
  let lifecycleClosing = false;
  let automaticTitlesEnabled = options[sessionAutomaticTitlesEnabled] ?? true;
  let lifecycleClosePromise: Promise<McpCloseResult> | undefined;
  let workspaceMcpLeasePromise: Promise<WorkspaceTrustMcpLease> | undefined;
  let workspaceMcpLeaseReleasePromise: Promise<void> | undefined;
  let workspaceMcpLeaseFenced = false;
  let workspaceMcpActivationClaims = 0;
  const ensureWorkspaceMcpLease = async (): Promise<void> => {
    if (options.workspaceTrust === undefined) {
      return;
    }
    for (;;) {
      if (workspaceMcpLeaseFenced) {
        throw new SessionLifecycleError("project_owner_unavailable");
      }
      const release = workspaceMcpLeaseReleasePromise;
      if (release !== undefined) {
        await options[workspaceMcpLeaseTransitionBarrier]?.waitingForRelease();
        await release;
        continue;
      }
      const acquisition = workspaceMcpLeasePromise ?? options.workspaceTrust.acquireMcpLease();
      workspaceMcpLeasePromise = acquisition;
      try {
        await acquisition;
      } catch (error) {
        if (workspaceMcpLeasePromise === acquisition) {
          workspaceMcpLeasePromise = undefined;
        }
        if (error instanceof WorkspaceTrustMcpLeaseError) {
          throw new SessionLifecycleError("project_in_use");
        }
        throw error;
      }
      if (
        workspaceMcpLeasePromise === acquisition &&
        workspaceMcpLeaseReleasePromise === undefined
      ) {
        return;
      }
    }
  };
  const releaseWorkspaceMcpLease = async (): Promise<void> => {
    if (workspaceMcpLeaseFenced) {
      throw new SessionLifecycleError("project_owner_unavailable");
    }
    if (workspaceMcpLeaseReleasePromise !== undefined) {
      return workspaceMcpLeaseReleasePromise;
    }
    const acquisition = workspaceMcpLeasePromise;
    if (acquisition === undefined) {
      return;
    }
    const release = (async () => {
      const lease = await acquisition;
      try {
        await lease.release();
      } catch {
        workspaceMcpLeaseFenced = true;
        throw new SessionLifecycleError("project_owner_unavailable");
      }
      if (workspaceMcpLeasePromise === acquisition) {
        workspaceMcpLeasePromise = undefined;
      }
    })();
    workspaceMcpLeaseReleasePromise = release;
    try {
      await release;
    } finally {
      if (workspaceMcpLeaseReleasePromise === release) {
        workspaceMcpLeaseReleasePromise = undefined;
      }
    }
  };
  const pendingMcpCatalogDurability = new Map<string, Promise<void>>();
  const preparedAdmissionTargets = new Map<
    string,
    {
      readonly runId: string;
      readonly resolved: Awaited<ReturnType<ModelTargets["resolve"]>>;
      readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
      readonly skillManifests: ReadonlyMap<string, SkillResourceManifestV1>;
      readonly skillPolicies: ReadonlyMap<string, "allow">;
      readonly onAdmitted?: (receipt: SessionAdmissionReceipt) => void;
    }
  >();
  const pendingMcpMetadataThrough = new Map<string, number>();
  let scheduleMcpCatalogFlush = (_sessionId: string) => {};
  const publishMetadata = async (event: SessionMetadataEvent): Promise<void> => {
    for (const listener of metadataListeners) {
      void Promise.resolve()
        .then(() => listener(event))
        .catch(() => undefined);
    }
  };
  const extensionExecutionDomain =
    options.extensionHost === undefined
      ? undefined
      : projectExecutionDomainForExtensionHost(options.extensionHost);
  const executionDomain =
    options[sessionProjectLifecycleOwner] === undefined && extensionExecutionDomain !== undefined
      ? extensionExecutionDomain
      : createProjectExecutionDomain({
          lifecycleOwner:
            options[sessionProjectLifecycleOwner] ?? createProjectLifecycleOwner(options),
        });
  let managedAgentStorePromise: Promise<ManagedAgentStore> | undefined;
  const resolveManagedAgentStore = () => {
    managedAgentStorePromise ??= createJsonlManagedAgentStore({
      workspaceRoot: options.workspaceRoot,
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    });
    return managedAgentStorePromise;
  };
  const managedAgentStore: ManagedAgentStore = {
    async append(record) {
      return (await resolveManagedAgentStore()).append(record);
    },
    async read() {
      return (await resolveManagedAgentStore()).read();
    },
  };
  const managedChildSessionStores = createJsonlSessionStoreDirectory<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    stateRoot: join(effectiveSessionStateRoot(options.stateRoot), "managed-child-sessions"),
  });
  const activeAgentManagers = new Map<string, AgentManager>();
  const toolsForSession = (
    sessionId: string,
    targetIdentity: ModelTargetIdentity,
    thinkingPolicy?: ThinkingPolicySnapshotV1,
    managedAgentTools = options.managedAgentTools,
  ): ToolRegistry => {
    const base = options.tools;
    if (
      options.modelTargets === undefined ||
      (managedAgentTools !== "managed-agent-tools.a1.v1" &&
        managedAgentTools !== "managed-agent-tools.a2-long-lived.v1")
    ) {
      if (base === undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return base;
    }
    const managerRouter: AgentManager = {
      parentRootId: `session:${sessionId}`,
      parentSessionId: sessionId,
      targetIdentity,
      ...(thinkingPolicy === undefined ? {} : { thinkingPolicy }),
      promptSummary() {
        return (
          activeAgentManagers.get(sessionId)?.promptSummary() ??
          "Managed agents: 0 active, 0 completed, 0 need attention; IDs: "
        );
      },
      async snapshot() {
        return (
          (await activeAgentManagers.get(sessionId)?.snapshot()) ?? {
            counts: { active: 0, completed: 0, attention: 0 },
            agents: [],
          }
        );
      },
      async spawnForeground(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The foreground scout host is unavailable.",
              },
            }
          : manager.spawnForeground(input);
      },
      async spawnBackground(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The background scout host is unavailable.",
              },
            }
          : manager.spawnBackground(input);
      },
      async list(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The managed-child host is unavailable.",
              },
            }
          : manager.list(input);
      },
      async cancel(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The managed-child host is unavailable.",
              },
            }
          : manager.cancel(input);
      },
      async wait(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The managed-child host is unavailable.",
              },
            }
          : manager.wait(input);
      },
      async followUp(input) {
        const manager = activeAgentManagers.get(sessionId);
        return manager === undefined
          ? {
              status: "failed",
              error: {
                code: "managed_agent_unavailable",
                message: "The managed-child host is unavailable.",
              },
            }
          : manager.followUp(input);
      },
      async waitForIdle() {
        await activeAgentManagers.get(sessionId)?.waitForIdle();
      },
      async close() {
        await activeAgentManagers.get(sessionId)?.close();
      },
      rebindParentRoot(parentRoot) {
        activeAgentManagers.get(sessionId)?.rebindParentRoot(parentRoot);
      },
    };
    return combineToolRegistries(
      base,
      createManagedAgentToolRegistry({ manager: managerRouter, profile: managedAgentTools }),
    );
  };
  const pendingMcpCatalogChanges = new Map<
    string,
    {
      readonly sessionId: string;
      readonly generationId: string;
      readonly serverId: string;
      readonly catalogDigest: `sha256:${string}`;
      readonly reason: "list_changed" | "server_closed";
      readonly attempt?: number;
      readonly closedServers?: readonly {
        readonly serverId: string;
        readonly definitionDigest: `sha256:${string}`;
      }[];
    }
  >();
  const mcpHost = createMcpRuntimeHost({
    ...(options[mcpBeforeToolDispatchBarrier] === undefined
      ? {}
      : { beforeToolDispatch: options[mcpBeforeToolDispatchBarrier] }),
    bootstrapScheduler: options[mcpBootstrapScheduler] ?? nodeMcpIdleScheduler,
    closeConfirmation: options[mcpCloseConfirmation] ?? { confirm: async () => Promise.resolve() },
    discoveryScheduler: options[mcpDiscoveryScheduler] ?? nodeMcpIdleScheduler,
    onCatalogStale(change) {
      disarmMcpIdle(change.sessionId);
      options[mcpCatalogStaleObservationBarrier]?.observed(change);
      pendingMcpCatalogChanges.set(
        `${change.sessionId}:${change.generationId}:${change.serverId}:${change.catalogDigest}`,
        change,
      );
      scheduleMcpCatalogFlush(change.sessionId);
    },
    packageRegistryUrl: options[mcpPackageRegistryUrl] ?? "https://registry.npmjs.org",
    packageManagerCliPath: options[mcpPackageManagerCliPath],
    requestScheduler: options[mcpRequestScheduler] ?? nodeMcpIdleScheduler,
    ...(options[mcpTransportFactory] === undefined
      ? {}
      : { transportFactory: options[mcpTransportFactory] }),
  });
  const releaseWorkspaceMcpLeaseIfIdle = async (): Promise<void> => {
    if (workspaceMcpActivationClaims === 0 && !mcpHost.hasWorkspaceSessions()) {
      await releaseWorkspaceMcpLease();
    }
  };
  const activateWithWorkspaceMcpLease = async <T>(activation: () => Promise<T>): Promise<T> => {
    workspaceMcpActivationClaims += 1;
    try {
      await ensureWorkspaceMcpLease();
      await options[workspaceMcpLeaseTransitionBarrier]?.activationLeaseReady?.();
      await requireTrustedWorkspace();
      return await activation();
    } finally {
      workspaceMcpActivationClaims -= 1;
      await releaseWorkspaceMcpLeaseIfIdle();
    }
  };
  const closePreparedMcpActivation = async (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly cause: unknown;
  }): Promise<McpHostError> => {
    try {
      const closed = await mcpHost.closePreparedActivation(input);
      if (closed.status === "closed") {
        await releaseWorkspaceMcpLeaseIfIdle();
      }
      return new McpHostError(
        closed.status === "closed" ? "mcp_start_failed" : "mcp_shutdown_unconfirmed",
        { cause: input.cause, closedServers: closed.servers },
      );
    } catch (closeError) {
      return new McpHostError("mcp_shutdown_unconfirmed", {
        cause: new AggregateError(
          [input.cause, closeError],
          "The prepared MCP activation could not be closed.",
        ),
      });
    }
  };
  const activeMcpConfigurationOperations = new Map<string, Promise<void>>();
  const idleScheduler = options[mcpIdleScheduler] ?? nodeMcpIdleScheduler;
  const mcpIdleTimers = new Map<
    string,
    { readonly generationId: string; readonly cancel: () => void }
  >();
  const mcpIdleOperations = new Map<string, Promise<void>>();
  const trackMcpConfigurationOperation = (
    generationId: string,
    operation: Promise<McpConfigurationResult>,
  ) => {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    activeMcpConfigurationOperations.set(generationId, settlement);
    void settlement.then(() => {
      if (activeMcpConfigurationOperations.get(generationId) === settlement) {
        activeMcpConfigurationOperations.delete(generationId);
      }
    });
  };
  type TrackedOwnerOperation = {
    readonly kind: "ordinary" | "title";
    readonly settlement: Promise<void>;
  };
  const trackedOwnerOperations = new Set<TrackedOwnerOperation>();
  let coordinatingOwnerOperation: TrackedOwnerOperation | undefined;
  const executeWithOwner = async <T>(
    kind: "ordinary" | "title",
    operation: (rootClaim: ProjectExecutionRootClaim) => Promise<T>,
    rootId = projectRuntimeRootId,
  ): Promise<T> => {
    const active = coordinatingOwnerOperation;
    if (active !== undefined && (kind === "title" || active.kind === "title")) {
      await active.settlement;
    }
    const operationPromise = executionDomain.claimRoot({ rootId }).then(async (rootClaim) => {
      try {
        return await operation(rootClaim);
      } finally {
        await rootClaim.release();
      }
    });
    const tracked = {
      kind,
      settlement: operationPromise.then(
        () => undefined,
        () => undefined,
      ),
    };
    trackedOwnerOperations.add(tracked);
    coordinatingOwnerOperation ??= tracked;
    try {
      return await operationPromise;
    } catch (error) {
      if (error instanceof ProjectExecutionDomainError) {
        throw new SessionLifecycleError(
          error.code === "root_conflict" || error.code === "project_in_use"
            ? "project_in_use"
            : "project_owner_unavailable",
        );
      }
      throw error;
    } finally {
      trackedOwnerOperations.delete(tracked);
      if (coordinatingOwnerOperation === tracked) {
        coordinatingOwnerOperation = undefined;
      }
    }
  };
  const runWithOwner = <T>(
    operation: (rootClaim: ProjectExecutionRootClaim) => Promise<T>,
    rootId?: string,
  ): Promise<T> => executeWithOwner("ordinary", operation, rootId);
  const runTitleWithOwner = <T>(
    operation: (rootClaim: ProjectExecutionRootClaim) => Promise<T>,
  ): Promise<T> => executeWithOwner("title", operation);
  const withOwner = async <T>(
    operation: (rootClaim: ProjectExecutionRootClaim) => Promise<T>,
    rootId?: string,
  ): Promise<T> => {
    if (lifecycleClosing) {
      throw new SessionLifecycleError("session_invalid");
    }
    return runWithOwner(operation, rootId);
  };
  const drainOwnerOperations = async (): Promise<void> => {
    while (trackedOwnerOperations.size > 0) {
      const settlements = [...trackedOwnerOperations].map(({ settlement }) => settlement);
      await options[sessionCloseDrainBarrier]?.beforeWait({
        activeCount: settlements.length,
        kind: "owner",
      });
      await Promise.allSettled(settlements);
    }
  };
  const titleAdmissionOperations = new Set<Promise<void>>();
  const titleOperations = new Set<Promise<void>>();
  const drainTitleOperations = async (): Promise<void> => {
    while (titleAdmissionOperations.size > 0) {
      await options[sessionCloseDrainBarrier]?.beforeWait({
        activeCount: titleAdmissionOperations.size,
        kind: "title_admission",
      });
      await Promise.allSettled(titleAdmissionOperations);
    }
    while (titleOperations.size > 0) {
      await options[sessionCloseDrainBarrier]?.beforeWait({
        activeCount: titleOperations.size,
        kind: "title_settlement",
      });
      await Promise.allSettled(titleOperations);
    }
  };
  const activeTitleSessions = new Set<string>();
  const commitTitleFailure = async (
    input: { readonly sessionId: string; readonly generationId: string },
    reason: "model_request_failed" | "invalid_title",
  ): Promise<void> => {
    await runTitleWithOwner(async () => {
      const records = await readSessionRecords(options, input.sessionId);
      if (
        records.some(
          (entry) =>
            entry.schemaVersion === 3 &&
            (entry.record.type === "session_title_generation_completed" ||
              entry.record.type === "session_title_generation_failed") &&
            entry.record.generationId === input.generationId,
        )
      ) {
        return;
      }
      const store = await openSessionStore(options, input.sessionId);
      const sequence = (records.at(-1)?.sequence ?? 0) + 1;
      await store.append({
        schemaVersion: 3,
        sequence,
        record: {
          type: "session_title_generation_failed",
          recordVersion: 1,
          generationId: input.generationId,
          reason,
        },
      });
      await publishMetadata({
        type: "session_naming_changed",
        sessionId: input.sessionId,
        throughSequence: sequence,
      });
    });
  };
  const settleTitleGeneration = async (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly targetIdentity: ModelTargetIdentity;
    readonly userMessage: string;
  }): Promise<void> => {
    const deadlineController = new AbortController();
    const deadline = (
      options[sessionTitleDeadlineScheduler] ?? nodeSessionTitleDeadlineScheduler
    ).schedule(30_000, () => deadlineController.abort(new Error("Title generation deadline.")));
    try {
      if (options.modelTargets === undefined) {
        await commitTitleFailure(input, "model_request_failed");
        return;
      }
      const signal = deadlineController.signal;
      const resolved = await options.modelTargets.resolve({
        targetId: input.targetIdentity.targetId,
        targetIdentity: input.targetIdentity,
        allowExperimental: input.targetIdentity.certification === "experimental",
        signal,
      });
      let text = "";
      let finish: "stop" | undefined;
      let usage:
        | { readonly status: "unknown" }
        | {
            readonly status: "known";
            readonly inputTokens: number;
            readonly outputTokens: number;
          } = {
        status: "unknown",
      };
      for await (const event of resolved.driver.stream({
        messages: [
          {
            role: "system",
            content:
              "Generate one concise plain-text title for this coding session. Return only the title.",
          },
          { role: "user", content: boundedTitleInput(input.userMessage) },
        ],
        tools: [],
        maximumOutputTokens: 64,
        purpose: "title",
        signal,
      })) {
        if (event.type === "text_delta") {
          text += event.text;
          if (Buffer.byteLength(text, "utf8") > 16 * 1024) {
            await commitTitleFailure(input, "invalid_title");
            return;
          }
        } else if (event.type === "usage") {
          usage = {
            status: "known",
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          };
        } else if (event.type === "finish") {
          finish = event.reason === "stop" ? "stop" : undefined;
        } else if (event.type.startsWith("tool_call_")) {
          await commitTitleFailure(input, "invalid_title");
          return;
        }
      }
      const title = normalizedSessionTitle(text);
      if (finish !== "stop" || title === null) {
        await commitTitleFailure(input, "invalid_title");
        return;
      }
      await runTitleWithOwner(async () => {
        const records = await readSessionRecords(options, input.sessionId);
        const latestGeneration = records.findLast(
          (entry) =>
            entry.schemaVersion === 3 && entry.record.type === "session_title_generation_started",
        );
        if (
          latestGeneration?.schemaVersion !== 3 ||
          latestGeneration.record.type !== "session_title_generation_started" ||
          latestGeneration.record.generationId !== input.generationId ||
          records.some(
            (entry) =>
              entry.schemaVersion === 3 &&
              (entry.record.type === "session_title_generation_completed" ||
                entry.record.type === "session_title_generation_failed") &&
              entry.record.generationId === input.generationId,
          )
        ) {
          return;
        }
        const store = await openSessionStore(options, input.sessionId);
        const sequence = (records.at(-1)?.sequence ?? 0) + 1;
        await store.append({
          schemaVersion: 3,
          sequence,
          record: {
            type: "session_title_generation_completed",
            recordVersion: 1,
            generationId: input.generationId,
            title,
            usage,
          },
        });
        await publishMetadata({
          type: "session_naming_changed",
          sessionId: input.sessionId,
          throughSequence: sequence,
        });
      });
    } catch {
      try {
        await commitTitleFailure(input, "model_request_failed");
      } catch {
        // Automatic naming metadata never changes the ordinary turn result.
      }
    } finally {
      deadline.cancel();
    }
  };
  const startAutomaticTitle = async (
    sessionId: string,
    sessionSnapshot: CurrentSessionSnapshot,
    eligible: boolean,
  ): Promise<CurrentSessionSnapshot | undefined> => {
    if (lifecycleClosing || !automaticTitlesEnabled || !eligible) {
      return undefined;
    }
    const admission = Promise.withResolvers<void>();
    titleAdmissionOperations.add(admission.promise);
    try {
      try {
        return await withOwner(async () => {
          const records = await readSessionRecords(options, sessionId);
          if (
            records.some(
              (entry) =>
                entry.schemaVersion === 3 &&
                (entry.record.type === "session_title_generation_started" ||
                  entry.record.type === "session_title_generation_skipped_manual"),
            )
          ) {
            return;
          }
          const store = await openSessionStore(options, sessionId);
          let manualNameActive = false;
          for (const entry of records) {
            if (entry.schemaVersion !== 3) {
              continue;
            }
            if (entry.record.type === "session_manual_name_set") {
              manualNameActive = true;
            } else if (entry.record.type === "session_manual_name_cleared") {
              manualNameActive = false;
            }
          }
          if (manualNameActive) {
            const sequence = (records.at(-1)?.sequence ?? 0) + 1;
            await store.append({
              schemaVersion: 3,
              sequence,
              record: { type: "session_title_generation_skipped_manual", recordVersion: 1 },
            });
            await publishMetadata({
              type: "session_naming_changed",
              sessionId,
              throughSequence: sequence,
            });
            const snapshot = await inspectSession({ sessionId });
            return snapshot.schemaVersion === 3 ? snapshot : undefined;
          }
          const generationId = randomUUID();
          const sequence = (records.at(-1)?.sequence ?? 0) + 1;
          await store.append({
            schemaVersion: 3,
            sequence,
            record: {
              type: "session_title_generation_started",
              recordVersion: 1,
              generationId,
              reason: "automatic",
              targetIdentity: sessionSnapshot.targetIdentity,
            },
          });
          await publishMetadata({
            type: "session_naming_changed",
            sessionId,
            throughSequence: sequence,
          });
          const firstRun = records.find(
            (entry) => entry.schemaVersion === 3 && entry.record.type === "logical_run_started",
          );
          if (firstRun?.schemaVersion === 3 && firstRun.record.type === "logical_run_started") {
            const operation = settleTitleGeneration({
              sessionId,
              generationId,
              targetIdentity: sessionSnapshot.targetIdentity,
              userMessage: firstRun.record.userMessage,
            });
            titleOperations.add(operation);
            activeTitleSessions.add(sessionId);
            void operation.finally(() => {
              titleOperations.delete(operation);
              activeTitleSessions.delete(sessionId);
            });
          }
          const snapshot = await inspectSession({ sessionId });
          return snapshot.schemaVersion === 3 ? snapshot : undefined;
        });
      } catch {
        // Automatic naming metadata never changes the ordinary turn result.
        return undefined;
      }
    } finally {
      admission.resolve();
      titleAdmissionOperations.delete(admission.promise);
    }
  };
  const flushPendingMcpCatalogChanges = async (sessionId: string): Promise<void> => {
    const changes = [...pendingMcpCatalogChanges.entries()]
      .filter(([, change]) => change.sessionId === sessionId)
      .sort(([, left], [, right]) =>
        left.generationId === right.generationId
          ? left.serverId < right.serverId
            ? -1
            : left.serverId > right.serverId
              ? 1
              : 0
          : left.generationId < right.generationId
            ? -1
            : left.generationId > right.generationId
              ? 1
              : 0,
      );
    if (changes.length === 0) {
      return;
    }
    const records = await readSessionRecords(options, sessionId);
    const store = await openSessionStore(options, sessionId);
    let nextSequence = (records.at(-1)?.sequence ?? 0) + 1;
    for (const [key, change] of changes) {
      const existingClosedServers = new Set(
        records.flatMap((entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "mcp_server_closed" &&
          entry.record.generationId === change.generationId
            ? [entry.record.serverId]
            : [],
        ),
      );
      if (change.attempt !== undefined) {
        for (const server of change.closedServers ?? []) {
          if (existingClosedServers.has(server.serverId)) {
            continue;
          }
          await store.append({
            schemaVersion: 3,
            sequence: nextSequence,
            record: {
              type: "mcp_server_closed",
              recordVersion: 1,
              generationId: change.generationId,
              attempt: change.attempt,
              serverId: server.serverId,
              definitionDigest: server.definitionDigest,
              reason: "stale",
            },
          });
          existingClosedServers.add(server.serverId);
          nextSequence += 1;
        }
      }
      const staleServers = mcpStaleCatalogServersFromRecords(
        records,
        change.generationId,
        change.catalogDigest,
      );
      if (!staleServers.has(change.serverId)) {
        await store.append({
          schemaVersion: 3,
          sequence: nextSequence,
          record: {
            type: "mcp_catalog_state_changed",
            recordVersion: 1,
            generationId: change.generationId,
            serverId: change.serverId,
            catalogDigest: change.catalogDigest,
            status: "stale",
            reason: change.reason,
          },
        });
        nextSequence += 1;
      }
      try {
        mcpHost.commitCatalogStale({
          sessionId: change.sessionId,
          generationId: change.generationId,
          serverId: change.serverId,
          catalogDigest: change.catalogDigest,
        });
      } catch (error) {
        if (mcpHost.snapshot(change.sessionId) !== undefined) {
          throw error;
        }
      }
      options[mcpCatalogStaleDurableBarrier]?.committed(change);
      pendingMcpCatalogChanges.delete(key);
    }
    const throughSequence = nextSequence - 1;
    if (activeSession === undefined) {
      await publishMetadata({ type: "mcp_configuration_changed", sessionId, throughSequence });
    } else {
      pendingMcpMetadataThrough.set(
        sessionId,
        Math.max(pendingMcpMetadataThrough.get(sessionId) ?? 0, throughSequence),
      );
    }
  };
  scheduleMcpCatalogFlush = (sessionId) => {
    if (pendingMcpCatalogDurability.has(sessionId)) {
      return;
    }
    const runningSession = activeSessionSettlement;
    const configurationOperations = [...activeMcpConfigurationOperations.values()];
    const operation = (async () => {
      await runningSession;
      await Promise.allSettled(configurationOperations);
      await runWithOwner(() => flushPendingMcpCatalogChanges(sessionId));
    })();
    pendingMcpCatalogDurability.set(sessionId, operation);
    void operation
      .catch(() => undefined)
      .finally(() => {
        if (pendingMcpCatalogDurability.get(sessionId) === operation) {
          pendingMcpCatalogDurability.delete(sessionId);
        }
      });
  };
  const disarmMcpIdle = (sessionId: string) => {
    const timer = mcpIdleTimers.get(sessionId);
    timer?.cancel();
    mcpIdleTimers.delete(sessionId);
  };
  const waitForMcpIdleOperation = async (sessionId: string) => {
    await mcpIdleOperations.get(sessionId);
  };
  const closeIdleMcpGeneration = async (sessionId: string, generationId: string) => {
    await withOwner(async () => {
      const closed = await mcpHost.closeIdleSession({ sessionId, generationId });
      const records = await readSessionRecords(options, sessionId);
      const store = await openSessionStore(options, sessionId);
      if (closed.status !== "closed") {
        for (const [index, server] of closed.servers.entries()) {
          await store.append({
            schemaVersion: 3,
            sequence: (records.at(-1)?.sequence ?? 0) + index + 1,
            record: {
              type: "mcp_catalog_state_changed",
              recordVersion: 1,
              generationId,
              serverId: server.serverId,
              catalogDigest: closed.catalogDigest,
              status: "stale",
              reason: "shutdown_unconfirmed",
            },
          });
        }
        return;
      }
      await releaseWorkspaceMcpLeaseIfIdle();
      for (const [index, server] of closed.servers.entries()) {
        await store.append({
          schemaVersion: 3,
          sequence: (records.at(-1)?.sequence ?? 0) + index + 1,
          record: {
            type: "mcp_server_closed",
            recordVersion: 1,
            generationId,
            attempt: closed.attempt,
            serverId: server.serverId,
            definitionDigest: server.definitionDigest,
            reason: "idle",
          },
        });
      }
    });
  };
  const armMcpIdle = (sessionId: string, generationId: string) => {
    disarmMcpIdle(sessionId);
    const scheduled = idleScheduler.schedule(mcpEffectiveBoundsV1.idleMilliseconds, async () => {
      if (mcpIdleTimers.get(sessionId)?.generationId !== generationId) {
        return;
      }
      mcpIdleTimers.delete(sessionId);
      const operation = closeIdleMcpGeneration(sessionId, generationId);
      mcpIdleOperations.set(sessionId, operation);
      try {
        await operation;
      } finally {
        if (mcpIdleOperations.get(sessionId) === operation) {
          mcpIdleOperations.delete(sessionId);
        }
      }
    });
    mcpIdleTimers.set(sessionId, { generationId, cancel: scheduled.cancel });
  };

  const inspectSession = async (
    input: { readonly sessionId: string },
    artifactCache = createArtifactMaterializationCache(),
  ): Promise<SessionSnapshot> => {
    const records = await storeDirectory.open(input.sessionId).then((store) => store?.read() ?? []);
    const first = records[0];
    if (first === undefined) {
      throw new SessionLifecycleError("session_not_found");
    }
    const projectId = await canonicalProjectId(options.workspaceRoot);
    if (first.schemaVersion === 1 || first.schemaVersion === 2) {
      if (records.some((record) => record.schemaVersion === 3)) {
        throw new SessionLifecycleError("session_invalid");
      }
      return {
        schemaVersion: records.some((record) => record.schemaVersion === 2) ? 2 : 1,
        sessionId: input.sessionId,
        projectId,
        status: "legacy",
        lastSequence: records.length,
      };
    }
    if (!isGenesisRecord(first) || first.record.sessionId !== input.sessionId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (first.record.projectId !== projectId) {
      throw new SessionLifecycleError("session_project_mismatch");
    }
    validateCurrentSessionHistory(first, records, options.workspaceRoot);
    await lineage.validateSessionLineage(first, records);
    await validateMcpAuthorityFromLineage(lineage, first, records);
    await validatePlanToolProfilesFromLineage(options, lineage, first, records);
    await skillResourceBytesFromLineage(lineage, first, records);
    const artifactInspection = await inspectModelResponseArtifactLineage(
      options,
      lineage,
      first,
      records,
      artifactCache,
    );
    if (artifactInspection.degradation === undefined) {
      await validatePromptProjectionDigests(
        options,
        lineage,
        first,
        artifactInspection.records,
        artifactCache,
      );
    }
    const replayRecords =
      artifactInspection.degradation === undefined ? artifactInspection.records : records;
    const snapshot = snapshotFromRecords(first, replayRecords, artifactInspection);
    const inheritedContext =
      artifactInspection.degradation === undefined
        ? await contextSnapshotFromLineage(options, lineage, first, replayRecords, artifactCache)
        : undefined;
    const [mcpWorkspaceConfirmation, mcpServerApprovals, mcpCommittedProfile, mcpCatalogState] =
      await Promise.all([
        mcpWorkspaceConfirmationFromLineage(lineage, first, records),
        mcpServerApprovalsFromLineage(lineage, first, records),
        mcpCommittedProfileFromLineage(lineage, first, records),
        mcpCatalogStateFromLineage(lineage, first, records),
      ]);
    let mcp: McpSessionSnapshot | undefined;
    if ((await inspectWorkspaceTrust()).status === "trusted") {
      try {
        mcp = await inspectMcpConfiguration(
          options.workspaceRoot,
          mcpWorkspaceConfirmation?.sourceDigest,
          mcpServerApprovals,
          mcpHost.snapshot(input.sessionId),
          mcpActivationFailureFromRecords(records),
          mcpCommittedProfile,
          mcpCatalogState,
          mcpActivationFromRecords(records),
        );
      } catch (error) {
        if (error instanceof McpConfigurationError) {
          throw new SessionLifecycleError("mcp_config_invalid");
        }
        throw error;
      }
    }
    return {
      ...snapshot,
      ...(inheritedContext === undefined ? {} : { context: inheritedContext }),
      ...(mcp === undefined ? {} : { mcp }),
    };
  };

  const inspectSessionContextUsage = async (
    input: { readonly sessionId: string },
    artifactCache = createArtifactMaterializationCache(),
  ): Promise<SessionContextUsageSnapshot | null> => {
    const records = await storeDirectory.open(input.sessionId).then((store) => store?.read() ?? []);
    const first = records[0];
    if (first === undefined) {
      throw new SessionLifecycleError("session_not_found");
    }
    if (first.schemaVersion === 1 || first.schemaVersion === 2) {
      return null;
    }
    const projectId = await canonicalProjectId(options.workspaceRoot);
    if (!isGenesisRecord(first) || first.record.sessionId !== input.sessionId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (first.record.projectId !== projectId) {
      throw new SessionLifecycleError("session_project_mismatch");
    }
    validateCurrentSessionHistory(first, records, options.workspaceRoot);
    await lineage.validateSessionLineage(first, records);
    const artifactInspection = await inspectModelResponseArtifactLineage(
      options,
      lineage,
      first,
      records,
      artifactCache,
    );
    if (artifactInspection.degradation !== undefined) {
      return null;
    }
    return (
      (await contextUsageSnapshotFromLineage(
        options,
        lineage,
        first,
        artifactInspection.records,
        artifactCache,
      )) ?? null
    );
  };

  const resumeSession = async (
    input: { readonly sessionId: string },
    artifactCache = createArtifactMaterializationCache(),
  ): Promise<SessionResumeResult> => {
    let snapshot = await inspectSession(input, artifactCache);
    if (snapshot.schemaVersion === 3 && snapshot.degradation !== undefined) {
      return {
        status: "rejected",
        snapshot,
        error: {
          code: "session_replay_unavailable",
          message: "Replay-authoritative model response content is unavailable.",
        },
      };
    }
    if (snapshot.schemaVersion === 3 && snapshot.status === "interrupted") {
      const restoredUserMessage = await appendMissingUserMessage(options, snapshot);
      if (restoredUserMessage) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (snapshot.schemaVersion !== 3) {
        throw new SessionLifecycleError("session_invalid");
      }
      const interruptedCompaction = await appendDanglingContextCompactionInterruption(
        options,
        snapshot,
      );
      if (interruptedCompaction) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (snapshot.schemaVersion !== 3) {
        throw new SessionLifecycleError("session_invalid");
      }
      const didNormalize = await appendDanglingAttemptInterruption(options, snapshot);
      if (didNormalize) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleRunTerminalIntent(options, snapshot))
      ) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleInterruptedCancellation(options, snapshot))
      ) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleCompletedResponseTerminal(options, snapshot, artifactCache))
      ) {
        snapshot = await inspectSession(input, artifactCache);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleIndeterminateToolEffects(options, snapshot))
      ) {
        snapshot = await inspectSession(input, artifactCache);
      }
    }
    if (snapshot.schemaVersion === 3) {
      const promptRecords = await readSessionRecords(options, input.sessionId);
      const promptGenesis = promptRecords[0];
      const activePromptContext =
        promptGenesis !== undefined && isGenesisRecord(promptGenesis)
          ? promptContextRecordFromRecords(promptGenesis, promptRecords)
          : undefined;
      let compatibleTools = toolsForSession(
        input.sessionId,
        snapshot.targetIdentity,
        undefined,
        promptGenesis !== undefined && isGenesisRecord(promptGenesis)
          ? promptGenesis.record.managedAgentTools
          : undefined,
      );
      if (activePromptContext?.recordVersion === 3 && activePromptContext.mcp !== undefined) {
        const profile =
          promptGenesis === undefined || !isGenesisRecord(promptGenesis)
            ? undefined
            : await mcpCommittedProfileFromLineage(lineage, promptGenesis, promptRecords);
        if (profile === undefined || profile.digest !== activePromptContext.mcp.profileDigest) {
          throw new SessionLifecycleError("session_invalid");
        }
        compatibleTools = combineToolRegistries(
          compatibleTools,
          mcpProfileDefinitionRegistry(profile),
        );
      }
      if (
        snapshot.promptContext !== undefined &&
        (promptGenesis === undefined ||
          !isGenesisRecord(promptGenesis) ||
          activePromptContext === undefined ||
          !isPromptContextRecordCompatible(activePromptContext, compatibleTools) ||
          !isPromptContextCompatible(snapshot.promptContext, compatibleTools))
      ) {
        return {
          status: "rejected",
          snapshot,
          error: {
            code: "prompt_profile_incompatible",
            message: "The exact recorded prompt and tool profile is not supported by this runtime.",
          },
        };
      }
      if (options.modelTargets === undefined) {
        return {
          status: "rejected",
          snapshot,
          error: {
            code: "model_target_unavailable",
            message: "The recorded model target cannot be checked in this runtime.",
          },
        };
      }
      const targetSnapshot = await options.modelTargets.snapshot({
        includeHistoricalProfiles: true,
        signal: new AbortController().signal,
      });
      const target = targetSnapshot.targets.find((candidate) =>
        sameModelTargetIdentity(candidate.identity, snapshot.targetIdentity),
      );
      if (
        target === undefined ||
        !modelTargetUsesContextProfile(snapshot.targetIdentity, target.contextProfile) ||
        !isContextProfileSupported(target.contextProfile)
      ) {
        return {
          status: "rejected",
          snapshot,
          error: {
            code: "model_target_incompatible",
            message: "The exact recorded model target is not supported by this runtime.",
          },
        };
      }
      if (target.readiness.status !== "available") {
        return {
          status: "rejected",
          snapshot,
          error: {
            code: "model_target_unavailable",
            message: `The exact recorded model target requires ${target.readiness.credentialSource}.`,
          },
        };
      }
      const historicalProfile =
        promptGenesis === undefined || !isGenesisRecord(promptGenesis)
          ? undefined
          : historicalContextProfile(
              promptGenesis,
              snapshot.context?.profile,
              target.contextProfile,
            );
      if (
        historicalProfile === undefined ||
        !isHistoricalContextProfileSupported(target.contextProfile, historicalProfile)
      ) {
        return {
          status: "rejected",
          snapshot,
          error: {
            code: "model_target_incompatible",
            message: "The exact recorded context profile is not supported by this runtime.",
          },
        };
      }
      return { status: "ready", snapshot };
    }
    return {
      status: "rejected",
      snapshot,
      error: {
        code: "non_resumable_legacy_session",
        message: "Legacy session history can be inspected but cannot be resumed safely.",
      },
    };
  };

  const prepareSessionInspection = async (sessionId: string): Promise<void> => {
    await waitForMcpIdleOperation(sessionId);
    if (activeSession !== undefined) {
      return;
    }
    await pendingMcpCatalogDurability.get(sessionId);
    if ([...pendingMcpCatalogChanges.values()].some((change) => change.sessionId === sessionId)) {
      await runWithOwner(() => flushPendingMcpCatalogChanges(sessionId));
    }
  };

  const inspectWorkspaceTrust = async (): Promise<WorkspaceTrustSnapshot> => {
    if (options.workspaceTrust !== undefined) {
      return options.workspaceTrust.load();
    }
    const identity = await resolveCanonicalWorkspaceIdentity(options.workspaceRoot);
    return { ...identity, status: "trusted", diagnostic: null };
  };
  const requireTrustedWorkspace = async (): Promise<void> => {
    if ((await inspectWorkspaceTrust()).status !== "trusted") {
      throw new SessionLifecycleError("session_workspace_untrusted");
    }
  };

  const prepareSessionCreation = async (input: {
    readonly targetIdentity: ModelTargetIdentity;
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly skills?: readonly string[];
    readonly resolved?: Awaited<ReturnType<ModelTargets["resolve"]>>;
  }): Promise<{
    readonly genesis: SessionGenesisRecord;
    readonly mcp: McpSessionSnapshot | undefined;
    readonly skillManifests: ReadonlyMap<string, SkillResourceManifestV1>;
    readonly skillPolicies: ReadonlyMap<string, "allow">;
    readonly selectedSkills?: readonly string[];
  }> => {
    input.signal?.throwIfAborted();
    const workspaceTrust = await inspectWorkspaceTrust();
    const projectInputsTrusted = workspaceTrust.status === "trusted";
    let mcp: McpSessionSnapshot | undefined;
    if (projectInputsTrusted) {
      try {
        mcp = await inspectMcpConfiguration(options.workspaceRoot);
      } catch (error) {
        if (error instanceof McpConfigurationError) {
          throw new SessionLifecycleError("mcp_config_invalid");
        }
        throw error;
      }
    }
    const sessionId = randomUUID();
    const projectId = await canonicalProjectId(options.workspaceRoot);
    const repository = await loadInitialRepositoryInstructions({
      includeProjectSources: projectInputsTrusted,
      workspaceRoot: options.workspaceRoot,
    });
    const skillBudgetContext =
      input.resolved === undefined
        ? await resolveSkillBudgetContext(options, input.targetIdentity)
        : {
            effectiveContextTokens: input.resolved.contextProfile.contextWindowTokens,
            estimatorVersion: input.resolved.contextProfile.estimatorVersion,
          };
    const extensionSources = await resolveExtensionSkillSources(options);
    const stagedArtifactStore = createStagedArtifactStore();
    const skillContext = await createInitialSkillContextV1({
      artifactStore: stagedArtifactStore,
      ...skillBudgetContext,
      projectId,
      sessionId,
      userHome: homedir(),
      workspaceRoot: options.workspaceRoot,
      extensionSources,
      includeProjectSources: projectInputsTrusted,
    });
    const selectedSkills: string[] = [];
    const skillManifests = new Map<string, SkillResourceManifestV1>();
    const skillPolicies = new Map<string, "allow">();
    if (input.skills !== undefined) {
      if (input.runId === undefined || !draftSkillSelectionsAreValid(input.skills)) {
        throw new SessionLifecycleError("session_skill_unavailable");
      }
      for (const [index, selection] of input.skills.entries()) {
        const exactCandidate = skillContext.registry.candidates.find(
          (entry) => entry.qualifiedId === selection,
        );
        const shortCandidates = skillContext.registry.candidates.filter(
          (entry) => entry.name === selection,
        );
        const candidate =
          exactCandidate ?? (shortCandidates.length === 1 ? shortCandidates[0] : undefined);
        if (candidate === undefined) {
          throw new SessionLifecycleError("session_skill_unavailable");
        }
        const requestId = `${input.runId}:skill:${index + 1}`;
        selectedSkills.push(candidate.qualifiedId);
        const manifest = await buildSkillResourceManifestV1({
          candidate,
          workspaceRoot: options.workspaceRoot,
          userHome: homedir(),
          userHomeDigest: skillContext.userHomeDigest,
          ...(extensionSources.length === 0 ? {} : { extensionSources }),
        });
        const policy =
          options.permissions?.decide({
            callId: requestId,
            name: "activate_skill",
            effect: "read",
            scope: "call",
            subject: {
              type: "skill",
              operation: "activate",
              qualifiedId: candidate.qualifiedId,
            },
          }) ?? "deny";
        if (policy === "deny") {
          throw new SessionLifecycleError("session_skill_policy_rejected");
        }
        if (policy === "ask") {
          throw new SessionLifecycleError("session_skill_confirmation_required");
        }
        skillManifests.set(requestId, manifest);
        skillPolicies.set(requestId, policy);
      }
    }
    if (options.tools === undefined) {
      throw new SessionLifecycleError("session_invalid");
    }
    input.signal?.throwIfAborted();
    await stagedArtifactStore.flushTo(
      createLazyArtifactStore(join(effectiveSessionStateRoot(options.stateRoot), "artifacts")),
    );
    input.signal?.throwIfAborted();
    return {
      genesis: {
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "session_genesis",
          ...(input.resolved === undefined
            ? {}
            : { recordVersion: 2 as const, contextProfile: input.resolved.contextProfile }),
          sessionId,
          projectId,
          targetIdentity: input.targetIdentity,
          ...(options.managedAgentTools === undefined
            ? {}
            : { managedAgentTools: options.managedAgentTools }),
          promptContext: createPromptContextV3(
            toolsForSession(sessionId, input.targetIdentity),
            repository,
            skillContext,
          ),
          skillContext,
        },
      },
      mcp,
      skillManifests,
      skillPolicies,
      ...(input.skills === undefined ? {} : { selectedSkills }),
    };
  };

  const persistPreparedSession = async (prepared: {
    readonly genesis: SessionGenesisRecord;
    readonly mcp: McpSessionSnapshot | undefined;
  }): Promise<CurrentSessionSnapshot> => {
    const store = await storeDirectory.create(prepared.genesis.record.sessionId);
    await store.append(prepared.genesis);
    const snapshot = snapshotFromGenesis(prepared.genesis, 1);
    return prepared.mcp === undefined ? snapshot : { ...snapshot, mcp: prepared.mcp };
  };

  return {
    async admit(input) {
      const runId = input.runId ?? randomUUID();
      if (
        !z.uuid().safeParse(runId).success ||
        (input.input.text.trim().length === 0 &&
          (input.pastedTextSelections === undefined || input.pastedTextSelections.length === 0)) ||
        !draftRunLimitsAreValid(input.limits) ||
        options.modelTargets === undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const created = await withOwner(async () => {
        await requireTrustedWorkspace();
        const officialResolved = await options.modelTargets?.resolve({
          targetId: input.targetIdentity.targetId,
          targetIdentity: input.targetIdentity,
          allowExperimental: input.targetIdentity.certification === "experimental",
          signal: input.signal ?? new AbortController().signal,
        });
        let resolved = officialResolved;
        if (officialResolved !== undefined && options.preferences !== undefined) {
          try {
            resolved = {
              ...officialResolved,
              contextProfile: await options.preferences.resolveContextProfile(
                officialResolved.contextProfile,
              ),
            };
          } catch {
            throw new SessionLifecycleError("session_user_configuration_invalid");
          }
        }
        if (
          resolved === undefined ||
          !sameModelTargetIdentity(resolved.identity, input.targetIdentity) ||
          !modelTargetUsesContextProfile(input.targetIdentity, resolved.contextProfile) ||
          !isContextProfileSupported(resolved.contextProfile)
        ) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        const thinkingPolicy = resolveRunThinkingPolicy(resolved, input.thinkingSelection);
        const prepared = await prepareSessionCreation({
          targetIdentity: input.targetIdentity,
          runId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.input.skills === undefined ? {} : { skills: input.input.skills }),
          resolved,
        });
        input.signal?.throwIfAborted();
        let snapshot: CurrentSessionSnapshot;
        try {
          snapshot = await persistPreparedSession(prepared);
        } catch {
          throw new SessionLifecycleError("session_persistence_failed");
        }
        preparedAdmissionTargets.set(snapshot.sessionId, {
          runId,
          resolved,
          ...(thinkingPolicy === undefined ? {} : { thinkingPolicy }),
          skillManifests: prepared.skillManifests,
          skillPolicies: prepared.skillPolicies,
          ...(input.onAdmitted === undefined ? {} : { onAdmitted: input.onAdmitted }),
        });
        return { snapshot, selectedSkills: prepared.selectedSkills };
      });
      try {
        return await this.continue({
          sessionId: created.snapshot.sessionId,
          input:
            created.selectedSkills === undefined
              ? input.input
              : { ...input.input, skills: created.selectedSkills },
          runId,
          ...(input.limits === undefined ? {} : { limits: input.limits }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.resourceSelections === undefined
            ? {}
            : { resourceSelections: input.resourceSelections }),
          ...(input.pastedTextSelections === undefined
            ? {}
            : { pastedTextSelections: input.pastedTextSelections }),
          ...(input.structuredContent === undefined
            ? {}
            : { structuredContent: input.structuredContent }),
          ...(input.thinkingSelection === undefined
            ? {}
            : { thinkingSelection: input.thinkingSelection }),
        });
      } finally {
        preparedAdmissionTargets.delete(created.snapshot.sessionId);
      }
    },
    async branch(input) {
      return withOwner(async () => {
        const artifactCache = createArtifactMaterializationCache();
        const requestedPosition = input.sourceBoundary?.sequence ?? input.atSequence;
        if (
          requestedPosition === undefined ||
          !Number.isSafeInteger(requestedPosition) ||
          requestedPosition <= 0
        ) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        let parent = await inspectSession({ sessionId: input.parentSessionId }, artifactCache);
        if (parent.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        if (parent.degradation !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        let parentRecords = await readSessionRecords(options, input.parentSessionId);
        const requestedCurrentTail =
          input.sourceBoundary === undefined && input.atSequence === parentRecords.length;
        let normalizedCurrentTail = false;
        if (parent.status === "interrupted" && requestedCurrentTail) {
          const restoredUserMessage = await appendMissingUserMessage(options, parent);
          if (restoredUserMessage) {
            parent = (await inspectSession(
              { sessionId: input.parentSessionId },
              artifactCache,
            )) as CurrentSessionSnapshot;
          }
          const interruptedAttempt = await appendDanglingAttemptInterruption(options, parent);
          if (interruptedAttempt) {
            parent = (await inspectSession(
              { sessionId: input.parentSessionId },
              artifactCache,
            )) as CurrentSessionSnapshot;
          }
          const terminalIntent =
            parent.status === "interrupted" && (await settleRunTerminalIntent(options, parent));
          if (terminalIntent) {
            parent = (await inspectSession(
              { sessionId: input.parentSessionId },
              artifactCache,
            )) as CurrentSessionSnapshot;
          }
          const cancelledRun =
            parent.status === "interrupted" &&
            (await settleInterruptedCancellation(options, parent));
          if (cancelledRun) {
            parent = (await inspectSession(
              { sessionId: input.parentSessionId },
              artifactCache,
            )) as CurrentSessionSnapshot;
          }
          const indeterminateEffect =
            parent.status === "interrupted" &&
            (await settleIndeterminateToolEffects(options, parent));
          if (indeterminateEffect) {
            parent = (await inspectSession(
              { sessionId: input.parentSessionId },
              artifactCache,
            )) as CurrentSessionSnapshot;
          }
          if (
            restoredUserMessage ||
            interruptedAttempt ||
            terminalIntent ||
            cancelledRun ||
            indeterminateEffect
          ) {
            normalizedCurrentTail = true;
            parentRecords = await readSessionRecords(options, input.parentSessionId);
          }
        }
        const sourceSessionId = input.sourceBoundary?.sessionId ?? input.parentSessionId;
        const sourceEventPosition =
          input.sourceBoundary === undefined
            ? requestedCurrentTail && normalizedCurrentTail
              ? parentRecords.length
              : input.atSequence
            : input.sourceBoundary.sequence;
        const parentGenesisRecord = parentRecords[0];
        if (
          parentGenesisRecord === undefined ||
          !isGenesisRecord(parentGenesisRecord) ||
          !(await lineage.sessionInheritsSourceBoundary(
            parentGenesisRecord,
            sourceSessionId,
            sourceEventPosition,
          ))
        ) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const sourceRecords =
          sourceSessionId === input.parentSessionId
            ? parentRecords
            : await readSessionRecords(options, sourceSessionId);
        if (sourceEventPosition > sourceRecords.length) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const parentPrefix = sourceRecords.slice(0, sourceEventPosition);
        const parentGenesis = parentPrefix[0];
        if (parentGenesis === undefined || !isGenesisRecord(parentGenesis)) {
          throw new SessionLifecycleError("session_invalid");
        }
        validateCurrentSessionHistory(parentGenesis, parentPrefix, options.workspaceRoot);
        await validateMcpAuthorityFromLineage(lineage, parentGenesis, parentPrefix);
        await replayArtifactBytesFromLineage(
          options,
          lineage,
          parentGenesis,
          parentPrefix,
          artifactCache,
        );
        if (!isCompleteBranchBoundary(parentPrefix)) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const parentPromptContext = promptContextRecordFromRecords(parentGenesis, parentPrefix);
        const parentSkillContext = skillContextRecordFromRecords(parentGenesis, parentPrefix);
        let targetIdentity = parent.targetIdentity;
        let branchContextProfile: ContextProfile | undefined;
        if (input.targetId !== undefined) {
          if (options.modelTargets === undefined) {
            throw new SessionLifecycleError("session_model_target_unavailable");
          }
          const targets = await options.modelTargets.snapshot({
            signal: new AbortController().signal,
          });
          const target = targets.targets.find(
            (candidate) => candidate.identity.targetId === input.targetId,
          );
          if (target === undefined) {
            throw new SessionLifecycleError("session_model_target_incompatible");
          }
          if (target.readiness.status !== "available") {
            throw new SessionLifecycleError("session_model_target_unavailable");
          }
          targetIdentity = target.identity;
          if (sameModelTargetIdentity(target.identity, parent.targetIdentity)) {
            if (!isContextProfileSupported(target.contextProfile)) {
              throw new SessionLifecycleError("session_model_target_incompatible");
            }
            const prefixContext = await contextSnapshotFromLineage(
              options,
              lineage,
              parentGenesis,
              parentPrefix,
              artifactCache,
            );
            branchContextProfile = historicalContextProfile(
              parentGenesis,
              prefixContext?.profile,
              target.contextProfile,
            );
            if (!isHistoricalContextProfileSupported(target.contextProfile, branchContextProfile)) {
              throw new SessionLifecycleError("session_model_target_incompatible");
            }
          } else {
            if (
              (await modelResponseTargetsFromBranchContext(lineage, parentPrefix)).some(
                (identity) => !areReplayProfilesCompatible(target.identity, identity),
              )
            ) {
              throw new SessionLifecycleError("session_model_target_incompatible");
            }
            if (options.preferences === undefined) {
              branchContextProfile = target.contextProfile;
            } else {
              try {
                branchContextProfile = await options.preferences.resolveContextProfile(
                  target.contextProfile,
                );
              } catch {
                throw new SessionLifecycleError("session_user_configuration_invalid");
              }
            }
          }
        } else if (options.modelTargets !== undefined) {
          const targets = await options.modelTargets.snapshot({
            includeHistoricalProfiles: true,
            signal: new AbortController().signal,
          });
          const target = targets.targets.find((candidate) =>
            sameModelTargetIdentity(candidate.identity, targetIdentity),
          );
          if (
            target === undefined ||
            target.readiness.status !== "available" ||
            !isContextProfileSupported(target.contextProfile)
          ) {
            throw new SessionLifecycleError("session_model_target_incompatible");
          }
          const prefixContext = await contextSnapshotFromLineage(
            options,
            lineage,
            parentGenesis,
            parentPrefix,
            artifactCache,
          );
          branchContextProfile = historicalContextProfile(
            parentGenesis,
            prefixContext?.profile,
            target.contextProfile,
          );
          if (!isHistoricalContextProfileSupported(target.contextProfile, branchContextProfile)) {
            throw new SessionLifecycleError("session_model_target_incompatible");
          }
        }
        const sessionId = randomUUID();
        const store = await sessionStoreDirectoryFrom(options).create(sessionId);
        const prefix = `${parentPrefix.map((record) => JSON.stringify(record)).join("\n")}\n`;
        const branchFallback = sessionTitleFallback(
          `Branch of ${sessionNamingStateFromRecords(parentRecords).displayLabel}`,
        );
        const genesis: SessionGenesisRecord = {
          schemaVersion: 3,
          sequence: 1,
          record: {
            type: "session_genesis",
            ...(branchContextProfile === undefined
              ? {}
              : { recordVersion: 2 as const, contextProfile: branchContextProfile }),
            sessionId,
            projectId: parent.projectId,
            targetIdentity,
            ...(parentGenesis.record.managedAgentTools === undefined
              ? {}
              : { managedAgentTools: parentGenesis.record.managedAgentTools }),
            naming: { profileVersion: 1, fallbackTitle: branchFallback },
            ...(parentPromptContext === undefined ? {} : { promptContext: parentPromptContext }),
            ...(parentSkillContext === undefined ? {} : { skillContext: parentSkillContext }),
            lineage:
              input.sourceBoundary === undefined
                ? {
                    parentSessionId: input.parentSessionId,
                    parentEventPosition: sourceEventPosition,
                    prefixDigest: `sha256:${createHash("sha256").update(prefix).digest("hex")}`,
                  }
                : {
                    recordVersion: 2,
                    parentSessionId: input.parentSessionId,
                    sourceSessionId,
                    sourceEventPosition,
                    sourcePrefixDigest: `sha256:${createHash("sha256")
                      .update(prefix)
                      .digest("hex")}`,
                  },
          },
        };
        await store.append(genesis);
        let nextSequence = 2;
        const parentPlan = planCycleSnapshotFromRecords(parentPrefix);
        if (parentPlan !== undefined) {
          await store.append({
            schemaVersion: 3,
            sequence: nextSequence,
            record: {
              type: "plan_cycle_inherited",
              recordVersion: 1,
              cycleId: parentPlan.cycleId,
              revision: parentPlan.revision,
              policyVersion: parentPlan.policyVersion,
              ...(parentPlan.shellPolicyVersion === undefined
                ? {}
                : { shellPolicyVersion: parentPlan.shellPolicyVersion }),
              ...(parentPlan.shellEnvironment === undefined
                ? {}
                : { shellEnvironment: parentPlan.shellEnvironment }),
              ...(parentPlan.gitPolicyVersion === undefined
                ? {}
                : { gitPolicyVersion: parentPlan.gitPolicyVersion }),
              ...(parentPlan.gitPolicyDigest === undefined
                ? {}
                : { gitPolicyDigest: parentPlan.gitPolicyDigest }),
              ...(parentPlan.gitAttestation === undefined
                ? {}
                : { gitAttestation: parentPlan.gitAttestation }),
              eligibleToolProfile: parentPlan.eligibleToolProfile,
              state: parentPlan.state === "exploring" ? "exploring" : "ready",
              ...(parentPlan.state === "exploring" ? {} : { submission: parentPlan.submission }),
              source: { sessionId: sourceSessionId, throughSequence: sourceEventPosition },
            },
          });
          nextSequence += 1;
        }
        const parentTodo = todoStoreSnapshotFromRecordsV1(parentPrefix);
        if (parentTodo.storeRevision > 0) {
          const inheritedTodoRecords = createInheritedTodoStoreRecordsV1({
            firstSequence: nextSequence,
            snapshot: parentTodo,
            source: { sessionId: sourceSessionId, throughSequence: sourceEventPosition },
          });
          await store.appendBatch(inheritedTodoRecords);
          nextSequence += inheritedTodoRecords.length;
        }
        const extensionSources = await resolveExtensionSkillSources(options);
        if (hasSkillPromptContext(parentPromptContext) && parentSkillContext !== undefined) {
          const reconciled = reconcileExtensionSkillContextV1({
            context: parentSkillContext,
            currentSources: extensionSources,
          });
          if (reconciled.context !== parentSkillContext) {
            const nextPromptContext = replacePromptSkillsV2(
              parentPromptContext,
              reconciled.context,
            );
            await store.append({
              schemaVersion: 3,
              sequence: nextSequence,
              record: {
                type: "skill_catalog_committed",
                recordVersion: 1,
                previousRevision: parentSkillContext.registry.revision,
                previousRegistryDigest: parentSkillContext.registry.digest,
                skillContext: reconciled.context,
                assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
                reason: "extension_reconciliation",
              },
            });
            nextSequence += 1;
            for (const revocation of reconciled.revoked) {
              await store.append({
                schemaVersion: 3,
                sequence: nextSequence,
                record: {
                  type: "skill_revoked",
                  recordVersion: 1,
                  catalogRevision: reconciled.context.catalog.revision,
                  activationIndex: revocation.activationIndex,
                  qualifiedId: revocation.qualifiedId,
                  reason: revocation.reason,
                  sourceEpoch: revocation.sourceEpoch,
                },
              });
              nextSequence += 1;
            }
          }
        }
        const snapshot = await inspectSession({ sessionId }, artifactCache);
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return snapshot;
      });
    },
    async close() {
      if (lifecycleClosePromise !== undefined) {
        return lifecycleClosePromise;
      }
      lifecycleClosing = true;
      const runningSession = activeSessionSettlement;
      activeSession?.abort();
      lifecycleClosePromise = (async (): Promise<McpCloseResult> => {
        await runningSession;
        const managedAgentSettlements = await Promise.allSettled(
          [...activeAgentManagers.values()].map((manager) => manager.close()),
        );
        if (managedAgentSettlements.some((result) => result.status === "rejected")) {
          throw new SessionLifecycleError("project_owner_unavailable");
        }
        activeAgentManagers.clear();
        await Promise.allSettled(pendingMcpCatalogDurability.values());
        for (const timer of mcpIdleTimers.values()) {
          timer.cancel();
        }
        mcpIdleTimers.clear();
        await Promise.allSettled(mcpIdleOperations.values());
        const hostResult = await mcpHost.close();
        if (hostResult.status === "closed") {
          await releaseWorkspaceMcpLeaseIfIdle();
        }
        await Promise.allSettled(activeMcpConfigurationOperations.values());
        await drainOwnerOperations();
        await drainTitleOperations();
        await drainOwnerOperations();
        let durable = true;
        try {
          await runWithOwner(async () => {
            for (const closedSession of hostResult.closedSessions) {
              await flushPendingMcpCatalogChanges(closedSession.sessionId);
              const records = await readSessionRecords(options, closedSession.sessionId);
              const existing = new Set(
                records.flatMap((entry) =>
                  entry.schemaVersion === 3 &&
                  entry.record.type === "mcp_server_closed" &&
                  entry.record.generationId === closedSession.generationId
                    ? [entry.record.serverId]
                    : [],
                ),
              );
              const missing = closedSession.servers.filter(
                (server) => !existing.has(server.serverId),
              );
              if (missing.length === 0) {
                continue;
              }
              const store = await openSessionStore(options, closedSession.sessionId);
              for (const [index, server] of missing.entries()) {
                await store.append({
                  schemaVersion: 3,
                  sequence: (records.at(-1)?.sequence ?? 0) + index + 1,
                  record: {
                    type: "mcp_server_closed",
                    recordVersion: 1,
                    generationId: closedSession.generationId,
                    attempt: closedSession.attempt,
                    serverId: server.serverId,
                    definitionDigest: server.definitionDigest,
                    reason: "session_close",
                  },
                });
              }
            }
            for (const unconfirmed of hostResult.unconfirmedSessions) {
              if (unconfirmed.catalogDigest === undefined || unconfirmed.servers.length === 0) {
                continue;
              }
              const records = await readSessionRecords(options, unconfirmed.sessionId);
              const existing = new Set(
                records.flatMap((entry) =>
                  entry.schemaVersion === 3 &&
                  entry.record.type === "mcp_catalog_state_changed" &&
                  entry.record.generationId === unconfirmed.generationId &&
                  entry.record.reason === "shutdown_unconfirmed"
                    ? [entry.record.serverId]
                    : [],
                ),
              );
              const missing = unconfirmed.servers.filter(
                (server) => !existing.has(server.serverId),
              );
              if (missing.length === 0) {
                continue;
              }
              const store = await openSessionStore(options, unconfirmed.sessionId);
              for (const [index, server] of missing.entries()) {
                await store.append({
                  schemaVersion: 3,
                  sequence: (records.at(-1)?.sequence ?? 0) + index + 1,
                  record: {
                    type: "mcp_catalog_state_changed",
                    recordVersion: 1,
                    generationId: unconfirmed.generationId,
                    serverId: server.serverId,
                    catalogDigest: unconfirmed.catalogDigest,
                    status: "stale",
                    reason: "shutdown_unconfirmed",
                  },
                });
              }
            }
          });
        } catch {
          durable = false;
        }
        await executionDomain.close();
        return {
          status:
            hostResult.status === "closed" && durable
              ? ("closed" as const)
              : ("mcp_shutdown_unconfirmed" as const),
        };
      })();
      return lifecycleClosePromise;
    },
    async create(input) {
      return withOwner(async () => {
        await requireTrustedWorkspace();
        return persistPreparedSession(
          await prepareSessionCreation({ targetIdentity: input.targetIdentity }),
        );
      });
    },
    async continue(input) {
      if (
        (input.runId !== undefined && !z.uuid().safeParse(input.runId).success) ||
        (input.planApproval !== undefined &&
          (!z.uuid().safeParse(input.planApproval.commandId).success ||
            input.input !== undefined ||
            input.runId !== undefined ||
            input.planRevision !== undefined ||
            input.resourceSelections !== undefined ||
            input.pastedTextSelections !== undefined ||
            input.structuredContent !== undefined ||
            input.thinkingSelection !== undefined)) ||
        (input.resourceSelections !== undefined && input.input === undefined) ||
        (input.pastedTextSelections !== undefined && input.input === undefined) ||
        (input.structuredContent !== undefined &&
          (input.input === undefined ||
            (input.resourceSelections === undefined &&
              input.pastedTextSelections === undefined))) ||
        input.input?.inputResources !== undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      let effectiveRunId =
        input.resourceSelections === undefined && input.pastedTextSelections === undefined
          ? input.runId
          : (input.runId ?? randomUUID());
      let effectiveInput = input.input;
      disarmMcpIdle(input.sessionId);
      await waitForMcpIdleOperation(input.sessionId);
      const continued = await withOwner(async (parentRoot) => {
        if (
          options.managedAgentTools !== undefined &&
          !(
            options.managedAgentTools === "managed-agent-tools.a2-long-lived.v1" &&
            activeAgentManagers.has(input.sessionId)
          )
        ) {
          await recoverInterruptedManagedAgents(
            managedAgentStore,
            managedChildSessionStores,
            createLazyArtifactStore(
              join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
            ),
            input.sessionId,
          );
        }
        const workspaceTrusted = (await inspectWorkspaceTrust()).status === "trusted";
        const artifactCache = createArtifactMaterializationCache();
        const resumed = await resumeSession({ sessionId: input.sessionId }, artifactCache);
        if (resumed.status === "rejected") {
          if (resumed.error.code === "model_target_incompatible") {
            throw new SessionLifecycleError("session_model_target_incompatible");
          }
          if (resumed.error.code === "model_target_unavailable") {
            throw new SessionLifecycleError("session_model_target_unavailable");
          }
          throw new SessionLifecycleError("session_invalid");
        }
        if (
          resumed.snapshot.status === "settled" &&
          effectiveInput === undefined &&
          input.planApproval === undefined
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (resumed.snapshot.mcp?.status === "mcp_shutdown_unconfirmed") {
          throw new SessionLifecycleError("mcp_shutdown_unconfirmed");
        }
        if (
          (resumed.snapshot.status === "idle" || resumed.snapshot.status === "settled") &&
          resumed.snapshot.mcp !== undefined &&
          resumed.snapshot.mcp.status !== "workspace_confirmation_required" &&
          resumed.snapshot.mcp.status !== "profile_committed" &&
          resumed.snapshot.mcp.status !== "profile_reactivation_required" &&
          !(
            resumed.snapshot.mcp.status === "activation_required" &&
            resumed.snapshot.mcp.activation?.status === "cancelled"
          )
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (resumed.snapshot.status === "interrupted" && effectiveInput !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const artifactRoot = join(effectiveSessionStateRoot(options.stateRoot), "artifacts");
        const artifactStore = await createFileArtifactStore({ root: artifactRoot });
        let planRevision: PlanRevisionIntentV1 | undefined;
        let planApproval: PlanApprovalIntentV1 | undefined;
        let approvedSubmission: PlanSubmissionSnapshotV1 | undefined;
        let approvedPlan: ApprovedPlanProjectionV1 | undefined;
        let runtimePlan = resumed.snapshot.plan;
        if (input.planApproval !== undefined) {
          const currentPlan = resumed.snapshot.plan;
          if (
            currentPlan === undefined ||
            currentPlan.state === "exploring" ||
            input.planApproval.cycleId !== currentPlan.cycleId ||
            input.planApproval.revision !== currentPlan.revision ||
            input.planApproval.planId !== currentPlan.submission.planId ||
            input.planApproval.contentDigest !== currentPlan.submission.contentDigest
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          approvedSubmission = currentPlan.submission;
          if (currentPlan.state === "ready") {
            planApproval = {
              sessionId: input.sessionId,
              commandId: input.planApproval.commandId,
              kickoffRunId: randomUUID(),
              cycleId: currentPlan.cycleId,
              revision: currentPlan.revision,
              planId: currentPlan.submission.planId,
              contentDigest: currentPlan.submission.contentDigest,
              policyVersion: currentPlan.policyVersion,
              toolProfileDigest: currentPlan.eligibleToolProfile.digest,
            };
            approvedPlan = await materializeApprovedPlanProjection(
              artifactStore,
              planApproval,
              approvedSubmission,
            );
            const sequence = resumed.snapshot.lastSequence + 1;
            const approvalStore = await openSessionStore(options, input.sessionId);
            await approvalStore.append({
              schemaVersion: 3,
              sequence,
              record: { type: "plan_approval_intent", recordVersion: 1, ...planApproval },
            });
            await options[planApprovalIntentBarrier]?.afterDurableRecord({
              ...planApproval,
              sequence,
            });
          } else {
            if (input.planApproval.commandId !== currentPlan.approval.commandId) {
              throw new SessionLifecycleError("session_invalid");
            }
            planApproval = currentPlan.approval;
            approvedPlan = await materializeApprovedPlanProjection(
              artifactStore,
              planApproval,
              approvedSubmission,
            );
          }
          effectiveRunId = planApproval.kickoffRunId;
          effectiveInput = { text: "Implement the approved plan." };
          runtimePlan = undefined;
        } else if (input.planRevision !== undefined) {
          const ready = resumed.snapshot.plan;
          if (
            effectiveInput === undefined ||
            ready?.state !== "ready" ||
            input.planRevision.cycleId !== ready.cycleId ||
            input.planRevision.revision !== ready.revision ||
            input.planRevision.planId !== ready.submission.planId ||
            input.planRevision.contentDigest !== ready.submission.contentDigest
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          planRevision = {
            cycleId: ready.cycleId,
            fromRevision: ready.revision,
            toRevision: ready.revision + 1,
            planId: ready.submission.planId,
            contentDigest: ready.submission.contentDigest,
          };
          const { submission: _submission, ...withoutSubmission } = ready;
          runtimePlan = {
            ...withoutSubmission,
            state: "exploring",
            revision: planRevision.toRevision,
          };
        } else if (resumed.snapshot.plan?.state === "ready" && effectiveInput !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (options.modelTargets === undefined) {
          throw new SessionLifecycleError("session_model_target_unavailable");
        }
        let records = await readSessionRecords(options, input.sessionId);
        const first = records[0];
        if (first === undefined || !isGenesisRecord(first)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const preparedAdmission = preparedAdmissionTargets.get(input.sessionId);
        let resolved =
          preparedAdmission !== undefined && preparedAdmission.runId === input.runId
            ? preparedAdmission.resolved
            : await options.modelTargets.resolve({
                targetId: resumed.snapshot.targetIdentity.targetId,
                targetIdentity: resumed.snapshot.targetIdentity,
                allowExperimental: resumed.snapshot.targetIdentity.certification === "experimental",
                signal: input.signal ?? new AbortController().signal,
              });
        if (preparedAdmission === undefined || preparedAdmission.runId !== input.runId) {
          resolved = {
            ...resolved,
            contextProfile: historicalContextProfile(
              first,
              resumed.snapshot.context?.profile,
              resolved.contextProfile,
            ),
          };
        }
        if (
          !sameModelTargetIdentity(resolved.identity, resumed.snapshot.targetIdentity) ||
          !modelTargetUsesContextProfile(
            resumed.snapshot.targetIdentity,
            resolved.contextProfile,
          ) ||
          !isContextProfileSupported(resolved.contextProfile)
        ) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        if (effectiveInput === undefined && input.thinkingSelection !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const newRunThinkingPolicy =
          effectiveInput === undefined
            ? undefined
            : preparedAdmission !== undefined && preparedAdmission.runId === input.runId
              ? preparedAdmission.thinkingPolicy
              : resolveRunThinkingPolicy(resolved, input.thinkingSelection);
        const persistedPromptContext = promptContextRecordFromRecords(first, records);
        let committedMcpProfile: McpToolProfileV1 | undefined;
        if (
          persistedPromptContext?.recordVersion === 3 &&
          persistedPromptContext.mcp !== undefined
        ) {
          const profile = requireMcpCommittedProfile(
            await mcpCommittedProfileFromLineage(lineage, first, records),
            persistedPromptContext,
          );
          committedMcpProfile = profile;
          if (
            workspaceTrusted &&
            mcpHost.snapshot(input.sessionId)?.profile?.digest !== profile.digest
          ) {
            const mcp = resumed.snapshot.mcp;
            const selectedServers = profile.servers.map((profileServer) => {
              const server = mcp?.servers.find(
                (candidate) =>
                  candidate.serverId === profileServer.serverId &&
                  candidate.definitionDigest === profileServer.definitionDigest &&
                  candidate.status === "approved",
              );
              if (server === undefined) {
                throw new SessionLifecycleError("session_invalid");
              }
              return server;
            });
            const generationId = randomUUID();
            const attempt =
              records.reduce(
                (maximum, entry) =>
                  entry.schemaVersion === 3 && entry.record.type === "mcp_activation_started"
                    ? Math.max(maximum, entry.record.attempt)
                    : maximum,
                0,
              ) + 1;
            const reactivationStore = await openSessionStore(options, input.sessionId);
            const nextSequence = (records.at(-1)?.sequence ?? 0) + 1;
            await reactivationStore.append({
              schemaVersion: 3,
              sequence: nextSequence,
              record: {
                type: "mcp_activation_started",
                recordVersion: 1,
                generationId,
                attempt,
                reason: "idle_reactivate",
                servers: selectedServers.map((server) => ({
                  serverId: server.serverId,
                  definitionDigest: server.definitionDigest,
                  startupEffects: server.startupEffects,
                })),
              },
            });
            let activationPrepared = false;
            let readySettlementDurable = false;
            try {
              const live = await activateWithWorkspaceMcpLease(() =>
                mcpHost.reactivateToolProfile({
                  sessionId: input.sessionId,
                  generationId,
                  attempt,
                  servers: selectedServers,
                  profile,
                }),
              );
              activationPrepared = true;
              await options[mcpActivationSettlementBarrier]?.beforeReadySettlement({
                sessionId: input.sessionId,
                generationId,
              });
              await reactivationStore.append({
                schemaVersion: 3,
                sequence: nextSequence + 1,
                record: {
                  type: "mcp_activation_settled",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  status: "ready",
                  catalogDigest: live.catalog.digest,
                  servers: live.settledServers,
                },
              });
              readySettlementDurable = true;
              mcpHost.commitActivation({
                sessionId: input.sessionId,
                generationId,
                catalogDigest: live.catalog.digest,
              });
              await flushPendingMcpCatalogChanges(input.sessionId);
            } catch (caughtError) {
              if (readySettlementDurable && mcpHost.wasGenerationCancelled(generationId)) {
                throw new SessionLifecycleError("mcp_activation_cancelled");
              }
              const error =
                activationPrepared &&
                !mcpHost.wasGenerationCancelled(generationId) &&
                !(caughtError instanceof McpHostError)
                  ? await closePreparedMcpActivation({
                      sessionId: input.sessionId,
                      generationId,
                      cause: caughtError,
                    })
                  : caughtError;
              const failure =
                error instanceof McpHostError
                  ? {
                      code: error.code,
                      ...(error.serverId === undefined ? {} : { serverId: error.serverId }),
                    }
                  : { code: "mcp_start_failed" as const };
              const closedServers = error instanceof McpHostError ? error.closedServers : [];
              for (const [index, server] of closedServers.entries()) {
                await reactivationStore.append({
                  schemaVersion: 3,
                  sequence: nextSequence + index + 1,
                  record: {
                    type: "mcp_server_closed",
                    recordVersion: 1,
                    generationId,
                    attempt,
                    serverId: server.serverId,
                    definitionDigest: server.definitionDigest,
                    reason:
                      failure.serverId === undefined
                        ? "stale"
                        : server.serverId === failure.serverId
                          ? "failed"
                          : "peer_failure",
                  },
                });
              }
              await reactivationStore.append({
                schemaVersion: 3,
                sequence: nextSequence + closedServers.length + 1,
                record: {
                  type: "mcp_activation_settled",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  status: "failed",
                  servers: [],
                  error: failure,
                },
              });
              throw new SessionLifecycleError(failure.code);
            }
            records = await readSessionRecords(options, input.sessionId);
          }
        }
        const artifactInspection = await materializeModelResponseArtifacts(
          options,
          first,
          records,
          { allowDegraded: false },
          artifactCache,
        );
        const replayRecords = [...artifactInspection.records];
        let activePromptContext = promptContextRecordFromRecords(first, replayRecords);
        let activeSkillContext = skillContextRecordFromRecords(first, replayRecords);
        const extensionSources = await resolveExtensionSkillSources(options);
        if (hasSkillPromptContext(activePromptContext) && activeSkillContext !== undefined) {
          const reconciled = reconcileExtensionSkillContextV1({
            context: activeSkillContext,
            currentSources: extensionSources,
          });
          if (reconciled.context !== activeSkillContext) {
            const nextPromptContext = replacePromptSkillsV2(
              activePromptContext,
              reconciled.context,
            );
            const reconciliationStore = await openSessionStore(options, input.sessionId);
            let nextSequence = (records.at(-1)?.sequence ?? 0) + 1;
            const catalogRecord: SessionRecord = {
              schemaVersion: 3,
              sequence: nextSequence,
              record: {
                type: "skill_catalog_committed",
                recordVersion: 1,
                previousRevision: activeSkillContext.registry.revision,
                previousRegistryDigest: activeSkillContext.registry.digest,
                skillContext: reconciled.context,
                assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
                reason: "extension_reconciliation",
              },
            };
            await reconciliationStore.append(catalogRecord);
            replayRecords.push(catalogRecord);
            nextSequence += 1;
            for (const revocation of reconciled.revoked) {
              const revocationRecord: SessionRecord = {
                schemaVersion: 3,
                sequence: nextSequence,
                record: {
                  type: "skill_revoked",
                  recordVersion: 1,
                  catalogRevision: reconciled.context.catalog.revision,
                  activationIndex: revocation.activationIndex,
                  qualifiedId: revocation.qualifiedId,
                  reason: revocation.reason,
                  sourceEpoch: revocation.sourceEpoch,
                },
              };
              await reconciliationStore.append(revocationRecord);
              replayRecords.push(revocationRecord);
              nextSequence += 1;
            }
            activePromptContext = nextPromptContext;
            activeSkillContext = reconciled.context;
          }
        }
        const activeSkillContents = await materializeActiveSkillContents(
          options,
          activeSkillContext,
        );
        const todo =
          activePromptContext !== undefined &&
          hasTodoToolProfileV1(activePromptContext.toolProfile.definitions)
            ? todoStoreSnapshotFromRecordsV1(replayRecords)
            : undefined;
        const referencedModelResponseArtifactBytes = await replayArtifactBytesFromLineage(
          options,
          lineage,
          first,
          records,
          artifactCache,
        );
        const skillResourceLineageBytes = await skillResourceBytesFromLineage(
          lineage,
          first,
          replayRecords,
        );
        const inputResourceLineageBytes = await inputResourceBytesFromLineage(
          lineage,
          first,
          replayRecords,
        );
        const visibleInputResources = await inputResourcesFromLineage(
          lineage,
          first,
          replayRecords,
        );
        await validateCompactionInputResources(lineage, first, replayRecords);
        validateInputResourceReadLineage(replayRecords, visibleInputResources);
        const [inheritedMessages, inheritedEvidence] = await Promise.all([
          createBranchMessages(options, lineage, records, artifactCache),
          lineage.createInheritedContextEvidence(records),
        ]);
        const resumeState =
          resumed.snapshot.status === "interrupted"
            ? createAgentResumeState(replayRecords, options, resumed.snapshot)
            : undefined;
        if (resumeState !== undefined && planApproval === undefined) {
          const kickoffRecord = replayRecords.findLast(
            (record) =>
              record.schemaVersion === 3 &&
              record.record.type === "logical_run_started" &&
              record.record.runId === resumeState.agentState.runId &&
              record.record.planKickoff !== undefined,
          );
          const recoveredKickoff =
            kickoffRecord?.schemaVersion === 3 &&
            kickoffRecord.record.type === "logical_run_started"
              ? kickoffRecord.record.planKickoff
              : undefined;
          if (recoveredKickoff !== undefined) {
            const recoveredSubmission = planSubmissionForApproval(replayRecords, recoveredKickoff);
            if (recoveredSubmission === undefined) {
              throw new SessionLifecycleError("session_invalid");
            }
            planApproval = recoveredKickoff;
            approvedSubmission = recoveredSubmission;
            runtimePlan = undefined;
          }
        }
        const recoveredThinkingPolicy =
          resumeState?.thinkingPolicy === undefined
            ? undefined
            : requireRecoveredThinkingPolicy(resolved, resumeState.thinkingPolicy);
        if (
          effectiveRunId !== undefined &&
          (effectiveInput === undefined ||
            resumeState !== undefined ||
            replayRecords.some(
              (record) =>
                record.schemaVersion === 3 &&
                "runId" in record.record &&
                record.record.runId === effectiveRunId,
            ))
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const ownMessages =
          resumeState === undefined ? modelMessagesFromCompleteRecords(replayRecords) : [];
        const initialMessages = replayRecords.some(
          (record) =>
            record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
        )
          ? ownMessages
          : [...inheritedMessages, ...ownMessages];
        const durableResumeState =
          resumeState === undefined
            ? undefined
            : {
                ...resumeState.agentState,
                messages: [...inheritedMessages, ...resumeState.agentState.messages],
              };
        if (resumeState === undefined && effectiveInput === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const store = await openSessionStore(options, input.sessionId);
        const durableOutputLimits = (
          options as SessionLifecycleOptions & {
            readonly [sessionDurableOutputLimits]?: AgentSessionDurableOutputLimits;
          }
        )[sessionDurableOutputLimits];
        if (
          approvedPlan === undefined &&
          planApproval !== undefined &&
          approvedSubmission !== undefined
        ) {
          approvedPlan = await materializeApprovedPlanProjection(
            artifactStore,
            planApproval,
            approvedSubmission,
          );
        }
        await validateVisibleInputResourceArtifacts(artifactStore, visibleInputResources);
        const inputResources =
          input.resourceSelections === undefined
            ? []
            : await ingestLocalInputResourcesV1({
                artifactRoot,
                artifactStore,
                ...(options[inputResourceIngestBarrier]?.afterResolved === undefined
                  ? {}
                  : { afterResolved: options[inputResourceIngestBarrier].afterResolved }),
                ...(options[inputResourceIngestBarrier]?.afterOpened === undefined
                  ? {}
                  : { afterOpened: options[inputResourceIngestBarrier].afterOpened }),
                runId: effectiveRunId as string,
                selections: input.resourceSelections,
                signal: input.signal ?? new AbortController().signal,
              });
        const pastedTextMaterialization =
          input.pastedTextSelections === undefined
            ? { occurrences: [], contents: new Map<string, string>() }
            : await promotePastedTextSelectionsV1({
                artifactRoot,
                artifactStore,
                projectId: first.record.projectId,
                sessionId: input.sessionId,
                runId: effectiveRunId as string,
                selections: input.pastedTextSelections,
                signal: input.signal ?? new AbortController().signal,
              });
        input.signal?.throwIfAborted();
        const runInput =
          effectiveInput === undefined ||
          (inputResources.length === 0 && pastedTextMaterialization.occurrences.length === 0)
            ? effectiveInput
            : {
                ...effectiveInput,
                inputResources,
                pastedTexts: pastedTextMaterialization.occurrences,
                pastedTextContents: pastedTextMaterialization.contents,
                ...(input.structuredContent === undefined
                  ? {}
                  : {
                      userContent: materializeSessionUserContentV1({
                        elements: input.structuredContent,
                        occurrences: inputResources,
                        pastedTexts: pastedTextMaterialization.occurrences,
                        userMessage: effectiveInput.text,
                      }),
                    }),
              };
        const runtimeInputResources = [...visibleInputResources, ...inputResources];
        if (runtimeInputResources.length > inputResourceLimitsV1.maximumOccurrencesPerLineage) {
          throw new InputResourceError(
            "input_resource_count_exceeded",
            "The selected input resources exceed the v1 session-lineage occurrence limit.",
          );
        }
        const runtimeInputResourceBytes = runtimeInputResources.reduce(
          (total, occurrence) => total + occurrence.artifact.byteCount,
          0,
        );
        if (
          !Number.isSafeInteger(runtimeInputResourceBytes) ||
          runtimeInputResourceBytes > inputResourceLimitsV1.maximumAggregateBytesPerLineage
        ) {
          throw new InputResourceError(
            "input_resource_aggregate_too_large",
            "The selected input resources exceed the v1 session-lineage aggregate byte limit.",
          );
        }
        const effectiveThinkingPolicy = recoveredThinkingPolicy ?? newRunThinkingPolicy;
        const sessionTools = toolsForSession(
          input.sessionId,
          resumed.snapshot.targetIdentity,
          effectiveThinkingPolicy,
          first.record.managedAgentTools,
        );
        const sessionDependencies = {
          artifactStore,
          model: resolved.driver,
          store: store as unknown as SessionStore,
          ...(first.record.managedAgentTools !== "managed-agent-tools.a2-long-lived.v1"
            ? {}
            : {
                [managedAgentPromptSummary]: () =>
                  activeAgentManagers.get(input.sessionId)?.promptSummary() ??
                  "Managed agents: 0 active, 0 completed, 0 need attention; IDs: ",
              }),
          [sessionDurableContext]: {
            ...(initialMessages.length === 0 ? {} : { hasInheritedMessages: true }),
            nextSequence: (replayRecords.at(-1)?.sequence ?? resumed.snapshot.lastSequence) + 1,
            ...(effectiveRunId === undefined ? {} : { newRunId: effectiveRunId }),
            ...(runtimeInputResources.length === 0
              ? {}
              : { inputResources: runtimeInputResources }),
            projectId: resumed.snapshot.projectId,
            ...(approvedPlan === undefined ? {} : { approvedPlan }),
            ...(planApproval === undefined ? {} : { planKickoff: planApproval }),
            ...(runtimePlan === undefined ? {} : { plan: runtimePlan }),
            ...(planRevision === undefined ? {} : { planRevision }),
            ...(todo === undefined ? {} : { todo }),
            referencedModelResponseArtifactBytes,
            skillResourceLineageBytes,
            inputResourceLineageBytes,
            ...(resumeState === undefined
              ? {}
              : {
                  inputResourceRunBytes: inputResourceBytesForRun(
                    replayRecords,
                    resumeState.agentState.runId,
                  ),
                  skillResourceRunBytes: skillResourceBytesForRun(
                    replayRecords,
                    resumeState.agentState.runId,
                  ),
                }),
            ...(activePromptContext === undefined
              ? {}
              : {
                  repositoryWorkspaceRoot: options.workspaceRoot,
                  authorizeProjectContextLoad: async () =>
                    (await inspectWorkspaceTrust()).status === "trusted",
                }),
            sessionId: resumed.snapshot.sessionId,
            ...(options[sessionLogicalRunStartedBarrier] === undefined &&
            preparedAdmission?.onAdmitted === undefined
              ? {}
              : {
                  afterLogicalRunStarted: async (started: {
                    readonly sessionId: string;
                    readonly runId: string;
                    readonly sequence: number;
                  }) => {
                    try {
                      preparedAdmission?.onAdmitted?.(started);
                    } catch {
                      // Admission observers cannot change an already durable logical input.
                    }
                    await options[sessionLogicalRunStartedBarrier]?.afterDurableRecord(started);
                  },
                }),
            targetIdentity: resumed.snapshot.targetIdentity,
            ...((recoveredThinkingPolicy ?? newRunThinkingPolicy) === undefined
              ? {}
              : { thinkingPolicy: recoveredThinkingPolicy ?? newRunThinkingPolicy }),
            ...(activePromptContext === undefined ? {} : { promptContext: activePromptContext }),
            ...(activeSkillContext === undefined ? {} : { skillContext: activeSkillContext }),
            ...(extensionSources.length === 0 ? {} : { extensionSkillSources: extensionSources }),
            ...(preparedAdmission === undefined
              ? {}
              : {
                  preparedExplicitSkillManifests: preparedAdmission.skillManifests,
                  preparedExplicitSkillPolicies: preparedAdmission.skillPolicies,
                }),
            ...(options.extensionHost === undefined
              ? {}
              : {
                  withCurrentExtensionSkillSources: <T>(
                    sources: readonly ExtensionSkillSourceV1[],
                    operation: () => Promise<T>,
                  ) =>
                    withInternalExtensionSkillSourcesCurrent(
                      options.extensionHost as ExtensionHost,
                      sources.map((source) => ({
                        extensionId: source.locator.extensionId,
                        packageName: source.locator.packageName,
                        packageVersion: source.locator.packageVersion,
                        lifecycleRevision: source.lifecycleRevision,
                        lifecycleDigest: source.lifecycleDigest,
                      })),
                      operation,
                    ),
                }),
            ...(activeSkillContents.size === 0 ? {} : { activeSkillContents }),
            ...(inheritedEvidence === undefined ? {} : { inheritedEvidence }),
            ...(resumeState !== undefined || initialMessages.length === 0
              ? {}
              : { initialMessages }),
            ...(durableResumeState === undefined ? {} : { resume: durableResumeState }),
          },
          contextProfile: resolved.contextProfile,
          ...(resolved.modalityProfile === undefined
            ? {}
            : { modalityProfile: resolved.modalityProfile }),
          ...(durableOutputLimits === undefined
            ? {}
            : { [sessionDurableOutputLimits]: durableOutputLimits }),
          tools: bindInputResourceToolRegistry(
            activePromptContext?.recordVersion === 3 && activePromptContext.mcp !== undefined
              ? combineToolRegistries(
                  sessionTools,
                  workspaceTrusted
                    ? mcpHost.toolRegistry(
                        input.sessionId,
                        requireMcpCommittedProfile(committedMcpProfile, activePromptContext),
                        artifactStore,
                      )
                    : mcpProfileDefinitionRegistry(
                        requireMcpCommittedProfile(committedMcpProfile, activePromptContext),
                      ),
                )
              : sessionTools,
            { artifactStore, occurrences: runtimeInputResources },
          ),
          ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        };
        const existingAgentManager = activeAgentManagers.get(input.sessionId);
        const agentManager =
          first.record.managedAgentTools === "managed-agent-tools.a2-long-lived.v1" &&
          existingAgentManager !== undefined
            ? existingAgentManager
            : createAgentManager({
                artifactStore,
                childContextProfile: resolved.contextProfile,
                childModel: resolved.driver,
                childSessionStores: managedChildSessionStores,
                managedStore: managedAgentStore,
                parentPermissions:
                  options.permissions ?? createPermissionPolicy({ allowedEffects: [] }),
                parentRoot,
                parentSessionId: input.sessionId,
                projectId: resumed.snapshot.projectId as `sha256:${string}`,
                ...(activePromptContext === undefined
                  ? {}
                  : { repository: activePromptContext.repository }),
                targetIdentity: resumed.snapshot.targetIdentity,
                ...(effectiveThinkingPolicy === undefined
                  ? {}
                  : { thinkingPolicy: effectiveThinkingPolicy }),
                workspaceRoot: options.workspaceRoot,
              });
        agentManager.rebindParentRoot(parentRoot);
        await agentManager.snapshot();
        const session = new AgentSession(sessionDependencies);
        let resolveSessionSettlement = () => {};
        const sessionSettlement = new Promise<void>((resolve) => {
          resolveSessionSettlement = resolve;
        });
        const unsubscribe = session.subscribe((event) => {
          for (const listener of listeners) {
            listener(event);
          }
        });
        const unsubscribeNotifications = session.subscribeNotifications((notification) => {
          if (notification.sessionId === null || notification.runId === null) {
            return;
          }
          const sessionNotification: SessionRuntimeNotification = {
            ...notification,
            sessionId: notification.sessionId,
            runId: notification.runId,
          };
          const projected = options[sessionRuntimeNotificationTransform]?.project(
            sessionNotification,
          ) ?? [sessionNotification];
          for (const notification of projected) {
            for (const listener of sessionEventListeners) {
              listener(notification);
            }
          }
        });
        activeSession = session;
        activeSessionSettlement = sessionSettlement;
        if (first.record.managedAgentTools !== undefined) {
          activeAgentManagers.set(input.sessionId, agentManager);
        }
        try {
          const runLimits = resumeState?.limits ?? input.limits;
          const result = await session.run(runInput ?? { text: resumeState?.userMessage ?? "" }, {
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(runLimits === undefined ? {} : { limits: runLimits }),
          });
          await flushPendingMcpCatalogChanges(input.sessionId);
          const snapshot = await inspectSession({ sessionId: input.sessionId }, artifactCache);
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return { result, snapshot };
        } finally {
          if (first.record.managedAgentTools !== "managed-agent-tools.a2-long-lived.v1") {
            activeAgentManagers.delete(input.sessionId);
          }
          resolveSessionSettlement();
          if (activeSession === session) {
            activeSession = undefined;
          }
          if (activeSessionSettlement === sessionSettlement) {
            activeSessionSettlement = undefined;
          }
          unsubscribe();
          unsubscribeNotifications();
          const mcpThroughSequence = pendingMcpMetadataThrough.get(input.sessionId);
          if (mcpThroughSequence !== undefined) {
            pendingMcpMetadataThrough.delete(input.sessionId);
            await publishMetadata({
              type: "mcp_configuration_changed",
              sessionId: input.sessionId,
              throughSequence: mcpThroughSequence,
            });
          }
          const live = mcpHost.snapshot(input.sessionId);
          if (live?.profile !== undefined) {
            armMcpIdle(input.sessionId, live.activation.generationId);
          }
        }
      }, `session:${input.sessionId}`);
      const titleSnapshot = await startAutomaticTitle(
        input.sessionId,
        continued.snapshot,
        continued.result.status === "completed" && continued.result.answer.length > 0,
      );
      return titleSnapshot === undefined ? continued : { ...continued, snapshot: titleSnapshot };
    },
    async configureWorkspaceTrust(command) {
      if (activeSession !== undefined || options.workspaceTrust === undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (command.type === "revoke") {
        for (const timer of mcpIdleTimers.values()) {
          timer.cancel();
        }
        mcpIdleTimers.clear();
        await Promise.allSettled(mcpIdleOperations.values());
        await Promise.allSettled(pendingMcpCatalogDurability.values());
        await Promise.allSettled(activeMcpConfigurationOperations.values());
      }
      return withOwner(async () => {
        const current = await inspectWorkspaceTrust();
        if (
          current.projectId === null ||
          current.projectId !== command.projectId ||
          current.diagnostic !== null
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (command.type === "revoke") {
          const closed = await mcpHost.closeWorkspaceSessions();
          if (closed.status !== "closed") {
            throw new SessionLifecycleError("mcp_shutdown_unconfirmed");
          }
          await releaseWorkspaceMcpLeaseIfIdle();
        }
        const snapshot = await options.workspaceTrust?.setTrusted({
          projectId: command.projectId,
          trusted: command.type === "grant",
        });
        if (snapshot === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "updated", snapshot };
      });
    },
    async configureMcp(command) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      await requireTrustedWorkspace();
      await pendingMcpCatalogDurability.get(command.sessionId);
      if (command.type === "cancel_configuration") {
        const before = await inspectSession({ sessionId: command.sessionId });
        const beforeMcp = before.schemaVersion === 3 ? before.mcp : undefined;
        const activation =
          beforeMcp?.workspaceConfirmed === true ? beforeMcp.activation : undefined;
        if (
          before.schemaVersion !== 3 ||
          (before.status !== "idle" && before.status !== "settled") ||
          activation?.generationId !== command.generationId ||
          (activation.status !== "activating" && activation.status !== "ready")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const closed = await mcpHost.closeSession({
          sessionId: command.sessionId,
          generationId: command.generationId,
        });
        await activeMcpConfigurationOperations.get(command.generationId);
        if (closed.status !== "closed") {
          throw new SessionLifecycleError("mcp_shutdown_unconfirmed");
        }
        await releaseWorkspaceMcpLeaseIfIdle();
        return withOwner(async () => {
          await requireTrustedWorkspace();
          const inspected = await inspectSession({ sessionId: command.sessionId });
          if (inspected.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          if (closed.servers.length > 0) {
            const store = await openSessionStore(options, command.sessionId);
            for (const [index, server] of closed.servers.entries()) {
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + index + 1,
                record: {
                  type: "mcp_server_closed",
                  recordVersion: 1,
                  generationId: command.generationId,
                  attempt: closed.attempt,
                  serverId: server.serverId,
                  definitionDigest: server.definitionDigest,
                  reason: "session_close",
                },
              });
            }
          }
          const snapshot = await inspectSession({ sessionId: command.sessionId });
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return { status: "updated" as const, snapshot };
        });
      }
      if (command.type === "revalidate_catalog") {
        disarmMcpIdle(command.sessionId);
        await waitForMcpIdleOperation(command.sessionId);
      }
      let ownerOperation!: Promise<McpConfigurationResult>;
      ownerOperation = withOwner(async () => {
        await requireTrustedWorkspace();
        await flushPendingMcpCatalogChanges(command.sessionId);
        const inspected = await inspectSession({ sessionId: command.sessionId });
        if (
          inspected.schemaVersion !== 3 ||
          (inspected.status !== "idle" && inspected.status !== "settled")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const store = await openSessionStore(options, command.sessionId);
        if (command.type === "confirm_workspace") {
          if (
            inspected.mcp === undefined ||
            inspected.mcp.workspaceConfirmed ||
            inspected.mcp.source.digest !== command.sourceDigest
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          await store.append({
            schemaVersion: 3,
            sequence: inspected.lastSequence + 1,
            record: {
              type: "mcp_workspace_confirmed",
              recordVersion: 1,
              sourceDigest: command.sourceDigest,
              canonicalizerVersion: 1,
            },
          });
        } else if (command.type === "approve_server") {
          const server = inspected.mcp?.servers.find(
            (candidate) => candidate.serverId === command.serverId,
          );
          if (
            inspected.mcp === undefined ||
            !inspected.mcp.workspaceConfirmed ||
            server === undefined ||
            server.status !== "approval_required" ||
            server.definitionDigest !== command.definitionDigest
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          await store.append({
            schemaVersion: 3,
            sequence: inspected.lastSequence + 1,
            record: {
              type: "mcp_server_definition_approved",
              recordVersion: 1,
              sourceDigest: inspected.mcp.source.digest,
              serverId: command.serverId,
              definitionDigest: command.definitionDigest,
            },
          });
        } else if (command.type === "activate_servers") {
          const reactivating = inspected.mcp?.status === "profile_reactivation_required";
          if (
            (inspected.mcp?.status !== "activation_required" && !reactivating) ||
            command.servers.length < 1 ||
            command.servers.length > 4 ||
            new Set(command.servers.map((server) => server.serverId)).size !==
              command.servers.length
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          const selectedServers = command.servers.map((selection) => {
            const server = inspected.mcp?.servers.find(
              (candidate) => candidate.serverId === selection.serverId,
            );
            if (
              server === undefined ||
              server.status !== "approved" ||
              server.definitionDigest !== selection.definitionDigest
            ) {
              throw new SessionLifecycleError("session_invalid");
            }
            return server;
          });
          let reactivationProfile: McpToolProfileV1 | undefined;
          let activationRecords: readonly SessionRecord[] = [];
          if (reactivating) {
            activationRecords = await readSessionRecords(options, command.sessionId);
            const genesis = activationRecords[0];
            if (genesis === undefined || !isGenesisRecord(genesis)) {
              throw new SessionLifecycleError("session_invalid");
            }
            const promptContext = promptContextRecordFromRecords(genesis, activationRecords);
            if (promptContext?.recordVersion !== 3 || promptContext.mcp === undefined) {
              throw new SessionLifecycleError("session_invalid");
            }
            reactivationProfile = requireMcpCommittedProfile(
              await mcpCommittedProfileFromLineage(lineage, genesis, activationRecords),
              promptContext,
            );
            if (
              reactivationProfile.servers.length !== selectedServers.length ||
              reactivationProfile.servers.some(
                (profileServer) =>
                  !selectedServers.some(
                    (server) =>
                      server.serverId === profileServer.serverId &&
                      server.definitionDigest === profileServer.definitionDigest,
                  ),
              )
            ) {
              throw new SessionLifecycleError("session_invalid");
            }
          }
          const generationId = randomUUID();
          const attempt = reactivating
            ? activationRecords.reduce(
                (maximum, entry) =>
                  entry.schemaVersion === 3 && entry.record.type === "mcp_activation_started"
                    ? Math.max(maximum, entry.record.attempt)
                    : maximum,
                0,
              ) + 1
            : 1;
          await store.append({
            schemaVersion: 3,
            sequence: inspected.lastSequence + 1,
            record: {
              type: "mcp_activation_started",
              recordVersion: 1,
              generationId,
              attempt,
              reason: reactivating ? "idle_reactivate" : "initial",
              servers: selectedServers.map((server) => ({
                serverId: server.serverId,
                definitionDigest: server.definitionDigest,
                startupEffects: server.startupEffects,
              })),
            },
          });
          trackMcpConfigurationOperation(generationId, ownerOperation);
          let activationPrepared = false;
          let readySettlementDurable = false;
          try {
            const live = await activateWithWorkspaceMcpLease(() =>
              reactivationProfile === undefined
                ? mcpHost.activate({
                    sessionId: command.sessionId,
                    generationId,
                    attempt,
                    servers: selectedServers,
                  })
                : mcpHost.reactivateToolProfile({
                    sessionId: command.sessionId,
                    generationId,
                    attempt,
                    servers: selectedServers,
                    profile: reactivationProfile,
                  }),
            );
            activationPrepared = true;
            await options[mcpActivationSettlementBarrier]?.beforeReadySettlement({
              sessionId: command.sessionId,
              generationId,
            });
            await store.append({
              schemaVersion: 3,
              sequence: inspected.lastSequence + 2,
              record: {
                type: "mcp_activation_settled",
                recordVersion: 1,
                generationId,
                attempt,
                status: "ready",
                catalogDigest: live.catalog.digest,
                servers: live.settledServers,
              },
            });
            readySettlementDurable = true;
            mcpHost.commitActivation({
              sessionId: command.sessionId,
              generationId,
              catalogDigest: live.catalog.digest,
            });
            await flushPendingMcpCatalogChanges(command.sessionId);
          } catch (caughtError) {
            if (readySettlementDurable && mcpHost.wasGenerationCancelled(generationId)) {
              throw new SessionLifecycleError("mcp_activation_cancelled");
            }
            const error =
              activationPrepared &&
              !mcpHost.wasGenerationCancelled(generationId) &&
              !(caughtError instanceof McpHostError)
                ? await closePreparedMcpActivation({
                    sessionId: command.sessionId,
                    generationId,
                    cause: caughtError,
                  })
                : caughtError;
            if (mcpHost.wasGenerationCancelled(generationId)) {
              const closedServers = error instanceof McpHostError ? error.closedServers : [];
              for (const [index, server] of closedServers.entries()) {
                await store.append({
                  schemaVersion: 3,
                  sequence: inspected.lastSequence + index + 2,
                  record: {
                    type: "mcp_server_closed",
                    recordVersion: 1,
                    generationId,
                    attempt,
                    serverId: server.serverId,
                    definitionDigest: server.definitionDigest,
                    reason: "session_close",
                  },
                });
              }
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + closedServers.length + 2,
                record: {
                  type: "mcp_activation_settled",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  status: "cancelled",
                  servers: [],
                },
              });
              throw new SessionLifecycleError("mcp_activation_cancelled");
            }
            const failure =
              error instanceof McpHostError
                ? {
                    code: error.code,
                    ...(error.serverId === undefined ? {} : { serverId: error.serverId }),
                  }
                : { code: "mcp_start_failed" as const };
            const closedServers = error instanceof McpHostError ? error.closedServers : [];
            for (const [index, server] of closedServers.entries()) {
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + index + 2,
                record: {
                  type: "mcp_server_closed",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  serverId: server.serverId,
                  definitionDigest: server.definitionDigest,
                  reason:
                    failure.serverId === undefined || server.serverId === failure.serverId
                      ? "failed"
                      : "peer_failure",
                },
              });
            }
            await store.append({
              schemaVersion: 3,
              sequence: inspected.lastSequence + closedServers.length + 2,
              record: {
                type: "mcp_activation_settled",
                recordVersion: 1,
                generationId,
                attempt,
                status: "failed",
                servers: [],
                error: failure,
              },
            });
            throw new SessionLifecycleError(failure.code);
          }
        } else if (command.type === "retry_activation") {
          if (
            inspected.mcp?.status !== "activation_failed" ||
            inspected.mcp.activation?.status !== "failed" ||
            inspected.mcp.activation.generationId !== command.generationId
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          const records = await readSessionRecords(options, command.sessionId);
          const failedStart = records.findLast(
            (entry) =>
              entry.schemaVersion === 3 &&
              entry.record.type === "mcp_activation_started" &&
              entry.record.generationId === command.generationId,
          );
          if (
            failedStart?.schemaVersion !== 3 ||
            failedStart.record.type !== "mcp_activation_started"
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          const selectedServers = failedStart.record.servers.map((selection) => {
            const server = inspected.mcp?.servers.find(
              (candidate) =>
                candidate.serverId === selection.serverId &&
                candidate.definitionDigest === selection.definitionDigest &&
                candidate.status === "approved",
            );
            if (server === undefined) {
              throw new SessionLifecycleError("session_invalid");
            }
            return server;
          });
          const generationId = randomUUID();
          const attempt = failedStart.record.attempt + 1;
          await store.append({
            schemaVersion: 3,
            sequence: inspected.lastSequence + 1,
            record: {
              type: "mcp_activation_started",
              recordVersion: 1,
              generationId,
              attempt,
              reason: "explicit_retry",
              servers: selectedServers.map((server) => ({
                serverId: server.serverId,
                definitionDigest: server.definitionDigest,
                startupEffects: server.startupEffects,
              })),
            },
          });
          trackMcpConfigurationOperation(generationId, ownerOperation);
          let activationPrepared = false;
          let readySettlementDurable = false;
          try {
            const live = await activateWithWorkspaceMcpLease(() =>
              mcpHost.activate({
                sessionId: command.sessionId,
                generationId,
                attempt,
                servers: selectedServers,
              }),
            );
            activationPrepared = true;
            await options[mcpActivationSettlementBarrier]?.beforeReadySettlement({
              sessionId: command.sessionId,
              generationId,
            });
            await store.append({
              schemaVersion: 3,
              sequence: inspected.lastSequence + 2,
              record: {
                type: "mcp_activation_settled",
                recordVersion: 1,
                generationId,
                attempt,
                status: "ready",
                catalogDigest: live.catalog.digest,
                servers: live.settledServers,
              },
            });
            readySettlementDurable = true;
            mcpHost.commitActivation({
              sessionId: command.sessionId,
              generationId,
              catalogDigest: live.catalog.digest,
            });
            await flushPendingMcpCatalogChanges(command.sessionId);
          } catch (caughtError) {
            if (readySettlementDurable && mcpHost.wasGenerationCancelled(generationId)) {
              throw new SessionLifecycleError("mcp_activation_cancelled");
            }
            const error =
              activationPrepared &&
              !mcpHost.wasGenerationCancelled(generationId) &&
              !(caughtError instanceof McpHostError)
                ? await closePreparedMcpActivation({
                    sessionId: command.sessionId,
                    generationId,
                    cause: caughtError,
                  })
                : caughtError;
            if (mcpHost.wasGenerationCancelled(generationId)) {
              const closedServers = error instanceof McpHostError ? error.closedServers : [];
              for (const [index, server] of closedServers.entries()) {
                await store.append({
                  schemaVersion: 3,
                  sequence: inspected.lastSequence + index + 2,
                  record: {
                    type: "mcp_server_closed",
                    recordVersion: 1,
                    generationId,
                    attempt,
                    serverId: server.serverId,
                    definitionDigest: server.definitionDigest,
                    reason: "session_close",
                  },
                });
              }
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + closedServers.length + 2,
                record: {
                  type: "mcp_activation_settled",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  status: "cancelled",
                  servers: [],
                },
              });
              throw new SessionLifecycleError("mcp_activation_cancelled");
            }
            const failure =
              error instanceof McpHostError
                ? {
                    code: error.code,
                    ...(error.serverId === undefined ? {} : { serverId: error.serverId }),
                  }
                : { code: "mcp_start_failed" as const };
            const closedServers = error instanceof McpHostError ? error.closedServers : [];
            for (const [index, server] of closedServers.entries()) {
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + index + 2,
                record: {
                  type: "mcp_server_closed",
                  recordVersion: 1,
                  generationId,
                  attempt,
                  serverId: server.serverId,
                  definitionDigest: server.definitionDigest,
                  reason:
                    failure.serverId === undefined || server.serverId === failure.serverId
                      ? "failed"
                      : "peer_failure",
                },
              });
            }
            await store.append({
              schemaVersion: 3,
              sequence: inspected.lastSequence + closedServers.length + 2,
              record: {
                type: "mcp_activation_settled",
                recordVersion: 1,
                generationId,
                attempt,
                status: "failed",
                servers: [],
                error: failure,
              },
            });
            throw new SessionLifecycleError(failure.code);
          }
        } else if (command.type === "revalidate_catalog") {
          if (
            inspected.mcp?.status !== "catalog_stale" ||
            inspected.mcp.activation?.generationId !== command.generationId ||
            inspected.mcp.profile === undefined
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          const records = await readSessionRecords(options, command.sessionId);
          const genesis = records[0];
          if (genesis === undefined || !isGenesisRecord(genesis)) {
            throw new SessionLifecycleError("session_invalid");
          }
          const profile = await mcpCommittedProfileFromLineage(lineage, genesis, records);
          if (profile?.digest !== inspected.mcp.profile.digest) {
            throw new SessionLifecycleError("session_invalid");
          }
          try {
            const prepared = await mcpHost.prepareToolProfileRevalidation({
              sessionId: command.sessionId,
              generationId: command.generationId,
              profile,
            });
            const staleServerIds = mcpStaleCatalogServersFromRecords(
              records,
              prepared.generationId,
              prepared.catalogDigest,
            );
            if (
              prepared.serverIds.length === 0 ||
              prepared.serverIds.some((serverId) => !staleServerIds.has(serverId))
            ) {
              throw new SessionLifecycleError("session_invalid");
            }
            for (const [index, serverId] of prepared.serverIds.entries()) {
              await store.append({
                schemaVersion: 3,
                sequence: inspected.lastSequence + index + 1,
                record: {
                  type: "mcp_catalog_state_changed",
                  recordVersion: 1,
                  generationId: prepared.generationId,
                  serverId,
                  catalogDigest: prepared.catalogDigest,
                  status: "ready",
                  reason: "revalidated",
                },
              });
            }
            mcpHost.commitToolProfileRevalidation({
              sessionId: command.sessionId,
              generationId: prepared.generationId,
              revalidationId: prepared.revalidationId,
              profileDigest: profile.digest,
            });
            armMcpIdle(command.sessionId, command.generationId);
          } catch (error) {
            const live = mcpHost.snapshot(command.sessionId);
            if (live?.profile !== undefined) {
              armMcpIdle(command.sessionId, live.activation.generationId);
            }
            if (error instanceof SessionLifecycleError) {
              throw error;
            }
            throw new SessionLifecycleError("mcp_catalog_invalid");
          }
        } else {
          if (
            inspected.mcp?.status !== "tool_selection_required" ||
            inspected.mcp.activation?.generationId !== command.generationId
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          let profile: McpToolProfileV1;
          try {
            profile = mcpHost.prepareToolProfile({
              sessionId: command.sessionId,
              generationId: command.generationId,
              selections: command.selections,
            });
          } catch {
            throw new SessionLifecycleError("mcp_catalog_invalid");
          }
          const records = await readSessionRecords(options, command.sessionId);
          const genesis = records[0];
          if (genesis === undefined || !isGenesisRecord(genesis)) {
            throw new SessionLifecycleError("session_invalid");
          }
          const activePromptContext = promptContextRecordFromRecords(genesis, records);
          if (activePromptContext?.recordVersion !== 3 || activePromptContext.mcp !== undefined) {
            throw new SessionLifecycleError("session_invalid");
          }
          const nextPromptContext = commitMcpToolProfileV3(activePromptContext, profile);
          await store.append({
            schemaVersion: 3,
            sequence: inspected.lastSequence + 1,
            record: {
              type: "mcp_tool_profile_committed",
              recordVersion: 1,
              profile,
              previousAssemblyIdentityDigest: activePromptContext.assemblyIdentityDigest,
              assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
            },
          });
          mcpHost.commitToolProfile(command.sessionId, profile);
          await flushPendingMcpCatalogChanges(command.sessionId);
          armMcpIdle(command.sessionId, command.generationId);
        }
        const snapshot = await inspectSession({ sessionId: command.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "updated", snapshot };
      });
      return ownerOperation;
    },
    decidePermission(command) {
      return (
        activeSession?.decidePermission(command) ?? {
          status: "rejected",
          error: {
            code: "permission_request_not_pending",
            message: "The permission request is not pending.",
          },
        }
      );
    },
    enableAutomaticTitles() {
      if (!lifecycleClosing) {
        automaticTitlesEnabled = true;
      }
    },
    async ensureAutomaticTitle(input) {
      const snapshot = await inspectSession(input);
      if (snapshot.schemaVersion !== 3) {
        throw new SessionLifecycleError("session_invalid");
      }
      const records = await readSessionRecords(options, input.sessionId);
      const titleSnapshot = await startAutomaticTitle(
        input.sessionId,
        snapshot,
        hasSuccessfullySettledAssistant(records),
      );
      return { status: "updated", snapshot: titleSnapshot ?? snapshot };
    },
    async inspect(input) {
      await prepareSessionInspection(input.sessionId);
      return inspectSession(input);
    },
    async inspectManagedAgents(input) {
      const manager = activeAgentManagers.get(input.sessionId);
      if (manager !== undefined) {
        return manager.snapshot();
      }
      if (options.managedAgentTools === undefined) {
        return { counts: { active: 0, completed: 0, attention: 0 }, agents: [] };
      }
      const session = await inspectSession({ sessionId: input.sessionId });
      if (session.schemaVersion !== 3) {
        throw new SessionLifecycleError("session_invalid");
      }
      const sessionRecords = await readSessionRecords(options, input.sessionId);
      const hasManagedAgentAdmission = sessionRecords.some((record) => {
        const event =
          record.schemaVersion === 1 || record.schemaVersion === 2
            ? record.event
            : record.record.type === "runtime_event"
              ? record.record.event
              : undefined;
        return event?.type === "tool_requested" && event.name === "spawn_agent";
      });
      if (!hasManagedAgentAdmission) {
        return { counts: { active: 0, completed: 0, attention: 0 }, agents: [] };
      }
      if (options.managedAgentTools === "managed-agent-tools.a2-long-lived.v1") {
        try {
          await withOwner(
            async () =>
              recoverInterruptedManagedAgents(
                managedAgentStore,
                managedChildSessionStores,
                createLazyArtifactStore(
                  join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
                ),
                input.sessionId,
              ),
            `session:${input.sessionId}`,
          );
        } catch (error) {
          if (!(error instanceof SessionLifecycleError) || error.code !== "project_in_use") {
            throw error;
          }
        }
      }
      return managedAgentSnapshotFromRecords(await managedAgentStore.read(), input.sessionId);
    },
    async cancelManagedAgent(input) {
      const manager = activeAgentManagers.get(input.sessionId);
      if (manager === undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      const result = await manager.cancel(input);
      if (result.status !== "completed") {
        throw new SessionLifecycleError("session_invalid");
      }
      return manager.snapshot();
    },
    async inspectWorkspaceTrust() {
      return inspectWorkspaceTrust();
    },
    async inspectContextUsage(input) {
      await prepareSessionInspection(input.sessionId);
      return inspectSessionContextUsage(input);
    },
    async getTodo(input) {
      await prepareSessionInspection(input.sessionId);
      const snapshot = await inspectSession({ sessionId: input.sessionId });
      if (snapshot.schemaVersion !== 3 || snapshot.todo === undefined) {
        throw new SessionLifecycleError("session_todo_unavailable");
      }
      const records = await readSessionRecords(options, input.sessionId);
      const todo = todoStoreSnapshotFromRecordsV1(records);
      if (todo.storeRevision !== input.expectedStoreRevision) {
        return { status: "stale" };
      }
      return getTodoV1(todo, { id: input.id });
    },
    async listTodos(input) {
      await prepareSessionInspection(input.sessionId);
      const snapshot = await inspectSession({ sessionId: input.sessionId });
      if (snapshot.schemaVersion !== 3 || snapshot.todo === undefined) {
        throw new SessionLifecycleError("session_todo_unavailable");
      }
      const records = await readSessionRecords(options, input.sessionId);
      const todo = todoStoreSnapshotFromRecordsV1(records);
      if (todo.storeRevision !== input.expectedStoreRevision) {
        return { status: "stale" };
      }
      return listTodosV1(
        todo,
        {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.titleContains === undefined ? {} : { titleContains: input.titleContains }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
        input.sessionId,
      );
    },
    async listProjectSessions(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new SessionLifecycleError("session_invalid");
      }
      const afterSessionId = decodeProjectSessionCatalogCursor(input.cursor);
      const projectId = await canonicalProjectId(options.workspaceRoot);
      const directoryEntries = await storeDirectory.listSessionEntries();
      const catalogEntries: Array<{
        readonly sessionId: string;
        readonly modifiedAtMilliseconds: number;
      }> = [];
      for (const entry of directoryEntries) {
        const records = await readSessionRecords(options, entry.sessionId);
        if (
          records.some((entry) =>
            entry.schemaVersion === 3
              ? entry.record.type === "logical_run_started"
              : entry.event.type === "user_message",
          )
        ) {
          catalogEntries.push(entry);
        }
      }
      catalogEntries.sort(
        (left, right) =>
          right.modifiedAtMilliseconds - left.modifiedAtMilliseconds ||
          (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0),
      );
      const cursorIndex =
        afterSessionId === undefined
          ? -1
          : catalogEntries.findIndex((entry) => entry.sessionId === afterSessionId);
      const start =
        afterSessionId === undefined
          ? 0
          : cursorIndex < 0
            ? catalogEntries.length
            : cursorIndex + 1;
      const selectedIds = catalogEntries
        .slice(start, start + limit)
        .map((entry) => entry.sessionId);
      const items = await Promise.all(
        selectedIds.map((sessionId) => inspectSession({ sessionId })),
      );
      const lastSessionId = selectedIds.at(-1);
      return {
        projectId,
        items,
        nextCursor:
          lastSessionId !== undefined && start + selectedIds.length < catalogEntries.length
            ? encodeProjectSessionCatalogCursor(lastSessionId)
            : null,
      };
    },
    async previewNewSession(input) {
      return withOwner(async () => {
        const projectInputsTrusted = (await inspectWorkspaceTrust()).status === "trusted";
        if (options.modelTargets === undefined) {
          throw new SessionLifecycleError("session_model_target_unavailable");
        }
        const targets = await options.modelTargets.snapshot({
          includeHistoricalProfiles: true,
          signal: input.signal ?? new AbortController().signal,
        });
        const target = targets.targets.find((candidate) =>
          sameModelTargetIdentity(candidate.identity, input.targetIdentity),
        );
        if (target === undefined || target.readiness.status !== "available") {
          throw new SessionLifecycleError("session_model_target_unavailable");
        }
        if (
          !modelTargetUsesContextProfile(input.targetIdentity, target.contextProfile) ||
          !isContextProfileSupported(target.contextProfile)
        ) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        let contextProfile = target.contextProfile;
        if (options.preferences !== undefined) {
          try {
            contextProfile = await options.preferences.resolveContextProfile(target.contextProfile);
          } catch {
            throw new SessionLifecycleError("session_user_configuration_invalid");
          }
        }
        const projectId = await canonicalProjectId(options.workspaceRoot);
        const extensionSources = await resolveExtensionSkillSources(options);
        const skillContext = await createInitialSkillContextV1({
          artifactStore: createStagedArtifactStore(),
          effectiveContextTokens: contextProfile.contextWindowTokens,
          estimatorVersion: contextProfile.estimatorVersion,
          projectId,
          sessionId: randomUUID(),
          userHome: homedir(),
          workspaceRoot: options.workspaceRoot,
          extensionSources,
          includeProjectSources: projectInputsTrusted,
        });
        return {
          targetIdentity: input.targetIdentity,
          contextProfile,
          skillContext: skillContextSnapshot(skillContext),
        };
      });
    },
    async reloadRepositoryInstructions(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        await requireTrustedWorkspace();
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (
          inspected.schemaVersion !== 3 ||
          inspected.status !== "idle" ||
          inspected.promptContext === undefined
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const genesis = records[0];
        if (genesis === undefined || !isGenesisRecord(genesis)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const context = promptContextRecordFromRecords(genesis, records);
        if (context === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const store = await openSessionStore(options, input.sessionId);
        let repository: PromptContextRecordV1["repository"];
        try {
          repository = await loadRepositoryInstructions({
            workspaceRoot: options.workspaceRoot,
            activeScopes: context.repository.activeScopes,
            revision: context.repository.revision + 1,
            loadReason: "explicit_reload",
          });
        } catch (error) {
          await store.append({
            schemaVersion: 3,
            sequence: records.length + 1,
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
            },
          });
          const snapshot = await inspectSession({ sessionId: input.sessionId });
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return {
            status: "rejected",
            snapshot,
            error: {
              code: "repository_instructions_unavailable",
              message: "Repository instructions could not be reloaded safely.",
            },
          };
        }
        if (repository.effectiveDigest === context.repository.effectiveDigest) {
          return { status: "unchanged", snapshot: inspected };
        }
        const nextContext = replacePromptRepositoryV1(context, repository);
        await store.append({
          schemaVersion: 3,
          sequence: records.length + 1,
          record: {
            type: "repository_instructions_committed",
            recordVersion: 1,
            previousRevision: context.repository.revision,
            previousEffectiveDigest: context.repository.effectiveDigest,
            repository,
            assemblyIdentityDigest: nextContext.assemblyIdentityDigest,
          },
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "reloaded", snapshot };
      });
    },
    async reloadSkills(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        await requireTrustedWorkspace();
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (inspected.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (
          inspected.status !== "idle" ||
          (inspected.promptContext?.profileVersion !== 2 &&
            inspected.promptContext?.profileVersion !== 3) ||
          inspected.skillContext === undefined
        ) {
          return {
            status: "rejected",
            snapshot: inspected,
            error: {
              code: "skill_reload_not_idle",
              message: "Agent Skills can be reloaded only in a clean idle session.",
            },
          };
        }
        const records = await readSessionRecords(options, input.sessionId);
        const genesis = records[0];
        if (genesis === undefined || !isGenesisRecord(genesis)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const promptContext = promptContextRecordFromRecords(genesis, records);
        const skillContext = skillContextRecordFromRecords(genesis, records);
        if (!hasSkillPromptContext(promptContext) || skillContext === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        let nextSkillContext: SkillContextRecordV1;
        try {
          nextSkillContext = await reloadSkillContextV1({
            artifactStore: createLazyArtifactStore(
              join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
            ),
            context: skillContext,
            projectId: inspected.projectId,
            sessionId: inspected.sessionId,
            userHome: homedir(),
            workspaceRoot: options.workspaceRoot,
            extensionSources: await resolveExtensionSkillSources(options),
          });
        } catch {
          const store = await openSessionStore(options, input.sessionId);
          await store.append({
            schemaVersion: 3,
            sequence: records.length + 1,
            record: {
              type: "skill_catalog_failed",
              recordVersion: 1,
              activeRevision: skillContext.registry.revision,
              activeRegistryDigest: skillContext.registry.digest,
              error: { code: "skill_catalog_unavailable" },
            },
          });
          const snapshot = await inspectSession({ sessionId: input.sessionId });
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return {
            status: "rejected",
            snapshot,
            error: {
              code: "skill_catalog_unavailable",
              message: "Agent Skills could not be reloaded safely.",
            },
          };
        }
        if (nextSkillContext === skillContext) {
          return { status: "unchanged", snapshot: inspected };
        }
        const nextPromptContext = replacePromptSkillsV2(promptContext, nextSkillContext);
        const store = await openSessionStore(options, input.sessionId);
        await store.append({
          schemaVersion: 3,
          sequence: records.length + 1,
          record: {
            type: "skill_catalog_committed",
            recordVersion: 1,
            previousRevision: skillContext.registry.revision,
            previousRegistryDigest: skillContext.registry.digest,
            skillContext: nextSkillContext,
            assemblyIdentityDigest: nextPromptContext.assemblyIdentityDigest,
          },
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "reloaded", snapshot };
      });
    },
    async regenerateSessionTitle(input) {
      if (
        lifecycleClosing ||
        activeSession !== undefined ||
        activeTitleSessions.has(input.sessionId)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const admission = Promise.withResolvers<void>();
      titleAdmissionOperations.add(admission.promise);
      try {
        const started = await withOwner(async () => {
          const inspected = await inspectSession({ sessionId: input.sessionId });
          if (inspected.schemaVersion !== 3 || options.modelTargets === undefined) {
            throw new SessionLifecycleError("session_invalid");
          }
          const records = await readSessionRecords(options, input.sessionId);
          const firstRun = records.find(
            (entry) => entry.schemaVersion === 3 && entry.record.type === "logical_run_started",
          );
          if (firstRun?.schemaVersion !== 3 || firstRun.record.type !== "logical_run_started") {
            throw new SessionLifecycleError("session_invalid");
          }
          const latestStarted = records.findLast(
            (entry) =>
              entry.schemaVersion === 3 && entry.record.type === "session_title_generation_started",
          );
          if (
            latestStarted?.schemaVersion === 3 &&
            latestStarted.record.type === "session_title_generation_started"
          ) {
            const latestGenerationId = latestStarted.record.generationId;
            const latestIsActive = !records.some(
              (entry) =>
                entry.schemaVersion === 3 &&
                (entry.record.type === "session_title_generation_completed" ||
                  entry.record.type === "session_title_generation_failed") &&
                entry.record.generationId === latestGenerationId,
            );
            if (latestIsActive) {
              throw new SessionLifecycleError("session_invalid");
            }
          }
          const generationId = randomUUID();
          const store = await openSessionStore(options, input.sessionId);
          const sequence = (records.at(-1)?.sequence ?? 0) + 1;
          await store.append({
            schemaVersion: 3,
            sequence,
            record: {
              type: "session_title_generation_started",
              recordVersion: 1,
              generationId,
              reason: "regenerate",
              targetIdentity: inspected.targetIdentity,
            },
          });
          await publishMetadata({
            type: "session_naming_changed",
            sessionId: input.sessionId,
            throughSequence: sequence,
          });
          const snapshot = await inspectSession({ sessionId: input.sessionId });
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return {
            generationId,
            targetIdentity: inspected.targetIdentity,
            userMessage: firstRun.record.userMessage,
            result: { status: "updated" as const, snapshot },
          };
        });
        const operation = settleTitleGeneration({
          sessionId: input.sessionId,
          generationId: started.generationId,
          targetIdentity: started.targetIdentity,
          userMessage: started.userMessage,
        });
        titleOperations.add(operation);
        activeTitleSessions.add(input.sessionId);
        void operation.finally(() => {
          titleOperations.delete(operation);
          activeTitleSessions.delete(input.sessionId);
        });
        return started.result;
      } finally {
        admission.resolve();
        titleAdmissionOperations.delete(admission.promise);
      }
    },
    async resume(input) {
      if (activeTitleSessions.has(input.sessionId)) {
        const snapshot = await inspectSession(input);
        return snapshot.schemaVersion === 3
          ? { status: "ready" as const, snapshot }
          : {
              status: "rejected" as const,
              snapshot,
              error: {
                code: "non_resumable_legacy_session" as const,
                message: "Legacy sessions cannot be resumed.",
              },
            };
      }
      return withOwner(async () => {
        const resumed = await resumeSession(input);
        if (resumed.status === "rejected") {
          return resumed;
        }
        const records = await readSessionRecords(options, input.sessionId);
        const started = records.findLast(
          (entry) =>
            entry.schemaVersion === 3 && entry.record.type === "session_title_generation_started",
        );
        if (
          started?.schemaVersion === 3 &&
          started.record.type === "session_title_generation_started"
        ) {
          const generationId = started.record.generationId;
          const terminalExists = records.some(
            (entry) =>
              entry.schemaVersion === 3 &&
              (entry.record.type === "session_title_generation_completed" ||
                entry.record.type === "session_title_generation_failed") &&
              entry.record.generationId === generationId,
          );
          if (terminalExists) {
            return resumed;
          }
          const store = await openSessionStore(options, input.sessionId);
          const sequence = (records.at(-1)?.sequence ?? 0) + 1;
          await store.append({
            schemaVersion: 3,
            sequence,
            record: {
              type: "session_title_generation_failed",
              recordVersion: 1,
              generationId,
              reason: "process_restart",
            },
          });
          await publishMetadata({
            type: "session_naming_changed",
            sessionId: input.sessionId,
            throughSequence: sequence,
          });
          const snapshot = await inspectSession(input);
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return { status: "ready" as const, snapshot };
        }
        return resumed;
      });
    },
    async clearSessionManualName(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (inspected.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const store = await openSessionStore(options, input.sessionId);
        const sequence = (records.at(-1)?.sequence ?? 0) + 1;
        await store.append({
          schemaVersion: 3,
          sequence,
          record: { type: "session_manual_name_cleared", recordVersion: 1 },
        });
        await publishMetadata({
          type: "session_naming_changed",
          sessionId: input.sessionId,
          throughSequence: sequence,
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "updated", snapshot };
      });
    },
    async enterPlan(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (
          inspected.schemaVersion !== 3 ||
          (inspected.status !== "idle" && inspected.status !== "settled") ||
          inspected.plan !== undefined
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (
          inspected.promptContext?.toolProfile.definitions.some(
            (definition) => definition.name === "search_repository",
          ) !== true
        ) {
          throw new SessionLifecycleError("session_plan_unavailable");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const eligibleToolProfile = planToolProfile(
          inspected,
          options.tools,
          "plan-policy.hybrid-v1",
        );
        const shellEnvironment = await (
          options[planShellEnvironmentFactory] ?? createPlanShellEnvironmentV1
        )();
        const store = await openSessionStore(options, input.sessionId);
        await store.append({
          schemaVersion: 3,
          sequence: (records.at(-1)?.sequence ?? 0) + 1,
          record: {
            type: "plan_cycle_entered",
            recordVersion: 1,
            cycleId: randomUUID(),
            revision: 1,
            policyVersion: "plan-policy.hybrid-v1",
            shellPolicyVersion: "plan-shell-policy.v1",
            shellEnvironment,
            gitPolicyVersion: planGitAutomaticPolicyV1.version,
            gitPolicyDigest: planGitAutomaticPolicyV1.digest,
            eligibleToolProfile,
          },
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return snapshot;
      });
    },
    async exitPlan(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (
          inspected.schemaVersion !== 3 ||
          (inspected.status !== "idle" && inspected.status !== "settled") ||
          inspected.plan?.cycleId !== input.cycleId ||
          inspected.plan.revision !== input.revision ||
          inspected.plan.state !== "exploring"
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const store = await openSessionStore(options, input.sessionId);
        await store.append({
          schemaVersion: 3,
          sequence: (records.at(-1)?.sequence ?? 0) + 1,
          record: {
            type: "plan_cycle_exited",
            recordVersion: 1,
            cycleId: input.cycleId,
            revision: input.revision + 1,
            reason: "user_cancelled",
          },
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return snapshot;
      });
    },
    async cancelPlan(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (
          inspected.schemaVersion !== 3 ||
          (inspected.status !== "idle" && inspected.status !== "settled") ||
          inspected.plan?.state !== "ready" ||
          inspected.plan.cycleId !== input.cycleId ||
          inspected.plan.revision !== input.revision ||
          inspected.plan.submission.planId !== input.planId ||
          inspected.plan.submission.contentDigest !== input.contentDigest
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const store = await openSessionStore(options, input.sessionId);
        await store.append({
          schemaVersion: 3,
          sequence: (records.at(-1)?.sequence ?? 0) + 1,
          record: {
            type: "plan_cycle_exited",
            recordVersion: 1,
            cycleId: input.cycleId,
            revision: input.revision + 1,
            reason: "user_cancelled",
          },
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return snapshot;
      });
    },
    async setSessionManualName(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
        const name = normalizedSessionTitle(input.name);
        if (name === null) {
          throw new SessionLifecycleError("session_invalid");
        }
        const inspected = await inspectSession({ sessionId: input.sessionId });
        if (inspected.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        const records = await readSessionRecords(options, input.sessionId);
        const store = await openSessionStore(options, input.sessionId);
        const sequence = (records.at(-1)?.sequence ?? 0) + 1;
        await store.append({
          schemaVersion: 3,
          sequence,
          record: { type: "session_manual_name_set", recordVersion: 1, name },
        });
        await publishMetadata({
          type: "session_naming_changed",
          sessionId: input.sessionId,
          throughSequence: sequence,
        });
        const snapshot = await inspectSession({ sessionId: input.sessionId });
        if (snapshot.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_invalid");
        }
        return { status: "updated", snapshot };
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeSessionEvents(listener) {
      sessionEventListeners.add(listener);
      return () => {
        sessionEventListeners.delete(listener);
      };
    },
    subscribeMetadata(listener) {
      metadataListeners.add(listener);
      return () => {
        metadataListeners.delete(listener);
      };
    },
  };
}

function boundedTitleInput(input: string): string {
  let normalized = "";
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }
  normalized = normalized.trim().split(/\s+/u).filter(Boolean).join(" ");
  let bounded = "";
  for (const character of normalized) {
    if (Buffer.byteLength(bounded + character, "utf8") > 4 * 1024) {
      break;
    }
    bounded += character;
  }
  return bounded;
}

function mcpWorkspaceConfirmationFromRecords(
  records: readonly SessionRecord[],
): SessionMcpWorkspaceConfirmedRecord["record"] | undefined {
  const confirmed = records.findLast(
    (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_workspace_confirmed",
  );
  return confirmed?.schemaVersion === 3 && confirmed.record.type === "mcp_workspace_confirmed"
    ? confirmed.record
    : undefined;
}

function mcpServerApprovalsFromRecords(
  records: readonly SessionRecord[],
): ReadonlyMap<string, `sha256:${string}`> {
  return new Map(
    records.flatMap((entry) =>
      entry.schemaVersion === 3 && entry.record.type === "mcp_server_definition_approved"
        ? [[entry.record.serverId, entry.record.definitionDigest] as const]
        : [],
    ),
  );
}

function mcpActivationFailureFromRecords(records: readonly SessionRecord[]):
  | {
      readonly code:
        | "mcp_bootstrap_failed"
        | "mcp_catalog_invalid"
        | "mcp_catalog_too_large"
        | "mcp_initialize_failed"
        | "mcp_shutdown_unconfirmed"
        | "mcp_start_failed"
        | "mcp_startup_timeout";
      readonly serverId?: string;
    }
  | undefined {
  const settled = records.findLast(
    (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_activation_settled",
  );
  return settled?.schemaVersion === 3 &&
    settled.record.type === "mcp_activation_settled" &&
    settled.record.status === "failed"
    ? settled.record.error
    : undefined;
}

function mcpActivationFromRecords(records: readonly SessionRecord[]):
  | {
      readonly attempt: number;
      readonly generationId: string;
      readonly status: "activating" | "ready" | "failed" | "cancelled";
    }
  | undefined {
  const started = records.findLast(
    (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_activation_started",
  );
  if (started?.schemaVersion !== 3 || started.record.type !== "mcp_activation_started") {
    return undefined;
  }
  const startedGenerationId = started.record.generationId;
  const settled = records.findLast(
    (entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "mcp_activation_settled" &&
      entry.record.generationId === startedGenerationId,
  );
  if (settled?.schemaVersion !== 3 || settled.record.type !== "mcp_activation_settled") {
    return {
      attempt: started.record.attempt,
      generationId: started.record.generationId,
      status: "activating",
    };
  }
  const wasClosed = records.some(
    (entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "mcp_server_closed" &&
      entry.record.generationId === startedGenerationId,
  );
  return {
    attempt: settled.record.attempt,
    generationId: settled.record.generationId,
    status: settled.record.status === "ready" && wasClosed ? "cancelled" : settled.record.status,
  };
}

function mcpCommittedProfileFromRecords(
  records: readonly SessionRecord[],
): McpToolProfileV1 | undefined {
  const committed = records.findLast(
    (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_tool_profile_committed",
  );
  return committed?.schemaVersion === 3 && committed.record.type === "mcp_tool_profile_committed"
    ? committed.record.profile
    : undefined;
}

function mcpCatalogStateFromRecords(
  records: readonly SessionRecord[],
): "ready" | "stale" | "shutdown_unconfirmed" | undefined {
  const staleCatalogs = new Set<string>();
  const unconfirmedCatalogs = new Set<string>();
  let state: "ready" | "stale" | "shutdown_unconfirmed" | undefined;
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "mcp_activation_settled" && entry.record.status === "ready") {
      staleCatalogs.clear();
      unconfirmedCatalogs.clear();
      state = "ready";
      continue;
    }
    if (entry.record.type !== "mcp_catalog_state_changed") {
      continue;
    }
    const key = `${entry.record.generationId}:${entry.record.serverId}:${entry.record.catalogDigest}`;
    if (entry.record.status === "stale") {
      staleCatalogs.add(key);
      if (entry.record.reason === "shutdown_unconfirmed") {
        unconfirmedCatalogs.add(key);
      }
    } else {
      staleCatalogs.delete(key);
      unconfirmedCatalogs.delete(key);
    }
    state =
      unconfirmedCatalogs.size > 0
        ? "shutdown_unconfirmed"
        : staleCatalogs.size === 0
          ? "ready"
          : "stale";
  }
  return state;
}

function mcpStaleCatalogServersFromRecords(
  records: readonly SessionRecord[],
  generationId: string,
  catalogDigest: `sha256:${string}`,
): ReadonlySet<string> {
  const serverIds = new Set<string>();
  for (const entry of records) {
    if (
      entry.schemaVersion !== 3 ||
      entry.record.type !== "mcp_catalog_state_changed" ||
      entry.record.generationId !== generationId ||
      entry.record.catalogDigest !== catalogDigest
    ) {
      continue;
    }
    if (entry.record.status === "stale") {
      serverIds.add(entry.record.serverId);
    } else {
      serverIds.delete(entry.record.serverId);
    }
  }
  return serverIds;
}

async function mcpWorkspaceConfirmationFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<SessionMcpWorkspaceConfirmedRecord["record"] | undefined> {
  const own = mcpWorkspaceConfirmationFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  return mcpWorkspaceConfirmationFromLineage(lineage, parentGenesis, prefixRecords);
}

async function mcpServerApprovalsFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<ReadonlyMap<string, `sha256:${string}`>> {
  const approvals =
    genesis.record.lineage === undefined
      ? new Map<string, `sha256:${string}`>()
      : new Map(
          await (async () => {
            const { parentGenesis, prefixRecords } =
              await lineage.readValidatedLineagePrefix(genesis);
            return mcpServerApprovalsFromLineage(lineage, parentGenesis, prefixRecords);
          })(),
        );
  for (const [serverId, digest] of mcpServerApprovalsFromRecords(records)) {
    approvals.set(serverId, digest);
  }
  return approvals;
}

async function mcpCommittedProfileFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<McpToolProfileV1 | undefined> {
  const own = mcpCommittedProfileFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  return mcpCommittedProfileFromLineage(lineage, parentGenesis, prefixRecords);
}

async function mcpCatalogStateFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<"ready" | "stale" | "shutdown_unconfirmed" | undefined> {
  const own = mcpCatalogStateFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  return mcpCatalogStateFromLineage(lineage, parentGenesis, prefixRecords);
}

type McpLineageAuthority = {
  confirmation?: SessionMcpWorkspaceConfirmedRecord["record"];
  readonly approvals: Map<string, `sha256:${string}`>;
  profile?: McpToolProfileV1;
};

async function validateMcpAuthorityFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<McpLineageAuthority> {
  let inherited: McpLineageAuthority = { approvals: new Map() };
  if (genesis.record.lineage !== undefined) {
    const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
    inherited = await validateMcpAuthorityFromLineage(lineage, parentGenesis, prefixRecords);
  }
  const authority: McpLineageAuthority = {
    approvals: new Map(inherited.approvals),
    ...(inherited.confirmation === undefined ? {} : { confirmation: inherited.confirmation }),
    ...(inherited.profile === undefined ? {} : { profile: inherited.profile }),
  };
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    const record = entry.record;
    if (record.type === "mcp_workspace_confirmed") {
      authority.confirmation = record;
      authority.approvals.clear();
      delete authority.profile;
      continue;
    }
    if (record.type === "mcp_server_definition_approved") {
      if (authority.confirmation?.sourceDigest !== record.sourceDigest) {
        throw new SessionLifecycleError("session_invalid");
      }
      authority.approvals.set(record.serverId, record.definitionDigest);
      continue;
    }
    if (record.type === "mcp_activation_started") {
      const selectedServers = record.servers.map(({ serverId, definitionDigest }) => ({
        serverId,
        definitionDigest,
      }));
      if (
        record.servers.some(
          (server) => authority.approvals.get(server.serverId) !== server.definitionDigest,
        ) ||
        (record.reason === "idle_reactivate" &&
          (authority.profile === undefined ||
            JSON.stringify(selectedServers) !==
              JSON.stringify(
                authority.profile.servers.map(({ serverId, definitionDigest }) => ({
                  serverId,
                  definitionDigest,
                })),
              )))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      continue;
    }
    if (record.type === "mcp_tool_profile_committed") {
      authority.profile = record.profile;
    }
  }
  return authority;
}

function requireMcpCommittedProfile(
  profile: McpToolProfileV1 | undefined,
  context: PromptContextRecordV3,
): McpToolProfileV1 {
  if (context.mcp === undefined || profile?.digest !== context.mcp.profileDigest) {
    throw new SessionLifecycleError("session_invalid");
  }
  return profile;
}

function combineToolRegistries(
  base: ToolRegistry | undefined,
  additional: ToolRegistry,
): ToolRegistry {
  if (base === undefined) {
    return additional;
  }
  const definitions = [...base.definitions(), ...additional.definitions()];
  const names = new Set(definitions.map((definition) => definition.name));
  if (names.size !== definitions.length) {
    throw new SessionLifecycleError("session_invalid");
  }
  return {
    definitions: () => definitions,
    resolve(name) {
      return base.resolve(name) ?? additional.resolve(name);
    },
  };
}

function mcpProfileDefinitionRegistry(profile: McpToolProfileV1): ToolRegistry {
  const adapters = profile.tools.map((tool) => {
    const definition = {
      name: tool.qualifiedName,
      description: tool.modelDescription,
      inputSchema: tool.modelProjection.schema,
    };
    return {
      definition,
      definitionDigest: tool.definitionDigest,
      outputSchema: z.json(),
      effect: tool.effect,
      replay: tool.replay,
      cancellation: tool.cancellation,
      maximumResult: { maximumBytes: tool.outputPolicy.maximumInlineBytes },
      prepare: () => ({
        status: "failed" as const,
        error: {
          code: "tool_io_failed" as const,
          message: "An inert MCP compatibility adapter cannot execute tools.",
        },
      }),
    };
  });
  const byName = new Map(adapters.map((adapter) => [adapter.definition.name, adapter]));
  return {
    definitions: () => adapters.map((adapter) => adapter.definition),
    resolve: (name) => byName.get(name),
  };
}

function historicalContextProfile(
  genesis: SessionGenesisRecord,
  compactedProfile: ContextProfile | undefined,
  officialProfile: ContextProfile,
): ContextProfile {
  return genesis.record.recordVersion === 2
    ? genesis.record.contextProfile
    : (compactedProfile ?? officialProfile);
}

function isHistoricalContextProfileSupported(
  officialProfile: ContextProfile,
  historicalProfile: ContextProfile,
): boolean {
  if (
    !isContextProfileSupported(historicalProfile) ||
    historicalProfile.version !== officialProfile.version ||
    historicalProfile.estimatorVersion !== officialProfile.estimatorVersion ||
    historicalProfile.contextWindowTokens > officialProfile.contextWindowTokens ||
    historicalProfile.maximumOutputTokens > officialProfile.maximumOutputTokens ||
    historicalProfile.compactAtTokens > officialProfile.compactAtTokens ||
    historicalProfile.compactAtTokens > Math.floor(historicalProfile.contextWindowTokens * 0.9) ||
    historicalProfile.postCompactTargetTokens !== officialProfile.postCompactTargetTokens ||
    historicalProfile.retainedTargetTokens !== officialProfile.retainedTargetTokens ||
    historicalProfile.ordinaryOutputReserveTokens !== officialProfile.ordinaryOutputReserveTokens
  ) {
    return false;
  }
  if (officialProfile.compactionSummaryMaximumOutputTokens === undefined) {
    return historicalProfile.compactionSummaryMaximumOutputTokens === undefined;
  }
  return (
    historicalProfile.compactionSummaryMaximumOutputTokens ===
    Math.min(
      officialProfile.compactionSummaryMaximumOutputTokens,
      historicalProfile.maximumOutputTokens,
    )
  );
}

async function contextSnapshotFromLineage(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<SessionContextSnapshot | undefined> {
  const ownContext = contextSnapshotFromRecords(records);
  if (ownContext !== undefined || genesis.record.lineage === undefined) {
    return ownContext;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    parentGenesis,
    prefixRecords,
    { allowDegraded: false },
    artifactCache,
  );
  return contextSnapshotFromLineage(
    options,
    lineage,
    parentGenesis,
    artifactInspection.records,
    artifactCache,
  );
}

async function contextUsageSnapshotFromLineage(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<SessionContextUsageSnapshot | undefined> {
  const ownUsage = contextUsageSnapshotFromRecords(records);
  if (genesis.record.lineage === undefined) {
    return ownUsage;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    parentGenesis,
    prefixRecords,
    { allowDegraded: false },
    artifactCache,
  );
  const inheritedUsage = await contextUsageSnapshotFromLineage(
    options,
    lineage,
    parentGenesis,
    artifactInspection.records,
    artifactCache,
  );
  if (ownUsage === undefined) {
    return inheritedUsage;
  }
  if (inheritedUsage === undefined) {
    return ownUsage;
  }
  return {
    ordinaryUsage: addContextUsageTotals(inheritedUsage.ordinaryUsage, ownUsage.ordinaryUsage),
    compactionUsage: addContextUsageTotals(
      inheritedUsage.compactionUsage,
      ownUsage.compactionUsage,
    ),
    active: ownUsage.active,
  };
}

async function createBranchMessages(
  options: SessionLifecycleOptions,
  lineageTraversal: SessionLineageTraversal,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<ModelMessage[]> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  if (genesis.record.lineage === undefined) {
    return [];
  }
  const { parentGenesis, prefixRecords: parentRecords } =
    await lineageTraversal.readValidatedLineagePrefix(genesis);
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    parentGenesis,
    parentRecords,
    { allowDegraded: false },
    artifactCache,
  );
  const projected = modelMessagesFromCompleteRecords(artifactInspection.records);
  if (
    parentRecords.some(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    )
  ) {
    return projected;
  }
  return [
    ...(await createBranchMessages(options, lineageTraversal, parentRecords, artifactCache)),
    ...projected,
  ];
}

async function validatePromptProjectionDigests(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<void> {
  if (genesis.record.promptContext === undefined) {
    return;
  }
  const inheritedMessages = await createBranchMessages(options, lineage, records, artifactCache);
  for (const entry of records) {
    if (
      entry.schemaVersion !== 3 ||
      entry.record.type !== "provider_attempt_started" ||
      entry.record.promptProjection === undefined
    ) {
      continue;
    }
    const prefix = records.filter((candidate) => candidate.sequence < entry.sequence);
    const context = promptContextRecordFromRecords(genesis, prefix);
    if (context === undefined) {
      throw new SessionLifecycleError("session_invalid");
    }
    const skillContext = skillContextRecordFromRecords(genesis, prefix);
    const activeSkillContents = await materializeActiveSkillContents(options, skillContext);
    const ownMessages = modelMessagesFromCompleteRecords(prefix);
    const transcript = prefix.some(
      (candidate) =>
        candidate.schemaVersion === 3 && candidate.record.type === "context_compaction_committed",
    )
      ? ownMessages
      : [...inheritedMessages, ...ownMessages];
    const assembledMessages = assemblePromptMessagesV1(
      transcript,
      context,
      skillContext,
      activeSkillContents,
    );
    const managedAgentSummary = entry.record.promptProjection.managedAgentSummary;
    const managedMessages =
      managedAgentSummary === undefined
        ? assembledMessages
        : insertDeveloperMessageBeforeLatestUser(assembledMessages, managedAgentSummary);
    const messages = hasTodoToolProfileV1(context.toolProfile.definitions)
      ? modelMessagesWithTodoSummaryV1(managedMessages, todoStoreSnapshotFromRecordsV1(prefix))
      : managedMessages;
    const plan = planCycleSnapshotFromRecords(prefix);
    const tools =
      plan === undefined
        ? context.toolProfile.definitions.map(({ definition }) => definition)
        : [
            ...plan.eligibleToolProfile.definitions.map((eligible) => {
              const definition = context.toolProfile.definitions.find(
                (candidate) => candidate.name === eligible.name,
              )?.definition;
              if (
                definition === undefined ||
                plan.eligibleToolProfile.source.version !== context.toolProfile.version ||
                plan.eligibleToolProfile.source.digest !== context.toolProfile.digest
              ) {
                throw new SessionLifecycleError("session_invalid");
              }
              return definition;
            }),
            ...(plan.state === "exploring" ? [submitPlanToolDefinitionV1] : []),
          ];
    const providerRunId = entry.record.runId;
    const kickoff = prefix.findLast(
      (candidate) =>
        candidate.schemaVersion === 3 &&
        candidate.record.type === "logical_run_started" &&
        candidate.record.runId === providerRunId &&
        candidate.record.planKickoff !== undefined,
    );
    const kickoffIntent =
      kickoff?.schemaVersion === 3 &&
      kickoff.record.type === "logical_run_started" &&
      kickoff.record.planKickoff !== undefined
        ? kickoff.record.planKickoff
        : undefined;
    const submission =
      kickoffIntent === undefined ? undefined : planSubmissionForApproval(prefix, kickoffIntent);
    const expectedApprovedPlanDigest =
      kickoffIntent !== undefined && submission !== undefined
        ? digestApprovedPlanProjectionV1({
            version: 1,
            ...kickoffIntent,
            ...(submission.title === undefined ? {} : { title: submission.title }),
          })
        : undefined;
    if (
      entry.record.promptProjection.approvedPlanProjectionDigest !== expectedApprovedPlanDigest ||
      digestPromptRequestV1(messages, tools) !==
        entry.record.promptProjection.requestProjectionDigest
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
}

function insertDeveloperMessageBeforeLatestUser(
  messages: readonly ModelMessage[],
  content: string,
): readonly ModelMessage[] {
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  const insertionIndex = userIndex < 0 ? messages.length : userIndex;
  return [
    ...messages.slice(0, insertionIndex),
    { role: "developer", content },
    ...messages.slice(insertionIndex),
  ];
}

async function modelResponseTargetsFromBranchContext(
  lineage: SessionLineageTraversal,
  records: readonly SessionRecord[],
): Promise<ModelTargetIdentity[]> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const ownTargets = records.flatMap((record) =>
    record.schemaVersion === 3 && record.record.type === "model_response_completed"
      ? [record.record.targetIdentity]
      : [],
  );
  if (genesis.record.lineage === undefined) {
    return ownTargets;
  }
  const { prefixRecords: parentRecords } = await lineage.readValidatedLineagePrefix(genesis);
  return [...(await modelResponseTargetsFromBranchContext(lineage, parentRecords)), ...ownTargets];
}

async function appendDanglingAttemptInterruption(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun?.record.type !== "logical_run_started") {
    return false;
  }
  const runId = latestRun.record.runId;
  const attempt = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  if (
    attempt?.record.type !== "provider_attempt_started" ||
    attemptStatus(currentRecords, attempt.record) !== "started"
  ) {
    return false;
  }
  const attemptRecord = attempt.record;
  const store = await openSessionStore(options, snapshot.sessionId);
  let nextSequence = records.length + 1;
  const reasoningId = `${attemptRecord.turn}:${attemptRecord.attempt}:provider-reasoning-0`;
  const reasoningStarted = currentRecords.findLast(
    (record) =>
      record.sequence > attempt.sequence &&
      record.record.type === "runtime_event" &&
      record.record.runId === attemptRecord.runId &&
      record.record.event.type === "model_reasoning_started" &&
      record.record.event.id === reasoningId,
  );
  const reasoningSettled = currentRecords.some(
    (record) =>
      record.sequence > (reasoningStarted?.sequence ?? Number.MAX_SAFE_INTEGER) &&
      record.record.type === "runtime_event" &&
      record.record.runId === attemptRecord.runId &&
      record.record.event.type === "model_reasoning_settled" &&
      record.record.event.id === reasoningId,
  );
  if (reasoningStarted !== undefined && !reasoningSettled) {
    await store.append({
      schemaVersion: 3,
      sequence: nextSequence,
      record: {
        type: "runtime_event",
        runId: attemptRecord.runId,
        event: { type: "model_reasoning_settled", id: reasoningId, status: "interrupted" },
      },
    });
    nextSequence += 1;
  }
  await store.append({
    schemaVersion: 3,
    sequence: nextSequence,
    record: {
      type: "provider_attempt_interrupted",
      runId: attemptRecord.runId,
      turn: attemptRecord.turn,
      attempt: attemptRecord.attempt,
      reason: "process_restart",
    },
  });
  return true;
}

async function appendDanglingContextCompactionInterruption(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const started = records.findLast(
    (record) => record.schemaVersion === 3 && record.record.type === "context_compaction_started",
  );
  if (started?.schemaVersion !== 3 || started.record.type !== "context_compaction_started") {
    return false;
  }
  const startedRecord = started.record;
  const hasTerminal = records.some(
    (record) =>
      record.sequence > started.sequence &&
      record.schemaVersion === 3 &&
      (record.record.type === "context_compaction_committed" ||
        record.record.type === "context_compaction_failed" ||
        record.record.type === "context_compaction_interrupted") &&
      record.record.attemptId === startedRecord.attemptId,
  );
  if (hasTerminal) {
    return false;
  }
  const store = await openSessionStore(options, snapshot.sessionId);
  await store.append({
    schemaVersion: 3,
    sequence: records.length + 1,
    record: {
      type: "context_compaction_interrupted",
      recordVersion: 1,
      runId: startedRecord.runId,
      attemptId: startedRecord.attemptId,
      attemptNumber: startedRecord.attemptNumber,
      windowNumber: startedRecord.windowNumber,
      trigger: startedRecord.trigger,
      sourceThrough: startedRecord.sourceThrough,
      reason: "process_restart",
      usage: { status: "unknown" },
    },
  });
  return true;
}

async function appendMissingUserMessage(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const run = currentRecords.findLast((record) => record.record.type === "logical_run_started");
  if (run?.record.type !== "logical_run_started") {
    return false;
  }
  const { runId, userMessage } = run.record;
  const hasUserMessage = currentRecords.some(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "user_message",
  );
  if (hasUserMessage) {
    return false;
  }
  const store = await openSessionStore(options, snapshot.sessionId);
  await store.append({
    schemaVersion: 3,
    sequence: records.length + 1,
    record: {
      type: "runtime_event",
      runId,
      event: { type: "user_message", text: userMessage },
    },
  });
  return true;
}

async function settleRunTerminalIntent(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const run = currentRecords.findLast((record) => record.record.type === "logical_run_started");
  if (run?.record.type !== "logical_run_started") {
    return false;
  }
  const runId = run.record.runId;
  const intent = currentRecords.findLast(
    (record) =>
      record.record.type === "provider_attempt_interrupted" &&
      record.record.runId === runId &&
      record.record.reason === "run_terminal",
  );
  if (
    intent?.record.type !== "provider_attempt_interrupted" ||
    intent.record.reason !== "run_terminal" ||
    currentRecords.some(
      (record) =>
        record.record.type === "runtime_event" &&
        record.record.runId === runId &&
        record.record.event.type === "session_settled",
    )
  ) {
    return false;
  }
  const store = await openSessionStore(options, snapshot.sessionId);
  let nextSequence = records.length + 1;
  const hasCancellationEvent = currentRecords.some(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "session_interrupted",
  );
  if (intent.record.result.status === "cancelled" && !hasCancellationEvent) {
    await store.append({
      schemaVersion: 3,
      sequence: nextSequence,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "session_interrupted", reason: "cancelled" },
      },
    });
    nextSequence += 1;
  }
  await store.append({
    schemaVersion: 3,
    sequence: nextSequence,
    record: {
      type: "runtime_event",
      runId,
      event: { type: "session_settled", result: intent.record.result },
    },
  });
  return true;
}

async function settleIndeterminateToolEffects(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun?.record.type !== "logical_run_started") {
    return false;
  }
  const runId = latestRun.record.runId;
  const indeterminateCalls: ToolCallIdentity[] = [];
  for (const responseRecord of currentRecords) {
    if (
      responseRecord.record.type !== "model_response_completed" ||
      responseRecord.record.runId !== runId
    ) {
      continue;
    }
    for (const call of responseRecord.record.response.toolCalls) {
      const laterEvents = currentRecords.filter(
        (candidate) =>
          candidate.sequence > responseRecord.sequence &&
          candidate.record.type === "runtime_event" &&
          candidate.record.runId === runId,
      );
      const started = laterEvents.some(
        (candidate) =>
          candidate.record.type === "runtime_event" &&
          candidate.record.event.type === "tool_started" &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      const requested = laterEvents.some(
        (candidate) =>
          candidate.record.type === "runtime_event" &&
          candidate.record.event.type === "tool_requested" &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      const terminal = laterEvents.some(
        (candidate) =>
          candidate.record.type === "runtime_event" &&
          (candidate.record.event.type === "tool_completed" ||
            candidate.record.event.type === "tool_failed") &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      const exactIntent = isExactToolIntent(options, snapshot, responseRecord.record, call);
      if (
        !terminal &&
        (!exactIntent ||
          (started && !isExactSafeReplay(options, snapshot, responseRecord.record, call)))
      ) {
        indeterminateCalls.push({ callId: call.id, name: call.name, requested, started });
      }
    }
  }
  const first = indeterminateCalls[0];
  if (first === undefined) {
    return false;
  }
  const store = await openSessionStore(options, snapshot.sessionId);
  let nextSequence = records.length + 1;
  for (const call of indeterminateCalls) {
    if (!call.requested) {
      await store.append({
        schemaVersion: 3,
        sequence: nextSequence,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.callId, name: call.name },
        },
      });
      nextSequence += 1;
    }
    const message = indeterminateToolMessage(call);
    await store.append({
      schemaVersion: 3,
      sequence: nextSequence,
      record: {
        type: "runtime_event",
        runId,
        event: {
          type: "tool_failed",
          callId: call.callId,
          name: call.name,
          error: {
            code: "tool_effect_indeterminate",
            reason: "process_restart",
            message,
          },
        },
      },
    });
    nextSequence += 1;
  }
  await store.append({
    schemaVersion: 3,
    sequence: nextSequence,
    record: {
      type: "runtime_event",
      runId,
      event: {
        type: "session_settled",
        result: {
          status: "failed",
          error: {
            code: "tool_effect_indeterminate",
            reason: "process_restart",
            message: indeterminateToolMessage(first),
          },
        },
      },
    },
  });
  return true;
}

async function settleInterruptedCancellation(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const run = currentRecords.findLast((record) => record.record.type === "logical_run_started");
  if (run?.record.type !== "logical_run_started") {
    return false;
  }
  const runId = run.record.runId;
  const cancellation = currentRecords.findLast(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "session_interrupted" &&
      record.record.event.reason === "cancelled",
  );
  const settled = currentRecords.some(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "session_settled",
  );
  if (cancellation === undefined || settled) {
    return false;
  }
  const store = await openSessionStore(options, snapshot.sessionId);
  await store.append({
    schemaVersion: 3,
    sequence: records.length + 1,
    record: {
      type: "runtime_event",
      runId,
      event: {
        type: "session_settled",
        result: {
          status: "cancelled",
          error: { code: "session_cancelled", message: "The session was cancelled." },
        },
      },
    },
  });
  return true;
}

async function settleCompletedResponseTerminal(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
  artifactCache: ModelResponseArtifactCache,
): Promise<boolean> {
  const records = await readSessionRecords(options, snapshot.sessionId);
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const run = currentRecords.findLast((record) => record.record.type === "logical_run_started");
  if (run?.record.type !== "logical_run_started") {
    return false;
  }
  const runId = run.record.runId;
  if (
    currentRecords.some(
      (record) =>
        (record.record.type === "runtime_event" &&
          record.record.runId === runId &&
          record.record.event.type === "session_settled") ||
        (record.record.type === "run_settled" && record.record.runId === runId),
    )
  ) {
    return false;
  }
  const responseRecord = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  if (
    responseRecord?.record.type !== "model_response_completed" ||
    !sameModelTargetIdentity(responseRecord.record.targetIdentity, snapshot.targetIdentity)
  ) {
    return false;
  }
  const responses = currentRecords.filter(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  const usageMissing = responses.some(
    (record) =>
      record.record.type === "model_response_completed" &&
      record.record.response.usage === undefined,
  );
  const reportedTokens = reportedTokensForRun(currentRecords, runId);
  const missingRequiredUsage = run.record.limits?.maxTokens !== undefined && usageMissing;
  const exhaustedTokenBudget =
    run.record.limits?.maxTokens !== undefined && reportedTokens >= run.record.limits.maxTokens;
  const isStopResponse =
    responseRecord.record.response.finishReason === "stop" &&
    responseRecord.record.response.toolCalls.length === 0 &&
    responseRecord.record.response.toolIntents.length === 0;
  const isOutputLimitResponse =
    responseRecord.record.response.finishReason === "length" &&
    responseRecord.record.response.toolCalls.length === 0 &&
    responseRecord.record.response.toolIntents.length === 0;
  const hasUnsafeStartedEffect = responseRecord.record.response.toolCalls.some((call) => {
    const laterEvents = currentRecords.filter(
      (record) =>
        record.sequence > responseRecord.sequence &&
        record.record.type === "runtime_event" &&
        record.record.runId === runId,
    );
    const started = laterEvents.some(
      (record) =>
        record.record.type === "runtime_event" &&
        record.record.event.type === "tool_started" &&
        record.record.event.callId === call.id &&
        record.record.event.name === call.name,
    );
    const terminal = laterEvents.some(
      (record) =>
        record.record.type === "runtime_event" &&
        (record.record.event.type === "tool_completed" ||
          record.record.event.type === "tool_failed") &&
        record.record.event.callId === call.id &&
        record.record.event.name === call.name,
    );
    return (
      started && !terminal && !isExactSafeReplay(options, snapshot, responseRecord.record, call)
    );
  });
  if (!isStopResponse && !isOutputLimitResponse && hasUnsafeStartedEffect) {
    return false;
  }
  if (!missingRequiredUsage && !exhaustedTokenBudget && !isStopResponse && !isOutputLimitResponse) {
    return false;
  }
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    genesis,
    records,
    { allowDegraded: false },
    artifactCache,
  );
  const responseText =
    artifactInspection.contents.get(responseRecord.sequence)?.text ??
    inlineModelResponseField(responseRecord.record.response.text);
  const artifactBackedResponse =
    responseRecord.record.response.recordVersion === 2 &&
    (responseRecord.record.response.text.storage === "artifact" ||
      responseRecord.record.response.reasoning?.storage === "artifact");
  const result: RunResult = isOutputLimitResponse
    ? { status: "incomplete", reason: "output_limit", answer: responseText }
    : missingRequiredUsage
      ? {
          status: "failed",
          error: {
            code: "token_usage_missing",
            message: "The provider did not report token usage for an active token limit.",
          },
        }
      : exhaustedTokenBudget
        ? {
            status: "failed",
            error: {
              code: "token_limit_exceeded",
              message: "The run reached its provider-reported token limit.",
            },
          }
        : { status: "completed", answer: responseText };
  const store = await openSessionStore(options, snapshot.sessionId);
  let nextSequence = records.length + 1;
  const responseWasPublished = currentRecords.some(
    (record) =>
      record.sequence > responseRecord.sequence &&
      ((record.record.type === "runtime_event" &&
        record.record.runId === runId &&
        record.record.event.type === "model_message_completed") ||
        (record.record.type === "model_response_published" &&
          record.record.runId === runId &&
          record.record.responseSequence === responseRecord.sequence)),
  );
  if (!responseWasPublished) {
    const publicationRecord: SessionRecord = artifactBackedResponse
      ? {
          schemaVersion: 3,
          sequence: nextSequence,
          record: {
            type: "model_response_published",
            recordVersion: 1,
            runId,
            responseSequence: responseRecord.sequence,
          },
        }
      : {
          schemaVersion: 3,
          sequence: nextSequence,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_completed", text: responseText },
          },
        };
    await store.append(publicationRecord);
    nextSequence += 1;
  }
  const settlementRecord: SessionRecord =
    artifactBackedResponse && (result.status === "completed" || result.status === "incomplete")
      ? {
          schemaVersion: 3,
          sequence: nextSequence,
          record: {
            type: "run_settled",
            recordVersion: 1,
            runId,
            responseSequence: responseRecord.sequence,
            ...(result.status === "completed"
              ? { status: "completed" as const }
              : { status: "incomplete" as const, reason: result.reason }),
          },
        }
      : {
          schemaVersion: 3,
          sequence: nextSequence,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "session_settled", result },
          },
        };
  await store.append(settlementRecord);
  return true;
}

type ToolCallIdentity = {
  readonly callId: string;
  readonly name: string;
  readonly requested: boolean;
  readonly started: boolean;
};

function indeterminateToolMessage(call: ToolCallIdentity): string {
  return call.started
    ? `The ${call.name} effect started before restart and cannot be replayed safely.`
    : `The durable ${call.name} request no longer matches the current tool definition and requires inspection.`;
}

function isExactSafeReplay(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
  responseRecord: Extract<SessionRecord, { readonly schemaVersion: 3 }>["record"],
  call: { readonly id: string; readonly name: string; readonly argumentsJson: string },
): boolean {
  if (!isExactToolIntent(options, snapshot, responseRecord, call)) {
    return false;
  }
  if (responseRecord.type !== "model_response_completed") {
    return false;
  }
  const intent = responseRecord.response.toolIntents.find(
    (candidate) => candidate.callId === call.id && candidate.name === call.name,
  );
  const adapter = options.tools?.resolve(call.name);
  return intent?.replay === "safe" && adapter?.replay === "safe";
}

function isExactToolIntent(
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
  responseRecord: Extract<SessionRecord, { readonly schemaVersion: 3 }>["record"],
  call: { readonly id: string; readonly name: string; readonly argumentsJson: string },
): boolean {
  if (
    responseRecord.type !== "model_response_completed" ||
    !sameModelTargetIdentity(responseRecord.targetIdentity, snapshot.targetIdentity)
  ) {
    return false;
  }
  const intent = responseRecord.response.toolIntents.find(
    (candidate) => candidate.callId === call.id && candidate.name === call.name,
  );
  const adapter = options.tools?.resolve(call.name);
  return (
    intent !== undefined &&
    adapter !== undefined &&
    intent.argumentsDigest ===
      `sha256:${createHash("sha256").update(call.argumentsJson).digest("hex")}` &&
    intent.effect === adapter.effect &&
    intent.definitionDigest === adapter.definitionDigest
  );
}

function createAgentResumeState(
  records: readonly SessionRecord[],
  options: SessionLifecycleOptions,
  snapshot: CurrentSessionSnapshot,
): {
  readonly userMessage: string;
  readonly limits: { readonly maxTurns?: number; readonly maxTokens?: number } | undefined;
  readonly thinkingPolicy: ThinkingPolicySnapshotV1 | undefined;
  readonly agentState: NonNullable<AgentSessionDurableContext["resume"]>;
} {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const run = currentRecords.findLast((record) => record.record.type === "logical_run_started");
  if (run?.record.type !== "logical_run_started") {
    throw new SessionLifecycleError("session_invalid");
  }
  const runId = run.record.runId;
  const lastAttempt = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  const lastAttemptRecord =
    lastAttempt?.record.type === "provider_attempt_started" ? lastAttempt.record : undefined;
  const lastAttemptStatus =
    lastAttemptRecord === undefined ? undefined : attemptStatus(currentRecords, lastAttemptRecord);
  const interruptedAttempt =
    lastAttemptStatus === "interrupted"
      ? currentRecords.findLast(
          (record) =>
            record.record.type === "provider_attempt_interrupted" &&
            record.record.runId === runId &&
            record.record.turn === lastAttemptRecord?.turn &&
            record.record.attempt === lastAttemptRecord?.attempt,
        )
      : undefined;
  const lastResponse = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  const toolBoundary =
    lastAttemptStatus === "completed" &&
    lastResponse?.record.type === "model_response_completed" &&
    lastResponse.record.response.finishReason === "tool_calls"
      ? lastResponse
      : undefined;
  if (
    lastAttemptRecord !== undefined &&
    interruptedAttempt?.record.type !== "provider_attempt_interrupted" &&
    toolBoundary === undefined
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const boundaryTurn =
    interruptedAttempt?.record.type === "provider_attempt_interrupted"
      ? interruptedAttempt.record.turn
      : toolBoundary?.record.type === "model_response_completed"
        ? toolBoundary.record.turn + 1
        : lastAttemptRecord === undefined
          ? 1
          : 0;
  const contextCheckpoint = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_committed",
  );
  const contextCheckpointRecord =
    contextCheckpoint?.record.type === "context_compaction_committed"
      ? contextCheckpoint.record
      : undefined;
  const checkpointIncludesCurrentRun =
    contextCheckpointRecord !== undefined && (contextCheckpoint?.sequence ?? 0) >= run.sequence;
  const messages: NonNullable<AgentSessionDurableContext["resume"]>["messages"][number][] = [
    ...modelMessagesFromCompleteRecords(
      currentRecords.filter((record) =>
        checkpointIncludesCurrentRun
          ? record.sequence <= (contextCheckpoint?.sequence ?? 0)
          : record.sequence < run.sequence,
      ),
    ),
    ...(checkpointIncludesCurrentRun ? [] : [createLogicalRunUserMessageV1(run.record)]),
  ];
  const toolResults: Array<
    NonNullable<AgentSessionDurableContext["resume"]>["toolResults"][number]
  > = [];
  const pendingToolCalls: Array<
    NonNullable<AgentSessionDurableContext["resume"]>["pendingToolCalls"][number]
  > = [];
  const reportedTokens = reportedTokensForRun(currentRecords, runId);
  const explicitSkillPermissions = currentRecords.flatMap((record) =>
    record.record.type === "runtime_event" &&
    record.record.runId === runId &&
    record.record.event.type === "tool_permission_decided" &&
    record.record.event.name === "activate_skill"
      ? [
          {
            requestId: record.record.event.callId,
            decision: record.record.event.decision,
          },
        ]
      : [],
  );
  const explicitSkills = run.record.skills ?? [];
  const explicitSkillBatchCommitted =
    explicitSkills.length > 0 &&
    currentRecords.some(
      (record) =>
        record.record.type === "skill_activation_batch_committed" &&
        record.record.runId === runId &&
        record.record.outcomes.length === explicitSkills.length &&
        record.record.outcomes.every(
          (outcome, index) =>
            outcome.requestId === explicitSkills[index]?.requestId &&
            outcome.selection === explicitSkills[index]?.selection,
        ),
    );
  for (const responseRecord of currentRecords) {
    if (
      responseRecord.record.type !== "model_response_completed" ||
      responseRecord.record.runId !== runId ||
      responseRecord.record.turn >= boundaryTurn ||
      (contextCheckpointRecord !== undefined &&
        responseRecord.sequence <= contextCheckpointRecord.sourceThrough)
    ) {
      continue;
    }
    const { response } = responseRecord.record;
    const responseText = inlineModelResponseField(response.text);
    const responseReasoning =
      response.reasoning === undefined ? undefined : inlineModelResponseField(response.reasoning);
    messages.push({
      role: "assistant",
      content: responseText,
      ...(responseReasoning === undefined ? {} : { reasoning: responseReasoning }),
      toolCalls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      const resultEvent = currentRecords.find(
        (candidate) =>
          candidate.sequence > responseRecord.sequence &&
          candidate.record.type === "runtime_event" &&
          candidate.record.runId === runId &&
          (candidate.record.event.type === "tool_completed" ||
            candidate.record.event.type === "tool_failed") &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      if (
        resultEvent?.record.type !== "runtime_event" ||
        (resultEvent.record.event.type !== "tool_completed" &&
          resultEvent.record.event.type !== "tool_failed")
      ) {
        if (responseRecord !== toolBoundary) {
          throw new SessionLifecycleError("session_invalid");
        }
        const requested = currentRecords.some(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            candidate.record.type === "runtime_event" &&
            candidate.record.runId === runId &&
            candidate.record.event.type === "tool_requested" &&
            candidate.record.event.callId === call.id &&
            candidate.record.event.name === call.name,
        );
        const started = currentRecords.some(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            candidate.record.type === "runtime_event" &&
            candidate.record.runId === runId &&
            candidate.record.event.type === "tool_started" &&
            candidate.record.event.callId === call.id &&
            candidate.record.event.name === call.name,
        );
        if (started && !isExactSafeReplay(options, snapshot, responseRecord.record, call)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const permission = currentRecords.findLast(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            candidate.record.type === "runtime_event" &&
            candidate.record.runId === runId &&
            candidate.record.event.type === "tool_permission_decided" &&
            candidate.record.event.callId === call.id &&
            candidate.record.event.name === call.name,
        );
        const permissionEvent =
          permission?.record.type === "runtime_event" &&
          permission.record.event.type === "tool_permission_decided"
            ? permission.record.event
            : undefined;
        const exactIntent = isExactToolIntent(options, snapshot, responseRecord.record, call);
        const repositoryRecord = currentRecords.findLast(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            (candidate.record.type === "repository_instructions_committed" ||
              candidate.record.type === "repository_instructions_failed" ||
              candidate.record.type === "path_context_committed" ||
              candidate.record.type === "path_context_failed") &&
            candidate.record.trigger?.runId === runId &&
            candidate.record.trigger.callId === call.id &&
            candidate.record.trigger.name === call.name,
        );
        const repositoryTrigger =
          repositoryRecord?.record.type === "repository_instructions_committed" ||
          repositoryRecord?.record.type === "repository_instructions_failed" ||
          repositoryRecord?.record.type === "path_context_committed" ||
          repositoryRecord?.record.type === "path_context_failed"
            ? repositoryRecord.record.trigger
            : undefined;
        const committedRepository =
          repositoryRecord?.record.type === "repository_instructions_committed"
            ? repositoryRecord.record.repository
            : repositoryRecord?.record.type === "path_context_committed"
              ? repositoryRecord.record.repository
              : undefined;
        const repositoryRecordSequence = repositoryRecord?.sequence;
        const repositoryActivation =
          committedRepository !== undefined && repositoryTrigger !== undefined
            ? {
                revision: committedRepository.revision,
                effectiveDigest: committedRepository.effectiveDigest,
                publishEvent: !currentRecords.some(
                  (candidate) =>
                    candidate.sequence > (repositoryRecordSequence ?? Number.MAX_SAFE_INTEGER) &&
                    candidate.record.type === "runtime_event" &&
                    candidate.record.runId === runId &&
                    candidate.record.event.type === "repository_instructions_activated" &&
                    candidate.record.event.revision === committedRepository.revision,
                ),
              }
            : undefined;
        const reusablePermission =
          repositoryTrigger === undefined &&
          exactIntent &&
          permissionEvent?.decision === "allow" &&
          permissionEvent?.effect !== undefined &&
          permissionEvent.scope === "call" &&
          permissionEvent.subject !== undefined
            ? {
                callId: call.id,
                name: call.name,
                effect: permissionEvent.effect,
                scope: permissionEvent.scope,
                subject: permissionEvent.subject,
              }
            : undefined;
        const committedSkillResource = currentRecords.find(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            candidate.record.type === "skill_resource_read_committed" &&
            candidate.record.runId === runId &&
            candidate.record.callId === call.id,
        );
        const committedInputResource = currentRecords.find(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            (candidate.record.type === "input_resource_read_committed" ||
              candidate.record.type === "input_resource_image_read_committed") &&
            candidate.record.runId === runId &&
            candidate.record.callId === call.id,
        );
        const replayResult =
          permissionEvent?.decision === "deny"
            ? {
                status: "failed" as const,
                error: {
                  code: "permission_denied" as const,
                  message:
                    snapshot.plan !== undefined && permissionEvent.requestId === undefined
                      ? `Permission denied for tool in Plan: ${call.name}`
                      : `Permission denied for tool: ${call.name}`,
                },
              }
            : committedSkillResource?.record.type === "skill_resource_read_committed"
              ? {
                  status: "completed" as const,
                  output: {
                    qualifiedId: committedSkillResource.record.qualifiedId,
                    activationIndex: committedSkillResource.record.activationIndex,
                    catalogRevision: committedSkillResource.record.catalogRevision,
                    manifestRevision: committedSkillResource.record.manifestRevision,
                    path: committedSkillResource.record.path,
                    offset: committedSkillResource.record.offset,
                    byteCount: committedSkillResource.record.byteCount,
                    totalByteCount: committedSkillResource.record.totalByteCount,
                    eof: committedSkillResource.record.eof,
                    fileDigest: committedSkillResource.record.fileDigest,
                    pageDigest: committedSkillResource.record.pageDigest,
                    content: committedSkillResource.record.content,
                    ...(committedSkillResource.record.executionToken === undefined
                      ? {}
                      : { executionToken: committedSkillResource.record.executionToken }),
                  },
                }
              : committedInputResource?.record.type === "input_resource_read_committed"
                ? {
                    status: "completed" as const,
                    output: {
                      occurrenceId: committedInputResource.record.occurrenceId,
                      displayName: committedInputResource.record.displayName,
                      offset: committedInputResource.record.offset,
                      byteCount: committedInputResource.record.byteCount,
                      totalByteCount: committedInputResource.record.totalByteCount,
                      eof: committedInputResource.record.eof,
                      nextCursor: committedInputResource.record.nextCursor,
                      digest: committedInputResource.record.digest,
                      pageDigest: committedInputResource.record.pageDigest,
                      content: committedInputResource.record.content,
                    },
                  }
                : committedInputResource?.record.type === "input_resource_image_read_committed"
                  ? { status: "completed" as const, output: committedInputResource.record.image }
                  : undefined;
        pendingToolCalls.push({
          call,
          requested,
          started,
          ...(repositoryActivation === undefined ? {} : { repositoryActivation }),
          ...(repositoryTrigger === undefined
            ? {}
            : { repositoryDisposition: repositoryTrigger.disposition }),
          ...(reusablePermission === undefined ? {} : { reusablePermission }),
          ...(replayResult === undefined ? {} : { replayResult }),
        });
        continue;
      }
      const result =
        resultEvent.record.event.type === "tool_completed"
          ? ({ status: "completed", output: resultEvent.record.event.output } as const)
          : ({ status: "failed", error: resultEvent.record.event.error } as const);
      toolResults.push({ call, result });
      messages.push({ role: "tool", callId: call.id, name: call.name, result });
    }
  }
  return {
    userMessage: run.record.userMessage,
    limits: run.record.limits,
    thinkingPolicy: run.record.thinkingPolicy,
    agentState: {
      runId,
      ...(explicitSkills.length === 0 || explicitSkillBatchCommitted
        ? {}
        : {
            pendingExplicitSkills: explicitSkills,
            ...(explicitSkillPermissions.length === 0 ? {} : { explicitSkillPermissions }),
          }),
      messages,
      nextTurn: boundaryTurn,
      nextAttempt:
        interruptedAttempt?.record.type === "provider_attempt_interrupted"
          ? interruptedAttempt.record.attempt + 1
          : 1,
      reportedTokens,
      compactionUsageUnknown: currentRecords.some(
        (record) =>
          (record.record.type === "context_compaction_committed" ||
            record.record.type === "context_compaction_failed" ||
            record.record.type === "context_compaction_interrupted") &&
          record.record.runId === runId &&
          (record.record.usage === undefined || "status" in record.record.usage),
      ),
      toolResults,
      pendingToolCalls,
    },
  };
}

function reportedTokensForRun(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
  runId: string,
): number {
  const usageRecords = records.filter(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "model_usage",
  );
  const total = usageRecords.reduce(
    (sum, record) =>
      record.record.type === "runtime_event" && record.record.event.type === "model_usage"
        ? sum + record.record.event.totalTokens
        : sum,
    0,
  );
  const compactionTotal = records.reduce((sum, record) => {
    if (
      record.record.type !== "context_compaction_committed" &&
      record.record.type !== "context_compaction_failed" &&
      record.record.type !== "context_compaction_interrupted"
    ) {
      return sum;
    }
    const usage = record.record.usage;
    return usage === undefined || "status" in usage
      ? sum
      : sum + usage.inputTokens + usage.outputTokens;
  }, 0);
  const combined = total + compactionTotal;
  if (!Number.isSafeInteger(combined) || combined < 0) {
    throw new SessionLifecycleError("session_invalid");
  }
  return combined;
}

function skillResourceBytesForRun(records: readonly SessionRecord[], runId: string): number {
  const total = records.reduce(
    (sum, record) =>
      record.schemaVersion === 3 &&
      record.record.type === "skill_resource_read_committed" &&
      record.record.runId === runId
        ? sum + record.record.byteCount
        : sum,
    0,
  );
  if (!Number.isSafeInteger(total) || total < 0 || total > 1024 * 1024) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function skillResourceBytesFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<number> {
  const ownBytes = records.reduce(
    (sum, record) =>
      record.schemaVersion === 3 && record.record.type === "skill_resource_read_committed"
        ? sum + record.record.byteCount
        : sum,
    0,
  );
  const inheritedBytes =
    genesis.record.lineage === undefined
      ? 0
      : await (async () => {
          const { parentGenesis, prefixRecords } =
            await lineage.readValidatedLineagePrefix(genesis);
          return skillResourceBytesFromLineage(lineage, parentGenesis, prefixRecords);
        })();
  const total = inheritedBytes + ownBytes;
  if (!Number.isSafeInteger(total) || total < 0 || total > 8 * 1024 * 1024) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

function inputResourceBytesForRun(records: readonly SessionRecord[], runId: string): number {
  const total = records.reduce(
    (sum, record) =>
      record.schemaVersion === 3 &&
      (record.record.type === "input_resource_read_committed" ||
        record.record.type === "input_resource_image_read_committed") &&
      record.record.runId === runId
        ? sum +
          (record.record.type === "input_resource_read_committed"
            ? record.record.byteCount
            : record.record.image.byteCount)
        : sum,
    0,
  );
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > inputResourceLimitsV1.maximumMaterializedBytesPerRun
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function inputResourceBytesFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<number> {
  const ownBytes = records.reduce(
    (sum, record) =>
      record.schemaVersion === 3 &&
      (record.record.type === "input_resource_read_committed" ||
        record.record.type === "input_resource_image_read_committed")
        ? sum +
          (record.record.type === "input_resource_read_committed"
            ? record.record.byteCount
            : record.record.image.byteCount)
        : sum,
    0,
  );
  const inheritedBytes =
    genesis.record.lineage === undefined
      ? 0
      : await (async () => {
          const { parentGenesis, prefixRecords } =
            await lineage.readValidatedLineagePrefix(genesis);
          return inputResourceBytesFromLineage(lineage, parentGenesis, prefixRecords);
        })();
  const total = inheritedBytes + ownBytes;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > inputResourceLimitsV1.maximumMaterializedBytesPerLineage
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function inputResourcesFromLineage(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<readonly InputResourceOccurrenceV1[]> {
  const inherited =
    genesis.record.lineage === undefined
      ? []
      : await (async () => {
          const { parentGenesis, prefixRecords } =
            await lineage.readValidatedLineagePrefix(genesis);
          return inputResourcesFromLineage(lineage, parentGenesis, prefixRecords);
        })();
  const own = records.flatMap((record) =>
    record.schemaVersion === 3 && record.record.type === "logical_run_started"
      ? (record.record.inputResources ?? [])
      : [],
  );
  const visible = [...inherited, ...own];
  const occurrenceIds = new Set(visible.map((occurrence) => occurrence.occurrenceId));
  const aggregateBytes = visible.reduce(
    (total, occurrence) => total + occurrence.artifact.byteCount,
    0,
  );
  if (
    visible.length > inputResourceLimitsV1.maximumOccurrencesPerLineage ||
    occurrenceIds.size !== visible.length ||
    !Number.isSafeInteger(aggregateBytes) ||
    aggregateBytes > inputResourceLimitsV1.maximumAggregateBytesPerLineage
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  return visible;
}

async function validateCompactionInputResources(
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<void> {
  for (const checkpoint of records) {
    if (
      checkpoint.schemaVersion !== 3 ||
      checkpoint.record.type !== "context_compaction_committed"
    ) {
      continue;
    }
    const checkpointRecord = checkpoint.record;
    const expected = await inputResourcesFromLineage(
      lineage,
      genesis,
      records.filter((record) => record.sequence <= checkpointRecord.sourceThrough),
    );
    if (!isDeepStrictEqual(checkpointRecord.inputResources ?? [], expected)) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
}

function validateInputResourceReadLineage(
  records: readonly SessionRecord[],
  visible: readonly InputResourceOccurrenceV1[],
): void {
  const occurrences = new Map(visible.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  for (const record of records) {
    if (
      record.schemaVersion !== 3 ||
      (record.record.type !== "input_resource_read_committed" &&
        record.record.type !== "input_resource_image_read_committed")
    ) {
      continue;
    }
    const descriptor =
      record.record.type === "input_resource_read_committed"
        ? {
            occurrenceId: record.record.occurrenceId,
            displayName: record.record.displayName,
            digest: record.record.digest,
            byteCount: record.record.totalByteCount,
          }
        : {
            occurrenceId: record.record.image.occurrenceId,
            displayName: record.record.image.displayName,
            digest: record.record.image.digest,
            byteCount: record.record.image.byteCount,
          };
    const occurrence = occurrences.get(descriptor.occurrenceId);
    if (
      occurrence === undefined ||
      descriptor.displayName !== occurrence.displayName ||
      descriptor.digest !== occurrence.digest ||
      descriptor.byteCount !== occurrence.artifact.byteCount ||
      (record.record.type === "input_resource_image_read_committed" &&
        (occurrence.support !== "image" ||
          record.record.image.artifactId !== occurrence.artifact.id ||
          record.record.image.mediaType !== occurrence.artifact.mediaType))
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
}

async function validateVisibleInputResourceArtifacts(
  artifactStore: ArtifactStore,
  occurrences: readonly InputResourceOccurrenceV1[],
): Promise<void> {
  for (const occurrence of occurrences) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await artifactStore.read(occurrence.artifact.id, {
        maximumBytes: inputResourceLimitsV1.maximumFileBytes,
      });
    } catch {
      throw new InputResourceError(
        "input_resource_corrupt",
        "An immutable input-resource artifact failed integrity validation.",
      );
    }
    if (
      bytes === undefined ||
      bytes.byteLength !== occurrence.artifact.byteCount ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== occurrence.digest
    ) {
      throw new InputResourceError(
        "input_resource_corrupt",
        "An immutable input-resource artifact is missing or does not match its descriptor.",
      );
    }
  }
}

async function materializeApprovedPlanProjection(
  artifactStore: ArtifactStore,
  approval: PlanApprovalIntentV1,
  submission: PlanSubmissionSnapshotV1,
): Promise<ApprovedPlanProjectionV1> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await artifactStore.read(submission.artifact.id, { maximumBytes: 64 * 1_024 });
  } catch {
    throw new SessionLifecycleError("session_invalid");
  }
  if (
    bytes === undefined ||
    bytes.byteLength !== submission.artifact.byteCount ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== submission.contentDigest
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SessionLifecycleError("session_invalid");
  }
  return {
    version: 1,
    ...approval,
    ...(submission.title === undefined ? {} : { title: submission.title }),
    markdown,
  };
}

function planSubmissionForApproval(
  records: readonly SessionRecord[],
  approval: PlanApprovalIntentV1,
): PlanSubmissionSnapshotV1 | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const entry = records[index];
    if (entry?.schemaVersion !== 3) {
      continue;
    }
    if (
      entry.record.type === "plan_submitted" &&
      entry.record.cycleId === approval.cycleId &&
      entry.record.revision === approval.revision &&
      entry.record.planId === approval.planId &&
      entry.record.contentDigest === approval.contentDigest
    ) {
      return {
        planId: entry.record.planId,
        revision: entry.record.revision,
        contentDigest: entry.record.contentDigest,
        ...(entry.record.title === undefined ? {} : { title: entry.record.title }),
        artifact: entry.record.artifact,
        policyVersion: entry.record.policyVersion,
        toolProfileDigest: entry.record.toolProfileDigest,
      };
    }
    const inherited = entry.record;
    if (
      inherited.type === "plan_cycle_inherited" &&
      inherited.state === "ready" &&
      inherited.submission !== undefined &&
      inherited.cycleId === approval.cycleId &&
      inherited.revision === approval.revision &&
      inherited.submission.planId === approval.planId &&
      inherited.submission.contentDigest === approval.contentDigest
    ) {
      return inherited.submission;
    }
  }
  return undefined;
}

async function canonicalProjectId(workspaceRoot: string): Promise<string> {
  return (await resolveCanonicalWorkspaceIdentity(workspaceRoot)).projectId;
}

async function resolveSkillBudgetContext(
  options: SessionLifecycleOptions,
  targetIdentity: ModelTargetIdentity,
): Promise<{ readonly effectiveContextTokens: number; readonly estimatorVersion: 1 }> {
  if (options.modelTargets !== undefined) {
    const snapshot = await options.modelTargets.snapshot({
      includeHistoricalProfiles: true,
      signal: new AbortController().signal,
    });
    const target = snapshot.targets.find((candidate) =>
      sameModelTargetIdentity(candidate.identity, targetIdentity),
    );
    if (target === undefined || target.contextProfile.estimatorVersion !== 1) {
      throw new SessionLifecycleError("session_model_target_unavailable");
    }
    return {
      effectiveContextTokens: target.contextProfile.contextWindowTokens,
      estimatorVersion: target.contextProfile.estimatorVersion,
    };
  }
  return { effectiveContextTokens: 1_000_000, estimatorVersion: 1 };
}

async function resolveExtensionSkillSources(
  options: SessionLifecycleOptions,
): Promise<readonly ExtensionSkillSourceV1[]> {
  if (options.extensionHost === undefined) {
    return [];
  }
  const sources = await loadInternalExtensionSkillSources(options.extensionHost);
  return sources.map((source) => ({
    locator: {
      source: "extension",
      extensionId: source.extensionId,
      packageName: source.packageName,
      packageVersion: source.packageVersion,
    },
    packageRoot: source.packageRoot,
    lifecycleRevision: source.lifecycleRevision,
    lifecycleDigest: source.lifecycleDigest,
  }));
}

type ResolvedModelResponseArtifact =
  | { readonly byteCount: number; readonly text: string }
  | undefined;

type ModelResponseArtifactCache = Map<string, Promise<ResolvedModelResponseArtifact>>;

function createArtifactMaterializationCache(): ModelResponseArtifactCache {
  return new Map();
}

function createLazyArtifactStore(root: string): ArtifactStore {
  let store: Promise<ArtifactStore> | undefined;
  const resolveStore = () => {
    store ??= createFileArtifactStore({ root });
    return store;
  };
  return {
    async write(input) {
      return (await resolveStore()).write(input);
    },
    async read(id, options) {
      return (await resolveStore()).read(id, options);
    },
  };
}

function createStagedArtifactStore(): ArtifactStore & {
  readonly flushTo: (store: ArtifactStore) => Promise<void>;
} {
  const artifacts = new Map<
    string,
    {
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly source: ArtifactSource;
    }
  >();
  return {
    async write(input) {
      const bytes = Uint8Array.from(input.bytes);
      const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      artifacts.set(id, { bytes, mediaType: input.mediaType, source: input.source });
      return {
        id,
        mediaType: input.mediaType,
        byteCount: bytes.byteLength,
        source: input.source,
      };
    },
    async read(id, options) {
      const bytes = artifacts.get(id)?.bytes;
      if (
        bytes === undefined ||
        (options?.maximumBytes !== undefined && bytes.byteLength > options.maximumBytes)
      ) {
        return undefined;
      }
      return Uint8Array.from(bytes);
    },
    async flushTo(store) {
      for (const [id, artifact] of artifacts) {
        const persisted = await store.write(artifact);
        if (persisted.id !== id) {
          throw new SessionLifecycleError("session_invalid");
        }
      }
    },
  };
}

async function materializeActiveSkillContents(
  options: SessionLifecycleOptions,
  context: SkillContextRecordV1 | undefined,
): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();
  if (context === undefined) {
    return contents;
  }
  const root = join(effectiveSessionStateRoot(options.stateRoot), "artifacts");
  for (const activation of context.active) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFileArtifact({
        root,
        id: activation.artifact.id,
        maximumBytes: activation.byteCount,
      });
    } catch {
      throw new SessionLifecycleError("session_invalid");
    }
    if (
      bytes === undefined ||
      bytes.byteLength !== activation.byteCount ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== activation.skillMdDigest
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SessionLifecycleError("session_invalid");
    }
    contents.set(activation.qualifiedId, content);
  }
  return contents;
}

async function inspectModelResponseArtifactLineage(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<ModelResponseArtifactInspection> {
  const ownInspection = await materializeModelResponseArtifacts(
    options,
    genesis,
    records,
    { allowDegraded: true },
    artifactCache,
  );
  if (ownInspection.degradation !== undefined || genesis.record.lineage === undefined) {
    return ownInspection;
  }
  const { parentGenesis, prefixRecords } = await lineage.readValidatedLineagePrefix(genesis);
  const inherited = await inspectModelResponseArtifactLineage(
    options,
    lineage,
    parentGenesis,
    prefixRecords,
    artifactCache,
  );
  if (inherited.degradation !== undefined) {
    return { ...ownInspection, degradation: inherited.degradation };
  }
  const logicalReferencedBytes =
    inherited.logicalReferencedBytes + ownInspection.logicalReferencedBytes;
  if (
    !Number.isSafeInteger(logicalReferencedBytes) ||
    logicalReferencedBytes > maximumReferencedModelResponseArtifactBytes
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  return {
    ...ownInspection,
    logicalReferencedBytes,
  };
}

async function replayArtifactBytesFromLineage(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<number> {
  const ownInspection = await materializeModelResponseArtifacts(
    options,
    genesis,
    records,
    { allowDegraded: false },
    artifactCache,
  );
  const inheritedBytes =
    genesis.record.lineage === undefined
      ? 0
      : await (async () => {
          const { parentGenesis, prefixRecords } =
            await lineage.readValidatedLineagePrefix(genesis);
          return replayArtifactBytesFromLineage(
            options,
            lineage,
            parentGenesis,
            prefixRecords,
            artifactCache,
          );
        })();
  const total = inheritedBytes + ownInspection.logicalReferencedBytes;
  const configuredMaximum = (
    options as SessionLifecycleOptions & {
      readonly [sessionDurableOutputLimits]?: AgentSessionDurableOutputLimits;
    }
  )[sessionDurableOutputLimits]?.maximumReferencedArtifactBytes;
  const maximumReferencedArtifactBytes =
    configuredMaximum ?? maximumReferencedModelResponseArtifactBytes;
  if (!Number.isSafeInteger(total) || total > maximumReferencedArtifactBytes) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function materializeModelResponseArtifacts(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  behavior: { readonly allowDegraded: boolean },
  artifactCache: ModelResponseArtifactCache,
): Promise<ModelResponseArtifactInspection> {
  const artifactRoot = join(effectiveSessionStateRoot(options.stateRoot), "artifacts");
  const contents = new Map<number, { readonly text: string; readonly reasoning?: string }>();
  const materialized: SessionRecord[] = [];
  let logicalReferencedBytes = 0;

  for (const entry of records) {
    if (
      entry.schemaVersion === 3 &&
      entry.record.type === "logical_run_started" &&
      entry.record.recordVersion === 3
    ) {
      const contents = new Map<string, string>();
      let pastedTextBytes = 0;
      for (const occurrence of entry.record.pastedTexts) {
        const source = occurrence.artifact.source;
        if (
          source.type !== "pasted_text" ||
          source.projectId !== genesis.record.projectId ||
          source.sessionId !== genesis.record.sessionId ||
          source.runId !== entry.record.runId ||
          source.occurrenceId !== occurrence.occurrenceId ||
          occurrence.artifact.id !== occurrence.digest ||
          occurrence.artifact.byteCount !== occurrence.byteCount
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        pastedTextBytes += occurrence.byteCount;
        if (pastedTextBytes > 1_024 * 1_024) {
          throw new SessionLifecycleError("session_invalid");
        }
        let pendingArtifact = artifactCache.get(occurrence.artifact.id);
        if (pendingArtifact === undefined) {
          pendingArtifact = readFileArtifact({
            root: artifactRoot,
            id: occurrence.artifact.id,
            maximumBytes: 1_024 * 1_024,
          }).then((bytes) =>
            bytes === undefined
              ? undefined
              : {
                  byteCount: bytes.byteLength,
                  text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                },
          );
          artifactCache.set(occurrence.artifact.id, pendingArtifact);
        }
        const resolved = await pendingArtifact;
        if (
          resolved === undefined ||
          resolved.byteCount !== occurrence.byteCount ||
          Buffer.byteLength(resolved.text, "utf8") !== occurrence.byteCount
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        const metrics = pastedTextMetricsV1(resolved.text);
        if (
          metrics.lineCount !== occurrence.lineCount ||
          metrics.scalarCount !== occurrence.scalarCount ||
          !isLargePastedTextV1(resolved.text)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        contents.set(occurrence.occurrenceId, resolved.text);
      }
      materialized.push({
        ...entry,
        record: attachPastedTextProjectionContentsV1({ ...entry.record }, contents),
      });
      continue;
    }
    if (entry.schemaVersion !== 3 || entry.record.type !== "model_response_completed") {
      materialized.push(entry);
      continue;
    }
    const responseRecord = entry.record;
    const { response } = responseRecord;
    if (response.recordVersion !== 2) {
      contents.set(entry.sequence, {
        text: response.text,
        ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
      });
      materialized.push(entry);
      continue;
    }
    const declaredTextBytes =
      response.text.storage === "inline"
        ? Buffer.byteLength(response.text.text, "utf8")
        : response.text.reference.byteCount;
    const declaredReasoningBytes =
      response.reasoning === undefined
        ? 0
        : response.reasoning.storage === "inline"
          ? Buffer.byteLength(response.reasoning.text, "utf8")
          : response.reasoning.reference.byteCount;
    if (
      !Number.isSafeInteger(declaredTextBytes + declaredReasoningBytes) ||
      declaredTextBytes + declaredReasoningBytes > maximumModelResponseContentBytes
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const resolveField = async (
      field: SessionModelResponseField,
      fieldKind: "reasoning" | "text",
    ): Promise<
      | { readonly status: "ready"; readonly text: string; readonly referencedBytes: number }
      | { readonly status: "degraded"; readonly degradation: ModelResponseArtifactDegradation }
    > => {
      if (field.storage === "inline") {
        return { status: "ready", text: field.text, referencedBytes: 0 };
      }
      const { reference } = field;
      const source = reference.source;
      const degradation = (
        code: ModelResponseArtifactDegradation["code"],
      ): {
        readonly status: "degraded";
        readonly degradation: ModelResponseArtifactDegradation;
      } => ({
        status: "degraded",
        degradation: {
          code,
          artifactId: reference.id,
          field: fieldKind,
          responseSequence: entry.sequence,
        },
      });
      if (
        reference.byteCount > maximumModelResponseContentBytes ||
        source.field !== fieldKind ||
        source.projectId !== genesis.record.projectId ||
        source.sessionId !== genesis.record.sessionId ||
        source.runId !== responseRecord.runId ||
        source.turn !== responseRecord.turn ||
        source.attempt !== responseRecord.attempt ||
        !sameModelTargetIdentity(source.targetIdentity, responseRecord.targetIdentity)
      ) {
        return degradation("model_response_artifact_corrupt");
      }
      let resolvedArtifact: ResolvedModelResponseArtifact;
      try {
        let pendingArtifact = artifactCache.get(reference.id);
        if (pendingArtifact === undefined) {
          pendingArtifact = readFileArtifact({
            root: artifactRoot,
            id: reference.id,
            maximumBytes: maximumModelResponseContentBytes,
          }).then((bytes) =>
            bytes === undefined
              ? undefined
              : {
                  byteCount: bytes.byteLength,
                  text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                },
          );
          artifactCache.set(reference.id, pendingArtifact);
        }
        resolvedArtifact = await pendingArtifact;
      } catch {
        return degradation("model_response_artifact_corrupt");
      }
      if (resolvedArtifact === undefined) {
        return degradation("model_response_artifact_missing");
      }
      if (resolvedArtifact.byteCount !== reference.byteCount) {
        return degradation("model_response_artifact_corrupt");
      }
      return {
        status: "ready",
        text: resolvedArtifact.text,
        referencedBytes: reference.byteCount,
      };
    };

    const text = await resolveField(response.text, "text");
    if (text.status === "degraded") {
      if (!behavior.allowDegraded) {
        throw new SessionLifecycleError("session_invalid");
      }
      return { contents, degradation: text.degradation, logicalReferencedBytes, records };
    }
    const reasoning =
      response.reasoning === undefined
        ? undefined
        : await resolveField(response.reasoning, "reasoning");
    if (reasoning?.status === "degraded") {
      if (!behavior.allowDegraded) {
        throw new SessionLifecycleError("session_invalid");
      }
      return { contents, degradation: reasoning.degradation, logicalReferencedBytes, records };
    }
    logicalReferencedBytes += text.referencedBytes + (reasoning?.referencedBytes ?? 0);
    if (logicalReferencedBytes > maximumReferencedModelResponseArtifactBytes) {
      throw new SessionLifecycleError("session_invalid");
    }
    const resolvedReasoning = reasoning?.text;
    contents.set(entry.sequence, {
      text: text.text,
      ...(resolvedReasoning === undefined ? {} : { reasoning: resolvedReasoning }),
    });
    materialized.push({
      ...entry,
      record: {
        ...entry.record,
        response: {
          ...response,
          text: { storage: "inline", text: text.text },
          ...(resolvedReasoning === undefined
            ? { reasoning: undefined }
            : { reasoning: { storage: "inline", text: resolvedReasoning } }),
        },
      },
    } as SessionRecord);
  }
  return { contents, logicalReferencedBytes, records: materialized };
}

export function effectiveSessionStateRoot(configured: string | undefined): string {
  if (configured !== undefined) {
    return configured;
  }
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

function createInheritedTodoStoreRecordsV1(input: {
  readonly firstSequence: number;
  readonly snapshot: TodoStoreSnapshotV1;
  readonly source: { readonly sessionId: string; readonly throughSequence: number };
}): readonly SessionTodoStoreInheritedRecord[] {
  const snapshotDigest = todoStoreSnapshotDigestV1(input.snapshot);
  const chunks: TodoItemV1[][] = [];
  let current: TodoItemV1[] = [];
  const recordFor = (items: readonly TodoItemV1[]): SessionTodoStoreInheritedRecord => ({
    schemaVersion: 3,
    sequence: input.firstSequence + todoLimitsV1.maximumEntities - 1,
    record: {
      type: "todo_store_inherited",
      recordVersion: 1,
      policyVersion: input.snapshot.policyVersion,
      storeRevision: input.snapshot.storeRevision,
      chunkIndex: todoLimitsV1.maximumEntities - 1,
      chunkCount: todoLimitsV1.maximumEntities,
      itemOffset: todoLimitsV1.maximumEntities - 1,
      snapshotDigest,
      items,
      source: input.source,
    },
  });
  const conservativeEnvelopeBytes = Buffer.byteLength(JSON.stringify(recordFor([])), "utf8");
  let currentBytes = conservativeEnvelopeBytes;
  for (const item of input.snapshot.items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const candidateBytes = currentBytes + itemBytes + (current.length === 0 ? 0 : 1);
    if (candidateBytes <= maxSessionRecordBytes) {
      current.push(item);
      currentBytes = candidateBytes;
      continue;
    }
    if (current.length === 0) {
      throw new SessionLifecycleError("session_invalid");
    }
    chunks.push(current);
    current = [item];
    currentBytes = conservativeEnvelopeBytes + itemBytes;
    if (currentBytes > maxSessionRecordBytes) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  let itemOffset = 0;
  const records = chunks.map((items, chunkIndex): SessionTodoStoreInheritedRecord => {
    const record: SessionTodoStoreInheritedRecord = {
      schemaVersion: 3,
      sequence: input.firstSequence + chunkIndex,
      record: {
        type: "todo_store_inherited",
        recordVersion: 1,
        policyVersion: input.snapshot.policyVersion,
        storeRevision: input.snapshot.storeRevision,
        chunkIndex,
        chunkCount: chunks.length,
        itemOffset,
        snapshotDigest,
        items,
        source: input.source,
      },
    };
    itemOffset += items.length;
    return record;
  });
  if (records.length === 0 || records.some((record) => !isSessionRecordWithinSizeLimit(record))) {
    throw new SessionLifecycleError("session_invalid");
  }
  return records;
}

function sessionStoreDirectoryFrom(
  options: SessionLifecycleOptions,
): SessionStoreDirectory<SessionRecord> {
  const directory = options[sessionStoreDirectory];
  if (directory === undefined) {
    throw new TypeError("The normalized Session Lifecycle requires a session store directory.");
  }
  return directory;
}

async function readSessionRecords(
  options: SessionLifecycleOptions,
  sessionId: string,
): Promise<readonly SessionRecord[]> {
  const store = await sessionStoreDirectoryFrom(options).open(sessionId);
  return store?.read() ?? [];
}

async function openSessionStore(
  options: SessionLifecycleOptions,
  sessionId: string,
): Promise<SessionStore<SessionRecord>> {
  const store = await sessionStoreDirectoryFrom(options).open(sessionId);
  if (store === undefined) {
    throw new SessionLifecycleError("session_not_found");
  }
  return store;
}

function planToolProfile(
  snapshot: CurrentSessionSnapshot,
  tools: ToolRegistry | undefined,
  policyVersion: PlanPolicyVersion,
): PlanEligibleToolProfileV1 {
  const source = snapshot.promptContext?.toolProfile;
  if (source === undefined || tools === undefined) {
    throw new SessionLifecycleError("session_invalid");
  }
  const mcpSnapshot = snapshot.mcp?.workspaceConfirmed === true ? snapshot.mcp : undefined;
  const mcpProfile =
    mcpSnapshot?.profile === undefined
      ? undefined
      : {
          ...mcpSnapshot.profile,
          tools: mcpSnapshot.profile.tools.map((tool) => {
            const server = mcpSnapshot.servers.find(
              (candidate) => candidate.serverId === tool.serverId,
            );
            if (server === undefined) {
              throw new SessionLifecycleError("session_invalid");
            }
            return { ...tool, serverDefinitionDigest: server.definitionDigest };
          }),
        };
  return planToolProfileFromAuthority(source, tools, mcpProfile, policyVersion);
}

function planToolProfileFromAuthority(
  source: NonNullable<CurrentSessionSnapshot["promptContext"]>["toolProfile"],
  tools: ToolRegistry,
  mcpProfile:
    | {
        readonly digest: `sha256:${string}`;
        readonly tools: readonly {
          readonly qualifiedName: string;
          readonly serverId: string;
          readonly originalName: string;
          readonly serverDefinitionDigest: `sha256:${string}`;
          readonly definitionDigest: `sha256:${string}`;
          readonly effect: ToolEffect;
        }[];
      }
    | undefined,
  policyVersion: PlanPolicyVersion,
): PlanEligibleToolProfileV1 {
  const mcpTools = new Map(
    mcpProfile?.tools.map((tool) => [tool.qualifiedName, tool] as const) ?? [],
  );
  const definitions: PlanEligibleToolProfileV1["definitions"][number][] = [];
  for (const definition of source.definitions) {
    const mcp = mcpTools.get(definition.name);
    if (mcp !== undefined) {
      if (
        mcp.effect === "read" ||
        (policyVersion === "plan-policy.hybrid-v1" &&
          (mcp.effect === "execute" || mcp.effect === "network"))
      ) {
        definitions.push({
          name: definition.name,
          definitionDigest: mcp.definitionDigest,
          effect: mcp.effect,
          source: "mcp",
          ...(policyVersion === "plan-policy.hybrid-v1"
            ? {
                mcp: {
                  serverId: mcp.serverId,
                  originalName: mcp.originalName,
                  serverDefinitionDigest: mcp.serverDefinitionDigest,
                },
              }
            : {}),
        });
      }
      continue;
    }
    const adapter = tools.resolve(definition.name);
    if (adapter === undefined || !/^sha256:[0-9a-f]{64}$/u.test(adapter.definitionDigest)) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (
      adapter.effect === "read" ||
      (policyVersion === "plan-policy.hybrid-v1" &&
        definition.name === "run_shell" &&
        adapter.effect === "execute")
    ) {
      definitions.push({
        name: definition.name,
        definitionDigest: adapter.definitionDigest as `sha256:${string}`,
        effect: adapter.effect,
        source: "builtin",
      });
    }
  }
  return createPlanToolProfileV1({
    source: { version: source.version, digest: source.digest },
    definitions,
  });
}

async function validatePlanToolProfilesFromLineage(
  options: SessionLifecycleOptions,
  lineage: SessionLineageTraversal,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<void> {
  if (options.tools === undefined) {
    throw new SessionLifecycleError("session_invalid");
  }
  for (const entry of records) {
    if (
      entry.schemaVersion !== 3 ||
      (entry.record.type !== "plan_cycle_entered" && entry.record.type !== "plan_cycle_inherited")
    ) {
      continue;
    }
    const prefix = records.filter((candidate) => candidate.sequence < entry.sequence);
    const promptContext = promptContextRecordFromRecords(genesis, prefix);
    if (promptContext === undefined) {
      throw new SessionLifecycleError("session_invalid");
    }
    const mcpProfile = await mcpCommittedProfileFromLineage(lineage, genesis, prefix);
    if (
      (promptContext.recordVersion === 3 && promptContext.mcp !== undefined) !==
        (mcpProfile !== undefined) ||
      (promptContext.recordVersion === 3 &&
        promptContext.mcp !== undefined &&
        promptContext.mcp.profileDigest !== mcpProfile?.digest)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const expected = planToolProfileFromAuthority(
      promptContext.toolProfile,
      options.tools,
      mcpProfile,
      entry.record.policyVersion,
    );
    if (!isDeepStrictEqual(entry.record.eligibleToolProfile, expected)) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
}

function draftSkillSelectionsAreValid(selections: readonly string[]): boolean {
  return (
    selections.length <= 8 &&
    selections.every(
      (selection) =>
        selection.length > 0 &&
        Buffer.byteLength(selection, "utf8") <= 16_384 &&
        /^[\x20-\x7e]+$/u.test(selection),
    )
  );
}

function draftRunLimitsAreValid(limits: RunOptions["limits"]): boolean {
  return (
    (limits?.maxTurns === undefined ||
      (Number.isSafeInteger(limits.maxTurns) && limits.maxTurns > 0)) &&
    (limits?.maxTokens === undefined ||
      (Number.isSafeInteger(limits.maxTokens) && limits.maxTokens > 0))
  );
}
