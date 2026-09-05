import type { ManagedControlCommand, ManagedControlReceipt } from "@adam-agent/presentation";

export type { ManagedControlCommand, ManagedControlReceipt } from "@adam-agent/presentation";

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  AgentSession,
  type ManagedAgentRequestBoundary,
  managedAgentPartialOutput,
  managedAgentRequestBoundary,
  sessionRecordCommittedBarrier,
} from "./agent-session.js";
import type { ModelDriver } from "./agent-session-contracts.js";
import type { ContextProfile } from "./context-profile.js";
import {
  type ManagedAgentInactivityScheduler,
  ManagedAgentStoreError,
  nodeManagedAgentDeadlineScheduler,
} from "./managed-agent.js";
import {
  foldManagedControl,
  type ManagedControlEvent,
  type ManagedControlIdentity,
  type ManagedControlRecord,
  type ManagedControlStore,
  type ManagedWorkspaceSnapshot,
  managedControlDigest,
  managedControlLink,
  managedTranscriptLink,
} from "./managed-agent-folds.js";
import {
  inspectManagedChildReceipt,
  managedChildTerminalResult,
  managedOutcomeFromChild,
  prepareManagedChildResume,
  validateManagedParentHistory,
} from "./managed-agent-recovery.js";
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
import { SessionStoreError } from "./session-store.js";
import { createReadToolRegistry, type PermissionPolicy } from "./tool-runtime.js";

/** Internal fault barrier for crash/settlement conformance; never selected by product configuration. */
export const managedAgentSettlementBarrier = Symbol("managed-agent-settlement-barrier");
export const managedAgentRecordBarrier = Symbol("managed-agent-record-barrier");

export type ManagedWorkspaceFrame = {
  readonly type: "snapshot" | "change" | "reset";
  readonly snapshot: ManagedWorkspaceSnapshot;
};

export type ManagedAgentControl = {
  inspect(input: { readonly parentSessionId: string }): Promise<ManagedWorkspaceSnapshot>;
  observe(input: {
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
  }): AsyncIterable<ManagedWorkspaceFrame>;
  dispatch(command: ManagedControlCommand): Promise<ManagedControlReceipt>;
};

const taskSchema = z
  .string()
  .refine((text) => text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= 16 * 1024);
