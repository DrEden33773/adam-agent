import type {
  ManagedControlIdentity,
  ManagedControlLink,
  ManagedControlOutcome,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";

export type {
  ManagedControlIdentity,
  ManagedControlLink,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";

import { createHash } from "node:crypto";
import { z } from "zod";
import { type ManagedAgentRecord, ManagedAgentStoreError } from "./managed-agent.js";
import type { SessionRecord } from "./session-store.js";

export type ManagedControlEvent =
  | {
      readonly type: "admitted";
      readonly role: "builtin:explore";
      readonly description: string;
      readonly task: string;
    }
  | { readonly type: "started" }
  | { readonly type: "cancel_requested" }
  | {
      readonly type: "execution_progress";
      readonly deadlineId: string;
      readonly atUnixMilliseconds: number;
      readonly transcript: ManagedControlLink;
    }
  | { readonly type: "stalled"; readonly deadlineId: string }
  | {
      readonly type: "cleanup_expired";
      readonly deadlineId: string;
      readonly maximumMilliseconds: 10_000;
    }
  | {
      readonly type: "consumed";
      readonly completion: ManagedControlLink;
      readonly parentReceipt: ManagedControlLink;
    }
  | ManagedControlOutcome
  | { readonly type: "settled"; readonly outcome: ManagedControlLink }
  | { readonly type: "completion"; readonly settled: ManagedControlLink };

export type ManagedControlRecord = ManagedControlIdentity & {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly event: ManagedControlEvent;
};

export type ManagedControlStore = {
  forParent(parentSessionId: string): ManagedControlStore;
  preflight(): Promise<void>;
  readLegacy(): Promise<readonly ManagedAgentRecord[]>;
  read(): Promise<readonly ManagedControlRecord[]>;
  append(record: ManagedControlRecord): Promise<void>;
  appendNext(record: Omit<ManagedControlRecord, "sequence">): Promise<ManagedControlRecord>;
};

const linkSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const boundedText = (maximum: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maximum);
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("admitted"),
    role: z.literal("builtin:explore"),
    description: boundedText(256).refine((value) => value.length > 0 && !/\p{Cc}/u.test(value)),
    task: boundedText(16 * 1024).refine((value) => value.trim().length > 0),
  }),
  z.strictObject({ type: z.literal("started") }),
  z.strictObject({ type: z.literal("cancel_requested") }),
  z.strictObject({
    type: z.literal("execution_progress"),
    deadlineId: z.uuid(),
    atUnixMilliseconds: z.number().int().nonnegative(),
    transcript: linkSchema,
  }),
  z.strictObject({ type: z.literal("stalled"), deadlineId: z.uuid() }),
  z.strictObject({
    type: z.literal("cleanup_expired"),
    deadlineId: z.uuid(),
    maximumMilliseconds: z.literal(10_000),
  }),
  z.strictObject({
    type: z.literal("consumed"),
    completion: linkSchema,
    parentReceipt: linkSchema,
  }),
  z.strictObject({
    type: z.literal("outcome"),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
      providerCalls: z.number().int().nonnegative(),
      unknownCalls: z.number().int().nonnegative(),
    }),
    status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
    summary: boundedText(16 * 1024),
    transcript: linkSchema,
    error: z.strictObject({ code: boundedText(128), message: boundedText(1024) }).optional(),
  }),
  z.strictObject({ type: z.literal("settled"), outcome: linkSchema }),
  z.strictObject({ type: z.literal("completion"), settled: linkSchema }),
]);
const recordSchema = z.strictObject({
  schemaVersion: z.literal(3),
  sequence: z.number().int().positive(),
  parentSessionId: z.uuid(),
  threadId: z.uuid(),
  turnId: z.uuid(),
  attemptId: z.uuid(),
  childSessionId: z.uuid(),
  event: eventSchema,
});

