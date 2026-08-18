import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFileArtifactStore, readFileArtifact } from "./artifact-store.js";
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
  AgentSession,
  type ContextUsageTotals,
  type ModelMessage,
  type PermissionDecisionCommand,
  type PermissionDecisionCommandResult,
  type RunOptions,
  type RunResult,
  type RuntimeEvent,
  type RuntimeEventListener,
} from "./index.js";
import {
  type ModelTargetIdentity,
  type ModelTargets,
  sameModelTargetIdentity,
} from "./model-targets.js";
import {
  createProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
} from "./project-lifecycle-owner.js";
import {
  assemblePromptMessagesV1,
  createPromptContextV1,
  digestPromptRequestV1,
  isPromptContextCompatible,
  isPromptContextRecordCompatible,
  isPromptContextRecordValid,
  type PromptContextRecordV1,
  type PromptContextSnapshot,
  promptContextSnapshot,
  replacePromptRepositoryV1,
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
  createJsonlSessionStore,
  openJsonlSessionStore,
  readJsonlSessionRecords,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionFailedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionContextCompactionStartedRecord,
  type SessionGenesisRecord,
  type SessionLogicalRunStartedRecord,
  type SessionModelResponseCompletedRecord,
  type SessionModelResponseField,
  type SessionRecord,
  type SessionStore,
} from "./session-store.js";
import type { PermissionPolicy, ToolRegistry } from "./tool-runtime.js";

