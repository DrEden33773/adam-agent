import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentSession } from "./agent-session.js";
import type {
  ContextUsageTotals,
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
  type ContextEvidenceV1,
  createContextProjectionMessage,
  estimateActiveContextTokens,
  mergeContextEvidence,
  reduceContextEvidence,
} from "./durable-context.js";
import {
  maximumModelResponseContentBytes,
  maximumReferencedModelResponseArtifactBytes,
} from "./durable-model-response-policy.js";
import {
  type ExtensionHost,
  loadInternalExtensionSkillSources,
  withInternalExtensionSkillSourcesCurrent,
} from "./extension-host.js";
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
  type McpToolProfileV1,
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
import {
  type ModelTargetIdentity,
  type ModelTargets,
  sameModelTargetIdentity,
} from "./model-targets.js";
import {
  createProjectLifecycleOwner,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
} from "./project-lifecycle-owner.js";
import {
  assemblePromptMessagesV1,
  commitMcpToolProfileV3,
  createPromptContextV3,
  digestPromptRequestV1,
  hasSkillPromptContext,
  isPromptContextCompatible,
  isPromptContextRecordCompatible,
  isPromptContextRecordValid,
  type PromptContextRecordV1,
  type PromptContextRecordV2,
  type PromptContextRecordV3,
  type PromptContextSnapshot,
  promptContextSnapshot,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import {
  loadInitialRepositoryInstructions,
  loadRepositoryInstructions,
  RepositoryInstructionsError,
} from "./repository-instructions.js";
import {
  type AgentSessionDurableContext,
  type AgentSessionDurableOutputLimits,
  sessionDurableContext,
  sessionDurableOutputLimits,
} from "./session-durable-context.js";
import {
  isSkillActivationBatchTransitionValid,
  isSkillContextCatalogSuccessor,
  isSkillContextPathSuccessor,
} from "./session-history-folds.js";
import {
  inlineModelResponseField,
  modelMessagesFromCanonicalRecords,
  modelMessagesFromCompleteRecords,
} from "./session-history-replay.js";
import {
  hasSuccessfullySettledAssistant,
  validateCurrentSessionHistory,
} from "./session-history-validation.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { normalizedSessionTitle, sessionTitleFallback } from "./session-naming.js";
import {
  createJsonlSessionStoreDirectory,
  type SessionGenesisRecord,
  type SessionMcpWorkspaceConfirmedRecord,
  type SessionModelResponseField,
  type SessionRecord,
  type SessionStore,
  type SessionStoreDirectory,
} from "./session-store.js";
import {
  buildSkillResourceManifestV1,
  createInitialSkillContextV1,
  type ExtensionSkillSourceV1,
  isSkillContextRecordV1Valid,
  reconcileExtensionSkillContextV1,
  reloadSkillContextV1,
  type SkillContextRecordV1,
  type SkillContextSnapshot,
  type SkillResourceManifestV1,
  skillContextSnapshot,
} from "./skills.js";
import {
  resolveThinkingPolicy,
  ThinkingPolicyError,
  type ThinkingPolicySelectionV1,
  type ThinkingPolicySnapshotV1,
} from "./thinking-policy.js";
import {
  createCodingToolRegistry,
  type PermissionPolicy,
  type ToolEffect,
  type ToolRegistry,
} from "./tool-runtime.js";

export type { McpSessionSnapshot } from "./mcp-host.js";
export { SessionLifecycleError } from "./session-lifecycle-error.js";

export type CurrentSessionSnapshot = {
  readonly schemaVersion: 3;
  readonly sessionId: string;
  readonly projectId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly status: "idle" | "interrupted" | "settled";
  readonly lastSequence: number;
  readonly mcp?: McpSessionSnapshot;
  readonly promptContext?: PromptContextSnapshot;
  readonly skillContext?: SkillContextSnapshot;
  readonly context?: SessionContextSnapshot;
  readonly degradation?: {
    readonly code: "model_response_artifact_corrupt" | "model_response_artifact_missing";
    readonly artifactId: string;
    readonly field: "reasoning" | "text";
    readonly responseSequence: number;
  };
  readonly lineage?: SessionGenesisRecord["record"]["lineage"];
  readonly run?: {
    readonly runId: string;
    readonly status: "interrupted" | "settled";
    readonly result?: RunResult;
    readonly lastAttempt?: {
      readonly turn: number;
      readonly attempt: number;
      readonly status: "started" | "interrupted" | "completed";
    };
    readonly lastCompletedResponse?: {
      readonly turn: number;
      readonly attempt: number;
      readonly finishReason: "length" | "stop" | "tool_calls";
    };
  };
};

export type SessionContextSnapshot = {
  readonly profile: ContextProfile;
  readonly checkpoint?: {
    readonly checkpointId: string;
    readonly sequence: number;
    readonly windowNumber: number;
    readonly status: "committed";
    readonly sourceThrough: number;
    readonly retainedFrom: number;
  };
  readonly lastAttempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly windowNumber: number;
    readonly status: "started" | "committed" | "failed" | "interrupted";
    readonly reason?: string;
    readonly usage:
      | { readonly status: "unknown" }
      | {
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly reasoningTokens?: number;
          readonly cachedInputTokens?: number;
          readonly cacheMissInputTokens?: number;
        };
  };
  readonly ordinaryUsage: ContextUsageTotals;
  readonly compactionUsage: ContextUsageTotals;
  readonly active:
    | { readonly source: "provider_reported"; readonly tokens: number }
    | { readonly source: "estimated"; readonly tokens: number }
    | { readonly source: "unknown" };
};

export type SessionContextUsageSnapshot = Pick<
  SessionContextSnapshot,
  "active" | "compactionUsage" | "ordinaryUsage"
>;

export type LegacySessionSnapshot = {
  readonly schemaVersion: 1 | 2;
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: "legacy";
  readonly lastSequence: number;
};

export type SessionSnapshot = CurrentSessionSnapshot | LegacySessionSnapshot;

export type SessionResumeResult =
  | { readonly status: "ready"; readonly snapshot: CurrentSessionSnapshot }
  | {
      readonly status: "rejected";
      readonly snapshot: SessionSnapshot;
      readonly error: {
        readonly code:
          | "model_target_incompatible"
          | "model_target_unavailable"
          | "prompt_profile_incompatible"
          | "non_resumable_legacy_session"
          | "session_replay_unavailable";
        readonly message: string;
      };
    };

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

/** Tests only. Production lifecycle instances always default automatic titles on. */
export const sessionAutomaticTitlesEnabled = Symbol("adam-agent.session-automatic-titles-enabled");

/** Tests only. Production lifecycle instances use the OS-backed project owner. */
export const sessionProjectLifecycleOwner = Symbol("adam-agent.session-project-lifecycle-owner");

/** Tests only. Production lifecycle instances use the JSONL session directory. */
export const sessionStoreDirectory = Symbol("adam-agent.session-store-directory");

/** Tests only. Production publishes each exact runtime notification once. */
export const sessionRuntimeNotificationTransform = Symbol(
  "adam-agent.session-runtime-notification-transform",
);

export type SessionRuntimeNotificationTransform = {
  project(notification: SessionRuntimeNotification): readonly SessionRuntimeNotification[];
};

