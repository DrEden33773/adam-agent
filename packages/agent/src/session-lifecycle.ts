import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import {
  AgentSession,
  type ModelMessage,
  type PermissionDecisionCommand,
  type PermissionDecisionCommandResult,
  type RunOptions,
  type RunResult,
  type RuntimeEvent,
  type RuntimeEventListener,
} from "./index.js";
import type { ModelTargetIdentity, ModelTargets } from "./model-targets.js";
import {
  createProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
} from "./project-lifecycle-owner.js";
import {
  type AgentSessionDurableContext,
  sessionDurableContext,
} from "./session-durable-context.js";
import {
  createJsonlSessionStore,
  openJsonlSessionStore,
  readJsonlSessionRecords,
  type SessionGenesisRecord,
  type SessionLogicalRunStartedRecord,
  type SessionModelResponseCompletedRecord,
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
      readonly finishReason: "stop" | "tool_calls";
    };
  };
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
          | "non_resumable_legacy_session";
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
    };

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

  const inspectSession = async (input: {
    readonly sessionId: string;
  }): Promise<SessionSnapshot> => {
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
    return snapshotFromRecords(first, records);
  };

  const resumeSession = async (input: {
    readonly sessionId: string;
  }): Promise<SessionResumeResult> => {
    let snapshot = await inspectSession(input);
    if (snapshot.schemaVersion === 3 && snapshot.status === "interrupted") {
      const restoredUserMessage = await appendMissingUserMessage(options, snapshot);
      if (restoredUserMessage) {
        snapshot = await inspectSession(input);
      }
      if (snapshot.schemaVersion !== 3) {
        throw new SessionLifecycleError("session_invalid");
      }
      const didNormalize = await appendDanglingAttemptInterruption(options, snapshot);
      if (didNormalize) {
        snapshot = await inspectSession(input);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleRunTerminalIntent(options, snapshot))
      ) {
        snapshot = await inspectSession(input);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleInterruptedCancellation(options, snapshot))
      ) {
        snapshot = await inspectSession(input);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleCompletedResponseTerminal(options, snapshot))
      ) {
        snapshot = await inspectSession(input);
      }
      if (
        snapshot.schemaVersion === 3 &&
        snapshot.status === "interrupted" &&
        (await settleIndeterminateToolEffects(options, snapshot))
      ) {
        snapshot = await inspectSession(input);
      }
    }
    if (snapshot.schemaVersion === 3) {
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
        signal: new AbortController().signal,
      });
      const target = targetSnapshot.targets.find(
        (candidate) => candidate.identity.targetId === snapshot.targetIdentity.targetId,
      );
      if (target === undefined || !sameTargetIdentity(target.identity, snapshot.targetIdentity)) {
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
        if (!Number.isSafeInteger(input.atSequence) || input.atSequence <= 0) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
        let parent = await inspectSession({ sessionId: input.parentSessionId });
        if (parent.schemaVersion !== 3) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
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
            parent = (await inspectSession({
              sessionId: input.parentSessionId,
            })) as CurrentSessionSnapshot;
          }
          const interruptedAttempt = await appendDanglingAttemptInterruption(options, parent);
          if (interruptedAttempt) {
            parent = (await inspectSession({
              sessionId: input.parentSessionId,
            })) as CurrentSessionSnapshot;
          }
          const terminalIntent =
            parent.status === "interrupted" && (await settleRunTerminalIntent(options, parent));
          if (terminalIntent) {
            parent = (await inspectSession({
              sessionId: input.parentSessionId,
            })) as CurrentSessionSnapshot;
          }
          const cancelledRun =
            parent.status === "interrupted" &&
            (await settleInterruptedCancellation(options, parent));
          if (cancelledRun) {
            parent = (await inspectSession({
              sessionId: input.parentSessionId,
            })) as CurrentSessionSnapshot;
          }
          const indeterminateEffect =
            parent.status === "interrupted" &&
            (await settleIndeterminateToolEffects(options, parent));
          if (indeterminateEffect) {
            parent = (await inspectSession({
              sessionId: input.parentSessionId,
            })) as CurrentSessionSnapshot;
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
        if (!isCompleteBranchBoundary(parentPrefix)) {
          throw new SessionLifecycleError("session_branch_boundary_invalid");
        }
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
            lineage: {
              parentSessionId: input.parentSessionId,
              parentEventPosition,
              prefixDigest: `sha256:${createHash("sha256").update(prefix).digest("hex")}`,
            },
          },
        };
        await store.append(genesis);
        return snapshotFromGenesis(genesis, 1);
      });
    },
    async create(input) {
      return withOwner(async () => {
        const sessionId = randomUUID();
        const projectId = await canonicalProjectId(options.workspaceRoot);
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
          },
        };
        await store.append(genesis);
        return snapshotFromGenesis(genesis, 1);
      });
    },
    async continue(input) {
      return withOwner(async () => {
        const resumed = await resumeSession({ sessionId: input.sessionId });
        if (resumed.status !== "ready" || resumed.snapshot.status === "settled") {
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
          allowExperimental: resumed.snapshot.targetIdentity.certification === "experimental",
          signal: input.signal ?? new AbortController().signal,
        });
        if (!sameTargetIdentity(resolved.identity, resumed.snapshot.targetIdentity)) {
          throw new SessionLifecycleError("session_model_target_incompatible");
        }
        const records = await readJsonlSessionRecords({
          workspaceRoot: options.workspaceRoot,
          sessionId: input.sessionId,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        });
        const inheritedMessages = await createBranchMessages(options, records);
        const resumeState =
          resumed.snapshot.status === "interrupted"
            ? createAgentResumeState(records, options, resumed.snapshot)
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
        const sessionDependencies = {
          model: resolved.driver,
          store: store as unknown as SessionStore,
          [sessionDurableContext]: {
            nextSequence: resumed.snapshot.lastSequence + 1,
            targetIdentity: resumed.snapshot.targetIdentity,
            ...(resumeState !== undefined || inheritedMessages.length === 0
              ? {}
              : { initialMessages: inheritedMessages }),
            ...(durableResumeState === undefined ? {} : { resume: durableResumeState }),
          },
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
          const snapshot = await inspectSession({ sessionId: input.sessionId });
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
  requested: boolean;
  started: boolean;
  terminal: boolean;
  terminalErrorCode?: string;
};

type ValidatedAttemptState = {
  readonly attempt: number;
  readonly turn: number;
  response?: SessionModelResponseCompletedRecord["record"];
  status: "started" | "interrupted" | "completed";
};

function validateCurrentSessionHistory(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): void {
  if (
    genesis.sequence !== 1 ||
    records[0] !== genesis ||
    records.some((record) => record.schemaVersion !== 3)
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
  let terminalIntent: RunResult | undefined;
  let lastUsage: Extract<RuntimeEvent, { readonly type: "model_usage" }> | undefined;
  let toolStates = new Map<string, ValidatedToolState>();

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
    if (run === undefined || record.runId !== run.runId) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (record.type === "provider_attempt_started") {
      if (
        terminalIntent !== undefined ||
        !sawUserMessage ||
        !sameTargetIdentity(record.targetIdentity, genesis.record.targetIdentity)
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
        (record.reason === "process_restart" && record.result !== undefined) ||
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
        !sameTargetIdentity(record.targetIdentity, genesis.record.targetIdentity)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      validateCompletedResponse(record);
      if (!sameResponseUsage(record.response.usage, lastUsage)) {
        throw new SessionLifecycleError("session_invalid");
      }
      attemptState.status = "completed";
      attemptState.response = record;
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
      if (
        terminalIntent !== undefined ||
        attemptState?.status !== "completed" ||
        attemptState.response?.response.text !== event.text ||
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
    if (event.type === "session_settled") {
      if (
        !sawUserMessage ||
        attemptState?.status === "started" ||
        (terminalIntent !== undefined &&
          JSON.stringify(terminalIntent) !== JSON.stringify(event.result)) ||
        (event.result.status === "completed" &&
          (attemptState?.status !== "completed" ||
            attemptState.response?.response.finishReason !== "stop" ||
            attemptState.response.response.text !== event.result.answer ||
            !sawModelCompletion)) ||
        (event.result.status === "cancelled" && !sawSessionInterruption) ||
        (event.result.status === "failed" &&
          (attemptState === undefined ||
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
      if (event.type === "tool_requested") {
        if (state.requested) {
          throw new SessionLifecycleError("session_invalid");
        }
        state.requested = true;
      } else if (event.type === "tool_permission_requested") {
        if (!state.requested || state.started || state.decision !== undefined) {
          throw new SessionLifecycleError("session_invalid");
        }
        validatePermissionEffect(state, event.effect);
      } else if (event.type === "tool_permission_decided") {
        if (!state.requested || state.started || state.decision !== undefined) {
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
    (response.finishReason === "stop" && response.toolCalls.length !== 0) ||
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
  const { parentGenesis } = await readValidatedLineagePrefix(options, genesis);
  await validateSessionLineage(
    options,
    parentGenesis,
    new Set([...visited, lineage.parentSessionId]),
  );
}

async function createBranchMessages(
  options: SessionLifecycleOptions,
  records: readonly SessionRecord[],
): Promise<ModelMessage[]> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const lineage = genesis.record.lineage;
  if (lineage === undefined) {
    return [];
  }
  const { prefixRecords: parentRecords } = await readValidatedLineagePrefix(options, genesis);
  return [
    ...(await createBranchMessages(options, parentRecords)),
    ...modelMessagesFromCompleteRecords(parentRecords),
  ];
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
    messages.push({
      role: "assistant",
      content: responseRecord.response.text,
      ...(responseRecord.response.reasoning === undefined
        ? {}
        : { reasoning: responseRecord.response.reasoning }),
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
    return records.length === 1 && first !== undefined && isGenesisRecord(first);
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

function sameTargetIdentity(left: ModelTargetIdentity, right: ModelTargetIdentity): boolean {
  return (
    left.targetId === right.targetId &&
    left.vendor === right.vendor &&
    left.modelId === right.modelId &&
    left.route === right.route &&
    left.upstreamProviderId === right.upstreamProviderId &&
    left.profileVersion === right.profileVersion &&
    left.certification === right.certification
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
    ...(genesis.record.lineage === undefined ? {} : { lineage: genesis.record.lineage }),
  };
}

function snapshotFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): CurrentSessionSnapshot {
  if (records.some((record) => record.schemaVersion !== 3)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun === undefined || latestRun.record.type !== "logical_run_started") {
    return snapshotFromGenesis(genesis, records.length);
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
      : undefined;
  return {
    ...snapshotFromGenesis(genesis, records.length),
    status: result === undefined ? "interrupted" : "settled",
    run: {
      runId,
      status: result === undefined ? "interrupted" : "settled",
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
        record.record.type === "runtime_event" &&
        record.record.runId === runId &&
        record.record.event.type === "session_settled",
    )
  ) {
    return false;
  }
  const responseRecord = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  if (
    responseRecord?.record.type !== "model_response_completed" ||
    !sameTargetIdentity(responseRecord.record.targetIdentity, snapshot.targetIdentity)
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
  if (!isStopResponse && hasUnsafeStartedEffect) {
    return false;
  }
  if (!missingRequiredUsage && !exhaustedTokenBudget && !isStopResponse) {
    return false;
  }
  const result: RunResult = missingRequiredUsage
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
      : { status: "completed", answer: responseRecord.record.response.text };
  const store = await openJsonlSessionStore<SessionRecord>({
    workspaceRoot: options.workspaceRoot,
    sessionId: snapshot.sessionId,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
  let nextSequence = records.length + 1;
  const responseWasPublished = currentRecords.some(
    (record) =>
      record.sequence > responseRecord.sequence &&
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "model_message_completed",
  );
  if (!responseWasPublished) {
    await store.append({
      schemaVersion: 3,
      sequence: nextSequence,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_completed", text: responseRecord.record.response.text },
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
      event: { type: "session_settled", result },
    },
  });
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
    !sameTargetIdentity(responseRecord.targetIdentity, snapshot.targetIdentity)
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
  const messages: NonNullable<AgentSessionDurableContext["resume"]>["messages"][number][] = [
    { role: "user", content: run.record.userMessage },
  ];
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
      responseRecord.record.turn >= boundaryTurn
    ) {
      continue;
    }
    const { response } = responseRecord.record;
    messages.push({
      role: "assistant",
      content: response.text,
      ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
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
        const reusablePermission =
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
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new SessionLifecycleError("session_invalid");
  }
  return total;
}

async function canonicalProjectId(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
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
