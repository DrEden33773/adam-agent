import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  type ArtifactReference,
  type ArtifactStore,
  type ChangePreviewArtifactSource,
  createFileArtifactStore,
  readFileArtifact,
} from "./artifact-store.js";
import { type ContextProfile, isContextProfileSupported } from "./context-profile.js";
import {
  type ContextEvidenceV1,
  createContextProjectionMessage,
  digestContextMessages,
  digestContextRecordPrefix,
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
  AgentSession,
  type ContextUsageTotals,
  type ModelMessage,
  type PermissionDecisionCommand,
  type PermissionDecisionCommandResult,
  type RunOptions,
  type RunResult,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimeEventNotification,
  type UserInput,
} from "./index.js";
import {
  createMcpRuntimeHost,
  inspectMcpConfiguration,
  isMcpToolProfileV1Valid,
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
import { normalizedSessionTitle, sessionTitleFallback } from "./session-naming.js";
import {
  createJsonlSessionStoreDirectory,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionFailedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionContextCompactionStartedRecord,
  type SessionGenesisRecord,
  type SessionLogicalRunStartedRecord,
  type SessionMcpActivationSettledRecord,
  type SessionMcpActivationStartedRecord,
  type SessionMcpServerClosedRecord,
  type SessionMcpServerDefinitionApprovedRecord,
  type SessionMcpToolProfileCommittedRecord,
  type SessionMcpWorkspaceConfirmedRecord,
  type SessionModelResponseCompletedRecord,
  type SessionModelResponseField,
  type SessionRecord,
  type SessionSkillActivationBatchCommittedRecord,
  type SessionStore,
  type SessionStoreDirectory,
} from "./session-store.js";
import {
  createInitialSkillContextV1,
  type ExtensionSkillSourceV1,
  isSkillContextRecordV1Valid,
  reconcileExtensionSkillContextV1,
  reloadSkillContextV1,
  type SkillContextRecordV1,
  type SkillContextSnapshot,
  skillContextSnapshot,
} from "./skills.js";
import {
  canonicalChangePreviewForToolCall,
  createCodingToolRegistry,
  type PermissionPolicy,
  type ToolEffect,
  type ToolRegistry,
} from "./tool-runtime.js";

export type { McpSessionSnapshot } from "./mcp-host.js";

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
    }
  | ({
      readonly type: "branch";
    } & SessionBranchInput)
  | { readonly type: "reload_repository_instructions"; readonly sessionId: string }
  | { readonly type: "reload_skills"; readonly sessionId: string }
  | McpConfigurationCommand;

