import type { ManagedControlCommand, ManagedControlReceipt } from "@adam-agent/presentation";
import type { ArtifactStore } from "./artifact-store.js";
import type { PlanCycleSnapshot } from "./plan-mode.js";

export type { ManagedControlCommand, ManagedControlReceipt } from "@adam-agent/presentation";

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  AgentSession,
  type ManagedAgentRequestBoundary,
  managedAgentInterruptAfterEffect,
  managedAgentPartialOutput,
  managedAgentRequestBoundary,
  managedAgentRuntimeBoundary,
  managedAgentStorageQuota,
  sessionRecordCommittedBarrier,
} from "./agent-session.js";
import type { ModelDriver } from "./agent-session-contracts.js";
import type { ContextProfile } from "./context-profile.js";
import {
  assertFleetReservation,
  createDelegationEnvelope,
  type DelegationEnvelope,
  delegationEnvelopeSchema,
  delegationOriginSchema,
  FleetBudgetError,
  type FleetPolicy,
  type FleetUsage,
  fleetBudget,
  fleetSessionCeiling,
  fleetStorage,
  managedChildTerminalBytes,
  managedControlTerminalBytes,
  resolveFleetPolicy,
  storedRecordBytes,
} from "./fleet-ledger.js";
import {
  type ManagedAgentInactivityScheduler,
  ManagedAgentStoreError,
  nodeManagedAgentDeadlineScheduler,
} from "./managed-agent.js";
import {
  foldManagedControl,
  type ManagedControlEvent,
  type ManagedControlFrozen,
  type ManagedControlIdentity,
  type ManagedControlRecord,
  type ManagedControlStore,
  type ManagedWorkspaceSnapshot,
  managedAcceptedInput,
  managedControlDigest,
  managedControlFrozenSchema,
  managedControlLink,
  managedTranscriptLink,
} from "./managed-agent-folds.js";
import {
  inspectManagedChildReceipt,
  managedChildTerminalResult,
  materializeManagedOutcome,
  prepareManagedChildResume,
  validateManagedChildGenesis,
  validateManagedParentHistory,
} from "./managed-agent-recovery.js";
import { selectManagedStarts } from "./managed-agent-scheduler.js";
import { ModelDriverError } from "./model-driver-error.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import {
  type ProjectExecutionDomain,
  ProjectExecutionDomainError,
} from "./project-execution-domain.js";
import { createPromptContextV1 } from "./prompt-assembly.js";
import { sessionDurableContext } from "./session-durable-context.js";
import { modelMessagesFromCompleteRecords } from "./session-history-replay.js";
import {
  cancelManagedChildSessionRecords,
  settleManagedChildTerminalIntent,
} from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import type { SessionRecord, SessionStore, SessionStoreDirectory } from "./session-store.js";
import { SessionLogicalQuotaError, SessionStoreError } from "./session-store.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  createReadToolRegistry,
  type JsonValue,
  type PermissionPolicy,
  type ToolRegistry,
} from "./tool-runtime.js";

/** Internal fault barrier for crash/settlement conformance; never selected by product configuration. */
export const managedAgentSettlementBarrier = Symbol("managed-agent-settlement-barrier");
export const managedAgentRecordBarrier = Symbol("managed-agent-record-barrier");

export type ManagedWorkspaceFrame = {
  readonly type: "snapshot" | "change" | "reset";
  readonly snapshot: ManagedWorkspaceSnapshot;
};

export type ManagedAgentControl = {
  prepareDelegation(
    command: Extract<ManagedControlCommand, { type: "spawn_agents" }>,
  ): Promise<DelegationEnvelope>;
  prepareContinuation(
    command: Extract<ManagedControlCommand, { type: "next_turn" }>,
  ): Promise<DelegationEnvelope>;
  settleUsage(input: FleetUsage): Promise<"settled" | "already_settled">;
  inspect(input: { readonly parentSessionId: string }): Promise<ManagedWorkspaceSnapshot>;
  observe(input: {
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
  }): AsyncIterable<ManagedWorkspaceFrame>;
  dispatch(
    command: ManagedControlCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ManagedControlReceipt>;
};

const taskSchema = z
  .string()
  .refine((text) => text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= 16 * 1024);
const spawnInputSchema = z.strictObject({
  mode: z.enum(["background", "foreground"]).optional(),
  entries: z
    .array(
      z.strictObject({
        role: z.literal("builtin:explore"),
        task: taskSchema,
        description: z
          .string()
          .min(1)
          .refine((text) => Buffer.byteLength(text, "utf8") <= 256 && !/\p{Cc}/u.test(text)),
      }),
    )
    .min(1)
    .max(32),
});
const validSpawnMode = (input: {
  mode?: "foreground" | "background" | undefined;
  entries: readonly unknown[];
}) => input.mode !== "foreground" || input.entries.length === 1;
const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["suspend_agents", "resume_agents"]),
    parentSessionId: z.uuid(),
    targets: z
      .array(z.strictObject({ threadId: z.uuid(), expectedTurnId: z.uuid() }))
      .min(1)
      .max(41)
      .optional(),
  }),
  z.strictObject({
    type: z.literal("close_thread"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("cancel_agents"),
    parentSessionId: z.uuid(),
    targets: z
      .array(z.strictObject({ threadId: z.uuid(), expectedTurnId: z.uuid() }))
      .min(1)
      .max(41)
      .refine(
        (targets) => new Set(targets.map((target) => target.threadId)).size === targets.length,
      ),
  }),
  z.strictObject({
    type: z.literal("reply_agent"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
    attentionId: z.string().min(1).max(128),
    inputId: z.uuid(),
    text: z
      .string()
      .min(1)
      .refine((text) => text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= 8192),
  }),
  z.strictObject({
    type: z.literal("post_agent"),
    origin: delegationOriginSchema.optional(),
    envelope: delegationEnvelopeSchema.optional(),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
    inputId: z.uuid(),
    mode: z.enum(["cooperative", "interrupt", "new_turn"]),
    text: z
      .string()
      .min(1)
      .refine((text) => text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= 8192),
  }),
  z.strictObject({
    type: z.literal("list_agents"),
    parentSessionId: z.uuid(),
    limit: z.number().int().min(1).max(41).optional(),
    cursor: z.string().max(128).optional(),
  }),
  z.strictObject({
    type: z.literal("wait_agents"),
    parentSessionId: z.uuid(),
    targets: z
      .array(z.strictObject({ threadId: z.uuid(), expectedTurnId: z.uuid() }))
      .min(1)
      .max(41),
    mode: z.enum(["any", "all"]),
  }),
  z.strictObject({
    type: z.literal("decide_permission"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
    requestId: z.string().min(1).max(512),
    decision: z.enum(["allow", "deny"]),
  }),
  spawnInputSchema.extend({
    type: z.literal("spawn_agents"),
    parentSessionId: z.uuid(),
    envelope: delegationEnvelopeSchema.optional(),
    origin: delegationOriginSchema.optional(),
  }),
  z.strictObject({ type: z.literal("prepare_main_delivery"), parentSessionId: z.uuid() }),
  z.strictObject({
    type: z.literal("acknowledge_main_delivery"),
    parentSessionId: z.uuid(),
    deliveries: z
      .array(
        z.strictObject({
          id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        }),
      )
      .max(32),
  }),
  z.strictObject({
    type: z.literal("cancel_turn"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("start_thread"),
    parentSessionId: z.uuid(),
    role: z.literal("builtin:explore"),
    task: taskSchema,
    description: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text, "utf8") <= 256 && !/\p{Cc}/u.test(text)),
  }),
  z.strictObject({
    type: z.literal("next_turn"),
    origin: delegationOriginSchema.optional(),
    envelope: delegationEnvelopeSchema.optional(),
    inputId: z.uuid().optional(),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
    task: taskSchema,
  }),
  z.strictObject({
    type: z.literal("recover_turn"),
    parentSessionId: z.uuid(),
    threadId: z.uuid(),
    expectedTurnId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("close"),
    parentSessionId: z.uuid(),
    reason: z.literal("exit").optional(),
  }),
]);

