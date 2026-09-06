import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ManagedDelegationContext, ManagedDelegationLimits } from "@adam-agent/presentation";
import { z } from "zod";
import type { ContextProfile } from "./context-profile.js";
import type { ManagedControlRecord } from "./managed-agent-folds.js";
import { agentRoleIdSchema } from "./role-catalog.js";
export function managedControlDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const delegationContextSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("task") }),
  z.strictObject({ mode: z.literal("current_request") }),
  z.strictObject({
    mode: z.literal("selected_messages"),
    messages: z
      .array(
        z.strictObject({
          sequence: positive,
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        }),
      )
      .min(1)
      .max(32),
  }),
]);
export type DelegationContext = ManagedDelegationContext;
export function requestedDelegationContext(
  entries: readonly { readonly context?: DelegationContext | undefined }[],
): DelegationEnvelope["context"] {
  return entries.some((entry) => entry.context?.mode === "selected_messages")
    ? "selected_messages"
    : entries.every((entry) => entry.context?.mode === "task")
      ? "task"
      : "current_request";
}
export const fleetPolicySchema = z.strictObject({
  version: z.literal(1),
  background: z.strictObject({ running: positive.max(4), queued: z.number().int().min(0).max(32) }),
  reserved: z.strictObject({ running: z.literal(1), queued: z.number().int().min(0).max(4) }),
  maximumAttempts: positive.max(4),
  threadTokens: positive,
  batchTokens: positive,
  sessionTokens: positive,
  storageBytes: positive.max(32 * 1024 * 1024),
});
export type FleetPolicy = z.infer<typeof fleetPolicySchema>;
export const delegationOriginSchema = z.strictObject({
  kind: z.enum(["main_run", "direct_request"]),
  id: z.uuid(),
  callId: z.string().min(1).max(512).optional(),
});
export const delegationEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  digest: z
    .templateLiteral(["sha256:", z.string()])
    .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
  origin: delegationOriginSchema,
  roles: z.array(agentRoleIdSchema).min(1).max(32),
  mode: z.enum(["background", "foreground"]),
  threads: positive.max(32),
  running: positive.max(4),
  queued: z.number().int().min(0).max(32),
  aggregateTokens: positive,
  threadTokens: positive,
  sessionTokens: positive,
  context: z.enum(["task", "current_request", "selected_messages"]),
  skills: z.array(z.string().max(512)).max(64),
  policy: fleetPolicySchema,
  policyDigest: z
    .templateLiteral(["sha256:", z.string()])
    .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
});
export type DelegationEnvelope = z.infer<typeof delegationEnvelopeSchema>;
const delegationLimitsSchema = delegationEnvelopeSchema
  .pick({
    mode: true,
    running: true,
    queued: true,
    aggregateTokens: true,
    threadTokens: true,
    sessionTokens: true,
  })
  .partial();
export const fleetProviderEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("provider_reserved"),
    requestId: z.uuid(),
    purpose: z.enum(["ordinary", "compaction"]),
    estimatedInput: z.number().int().nonnegative(),
    maximumOutput: positive,
    source: z.strictObject({
      sequence: positive,
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }),
  }),
  z.strictObject({
    type: z.literal("provider_usage"),
    requestId: z.uuid(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("provider_unknown"), requestId: z.uuid() }),
]);
export type FleetProviderEvent = z.infer<typeof fleetProviderEventSchema>;
export type FleetUsage = Omit<Extract<FleetProviderEvent, { type: "provider_usage" }>, "type">;