const commandSchema = z.discriminatedUnion("type", [
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
  z.strictObject({ type: z.literal("close"), parentSessionId: z.uuid() }),
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
  readonly parentSessionStore?: SessionStore<SessionRecord>;
  readonly inactivityScheduler?: ManagedAgentInactivityScheduler;
  readonly cleanupScheduler?: ManagedAgentInactivityScheduler;
  readonly now?: () => number;
  readonly [managedAgentSettlementBarrier]?: () => Promise<void>;
  readonly [managedAgentRecordBarrier]?: (record: ManagedControlRecord) => Promise<void>;
  readonly [sessionRecordCommittedBarrier]?: (record: SessionRecord) => Promise<void>;
}): ManagedAgentControl {
  const controlStore = options.store.forParent(options.parentSessionId);
  let serial = Promise.resolve();
  let closing = false;
  const inFlight = new Set<Promise<void>>();
  const failedAttempts = new Set<string>();
  const active = new Map<
    string,
    {
      readonly attemptId: string;
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
  const project = async (
    records: readonly ManagedControlRecord[],
    parentSessionId: string,
    admittingTurnId?: string,
  ): Promise<ManagedWorkspaceSnapshot> => {
    const snapshot = foldManagedControl(records, parentSessionId);
    const threads = await Promise.all(
      snapshot.threads.map((thread) => {
        const live =
          active.get(thread.threadId)?.attemptId === thread.turn.attemptId ||
          admittingTurnId === thread.turn.turnId;
        const interrupted =
          !live && thread.turn.phase !== "idle" && thread.turn.outcome === undefined;
        return inspectManagedChildReceipt(
          {
            ...thread,
            residency: live ? "live" : "unloaded",
            turn: {
              ...thread.turn,
              recovery: !live && thread.turn.phase !== "idle" ? "required" : thread.turn.recovery,
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
        );
      }),
    );
    return { ...snapshot, threads };
  };
  const append = async (identity: ManagedControlIdentity, event: ManagedControlEvent) => {
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
  const run = async (
    identity: ManagedControlIdentity,
    task: string,
    previousSessionId?: string,
    preparedStore?: SessionStore<SessionRecord>,
    resume?: ReturnType<typeof prepareManagedChildResume>,
  ) => {
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
        const tools = createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
        const promptContext = createPromptContextV1(tools);
        const store =
          preparedStore ?? (await options.childSessionStores.create(identity.childSessionId));
        if (preparedStore === undefined)
          await store.append({
            schemaVersion: 3,
            sequence: 1,
            record: {
              type: "session_genesis",
              recordVersion: 2,
              sessionId: identity.childSessionId,
              projectId: options.projectId,
              targetIdentity: options.targetIdentity,
              contextProfile: options.contextProfile,
              promptContext,
            },
          });
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
        const dependencies = {
          [managedAgentPartialOutput]: true as const,
          ...(options[sessionRecordCommittedBarrier] === undefined
            ? {}
            : { [sessionRecordCommittedBarrier]: options[sessionRecordCommittedBarrier] }),
          model: options.model,
          contextProfile: options.contextProfile,
          tools,
          permissions: {
            decide: (input: Parameters<PermissionPolicy["decide"]>[0]) =>
              input.effect === "read" && options.permissions.decide(input) === "allow"
                ? ("allow" as const)
                : ("deny" as const),
          },
          store: store as SessionStore,
          [managedAgentRequestBoundary]: async () => ({
            messages: [],
            deliveries: [],
            acknowledge: async () => {
              await serialized(async () => {
                await append(identity, {
                  type: "execution_progress",
                  deadlineId: identity.attemptId,
                  atUnixMilliseconds: (options.now ?? Date.now)(),
                  transcript: managedTranscriptLink(await store.read()),
                });
                executing = true;
                resetInactivity();
              });
            },
          }),
          [sessionDurableContext]: {
            nextSequence: preparedStore === undefined ? 2 : (await preparedStore.read()).length + 1,
            ...(resume === undefined ? {} : { resume: resume.agentState }),
            sessionId: identity.childSessionId,
            projectId: options.projectId,
            targetIdentity: options.targetIdentity,
            promptContext,
            repositoryWorkspaceRoot: options.workspaceRoot,
            initialMessages: [
              {
                role: "developer" as const,
                content:
                  "Explore the exact delegated task using local repository reads only. Do not write, execute, access Web, MCP or extensions, spawn children, or change authority. The workspace is live, not a filesystem snapshot.",
              },
              ...(previous === undefined
                ? []
                : modelMessagesFromCompleteRecords(await previous.read())),
            ],
          },
        };
        const child = new AgentSession(dependencies);
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
            executing = false;
            generation += 1;
            timer?.cancel();
          });
        const records = await store.read();
        const outcome = await serialized(async () =>
          append(
            identity,
            managedOutcomeFromChild(
              result,
              records,
              (await controlStore.read()).filter((record) => record.turnId === identity.turnId),
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
          if (active.get(identity.threadId)?.attemptId === identity.attemptId)
            active.delete(identity.threadId);
          await serialized(async () => {
            const settled = await append(identity, {
              type: "settled",
              outcome: managedControlLink(outcome),
            });
            await append(identity, { type: "completion", settled: managedControlLink(settled) });
          });
        } finally {
          await settlementClaim.release();
        }
      } finally {
        cleanupTimer?.cancel();
        await claim.release();
      }
    })();
    active.set(identity.threadId, { attemptId: identity.attemptId, controller, completion });
    inFlight.add(completion);
    void completion.then(
      () => inFlight.delete(completion),
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
  const rejected = (
    code: Extract<ManagedControlReceipt, { status: "rejected" }>["code"],
    message: string,
  ): ManagedControlReceipt => ({ status: "rejected", code, message });
  const control: ManagedAgentControl = {
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
    async dispatch(command) {
      if (!commandSchema.safeParse(command).success)
        return rejected(
          "action_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
      if (command.parentSessionId !== options.parentSessionId)
        return rejected("action_unavailable", "This control belongs to another parent Session.");
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
                (record) =>
                  record.threadId === command.threadId && record.event.type === "admitted",
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
              const live = active.get(command.threadId);
              if (live !== undefined) {
                live.controller.abort();
                return { completion: live.completion, turnId: admission.turnId };
              }
              const unstartedStore = await options.childSessionStores.open(
                admission.childSessionId,
              );
              const childRecords =
                unstartedStore === undefined &&
                !turn.some((record) => record.event.type === "started")
                  ? []
                  : await cancelManagedChildSessionRecords({
                      workspaceRoot: options.workspaceRoot,
                      sessionId: admission.childSessionId,
                      childSessionStores: options.childSessionStores,
                    });
              const outcome = await append(
                admission,
                managedOutcomeFromChild(
                  {
                    status: "cancelled",
                    error: { code: "session_cancelled", message: "The session was cancelled." },
                  },
                  childRecords,
                  turn,
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
            await cancellation.completion;
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
        closing = true;
        const drain = (async () => {
          await serial;
          for (const attempt of active.values()) attempt.controller.abort();
          const results = await Promise.allSettled([...inFlight]);
          await serial;
          return (
            results.every((result) => result.status === "fulfilled") && failedAttempts.size === 0
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
            : rejected(
                "recovery_required",
                "Managed cleanup is incomplete. Inspect durable state.",
              );
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
                  record.record.type === "provider_attempt_started" &&
                  record.record.managedAgentDeliveryVersion === 3 &&
                  record.record.managedAgentDeliveries?.some(
                    (delivery) =>
                      delivery.id === completion.id &&
                      delivery.digest === completion.receipt.digest &&
                      delivery.messageDigest === managedControlMessageDigest(completion),
                  ),
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
              return rejected(
                "recovery_required",
                "The exact Main request receipt is not durable.",
              );
            for (const { completion, parent } of receipts) {
              if (parent === undefined || completion.consumption === "consumed") continue;
              const record = records.find(
                (entry) => entry.sequence === completion.receipt.sequence,
              );
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
            let outcome = turnRecords.find((record) => record.event.type === "outcome");
            const childStore = await options.childSessionStores.open(admission.childSessionId);
            let childRecords = await childStore?.read();
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
              const result = managedChildTerminalResult(childRecords, options.workspaceRoot);
              if (result !== undefined)
                outcome = await append(
                  admission,
                  managedOutcomeFromChild(result, childRecords, turnRecords),
                );
            }
            if (outcome?.event.type !== "outcome") {
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
                    createReadToolRegistry({ workspaceRoot: options.workspaceRoot }),
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
                    : prepareManagedChildResume(
                        childRecords,
                        createReadToolRegistry({ workspaceRoot: options.workspaceRoot }),
                        options.workspaceRoot,
                      );
                if (childRecords.length > 1 && resume === undefined)
                  return rejected(
                    "recovery_required",
                    "This interrupted effect cannot be replayed safely.",
                  );
                await run(identity, admission.event.task, undefined, childStore, resume);
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
            if (previous.turn.phase !== "idle")
              return rejected("authority_busy", "The selected turn has not settled.");
            const previousStore = await options.childSessionStores.open(
              previous.turn.childSessionId,
            );
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
          await append(identity, {
            type: "admitted",
            role: previous?.role ?? "builtin:explore",
            description:
              previous?.description ?? (command.type === "start_thread" ? command.description : ""),
            task: command.task,
          });
          await run(identity, command.task, previous?.turn.childSessionId);
          return { status: "accepted" as const, ...identity };
        } finally {
          await claim.release();
        }
      }).catch((error: unknown) => {
        if (error instanceof ProjectExecutionDomainError)
          return rejected(
            error.code === "root_conflict" || error.code === "project_in_use"
              ? "authority_busy"
              : "runtime_unavailable",
            error.message,
          );
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
      });
    },
  };
  return control;
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