export type SessionLifecycleOptions = {
  readonly extensionHost?: ExtensionHost;
  readonly modelTargets?: ModelTargets;
  readonly permissions?: PermissionPolicy;
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
  readonly tools?: ToolRegistry;
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
  readonly [sessionAutomaticTitlesEnabled]?: boolean;
  readonly [sessionProjectLifecycleOwner]?: ProjectLifecycleOwner;
  readonly [sessionStoreDirectory]?: SessionStoreDirectory<SessionRecord>;
  readonly [sessionRuntimeNotificationTransform]?: SessionRuntimeNotificationTransform;
};

export type SessionContinueResult = {
  readonly result: RunResult;
  readonly snapshot: CurrentSessionSnapshot;
};

export type NewSessionDraftSnapshot = {
  readonly targetIdentity: ModelTargetIdentity;
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
    }
  | ({
      readonly type: "branch";
    } & SessionBranchInput)
  | { readonly type: "reload_repository_instructions"; readonly sessionId: string }
  | { readonly type: "reload_skills"; readonly sessionId: string }
  | McpConfigurationCommand;

export interface SessionLifecycle {
  admit(input: {
    readonly targetIdentity: ModelTargetIdentity;
    readonly input: UserInput;
    readonly limits?: RunOptions["limits"];
    readonly runId?: string;
    readonly signal?: AbortSignal;
    readonly thinkingSelection?: ThinkingPolicySelectionV1;
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
  }): Promise<SessionContinueResult>;
  configureMcp(command: McpConfigurationCommand): Promise<McpConfigurationResult>;
  create(input: { readonly targetIdentity: ModelTargetIdentity }): Promise<CurrentSessionSnapshot>;
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
  enableAutomaticTitles(): void;
  ensureAutomaticTitle(input: { readonly sessionId: string }): Promise<SessionNamingResult>;
  inspect(input: { readonly sessionId: string }): Promise<SessionSnapshot>;
  inspectContextUsage(input: {
    readonly sessionId: string;
  }): Promise<SessionContextUsageSnapshot | null>;
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
  const listeners = new Set<RuntimeEventListener>();
  const sessionEventListeners = new Set<SessionRuntimeNotificationListener>();
  const metadataListeners = new Set<SessionMetadataListener>();
  let activeSession: AgentSession | undefined;
  let activeSessionSettlement: Promise<void> | undefined;
  let lifecycleClosing = false;
  let automaticTitlesEnabled = options[sessionAutomaticTitlesEnabled] ?? true;
  let lifecycleClosePromise: Promise<McpCloseResult> | undefined;
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
  const owner = options[sessionProjectLifecycleOwner] ?? createProjectLifecycleOwner(options);
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
  const closePreparedMcpActivation = async (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly cause: unknown;
  }): Promise<McpHostError> => {
    try {
      const closed = await mcpHost.closePreparedActivation(input);
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
  let trackedOwnerOperation:
    | { readonly kind: "ordinary" | "title"; readonly settlement: Promise<void> }
    | undefined;
  const executeWithOwner = async <T>(
    kind: "ordinary" | "title",
    operation: () => Promise<T>,
  ): Promise<T> => {
    const active = trackedOwnerOperation;
    if (active !== undefined && (kind === "title" || active.kind === "title")) {
      await active.settlement;
    }
    const operationPromise = owner.run(operation);
    let trackedSettlement: Promise<void> | undefined;
    if (trackedOwnerOperation === undefined) {
      trackedSettlement = operationPromise.then(
        () => undefined,
        () => undefined,
      );
      trackedOwnerOperation = { kind, settlement: trackedSettlement };
    }
    try {
      return await operationPromise;
    } catch (error) {
      if (error instanceof ProjectLifecycleOwnerError) {
        throw new SessionLifecycleError(error.code);
      }
      throw error;
    } finally {
      if (trackedOwnerOperation?.settlement === trackedSettlement) {
        trackedOwnerOperation = undefined;
      }
    }
  };
  const runWithOwner = <T>(operation: () => Promise<T>): Promise<T> =>
    executeWithOwner("ordinary", operation);
  const runTitleWithOwner = <T>(operation: () => Promise<T>): Promise<T> =>
    executeWithOwner("title", operation);
  const withOwner = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycleClosing) {
      throw new SessionLifecycleError("session_invalid");
    }
    return runWithOwner(operation);
  };
  const titleOperations = new Set<Promise<void>>();
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
    if (!automaticTitlesEnabled || !eligible) {
      return undefined;
    }
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
    await validateSessionLineage(options, first, new Set([input.sessionId]));
    await validateMcpAuthorityFromLineage(options, first, records);
    await skillResourceBytesFromLineage(options, first, records);
    await validateInheritedContextEvidence(options, first, records);
    const artifactInspection = await inspectModelResponseArtifactLineage(
      options,
      first,
      records,
      artifactCache,
    );
    if (artifactInspection.degradation === undefined) {
      await validatePromptProjectionDigests(
        options,
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
        ? await contextSnapshotFromLineage(options, first, replayRecords, artifactCache)
        : undefined;
    const [mcpWorkspaceConfirmation, mcpServerApprovals, mcpCommittedProfile, mcpCatalogState] =
      await Promise.all([
        mcpWorkspaceConfirmationFromLineage(options, first, records),
        mcpServerApprovalsFromLineage(options, first, records),
        mcpCommittedProfileFromLineage(options, first, records),
        mcpCatalogStateFromLineage(options, first, records),
      ]);
    let mcp: McpSessionSnapshot | undefined;
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
    await validateSessionLineage(options, first, new Set([input.sessionId]));
    await validateInheritedContextEvidence(options, first, records);
    const artifactInspection = await inspectModelResponseArtifactLineage(
      options,
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
      let compatibleTools = options.tools;
      if (activePromptContext?.recordVersion === 3 && activePromptContext.mcp !== undefined) {
        const profile =
          promptGenesis === undefined || !isGenesisRecord(promptGenesis)
            ? undefined
            : await mcpCommittedProfileFromLineage(options, promptGenesis, promptRecords);
        if (profile === undefined || profile.digest !== activePromptContext.mcp.profileDigest) {
          throw new SessionLifecycleError("session_invalid");
        }
        compatibleTools = combineToolRegistries(
          options.tools,
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
        target.contextProfile.version !== snapshot.targetIdentity.profileVersion ||
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
      if (
        snapshot.context !== undefined &&
        JSON.stringify(target.contextProfile) !== JSON.stringify(snapshot.context.profile)
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
    let mcp: McpSessionSnapshot | undefined;
    try {
      mcp = await inspectMcpConfiguration(options.workspaceRoot);
    } catch (error) {
      if (error instanceof McpConfigurationError) {
        throw new SessionLifecycleError("mcp_config_invalid");
      }
      throw error;
    }
    const sessionId = randomUUID();
    const projectId = await canonicalProjectId(options.workspaceRoot);
    const repository = await loadInitialRepositoryInstructions({
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
          sessionId,
          projectId,
          targetIdentity: input.targetIdentity,
          promptContext: createPromptContextV3(options.tools, repository, skillContext),
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
        input.input.text.trim().length === 0 ||
        !draftRunLimitsAreValid(input.limits) ||
        options.modelTargets === undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const created = await withOwner(async () => {
        const resolved = await options.modelTargets?.resolve({
          targetId: input.targetIdentity.targetId,
          targetIdentity: input.targetIdentity,
          allowExperimental: input.targetIdentity.certification === "experimental",
          signal: input.signal ?? new AbortController().signal,
        });
        if (
          resolved === undefined ||
          !sameModelTargetIdentity(resolved.identity, input.targetIdentity) ||
          resolved.contextProfile.version !== input.targetIdentity.profileVersion ||
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
          !(await sessionInheritsSourceBoundary(
            options,
            parentGenesisRecord,
            sourceSessionId,
            sourceEventPosition,
            new Set(),
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
        await validateMcpAuthorityFromLineage(options, parentGenesis, parentPrefix);
        await replayArtifactBytesFromLineage(options, parentGenesis, parentPrefix, artifactCache);
        if (!isCompleteBranchBoundary(parentPrefix)) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const parentPromptContext = promptContextRecordFromRecords(parentGenesis, parentPrefix);
        const parentSkillContext = skillContextRecordFromRecords(parentGenesis, parentPrefix);
        let targetIdentity = parent.targetIdentity;
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
          if (
            (await modelResponseTargetsFromBranchContext(options, parentPrefix)).some(
              (identity) => !areReplayProfilesCompatible(target.identity, identity),
            )
          ) {
            throw new SessionLifecycleError("session_model_target_incompatible");
          }
          targetIdentity = target.identity;
        }
        const sessionId = randomUUID();
        const store = await sessionStoreDirectoryFrom(options).create(sessionId);
        const prefix = `${parentPrefix.map((record) => JSON.stringify(record)).join("\n")}\n`;
        const branchFallback = sessionTitleFallback(
          `Branch of ${sessionDisplayLabelFromRecords(parentRecords)}`,
        );
        const genesis: SessionGenesisRecord = {
          schemaVersion: 3,
          sequence: 1,
          record: {
            type: "session_genesis",
            sessionId,
            projectId: parent.projectId,
            targetIdentity,
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
            let nextSequence = 2;
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
        await Promise.allSettled(titleOperations);
        await Promise.allSettled(pendingMcpCatalogDurability.values());
        for (const timer of mcpIdleTimers.values()) {
          timer.cancel();
        }
        mcpIdleTimers.clear();
        await Promise.allSettled(mcpIdleOperations.values());
        const hostResult = await mcpHost.close();
        await Promise.allSettled(activeMcpConfigurationOperations.values());
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
      return withOwner(async () =>
        persistPreparedSession(
          await prepareSessionCreation({ targetIdentity: input.targetIdentity }),
        ),
      );
    },
    async continue(input) {
      if (input.runId !== undefined && !z.uuid().safeParse(input.runId).success) {
        throw new SessionLifecycleError("session_invalid");
      }
      disarmMcpIdle(input.sessionId);
      await waitForMcpIdleOperation(input.sessionId);
      const continued = await withOwner(async () => {
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
        if (resumed.snapshot.status === "settled" && input.input === undefined) {
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
        if (resumed.snapshot.status === "interrupted" && input.input !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        if (options.modelTargets === undefined) {
          throw new SessionLifecycleError("session_model_target_unavailable");
        }
        const preparedAdmission = preparedAdmissionTargets.get(input.sessionId);
        const resolved =
          preparedAdmission !== undefined && preparedAdmission.runId === input.runId
            ? preparedAdmission.resolved
            : await options.modelTargets.resolve({
                targetId: resumed.snapshot.targetIdentity.targetId,
                targetIdentity: resumed.snapshot.targetIdentity,
                allowExperimental: resumed.snapshot.targetIdentity.certification === "experimental",
                signal: input.signal ?? new AbortController().signal,
              });
        if (
          !sameModelTargetIdentity(resolved.identity, resumed.snapshot.targetIdentity) ||
          resolved.contextProfile.version !== resumed.snapshot.targetIdentity.profileVersion ||
          !isContextProfileSupported(resolved.contextProfile)
        ) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        if (input.input === undefined && input.thinkingSelection !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const newRunThinkingPolicy =
          input.input === undefined
            ? undefined
            : preparedAdmission !== undefined && preparedAdmission.runId === input.runId
              ? preparedAdmission.thinkingPolicy
              : resolveRunThinkingPolicy(resolved, input.thinkingSelection);
        let records = await readSessionRecords(options, input.sessionId);
        const first = records[0];
        if (first === undefined || !isGenesisRecord(first)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const persistedPromptContext = promptContextRecordFromRecords(first, records);
        let committedMcpProfile: McpToolProfileV1 | undefined;
        if (
          persistedPromptContext?.recordVersion === 3 &&
          persistedPromptContext.mcp !== undefined
        ) {
          const profile = requireMcpCommittedProfile(
            await mcpCommittedProfileFromLineage(options, first, records),
            persistedPromptContext,
          );
          committedMcpProfile = profile;
          if (mcpHost.snapshot(input.sessionId)?.profile?.digest !== profile.digest) {
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
              const live = await mcpHost.reactivateToolProfile({
                sessionId: input.sessionId,
                generationId,
                attempt,
                servers: selectedServers,
                profile,
              });
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
        const referencedModelResponseArtifactBytes = await replayArtifactBytesFromLineage(
          options,
          first,
          records,
          artifactCache,
        );
        const skillResourceLineageBytes = await skillResourceBytesFromLineage(
          options,
          first,
          replayRecords,
        );
        const [inheritedMessages, inheritedEvidence] = await Promise.all([
          createBranchMessages(options, records, artifactCache),
          createBranchEvidence(options, records),
        ]);
        const resumeState =
          resumed.snapshot.status === "interrupted"
            ? createAgentResumeState(replayRecords, options, resumed.snapshot)
            : undefined;
        const recoveredThinkingPolicy =
          resumeState?.thinkingPolicy === undefined
            ? undefined
            : requireRecoveredThinkingPolicy(resolved, resumeState.thinkingPolicy);
        if (
          input.runId !== undefined &&
          (input.input === undefined ||
            resumeState !== undefined ||
            replayRecords.some(
              (record) =>
                record.schemaVersion === 3 &&
                "runId" in record.record &&
                record.record.runId === input.runId,
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
        if (resumeState === undefined && input.input === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const store = await openSessionStore(options, input.sessionId);
        const durableOutputLimits = (
          options as SessionLifecycleOptions & {
            readonly [sessionDurableOutputLimits]?: AgentSessionDurableOutputLimits;
          }
        )[sessionDurableOutputLimits];
        const artifactStore = await createFileArtifactStore({
          root: join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
        });
        const sessionDependencies = {
          artifactStore,
          model: resolved.driver,
          store: store as unknown as SessionStore,
          [sessionDurableContext]: {
            ...(initialMessages.length === 0 ? {} : { hasInheritedMessages: true }),
            nextSequence: (replayRecords.at(-1)?.sequence ?? resumed.snapshot.lastSequence) + 1,
            ...(input.runId === undefined ? {} : { newRunId: input.runId }),
            projectId: resumed.snapshot.projectId,
            referencedModelResponseArtifactBytes,
            skillResourceLineageBytes,
            ...(resumeState === undefined
              ? {}
              : {
                  skillResourceRunBytes: skillResourceBytesForRun(
                    replayRecords,
                    resumeState.agentState.runId,
                  ),
                }),
            ...(activePromptContext === undefined
              ? {}
              : { repositoryWorkspaceRoot: options.workspaceRoot }),
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
            ...(hasContextEvidence(inheritedEvidence) ? { inheritedEvidence } : {}),
            ...(resumeState !== undefined || initialMessages.length === 0
              ? {}
              : { initialMessages }),
            ...(durableResumeState === undefined ? {} : { resume: durableResumeState }),
          },
          contextProfile: resolved.contextProfile,
          ...(durableOutputLimits === undefined
            ? {}
            : { [sessionDurableOutputLimits]: durableOutputLimits }),
          ...(options.tools === undefined
            ? {}
            : {
                tools:
                  activePromptContext?.recordVersion === 3 && activePromptContext.mcp !== undefined
                    ? combineToolRegistries(
                        options.tools,
                        mcpHost.toolRegistry(
                          input.sessionId,
                          requireMcpCommittedProfile(committedMcpProfile, activePromptContext),
                          artifactStore,
                        ),
                      )
                    : options.tools,
              }),
          ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        };
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
        try {
          const runLimits = resumeState?.limits ?? input.limits;
          const result = await session.run(
            input.input ?? { text: resumeState?.userMessage ?? "" },
            {
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(runLimits === undefined ? {} : { limits: runLimits }),
            },
          );
          await flushPendingMcpCatalogChanges(input.sessionId);
          const snapshot = await inspectSession({ sessionId: input.sessionId }, artifactCache);
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return { result, snapshot };
        } finally {
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
      });
      const titleSnapshot = await startAutomaticTitle(
        input.sessionId,
        continued.snapshot,
        continued.result.status === "completed" && continued.result.answer.length > 0,
      );
      return titleSnapshot === undefined ? continued : { ...continued, snapshot: titleSnapshot };
    },
    async configureMcp(command) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
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
        return withOwner(async () => {
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
              await mcpCommittedProfileFromLineage(options, genesis, activationRecords),
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
            const live =
              reactivationProfile === undefined
                ? await mcpHost.activate({
                    sessionId: command.sessionId,
                    generationId,
                    attempt,
                    servers: selectedServers,
                  })
                : await mcpHost.reactivateToolProfile({
                    sessionId: command.sessionId,
                    generationId,
                    attempt,
                    servers: selectedServers,
                    profile: reactivationProfile,
                  });
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
            const live = await mcpHost.activate({
              sessionId: command.sessionId,
              generationId,
              attempt,
              servers: selectedServers,
            });
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
          const profile = await mcpCommittedProfileFromLineage(options, genesis, records);
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
    async inspectContextUsage(input) {
      await prepareSessionInspection(input.sessionId);
      return inspectSessionContextUsage(input);
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
          target.contextProfile.version !== input.targetIdentity.profileVersion ||
          !isContextProfileSupported(target.contextProfile)
        ) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        const projectId = await canonicalProjectId(options.workspaceRoot);
        const extensionSources = await resolveExtensionSkillSources(options);
        const skillContext = await createInitialSkillContextV1({
          artifactStore: createStagedArtifactStore(),
          effectiveContextTokens: target.contextProfile.contextWindowTokens,
          estimatorVersion: target.contextProfile.estimatorVersion,
          projectId,
          sessionId: randomUUID(),
          userHome: homedir(),
          workspaceRoot: options.workspaceRoot,
          extensionSources,
        });
        return {
          targetIdentity: input.targetIdentity,
          skillContext: skillContextSnapshot(skillContext),
        };
      });
    },
    async reloadRepositoryInstructions(input) {
      if (activeSession !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      return withOwner(async () => {
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
      if (activeSession !== undefined || activeTitleSessions.has(input.sessionId)) {
        throw new SessionLifecycleError("session_invalid");
      }
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

function isGenesisRecord(record: SessionRecord): record is SessionGenesisRecord {
  return record.schemaVersion === 3 && record.record.type === "session_genesis";
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

function sessionDisplayLabelFromRecords(records: readonly SessionRecord[]): string {
  const genesis = records[0];
  let fallbackTitle =
    genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
      ? (genesis.record.naming?.fallbackTitle ?? null)
      : null;
  let manualName: string | null = null;
  let generatedTitle: string | null = null;
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "logical_run_started" && fallbackTitle === null) {
      fallbackTitle =
        entry.record.naming?.fallbackTitle ?? sessionTitleFallback(entry.record.userMessage);
    } else if (entry.record.type === "session_manual_name_set") {
      manualName = entry.record.name;
    } else if (entry.record.type === "session_manual_name_cleared") {
      manualName = null;
    } else if (entry.record.type === "session_title_generation_completed") {
      generatedTitle = entry.record.title;
    }
  }
  return manualName ?? generatedTitle ?? fallbackTitle ?? "New session";
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
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<SessionMcpWorkspaceConfirmedRecord["record"] | undefined> {
  const own = mcpWorkspaceConfirmationFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  return mcpWorkspaceConfirmationFromLineage(options, parentGenesis, prefixRecords);
}

async function mcpServerApprovalsFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<ReadonlyMap<string, `sha256:${string}`>> {
  const approvals =
    genesis.record.lineage === undefined
      ? new Map<string, `sha256:${string}`>()
      : new Map(
          await (async () => {
            const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(
              options,
              genesis,
            );
            return mcpServerApprovalsFromLineage(options, parentGenesis, prefixRecords);
          })(),
        );
  for (const [serverId, digest] of mcpServerApprovalsFromRecords(records)) {
    approvals.set(serverId, digest);
  }
  return approvals;
}

async function mcpCommittedProfileFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<McpToolProfileV1 | undefined> {
  const own = mcpCommittedProfileFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  return mcpCommittedProfileFromLineage(options, parentGenesis, prefixRecords);
}

async function mcpCatalogStateFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<"ready" | "stale" | "shutdown_unconfirmed" | undefined> {
  const own = mcpCatalogStateFromRecords(records);
  if (own !== undefined || genesis.record.lineage === undefined) {
    return own;
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  return mcpCatalogStateFromLineage(options, parentGenesis, prefixRecords);
}

type McpLineageAuthority = {
  confirmation?: SessionMcpWorkspaceConfirmedRecord["record"];
  readonly approvals: Map<string, `sha256:${string}`>;
  profile?: McpToolProfileV1;
};

async function validateMcpAuthorityFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<McpLineageAuthority> {
  let inherited: McpLineageAuthority = { approvals: new Map() };
  if (genesis.record.lineage !== undefined) {
    const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
    inherited = await validateMcpAuthorityFromLineage(options, parentGenesis, prefixRecords);
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

async function validateSessionLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  visited: ReadonlySet<string>,
): Promise<void> {
  const lineage = genesis.record.lineage;
  if (lineage === undefined) {
    return;
  }
  if (visited.has(lineage.parentSessionId)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  const expectedPromptContext = promptContextRecordFromRecords(parentGenesis, prefixRecords);
  if (!isDeepStrictEqual(genesis.record.promptContext, expectedPromptContext)) {
    throw new SessionLifecycleError("session_invalid");
  }
  await validateInheritedContextEvidence(options, parentGenesis, prefixRecords);
  if ("recordVersion" in lineage) {
    const declaredParentRecords = await readSessionRecords(options, lineage.parentSessionId);
    const declaredParentGenesis = declaredParentRecords[0];
    if (declaredParentGenesis === undefined || !isGenesisRecord(declaredParentGenesis)) {
      throw new SessionLifecycleError("session_invalid");
    }
    await validateSessionLineage(
      options,
      declaredParentGenesis,
      new Set([...visited, lineage.parentSessionId]),
    );
    return;
  }
  await validateSessionLineage(
    options,
    parentGenesis,
    new Set([...visited, lineage.parentSessionId]),
  );
}

async function sessionInheritsSourceBoundary(
  options: SessionLifecycleOptions,
  sessionGenesis: SessionGenesisRecord,
  sourceSessionId: string,
  sourceEventPosition: number,
  visited: ReadonlySet<string>,
): Promise<boolean> {
  if (visited.has(sessionGenesis.record.sessionId)) {
    return false;
  }
  if (sessionGenesis.record.sessionId === sourceSessionId) {
    const ownRecords = await readSessionRecords(options, sourceSessionId);
    return sourceEventPosition <= ownRecords.length;
  }
  const lineage = sessionGenesis.record.lineage;
  if (lineage === undefined) {
    return false;
  }
  const inheritedSessionId =
    "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
  const inheritedEventPosition =
    "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
  if (sourceSessionId === inheritedSessionId) {
    return sourceEventPosition <= inheritedEventPosition;
  }
  const inheritedRecords = await readSessionRecords(options, inheritedSessionId);
  const inheritedGenesis = inheritedRecords[0];
  if (inheritedGenesis === undefined || !isGenesisRecord(inheritedGenesis)) {
    return false;
  }
  return sessionInheritsSourceBoundary(
    options,
    inheritedGenesis,
    sourceSessionId,
    sourceEventPosition,
    new Set([...visited, sessionGenesis.record.sessionId]),
  );
}

async function validateInheritedContextEvidence(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): Promise<void> {
  const expected = await createBranchEvidence(options, records);
  for (const entry of records) {
    if (entry.schemaVersion !== 3 || entry.record.type !== "context_compaction_committed") {
      continue;
    }
    const actual = inheritedContextEvidence(entry.record.evidence);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
  if (genesis.record.lineage === undefined && hasContextEvidence(expected)) {
    throw new SessionLifecycleError("session_invalid");
  }
}

async function contextSnapshotFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<SessionContextSnapshot | undefined> {
  const ownContext = contextSnapshotFromRecords(records);
  if (ownContext !== undefined || genesis.record.lineage === undefined) {
    return ownContext;
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    parentGenesis,
    prefixRecords,
    { allowDegraded: false },
    artifactCache,
  );
  return contextSnapshotFromLineage(
    options,
    parentGenesis,
    artifactInspection.records,
    artifactCache,
  );
}

async function contextUsageSnapshotFromLineage(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<SessionContextUsageSnapshot | undefined> {
  const ownUsage = contextUsageSnapshotFromRecords(records);
  if (genesis.record.lineage === undefined) {
    return ownUsage;
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  const artifactInspection = await materializeModelResponseArtifacts(
    options,
    parentGenesis,
    prefixRecords,
    { allowDegraded: false },
    artifactCache,
  );
  const inheritedUsage = await contextUsageSnapshotFromLineage(
    options,
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
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<ModelMessage[]> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const lineage = genesis.record.lineage;
  if (lineage === undefined) {
    return [];
  }
  const { parentGenesis, prefixRecords: parentRecords } = await readValidatedLineagePrefix(
    options,
    genesis,
  );
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
  return [...(await createBranchMessages(options, parentRecords, artifactCache)), ...projected];
}

async function validatePromptProjectionDigests(
  options: SessionLifecycleOptions,
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactCache: ModelResponseArtifactCache,
): Promise<void> {
  if (genesis.record.promptContext === undefined) {
    return;
  }
  const inheritedMessages = await createBranchMessages(options, records, artifactCache);
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
    const messages = assemblePromptMessagesV1(
      transcript,
      context,
      skillContext,
      activeSkillContents,
    );
    const tools = context.toolProfile.definitions.map(({ definition }) => definition);
    if (
      digestPromptRequestV1(messages, tools) !==
      entry.record.promptProjection.requestProjectionDigest
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
  }
}

async function createBranchEvidence(
  options: SessionLifecycleOptions,
  records: readonly SessionRecord[],
): Promise<ContextEvidenceV1> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  if (genesis.record.lineage === undefined) {
    return emptyContextEvidence();
  }
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  const inherited = await createBranchEvidence(options, prefixRecords);
  const run = prefixRecords.findLast(
    (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
  );
  if (run?.schemaVersion !== 3 || run.record.type !== "logical_run_started") {
    return inherited;
  }
  return mergeContextEvidence(
    inherited,
    reduceContextEvidence(
      prefixRecords,
      run.record.runId,
      prefixRecords.at(-1)?.sequence ?? 1,
      parentGenesis.record.sessionId,
    ),
  );
}

function inheritedContextEvidence(evidence: ContextEvidenceV1): ContextEvidenceV1 {
  return {
    schemaVersion: 1,
    modifiedFiles: evidence.modifiedFiles.filter((entry) => entry.sessionId !== undefined),
    permissions: evidence.permissions.filter((entry) => entry.sessionId !== undefined),
    toolResults: evidence.toolResults.filter((entry) => entry.sessionId !== undefined),
    failures: evidence.failures.filter((entry) => entry.sessionId !== undefined),
  };
}

function emptyContextEvidence(): ContextEvidenceV1 {
  return {
    schemaVersion: 1,
    modifiedFiles: [],
    permissions: [],
    toolResults: [],
    failures: [],
  };
}

function hasContextEvidence(evidence: ContextEvidenceV1): boolean {
  return (
    evidence.modifiedFiles.length > 0 ||
    evidence.permissions.length > 0 ||
    evidence.toolResults.length > 0 ||
    evidence.failures.length > 0
  );
}

async function modelResponseTargetsFromBranchContext(
  options: SessionLifecycleOptions,
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
  const lineage = genesis.record.lineage;
  if (lineage === undefined) {
    return ownTargets;
  }
  const { prefixRecords: parentRecords } = await readValidatedLineagePrefix(options, genesis);
  return [...(await modelResponseTargetsFromBranchContext(options, parentRecords)), ...ownTargets];
}

async function readValidatedLineagePrefix(
  options: SessionLifecycleOptions,
  childGenesis: SessionGenesisRecord,
): Promise<{
  readonly parentGenesis: SessionGenesisRecord;
  readonly prefixRecords: readonly SessionRecord[];
}> {
  const lineage = childGenesis.record.lineage;
  if (lineage === undefined) {
    throw new SessionLifecycleError("session_invalid");
  }
  let declaredParentRecords: readonly SessionRecord[];
  try {
    declaredParentRecords = await readSessionRecords(options, lineage.parentSessionId);
  } catch {
    throw new SessionLifecycleError("session_invalid");
  }
  const declaredParentGenesis = declaredParentRecords[0];
  if (
    declaredParentGenesis === undefined ||
    !isGenesisRecord(declaredParentGenesis) ||
    declaredParentGenesis.record.sessionId !== lineage.parentSessionId ||
    declaredParentGenesis.record.projectId !== childGenesis.record.projectId
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const sourceSessionId =
    "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
  const sourceEventPosition =
    "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
  if (
    !(await sessionInheritsSourceBoundary(
      options,
      declaredParentGenesis,
      sourceSessionId,
      sourceEventPosition,
      new Set(),
    ))
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const parentRecords =
    sourceSessionId === lineage.parentSessionId
      ? declaredParentRecords
      : await readSessionRecords(options, sourceSessionId);
  const parentGenesis = parentRecords[0];
  if (
    parentGenesis === undefined ||
    !isGenesisRecord(parentGenesis) ||
    parentGenesis.record.projectId !== childGenesis.record.projectId ||
    sourceEventPosition > parentRecords.length
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const prefixRecords = parentRecords.slice(0, sourceEventPosition);
  const prefix = `${prefixRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const digest = `sha256:${createHash("sha256").update(prefix).digest("hex")}`;
  const expectedDigest =
    "recordVersion" in lineage ? lineage.sourcePrefixDigest : lineage.prefixDigest;
  if (digest !== expectedDigest || !isCompleteBranchBoundary(prefixRecords)) {
    throw new SessionLifecycleError("session_invalid");
  }
  validateCurrentSessionHistory(parentGenesis, prefixRecords, options.workspaceRoot);
  return { parentGenesis, prefixRecords };
}

function isCompleteBranchBoundary(records: readonly SessionRecord[]): boolean {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (currentRecords.length !== records.length || currentRecords.length === 0) {
    return false;
  }
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun === undefined) {
    const first = records[0];
    return (
      first !== undefined &&
      isGenesisRecord(first) &&
      currentRecords
        .slice(1)
        .every(
          (entry) =>
            ((entry.record.type === "repository_instructions_committed" ||
              entry.record.type === "repository_instructions_failed") &&
              entry.record.trigger === undefined) ||
            entry.record.type === "skill_catalog_committed" ||
            entry.record.type === "skill_catalog_failed" ||
            entry.record.type === "skill_revoked" ||
            entry.record.type === "mcp_workspace_confirmed" ||
            entry.record.type === "mcp_server_definition_approved" ||
            entry.record.type === "mcp_activation_started" ||
            entry.record.type === "mcp_activation_settled" ||
            entry.record.type === "mcp_tool_profile_committed",
        )
    );
  }
  if (latestRun.record.type !== "logical_run_started") {
    return false;
  }
  const runId = latestRun.record.runId;
  const lastAttempt = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  if (
    lastAttempt?.record.type === "provider_attempt_started" &&
    attemptStatus(currentRecords, lastAttempt.record) === "started"
  ) {
    return false;
  }
  const lastResponse = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  if (
    lastResponse?.record.type !== "model_response_completed" ||
    lastResponse.record.response.finishReason !== "tool_calls"
  ) {
    return true;
  }
  return lastResponse.record.response.toolCalls.every((call) =>
    currentRecords.some(
      (candidate) =>
        candidate.sequence > lastResponse.sequence &&
        candidate.record.type === "runtime_event" &&
        candidate.record.runId === runId &&
        (candidate.record.event.type === "tool_completed" ||
          candidate.record.event.type === "tool_failed") &&
        candidate.record.event.callId === call.id &&
        candidate.record.event.name === call.name,
    ),
  );
}

function areReplayProfilesCompatible(
  left: ModelTargetIdentity,
  right: ModelTargetIdentity,
): boolean {
  return (
    left.vendor === right.vendor &&
    left.route === right.route &&
    left.upstreamProviderId === right.upstreamProviderId &&
    left.profileVersion === right.profileVersion
  );
}

function snapshotFromGenesis(
  genesis: SessionGenesisRecord,
  lastSequence: number,
): CurrentSessionSnapshot {
  return {
    schemaVersion: 3,
    sessionId: genesis.record.sessionId,
    projectId: genesis.record.projectId,
    targetIdentity: genesis.record.targetIdentity,
    status: "idle",
    lastSequence,
    ...(genesis.record.promptContext === undefined
      ? {}
      : { promptContext: promptContextSnapshot(genesis.record.promptContext) }),
    ...(genesis.record.skillContext === undefined
      ? {}
      : { skillContext: skillContextSnapshot(genesis.record.skillContext) }),
    ...(genesis.record.lineage === undefined ? {} : { lineage: genesis.record.lineage }),
  };
}

function promptContextSnapshotFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): PromptContextSnapshot | undefined {
  const context = promptContextRecordFromRecords(genesis, records);
  if (context === undefined) {
    return undefined;
  }
  const snapshot = promptContextSnapshot(context);
  const latestProjection = records.findLast(
    (entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "provider_attempt_started" &&
      entry.record.promptProjection !== undefined,
  );
  return latestProjection?.schemaVersion === 3 &&
    latestProjection.record.type === "provider_attempt_started" &&
    latestProjection.record.promptProjection !== undefined
    ? {
        ...snapshot,
        lastRequestProjectionDigest:
          latestProjection.record.promptProjection.requestProjectionDigest,
      }
    : snapshot;
}

function promptContextRecordFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): SessionGenesisRecord["record"]["promptContext"] {
  let context = genesis.record.promptContext;
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "repository_instructions_committed") {
      if (
        context === undefined ||
        entry.record.previousRevision !== context.repository.revision ||
        entry.record.previousEffectiveDigest !== context.repository.effectiveDigest ||
        entry.record.repository.revision !== context.repository.revision + 1
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptRepositoryV1(context, entry.record.repository);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "mcp_tool_profile_committed") {
      if (
        context?.recordVersion !== 3 ||
        context.mcp !== undefined ||
        entry.record.previousAssemblyIdentityDigest !== context.assemblyIdentityDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = commitMcpToolProfileV3(context, entry.record.profile);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "path_context_committed") {
      if (
        !hasSkillPromptContext(context) ||
        entry.record.previousRepositoryRevision !== context.repository.revision ||
        entry.record.previousRepositoryDigest !== context.repository.effectiveDigest ||
        entry.record.repository.revision !== context.repository.revision + 1
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      let next = replacePromptRepositoryV1(context, entry.record.repository) as
        | PromptContextRecordV2
        | PromptContextRecordV3;
      next = replacePromptSkillsV2(next, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "skill_activation_batch_committed") {
      if (!hasSkillPromptContext(context)) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptSkillsV2(context, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
    }
    if (entry.record.type === "skill_catalog_committed") {
      if (!hasSkillPromptContext(context)) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptSkillsV2(context, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
    }
  }
  return context;
}

function skillContextRecordFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): SkillContextRecordV1 | undefined {
  let context = genesis.record.skillContext;
  for (const entry of records) {
    if (
      entry.schemaVersion !== 3 ||
      (entry.record.type !== "skill_activation_batch_committed" &&
        entry.record.type !== "skill_catalog_committed" &&
        entry.record.type !== "path_context_committed")
    ) {
      continue;
    }
    if (entry.record.type === "skill_catalog_committed") {
      if (
        context === undefined ||
        entry.record.previousRevision !== context.registry.revision ||
        entry.record.previousRegistryDigest !== context.registry.digest ||
        !isSkillContextRecordV1Valid(entry.record.skillContext) ||
        !isSkillContextCatalogSuccessor(context, entry.record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = entry.record.skillContext;
      continue;
    }
    if (entry.record.type === "path_context_committed") {
      if (
        context === undefined ||
        entry.record.previousSkillRevision !== context.registry.revision ||
        entry.record.previousSkillRegistryDigest !== context.registry.digest ||
        !isSkillContextRecordV1Valid(entry.record.skillContext) ||
        !isSkillContextPathSuccessor(context, entry.record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = entry.record.skillContext;
      continue;
    }
    if (
      context === undefined ||
      entry.record.previousActivationDigest !== context.activationDigest ||
      !isSkillContextRecordV1Valid(entry.record.skillContext) ||
      !isSkillActivationBatchTransitionValid(context, entry.record.skillContext, entry.record)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    context = entry.record.skillContext;
  }
  return context;
}

function contextSnapshotFromRecords(
  records: readonly SessionRecord[],
): SessionContextSnapshot | undefined {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const checkpoint = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_committed",
  );
  const started = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_started",
  );
  const checkpointRecord =
    checkpoint?.record.type === "context_compaction_committed" ? checkpoint.record : undefined;
  const startedRecord =
    started?.record.type === "context_compaction_started" ? started.record : undefined;
  if (checkpointRecord === undefined && startedRecord === undefined) {
    return undefined;
  }
  const compactionUsage = compactionContextUsageFromRecords(currentRecords);
  const ordinaryUsage = ordinaryContextUsageFromRecords(currentRecords);
  const lastTerminal =
    startedRecord === undefined
      ? undefined
      : currentRecords.findLast(
          (record) =>
            record.sequence > (started?.sequence ?? 0) &&
            (record.record.type === "context_compaction_committed" ||
              record.record.type === "context_compaction_failed" ||
              record.record.type === "context_compaction_interrupted") &&
            record.record.attemptId === startedRecord.attemptId,
        );
  const terminalRecord =
    lastTerminal?.record.type === "context_compaction_committed" ||
    lastTerminal?.record.type === "context_compaction_failed" ||
    lastTerminal?.record.type === "context_compaction_interrupted"
      ? lastTerminal.record
      : undefined;
  const lastAttemptUsage =
    terminalRecord?.usage === undefined ? ({ status: "unknown" } as const) : terminalRecord.usage;
  const lastAttemptStatus =
    terminalRecord?.type === "context_compaction_committed"
      ? ("committed" as const)
      : terminalRecord?.type === "context_compaction_failed"
        ? ("failed" as const)
        : terminalRecord?.type === "context_compaction_interrupted"
          ? ("interrupted" as const)
          : ("started" as const);
  const latestResponse = currentRecords.findLast(
    (record) =>
      record.sequence > (checkpoint?.sequence ?? Number.MAX_SAFE_INTEGER) &&
      record.record.type === "model_response_completed",
  );
  const active =
    latestResponse?.record.type === "model_response_completed" &&
    latestResponse.record.response.usage !== undefined
      ? {
          source: "provider_reported" as const,
          tokens: latestResponse.record.response.usage.inputTokens,
        }
      : checkpointRecord !== undefined
        ? {
            source: "estimated" as const,
            tokens: estimateActiveContextTokens(
              [
                createContextProjectionMessage(checkpointRecord.summary, checkpointRecord.evidence),
                ...modelMessagesFromCanonicalRecords(
                  currentRecords.filter(
                    (record) =>
                      record.sequence >= checkpointRecord.retainedFrom &&
                      record.sequence <= checkpointRecord.sourceThrough,
                  ),
                ),
              ],
              checkpointRecord.contextProfile,
            ),
          }
        : { source: "unknown" as const };
  return {
    profile:
      startedRecord?.contextProfile ??
      (checkpointRecord as NonNullable<typeof checkpointRecord>).contextProfile,
    ...(checkpointRecord === undefined || checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            checkpointId: checkpointRecord.checkpointId,
            sequence: checkpoint.sequence,
            windowNumber: checkpointRecord.windowNumber,
            status: "committed" as const,
            sourceThrough: checkpointRecord.sourceThrough,
            retainedFrom: checkpointRecord.retainedFrom,
          },
        }),
    lastAttempt: {
      attemptId:
        startedRecord?.attemptId ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).attemptId,
      attemptNumber:
        startedRecord?.attemptNumber ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).attemptNumber,
      windowNumber:
        startedRecord?.windowNumber ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).windowNumber,
      status: lastAttemptStatus,
      ...(terminalRecord?.type === "context_compaction_failed" ||
      terminalRecord?.type === "context_compaction_interrupted"
        ? { reason: terminalRecord.reason }
        : {}),
      usage: lastAttemptUsage,
    },
    ordinaryUsage,
    compactionUsage,
    active,
  };
}

function contextUsageSnapshotFromRecords(
  records: readonly SessionRecord[],
): SessionContextUsageSnapshot | undefined {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (
    !currentRecords.some(
      ({ record }) =>
        record.type === "provider_attempt_started" ||
        record.type === "context_compaction_started" ||
        record.type === "context_compaction_committed" ||
        record.type === "context_compaction_failed" ||
        record.type === "context_compaction_interrupted",
    )
  ) {
    return undefined;
  }
  const latestAttemptBoundary = currentRecords.findLast(
    ({ record }) =>
      record.type === "provider_attempt_started" ||
      record.type === "model_response_completed" ||
      record.type === "provider_attempt_interrupted",
  );
  return {
    ordinaryUsage: ordinaryContextUsageFromRecords(currentRecords),
    compactionUsage: compactionContextUsageFromRecords(currentRecords),
    active:
      latestAttemptBoundary?.record.type === "model_response_completed" &&
      latestAttemptBoundary.record.response.usage !== undefined
        ? {
            source: "provider_reported",
            tokens: latestAttemptBoundary.record.response.usage.inputTokens,
          }
        : { source: "unknown" },
  };
}

function compactionContextUsageFromRecords(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ContextUsageTotals {
  return records.reduce<ContextUsageTotals>((totals, entry) => {
    if (
      entry.record.type !== "context_compaction_committed" &&
      entry.record.type !== "context_compaction_failed" &&
      entry.record.type !== "context_compaction_interrupted"
    ) {
      return totals;
    }
    const usage = entry.record.usage;
    if (usage === undefined || "status" in usage) {
      return incrementUnknownContextUsage(totals);
    }
    return {
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
      cachedInputTokens: totals.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      cacheMissInputTokens: totals.cacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
      unknownCalls: totals.unknownCalls,
    };
  }, emptyContextUsageTotals());
}

function addContextUsageTotals(
  left: ContextUsageTotals,
  right: ContextUsageTotals,
): ContextUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheMissInputTokens: left.cacheMissInputTokens + right.cacheMissInputTokens,
    unknownCalls: left.unknownCalls + right.unknownCalls,
  };
}

function emptyContextUsageTotals(): ContextUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    unknownCalls: 0,
  };
}

function incrementUnknownContextUsage(totals: ContextUsageTotals): ContextUsageTotals {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheMissInputTokens: totals.cacheMissInputTokens,
    unknownCalls: totals.unknownCalls + 1,
  };
}

function ordinaryContextUsageFromRecords(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ContextUsageTotals {
  let totals: ContextUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    unknownCalls: 0,
  };
  let attemptStarted = false;
  let usageSeen = false;
  for (const entry of records) {
    const record = entry.record;
    if (record.type === "provider_attempt_started") {
      attemptStarted = true;
      usageSeen = false;
      continue;
    }
    if (record.type === "runtime_event" && record.event.type === "model_usage" && attemptStarted) {
      usageSeen = true;
      totals = {
        inputTokens: totals.inputTokens + record.event.inputTokens,
        outputTokens: totals.outputTokens + record.event.outputTokens,
        reasoningTokens: totals.reasoningTokens + (record.event.reasoningTokens ?? 0),
        cachedInputTokens: totals.cachedInputTokens + (record.event.cachedInputTokens ?? 0),
        cacheMissInputTokens:
          totals.cacheMissInputTokens + (record.event.cacheMissInputTokens ?? 0),
        unknownCalls: totals.unknownCalls,
      };
      continue;
    }
    if (
      attemptStarted &&
      (record.type === "model_response_completed" || record.type === "provider_attempt_interrupted")
    ) {
      if (!usageSeen) {
        totals = incrementUnknownContextUsage(totals);
      }
      attemptStarted = false;
      usageSeen = false;
    }
  }
  return totals;
}

function snapshotFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactInspection?: ModelResponseArtifactInspection,
): CurrentSessionSnapshot {
  if (records.some((record) => record.schemaVersion !== 3)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const context = contextSnapshotFromRecords(records);
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun === undefined || latestRun.record.type !== "logical_run_started") {
    const promptContext = promptContextSnapshotFromRecords(genesis, records);
    const skillContext = skillContextRecordFromRecords(genesis, records);
    return {
      ...snapshotFromGenesis(genesis, records.length),
      ...(promptContext === undefined ? {} : { promptContext }),
      ...(skillContext === undefined ? {} : { skillContext: skillContextSnapshot(skillContext) }),
      ...(context === undefined ? {} : { context }),
      ...(artifactInspection?.degradation === undefined
        ? {}
        : { degradation: artifactInspection.degradation }),
    };
  }
  const runId = latestRun.record.runId;
  const lastResponse = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  const settlement = currentRecords.findLast(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "session_settled",
  );
  const linkedSettlement = currentRecords.findLast(
    (record) => record.record.type === "run_settled" && record.record.runId === runId,
  );
  const lastAttemptStarted = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  const lastAttempt =
    lastAttemptStarted?.record.type !== "provider_attempt_started"
      ? undefined
      : {
          turn: lastAttemptStarted.record.turn,
          attempt: lastAttemptStarted.record.attempt,
          status: attemptStatus(currentRecords, lastAttemptStarted.record),
        };
  const result =
    settlement?.record.type === "runtime_event" &&
    settlement.record.event.type === "session_settled"
      ? settlement.record.event.result
      : linkedSettlement?.record.type === "run_settled"
        ? artifactInspection?.contents.get(linkedSettlement.record.responseSequence) === undefined
          ? undefined
          : linkedSettlement.record.status === "completed"
            ? {
                status: "completed" as const,
                answer: artifactInspection.contents.get(linkedSettlement.record.responseSequence)
                  ?.text as string,
              }
            : {
                status: "incomplete" as const,
                reason: linkedSettlement.record.reason,
                answer: artifactInspection.contents.get(linkedSettlement.record.responseSequence)
                  ?.text as string,
              }
        : undefined;
  const isSettled = settlement !== undefined || linkedSettlement !== undefined;
  const promptContext = promptContextSnapshotFromRecords(genesis, records);
  const skillContext = skillContextRecordFromRecords(genesis, records);
  return {
    ...snapshotFromGenesis(genesis, records.length),
    ...(promptContext === undefined ? {} : { promptContext }),
    ...(skillContext === undefined ? {} : { skillContext: skillContextSnapshot(skillContext) }),
    ...(context === undefined ? {} : { context }),
    ...(artifactInspection?.degradation === undefined
      ? {}
      : { degradation: artifactInspection.degradation }),
    status: isSettled ? "settled" : "interrupted",
    run: {
      runId,
      status: isSettled ? "settled" : "interrupted",
      ...(result === undefined ? {} : { result }),
      ...(lastAttempt === undefined ? {} : { lastAttempt }),
      ...(lastResponse?.record.type !== "model_response_completed"
        ? {}
        : {
            lastCompletedResponse: {
              turn: lastResponse.record.turn,
              attempt: lastResponse.record.attempt,
              finishReason: lastResponse.record.response.finishReason,
            },
          }),
    },
  };
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

function attemptStatus(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
  attempt: {
    readonly runId: string;
    readonly turn: number;
    readonly attempt: number;
  },
): "started" | "interrupted" | "completed" {
  const matching = records.filter(
    (record) =>
      "runId" in record.record &&
      record.record.runId === attempt.runId &&
      "turn" in record.record &&
      record.record.turn === attempt.turn &&
      "attempt" in record.record &&
      record.record.attempt === attempt.attempt,
  );
  if (matching.some((record) => record.record.type === "model_response_completed")) {
    return "completed";
  }
  if (matching.some((record) => record.record.type === "provider_attempt_interrupted")) {
    return "interrupted";
  }
  return "started";
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
  const messages: NonNullable<AgentSessionDurableContext["resume"]>["messages"][number][] =
    contextCheckpointRecord !== undefined
      ? modelMessagesFromCompleteRecords(
          currentRecords.filter((record) => record.sequence <= (contextCheckpoint?.sequence ?? 0)),
        )
      : [{ role: "user", content: run.record.userMessage }];
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
            candidate.record.event.name === call.name &&
            candidate.record.event.decision === "allow",
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
        const committedResource = currentRecords.find(
          (candidate) =>
            candidate.sequence > responseRecord.sequence &&
            candidate.record.type === "skill_resource_read_committed" &&
            candidate.record.runId === runId &&
            candidate.record.callId === call.id,
        );
        const replayResult =
          committedResource?.record.type === "skill_resource_read_committed"
            ? {
                status: "completed" as const,
                output: {
                  qualifiedId: committedResource.record.qualifiedId,
                  activationIndex: committedResource.record.activationIndex,
                  catalogRevision: committedResource.record.catalogRevision,
                  manifestRevision: committedResource.record.manifestRevision,
                  path: committedResource.record.path,
                  offset: committedResource.record.offset,
                  byteCount: committedResource.record.byteCount,
                  totalByteCount: committedResource.record.totalByteCount,
                  eof: committedResource.record.eof,
                  fileDigest: committedResource.record.fileDigest,
                  pageDigest: committedResource.record.pageDigest,
                  content: committedResource.record.content,
                  ...(committedResource.record.executionToken === undefined
                    ? {}
                    : { executionToken: committedResource.record.executionToken }),
                },
              }
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
  options: SessionLifecycleOptions,
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
          const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(
            options,
            genesis,
          );
          return skillResourceBytesFromLineage(options, parentGenesis, prefixRecords);
        })();
  const total = inheritedBytes + ownBytes;
  if (!Number.isSafeInteger(total) || total < 0 || total > 8 * 1024 * 1024) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function canonicalProjectId(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
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

type ModelResponseArtifactDegradation = NonNullable<CurrentSessionSnapshot["degradation"]>;

type ModelResponseArtifactInspection = {
  readonly contents: ReadonlyMap<number, { readonly text: string; readonly reasoning?: string }>;
  readonly degradation?: ModelResponseArtifactDegradation;
  readonly logicalReferencedBytes: number;
  readonly records: readonly SessionRecord[];
};

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
  const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(options, genesis);
  const inherited = await inspectModelResponseArtifactLineage(
    options,
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
          const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(
            options,
            genesis,
          );
          return replayArtifactBytesFromLineage(
            options,
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

function effectiveSessionStateRoot(configured: string | undefined): string {
  if (configured !== undefined) {
    return configured;
  }
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
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