export function validateManagedControlRecord(
  value: unknown,
  previous: readonly ManagedControlRecord[],
): ManagedControlRecord {
  const parsed = recordSchema.safeParse(value);
  const invalid = (): never => {
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
  };
  if (!parsed.success) return invalid();
  const record = structuredClone(value) as ManagedControlRecord;
  if (record.sequence !== previous.length + 1) return invalid();
  const threadRecords = previous.filter((entry) => entry.threadId === record.threadId);
  if (threadRecords.some((entry) => entry.parentSessionId !== record.parentSessionId))
    return invalid();
  const turnRecords = previous.filter((entry) => entry.turnId === record.turnId);
  if (record.event.type === "admitted") {
    if (
      turnRecords.length > 0 ||
      previous.some(
        (entry) =>
          entry.attemptId === record.attemptId || entry.childSessionId === record.childSessionId,
      )
    )
      return invalid();
    const last = threadRecords.at(-1);
    if (last !== undefined && last.event.type !== "completion" && last.event.type !== "consumed")
      return invalid();
    const first = threadRecords[0];
    if (
      first?.event.type === "admitted" &&
      (first.event.role !== record.event.role ||
        first.event.description !== record.event.description)
    )
      return invalid();
  } else {
    const admission = turnRecords[0];
    if (
      admission?.event.type !== "admitted" ||
      admission.threadId !== record.threadId ||
      admission.parentSessionId !== record.parentSessionId ||
      admission.attemptId !== record.attemptId ||
      admission.childSessionId !== record.childSessionId
    )
      return invalid();
    if (
      record.event.type !== "execution_progress" &&
      turnRecords.some((entry) => entry.event.type === record.event.type)
    )
      return invalid();
    const last = turnRecords.at(-1);
    const event = record.event;
    if (
      event.type === "cleanup_expired" &&
      (last?.event.type !== "outcome" || event.deadlineId !== record.attemptId)
    )
      return invalid();
    if (
      event.type === "consumed" &&
      (last?.event.type !== "completion" ||
        event.completion.sequence !== last.sequence ||
        event.completion.digest !== managedControlDigest(last))
    )
      return invalid();
    if (
      event.type === "started" &&
      last?.event.type !== "admitted" &&
      last?.event.type !== "cancel_requested"
    )
      return invalid();
    const executing =
      last?.event.type === "started" ||
      last?.event.type === "execution_progress" ||
      last?.event.type === "stalled";
    if (
      (event.type === "execution_progress" || event.type === "stalled") &&
      (!executing || event.deadlineId !== record.attemptId)
    )
      return invalid();
    if (event.type === "cancel_requested" && !executing && last?.event.type !== "admitted")
      return invalid();
    if (event.type === "outcome" && !executing && last?.event.type !== "cancel_requested")
      return invalid();
    if (event.type === "settled" || event.type === "completion") {
      const targetType = event.type === "settled" ? "outcome" : "settled";
      const link = event.type === "settled" ? event.outcome : event.settled;
      const target =
        event.type === "settled" && last?.event.type === "cleanup_expired"
          ? turnRecords.find((entry) => entry.event.type === "outcome")
          : last;
      if (
        target?.event.type !== targetType ||
        link.sequence !== target.sequence ||
        link.digest !== managedControlDigest(target)
      )
        return invalid();
    }
  }
  return record;
}

export function managedControlDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function managedControlLink(record: ManagedControlRecord): ManagedControlLink {
  return { sequence: record.sequence, digest: managedControlDigest(record) };
}

export function managedTranscriptLink(records: readonly SessionRecord[]): ManagedControlLink {
  return { sequence: records.at(-1)?.sequence ?? 0, digest: managedControlDigest(records) };
}

export function managedCompletionId(identity: ManagedControlIdentity): `sha256:${string}` {
  return managedControlDigest([identity.parentSessionId, identity.threadId, identity.turnId]);
}