export function resolveFleetPolicy(profile: ContextProfile, input?: FleetPolicy): FleetPolicy {
  const policy = fleetPolicySchema.parse(
    input ?? {
      version: 1,
      background: { running: 4, queued: 32 },
      reserved: { running: 1, queued: 4 },
      maximumAttempts: 4,
      threadTokens: profile.contextWindowTokens,
      batchTokens: 4 * profile.contextWindowTokens,
      sessionTokens: 16 * profile.contextWindowTokens,
      storageBytes: 32 * 1024 * 1024,
    },
  );
  if (
    policy.threadTokens > profile.contextWindowTokens ||
    policy.batchTokens > 4 * profile.contextWindowTokens ||
    policy.sessionTokens > 16 * profile.contextWindowTokens
  )
    throw new TypeError("Owner policy cannot enlarge certified token ceilings.");
  return policy;
}
export function createDelegationEnvelope(
  policy: FleetPolicy,
  input: {
    mode: "background" | "foreground";
    count: number;
    origin: DelegationEnvelope["origin"];
    sessionTokens: number;
    availableTokens?: number;
    threadTokens?: number;
    roles?: DelegationEnvelope["roles"];
    context?: DelegationEnvelope["context"];
    skills?: readonly string[];
    limits?: ManagedDelegationLimits;
  },
): DelegationEnvelope {
  const lane = input.mode === "background" ? policy.background : policy.reserved;
  const value = {
    version: 1 as const,
    id: randomUUID(),
    origin: input.origin,
    roles: input.roles ?? ["builtin:explore"],
    mode: input.mode,
    threads: input.count,
    running: Math.min(lane.running, input.count),
    queued: Math.max(0, input.count - lane.running),
    aggregateTokens: Math.min(
      policy.batchTokens,
      input.sessionTokens,
      input.availableTokens ?? input.sessionTokens,
    ),
    threadTokens: Math.min(policy.threadTokens, input.threadTokens ?? policy.threadTokens),
    sessionTokens: input.sessionTokens,
    context: input.context ?? "current_request",
    skills: [...(input.skills ?? [])],
    ...delegationLimitsSchema.parse(input.limits ?? {}),
    policy,
    policyDigest: managedControlDigest(policy),
  };
  const envelope = delegationEnvelopeSchema.parse({
    ...value,
    digest: managedControlDigest(value),
  });
  if (
    !delegationEnvelopeMatches(envelope, {
      policy,
      roles: value.roles,
      count: input.count,
      mode: input.mode,
      origin: input.origin,
      sessionTokens: input.sessionTokens,
      context: value.context,
      skills: value.skills,
    }) ||
    envelope.aggregateTokens > (input.availableTokens ?? input.sessionTokens)
  )
    throw new TypeError("Delegation limits exceed the available policy or Session budget.");
  return envelope;
}