export function createManagedAgentControl(options: {
  readonly parentSessionId: string;
  readonly projectId: `sha256:${string}`;
  readonly workspaceRoot: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly contextProfile: ContextProfile;
  readonly model: ModelDriver;
  readonly permissions: PermissionPolicy;
  readonly executionDomain: ProjectExecutionDomain;
  readonly store: ManagedControlStore;
  readonly childSessionStores: SessionStoreDirectory<SessionRecord>;
  readonly admissionGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly artifactStore?: ArtifactStore;
  readonly policy?: FleetPolicy;
  readonly readPlan?: () => Promise<PlanCycleSnapshot | undefined>;
  readonly resolveFrozenContext?: () => Promise<
    Pick<
      ManagedControlFrozen,
      "parentBranchId" | "thinkingPolicy" | "skillContext" | "parentRequest"
    > & { readonly repository?: ManagedControlFrozen["promptContext"]["repository"] }
  >;
  readonly parentSessionStore?: SessionStore<SessionRecord>;
  readonly frozenContext?: Pick<
    ManagedControlFrozen,
    "parentBranchId" | "thinkingPolicy" | "skillContext" | "parentRequest"
  > & { readonly repository?: ManagedControlFrozen["promptContext"]["repository"] };
  readonly inactivityScheduler?: ManagedAgentInactivityScheduler;
  readonly cleanupScheduler?: ManagedAgentInactivityScheduler;
  readonly now?: () => number;
  readonly [managedAgentSettlementBarrier]?: () => Promise<void>;
  readonly [managedAgentRecordBarrier]?: (record: ManagedControlRecord) => Promise<void>;
  readonly [sessionRecordCommittedBarrier]?: (record: SessionRecord) => Promise<void>;
}): ManagedAgentControl {
  const policy = resolveFleetPolicy(options.contextProfile, options.policy);
  const controlStore = options.store.forParent(options.parentSessionId);
  let serial = Promise.resolve();
  let closing = false;
  const ready = new Set<string>();
  const occupied = new Set<string>();
  const resumptions = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const sessions = new Map<string, AgentSession>();
  const ceilingWaits = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const parentReplies = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const inactivity = new Map<string, { pause(): void; resume(): void }>();
  const recoveryStarts = new Map<
    string,
    { store: SessionStore<SessionRecord>; resume: ReturnType<typeof prepareManagedChildResume> }
  >();
  const inFlight = new Set<Promise<void>>();
  const failedAttempts = new Set<string>();
  const active = new Map<
    string,
    {
      readonly attemptId: string;
      readonly turnId: string;
      readonly controller: AbortController;
      readonly completion: Promise<void>;
    }
  >();
  const subscribers = new Set<(frame: ManagedWorkspaceFrame) => void>();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = serial.then(operation);
    serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const authorized = <T>(operation: () => Promise<T>): Promise<T> =>
    serialized(async () => {
      const claim = await options.executionDomain.claimScope({
        kind: "control",
        sessionId: options.parentSessionId,
        identity: randomUUID(),
      });
      try {
        return await operation();
      } finally {
        await claim.release();
      }
    });
  const childGenesis = (admission: ManagedControlRecord): SessionRecord => {
    const identity = admission;
    const frozen = admission.event.type === "admitted" ? admission.event.frozen : undefined;
    const promptContext =
      frozen?.promptContext ??
      createPromptContextV1(createReadToolRegistry({ workspaceRoot: options.workspaceRoot }));
    return {
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        recordVersion: 2,
        sessionId: identity.childSessionId,
        ...(frozen === undefined
          ? {}
          : {
              managedParent: {
                version: 3 as const,
                parentSessionId: identity.parentSessionId,
                threadId: identity.threadId,
                turnId: identity.turnId,
                attemptId: identity.attemptId,
                admission: managedControlLink(admission),
              },
            }),
        projectId: options.projectId,
        targetIdentity: frozen?.targetIdentity ?? options.targetIdentity,
        contextProfile: frozen?.contextProfile ?? options.contextProfile,
        promptContext,
      },
    };
  };
  const startupBytes = (admission: ManagedControlRecord, childBytes = 0) => {
    const { parentSessionId, threadId, turnId, attemptId, childSessionId } = admission;
    return (
      Math.max(0, storedRecordBytes([childGenesis(admission)]) - childBytes) +
      storedRecordBytes([
        {
          parentSessionId,
          threadId,
          turnId,
          attemptId,
          childSessionId,
          schemaVersion: 3,
          sequence: Number.MAX_SAFE_INTEGER,
          event: { type: "started" },
        },
      ])
    );
  };
  const storageUsage = async (
    records: readonly ManagedControlRecord[],
    spendingTurn?: string,
    displayOnly = false,
    spendingStartup?: string,
  ) => {
    const childIds = [...new Set(records.map((record) => record.childSessionId))];
    let unavailable = false;
    const childSizes = await Promise.all(
      childIds.map(async (id) => {
        try {
          return options.childSessionStores.byteLength === undefined
            ? storedRecordBytes((await (await options.childSessionStores.open(id))?.read()) ?? [])
            : ((await options.childSessionStores.byteLength(id)) ?? 0);
        } catch (error) {
          if (!displayOnly) throw error;
          unavailable = true;
          return 0;
        }
      }),
    );
    const storage = fleetStorage(
      records,
      policy.storageBytes,
      childSizes.reduce((total, bytes) => total + bytes, 0),
      spendingTurn,
    );
    const reservedStartupBytes = records.reduce((total, admission) => {
      if (
        admission.event.type !== "admitted" ||
        admission.turnId === spendingStartup ||
        admission.turnId === spendingTurn ||
        records.some(
          (entry) =>
            entry.turnId === admission.turnId &&
            (entry.event.type === "started" ||
              entry.event.type === "outcome" ||
              entry.event.type === "settled"),
        )
      )
        return total;
      return (
        total + startupBytes(admission, childSizes[childIds.indexOf(admission.childSessionId)] ?? 0)
      );
    }, 0);
    storage.availableBytes = Math.max(0, storage.availableBytes - reservedStartupBytes);
    return unavailable
      ? { ...storage, reservedStartupBytes, status: "unavailable" as const, availableBytes: 0 }
      : { ...storage, reservedStartupBytes, status: "known" as const };
  };
  const project = async (
    records: readonly ManagedControlRecord[],
    parentSessionId: string,
    admittingTurnId?: string,
  ): Promise<ManagedWorkspaceSnapshot> => {
    const snapshot = foldManagedControl(records, parentSessionId);
    const threads = await Promise.all(
      snapshot.threads.map((thread) => {
        const local = active.get(thread.threadId)?.attemptId === thread.turn.attemptId;
        const warm =
          local || ready.has(thread.turn.turnId) || admittingTurnId === thread.turn.turnId;
        const live = local && thread.turn.phase !== "idle";
        const interrupted =
          !warm &&
          thread.turn.waitReason !== "plan" &&
          thread.turn.phase !== "idle" &&
          thread.turn.outcome === undefined;
        return inspectManagedChildReceipt(
          {
            ...thread,
            residency: live ? "live" : "unloaded",
            turn: {
              ...thread.turn,
              recovery:
                !warm &&
                (thread.turn.phase !== "idle" ||
                  !records.some(
                    (record) =>
                      record.turnId === thread.turn.turnId && record.event.type === "completion",
                  ))
                  ? "required"
                  : thread.turn.recovery,
              ...(interrupted
                ? {
                    phase: "waiting" as const,
                    waitReason: "suspended" as const,
                    lastOutcome: "interrupted" as const,
                    label: "Suspended · Resume or cancel",
                  }
                : {}),
              ...(!live && thread.turn.watchdog?.state === "running"
                ? { watchdog: { ...thread.turn.watchdog, state: "stopped" as const } }
                : {}),
            },
          },
          options.childSessionStores,
          records.find(
            (record) => record.turnId === thread.turn.turnId && record.event.type === "admitted",
          ),
        );
      }),
    );
    return {
      ...snapshot,
      threads,
      storage: await storageUsage(records, undefined, true),
      budget: fleetBudget(
        records,
        fleetSessionCeiling(records, policy),
        undefined,
        new Set([...active.values()].map((entry) => entry.turnId)),
      ),
    };
  };
  const append = async (identity: ManagedControlIdentity, event: ManagedControlEvent) => {
    const history = await controlStore.read();
    const terminal =
      event.type === "outcome" ||
      event.type === "settled" ||
      event.type === "completion" ||
      event.type === "cleanup_expired" ||
      event.type === "cancel_requested" ||
      event.type === "budget_blocked" ||
      event.type === "input_undelivered" ||
      event.type === "input_delivered" ||
      event.type === "provider_unknown";
    const capacity = await storageUsage(
      history,
      terminal ? identity.turnId : undefined,
      false,
      event.type === "started" ? identity.turnId : undefined,
    );
    if (
      storedRecordBytes([{ ...identity, schemaVersion: 3, sequence: history.length + 1, event }]) >
      capacity.availableBytes
    )
      throw new SessionLogicalQuotaError();
    const record = await controlStore.appendNext({ ...identity, schemaVersion: 3, event });
    await options[managedAgentRecordBarrier]?.(record);
    const snapshot = await project(
      await controlStore.read(),
      options.parentSessionId,
      event.type === "admitted" ? record.turnId : undefined,
    );
    for (const subscriber of subscribers) subscriber({ type: "change", snapshot });
    return record;
  };
  const reconcileInputs = async (
    identity: ManagedControlIdentity,
    childRecords: readonly SessionRecord[],
    terminalReason?: "settled" | "cancelled" | "restart",
  ) => {
    if (childRecords.length > 0)
      await managedChildTerminalResult(childRecords, options.workspaceRoot, options.artifactStore);
    const records = await controlStore.read();
    for (const input of records) {
      const event = managedAcceptedInput(input);
      if (input.turnId !== identity.turnId || event === undefined) continue;
      const prior = records.find(
        (record) =>
          (record.event.type === "input_delivered" || record.event.type === "input_undelivered") &&
          record.event.inputId === event.inputId,
      );
      const receipt = childRecords.find(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "provider_attempt_started" &&
          (event.messageId === undefined
            ? record.record.turn === 1 &&
              childRecords.some(
                (run) =>
                  run.schemaVersion === 3 &&
                  run.record.type === "logical_run_started" &&
                  record.record.type === "provider_attempt_started" &&
                  run.record.runId === record.record.runId &&
                  run.record.userMessage === event.text,
              )
            : record.record.managedAgentDeliveryVersion === 3 &&
              record.record.managedAgentDeliveries?.some(
                (delivery) =>
                  delivery.id === event.messageId &&
                  delivery.digest === managedControlDigest(input) &&
                  delivery.messageDigest ===
                    `sha256:${createHash("sha256").update(`Parent message (${event.messageId}): ${event.text}`, "utf8").digest("hex")}`,
              )),
      );
      if (prior?.event.type === "input_delivered") {
        if (
          receipt === undefined ||
          prior.event.childReceipt.sequence !== receipt.sequence ||
          prior.event.childReceipt.digest !== managedControlDigest(receipt)
        )
          throw new SessionStoreError();
        continue;
      }
      if (prior?.event.type === "input_undelivered") {
        if (receipt !== undefined) throw new SessionStoreError();
        continue;
      }
      if (receipt !== undefined)
        await append(identity, {
          type: "input_delivered",
          inputId: event.inputId,
          childReceipt: { sequence: receipt.sequence, digest: managedControlDigest(receipt) },
        });
      else if (terminalReason !== undefined)
        await append(identity, {
          type: "input_undelivered",
          inputId: event.inputId,
          reason: terminalReason,
        });
    }
  };
  const currentCeilingAllows = async () => {
    const plan = await options.readPlan?.();
    return plan === undefined || plan.policyVersion === "plan-policy.hybrid-delegation-v1";
  };
  const waitForCeiling = async (identity: ManagedControlIdentity, signal: AbortSignal) => {
    while (!signal.aborted && !(await currentCeilingAllows())) {
      const wake = Promise.withResolvers<void>();
      const abort = () => wake.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await serialized(async () => {
          if (signal.aborted) {
            wake.resolve();
            return;
          }
          inactivity.get(identity.turnId)?.pause();
          await append(identity, { type: "capacity_wait", reason: "plan" });
          occupied.delete(identity.turnId);
          ceilingWaits.set(identity.turnId, wake);
          await startReady();
        });
        await wake.promise;
      } finally {
        ceilingWaits.delete(identity.turnId);
        signal.removeEventListener("abort", abort);
      }
    }
  };
  const childTools = (identity?: ManagedControlIdentity): ToolRegistry => {
    const reads = createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
    const adapters = (["report_to_parent", "request_parent_input"] as const).map((name) => {
      const schema =
        name === "report_to_parent"
          ? z.strictObject({ message: z.string().min(1).max(8192) })
          : z.strictObject({ question: z.string().min(1).max(8192) });
      return createInternalToolAdapter(
        {
          definition: {
            name,
            description:
              name === "report_to_parent"
                ? "Report bounded evidence to the exact parent."
                : "Wait for one exact parent reply. This cannot request permission.",
            inputSchema: z.toJSONSchema(schema),
          },
          effect: "delegate",
          cancellation: "abort_signal",
          maximumResult: { maximumBytes: 16 * 1024 },
          outputSchema: z.custom<JsonValue>(),
          prepare(json, source) {
            let value: unknown;
            try {
              value = JSON.parse(json) as unknown;
            } catch {
              value = undefined;
            }
            const parsed = schema.safeParse(value);
            if (
              !parsed.success ||
              identity === undefined ||
              source?.runId === undefined ||
              source.turn === undefined ||
              source.attempt === undefined
            )
              return {
                status: "failed",
                error: {
                  code: "invalid_tool_input",
                  message: "The exact child request is unavailable.",
                },
              };
            const text = "question" in parsed.data ? parsed.data.question : parsed.data.message;
            const call = {
              runId: source.runId,
              turn: source.turn,
              attempt: source.attempt,
              callId: source.callId,
            };
            const id = managedControlDigest([identity, call, name, text]);
            return {
              status: "ready",
              permissionSubject: {
                type: "managed_agent_action",
                parentSessionId: identity.parentSessionId,
                action: name,
                threadIds: [identity.threadId],
                turnIds: [identity.turnId],
                argumentsDigest: managedControlDigest(parsed.data),
              },
              async execute(context) {
                const reply = Promise.withResolvers<void>();
                const aborted = () => reply.resolve();
                context.signal.addEventListener("abort", aborted, { once: true });
                try {
                  await serialized(async () => {
                    const records = await controlStore.read();
                    if (
                      records.filter(
                        (record) =>
                          record.turnId === identity.turnId &&
                          (record.event.type === "child_report" ||
                            record.event.type === "parent_input_requested"),
                      ).length >= 32
                    )
                      throw new RangeError("This turn's parent coordination limit is exhausted.");
                    await append(identity, {
                      type: name === "report_to_parent" ? "child_report" : "parent_input_requested",
                      id,
                      text,
                      source: call,
                    });
                    if (name === "request_parent_input") {
                      parentReplies.set(id, reply);
                      inactivity.get(identity.turnId)?.pause();
                      await append(identity, {
                        type: "capacity_wait",
                        reason: "parent_input",
                        requestId: id,
                      });
                      occupied.delete(identity.turnId);
                      await startReady();
                    } else inactivity.get(identity.turnId)?.resume();
                  });
                  if (name === "report_to_parent")
                    return { status: "completed", output: { status: "reported", id } };
                  if (!context.signal.aborted) await reply.promise;
                  if (context.signal.aborted)
                    return {
                      status: "failed",
                      error: {
                        code: "managed_agent_cancelled",
                        message: "The parent input wait was cancelled.",
                      },
                    };
                  const slot = Promise.withResolvers<void>();
                  const abortSlot = () => slot.resolve();
                  context.signal.addEventListener("abort", abortSlot, { once: true });
                  try {
                    await serialized(async () => {
                      if (context.signal.aborted) {
                        slot.resolve();
                        return;
                      }
                      await append(identity, { type: "capacity_wait", reason: "capacity" });
                      resumptions.set(identity.turnId, slot);
                      ready.add(identity.turnId);
                      await startReady();
                    });
                    await slot.promise;
                  } finally {
                    context.signal.removeEventListener("abort", abortSlot);
                  }
                  if (context.signal.aborted)
                    return {
                      status: "failed",
                      error: {
                        code: "managed_agent_cancelled",
                        message: "The parent input wait was cancelled.",
                      },
                    };
                  inactivity.get(identity.turnId)?.resume();
                  return { status: "completed", output: { status: "replied", attentionId: id } };
                } finally {
                  parentReplies.delete(id);
                  context.signal.removeEventListener("abort", aborted);
                }
              },
            };
          },
        },
        "never",
      );
    });
    return createInternalToolRegistry([
      ...reads.definitions().flatMap((definition) => {
        const adapter = reads.resolve(definition.name);
        return adapter === undefined ? [] : [adapter];
      }),
      ...adapters,
    ]);
  };
  const run = async (
    identity: ManagedControlIdentity,
    task: string,
    previousSessionId?: string,
    preparedStore?: SessionStore<SessionRecord>,
    resume?: ReturnType<typeof prepareManagedChildResume>,
  ) => {
    const admission = (await controlStore.read()).find(
      (record) => record.turnId === identity.turnId && record.event.type === "admitted",
    );
    const frozen = admission?.event.type === "admitted" ? admission.event.frozen : undefined;
    const controller = new AbortController();
    const completion = (async () => {
      const claim = await options.executionDomain.claimScope({
        kind: "child_attempt",
        sessionId: identity.parentSessionId,
        threadId: identity.threadId,
        identity: identity.attemptId,
      });
      let cleanupDone = false;
      let cleanupExpired = false;
      let cleanupTimer: { cancel(): void } | undefined;
      try {
        const tools =
          frozen === undefined
            ? createReadToolRegistry({ workspaceRoot: options.workspaceRoot })
            : childTools(identity);
        const promptContext = frozen?.promptContext ?? createPromptContextV1(tools);
        const store =
          preparedStore ?? (await options.childSessionStores.create(identity.childSessionId));
        if (preparedStore === undefined) {
          if (admission === undefined) throw new Error("Missing canonical child admission.");
          const genesis = childGenesis(admission);
          await serialized(async () => {
            const capacity = await storageUsage(
              await controlStore.read(),
              undefined,
              false,
              identity.turnId,
            );
            if (storedRecordBytes([genesis]) > capacity.availableBytes)
              throw new SessionLogicalQuotaError();
            await store.append(genesis);
          });
        }
        if (preparedStore === undefined && options[sessionRecordCommittedBarrier] !== undefined) {
          const genesis = (await store.read())[0];
          if (genesis !== undefined) await options[sessionRecordCommittedBarrier]?.(genesis);
        }
        const previous =
          previousSessionId === undefined
            ? undefined
            : await options.childSessionStores.open(previousSessionId);
        let generation = 0;
        let executing = false;
        let timer: { cancel(): void } | undefined;
        const resetInactivity = () => {
          if (!executing) return;
          timer?.cancel();
          const scheduledGeneration = ++generation;
          timer = (options.inactivityScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
            300_000,
            () => {
              void serialized(async () => {
                if (
                  !executing ||
                  generation !== scheduledGeneration ||
                  active.get(identity.threadId)?.attemptId !== identity.attemptId
                )
                  return;
                await append(identity, { type: "stalled", deadlineId: identity.attemptId });
                executing = false;
                controller.abort();
              }).catch(() => controller.abort());
            },
          );
        };
        inactivity.set(identity.turnId, {
          pause() {
            executing = false;
            generation += 1;
            timer?.cancel();
          },
          resume() {
            executing = true;
            resetInactivity();
          },
        });
        const dependencies = {
          [managedAgentPartialOutput]: true as const,
          ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
          [managedAgentInterruptAfterEffect]: async () => {
            const records = await controlStore.read();
            return records.flatMap((record) =>
              record.turnId === identity.turnId &&
              record.event.type === "input_accepted" &&
              record.event.mode === "interrupt" &&
              !records.some(
                (entry) =>
                  (entry.event.type === "input_delivered" ||
                    entry.event.type === "input_undelivered") &&
                  entry.event.inputId ===
                    (record.event.type === "input_accepted" ? record.event.inputId : ""),
              )
                ? [{ id: record.event.messageId, digest: managedControlDigest(record) }]
                : [],
            );
          },
          [managedAgentStorageQuota]: (
            records: readonly SessionRecord[],
            terminal: boolean,
            commit: () => Promise<void>,
          ) =>
            serialized(async () => {
              const capacity = await storageUsage(
                await controlStore.read(),
                terminal ? identity.turnId : undefined,
              );
              if (storedRecordBytes(records) > capacity.availableBytes)
                throw new SessionLogicalQuotaError();
              await commit();
            }),
          [managedAgentRuntimeBoundary]: async (record: SessionRecord) => {
            if (record.schemaVersion !== 3 || record.record.type !== "runtime_event") return;
            const event = record.record.event;
            if (event.type === "tool_permission_decided")
              await waitForCeiling(identity, controller.signal);
            if (event.type === "tool_permission_requested") {
              await serialized(async () => {
                executing = false;
                generation += 1;
                timer?.cancel();
                await append(identity, {
                  type: "capacity_wait",
                  reason: "permission",
                  requestId: event.requestId,
                });
                occupied.delete(identity.turnId);
                await startReady();
              });
            } else if (
              event.type === "tool_permission_decided" &&
              event.requestId !== undefined &&
              !occupied.has(identity.turnId)
            ) {
              const resumeSlot = Promise.withResolvers<void>();
              const abort = () => resumeSlot.resolve();
              controller.signal.addEventListener("abort", abort, { once: true });
              try {
                await serialized(async () => {
                  if (controller.signal.aborted) {
                    resumeSlot.resolve();
                    return;
                  }
                  await append(identity, { type: "capacity_wait", reason: "capacity" });
                  resumptions.set(identity.turnId, resumeSlot);
                  ready.add(identity.turnId);
                  await startReady();
                });
                await resumeSlot.promise;
                if (!controller.signal.aborted) {
                  executing = true;
                  resetInactivity();
                }
              } finally {
                controller.signal.removeEventListener("abort", abort);
              }
            }
          },
          ...(options[sessionRecordCommittedBarrier] === undefined
            ? {}
            : { [sessionRecordCommittedBarrier]: options[sessionRecordCommittedBarrier] }),
          model: {
            async *stream(request) {
              if (admission?.event.type !== "admitted" || admission.event.envelope === undefined) {
                yield* options.model.stream(request);
                return;
              }
              await waitForCeiling(identity, request.signal);
              if (request.signal.aborted) return;
              const requestId = randomUUID();
              let reserved = false;
              let settled = false;
              try {
                await serialized(async () => {
                  const estimatedInput = Math.ceil(
                    Buffer.byteLength(
                      JSON.stringify({ messages: request.messages, tools: request.tools }),
                      "utf8",
                    ) / 4,
                  );
                  assertFleetReservation(
                    await controlStore.read(),
                    admission,
                    estimatedInput + request.maximumOutputTokens,
                    policy,
                  );
                  const sourceRecords = await store.read();
                  const source = sourceRecords.findLast(
                    (record) =>
                      record.schemaVersion === 3 &&
                      (record.record.type === "provider_attempt_started" ||
                        record.record.type === "context_compaction_started"),
                  );
                  if (source === undefined)
                    throw new Error("Missing exact provider source receipt.");
                  await append(identity, {
                    type: "provider_reserved",
                    requestId,
                    purpose: request.purpose === "compaction" ? "compaction" : "ordinary",
                    estimatedInput,
                    maximumOutput: request.maximumOutputTokens,
                    source: { sequence: source.sequence, digest: managedControlDigest(source) },
                  });
                  reserved = true;
                  if (request.purpose === "compaction") {
                    await append(identity, {
                      type: "execution_progress",
                      deadlineId: identity.attemptId,
                      atUnixMilliseconds: (options.now ?? Date.now)(),
                      transcript: managedTranscriptLink(sourceRecords),
                    });
                    executing = true;
                    resetInactivity();
                  }
                });
                for await (const event of options.model.stream(request)) {
                  if (event.type === "usage") {
                    await control.settleUsage({
                      requestId,
                      inputTokens: event.inputTokens,
                      outputTokens: event.outputTokens,
                      reasoningTokens: event.reasoningTokens ?? 0,
                    });
                    settled = true;
                    const reservation = (await controlStore.read()).find(
                      (record) =>
                        record.event.type === "provider_reserved" &&
                        record.event.requestId === requestId,
                    );
                    if (
                      reservation?.event.type === "provider_reserved" &&
                      event.inputTokens + event.outputTokens >
                        reservation.event.estimatedInput + reservation.event.maximumOutput
                    )
                      throw new FleetBudgetError("fleet_estimator_overrun");
                  }
                  yield event;
                }
              } catch (error) {
                if (error instanceof FleetBudgetError) {
                  await serialized(async () => {
                    await append(identity, {
                      type: "budget_blocked",
                      code: error.code,
                      message: error.message,
                    });
                  });
                  throw new ModelDriverError("invalid_request", error.message, { cause: error });
                }
                throw error;
              } finally {
                if (reserved && !settled)
                  await serialized(async () => {
                    await append(identity, { type: "provider_unknown", requestId });
                  });
              }
            },
          } satisfies ModelDriver,
          contextProfile: frozen?.contextProfile ?? options.contextProfile,
          tools,
          permissions: {
            decide: (input: Parameters<PermissionPolicy["decide"]>[0]) =>
              input.effect === "read"
                ? intersectReadPermission(
                    frozen?.permissionReadCeiling ?? "allow",
                    options.permissions.decide(input),
                  )
                : input.effect === "delegate" &&
                    input.subject.type === "managed_agent_action" &&
                    input.subject.parentSessionId === identity.parentSessionId &&
                    input.subject.turnIds.length === 1 &&
                    input.subject.turnIds[0] === identity.turnId &&
                    (input.name === "report_to_parent" || input.name === "request_parent_input")
                  ? ("allow" as const)
                  : ("deny" as const),
          },
          store: store as SessionStore,
          [managedAgentRequestBoundary]: async () => {
            await serialized(async () => {
              await reconcileInputs(identity, await store.read());
            });
            const records = await controlStore.read();
            const pending = records
              .filter(
                (record) =>
                  record.turnId === identity.turnId &&
                  record.event.type === "input_accepted" &&
                  !records.some(
                    (entry) =>
                      (entry.event.type === "input_delivered" ||
                        entry.event.type === "input_undelivered") &&
                      entry.event.inputId ===
                        (record.event.type === "input_accepted" ? record.event.inputId : ""),
                  ),
              )
              .slice(0, 32);
            return {
              atomicReceipt: true as const,
              messages: pending.flatMap((record) =>
                record.event.type === "input_accepted"
                  ? [{ id: record.event.messageId, text: record.event.text }]
                  : [],
              ),
              deliveries: pending.flatMap((record) =>
                record.event.type === "input_accepted"
                  ? [{ id: record.event.messageId, digest: managedControlDigest(record) }]
                  : [],
              ),
              acknowledge: async () =>
                serialized(async () => {
                  const childRecords = await store.read();
                  const request = childRecords.findLast(
                    (record) =>
                      record.schemaVersion === 3 &&
                      record.record.type === "provider_attempt_started",
                  );
                  for (const input of pending) {
                    if (
                      input.event.type !== "input_accepted" ||
                      request?.schemaVersion !== 3 ||
                      request.record.type !== "provider_attempt_started" ||
                      !request.record.managedAgentDeliveries?.some(
                        (delivery) =>
                          input.event.type === "input_accepted" &&
                          delivery.id === input.event.messageId &&
                          delivery.digest === managedControlDigest(input),
                      )
                    )
                      throw new Error("Missing exact child delivery receipt.");
                    await append(identity, {
                      type: "input_delivered",
                      inputId: input.event.inputId,
                      childReceipt: {
                        sequence: request.sequence,
                        digest: managedControlDigest(request),
                      },
                    });
                  }
                  await reconcileInputs(identity, childRecords);
                  await append(identity, {
                    type: "execution_progress",
                    deadlineId: identity.attemptId,
                    atUnixMilliseconds: (options.now ?? Date.now)(),
                    transcript: managedTranscriptLink(childRecords),
                  });
                  executing = true;
                  resetInactivity();
                }),
            };
          },
          [sessionDurableContext]: {
            nextSequence: preparedStore === undefined ? 2 : (await preparedStore.read()).length + 1,
            ...(resume === undefined ? {} : { resume: resume.agentState }),
            sessionId: identity.childSessionId,
            projectId: options.projectId,
            targetIdentity: frozen?.targetIdentity ?? options.targetIdentity,
            ...(frozen?.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: frozen.thinkingPolicy }),
            promptContext,
            repositoryWorkspaceRoot: options.workspaceRoot,
            initialMessages: [
              {
                role: "developer" as const,
                content:
                  "Explore the exact delegated task using local repository reads only. Do not write, execute, access Web, MCP or extensions, spawn children, or change authority. The workspace is live, not a filesystem snapshot.",
              },
              ...(frozen?.parentRequest
                ? [{ role: "user" as const, content: frozen.parentRequest }]
                : []),
              ...(previous === undefined
                ? []
                : modelMessagesFromCompleteRecords(await previous.read())),
            ],
          },
        };
        const child = new AgentSession(dependencies);
        sessions.set(identity.turnId, child);
        let lastAssistantDelta: string | undefined;
        const lastReasoning = new Map<string, string>();
        const unsubscribe = child.subscribe((event) => {
          if (
            event.type === "model_message_delta" &&
            event.text.length > 0 &&
            event.text !== lastAssistantDelta
          ) {
            lastAssistantDelta = event.text;
            resetInactivity();
          }
          if (
            event.type === "model_reasoning_updated" &&
            event.text.length > 0 &&
            event.text !== lastReasoning.get(event.id)
          ) {
            lastReasoning.set(event.id, event.text);
            resetInactivity();
          }
          if (
            event.type === "tool_completed" ||
            event.type === "tool_failed" ||
            event.type === "context_compaction_committed" ||
            event.type === "context_compaction_failed" ||
            event.type === "model_reasoning_started" ||
            event.type === "model_reasoning_settled"
          )
            resetInactivity();
        });
        await serialized(async () => {
          const records = await controlStore.read();
          if (
            !records.some(
              (record) => record.turnId === identity.turnId && record.event.type === "started",
            )
          )
            await append(identity, { type: "started" });
        });
        const result = await child
          .run(
            { text: resume?.userMessage ?? task },
            {
              signal: controller.signal,
              limits: { maxTokens: options.contextProfile.contextWindowTokens },
            },
          )
          .finally(() => {
            unsubscribe();
            inactivity.delete(identity.turnId);
            executing = false;
            generation += 1;
            timer?.cancel();
          });
        const records = await store.read();
        if (
          (await managedChildTerminalResult(
            records,
            options.workspaceRoot,
            options.artifactStore,
          )) === undefined
        )
          throw new SessionStoreError();
        const outcome = await serialized(async () =>
          append(
            identity,
            await materializeManagedOutcome(
              result,
              records,
              (await controlStore.read()).filter((record) => record.turnId === identity.turnId),
              options.artifactStore,
            ),
          ),
        );
        cleanupTimer = (options.cleanupScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
          10_000,
          () => {
            void serialized(async () => {
              if (cleanupDone || cleanupExpired) return;
              await append(identity, {
                type: "cleanup_expired",
                deadlineId: identity.attemptId,
                maximumMilliseconds: 10_000,
              });
              cleanupExpired = true;
            }).catch(() => {
              failedAttempts.add(identity.attemptId);
              closing = true;
            });
          },
        );
        await options[managedAgentSettlementBarrier]?.();
        const settlementClaim = await options.executionDomain.claimScope({
          kind: "control",
          sessionId: identity.parentSessionId,
          identity: `settlement:${identity.attemptId}`,
        });
        try {
          await claim.release();
          cleanupDone = true;
          cleanupTimer.cancel();
          await serialized(async () => {
            occupied.delete(identity.turnId);
            sessions.delete(identity.turnId);
            ready.delete(identity.turnId);
            resumptions.delete(identity.turnId);
            await reconcileInputs(
              identity,
              records,
              controller.signal.aborted ? "cancelled" : "settled",
            );
            const settled = await append(identity, {
              type: "settled",
              outcome: managedControlLink(outcome),
            });
            await append(identity, { type: "completion", settled: managedControlLink(settled) });
            if (active.get(identity.threadId)?.attemptId === identity.attemptId)
              active.delete(identity.threadId);
          });
        } finally {
          await settlementClaim.release();
        }
      } finally {
        cleanupTimer?.cancel();
        await claim.release();
      }
    })();
    occupied.add(identity.turnId);
    active.set(identity.threadId, {
      attemptId: identity.attemptId,
      turnId: identity.turnId,
      controller,
      completion,
    });
    inFlight.add(completion);
    void completion.then(
      () => {
        inFlight.delete(completion);
        if (!closing)
          void serialized(startReady).catch(() => {
            closing = true;
          });
      },
      () => {
        inFlight.delete(completion);
        failedAttempts.add(identity.attemptId);
        if (active.get(identity.threadId)?.attemptId === identity.attemptId)
          active.delete(identity.threadId);
        closing = true;
        for (const attempt of active.values()) attempt.controller.abort();
        void control.inspect({ parentSessionId: options.parentSessionId }).then(
          (snapshot) => {
            for (const subscriber of subscribers) subscriber({ type: "reset", snapshot });
          },
          () => {
            const snapshot: ManagedWorkspaceSnapshot = {
              parentSessionId: options.parentSessionId,
              revision: 0,
              status: "runtime_unavailable",
              diagnostic: "Managed runtime is unavailable. Inspect durable state.",
              threads: [],
              completions: [],
            };
            for (const subscriber of subscribers) subscriber({ type: "reset", snapshot });
          },
        );
      },
    );
  };
  const startReady = async () => {
    if (closing) return;
    const records = await controlStore.read();
    const selected = selectManagedStarts(
      foldManagedControl(records, options.parentSessionId),
      occupied,
      ready,
      policy,
    );
    for (const turnId of selected) {
      const admission = records.find(
        (record) => record.turnId === turnId && record.event.type === "admitted",
      );
      if (admission?.event.type !== "admitted")
        throw new ManagedAgentStoreError("managed_agent_log_invalid");
      ready.delete(turnId);
      if (!(await currentCeilingAllows())) {
        const resuming = resumptions.get(turnId);
        if (resuming === undefined)
          await append(admission, { type: "admission_paused", reason: "plan" });
        else {
          resumptions.delete(turnId);
          ceilingWaits.set(turnId, resuming);
          await append(admission, { type: "capacity_wait", reason: "plan" });
        }
        continue;
      }
      const resumeSlot = resumptions.get(turnId);
      if (resumeSlot !== undefined) {
        occupied.add(turnId);
        resumptions.delete(turnId);
        await append(admission, { type: "capacity_acquired" });
        resumeSlot.resolve();
        continue;
      }
      const recovery = recoveryStarts.get(turnId);
      recoveryStarts.delete(turnId);
      const previous = records.findLast(
        (record) =>
          record.threadId === admission.threadId &&
          record.event.type === "admitted" &&
          record.sequence < admission.sequence,
      );
      await run(
        {
          parentSessionId: admission.parentSessionId,
          threadId: admission.threadId,
          turnId: admission.turnId,
          attemptId: admission.attemptId,
          childSessionId: admission.childSessionId,
        },
        admission.event.task,
        previous?.childSessionId,
        recovery?.store,
        recovery?.resume,
      );
    }
  };
  const rejected = (
    code: Extract<ManagedControlReceipt, { status: "rejected" }>["code"],
    message: string,
  ): ManagedControlReceipt => ({ status: "rejected", code, message });
  const control: ManagedAgentControl = {
    async prepareDelegation(command) {
      const records = await controlStore.read();
      const sessionTokens = fleetSessionCeiling(records, policy);
      const available = fleetBudget(records, sessionTokens).available;
      if (available <= 0) throw new FleetBudgetError("fleet_budget_exhausted");
      return createDelegationEnvelope(policy, {
        mode: command.mode ?? "background",
        count: command.entries.length,
        origin: command.origin ?? { kind: "direct_request", id: randomUUID() },
        sessionTokens,
        availableTokens: available,
      });
    },
    async prepareContinuation(command) {
      const records = await controlStore.read();
      const first = records.find(
        (record) => record.threadId === command.threadId && record.event.type === "admitted",
      );
      if (
        command.parentSessionId !== options.parentSessionId ||
        first?.event.type !== "admitted" ||
        first.event.envelope === undefined
      )
        throw new TypeError("The original frozen thread authority is unavailable.");
      const sessionTokens = fleetSessionCeiling(records, policy);
      const available = fleetBudget(records, sessionTokens).available;
      if (available <= 0) throw new FleetBudgetError("fleet_budget_exhausted");
      return createDelegationEnvelope(policy, {
        mode: first.event.lane === "reserved" ? "foreground" : "background",
        count: 1,
        origin: command.origin ?? { kind: "direct_request", id: command.inputId ?? randomUUID() },
        sessionTokens,
        availableTokens: available,
        threadTokens: first.event.envelope.threadTokens,
      });
    },
    async settleUsage(input) {
      return authorized(async () => {
        const records = await controlStore.read();
        const reservation = records.find(
          (record) =>
            record.event.type === "provider_reserved" && record.event.requestId === input.requestId,
        );
        if (reservation === undefined) throw new TypeError("Unknown provider request identity.");
        const prior = records.find(
          (record) =>
            record.event.type === "provider_usage" && record.event.requestId === input.requestId,
        );
        if (prior?.event.type === "provider_usage") {
          if (!isDeepStrictEqual(prior.event, { type: "provider_usage", ...input }))
            throw new TypeError("Conflicting provider usage receipt.");
          return "already_settled";
        }
        await append(reservation, { type: "provider_usage", ...input });
        return "settled";
      });
    },
    async inspect({ parentSessionId }) {
      if (parentSessionId !== options.parentSessionId)
        throw new TypeError("This control belongs to another parent Session.");
      await serial;
      try {
        return await project(await controlStore.read(), parentSessionId);
      } catch (error) {
        if (!(error instanceof ManagedAgentStoreError)) throw error;
        return {
          parentSessionId,
          status: "recovery_required",
          diagnostic: "Managed history is unavailable. Inspect durable state.",
          revision: 0,
          threads: [],
          completions: [],
        };
      }
    },
    async *observe({ parentSessionId, signal }) {
      if (parentSessionId !== options.parentSessionId)
        throw new TypeError("This control belongs to another parent Session.");
      const pending: ManagedWorkspaceFrame[] = [];
      let wake = Promise.withResolvers<void>();
      const subscriber = (frame: ManagedWorkspaceFrame) => {
        pending.push(frame);
        wake.resolve();
      };
      const abort = () => wake.resolve();
      subscribers.add(subscriber);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const snapshot = await control.inspect({ parentSessionId });
        let revision = snapshot.revision;
        yield { type: "snapshot", snapshot };
        while (!signal.aborted) {
          const frame = pending.shift();
          if (frame === undefined) {
            await wake.promise;
            wake = Promise.withResolvers<void>();
            continue;
          }
          if (frame.type !== "reset" && frame.snapshot.revision <= revision) continue;
          yield {
            ...frame,
            type:
              frame.type === "reset" || frame.snapshot.revision !== revision + 1
                ? "reset"
                : "change",
          };
          revision = frame.snapshot.revision;
        }
      } finally {
        subscribers.delete(subscriber);
        signal.removeEventListener("abort", abort);
      }
    },
    async dispatch(command, dispatchOptions) {
      try {
        const execute = () => dispatchCommand(command, dispatchOptions);
        const receipt = await (options.admissionGuard !== undefined &&
        (command.type === "spawn_agents" ||
          command.type === "next_turn" ||
          command.type === "recover_turn")
          ? options.admissionGuard(execute)
          : execute());
        return await joinForeground(command, receipt, dispatchOptions);
      } catch (error) {
        if (error instanceof ProjectExecutionDomainError)
          return rejected(
            error.code === "root_conflict" || error.code === "project_in_use"
              ? "authority_busy"
              : "runtime_unavailable",
            error.message,
          );
        if (
          error instanceof SessionLifecycleError &&
          error.code === "session_managed_transition_required"
        )
          return rejected("authority_busy", error.message);
        if (error instanceof SessionLogicalQuotaError)
          return rejected("storage_quota_exceeded", error.message);
        if (error instanceof FleetBudgetError) return rejected("budget_exhausted", error.message);
        if (
          error instanceof ManagedAgentStoreError ||
          error instanceof SessionStoreError ||
          error instanceof SessionLifecycleError
        )
          return rejected(
            "recovery_required",
            "Managed history is unavailable. Inspect durable state.",
          );
        return rejected(
          "persistence_failed",
          "Managed control could not durably accept the request.",
        );
      }
    },
  };
  async function dispatchCommand(
    command: ManagedControlCommand,
    dispatchOptions?: { readonly signal?: AbortSignal },
  ): Promise<ManagedControlReceipt> {
    if (
      dispatchOptions?.signal?.aborted &&
      (command.type === "spawn_agents" ||
        command.type === "post_agent" ||
        command.type === "reply_agent" ||
        command.type === "next_turn" ||
        command.type === "start_thread")
    )
      return rejected("action_unavailable", "The caller cancelled before admission.");
    if (
      !commandSchema.safeParse(command).success ||
      (command.type === "spawn_agents" && !validSpawnMode(command))
    )
      return rejected(
        "action_unavailable",
        "Historical agent controls are read-only. Start a new current Session to delegate work.",
      );
    if (command.parentSessionId !== options.parentSessionId)
      return rejected("action_unavailable", "This control belongs to another parent Session.");
    if (command.type === "start_thread") {
      const receipt = await control.dispatch(
        {
          type: "spawn_agents",
          parentSessionId: command.parentSessionId,
          entries: [{ role: command.role, task: command.task, description: command.description }],
        },
        dispatchOptions,
      );
      const turn = receipt.status === "admitted" ? receipt.turns[0] : undefined;
      return turn === undefined ? receipt : { status: "accepted", ...turn };
    }
    if (command.type === "suspend_agents" || command.type === "resume_agents") {
      const snapshot = await control.inspect({ parentSessionId: command.parentSessionId });
      const targets =
        command.targets ??
        snapshot.threads
          .filter((thread) => thread.turn.phase !== "idle")
          .map((thread) => ({ threadId: thread.threadId, expectedTurnId: thread.turn.turnId }));
      if (
        targets.some(
          (target) =>
            !snapshot.threads.some(
              (thread) =>
                thread.threadId === target.threadId && thread.turn.turnId === target.expectedTurnId,
            ),
        )
      )
        return rejected("stale_revision", "One selected turn changed.");
      if (command.type === "resume_agents")
        return {
          status: "resumed",
          results: await Promise.all(
            targets.map(async (target): Promise<ManagedControlReceipt> => {
              const waiting = ceilingWaits.get(target.expectedTurnId);
              if (waiting === undefined)
                return control.dispatch({
                  type: "recover_turn",
                  parentSessionId: command.parentSessionId,
                  ...target,
                });
              if (!(await currentCeilingAllows()))
                return rejected("plan_policy_paused", "Paused by current Plan policy");
              await serialized(async () => {
                resumptions.set(target.expectedTurnId, waiting);
                ready.add(target.expectedTurnId);
                await startReady();
              });
              return { status: "recovered" };
            }),
          ),
        };
      await serialized(async () => {
        const claim = await options.executionDomain.claimScope({
          kind: "control",
          sessionId: options.parentSessionId,
          identity: randomUUID(),
        });
        try {
          const records = await controlStore.read();
          const pending = records.filter(
            (record) =>
              record.event.type === "admitted" &&
              targets.some((target) => target.expectedTurnId === record.turnId) &&
              !records.some(
                (entry) => entry.turnId === record.turnId && entry.event.type === "outcome",
              ),
          );
          if (pending.length > 0)
            await controlStore.appendBatchNext(
              pending.map(({ sequence: _sequence, ...record }) => ({
                ...record,
                event: { type: "suspend_requested" as const },
              })),
            );
          for (const target of targets) ready.delete(target.expectedTurnId);
        } finally {
          await claim.release();
        }
      });
      const running = targets.filter((target) => active.has(target.threadId));
      const results = await Promise.all(
        running.map((target) =>
          control.dispatch({
            type: "cancel_turn",
            parentSessionId: command.parentSessionId,
            ...target,
          }),
        ),
      );
      const current = await control.inspect({ parentSessionId: command.parentSessionId });
      for (const subscriber of subscribers) subscriber({ type: "reset", snapshot: current });
      return results.some(
        (result) => result.status === "rejected" && result.code !== "action_unavailable",
      )
        ? rejected(
            "recovery_required",
            "Suspension is durable but running cleanup requires recovery.",
          )
        : { status: "suspended" };
    }
    if (command.type === "close_thread") {
      return serialized(async () => {
        const claim = await options.executionDomain.claimScope({
          kind: "control",
          sessionId: options.parentSessionId,
          identity: randomUUID(),
        });
        try {
          const records = await controlStore.read();
          const thread = foldManagedControl(records, options.parentSessionId).threads.find(
            (thread) => thread.threadId === command.threadId,
          );
          if (thread?.turn.turnId !== command.expectedTurnId)
            return rejected("stale_revision", "The selected turn changed.");
          if (thread.turn.phase !== "idle")
            return rejected(
              "authority_busy",
              "Settle the selected turn before closing its thread.",
            );
          const admission = records.find(
            (record) =>
              record.turnId === command.expectedTurnId && record.event.type === "admitted",
          );
          if (admission !== undefined && thread.lifecycle !== "closed")
            await append(admission, { type: "thread_closed" });
          return { status: "closed" };
        } finally {
          await claim.release();
        }
      });
    }
    if (command.type === "cancel_agents") {
      const intent = await serialized(async () => {
        const claim = await options.executionDomain.claimScope({
          kind: "control",
          sessionId: options.parentSessionId,
          identity: randomUUID(),
        });
        try {
          const records = await controlStore.read();
          const snapshot = foldManagedControl(records, options.parentSessionId);
          if (
            command.targets.some(
              (target) =>
                !snapshot.threads.some(
                  (thread) =>
                    thread.threadId === target.threadId &&
                    thread.turn.turnId === target.expectedTurnId,
                ),
            )
          )
            return rejected(
              "stale_revision",
              "One selected turn changed. No cancellation intents were registered.",
            );
          const admissions = command.targets.flatMap((target) =>
            records.filter(
              (record) =>
                record.threadId === target.threadId &&
                record.turnId === target.expectedTurnId &&
                record.event.type === "admitted",
            ),
          );
          const pending = admissions.filter(
            (admission) =>
              !records.some(
                (record) =>
                  record.turnId === admission.turnId &&
                  (record.event.type === "cancel_requested" || record.event.type === "outcome"),
              ),
          );
          if (pending.length > 0)
            await controlStore.appendBatchNext(
              pending.map(({ sequence: _sequence, ...admission }) => ({
                ...admission,
                event: { type: "cancel_requested" as const },
              })),
            );
          for (const admission of admissions) ready.delete(admission.turnId);
          return { status: "acknowledged" as const };
        } finally {
          await claim.release();
        }
      });
      if (intent.status === "rejected") return intent;
      const results = await Promise.all(
        command.targets.map((target) =>
          control.dispatch({
            type: "cancel_turn",
            parentSessionId: command.parentSessionId,
            ...target,
          }),
        ),
      );
      if (
        results.some(
          (result) => result.status === "rejected" && result.code !== "action_unavailable",
        )
      )
        return rejected(
          "recovery_required",
          "Cancellation intents are durable; some settlements require recovery.",
        );
      return control.dispatch(
        {
          type: "wait_agents",
          parentSessionId: command.parentSessionId,
          targets: command.targets,
          mode: "all",
        },
        dispatchOptions,
      );
    }
    if (command.type === "list_agents") {
      const snapshot = await control.inspect({ parentSessionId: command.parentSessionId });
      const cursor = command.cursor?.match(/^(\d+):(\d+)$/u);
      if (
        command.cursor !== undefined &&
        (cursor === undefined || cursor === null || Number(cursor[1]) !== snapshot.revision)
      )
        return rejected("stale_revision", "The list changed. Read its first page again.");
      const offset = Number(cursor?.[2] ?? 0);
      const limit = command.limit ?? 16;
      return {
        status: "listed",
        revision: snapshot.revision,
        threads: snapshot.threads.slice(offset, offset + limit),
        ...(offset + limit < snapshot.threads.length
          ? { cursor: `${snapshot.revision}:${offset + limit}` }
          : {}),
      };
    }
    if (command.type === "wait_agents") {
      const snapshot = await control.inspect({ parentSessionId: command.parentSessionId });
      if (
        command.targets.some(
          (target) =>
            !snapshot.threads.some(
              (thread) =>
                thread.threadId === target.threadId && thread.turn.turnId === target.expectedTurnId,
            ) &&
            !snapshot.completions.some(
              (entry) =>
                entry.threadId === target.threadId && entry.turnId === target.expectedTurnId,
            ),
        )
      )
        return rejected("stale_revision", "The exact selected turn is unavailable.");
      const observer = new AbortController();
      const abort = () => observer.abort();
      if (dispatchOptions?.signal?.aborted) observer.abort();
      else dispatchOptions?.signal?.addEventListener("abort", abort, { once: true });
      try {
        for await (const frame of control.observe({
          parentSessionId: command.parentSessionId,
          signal: observer.signal,
        })) {
          if (observer.signal.aborted) break;
          const results = frame.snapshot.completions.filter((entry) =>
            command.targets.some(
              (target) =>
                target.threadId === entry.threadId && target.expectedTurnId === entry.turnId,
            ),
          );
          if (
            results.length >=
            (command.mode === "any"
              ? 1
              : new Set(command.targets.map((target) => target.expectedTurnId)).size)
          )
            return { status: "completed", results };
          if (
            frame.snapshot.status !== "ready" ||
            frame.snapshot.threads.some(
              (thread) =>
                command.targets.some((target) => target.expectedTurnId === thread.turn.turnId) &&
                thread.turn.recovery === "required",
            )
          )
            return rejected("recovery_required", "The selected turn needs explicit recovery.");
        }
        return rejected("action_unavailable", "The wait was cancelled.");
      } finally {
        observer.abort();
        dispatchOptions?.signal?.removeEventListener("abort", abort);
      }
    }
    if (command.type === "reply_agent") {
      return authorized(async () => {
        if (!(await currentCeilingAllows()))
          return rejected("plan_policy_paused", "Paused by current Plan policy");
        const records = await controlStore.read();
        const thread = foldManagedControl(records, options.parentSessionId).threads.find(
          (entry) => entry.threadId === command.threadId,
        );
        if (
          thread?.turn.turnId !== command.expectedTurnId ||
          thread.turn.attention?.id !== command.attentionId ||
          thread.turn.attention.kind !== "parent_input" ||
          !parentReplies.has(command.attentionId)
        )
          return rejected("stale_revision", "The exact parent-input request is no longer pending.");
        if (
          records.some(
            (record) =>
              record.event.type === "input_accepted" && record.event.inputId === command.inputId,
          )
        )
          return rejected("stale_revision", "The input identity is already used.");
        const admission = records.find(
          (record) => record.turnId === command.expectedTurnId && record.event.type === "admitted",
        );
        if (admission === undefined) throw new Error("Missing turn");
        await append(admission, {
          type: "input_accepted",
          inputId: command.inputId,
          text: command.text,
          mode: "cooperative",
          messageId: managedControlDigest([
            options.parentSessionId,
            command.expectedTurnId,
            command.inputId,
          ]),
        });
        parentReplies.get(command.attentionId)?.resolve();
        return {
          status: "input_accepted",
          inputId: command.inputId,
          turnId: command.expectedTurnId,
        };
      });
    }
    if (command.type === "post_agent") {
      if (command.mode === "new_turn")
        return control.dispatch({
          type: "next_turn",
          parentSessionId: command.parentSessionId,
          threadId: command.threadId,
          expectedTurnId: command.expectedTurnId,
          task: command.text,
          inputId: command.inputId,
          ...(command.origin === undefined ? {} : { origin: command.origin }),
          ...(command.envelope === undefined ? {} : { envelope: command.envelope }),
        });
      return authorized(async () => {
        if (!(await currentCeilingAllows()))
          return rejected("plan_policy_paused", "Paused by current Plan policy");
        const records = await controlStore.read();
        const thread = foldManagedControl(records, options.parentSessionId).threads.find(
          (entry) => entry.threadId === command.threadId,
        );
        if (thread?.turn.turnId !== command.expectedTurnId)
          return rejected(
            "stale_revision",
            "The selected turn changed. Inspect the current thread.",
          );
        const prior = records.find(
          (record) =>
            record.event.type === "input_accepted" && record.event.inputId === command.inputId,
        );
        if (prior !== undefined)
          return prior.turnId === command.expectedTurnId &&
            prior.event.type === "input_accepted" &&
            prior.event.text === command.text &&
            prior.event.mode === command.mode
            ? {
                status: "input_accepted",
                inputId: command.inputId,
                turnId: command.expectedTurnId,
              }
            : rejected(
                "stale_revision",
                "The input identity was already used for another command.",
              );
        if (
          thread.turn.phase === "queued" ||
          !records.some(
            (record) => record.turnId === command.expectedTurnId && record.event.type === "started",
          )
        )
          return rejected(
            "action_unavailable",
            "Queued tasks are immutable. Cancel and submit a new task.",
          );
        if (
          closing ||
          thread.turn.phase === "idle" ||
          thread.turn.phase === "settling" ||
          !active.has(thread.threadId)
        )
          return rejected(
            "action_unavailable",
            "The selected turn cannot accept input. Resume or start a new turn explicitly.",
          );
        if (
          records.filter(
            (record) =>
              record.turnId === command.expectedTurnId && record.event.type === "input_accepted",
          ).length >= 32
        )
          return rejected("capacity_exhausted", "This turn's input capacity is exhausted.");
        const admission = records.find(
          (record) => record.turnId === command.expectedTurnId && record.event.type === "admitted",
        );
        if (admission === undefined) throw new Error("Missing admitted turn");
        await append(admission, {
          type: "input_accepted",
          inputId: command.inputId,
          text: command.text,
          mode: command.mode === "interrupt" ? "interrupt" : "cooperative",
          messageId: managedControlDigest([
            options.parentSessionId,
            command.expectedTurnId,
            command.inputId,
          ]),
        });
        return {
          status: "input_accepted",
          inputId: command.inputId,
          turnId: command.expectedTurnId,
        };
      });
    }
    if (command.type === "decide_permission") {
      const snapshot = await control.inspect({ parentSessionId: command.parentSessionId });
      const thread = snapshot.threads.find((entry) => entry.threadId === command.threadId);
      if (
        thread?.turn.turnId !== command.expectedTurnId ||
        thread.turn.attention?.id !== command.requestId ||
        thread.turn.attention.kind !== "permission"
      )
        return rejected("stale_revision", "The exact permission is no longer pending.");
      const decision = sessions
        .get(command.expectedTurnId)
        ?.decidePermission({ requestId: command.requestId, decision: command.decision });
      return decision?.status === "accepted"
        ? {
            status: "accepted",
            parentSessionId: command.parentSessionId,
            threadId: thread.threadId,
            turnId: thread.turn.turnId,
            attemptId: thread.turn.attemptId,
            childSessionId: thread.turn.childSessionId,
          }
        : rejected("action_unavailable", "The permission owner is unavailable.");
    }
    if (command.type === "cancel_turn") {
      try {
        const cancellation = await serialized(async () => {
          const claim = await options.executionDomain.claimScope({
            kind: "control",
            sessionId: options.parentSessionId,
            identity: randomUUID(),
          });
          try {
            await controlStore.preflight();
            const records = await controlStore.read();
            const admission = records.findLast(
              (record) => record.threadId === command.threadId && record.event.type === "admitted",
            );
            if (
              admission === undefined ||
              admission.parentSessionId !== options.parentSessionId ||
              admission.turnId !== command.expectedTurnId
            )
              return rejected(
                "stale_revision",
                "The selected turn changed. Inspect the current thread.",
              );
            const turn = records.filter((record) => record.turnId === admission.turnId);
            const previousOutcome = turn.find((record) => record.event.type === "outcome");
            if (previousOutcome !== undefined)
              return rejected(
                "action_unavailable",
                "The selected turn already has an outcome. Inspect or recover settlement.",
              );
            if (!turn.some((record) => record.event.type === "cancel_requested"))
              await append(admission, { type: "cancel_requested" });
            ready.delete(admission.turnId);
            const live = active.get(command.threadId);
            if (live !== undefined) {
              live.controller.abort();
              return { completion: live.completion, turnId: admission.turnId };
            }
            const unstartedStore = await options.childSessionStores.open(admission.childSessionId);
            const existingRecords = await unstartedStore?.read();
            if (existingRecords?.[0] !== undefined)
              validateManagedChildGenesis(admission, existingRecords[0]);
            const childRecords =
              unstartedStore === undefined &&
              !turn.some((record) => record.event.type === "started")
                ? []
                : await cancelManagedChildSessionRecords({
                    workspaceRoot: options.workspaceRoot,
                    sessionId: admission.childSessionId,
                    childSessionStores: options.childSessionStores,
                  });
            await reconcileInputs(admission, childRecords, "cancelled");
            const outcome = await append(
              admission,
              await materializeManagedOutcome(
                {
                  status: "cancelled",
                  error: { code: "session_cancelled", message: "The session was cancelled." },
                },
                childRecords,
                turn,
                options.artifactStore,
              ),
            );
            const settled = await append(admission, {
              type: "settled",
              outcome: managedControlLink(outcome),
            });
            await append(admission, { type: "completion", settled: managedControlLink(settled) });
            return { status: "cancelled" as const, turnId: admission.turnId };
          } finally {
            await claim.release();
          }
        });
        if ("completion" in cancellation) {
          const expired = Promise.withResolvers<false>();
          const timer = (options.cleanupScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
            10_000,
            () => expired.resolve(false),
          );
          try {
            if (!(await Promise.race([cancellation.completion.then(() => true), expired.promise])))
              return rejected(
                "recovery_required",
                "Cancellation is durable but cleanup has not settled.",
              );
          } finally {
            timer.cancel();
          }
          const outcome = (await controlStore.read()).find(
            (record) => record.turnId === cancellation.turnId && record.event.type === "outcome",
          );
          return outcome?.event.type === "outcome" && outcome.event.status === "cancelled"
            ? { status: "cancelled", turnId: cancellation.turnId }
            : { status: "recovered" };
        }
        return cancellation;
      } catch (error) {
        if (error instanceof ProjectExecutionDomainError)
          return rejected("authority_busy", error.message);
        return rejected(
          "recovery_required",
          "The interrupted turn could not be durably cancelled. Inspect durable state.",
        );
      }
    }
    if (command.type === "close") {
      const wasClosing = closing;
      closing = true;
      ready.clear();
      let suspensionFailed = false;
      if (command.reason === "exit" && !wasClosing) {
        try {
          const snapshot = await control.inspect({ parentSessionId: options.parentSessionId });
          if (snapshot.status === "ready" || active.size > 0) {
            const suspended = await control.dispatch({
              type: "suspend_agents",
              parentSessionId: options.parentSessionId,
            });
            suspensionFailed = suspended.status === "rejected";
          }
        } catch {
          suspensionFailed = true;
        }
      }
      const drain = (async () => {
        await serial;
        for (const attempt of active.values()) attempt.controller.abort();
        const results = await Promise.allSettled([...inFlight]);
        await serial;
        return (
          !suspensionFailed &&
          results.every((result) => result.status === "fulfilled") &&
          failedAttempts.size === 0
        );
      })();
      const expired = Promise.withResolvers<false>();
      const timer = (options.cleanupScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
        10_000,
        () => expired.resolve(false),
      );
      try {
        return (await Promise.race([drain, expired.promise]))
          ? { status: "closed" }
          : rejected("recovery_required", "Managed cleanup is incomplete. Inspect durable state.");
      } finally {
        timer.cancel();
      }
    }
    return serialized(async () => {
      if (closing) return rejected("runtime_unavailable", "Managed control is closed.");
      const claim = await options.executionDomain.claimScope({
        kind: "control",
        sessionId: options.parentSessionId,
        identity: randomUUID(),
      });
      try {
        await controlStore.preflight();
        if (
          (command.type === "spawn_agents" || command.type === "next_turn") &&
          !(await currentCeilingAllows())
        )
          return rejected("plan_policy_paused", "Paused by current Plan policy");
        if (command.type === "spawn_agents") {
          const frozenContext = (await options.resolveFrozenContext?.()) ?? options.frozenContext;
          const frozen = managedControlFrozenSchema.parse({
            version: 1,
            parentBranchId: frozenContext?.parentBranchId ?? options.parentSessionId,
            targetIdentity: options.targetIdentity,
            contextProfile: options.contextProfile,
            ...(frozenContext?.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: frozenContext.thinkingPolicy }),
            ...(frozenContext?.skillContext === undefined
              ? {}
              : { skillContext: frozenContext.skillContext }),
            promptContext: createPromptContextV1(childTools(), frozenContext?.repository),
            parentRequest: frozenContext?.parentRequest ?? "",
            permissionEffects: ["read"],
            permissionReadCeiling: options.permissions.delegationReadCeiling ?? "deny",
          });
          if (frozen.targetIdentity.certification !== "certified")
            return rejected(
              "action_unavailable",
              "The resolved role target is unavailable or uncertified.",
            );
          const envelope =
            command.envelope === undefined
              ? await control.prepareDelegation(command)
              : delegationEnvelopeSchema.parse(command.envelope);
          const { digest: envelopeDigest, ...envelopeFields } = envelope;
          if (
            managedControlDigest(envelopeFields) !== envelopeDigest ||
            managedControlDigest(envelope.policy) !== envelope.policyDigest ||
            envelope.threads !== command.entries.length ||
            envelope.threads > envelope.running + envelope.queued ||
            envelope.skills.length > 0 ||
            envelope.mode !== (command.mode ?? "background") ||
            (command.origin !== undefined && !isDeepStrictEqual(envelope.origin, command.origin)) ||
            envelope.running >
              policy[envelope.mode === "background" ? "background" : "reserved"].running ||
            envelope.aggregateTokens > policy.batchTokens ||
            envelope.threadTokens > policy.threadTokens ||
            envelope.sessionTokens > fleetSessionCeiling(await controlStore.read(), policy)
          )
            return rejected(
              "action_unavailable",
              "The exact delegation envelope is invalid or exceeds current authority.",
            );
          const existingAdmissions = (await controlStore.read()).filter(
            (record) =>
              record.event.type === "admitted" && record.event.envelope?.id === envelope.id,
          );
          if (existingAdmissions.length > 0) {
            if (
              existingAdmissions.length !== command.entries.length ||
              existingAdmissions.some(
                (record, index) =>
                  record.event.type !== "admitted" ||
                  !isDeepStrictEqual(record.event.envelope, envelope) ||
                  record.event.task !== command.entries[index]?.task ||
                  record.event.role !== command.entries[index]?.role ||
                  record.event.description !== command.entries[index]?.description,
              )
            )
              return rejected(
                "action_unavailable",
                "This envelope already authorized a different exact batch.",
              );
            return {
              status: "admitted" as const,
              turns: existingAdmissions.map(
                ({ parentSessionId, threadId, turnId, attemptId, childSessionId }) => ({
                  parentSessionId,
                  threadId,
                  turnId,
                  attemptId,
                  childSessionId,
                }),
              ),
            };
          }
          if (envelope.origin.kind === "main_run" && options.parentSessionStore !== undefined) {
            const parent = await options.parentSessionStore.read();
            const run = parent.findLast(
              (record) =>
                record.schemaVersion === 3 && record.record.type === "logical_run_started",
            );
            if (
              run?.schemaVersion !== 3 ||
              run.record.type !== "logical_run_started" ||
              run.record.runId !== envelope.origin.id ||
              parent.some(
                (record) =>
                  record.schemaVersion === 3 &&
                  ((record.record.type === "run_settled" &&
                    record.record.runId === envelope.origin.id) ||
                    (record.record.type === "runtime_event" &&
                      record.record.runId === envelope.origin.id &&
                      record.record.event.type === "session_settled")),
              )
            )
              return rejected(
                "action_unavailable",
                "Unused envelope authority belongs only to its original active Main run.",
              );
          }
          const batchId = envelope.id;
          const lane =
            command.mode === "foreground" ? ("reserved" as const) : ("background" as const);
          const current = foldManagedControl(await controlStore.read(), options.parentSessionId);
          if (
            current.threads.filter(
              (thread) =>
                (thread.turn.lane ?? "background") === lane && thread.turn.phase !== "idle",
            ).length +
              command.entries.length >
            policy[lane].running + policy[lane].queued
          )
            return rejected(
              "capacity_exhausted",
              "This lane has no remaining nonterminal admission capacity.",
            );
          const inputs = command.entries.map((entry) => ({
            parentSessionId: options.parentSessionId,
            threadId: randomUUID(),
            turnId: randomUUID(),
            attemptId: randomUUID(),
            childSessionId: randomUUID(),
            schemaVersion: 3 as const,
            event: { type: "admitted" as const, ...entry, batchId, lane, frozen, envelope },
          }));
          const capacity = await storageUsage(await controlStore.read());
          if (
            storedRecordBytes(inputs) +
              inputs.reduce(
                (total, input) =>
                  total + startupBytes({ ...input, sequence: Number.MAX_SAFE_INTEGER }),
                0,
              ) +
              inputs.length * (managedControlTerminalBytes + managedChildTerminalBytes + 128) >
            capacity.availableBytes
          )
            return rejected(
              "storage_quota_exceeded",
              "There is not enough logical storage for the complete batch and its terminal receipts.",
            );
          const records = await controlStore.appendBatchNext(inputs);
          const lastAdmission = records.at(-1);
          if (lastAdmission !== undefined)
            await options[managedAgentRecordBarrier]?.(lastAdmission);
          for (const record of records) ready.add(record.turnId);
          const snapshot = await project(await controlStore.read(), options.parentSessionId);
          for (const subscriber of subscribers) subscriber({ type: "reset", snapshot });
          await startReady();
          return {
            status: "admitted" as const,
            turns: records.map(
              ({ parentSessionId, threadId, turnId, attemptId, childSessionId }) => ({
                parentSessionId,
                threadId,
                turnId,
                attemptId,
                childSessionId,
              }),
            ),
          };
        }
        if (
          command.type === "prepare_main_delivery" ||
          command.type === "acknowledge_main_delivery"
        ) {
          if (options.parentSessionStore === undefined)
            return rejected(
              "action_unavailable",
              "The canonical Main receipt owner is unavailable.",
            );
          const records = await controlStore.read();
          const snapshot = foldManagedControl(records, options.parentSessionId);
          const parentRecords = await options.parentSessionStore.read();
          validateManagedParentHistory(
            parentRecords,
            options.parentSessionId,
            options.projectId,
            options.workspaceRoot,
          );
          if (
            parentRecords.some(
              (record) =>
                record.schemaVersion === 3 &&
                record.record.type === "provider_attempt_started" &&
                record.record.managedAgentDeliveryVersion === 3 &&
                record.record.managedAgentDeliveries?.some((delivery) =>
                  snapshot.completions.some(
                    (completion) =>
                      completion.id === delivery.id &&
                      (completion.receipt.digest !== delivery.digest ||
                        managedControlMessageDigest(completion) !== delivery.messageDigest),
                  ),
                ),
            )
          )
            return rejected(
              "recovery_required",
              "The Main receipt does not match its exact completion content.",
            );
          const receipts = snapshot.completions.map((completion) => ({
            completion,
            parent: parentRecords.find(
              (record) =>
                record.schemaVersion === 3 &&
                ((record.record.type === "runtime_event" &&
                  record.record.event.type === "tool_completed" &&
                  (record.record.event.name === "spawn_agents" ||
                    record.record.event.name === "wait_agents") &&
                  managedToolContainsCompletion(record.record.event.output, completion)) ||
                  (record.record.type === "provider_attempt_started" &&
                    record.record.managedAgentDeliveryVersion === 3 &&
                    record.record.managedAgentDeliveries?.some(
                      (delivery) =>
                        delivery.id === completion.id &&
                        delivery.digest === completion.receipt.digest &&
                        delivery.messageDigest === managedControlMessageDigest(completion),
                    ))),
            ),
          }));
          if (
            command.type === "acknowledge_main_delivery" &&
            command.deliveries.some(
              (delivery) =>
                !receipts.some(
                  ({ completion, parent }) =>
                    completion.id === delivery.id &&
                    completion.receipt.digest === delivery.digest &&
                    parent !== undefined,
                ),
            )
          )
            return rejected("recovery_required", "The exact Main request receipt is not durable.");
          for (const { completion, parent } of receipts) {
            if (parent === undefined || completion.consumption === "consumed") continue;
            const record = records.find((entry) => entry.sequence === completion.receipt.sequence);
            if (record === undefined)
              return rejected("recovery_required", "The completion receipt is unavailable.");
            await append(record, {
              type: "consumed",
              completion: completion.receipt,
              parentReceipt: { sequence: parent.sequence, digest: managedControlDigest(parent) },
            });
          }
          if (command.type === "acknowledge_main_delivery")
            return { status: "acknowledged" as const };
          const pending = receipts
            .filter(
              ({ completion, parent }) =>
                completion.consumption === "pending" && parent === undefined,
            )
            .slice(0, 32);
          if (
            storedRecordBytes(parentRecords) +
              pending.reduce(
                (total, { completion }) =>
                  total + Buffer.byteLength(JSON.stringify(completion), "utf8") * 2 + 2048,
                0,
              ) >
            Math.min(policy.storageBytes, 32 * 1024 * 1024)
          )
            return { status: "delivery" as const, messages: [], deliveries: [] };
          return {
            status: "delivery" as const,
            messages: pending.map(({ completion }) => ({
              id: completion.id,
              text: `Managed agent ${completion.threadId}, turn ${completion.turnId}: ${completion.outcome.status}\n${completion.outcome.summary}`,
            })),
            deliveries: pending.map(({ completion }) => ({
              id: completion.id,
              digest: completion.receipt.digest,
            })),
          };
        }
        if (command.type === "recover_turn") {
          const records = await controlStore.read();
          const admission = records.findLast(
            (record) => record.threadId === command.threadId && record.event.type === "admitted",
          );
          if (
            admission === undefined ||
            admission.parentSessionId !== options.parentSessionId ||
            admission.turnId !== command.expectedTurnId
          )
            return rejected(
              "stale_revision",
              "The selected turn changed. Inspect the current thread.",
            );
          if (active.has(command.threadId))
            return rejected("authority_busy", "The selected turn has not settled.");
          const turnRecords = records.filter((record) => record.turnId === admission.turnId);
          if (
            admission.event.type === "admitted" &&
            admission.event.frozen !== undefined &&
            (!isDeepStrictEqual(admission.event.frozen.targetIdentity, options.targetIdentity) ||
              !isDeepStrictEqual(admission.event.frozen.contextProfile, options.contextProfile))
          )
            return rejected(
              "action_unavailable",
              "The thread's frozen target and context are unavailable.",
            );
          if (
            admission.event.type === "admitted" &&
            admission.event.lane !== undefined &&
            turnRecords.every(
              (record) =>
                record.event.type === "admitted" ||
                record.event.type === "suspend_requested" ||
                record.event.type === "admission_paused",
            ) &&
            (await options.childSessionStores.open(admission.childSessionId)) === undefined
          ) {
            if (!(await currentCeilingAllows()))
              return rejected("plan_policy_paused", "Paused by current Plan policy");
            ready.add(admission.turnId);
            await startReady();
            return {
              status: "accepted" as const,
              parentSessionId: admission.parentSessionId,
              threadId: admission.threadId,
              turnId: admission.turnId,
              attemptId: admission.attemptId,
              childSessionId: admission.childSessionId,
            };
          }
          let outcome = turnRecords.find((record) => record.event.type === "outcome");
          const childStore = await options.childSessionStores.open(admission.childSessionId);
          let childRecords = await childStore?.read();
          if (childRecords?.[0] !== undefined)
            validateManagedChildGenesis(admission, childRecords[0]);
          if (childRecords !== undefined)
            await reconcileInputs(
              admission,
              childRecords,
              outcome === undefined ? undefined : "settled",
            );
          const recoveryTools =
            admission.event.type === "admitted" && admission.event.frozen !== undefined
              ? childTools(admission)
              : createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
          const childGenesis = childRecords?.[0];
          if (
            outcome === undefined &&
            childRecords !== undefined &&
            childGenesis?.schemaVersion === 3 &&
            childGenesis.record.type === "session_genesis" &&
            childGenesis.record.sessionId === admission.childSessionId &&
            childGenesis.record.projectId === options.projectId &&
            isDeepStrictEqual(childGenesis.record.targetIdentity, options.targetIdentity)
          ) {
            if (
              childRecords.some(
                (record) =>
                  record.schemaVersion === 3 &&
                  record.record.type === "provider_attempt_interrupted" &&
                  record.record.reason === "run_terminal",
              )
            )
              childRecords = await settleManagedChildTerminalIntent({
                workspaceRoot: options.workspaceRoot,
                sessionId: admission.childSessionId,
                childSessionStores: options.childSessionStores,
              });
            const result = await managedChildTerminalResult(
              childRecords,
              options.workspaceRoot,
              options.artifactStore,
            );
            if (result !== undefined)
              outcome = await append(
                admission,
                await materializeManagedOutcome(
                  result,
                  childRecords,
                  turnRecords,
                  options.artifactStore,
                ),
              );
          }
          if (outcome?.event.type !== "outcome") {
            if (admission.event.type !== "admitted" || admission.event.envelope === undefined)
              return rejected(
                "action_unavailable",
                "This historical turn has no frozen scheduler envelope. Inspect or cancel it.",
              );
            const genesis = childRecords?.[0];
            if (
              admission.event.type === "admitted" &&
              childStore !== undefined &&
              childRecords !== undefined &&
              genesis?.schemaVersion === 3 &&
              genesis.record.type === "session_genesis" &&
              genesis.record.sessionId === admission.childSessionId &&
              genesis.record.projectId === options.projectId &&
              isDeepStrictEqual(genesis.record.targetIdentity, options.targetIdentity) &&
              isDeepStrictEqual(genesis.record.contextProfile, options.contextProfile) &&
              isDeepStrictEqual(
                genesis.record.promptContext,
                createPromptContextV1(
                  recoveryTools,
                  admission.event.type === "admitted"
                    ? admission.event.frozen?.promptContext.repository
                    : undefined,
                ),
              ) &&
              !turnRecords.some(
                (record) =>
                  record.event.type === "cancel_requested" || record.event.type === "stalled",
              )
            ) {
              const identity: ManagedControlIdentity = {
                parentSessionId: admission.parentSessionId,
                threadId: admission.threadId,
                turnId: admission.turnId,
                attemptId: admission.attemptId,
                childSessionId: admission.childSessionId,
              };
              const resume =
                childRecords.length === 1
                  ? undefined
                  : prepareManagedChildResume(childRecords, recoveryTools, options.workspaceRoot);
              if (childRecords.length > 1 && resume === undefined) {
                await reconcileInputs(admission, childRecords, "restart");
                return rejected(
                  "recovery_required",
                  "This interrupted effect cannot be replayed safely.",
                );
              }
              if (!(await currentCeilingAllows()))
                return rejected("plan_policy_paused", "Paused by current Plan policy");
              recoveryStarts.set(identity.turnId, { store: childStore, resume });
              ready.add(identity.turnId);
              await startReady();
              return { status: "accepted" as const, ...identity };
            }
            return rejected(
              "recovery_required",
              "This interrupted effect cannot be replayed safely.",
            );
          }
          const provenRecords =
            childRecords ??
            (outcome.event.status === "cancelled" &&
            outcome.event.transcript.sequence === 0 &&
            !turnRecords.some((record) => record.event.type === "started")
              ? []
              : undefined);
          if (
            provenRecords === undefined ||
            managedTranscriptLink(provenRecords).digest !== outcome.event.transcript.digest ||
            (provenRecords.at(-1)?.sequence ?? 0) !== outcome.event.transcript.sequence
          )
            return rejected(
              "recovery_required",
              "The child transcript does not match its outcome receipt.",
            );
          await reconcileInputs(
            admission,
            provenRecords,
            outcome.event.status === "cancelled" ? "cancelled" : "settled",
          );
          const settled =
            turnRecords.find((record) => record.event.type === "settled") ??
            (await append(admission, { type: "settled", outcome: managedControlLink(outcome) }));
          if (!turnRecords.some((record) => record.event.type === "completion"))
            await append(admission, { type: "completion", settled: managedControlLink(settled) });
          return { status: "recovered" as const };
        }
        const snapshot = foldManagedControl(await controlStore.read(), options.parentSessionId);
        const previous =
          command.type === "next_turn"
            ? snapshot.threads.find((thread) => thread.threadId === command.threadId)
            : undefined;
        if (command.type === "next_turn") {
          if (previous === undefined || previous.turn.turnId !== command.expectedTurnId)
            return rejected(
              "stale_revision",
              "The selected turn changed. Inspect the current thread.",
            );
          if (previous.lifecycle === "closed")
            return rejected("action_unavailable", "The thread is closed and remains read-only.");
          const firstAdmission = (await controlStore.read()).find(
            (record) => record.threadId === previous.threadId && record.event.type === "admitted",
          );
          const initialMaximumAttempts =
            firstAdmission?.event.type === "admitted"
              ? (firstAdmission.event.envelope?.policy.maximumAttempts ?? 4)
              : 4;
          if (
            (await controlStore.read()).filter(
              (record) => record.threadId === previous.threadId && record.event.type === "admitted",
            ).length >= Math.min(policy.maximumAttempts, initialMaximumAttempts)
          )
            return rejected("attempt_limit", "This thread has reached its four-attempt limit.");
          if (previous.turn.phase !== "idle")
            return rejected("authority_busy", "The selected turn has not settled.");
          const previousStore = await options.childSessionStores.open(previous.turn.childSessionId);
          const previousRecords = await previousStore?.read();
          const genesis = previousRecords?.[0];
          if (
            genesis?.schemaVersion !== 3 ||
            genesis.record.type !== "session_genesis" ||
            genesis.record.sessionId !== previous.turn.childSessionId ||
            genesis.record.projectId !== options.projectId ||
            previous.turn.outcome?.transcript.digest !==
              managedTranscriptLink(previousRecords ?? []).digest
          )
            return rejected(
              "recovery_required",
              "The child transcript does not match its outcome receipt.",
            );
          if (
            !isDeepStrictEqual(genesis.record.targetIdentity, options.targetIdentity) ||
            !isDeepStrictEqual(genesis.record.contextProfile, options.contextProfile)
          )
            return rejected(
              "action_unavailable",
              "The thread's frozen target and context are unavailable.",
            );
        }
        const identity: ManagedControlIdentity = {
          parentSessionId: options.parentSessionId,
          threadId: previous?.threadId ?? randomUUID(),
          turnId: randomUUID(),
          attemptId: randomUUID(),
          childSessionId: randomUUID(),
        };
        const priorAdmission =
          previous === undefined
            ? undefined
            : (await controlStore.read()).find(
                (record) =>
                  record.threadId === previous.threadId && record.event.type === "admitted",
              );
        const inherited =
          priorAdmission?.event.type === "admitted" ? priorAdmission.event : undefined;
        if (inherited?.envelope === undefined)
          return rejected(
            "action_unavailable",
            "This historical thread has no frozen scheduler envelope and remains read-only.",
          );
        if (inherited.frozen === undefined)
          return rejected(
            "action_unavailable",
            "The original frozen thread configuration is unavailable.",
          );
        const envelope =
          command.envelope === undefined
            ? await control.prepareContinuation(command)
            : delegationEnvelopeSchema.parse(command.envelope);
        const { digest, ...fields } = envelope;
        const lane = inherited.lane ?? "background";
        if (
          digest !== managedControlDigest(fields) ||
          envelope.policyDigest !== managedControlDigest(envelope.policy) ||
          envelope.threads !== 1 ||
          envelope.running !== 1 ||
          envelope.mode !== (lane === "reserved" ? "foreground" : "background") ||
          envelope.skills.length !== 0 ||
          envelope.threadTokens > Math.min(inherited.envelope.threadTokens, policy.threadTokens) ||
          envelope.aggregateTokens > policy.batchTokens ||
          envelope.sessionTokens > fleetSessionCeiling(await controlStore.read(), policy) ||
          (command.origin !== undefined && !isDeepStrictEqual(envelope.origin, command.origin)) ||
          (await controlStore.read()).some(
            (record) =>
              record.event.type === "admitted" && record.event.envelope?.id === envelope.id,
          )
        )
          return rejected(
            "action_unavailable",
            "The exact continuation envelope is invalid or already spent.",
          );
        if (
          snapshot.threads.filter(
            (thread) => thread.turn.phase !== "idle" && (thread.turn.lane ?? "background") === lane,
          ).length >=
          policy[lane].running + policy[lane].queued
        )
          return rejected("capacity_exhausted", "This lane has no remaining admission capacity.");
        const event: ManagedControlEvent = {
          type: "admitted",
          envelope,
          batchId: envelope.id,
          lane,
          frozen: inherited.frozen,
          role: previous?.role ?? "builtin:explore",
          description: previous?.description ?? "",
          task: command.task,
          ...(command.inputId === undefined ? {} : { inputId: command.inputId }),
        };
        const history = await controlStore.read();
        const capacity = await storageUsage(history);
        if (
          storedRecordBytes([
            { ...identity, schemaVersion: 3, sequence: history.length + 1, event },
          ]) +
            startupBytes({ ...identity, schemaVersion: 3, sequence: history.length + 1, event }) +
            managedControlTerminalBytes +
            managedChildTerminalBytes >
          capacity.availableBytes
        )
          return rejected(
            "storage_quota_exceeded",
            "There is no exact admission and terminal storage reservation for another turn.",
          );
        await append(identity, event);
        ready.add(identity.turnId);
        await startReady();
        return { status: "accepted" as const, ...identity };
      } finally {
        await claim.release();
      }
    });
  }
  async function joinForeground(
    command: ManagedControlCommand,
    receipt: ManagedControlReceipt,
    dispatchOptions?: { readonly signal?: AbortSignal },
  ): Promise<ManagedControlReceipt> {
    if (
      command.type !== "spawn_agents" ||
      command.mode !== "foreground" ||
      receipt.status !== "admitted"
    )
      return receipt;
    const targets = receipt.turns.map((turn) => ({
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
    }));
    const result = await control.dispatch(
      { type: "wait_agents", parentSessionId: options.parentSessionId, targets, mode: "all" },
      dispatchOptions,
    );
    if (dispatchOptions?.signal?.aborted && result.status !== "completed")
      await control.dispatch({
        type: "cancel_agents",
        parentSessionId: options.parentSessionId,
        targets,
      });
    return result;
  }
  return control;
}