export interface SessionLifecycle {
  branch(input: SessionBranchInput): Promise<CurrentSessionSnapshot>;
  close(): Promise<McpCloseResult>;
  continue(input: {
    readonly sessionId: string;
    readonly input?: UserInput;
    readonly limits?: RunOptions["limits"];
    readonly runId?: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionContinueResult>;
  configureMcp(command: McpConfigurationCommand): Promise<McpConfigurationResult>;
  create(input: { readonly targetIdentity: ModelTargetIdentity }): Promise<CurrentSessionSnapshot>;
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
  enableAutomaticTitles(): void;
  ensureAutomaticTitle(input: { readonly sessionId: string }): Promise<SessionNamingResult>;
  inspect(input: { readonly sessionId: string }): Promise<SessionSnapshot>;
  listProjectSessions(input?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<ProjectSessionCatalogPage>;
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

export class SessionLifecycleError extends Error {
  readonly code:
    | "session_branch_boundary_invalid"
    | "session_invalid"
    | "session_model_target_incompatible"
    | "session_model_target_unavailable"
    | "session_not_found"
    | "session_project_mismatch"
    | "mcp_config_invalid"
    | "mcp_bootstrap_failed"
    | "mcp_catalog_invalid"
    | "mcp_catalog_too_large"
    | "mcp_initialize_failed"
    | "mcp_start_failed"
    | "mcp_startup_timeout"
    | "mcp_activation_cancelled"
    | "mcp_shutdown_unconfirmed"
    | "project_in_use"
    | "project_owner_unavailable";

  constructor(code: SessionLifecycleError["code"]) {
    super(sessionLifecycleErrorMessage(code));
    this.name = "SessionLifecycleError";
    this.code = code;
  }
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

  return {
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
      return withOwner(async () => {
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
        const store = await storeDirectory.create(sessionId);
        const skillBudgetContext = await resolveSkillBudgetContext(options, input.targetIdentity);
        const extensionSources = await resolveExtensionSkillSources(options);
        const skillContext = await createInitialSkillContextV1({
          artifactStore: createLazyArtifactStore(
            join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
          ),
          ...skillBudgetContext,
          projectId,
          sessionId,
          userHome: homedir(),
          workspaceRoot: options.workspaceRoot,
          extensionSources,
        });
        if (options.tools === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const genesis: SessionGenesisRecord = {
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
        };
        await store.append(genesis);
        const snapshot = snapshotFromGenesis(genesis, 1);
        return mcp === undefined ? snapshot : { ...snapshot, mcp };
      });
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
        const resolved = await options.modelTargets.resolve({
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
            ...(options[sessionLogicalRunStartedBarrier] === undefined
              ? {}
              : {
                  afterLogicalRunStarted: (started: {
                    readonly sessionId: string;
                    readonly runId: string;
                    readonly sequence: number;
                  }) =>
                    options[sessionLogicalRunStartedBarrier]?.afterDurableRecord(started) ??
                    Promise.resolve(),
                }),
            targetIdentity: resumed.snapshot.targetIdentity,
            ...(activePromptContext === undefined ? {} : { promptContext: activePromptContext }),
            ...(activeSkillContext === undefined ? {} : { skillContext: activeSkillContext }),
            ...(extensionSources.length === 0 ? {} : { extensionSkillSources: extensionSources }),
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
      await waitForMcpIdleOperation(input.sessionId);
      if (activeSession === undefined) {
        await pendingMcpCatalogDurability.get(input.sessionId);
        if (
          [...pendingMcpCatalogChanges.values()].some(
            (change) => change.sessionId === input.sessionId,
          )
        ) {
          await runWithOwner(() => flushPendingMcpCatalogChanges(input.sessionId));
        }
      }
      return inspectSession(input);
    },
    async listProjectSessions(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
        throw new SessionLifecycleError("session_invalid");
      }
      const afterSessionId = decodeProjectSessionCatalogCursor(input.cursor);
      const projectId = await canonicalProjectId(options.workspaceRoot);
      const sessionIds = [...(await storeDirectory.listSessionIds())].sort();
      const afterIndex =
        afterSessionId === undefined
          ? 0
          : sessionIds.findIndex((sessionId) => sessionId > afterSessionId);
      const start = afterIndex < 0 ? sessionIds.length : afterIndex;
      const selectedIds = sessionIds.slice(start, start + limit);
      const items = await Promise.all(
        selectedIds.map((sessionId) => inspectSession({ sessionId })),
      );
      const lastSessionId = selectedIds.at(-1);
      return {
        projectId,
        items,
        nextCursor:
          lastSessionId !== undefined && start + selectedIds.length < sessionIds.length
            ? encodeProjectSessionCatalogCursor(lastSessionId)
            : null,
      };
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

type ValidatedToolState = {
  readonly call: { readonly id: string; readonly name: string; readonly argumentsJson: string };
  readonly intent: {
    readonly effect?: string | undefined;
  };
  decision?: "allow" | "deny";
  changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource>;
  permissionRequestId?: string;
  requested: boolean;
  repositoryActivationPublished?: boolean;
  repositoryDisposition?: "mutation_retry_required" | "read_continue" | "unavailable";
  repositoryRevision?: number;
  started: boolean;
  terminal: boolean;
  terminalErrorCode?: string;
};

type ValidatedAttemptState = {
  readonly attempt: number;
  readonly turn: number;
  response?: SessionModelResponseCompletedRecord["record"];
  responseSequence?: number;
  status: "started" | "interrupted" | "completed";
};

function validateCurrentSessionHistory(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  workspaceRoot: string,
): void {
  if (
    genesis.sequence !== 1 ||
    records[0] !== genesis ||
    records.some((record) => record.schemaVersion !== 3) ||
    (genesis.record.promptContext !== undefined &&
      genesis.record.promptContext.recordVersion !== 1) !==
      (genesis.record.skillContext !== undefined) ||
    (genesis.record.skillContext !== undefined &&
      !isSkillContextRecordV1Valid(genesis.record.skillContext)) ||
    (genesis.record.promptContext !== undefined &&
      (!isPromptContextRecordValid(genesis.record.promptContext) ||
        (genesis.record.lineage === undefined &&
          (genesis.record.promptContext.repository.revision !== 1 ||
            JSON.stringify(genesis.record.promptContext.repository.activeScopes) !== '["."]' ||
            genesis.record.promptContext.repository.sources.some(
              (source) => source.scope !== "." || source.loadReason !== "root_eager",
            )))))
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  let run: SessionLogicalRunStartedRecord["record"] | undefined;
  let attemptState: ValidatedAttemptState | undefined;
  let sawUserMessage = false;
  let sawSettlement = false;
  let sawSessionInterruption = false;
  let sawModelStart = false;
  let sawModelCompletion = false;
  let publishedResponseSequence: number | undefined;
  let terminalIntent: RunResult | undefined;
  let lastContextTerminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"]
    | undefined;
  let lastUsage: Extract<RuntimeEvent, { readonly type: "model_usage" }> | undefined;
  let toolStates = new Map<string, ValidatedToolState>();
  let activePromptContext = genesis.record.promptContext;
  let activeSkillContext = genesis.record.skillContext;
  const skillPermissions = new Map<
    string,
    {
      readonly qualifiedId: string;
      readonly permissionRequestId?: string;
      decision?: "allow" | "deny";
      committed: boolean;
    }
  >();
  const committedSkillResourceReads = new Set<string>();
  const publishedSkillActivations = new Set<number>();
  const publishedSkillRevocations = new Set<number>();
  let skillResourceRunBytes = 0;
  let manualSessionName: string | null = null;
  let automaticTitleEligible = false;
  let automaticTitleSlotClosed = false;
  let activeTitleGeneration:
    | {
        readonly generationId: string;
        readonly reason: "automatic" | "regenerate";
      }
    | undefined;
  const titleGenerationIds = new Set<string>();
  const activatableRepositoryRevisions = new Map<number, ValidatedToolState>();
  const publishedRepositoryRevisions = new Set<number>();
  let mcpWorkspaceConfirmation: SessionMcpWorkspaceConfirmedRecord["record"] | undefined;
  const mcpServerApprovals = new Map<string, SessionMcpServerDefinitionApprovedRecord["record"]>();
  let mcpActivationStarted: SessionMcpActivationStartedRecord["record"] | undefined;
  let mcpActivationSettled: SessionMcpActivationSettledRecord["record"] | undefined;
  let mcpToolProfile: SessionMcpToolProfileCommittedRecord["record"] | undefined;
  const closedMcpServers = new Set<string>();
  const pendingMcpServerClosures = new Map<string, SessionMcpServerClosedRecord["record"]>();
  const staleMcpCatalogs = new Set<string>();
  const inheritedMcpProfile =
    genesis.record.lineage !== undefined &&
    activePromptContext?.recordVersion === 3 &&
    activePromptContext.mcp !== undefined;

  for (const entry of currentRecords.slice(1)) {
    const record = entry.record;
    if (record.type === "session_genesis") {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "mcp_workspace_confirmed") {
      if (run !== undefined || mcpWorkspaceConfirmation !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpWorkspaceConfirmation = record;
      continue;
    }
    if (record.type === "mcp_server_definition_approved") {
      if (
        run !== undefined ||
        (mcpWorkspaceConfirmation === undefined && genesis.record.lineage === undefined) ||
        (mcpWorkspaceConfirmation !== undefined &&
          record.sourceDigest !== mcpWorkspaceConfirmation.sourceDigest) ||
        mcpServerApprovals.has(record.serverId)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpServerApprovals.set(record.serverId, record);
      continue;
    }
    if (record.type === "mcp_activation_started") {
      const expectedReason =
        mcpToolProfile !== undefined || inheritedMcpProfile
          ? "idle_reactivate"
          : mcpActivationStarted === undefined
            ? "initial"
            : "explicit_retry";
      if (
        run !== undefined ||
        (mcpWorkspaceConfirmation === undefined && genesis.record.lineage === undefined) ||
        (mcpActivationStarted !== undefined && mcpActivationSettled === undefined) ||
        record.reason !== expectedReason ||
        record.attempt !== (mcpActivationStarted?.attempt ?? 0) + 1 ||
        record.servers.some(
          (server) =>
            mcpServerApprovals.get(server.serverId)?.definitionDigest !== server.definitionDigest &&
            genesis.record.lineage === undefined,
        ) ||
        (mcpToolProfile !== undefined &&
          JSON.stringify(
            record.servers.map(({ serverId, definitionDigest }) => ({
              serverId,
              definitionDigest,
            })),
          ) !==
            JSON.stringify(
              mcpToolProfile.profile.servers.map(({ serverId, definitionDigest }) => ({
                serverId,
                definitionDigest,
              })),
            ))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpActivationStarted = record;
      mcpActivationSettled = undefined;
      continue;
    }
    if (record.type === "mcp_activation_settled") {
      const pendingClosures = [...pendingMcpServerClosures.values()].filter(
        (closure) => closure.generationId === record.generationId,
      );
      const validTerminalClosures =
        pendingClosures.length === 0 ||
        (record.status === "failed" &&
          record.error?.code === "mcp_shutdown_unconfirmed" &&
          pendingClosures.length <= (mcpActivationStarted?.servers.length ?? 0) &&
          pendingClosures.every(
            (closure) =>
              closure.reason === "failed" ||
              closure.reason === "peer_failure" ||
              closure.reason === "stale",
          )) ||
        (record.status === "failed" &&
          (mcpToolProfile !== undefined || inheritedMcpProfile) &&
          record.error?.serverId === undefined &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "stale")) ||
        (record.status === "failed" &&
          record.error?.serverId === undefined &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "failed")) ||
        (record.status === "failed" &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.some(
            (closure) => closure.serverId === record.error?.serverId && closure.reason === "failed",
          ) &&
          pendingClosures.every((closure) =>
            closure.serverId === record.error?.serverId
              ? closure.reason === "failed"
              : closure.reason === "peer_failure",
          )) ||
        (record.status === "cancelled" &&
          pendingClosures.length === mcpActivationStarted?.servers.length &&
          pendingClosures.every((closure) => closure.reason === "session_close"));
      if (
        run !== undefined ||
        mcpActivationStarted === undefined ||
        mcpActivationSettled !== undefined ||
        record.generationId !== mcpActivationStarted.generationId ||
        record.attempt !== mcpActivationStarted.attempt ||
        (record.status === "ready" &&
          (record.catalogDigest === undefined ||
            record.error !== undefined ||
            record.servers.length !== mcpActivationStarted.servers.length)) ||
        (record.status !== "ready" &&
          (record.catalogDigest !== undefined || record.servers.length !== 0)) ||
        !validTerminalClosures
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      mcpActivationSettled = record;
      for (const closure of pendingClosures) {
        pendingMcpServerClosures.delete(`${closure.generationId}:${closure.serverId}`);
      }
      continue;
    }
    if (record.type === "mcp_server_closed") {
      const key = `${record.generationId}:${record.serverId}`;
      const settledServer = mcpActivationSettled?.servers.find(
        (server) => server.serverId === record.serverId,
      );
      const startedServer = mcpActivationStarted?.servers.find(
        (server) => server.serverId === record.serverId,
      );
      const hasCommittedProfile = mcpToolProfile !== undefined || inheritedMcpProfile;
      const validFailedClose =
        !hasCommittedProfile &&
        mcpActivationSettled?.status === "failed" &&
        startedServer?.definitionDigest === record.definitionDigest &&
        ((record.reason === "failed" && mcpActivationSettled.error?.serverId === record.serverId) ||
          (record.reason === "peer_failure" &&
            mcpActivationSettled.error?.serverId !== record.serverId));
      const validPendingFailureClose =
        !hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        (record.reason === "failed" || record.reason === "peer_failure");
      const validPendingCancelledClose =
        !hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        record.reason === "session_close";
      const validPendingProfileClose =
        hasCommittedProfile &&
        mcpActivationSettled === undefined &&
        startedServer?.definitionDigest === record.definitionDigest &&
        (record.reason === "failed" ||
          record.reason === "peer_failure" ||
          record.reason === "stale");
      const validReadyClose =
        mcpActivationSettled?.status === "ready" &&
        settledServer?.definitionDigest === record.definitionDigest &&
        (((record.reason === "idle" || record.reason === "stale") && hasCommittedProfile) ||
          record.reason === "session_close");
      if (
        run !== undefined ||
        (!validFailedClose &&
          !validPendingFailureClose &&
          !validPendingCancelledClose &&
          !validPendingProfileClose &&
          !validReadyClose) ||
        record.generationId !==
          (mcpActivationSettled?.generationId ?? mcpActivationStarted?.generationId) ||
        record.attempt !== (mcpActivationSettled?.attempt ?? mcpActivationStarted?.attempt) ||
        closedMcpServers.has(key)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      closedMcpServers.add(key);
      if (validPendingFailureClose || validPendingCancelledClose || validPendingProfileClose) {
        pendingMcpServerClosures.set(key, record);
      }
      continue;
    }
    if (record.type === "mcp_tool_profile_committed") {
      let nextPromptContext: PromptContextRecordV3;
      try {
        if (
          activePromptContext?.recordVersion !== 3 ||
          activePromptContext.mcp !== undefined ||
          record.previousAssemblyIdentityDigest !== activePromptContext.assemblyIdentityDigest
        ) {
          throw new Error("invalid MCP prompt transition");
        }
        nextPromptContext = commitMcpToolProfileV3(activePromptContext, record.profile);
      } catch {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        run !== undefined ||
        mcpActivationSettled?.status !== "ready" ||
        mcpToolProfile !== undefined ||
        record.profile.generationId !== mcpActivationSettled.generationId ||
        record.profile.digest.length !== 71 ||
        !isMcpToolProfileV1Valid(record.profile) ||
        JSON.stringify(record.profile.servers) !== JSON.stringify(mcpActivationSettled.servers) ||
        record.assemblyIdentityDigest !== nextPromptContext.assemblyIdentityDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      activePromptContext = nextPromptContext;
      mcpToolProfile = record;
      continue;
    }
    if (record.type === "mcp_catalog_state_changed") {
      const staleKey = `${record.generationId}:${record.serverId}:${record.catalogDigest}`;
      const validIdentity =
        mcpActivationSettled?.status === "ready" &&
        record.generationId === mcpActivationSettled.generationId &&
        record.catalogDigest === mcpActivationSettled.catalogDigest &&
        mcpActivationSettled.servers.some((server) => server.serverId === record.serverId);
      if (record.status === "stale") {
        const validOccurrence =
          record.runId === undefined ? run === undefined : record.runId === run?.runId;
        if (!validOccurrence || !validIdentity || staleMcpCatalogs.has(staleKey)) {
          throw new SessionLifecycleError("session_invalid");
        }
        staleMcpCatalogs.add(staleKey);
      } else {
        if (
          run !== undefined ||
          mcpToolProfile === undefined ||
          !validIdentity ||
          !staleMcpCatalogs.delete(staleKey)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
      }
      continue;
    }
    if (record.type === "logical_run_started") {
      if (sawSettlement) {
        attemptState = undefined;
        sawUserMessage = false;
        sawSettlement = false;
        sawSessionInterruption = false;
        sawModelStart = false;
        sawModelCompletion = false;
        publishedResponseSequence = undefined;
        terminalIntent = undefined;
        lastContextTerminal = undefined;
        lastUsage = undefined;
        toolStates = new Map();
        skillPermissions.clear();
        committedSkillResourceReads.clear();
        skillResourceRunBytes = 0;
      }
      if (
        run !== undefined ||
        attemptState !== undefined ||
        sawUserMessage ||
        record.skills?.some(
          (selection, index) => selection.requestId !== `${record.runId}:skill:${index + 1}`,
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      run = record;
      continue;
    }
    if (record.type === "repository_instructions_committed") {
      const expectedLoadReason =
        record.trigger === undefined ? "explicit_reload" : "path_scope_activation";
      if (
        activePromptContext === undefined ||
        record.previousRevision !== activePromptContext.repository.revision ||
        record.previousEffectiveDigest !== activePromptContext.repository.effectiveDigest ||
        record.repository.revision !== activePromptContext.repository.revision + 1 ||
        record.repository.sources.some(
          (source: PromptContextRecordV1["repository"]["sources"][number]) =>
            source.loadReason !== expectedLoadReason,
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptRepositoryV1(activePromptContext, record.repository);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.trigger === undefined) {
        if (run !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        const toolState = toolStates.get(record.trigger.callId);
        if (
          run === undefined ||
          record.trigger.runId !== run.runId ||
          toolState === undefined ||
          toolState.call.name !== record.trigger.name ||
          record.trigger.argumentsDigest !==
            `sha256:${createHash("sha256")
              .update(toolState.call.argumentsJson, "utf8")
              .digest("hex")}` ||
          !toolState.requested ||
          toolState.started ||
          toolState.terminal ||
          toolState.decision !== undefined ||
          toolState.permissionRequestId !== undefined ||
          toolState.repositoryDisposition !== undefined ||
          (record.trigger.name === "read_file") !== (record.trigger.disposition === "read_continue")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        toolState.repositoryDisposition = record.trigger.disposition;
        toolState.repositoryRevision = record.repository.revision;
        activatableRepositoryRevisions.set(record.repository.revision, toolState);
      }
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "repository_instructions_failed") {
      if (
        activePromptContext === undefined ||
        record.activeRevision !== activePromptContext.repository.revision ||
        record.activeEffectiveDigest !== activePromptContext.repository.effectiveDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.trigger === undefined) {
        if (run !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        const toolState = toolStates.get(record.trigger.callId);
        if (
          run === undefined ||
          record.trigger.runId !== run.runId ||
          toolState === undefined ||
          toolState.call.name !== record.trigger.name ||
          record.trigger.argumentsDigest !==
            `sha256:${createHash("sha256")
              .update(toolState.call.argumentsJson, "utf8")
              .digest("hex")}` ||
          !toolState.requested ||
          toolState.started ||
          toolState.terminal ||
          toolState.decision !== undefined ||
          toolState.permissionRequestId !== undefined ||
          toolState.repositoryDisposition !== undefined
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        toolState.repositoryDisposition = "unavailable";
      }
      continue;
    }
    if (record.type === "path_context_committed") {
      const toolState = toolStates.get(record.trigger.callId);
      if (
        run === undefined ||
        record.trigger.runId !== run.runId ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.previousRepositoryRevision !== activePromptContext.repository.revision ||
        record.previousRepositoryDigest !== activePromptContext.repository.effectiveDigest ||
        record.repository.revision !== activePromptContext.repository.revision + 1 ||
        record.previousSkillRevision !== activeSkillContext.registry.revision ||
        record.previousSkillRegistryDigest !== activeSkillContext.registry.digest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillContextPathSuccessor(activeSkillContext, record.skillContext) ||
        toolState === undefined ||
        toolState.call.name !== record.trigger.name ||
        record.trigger.argumentsDigest !==
          `sha256:${createHash("sha256").update(toolState.call.argumentsJson, "utf8").digest("hex")}` ||
        !toolState.requested ||
        toolState.started ||
        toolState.terminal ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      let nextPromptContext = replacePromptRepositoryV1(activePromptContext, record.repository) as
        | PromptContextRecordV2
        | PromptContextRecordV3;
      nextPromptContext = replacePromptSkillsV2(nextPromptContext, record.skillContext);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryDisposition = record.trigger.disposition;
      toolState.repositoryRevision = record.repository.revision;
      activatableRepositoryRevisions.set(record.repository.revision, toolState);
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "path_context_failed") {
      const toolState = toolStates.get(record.trigger.callId);
      if (
        run === undefined ||
        record.trigger.runId !== run.runId ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.activeRepositoryRevision !== activePromptContext.repository.revision ||
        record.activeRepositoryDigest !== activePromptContext.repository.effectiveDigest ||
        record.activeSkillRevision !== activeSkillContext.registry.revision ||
        record.activeSkillRegistryDigest !== activeSkillContext.registry.digest ||
        toolState === undefined ||
        toolState.call.name !== record.trigger.name ||
        record.trigger.argumentsDigest !==
          `sha256:${createHash("sha256").update(toolState.call.argumentsJson, "utf8").digest("hex")}` ||
        !toolState.requested ||
        toolState.started ||
        toolState.terminal ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined ||
        toolState.repositoryDisposition !== undefined
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryDisposition = "unavailable";
      continue;
    }
    if (record.type === "skill_catalog_committed") {
      if (
        (record.reason === undefined
          ? run !== undefined
          : record.reason !== "extension_reconciliation" || attemptState?.status === "started") ||
        !hasSkillPromptContext(activePromptContext) ||
        activeSkillContext === undefined ||
        record.previousRevision !== activeSkillContext.registry.revision ||
        record.previousRegistryDigest !== activeSkillContext.registry.digest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillContextCatalogSuccessor(activeSkillContext, record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptSkillsV2(activePromptContext, record.skillContext);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "skill_catalog_failed") {
      if (
        run !== undefined ||
        activeSkillContext === undefined ||
        record.activeRevision !== activeSkillContext.registry.revision ||
        record.activeRegistryDigest !== activeSkillContext.registry.digest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      continue;
    }
    if (record.type === "skill_revoked") {
      const revocation = activeSkillContext?.revocations.find(
        (entry) => entry.activationIndex === record.activationIndex,
      );
      if (
        run !== undefined ||
        activeSkillContext === undefined ||
        record.catalogRevision !== activeSkillContext.catalog.revision ||
        revocation === undefined ||
        revocation.qualifiedId !== record.qualifiedId ||
        revocation.reason !== record.reason ||
        JSON.stringify(revocation.sourceEpoch) !== JSON.stringify(record.sourceEpoch) ||
        publishedSkillRevocations.has(record.activationIndex)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedSkillRevocations.add(record.activationIndex);
      continue;
    }
    if (record.type === "skill_activation_batch_committed") {
      const previousSkillContext = activeSkillContext;
      if (
        run === undefined ||
        record.runId !== run.runId ||
        !sawUserMessage ||
        (attemptState !== undefined &&
          (attemptState.status !== "completed" ||
            attemptState.response?.response.finishReason !== "tool_calls")) ||
        !hasSkillPromptContext(activePromptContext) ||
        previousSkillContext === undefined ||
        record.previousActivationDigest !== previousSkillContext.activationDigest ||
        !isSkillContextRecordV1Valid(record.skillContext) ||
        !isSkillActivationBatchValid(previousSkillContext, record.skillContext, record, run)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const nextPromptContext = replacePromptSkillsV2(activePromptContext, record.skillContext);
      const newActivations = record.skillContext.active.slice(previousSkillContext.active.length);
      if (
        nextPromptContext.assemblyIdentityDigest !== record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(nextPromptContext) ||
        newActivations.some((activation) => {
          const permission = skillPermissions.get(activation.requestId);
          const modelTool = toolStates.get(activation.requestId);
          let modelQualifiedId: string | undefined;
          try {
            const parsed =
              modelTool?.call.name === "activate_skill"
                ? (JSON.parse(modelTool.call.argumentsJson) as { qualifiedId?: unknown })
                : undefined;
            modelQualifiedId =
              typeof parsed?.qualifiedId === "string" ? parsed.qualifiedId : undefined;
          } catch {
            modelQualifiedId = undefined;
          }
          const validExplicitPermission =
            permission !== undefined &&
            permission.qualifiedId === activation.qualifiedId &&
            permission.decision === "allow" &&
            !permission.committed;
          const validModelTool =
            modelTool !== undefined &&
            modelQualifiedId === activation.qualifiedId &&
            modelTool.requested &&
            modelTool.started &&
            !modelTool.terminal &&
            modelTool.decision === "allow";
          return !validExplicitPermission && !validModelTool;
        })
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      for (const activation of newActivations) {
        for (const permission of skillPermissions.values()) {
          if (permission.qualifiedId === activation.qualifiedId) {
            permission.committed = true;
          }
        }
      }
      activeSkillContext = record.skillContext;
      activePromptContext = nextPromptContext;
      continue;
    }
    if (record.type === "skill_activated") {
      const activation = activeSkillContext?.active.find(
        (entry) => entry.activationIndex === record.activationIndex,
      );
      if (
        run === undefined ||
        record.runId !== run.runId ||
        activation === undefined ||
        activation.qualifiedId !== record.qualifiedId ||
        activation.catalogRevision !== record.catalogRevision ||
        activation.reason !== record.reason ||
        activation.skillMdDigest !== record.skillMdDigest ||
        activation.manifest.digest !== record.manifestDigest ||
        publishedSkillActivations.has(record.activationIndex)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedSkillActivations.add(record.activationIndex);
      continue;
    }
    if (record.type === "skill_resource_read_committed") {
      const toolState = toolStates.get(record.callId);
      const activation = activeSkillContext?.active.find(
        (entry) => entry.qualifiedId === record.qualifiedId,
      );
      let argumentsValue:
        | { qualifiedId?: unknown; path?: unknown; offset?: unknown; maxByteCount?: unknown }
        | undefined;
      try {
        argumentsValue = JSON.parse(toolState?.call.argumentsJson ?? "") as typeof argumentsValue;
      } catch {
        argumentsValue = undefined;
      }
      const requestedOffset =
        typeof argumentsValue?.offset === "number" ? argumentsValue.offset : 0;
      const requestedMaximum =
        typeof argumentsValue?.maxByteCount === "number" ? argumentsValue.maxByteCount : 65_536;
      if (
        run === undefined ||
        record.runId !== run.runId ||
        attemptState?.status !== "completed" ||
        attemptState.response?.response.finishReason !== "tool_calls" ||
        toolState?.call.name !== "read_skill_resource" ||
        !toolState.requested ||
        !toolState.started ||
        toolState.terminal ||
        toolState.decision !== "allow" ||
        committedSkillResourceReads.has(record.callId) ||
        argumentsValue?.qualifiedId !== record.qualifiedId ||
        argumentsValue.path !== record.path ||
        requestedOffset !== record.offset ||
        record.byteCount > requestedMaximum ||
        activation === undefined ||
        activation.activationIndex !== record.activationIndex ||
        activation.catalogRevision !== record.catalogRevision ||
        activation.manifest.revision !== record.manifestRevision ||
        !activation.manifest.entries.some((entry) => entry.path === record.path) ||
        record.offset + record.byteCount > record.totalByteCount ||
        record.eof !== (record.offset + record.byteCount === record.totalByteCount) ||
        Buffer.byteLength(record.content, "utf8") !== record.byteCount ||
        `sha256:${createHash("sha256").update(record.content, "utf8").digest("hex")}` !==
          record.pageDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      skillResourceRunBytes += record.byteCount;
      if (!Number.isSafeInteger(skillResourceRunBytes) || skillResourceRunBytes > 1024 * 1024) {
        throw new SessionLifecycleError("session_invalid");
      }
      committedSkillResourceReads.add(record.callId);
      continue;
    }
    if (record.type === "session_manual_name_set") {
      if (run !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      manualSessionName = record.name;
      continue;
    }
    if (record.type === "session_manual_name_cleared") {
      if (run !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      manualSessionName = null;
      continue;
    }
    if (record.type === "session_title_generation_started") {
      if (
        run !== undefined ||
        activeTitleGeneration !== undefined ||
        titleGenerationIds.has(record.generationId) ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        (record.reason === "automatic" &&
          (!automaticTitleEligible || automaticTitleSlotClosed || manualSessionName !== null))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      titleGenerationIds.add(record.generationId);
      activeTitleGeneration = {
        generationId: record.generationId,
        reason: record.reason,
      };
      if (record.reason === "automatic") {
        automaticTitleSlotClosed = true;
      }
      continue;
    }
    if (
      record.type === "session_title_generation_completed" ||
      record.type === "session_title_generation_failed"
    ) {
      if (run !== undefined || activeTitleGeneration?.generationId !== record.generationId) {
        throw new SessionLifecycleError("session_invalid");
      }
      activeTitleGeneration = undefined;
      continue;
    }
    if (record.type === "session_title_generation_skipped_manual") {
      if (
        run !== undefined ||
        activeTitleGeneration !== undefined ||
        !automaticTitleEligible ||
        automaticTitleSlotClosed ||
        manualSessionName === null
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      automaticTitleSlotClosed = true;
      continue;
    }
    if (run === undefined || record.runId !== run.runId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "provider_attempt_started") {
      if (
        terminalIntent !== undefined ||
        !sawUserMessage ||
        [...skillPermissions.values()].some(
          (permission) => permission.decision === "allow" && !permission.committed,
        ) ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        (activePromptContext === undefined
          ? record.promptProjection !== undefined
          : record.promptProjection === undefined ||
            record.promptProjection.assemblyIdentityDigest !==
              activePromptContext.assemblyIdentityDigest)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (attemptState === undefined) {
        if (record.turn !== 1 || record.attempt !== 1) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else if (attemptState.status === "interrupted") {
        if (record.turn !== attemptState.turn || record.attempt !== attemptState.attempt + 1) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else if (attemptState.status === "completed") {
        if (
          attemptState.response?.response.finishReason !== "tool_calls" ||
          [...toolStates.values()].some((state) => !state.terminal) ||
          record.turn !== attemptState.turn + 1 ||
          record.attempt !== 1
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
      } else {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState = {
        turn: record.turn,
        attempt: record.attempt,
        status: "started",
      };
      sawModelStart = false;
      sawModelCompletion = false;
      lastUsage = undefined;
      toolStates = new Map();
      continue;
    }
    if (record.type === "provider_attempt_interrupted") {
      if (
        !isMatchingStartedAttempt(attemptState, record) ||
        ((record.reason === "process_restart" || record.reason === "context_overflow") &&
          record.result !== undefined) ||
        (record.reason === "run_terminal" && record.result === undefined)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState.status = "interrupted";
      if (record.reason === "run_terminal") {
        terminalIntent = record.result;
      }
      continue;
    }
    if (record.type === "model_response_completed") {
      if (
        terminalIntent !== undefined ||
        !isMatchingStartedAttempt(attemptState, record) ||
        !sawModelStart ||
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      validateCompletedResponse(record);
      if (!sameResponseUsage(record.response.usage, lastUsage)) {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState.status = "completed";
      attemptState.response = record;
      attemptState.responseSequence = entry.sequence;
      toolStates = new Map(
        record.response.toolCalls.map((call, index) => [
          call.id,
          {
            call,
            intent: record.response.toolIntents[index] as ValidatedToolState["intent"],
            requested: false,
            started: false,
            terminal: false,
          },
        ]),
      );
      continue;
    }
    if (
      record.type === "context_compaction_started" ||
      record.type === "context_compaction_committed" ||
      record.type === "context_compaction_failed" ||
      record.type === "context_compaction_interrupted"
    ) {
      if (
        record.type === "context_compaction_started" &&
        (!sawUserMessage ||
          terminalIntent !== undefined ||
          attemptState?.status === "started" ||
          (attemptState?.status === "completed" &&
            (attemptState.response?.response.finishReason !== "tool_calls" ||
              [...toolStates.values()].some((state) => !state.terminal))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (record.type !== "context_compaction_started") {
        lastContextTerminal = record;
      }
      continue;
    }
    if (record.type === "model_response_published") {
      if (
        attemptState?.status !== "completed" ||
        attemptState.responseSequence !== record.responseSequence ||
        sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      publishedResponseSequence = record.responseSequence;
      sawModelCompletion = true;
      continue;
    }
    if (record.type === "run_settled") {
      const finishReason = attemptState?.response?.response.finishReason;
      const settlementMatchesResponse =
        (record.status === "completed" && finishReason === "stop") ||
        (record.status === "incomplete" &&
          record.reason === "output_limit" &&
          finishReason === "length");
      if (
        attemptState?.status !== "completed" ||
        attemptState.responseSequence !== record.responseSequence ||
        publishedResponseSequence !== record.responseSequence ||
        !settlementMatchesResponse ||
        !sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const settledResponse = attemptState.response;
      if (
        record.status === "completed" &&
        settledResponse !== undefined &&
        hasNonEmptyModelResponseText(settledResponse.response.text)
      ) {
        automaticTitleEligible = true;
      }
      sawSettlement = true;
      run = undefined;
      continue;
    }
    const event = record.event;
    if (event.type === "user_message") {
      if (
        terminalIntent !== undefined ||
        sawUserMessage ||
        attemptState !== undefined ||
        event.text !== run.userMessage
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawUserMessage = true;
      continue;
    }
    if (event.type === "model_message_started") {
      if (terminalIntent !== undefined || attemptState?.status !== "started" || sawModelStart) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawModelStart = true;
      continue;
    }
    if (event.type === "model_usage") {
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "started" ||
        !sawModelStart ||
        event.totalTokens !== event.inputTokens + event.outputTokens
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      lastUsage = event;
      continue;
    }
    if (event.type === "model_message_completed") {
      const responseText = attemptState?.response?.response.text;
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "completed" ||
        responseText === undefined ||
        inlineModelResponseField(responseText) !== event.text ||
        sawModelCompletion
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawModelCompletion = true;
      continue;
    }
    if (event.type === "session_interrupted") {
      if (
        !sawUserMessage ||
        sawSessionInterruption ||
        (terminalIntent !== undefined && terminalIntent.status !== "cancelled")
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      sawSessionInterruption = true;
      continue;
    }
    if (
      (event.type === "tool_permission_requested" || event.type === "tool_permission_decided") &&
      event.name === "activate_skill" &&
      attemptState === undefined
    ) {
      const subject = event.subject;
      const candidate =
        subject?.type === "skill" && subject.operation === "activate"
          ? activeSkillContext?.registry.candidates.find(
              (entry) => entry.qualifiedId === subject.qualifiedId,
            )
          : undefined;
      if (
        run === undefined ||
        !sawUserMessage ||
        attemptState !== undefined ||
        event.effect !== "read" ||
        event.scope !== "call" ||
        candidate === undefined ||
        !run.skills?.some(
          (selection) =>
            selection.requestId === event.callId &&
            (selection.selection === candidate.qualifiedId ||
              selection.selection === candidate.name),
        )
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const existing = skillPermissions.get(event.callId);
      if (event.type === "tool_permission_requested") {
        if (existing !== undefined || event.requestId !== event.callId) {
          throw new SessionLifecycleError("session_invalid");
        }
        skillPermissions.set(event.callId, {
          qualifiedId: candidate.qualifiedId,
          permissionRequestId: event.requestId,
          committed: false,
        });
      } else {
        if (event.decision !== "allow" && event.decision !== "deny") {
          throw new SessionLifecycleError("session_invalid");
        }
        if (existing === undefined) {
          if (event.requestId !== undefined) {
            throw new SessionLifecycleError("session_invalid");
          }
          skillPermissions.set(event.callId, {
            qualifiedId: candidate.qualifiedId,
            decision: event.decision,
            committed: false,
          });
        } else {
          if (
            existing.decision !== undefined ||
            existing.qualifiedId !== candidate.qualifiedId ||
            event.requestId !== existing.permissionRequestId
          ) {
            throw new SessionLifecycleError("session_invalid");
          }
          existing.decision = event.decision;
        }
      }
      continue;
    }
    if (event.type === "repository_instructions_activated") {
      const toolState = activatableRepositoryRevisions.get(event.revision);
      if (
        activePromptContext === undefined ||
        event.revision !== activePromptContext.repository.revision ||
        event.effectiveDigest !== activePromptContext.repository.effectiveDigest ||
        toolState === undefined ||
        toolState.repositoryDisposition === "unavailable" ||
        toolState.repositoryRevision !== event.revision ||
        toolState.repositoryActivationPublished === true ||
        toolState.decision !== undefined ||
        toolState.permissionRequestId !== undefined ||
        toolState.started ||
        toolState.terminal ||
        publishedRepositoryRevisions.has(event.revision)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      toolState.repositoryActivationPublished = true;
      publishedRepositoryRevisions.add(event.revision);
      continue;
    }
    if (event.type === "session_settled") {
      if (
        !sawUserMessage ||
        attemptState?.status === "started" ||
        (terminalIntent !== undefined &&
          JSON.stringify(terminalIntent) !== JSON.stringify(event.result)) ||
        (event.result.status === "completed" &&
          (attemptState?.status !== "completed" ||
            attemptState.response?.response.finishReason !== "stop" ||
            inlineModelResponseField(attemptState.response.response.text) !== event.result.answer ||
            !sawModelCompletion)) ||
        (event.result.status === "incomplete" &&
          (attemptState?.status !== "completed" ||
            attemptState.response?.response.finishReason !== "length" ||
            inlineModelResponseField(attemptState.response.response.text) !== event.result.answer ||
            !sawModelCompletion)) ||
        (event.result.status === "cancelled" && !sawSessionInterruption) ||
        (event.result.status === "failed" &&
          ((attemptState === undefined &&
            event.result.error.code !== "skill_activation_failed" &&
            !isContextTerminalFailure(event.result, lastContextTerminal)) ||
            event.result.error.code === "invalid_run_limits" ||
            event.result.error.code === "run_already_active" ||
            event.result.error.code === "session_persistence_failed" ||
            (event.result.error.code === "tool_effect_indeterminate" &&
              ![...toolStates.values()].some(
                (state) => state.terminalErrorCode === "tool_effect_indeterminate",
              ))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (event.result.status === "completed" && event.result.answer.length > 0) {
        automaticTitleEligible = true;
      }
      sawSettlement = true;
      run = undefined;
      continue;
    }
    if (
      event.type === "tool_requested" ||
      event.type === "tool_permission_requested" ||
      event.type === "tool_permission_decided" ||
      event.type === "tool_started" ||
      event.type === "tool_completed" ||
      event.type === "tool_failed"
    ) {
      if (terminalIntent !== undefined) {
        throw new SessionLifecycleError("session_invalid");
      }
      const state = toolStates.get(event.callId);
      if (
        attemptState?.status !== "completed" ||
        attemptState.response?.response.finishReason !== "tool_calls" ||
        state === undefined ||
        state.call.name !== event.name ||
        state.terminal
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        state.repositoryDisposition !== undefined &&
        (event.type === "tool_requested" ||
          (state.repositoryDisposition === "unavailable"
            ? event.type !== "tool_failed" ||
              (event.error.code !== "repository_instructions_unavailable" &&
                event.error.code !== "project_context_unavailable")
            : state.repositoryActivationPublished !== true ||
              (state.repositoryDisposition === "mutation_retry_required" &&
                (event.type !== "tool_failed" ||
                  (event.error.code !== "repository_context_changed" &&
                    event.error.code !== "project_context_changed")))))
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        (event.type === "tool_permission_requested" || event.type === "tool_permission_decided") &&
        !isCanonicalChangePreviewReference({
          event,
          genesis,
          runId: run.runId,
          state,
          workspaceRoot,
        })
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (
        state.call.name === "read_skill_resource" &&
        event.type === "tool_completed" &&
        !committedSkillResourceReads.has(event.callId)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      if (event.type === "tool_requested") {
        if (state.requested) {
          throw new SessionLifecycleError("session_invalid");
        }
        state.requested = true;
      } else if (event.type === "tool_permission_requested") {
        if (
          !state.requested ||
          state.started ||
          state.decision !== undefined ||
          (state.permissionRequestId !== undefined && state.permissionRequestId !== event.requestId)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        validatePermissionEffect(state, event.effect);
        state.permissionRequestId ??= event.requestId;
      } else if (event.type === "tool_permission_decided") {
        if (
          !state.requested ||
          state.started ||
          state.decision !== undefined ||
          (state.permissionRequestId === undefined
            ? event.requestId !== undefined
            : event.requestId !== state.permissionRequestId)
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        validatePermissionEffect(state, event.effect);
        state.decision = event.decision;
      } else if (event.type === "tool_started") {
        if (!state.requested || state.started || state.decision !== "allow") {
          throw new SessionLifecycleError("session_invalid");
        }
        state.started = true;
      } else {
        if (
          !state.requested ||
          (event.type === "tool_completed" && !state.started) ||
          (event.type === "tool_failed" &&
            event.error.code === "permission_denied" &&
            state.decision !== "deny")
        ) {
          throw new SessionLifecycleError("session_invalid");
        }
        state.terminal = true;
        if (event.type === "tool_failed") {
          state.terminalErrorCode = event.error.code;
        }
      }
      continue;
    }
    throw new SessionLifecycleError("session_invalid");
  }
  validateContextCompactionHistory(genesis, currentRecords);
}

function isContextTerminalFailure(
  result: Extract<RunResult, { readonly status: "failed" }>,
  terminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"]
    | undefined,
): boolean {
  if (terminal?.type === "context_compaction_committed") {
    return (
      result.error.code === "token_limit_exceeded" || result.error.code === "token_usage_missing"
    );
  }
  if (terminal?.type !== "context_compaction_failed") {
    return false;
  }
  const expectedCode =
    terminal.reason === "model_request_failed"
      ? "context_compaction_failed"
      : terminal.reason === "summary_invalid"
        ? "context_compaction_invalid"
        : terminal.reason === "input_unrecoverable"
          ? "context_compaction_input_unrecoverable"
          : terminal.reason === "context_window_unrecoverable"
            ? "context_window_unrecoverable"
            : undefined;
  return result.error.code === expectedCode;
}

function validateContextCompactionHistory(
  genesis: SessionGenesisRecord,
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): void {
  const starts = new Map<
    string,
    {
      readonly entry: SessionContextCompactionStartedRecord;
      terminal: boolean;
    }
  >();
  const boundaryAttempts = new Map<string, number>();
  const boundaryRetryAllowed = new Map<string, boolean>();
  const committedBoundaries = new Set<string>();
  const checkpointIds = new Set<string>();
  let latestCheckpointSequence: number | undefined;
  let latestWindowNumber = 0;
  for (const entry of records) {
    const record = entry.record;
    const openStart = [...starts.values()].find((start) => !start.terminal);
    if (
      openStart !== undefined &&
      !(
        (record.type === "context_compaction_committed" ||
          record.type === "context_compaction_failed" ||
          record.type === "context_compaction_interrupted") &&
        record.attemptId === openStart.entry.record.attemptId
      )
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "context_compaction_started") {
      if (
        !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
        record.sourceThrough >= entry.sequence ||
        !isContextProfileValid(record.contextProfile) ||
        record.previousCheckpointSequence !== latestCheckpointSequence ||
        record.windowNumber !== latestWindowNumber + 1 ||
        digestContextRecordPrefix(
          records.filter((candidate) => candidate.sequence <= record.sourceThrough),
        ) !== record.sourceDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${record.sourceDigest}`;
      const expectedAttempt = (boundaryAttempts.get(boundary) ?? 0) + 1;
      if (
        record.attemptNumber !== expectedAttempt ||
        record.attemptNumber > 2 ||
        (record.attemptNumber === 1 && record.sourceThrough !== entry.sequence - 1) ||
        (expectedAttempt > 1 && boundaryRetryAllowed.get(boundary) !== true) ||
        starts.has(record.attemptId) ||
        committedBoundaries.has(boundary)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      boundaryAttempts.set(boundary, expectedAttempt);
      boundaryRetryAllowed.set(boundary, false);
      starts.set(record.attemptId, {
        entry: entry as SessionContextCompactionStartedRecord,
        terminal: false,
      });
      continue;
    }
    if (
      record.type !== "context_compaction_committed" &&
      record.type !== "context_compaction_failed" &&
      record.type !== "context_compaction_interrupted"
    ) {
      continue;
    }
    const started = starts.get(record.attemptId);
    if (
      started === undefined ||
      started.terminal ||
      !sameContextAttempt(started.entry.record, record)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    started.terminal = true;
    if (record.type !== "context_compaction_committed") {
      const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${started.entry.record.sourceDigest}`;
      boundaryRetryAllowed.set(
        boundary,
        (record.type === "context_compaction_failed" &&
          record.reason === "replacement_too_large") ||
          (record.type === "context_compaction_interrupted" && record.reason === "process_restart"),
      );
      continue;
    }
    const boundary = `${record.runId}:${record.windowNumber}:${record.sourceThrough}:${started.entry.record.sourceDigest}`;
    if (
      committedBoundaries.has(boundary) ||
      checkpointIds.has(record.checkpointId) ||
      record.retainedFrom < 1 ||
      record.retainedFrom > record.sourceThrough + 1 ||
      record.previousCheckpointSequence !== latestCheckpointSequence ||
      record.sourceDigest !== started.entry.record.sourceDigest ||
      !sameModelTargetIdentity(record.targetIdentity, genesis.record.targetIdentity) ||
      JSON.stringify(record.contextProfile) !== JSON.stringify(started.entry.record.contextProfile)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const retainedRecords = records.filter(
      (candidate) =>
        candidate.sequence >= record.retainedFrom && candidate.sequence <= record.sourceThrough,
    );
    const replacement = [
      createContextProjectionMessage(record.summary, record.evidence),
      ...modelMessagesFromCanonicalRecords(retainedRecords),
    ];
    if (
      !isContextEvidenceValid(record.evidence, records, record.runId, record.sourceThrough) ||
      digestContextMessages(replacement) !== record.replacementDigest
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    committedBoundaries.add(boundary);
    checkpointIds.add(record.checkpointId);
    latestCheckpointSequence = entry.sequence;
    latestWindowNumber = record.windowNumber;
  }
  const dangling = [...starts.values()].filter((start) => !start.terminal);
  if (
    dangling.length > 1 ||
    (dangling.length === 1 && dangling[0]?.entry.sequence !== records.at(-1)?.sequence)
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
}

function isContextEvidenceValid(
  evidence: SessionContextCompactionCommittedRecord["record"]["evidence"],
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
  runId: string,
  sourceThrough: number,
): boolean {
  const localEvidence: ContextEvidenceV1 = {
    schemaVersion: 1,
    modifiedFiles: evidence.modifiedFiles.filter((entry) => entry.sessionId === undefined),
    permissions: evidence.permissions.filter((entry) => entry.sessionId === undefined),
    toolResults: evidence.toolResults.filter((entry) => entry.sessionId === undefined),
    failures: evidence.failures.filter((entry) => entry.sessionId === undefined),
  };
  return (
    JSON.stringify(localEvidence) ===
    JSON.stringify(reduceContextEvidence(records, runId, sourceThrough))
  );
}

function sameContextAttempt(
  started: SessionContextCompactionStartedRecord["record"],
  terminal:
    | SessionContextCompactionCommittedRecord["record"]
    | SessionContextCompactionFailedRecord["record"]
    | SessionContextCompactionInterruptedRecord["record"],
): boolean {
  return (
    terminal.runId === started.runId &&
    terminal.attemptId === started.attemptId &&
    terminal.attemptNumber === started.attemptNumber &&
    terminal.windowNumber === started.windowNumber &&
    terminal.trigger === started.trigger &&
    terminal.sourceThrough === started.sourceThrough
  );
}

function isContextProfileValid(profile: ContextProfile): boolean {
  return isContextProfileSupported(profile);
}

function hasSuccessfullySettledAssistant(records: readonly SessionRecord[]): boolean {
  const completedResponseSequences = new Set(
    records.flatMap((entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "run_settled" &&
      entry.record.status === "completed"
        ? [entry.record.responseSequence]
        : [],
    ),
  );
  return records.some((entry) => {
    if (entry.schemaVersion !== 3) {
      return false;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_settled" &&
      entry.record.event.result.status === "completed"
    ) {
      return entry.record.event.result.answer.length > 0;
    }
    if (
      entry.record.type !== "model_response_completed" ||
      !completedResponseSequences.has(entry.sequence)
    ) {
      return false;
    }
    return hasNonEmptyModelResponseText(entry.record.response.text);
  });
}

function hasNonEmptyModelResponseText(field: string | SessionModelResponseField): boolean {
  return typeof field === "string"
    ? field.length > 0
    : field.storage === "inline"
      ? field.text.length > 0
      : field.reference.byteCount > 0;
}

function isMatchingStartedAttempt(
  attempt: ValidatedAttemptState | undefined,
  record: { readonly attempt: number; readonly turn: number },
): attempt is ValidatedAttemptState {
  return (
    attempt?.status === "started" &&
    attempt.turn === record.turn &&
    attempt.attempt === record.attempt
  );
}

function validateCompletedResponse(record: SessionModelResponseCompletedRecord["record"]): void {
  const { response } = record;
  if (
    response.toolCalls.length !== response.toolIntents.length ||
    ((response.finishReason === "stop" || response.finishReason === "length") &&
      response.toolCalls.length !== 0) ||
    (response.finishReason === "tool_calls" && response.toolCalls.length === 0)
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const callIds = new Set<string>();
  for (const [index, call] of response.toolCalls.entries()) {
    const intent = response.toolIntents[index];
    if (
      intent === undefined ||
      callIds.has(call.id) ||
      intent.callId !== call.id ||
      intent.name !== call.name ||
      intent.argumentsDigest !==
        `sha256:${createHash("sha256").update(call.argumentsJson).digest("hex")}` ||
      (intent.replay === "safe" &&
        (intent.effect === undefined || intent.definitionDigest === undefined))
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    callIds.add(call.id);
  }
}

function validatePermissionEffect(state: ValidatedToolState, effect: string | undefined): void {
  if (state.intent.effect === undefined || state.intent.effect !== effect) {
    throw new SessionLifecycleError("session_invalid");
  }
}

function isCanonicalChangePreviewReference(input: {
  readonly event: Extract<
    RuntimeEvent,
    { readonly type: "tool_permission_requested" | "tool_permission_decided" }
  >;
  readonly genesis: SessionGenesisRecord;
  readonly runId: string;
  readonly state: ValidatedToolState;
  readonly workspaceRoot: string;
}): boolean {
  const reference = input.event.changePreviewRef;
  if (reference === undefined) {
    return input.state.changePreviewRef === undefined;
  }
  const argumentsDigest = `sha256:${createHash("sha256")
    .update(input.state.call.argumentsJson, "utf8")
    .digest("hex")}`;
  if (
    (input.state.call.name !== "write_file" && input.state.call.name !== "edit_file") ||
    reference.source.projectId !== input.genesis.record.projectId ||
    reference.source.sessionId !== input.genesis.record.sessionId ||
    reference.source.runId !== input.runId ||
    reference.source.callId !== input.state.call.id ||
    reference.source.toolName !== input.state.call.name ||
    reference.source.argumentsDigest !== argumentsDigest ||
    (input.state.changePreviewRef !== undefined &&
      !isDeepStrictEqual(input.state.changePreviewRef, reference))
  ) {
    return false;
  }
  const expectedPreview = canonicalChangePreviewForToolCall({
    workspaceRoot: input.workspaceRoot,
    call: input.state.call,
  });
  if (expectedPreview === undefined) {
    return false;
  }
  const expectedBytes = Buffer.from(expectedPreview, "utf8");
  if (
    reference.id !== `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}` ||
    reference.byteCount !== expectedBytes.byteLength
  ) {
    return false;
  }
  input.state.changePreviewRef = reference;
  return true;
}

function sameResponseUsage(
  response:
    | {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens?: number;
        readonly cachedInputTokens?: number;
        readonly cacheMissInputTokens?: number;
      }
    | undefined,
  event: Extract<RuntimeEvent, { readonly type: "model_usage" }> | undefined,
): boolean {
  return (
    response?.inputTokens === event?.inputTokens &&
    response?.outputTokens === event?.outputTokens &&
    response?.reasoningTokens === event?.reasoningTokens &&
    response?.cachedInputTokens === event?.cachedInputTokens &&
    response?.cacheMissInputTokens === event?.cacheMissInputTokens
  );
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

function modelMessagesFromCompleteRecords(records: readonly SessionRecord[]): ModelMessage[] {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (currentRecords.length !== records.length) {
    throw new SessionLifecycleError("session_invalid");
  }
  const checkpoint = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_committed",
  );
  if (checkpoint?.record.type === "context_compaction_committed") {
    const checkpointRecord = checkpoint.record;
    const retainedRecords = currentRecords.filter(
      (record) =>
        record.sequence >= checkpointRecord.retainedFrom &&
        record.sequence <= checkpointRecord.sourceThrough,
    );
    const replacement = [
      createContextProjectionMessage(checkpointRecord.summary, checkpointRecord.evidence),
      ...modelMessagesFromCanonicalRecords(retainedRecords),
    ];
    if (digestContextMessages(replacement) !== checkpointRecord.replacementDigest) {
      throw new SessionLifecycleError("session_invalid");
    }
    const laterRecords = currentRecords.filter(
      (record) => record.sequence > (checkpoint?.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    return [...replacement, ...modelMessagesFromCanonicalRecords(laterRecords)];
  }
  return modelMessagesFromCanonicalRecords(currentRecords);
}

function modelMessagesFromCanonicalRecords(
  currentRecords: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const record of currentRecords) {
    if (record.record.type === "logical_run_started") {
      messages.push({ role: "user", content: record.record.userMessage });
      continue;
    }
    if (record.record.type !== "model_response_completed") {
      continue;
    }
    const responseRecord = record.record;
    const responseText = inlineModelResponseField(responseRecord.response.text);
    const responseReasoning =
      responseRecord.response.reasoning === undefined
        ? undefined
        : inlineModelResponseField(responseRecord.response.reasoning);
    messages.push({
      role: "assistant",
      content: responseText,
      ...(responseReasoning === undefined ? {} : { reasoning: responseReasoning }),
      toolCalls: responseRecord.response.toolCalls,
    });
    for (const call of responseRecord.response.toolCalls) {
      const resultRecord = currentRecords.find(
        (candidate) =>
          candidate.sequence > record.sequence &&
          candidate.record.type === "runtime_event" &&
          candidate.record.runId === responseRecord.runId &&
          (candidate.record.event.type === "tool_completed" ||
            candidate.record.event.type === "tool_failed") &&
          candidate.record.event.callId === call.id &&
          candidate.record.event.name === call.name,
      );
      if (
        resultRecord?.record.type !== "runtime_event" ||
        (resultRecord.record.event.type !== "tool_completed" &&
          resultRecord.record.event.type !== "tool_failed")
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const result =
        resultRecord.record.event.type === "tool_completed"
          ? ({ status: "completed", output: resultRecord.record.event.output } as const)
          : ({ status: "failed", error: resultRecord.record.event.error } as const);
      messages.push({ role: "tool", callId: call.id, name: call.name, result });
    }
  }
  return messages;
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

function isSkillContextCatalogSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
): boolean {
  return (
    next.registry.revision === previous.registry.revision + 1 &&
    next.catalog.revision === next.registry.revision &&
    JSON.stringify(next.budget) === JSON.stringify(previous.budget) &&
    JSON.stringify(next.activeProjectScopes) === JSON.stringify(previous.activeProjectScopes) &&
    next.activationCounter === previous.activationCounter &&
    JSON.stringify(next.active) ===
      JSON.stringify(
        previous.active.filter((activation) =>
          next.active.some((entry) => entry.activationIndex === activation.activationIndex),
        ),
      ) &&
    JSON.stringify(next.revocations.slice(0, previous.revocations.length)) ===
      JSON.stringify(previous.revocations) &&
    previous.active
      .filter(
        (activation) =>
          !next.active.some((entry) => entry.activationIndex === activation.activationIndex),
      )
      .every((activation) =>
        next.revocations
          .slice(previous.revocations.length)
          .some(
            (revocation) =>
              revocation.activationIndex === activation.activationIndex &&
              revocation.qualifiedId === activation.qualifiedId &&
              revocation.revokedAtRevision === next.registry.revision,
          ),
      )
  );
}

function isSkillContextPathSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
): boolean {
  return (
    next.registry.revision === previous.registry.revision + 1 &&
    next.catalog.revision === next.registry.revision &&
    JSON.stringify(next.budget) === JSON.stringify(previous.budget) &&
    JSON.stringify(next.active) === JSON.stringify(previous.active) &&
    next.activationCounter === previous.activationCounter &&
    JSON.stringify(next.revocations) === JSON.stringify(previous.revocations) &&
    JSON.stringify(next.extensionSources) === JSON.stringify(previous.extensionSources) &&
    previous.activeProjectScopes.every((scope) => next.activeProjectScopes.includes(scope)) &&
    next.activeProjectScopes.length > previous.activeProjectScopes.length
  );
}

function isSkillContextActivationSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  runId: string,
): boolean {
  const staticPrevious = {
    recordVersion: previous.recordVersion,
    profileVersion: previous.profileVersion,
    budget: previous.budget,
    sourceRoots: previous.sourceRoots,
    extensionSources: previous.extensionSources,
    registry: previous.registry,
    catalog: previous.catalog,
    revocations: previous.revocations,
  };
  const staticNext = {
    recordVersion: next.recordVersion,
    profileVersion: next.profileVersion,
    budget: next.budget,
    sourceRoots: next.sourceRoots,
    extensionSources: next.extensionSources,
    registry: next.registry,
    catalog: next.catalog,
    revocations: next.revocations,
  };
  if (
    JSON.stringify(staticPrevious) !== JSON.stringify(staticNext) ||
    next.activationCounter <= previous.activationCounter ||
    next.activationCounter - previous.activationCounter !==
      next.active.length - previous.active.length ||
    next.active.length <= previous.active.length ||
    JSON.stringify(next.active.slice(0, previous.active.length)) !== JSON.stringify(previous.active)
  ) {
    return false;
  }
  const seen = new Set(previous.active.map((activation) => activation.qualifiedId));
  return next.active.slice(previous.active.length).every((activation, offset) => {
    const candidate = next.registry.candidates.find(
      (entry) => entry.qualifiedId === activation.qualifiedId,
    );
    const valid =
      activation.activationIndex === previous.activationCounter + offset + 1 &&
      activation.catalogRevision === next.catalog.revision &&
      activation.runId === runId &&
      !seen.has(activation.qualifiedId) &&
      candidate !== undefined &&
      candidate.skillMdDigest === activation.skillMdDigest &&
      candidate.byteCount === activation.byteCount &&
      candidate.estimatedTokens === activation.estimatedTokens &&
      JSON.stringify(candidate.artifact) === JSON.stringify(activation.artifact);
    seen.add(activation.qualifiedId);
    return valid;
  });
}

function isSkillActivationBatchTransitionValid(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  record: SessionSkillActivationBatchCommittedRecord["record"],
): boolean {
  const newActivations = next.active.slice(previous.active.length);
  const activatedOutcomes = record.outcomes.filter((outcome) => outcome.status === "activated");
  const unchanged = JSON.stringify(previous) === JSON.stringify(next);
  if (
    (!unchanged && !isSkillContextActivationSuccessor(previous, next, record.runId)) ||
    (unchanged && activatedOutcomes.length > 0) ||
    activatedOutcomes.length !== newActivations.length ||
    new Set(record.outcomes.map((outcome) => outcome.requestId)).size !== record.outcomes.length
  ) {
    return false;
  }
  let activatedOffset = 0;
  return record.outcomes.every((outcome, outcomeIndex) => {
    const activation = next.active.find(
      (entry) => entry.activationIndex === outcome.activationIndex,
    );
    if (activation?.qualifiedId !== outcome.qualifiedId) {
      return false;
    }
    if (outcome.status === "activated") {
      const newActivation = newActivations[activatedOffset];
      activatedOffset += 1;
      return (
        newActivation?.qualifiedId === outcome.qualifiedId &&
        newActivation.requestId === outcome.requestId &&
        newActivation.activationIndex === outcome.activationIndex
      );
    }
    if (outcome.status === "already_active") {
      return previous.active.some(
        (entry) =>
          entry.qualifiedId === outcome.qualifiedId &&
          entry.activationIndex === outcome.activationIndex,
      );
    }
    return record.outcomes
      .slice(0, outcomeIndex)
      .some((entry) => entry.qualifiedId === outcome.qualifiedId);
  });
}

function isSkillActivationBatchValid(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  record: SessionSkillActivationBatchCommittedRecord["record"],
  run: SessionLogicalRunStartedRecord["record"],
): boolean {
  if (!isSkillActivationBatchTransitionValid(previous, next, record)) {
    return false;
  }
  const explicitSelections = run.skills ?? [];
  const explicitRequestIds = new Set(explicitSelections.map((selection) => selection.requestId));
  const isExplicitBatch = record.outcomes.some((outcome) =>
    explicitRequestIds.has(outcome.requestId),
  );
  if (!isExplicitBatch) {
    return record.outcomes.length === 1 && record.outcomes[0]?.status === "activated";
  }
  return (
    record.outcomes.length === explicitSelections.length &&
    record.outcomes.every(
      (outcome, index) =>
        outcome.requestId === explicitSelections[index]?.requestId &&
        outcome.selection === explicitSelections[index]?.selection &&
        resolvePersistedSkillSelection(previous, outcome.selection) === outcome.qualifiedId,
    )
  );
}

function resolvePersistedSkillSelection(
  context: SkillContextRecordV1,
  selection: string,
): string | undefined {
  const exact = context.registry.candidates.find(
    (candidate) => candidate.qualifiedId === selection,
  );
  if (exact !== undefined) {
    return exact.qualifiedId;
  }
  const shortMatches = context.registry.candidates.filter(
    (candidate) => candidate.name === selection,
  );
  return shortMatches.length === 1 ? shortMatches[0]?.qualifiedId : undefined;
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
  const compactionUsage: ContextUsageTotals = currentRecords.reduce<ContextUsageTotals>(
    (totals, entry) => {
      if (
        entry.record.type !== "context_compaction_committed" &&
        entry.record.type !== "context_compaction_failed" &&
        entry.record.type !== "context_compaction_interrupted"
      ) {
        return totals;
      }
      const usage = entry.record.usage;
      if (usage === undefined) {
        return incrementUnknownContextUsage(totals);
      }
      if ("status" in usage) {
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
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheMissInputTokens: 0,
      unknownCalls: 0,
    },
  );
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
  const store = await openSessionStore(options, snapshot.sessionId);
  await store.append({
    schemaVersion: 3,
    sequence: records.length + 1,
    record: {
      type: "provider_attempt_interrupted",
      runId: attempt.record.runId,
      turn: attempt.record.turn,
      attempt: attempt.record.attempt,
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

function inlineModelResponseField(field: string | SessionModelResponseField): string {
  if (typeof field === "string") {
    return field;
  }
  if (field.storage === "inline") {
    return field.text;
  }
  throw new SessionLifecycleError("session_invalid");
}

function sessionLifecycleErrorMessage(code: SessionLifecycleError["code"]): string {
  switch (code) {
    case "mcp_bootstrap_failed":
      return "The exact MCP package bootstrap failed.";
    case "mcp_config_invalid":
      return "The project MCP configuration is invalid.";
    case "mcp_catalog_invalid":
      return "The MCP tool catalog is invalid.";
    case "mcp_catalog_too_large":
      return "The MCP tool catalog exceeded its bounded limits.";
    case "mcp_initialize_failed":
      return "The MCP server initialization failed.";
    case "mcp_start_failed":
      return "The approved MCP server could not be started.";
    case "mcp_startup_timeout":
      return "The MCP server startup deadline elapsed.";
    case "mcp_activation_cancelled":
      return "The MCP activation was cancelled before it became ready.";
    case "mcp_shutdown_unconfirmed":
      return "The MCP server shutdown could not be causally confirmed.";
    case "project_in_use":
      return "Another process owns lifecycle mutations for this canonical project.";
    case "project_owner_unavailable":
      return "The OS-backed project lifecycle owner is unavailable.";
    case "session_branch_boundary_invalid":
      return "The requested branch position is not a complete session boundary.";
    case "session_invalid":
      return "The session history is invalid.";
    case "session_model_target_incompatible":
      return "The requested exact model target is not compatible with this session boundary.";
    case "session_model_target_unavailable":
      return "The requested exact model target is not ready in this runtime.";
    case "session_not_found":
      return "The session does not exist in this project.";
    case "session_project_mismatch":
      return "The session belongs to another canonical project.";
  }
}