export type CurrentSessionSnapshot = {
  readonly schemaVersion: 3;
  readonly sessionId: string;
  readonly projectId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly status: "idle" | "interrupted" | "settled";
  readonly lastSequence: number;
  readonly promptContext?: PromptContextSnapshot;
  readonly context?: SessionContextSnapshot;
  readonly degradation?: {
    readonly code: "model_response_artifact_corrupt" | "model_response_artifact_missing";
    readonly artifactId: string;
    readonly field: "reasoning" | "text";
    readonly responseSequence: number;
  };
  readonly lineage?: {
    readonly parentSessionId: string;
    readonly parentEventPosition: number;
    readonly prefixDigest: string;
  };
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

export type SessionLifecycleOptions = {
  readonly modelTargets?: ModelTargets;
  readonly permissions?: PermissionPolicy;
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
  readonly tools?: ToolRegistry;
};

export type SessionContinueResult = {
  readonly result: RunResult;
  readonly snapshot: CurrentSessionSnapshot;
};

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

export type SessionCommand =
  | { readonly type: "create"; readonly targetIdentity: ModelTargetIdentity }
  | { readonly type: "resume"; readonly sessionId: string }
  | {
      readonly type: "continue";
      readonly sessionId: string;
      readonly input?: { readonly text: string };
      readonly limits?: RunOptions["limits"];
      readonly signal?: AbortSignal;
    }
  | {
      readonly type: "branch";
      readonly parentSessionId: string;
      readonly atSequence: number;
      readonly targetId?: string;
    }
  | { readonly type: "reload_repository_instructions"; readonly sessionId: string };

export interface SessionLifecycle {
  branch(input: {
    readonly parentSessionId: string;
    readonly atSequence: number;
    readonly targetId?: string;
  }): Promise<CurrentSessionSnapshot>;
  continue(input: {
    readonly sessionId: string;
    readonly input?: { readonly text: string };
    readonly limits?: RunOptions["limits"];
    readonly signal?: AbortSignal;
  }): Promise<SessionContinueResult>;
  create(input: { readonly targetIdentity: ModelTargetIdentity }): Promise<CurrentSessionSnapshot>;
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
  inspect(input: { readonly sessionId: string }): Promise<SessionSnapshot>;
  reloadRepositoryInstructions(input: {
    readonly sessionId: string;
  }): Promise<RepositoryInstructionsReloadResult>;
  resume(input: { readonly sessionId: string }): Promise<SessionResumeResult>;
  subscribe(listener: RuntimeEventListener): () => void;
}

export class SessionLifecycleError extends Error {
  readonly code:
    | "session_branch_boundary_invalid"
    | "session_invalid"
    | "session_model_target_incompatible"
    | "session_model_target_unavailable"
    | "session_not_found"
    | "session_project_mismatch"
    | "project_in_use"
    | "project_owner_unavailable";

  constructor(code: SessionLifecycleError["code"]) {
    super(sessionLifecycleErrorMessage(code));
    this.name = "SessionLifecycleError";
    this.code = code;
  }
}

export function createSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycle {
  const listeners = new Set<RuntimeEventListener>();
  let activeSession: AgentSession | undefined;
  const owner = createProjectLifecycleOwner(options);
  const withOwner = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await owner.run(operation);
    } catch (error) {
      if (error instanceof ProjectLifecycleOwnerError) {
        throw new SessionLifecycleError(error.code);
      }
      throw error;
    }
  };

  const inspectSession = async (
    input: { readonly sessionId: string },
    artifactCache = createArtifactMaterializationCache(),
  ): Promise<SessionSnapshot> => {
    const records = await readJsonlSessionRecords({
      workspaceRoot: options.workspaceRoot,
      sessionId: input.sessionId,
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    });
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
    validateCurrentSessionHistory(first, records);
    await validateSessionLineage(options, first, new Set([input.sessionId]));
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
    return inheritedContext === undefined ? snapshot : { ...snapshot, context: inheritedContext };
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
      const promptRecords = await readJsonlSessionRecords({
        workspaceRoot: options.workspaceRoot,
        sessionId: input.sessionId,
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      });
      const promptGenesis = promptRecords[0];
      if (
        snapshot.promptContext !== undefined &&
        (promptGenesis === undefined ||
          !isGenesisRecord(promptGenesis) ||
          promptGenesis.record.promptContext === undefined ||
          !isPromptContextRecordCompatible(promptGenesis.record.promptContext, options.tools) ||
          !isPromptContextCompatible(snapshot.promptContext, options.tools))
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
        if (!Number.isSafeInteger(input.atSequence) || input.atSequence <= 0) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        let parent = await inspectSession({ sessionId: input.parentSessionId }, artifactCache);
        if (parent.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        if (parent.degradation !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        let parentRecords = await readJsonlSessionRecords({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.parentSessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const requestedCurrentTail = input.atSequence === parentRecords.length;
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
            parentRecords = await readJsonlSessionRecords({
              workspaceRoot: options.workspaceRoot,
              sessionId: input.parentSessionId,
              ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
            });
          }
        }
        const parentEventPosition =
          requestedCurrentTail && normalizedCurrentTail ? parentRecords.length : input.atSequence;
        if (parentEventPosition > parentRecords.length) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const parentPrefix = parentRecords.slice(0, parentEventPosition);
        const parentGenesis = parentPrefix[0];
        if (parentGenesis === undefined || !isGenesisRecord(parentGenesis)) {
          throw new SessionLifecycleError("session_invalid");
        }
        validateCurrentSessionHistory(parentGenesis, parentPrefix);
        await replayArtifactBytesFromLineage(options, parentGenesis, parentPrefix, artifactCache);
        if (!isCompleteBranchBoundary(parentPrefix)) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        const parentPromptContext = promptContextRecordFromRecords(parentGenesis, parentPrefix);
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
        const store = await createJsonlSessionStore<SessionRecord>({
          workspaceRoot: options.workspaceRoot,
          sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const prefix = `${parentPrefix.map((record) => JSON.stringify(record)).join("\n")}\n`;
        const genesis: SessionGenesisRecord = {
          schemaVersion: 3,
          sequence: 1,
          record: {
            type: "session_genesis",
            sessionId,
            projectId: parent.projectId,
            targetIdentity,
            ...(parentPromptContext === undefined ? {} : { promptContext: parentPromptContext }),
            lineage: {
              parentSessionId: input.parentSessionId,
              parentEventPosition,
              prefixDigest: `sha256:${createHash("sha256").update(prefix).digest("hex")}`,
            },
          },
        };
        await store.append(genesis);
        const context = await contextSnapshotFromLineage(
          options,
          parentGenesis,
          parentPrefix,
          artifactCache,
        );
        return {
          ...snapshotFromGenesis(genesis, 1),
          ...(context === undefined ? {} : { context }),
        };
      });
    },
    async create(input) {
      return withOwner(async () => {
        const sessionId = randomUUID();
        const projectId = await canonicalProjectId(options.workspaceRoot);
        const repository = await loadInitialRepositoryInstructions({
          workspaceRoot: options.workspaceRoot,
        });
        const store = await createJsonlSessionStore<SessionRecord>({
          workspaceRoot: options.workspaceRoot,
          sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const genesis: SessionGenesisRecord = {
          schemaVersion: 3,
          sequence: 1,
          record: {
            type: "session_genesis",
            sessionId,
            projectId,
            targetIdentity: input.targetIdentity,
            promptContext: createPromptContextV1(options.tools, repository),
          },
        };
        await store.append(genesis);
        return snapshotFromGenesis(genesis, 1);
      });
    },
    async continue(input) {
      return withOwner(async () => {
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
        if (resumed.snapshot.status === "settled") {
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
        const records = await readJsonlSessionRecords({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const first = records[0];
        if (first === undefined || !isGenesisRecord(first)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const artifactInspection = await materializeModelResponseArtifacts(
          options,
          first,
          records,
          { allowDegraded: false },
          artifactCache,
        );
        const replayRecords = artifactInspection.records;
        const activePromptContext = promptContextRecordFromRecords(first, replayRecords);
        const referencedModelResponseArtifactBytes = await replayArtifactBytesFromLineage(
          options,
          first,
          records,
          artifactCache,
        );
        const [inheritedMessages, inheritedEvidence] = await Promise.all([
          createBranchMessages(options, records, artifactCache),
          createBranchEvidence(options, records),
        ]);
        const resumeState =
          resumed.snapshot.status === "interrupted"
            ? createAgentResumeState(replayRecords, options, resumed.snapshot)
            : undefined;
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
        const store = await openJsonlSessionStore<SessionRecord>({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const durableOutputLimits = (
          options as SessionLifecycleOptions & {
            readonly [sessionDurableOutputLimits]?: AgentSessionDurableOutputLimits;
          }
        )[sessionDurableOutputLimits];
        const sessionDependencies = {
          artifactStore: await createFileArtifactStore({
            root: join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
          }),
          model: resolved.driver,
          store: store as unknown as SessionStore,
          [sessionDurableContext]: {
            ...(inheritedMessages.length === 0 ? {} : { hasInheritedMessages: true }),
            nextSequence: resumed.snapshot.lastSequence + 1,
            projectId: resumed.snapshot.projectId,
            referencedModelResponseArtifactBytes,
            ...(activePromptContext === undefined
              ? {}
              : { repositoryWorkspaceRoot: options.workspaceRoot }),
            sessionId: resumed.snapshot.sessionId,
            targetIdentity: resumed.snapshot.targetIdentity,
            ...(activePromptContext === undefined ? {} : { promptContext: activePromptContext }),
            ...(hasContextEvidence(inheritedEvidence) ? { inheritedEvidence } : {}),
            ...(resumeState !== undefined || inheritedMessages.length === 0
              ? {}
              : { initialMessages: inheritedMessages }),
            ...(durableResumeState === undefined ? {} : { resume: durableResumeState }),
          },
          contextProfile: resolved.contextProfile,
          ...(durableOutputLimits === undefined
            ? {}
            : { [sessionDurableOutputLimits]: durableOutputLimits }),
          ...(options.tools === undefined ? {} : { tools: options.tools }),
          ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        };
        const session = new AgentSession(sessionDependencies);
        const unsubscribe = session.subscribe((event) => {
          for (const listener of listeners) {
            listener(event);
          }
        });
        activeSession = session;
        try {
          const runLimits = resumeState?.limits ?? input.limits;
          const result = await session.run(
            input.input ?? { text: resumeState?.userMessage ?? "" },
            {
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(runLimits === undefined ? {} : { limits: runLimits }),
            },
          );
          const snapshot = await inspectSession({ sessionId: input.sessionId }, artifactCache);
          if (snapshot.schemaVersion !== 3) {
            throw new SessionLifecycleError("session_invalid");
          }
          return { result, snapshot };
        } finally {
          if (activeSession === session) {
            activeSession = undefined;
          }
          unsubscribe();
        }
      });
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
    async inspect(input) {
      return inspectSession(input);
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
        const records = await readJsonlSessionRecords({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const genesis = records[0];
        if (genesis === undefined || !isGenesisRecord(genesis)) {
          throw new SessionLifecycleError("session_invalid");
        }
        const context = promptContextRecordFromRecords(genesis, records);
        if (context === undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        const store = await openJsonlSessionStore<SessionRecord>({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
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
    async resume(input) {
      return withOwner(() => resumeSession(input));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function isGenesisRecord(record: SessionRecord): record is SessionGenesisRecord {
  return record.schemaVersion === 3 && record.record.type === "session_genesis";
}

type ValidatedToolState = {
  readonly call: { readonly id: string; readonly name: string; readonly argumentsJson: string };
  readonly intent: {
    readonly effect?: string | undefined;
  };
  decision?: "allow" | "deny";
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
): void {
  if (
    genesis.sequence !== 1 ||
    records[0] !== genesis ||
    records.some((record) => record.schemaVersion !== 3) ||
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
  const activatableRepositoryRevisions = new Map<number, ValidatedToolState>();
  const publishedRepositoryRevisions = new Set<number>();

  for (const entry of currentRecords.slice(1)) {
    if (sawSettlement) {
      throw new SessionLifecycleError("session_invalid");
    }
    const record = entry.record;
    if (record.type === "session_genesis") {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "logical_run_started") {
      if (run !== undefined || attemptState !== undefined || sawUserMessage) {
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
        record.repository.sources.some((source) => source.loadReason !== expectedLoadReason)
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
    if (run === undefined || record.runId !== run.runId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "provider_attempt_started") {
      if (
        terminalIntent !== undefined ||
        !sawUserMessage ||
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
      sawSettlement = true;
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
      sawSettlement = true;
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
              event.error.code !== "repository_instructions_unavailable"
            : state.repositoryActivationPublished !== true ||
              (state.repositoryDisposition === "mutation_retry_required" &&
                (event.type !== "tool_failed" ||
                  event.error.code !== "repository_context_changed"))))
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
  if (JSON.stringify(genesis.record.promptContext) !== JSON.stringify(expectedPromptContext)) {
    throw new SessionLifecycleError("session_invalid");
  }
  await validateInheritedContextEvidence(options, parentGenesis, prefixRecords);
  await validateSessionLineage(
    options,
    parentGenesis,
    new Set([...visited, lineage.parentSessionId]),
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
    const ownMessages = modelMessagesFromCompleteRecords(prefix);
    const transcript = prefix.some(
      (candidate) =>
        candidate.schemaVersion === 3 && candidate.record.type === "context_compaction_committed",
    )
      ? ownMessages
      : [...inheritedMessages, ...ownMessages];
    const messages = assemblePromptMessagesV1(transcript, context);
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
  let parentRecords: readonly SessionRecord[];
  try {
    parentRecords = await readJsonlSessionRecords({
      workspaceRoot: options.workspaceRoot,
      sessionId: lineage.parentSessionId,
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    });
  } catch {
    throw new SessionLifecycleError("session_invalid");
  }
  const parentGenesis = parentRecords[0];
  if (
    parentGenesis === undefined ||
    !isGenesisRecord(parentGenesis) ||
    parentGenesis.record.sessionId !== lineage.parentSessionId ||
    parentGenesis.record.projectId !== childGenesis.record.projectId ||
    lineage.parentEventPosition > parentRecords.length
  ) {
    throw new SessionLifecycleError("session_invalid");
  }
  const prefixRecords = parentRecords.slice(0, lineage.parentEventPosition);
  const prefix = `${prefixRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const digest = `sha256:${createHash("sha256").update(prefix).digest("hex")}`;
  if (digest !== lineage.prefixDigest || !isCompleteBranchBoundary(prefixRecords)) {
    throw new SessionLifecycleError("session_invalid");
  }
  validateCurrentSessionHistory(parentGenesis, prefixRecords);
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
            (entry.record.type === "repository_instructions_committed" ||
              entry.record.type === "repository_instructions_failed") &&
            entry.record.trigger === undefined,
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
    if (entry.schemaVersion !== 3 || entry.record.type !== "repository_instructions_committed") {
      continue;
    }
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
    return {
      ...snapshotFromGenesis(genesis, records.length),
      ...(promptContext === undefined ? {} : { promptContext }),
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
  return {
    ...snapshotFromGenesis(genesis, records.length),
    ...(promptContext === undefined ? {} : { promptContext }),
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const records = await readJsonlSessionRecords({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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
              candidate.record.type === "repository_instructions_failed") &&
            candidate.record.trigger?.runId === runId &&
            candidate.record.trigger.callId === call.id &&
            candidate.record.trigger.name === call.name,
        );
        const repositoryTrigger =
          repositoryRecord?.record.type === "repository_instructions_committed" ||
          repositoryRecord?.record.type === "repository_instructions_failed"
            ? repositoryRecord.record.trigger
            : undefined;
        const committedRepository =
          repositoryRecord?.record.type === "repository_instructions_committed"
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
        pendingToolCalls.push({
          call,
          requested,
          started,
          ...(repositoryActivation === undefined ? {} : { repositoryActivation }),
          ...(repositoryTrigger === undefined
            ? {}
            : { repositoryDisposition: repositoryTrigger.disposition }),
          ...(reusablePermission === undefined ? {} : { reusablePermission }),
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

async function canonicalProjectId(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
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