export function createManagedAgentControlToolRegistry(options: {
  readonly control: ManagedAgentControl | (() => Promise<ManagedAgentControl | undefined>);
  readonly parentSessionId: string;
}): ToolRegistry {
  const resolveControl = async () => {
    const control =
      typeof options.control === "function" ? await options.control() : options.control;
    if (control === undefined) throw new Error("The current managed control is unavailable.");
    return control;
  };
  const target = z.strictObject({
    threadId: z.string().min(1).max(128),
    expectedTurnId: z.uuid().optional(),
  });
  const schemas = [
    { name: "spawn_agents" as const, schema: spawnInputSchema },
    {
      name: "list_agents" as const,
      schema: z.strictObject({
        limit: z.number().int().min(1).max(32).optional(),
        cursor: z.string().max(128).optional(),
      }),
    },
    {
      name: "wait_agents" as const,
      schema: z.strictObject({
        targets: z.array(target).min(1).max(32),
        mode: z.enum(["any", "all"]).default("all"),
      }),
    },
    {
      name: "post_agent" as const,
      schema: target.extend({
        mode: z.enum(["cooperative", "interrupt", "new_turn"]).default("cooperative"),
        text: z.string().min(1).max(8192),
        inputId: z.uuid().optional(),
      }),
    },
    {
      name: "reply_agent" as const,
      schema: target.extend({
        attentionId: z.string().min(1).max(128),
        text: z.string().min(1).max(8192),
        inputId: z.uuid().optional(),
      }),
    },
    {
      name: "cancel_agents" as const,
      schema: z.strictObject({ targets: z.array(target).min(1).max(32) }),
    },
  ];
  return createInternalToolRegistry(
    schemas.map(({ name, schema }) =>
      createInternalToolAdapter(
        {
          definition: {
            name,
            description:
              name === "spawn_agents"
                ? "Atomically admit 1-32 background agents, or join exactly one foreground agent. Target, thinking and authority are Host-owned."
                : name === "list_agents"
                  ? "List bounded thread summaries and actions without raw task or transcript."
                  : name === "wait_agents"
                    ? "Wait for any/all exact turns. Handles resolve once at dispatch."
                    : name === "post_agent"
                      ? "Post exact input cooperatively, interrupt after the current effect, or start an idle new turn. Queued tasks are immutable."
                      : name === "reply_agent"
                        ? "Reply to one exact parent-input attention. This cannot answer permission."
                        : "Atomically register cancellation intents for exact selected turns, then join settlement.",
            inputSchema: z.toJSONSchema(schema),
          },
          effect: name === "list_agents" || name === "wait_agents" ? "read" : "delegate",
          cancellation: "abort_signal",
          maximumResult: { maximumBytes: 1024 * 1024 },
          outputSchema: z.custom<JsonValue>(),
          prepare(argumentsJson, source) {
            let value: unknown;
            try {
              value = JSON.parse(argumentsJson) as unknown;
            } catch {
              value = undefined;
            }
            const parsed = schema.safeParse(value);
            if (
              !parsed.success ||
              (name === "spawn_agents" &&
                (!spawnInputSchema.safeParse(parsed.data).success ||
                  !("entries" in parsed.data) ||
                  !validSpawnMode(parsed.data)))
            )
              return {
                status: "failed",
                error: { code: "invalid_tool_input", message: "Tool input is invalid." },
              };
            let prepared:
              | Promise<{ control: ManagedAgentControl; command: ManagedControlCommand }>
              | undefined;
            const prepare = () =>
              (prepared ??= (async () => {
                const control = await resolveControl();
                const snapshot = await control.inspect({
                  parentSessionId: options.parentSessionId,
                });
                const resolveTarget = (input: z.infer<typeof target>) => {
                  const thread = snapshot.threads.find(
                    (thread) =>
                      thread.threadId === input.threadId || thread.handle === input.threadId,
                  );
                  return {
                    threadId: thread?.threadId ?? input.threadId,
                    expectedTurnId: input.expectedTurnId ?? thread?.turn.turnId,
                  };
                };
                let data: object = parsed.data;
                if ("targets" in parsed.data)
                  data = { ...parsed.data, targets: parsed.data.targets.map(resolveTarget) };
                if ("threadId" in parsed.data)
                  data = {
                    ...parsed.data,
                    ...resolveTarget(parsed.data),
                    inputId: parsed.data.inputId ?? randomUUID(),
                  };
                if (
                  (name === "spawn_agents" ||
                    (name === "post_agent" &&
                      "mode" in parsed.data &&
                      parsed.data.mode === "new_turn")) &&
                  source?.runId !== undefined
                )
                  data = {
                    ...data,
                    origin: { kind: "main_run", id: source.runId, callId: source.callId },
                  };
                let command = commandSchema.parse({
                  ...data,
                  type: name,
                  parentSessionId: options.parentSessionId,
                }) as ManagedControlCommand;
                if (command.type === "spawn_agents")
                  command = { ...command, envelope: await control.prepareDelegation(command) };
                if (command.type === "post_agent" && command.mode === "new_turn")
                  command = {
                    ...command,
                    envelope: await control.prepareContinuation({
                      type: "next_turn",
                      parentSessionId: command.parentSessionId,
                      threadId: command.threadId,
                      expectedTurnId: command.expectedTurnId,
                      task: command.text,
                      inputId: command.inputId,
                      ...(command.origin === undefined ? {} : { origin: command.origin }),
                    }),
                  };
                return { control, command };
              })());
            return {
              status: "ready",
              permissionSubject: {
                type: "managed_agent_action",
                parentSessionId: options.parentSessionId,
                action: name === "spawn_agents" ? "post_agent" : name,
                threadIds: [],
                turnIds: [],
                argumentsDigest: managedControlDigest(parsed.data),
              },
              async resolvePermissionSubject() {
                const { command } = await prepare();
                if (command.type === "spawn_agents" && command.envelope !== undefined)
                  return {
                    type: "managed_agent_batch",
                    envelope: command.envelope,
                    parentSessionId: command.parentSessionId,
                    count: command.entries.length,
                    mode: command.mode ?? "background",
                    argumentsDigest: managedControlDigest(command),
                  };
                const targets =
                  "targets" in command
                    ? command.targets
                    : "threadId" in command
                      ? [{ threadId: command.threadId, expectedTurnId: command.expectedTurnId }]
                      : [];
                return {
                  type: "managed_agent_action",
                  parentSessionId: command.parentSessionId,
                  action: name === "spawn_agents" ? "post_agent" : name,
                  ...(command.type === "post_agent" && command.envelope !== undefined
                    ? { envelope: command.envelope }
                    : {}),
                  threadIds: targets.map((target) => target.threadId),
                  turnIds: targets.map((target) => target.expectedTurnId),
                  argumentsDigest: managedControlDigest(command),
                };
              },
              async execute(context) {
                try {
                  const { control, command } = await prepare();
                  const receipt = await control.dispatch(command, { signal: context.signal });
                  return receipt.status === "rejected"
                    ? {
                        status: "failed",
                        error: { code: "managed_agent_unavailable", message: receipt.message },
                      }
                    : { status: "completed", output: receipt as unknown as JsonValue };
                } catch {
                  return {
                    status: "failed",
                    error: {
                      code: "managed_agent_unavailable",
                      message:
                        "The exact managed action is unavailable. Inspect the current workspace.",
                    },
                  };
                }
              },
            };
          },
        },
        "never",
      ),
    ),
  );
}