export function delegationEnvelopeMatches(
  candidate: unknown,
  expected: {
    readonly policy: FleetPolicy;
    readonly roles: readonly string[];
    readonly count: number;
    readonly mode: "background" | "foreground";
    readonly origin?: DelegationEnvelope["origin"];
    readonly sessionTokens: number;
    readonly context?: DelegationEnvelope["context"];
    readonly skills?: readonly string[];
  },
): candidate is DelegationEnvelope {
  const parsed = delegationEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const envelope = parsed.data;
  const { digest, ...fields } = envelope;
  return (
    managedControlDigest(fields) === digest &&
    managedControlDigest(envelope.policy) === envelope.policyDigest &&
    isDeepStrictEqual(envelope.policy, expected.policy) &&
    isDeepStrictEqual(envelope.roles, [...new Set(expected.roles)]) &&
    envelope.threads === expected.count &&
    envelope.threads <= envelope.running + envelope.queued &&
    isDeepStrictEqual(envelope.skills, [...new Set(expected.skills ?? [])]) &&
    envelope.context === (expected.context ?? "current_request") &&
    envelope.mode === expected.mode &&
    (expected.origin === undefined || isDeepStrictEqual(envelope.origin, expected.origin)) &&
    envelope.running <=
      expected.policy[envelope.mode === "background" ? "background" : "reserved"].running &&
    envelope.queued <=
      expected.policy[envelope.mode === "background" ? "background" : "reserved"].queued &&
    (envelope.mode !== "foreground" || envelope.threads === 1) &&
    envelope.aggregateTokens <= expected.policy.batchTokens &&
    envelope.aggregateTokens <= envelope.sessionTokens &&
    envelope.threadTokens <= expected.policy.threadTokens &&
    envelope.sessionTokens <= expected.sessionTokens
  );
}
export function fleetBudget(
  records: readonly ManagedControlRecord[],
  ceiling: number,
  select: (record: ManagedControlRecord) => boolean = () => true,
  live?: ReadonlySet<string>,
) {
  let knownUsed = 0;
  let outstandingReserved = 0;
  let unknownReserved = 0;
  let overrun = 0;
  for (const record of records) {
    if (record.event.type !== "provider_reserved" || !select(record)) continue;
    const reservation = record.event;
    const settled = records.find(
      (entry) =>
        entry.event.type === "provider_usage" && entry.event.requestId === reservation.requestId,
    );
    const reserved = reservation.estimatedInput + reservation.maximumOutput;
    if (settled?.event.type === "provider_usage") {
      const used = settled.event.inputTokens + settled.event.outputTokens;
      knownUsed += used;
      overrun += Math.max(0, used - reserved);
    } else if (
      (live !== undefined && !live.has(record.turnId)) ||
      records.some(
        (entry) =>
          entry.event.type === "provider_unknown" &&
          entry.event.requestId === reservation.requestId,
      )
    )
      unknownReserved += reserved;
    else outstandingReserved += reserved;
  }
  return {
    ceiling,
    knownUsed,
    outstandingReserved,
    unknownReserved,
    available: Math.max(0, ceiling - knownUsed - outstandingReserved - unknownReserved),
    overrun,
  };
}
export function fleetSessionCeiling(
  records: readonly ManagedControlRecord[],
  policy: FleetPolicy,
): number {
  const first = records.find(
    (entry) => entry.event.type === "admitted" && entry.event.envelope !== undefined,
  );
  return Math.min(
    policy.sessionTokens,
    first?.event.type === "admitted"
      ? (first.event.envelope?.sessionTokens ?? policy.sessionTokens)
      : policy.sessionTokens,
  );
}
export class FleetBudgetError extends Error {
  constructor(readonly code: "fleet_budget_exhausted" | "fleet_estimator_overrun") {
    super(
      code === "fleet_budget_exhausted"
        ? "No provable token capacity remains for this request."
        : "The provider exceeded its reserved token estimate.",
    );
  }
}
export function assertFleetReservation(
  records: readonly ManagedControlRecord[],
  admission: ManagedControlRecord,
  amount: number,
  policy: FleetPolicy,
): void {
  if (admission.event.type !== "admitted" || admission.event.envelope === undefined) return;
  const envelope = admission.event.envelope;
  const first = records.find(
    (record) => record.threadId === admission.threadId && record.event.type === "admitted",
  );
  const initialThreadTokens =
    first?.event.type === "admitted"
      ? (first.event.envelope?.threadTokens ?? envelope.threadTokens)
      : envelope.threadTokens;
  const thread = fleetBudget(
    records,
    Math.min(initialThreadTokens, envelope.threadTokens, policy.threadTokens),
    (record) => record.threadId === admission.threadId,
  );
  const batchTurns = new Set(
    records
      .filter(
        (record) => record.event.type === "admitted" && record.event.envelope?.id === envelope.id,
      )
      .map((record) => record.turnId),
  );
  const batch = fleetBudget(
    records,
    Math.min(envelope.aggregateTokens, policy.batchTokens),
    (record) => batchTurns.has(record.turnId),
  );
  const session = fleetBudget(records, fleetSessionCeiling(records, policy));
  if ([thread, batch, session].some((budget) => budget.overrun > 0))
    throw new FleetBudgetError("fleet_estimator_overrun");
  if ([thread, batch, session].some((budget) => budget.available < amount))
    throw new FleetBudgetError("fleet_budget_exhausted");
}

export const managedControlTerminalBytes = 64 * 1024;
export const managedChildTerminalBytes = 256 * 1024;
export function storedRecordBytes(records: readonly unknown[]): number {
  return records.reduce<number>(
    (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8") + 1,
    0,
  );
}
export function fleetStorage(
  records: readonly ManagedControlRecord[],
  ceiling: number,
  childBytes: number,
  spendingTurn?: string,
) {
  const pending = records.filter(
    (record) =>
      record.event.type === "admitted" &&
      record.turnId !== spendingTurn &&
      !records.some((entry) => entry.turnId === record.turnId && entry.event.type === "completion"),
  );
  const reservedTerminalBytes = pending.reduce(
    (total, record) =>
      total +
      managedControlTerminalBytes +
      (records.some((entry) => entry.turnId === record.turnId && entry.event.type === "settled")
        ? 0
        : managedChildTerminalBytes),
    0,
  );
  const usedBytes = storedRecordBytes(records) + childBytes;
  return {
    ceiling,
    usedBytes,
    reservedTerminalBytes,
    availableBytes: Math.max(0, ceiling - usedBytes - reservedTerminalBytes),
  };
}