export function foldManagedControl(
  records: readonly ManagedControlRecord[],
  parentSessionId: string,
): ManagedWorkspaceSnapshot {
  const threads = new Map<string, ManagedControlThread>();
  for (const record of records) {
    if (record.parentSessionId !== parentSessionId) continue;
    const event = record.event;
    if (event.type === "consumed") continue;
    if (event.type === "admitted") {
      const existing = threads.get(record.threadId);
      threads.set(record.threadId, {
        parentSessionId,
        lifecycle: "open",
        displayName: "Explore",
        handle: existing?.handle ?? `@explore-${threads.size + 1}`,
        residency: "live",
        threadId: record.threadId,
        role: event.role,
        description: event.description,
        turn: {
          turnId: record.turnId,
          attemptId: record.attemptId,
          childSessionId: record.childSessionId,
          phase: "starting",
          label: "Starting",
          recovery: "none",
          health: "healthy",
          waitReason: "none",
          ownerPhase: "waiting",
          lastOutcome: "none",
        },
      });
      continue;
    }
    const thread = threads.get(record.threadId);
    if (thread === undefined || thread.turn.turnId !== record.turnId)
      throw new Error("Invalid managed control history.");
    if (event.type === "completion" || event.type === "cancel_requested") continue;
    if (event.type === "execution_progress") {
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...thread.turn,
          phase: "executing",
          label: "Running",
          watchdog: {
            deadlineId: event.deadlineId,
            maximumInactivityMilliseconds: 300_000,
            lastProgressAtUnixMilliseconds: event.atUnixMilliseconds,
            transcript: event.transcript,
            state: "running",
          },
        },
      });
      continue;
    }
    if (event.type === "stalled") {
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...thread.turn,
          health: "stalled",
          ...(thread.turn.watchdog === undefined
            ? {}
            : { watchdog: { ...thread.turn.watchdog, state: "stalled" } }),
        },
      });
      continue;
    }
    if (event.type === "cleanup_expired") {
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...thread.turn,
          recovery: "required",
          diagnostic: "Cleanup has not settled. Inspect durable state.",
        },
      });
      continue;
    }
    const previousTurn = { ...thread.turn };
    if (event.type === "settled") {
      delete previousTurn.diagnostic;
      previousTurn.recovery = "none";
    }
    const phase =
      event.type === "started" ? "executing" : event.type === "outcome" ? "settling" : "idle";
    threads.set(record.threadId, {
      ...thread,
      residency: phase === "idle" ? "unloaded" : "live",
      turn: {
        ...previousTurn,
        phase,
        ownerPhase:
          phase === "settling" ? "releasing" : phase === "executing" ? "claimed" : "released",
        lastOutcome: event.type === "outcome" ? event.status : thread.turn.lastOutcome,
        label:
          phase === "settling"
            ? "Settling"
            : phase === "executing"
              ? "Running"
              : thread.turn.outcome?.status === "cancelled"
                ? "Cancelled"
                : thread.turn.outcome?.status === "failed"
                  ? "Failed"
                  : thread.turn.outcome?.status === "interrupted"
                    ? "Interrupted"
                    : "Completed",
        ...(event.type === "outcome" ? { outcome: event } : {}),
        ...(event.type === "outcome" && thread.turn.watchdog !== undefined
          ? {
              watchdog: {
                ...thread.turn.watchdog,
                state:
                  thread.turn.health === "stalled" ? ("stalled" as const) : ("stopped" as const),
              },
            }
          : {}),
      },
    });
  }
  return {
    completions: records.flatMap((record) => {
      if (record.parentSessionId !== parentSessionId || record.event.type !== "completion")
        return [];
      const outcome = records.find(
        (entry) => entry.turnId === record.turnId && entry.event.type === "outcome",
      );
      if (outcome?.event.type !== "outcome")
        throw new ManagedAgentStoreError("managed_agent_log_invalid");
      return [
        {
          id: managedCompletionId(record),
          threadId: record.threadId,
          turnId: record.turnId,
          receipt: managedControlLink(record),
          outcome: outcome.event,
          consumption: records.some(
            (entry) => entry.turnId === record.turnId && entry.event.type === "consumed",
          )
            ? ("consumed" as const)
            : ("pending" as const),
        },
      ];
    }),
    status: "ready",
    parentSessionId,
    revision: records.at(-1)?.sequence ?? 0,
    threads: [...threads.values()],
  };
}