function intersectReadPermission(
  frozen: "allow" | "ask" | "deny",
  current: "allow" | "ask" | "deny",
): "allow" | "ask" | "deny" {
  return frozen === "deny" || current === "deny"
    ? "deny"
    : frozen === "ask" || current === "ask"
      ? "ask"
      : "allow";
}

function managedToolContainsCompletion(
  output: unknown,
  completion: ManagedWorkspaceSnapshot["completions"][number],
): boolean {
  if (
    typeof output !== "object" ||
    output === null ||
    !("status" in output) ||
    output.status !== "completed" ||
    !("results" in output) ||
    !Array.isArray(output.results)
  )
    return false;
  return output.results.some((result) =>
    isDeepStrictEqual(result, { ...completion, consumption: "pending" }),
  );
}

function managedControlMessageDigest(
  completion: ManagedWorkspaceSnapshot["completions"][number],
): `sha256:${string}` {
  const text = `Parent message (${completion.id}): Managed agent ${completion.threadId}, turn ${completion.turnId}: ${completion.outcome.status}\n${completion.outcome.summary}`;
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** AgentSession writes the canonical Main receipt before Control may acknowledge consumption. */
export function managedControlMainRequestBoundary(
  control: ManagedAgentControl,
  parentSessionId: string,
): ManagedAgentRequestBoundary {
  return async () => {
    const receipt = await control.dispatch({ type: "prepare_main_delivery", parentSessionId });
    if (
      receipt.status === "rejected" &&
      receipt.code === "recovery_required" &&
      (await control.inspect({ parentSessionId })).status === "recovery_required"
    )
      return { atomicReceipt: true, messages: [], deliveries: [], async acknowledge() {} };
    if (receipt.status !== "delivery")
      throw new Error("Managed completion delivery is unavailable.");
    return {
      atomicReceipt: true,
      messages: receipt.messages,
      deliveries: receipt.deliveries,
      async acknowledge() {
        if (receipt.deliveries.length === 0) return;
        const acknowledged = await control.dispatch({
          type: "acknowledge_main_delivery",
          parentSessionId,
          deliveries: receipt.deliveries,
        });
        if (acknowledged.status !== "acknowledged")
          throw new Error("Managed completion acknowledgement is unavailable.");
      },
    };
  };
}
