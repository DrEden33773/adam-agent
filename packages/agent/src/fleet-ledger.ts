import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ManagedDelegationContext, ManagedDelegationLimits } from "@adam-agent/presentation";
import { z } from "zod";
import type { ContextProfile } from "./context-profile.js";
import { backgroundCapacitySchema } from "./managed-agent-capacity.js";
import type { ManagedControlRecord } from "./managed-agent-folds.js";
import { agentRoleIdSchema } from "./role-catalog.js";
import {
  latestTaskBudget,
  type TaskBudget,
  taskBudgetSchema,
  taskBudgetUsage,
  taskProviderEventSchema,
} from "./task-budget.js";
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
const historicalFleetPolicySchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    background: z.strictObject({
      running: positive.max(4),
      queued: z.number().int().min(0).max(32),
    }),
    reserved: z.strictObject({ running: z.literal(1), queued: z.number().int().min(0).max(4) }),
    maximumAttempts: positive.max(4),
    threadTokens: positive.nullable(),
    batchTokens: positive.nullable(),
    sessionTokens: positive.nullable(),
    storageBytes: positive.max(32 * 1024 * 1024),
  })
  .refine(
    (policy) =>
      policy.version === 1
        ? policy.threadTokens !== null &&
          policy.batchTokens !== null &&
          policy.sessionTokens !== null
        : policy.threadTokens === null &&
          policy.batchTokens === null &&
          policy.sessionTokens === null,
    "Token policy fields must match their frozen version.",
  );
export const fleetPolicySchema = z.union([
  historicalFleetPolicySchema,
  z.strictObject({
    version: z.literal(3),
    background: z.strictObject({
      running: backgroundCapacitySchema,
      queued: z.literal("unlimited"),
    }),
    reserved: z.strictObject({ running: z.literal(1), queued: z.number().int().min(0).max(4) }),
    maximumAttempts: z.literal("unlimited"),
    threadTokens: z.null(),
    batchTokens: z.null(),
    sessionTokens: z.null(),
    storageBytes: positive.max(32 * 1024 * 1024),
  }),
]);
export type FleetPolicy = z.infer<typeof fleetPolicySchema>;
/** Unlimited is serialized explicitly; Infinity is only an arithmetic comparison bound. */
export function fleetLimit(value: number | "unlimited"): number {
  return value === "unlimited" ? Infinity : value;
}
export const delegationOriginSchema = z.strictObject({
  kind: z.enum(["main_run", "direct_request"]),
  id: z.uuid(),
  callId: z.string().min(1).max(512).optional(),
});
const delegationEnvelopeFields = z.strictObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  concurrency: z
    .discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("owner") }),
      z.strictObject({ mode: z.literal("limited"), running: positive.max(32) }),
    ])
    .optional(),
  taskBudget: taskBudgetSchema.optional(),
  id: z.uuid(),
  digest: z
    .templateLiteral(["sha256:", z.string()])
    .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
  origin: delegationOriginSchema,
  roles: z
    .array(z.union([agentRoleIdSchema, z.literal("builtin:reviewer")]))
    .min(1)
    .max(32),
  mode: z.enum(["background", "foreground"]),
  threads: positive.max(32),
  running: positive.max(32),
  queued: z.number().int().min(0).max(32),
  aggregateTokens: positive.nullable(),
  threadTokens: positive.nullable(),
  sessionTokens: positive.nullable(),
  context: z.enum(["task", "current_request", "selected_messages"]),
  skills: z.array(z.string().max(512)).max(64),
  policy: fleetPolicySchema,
  policyDigest: z
    .templateLiteral(["sha256:", z.string()])
    .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
});
export const delegationEnvelopeSchema = delegationEnvelopeFields.refine(
  (envelope) =>
    envelope.version === envelope.policy.version &&
    (envelope.version === 3
      ? envelope.concurrency !== undefined &&
        envelope.running <= envelope.threads &&
        (envelope.concurrency.mode === "limited"
          ? envelope.concurrency.running === envelope.running
          : envelope.mode === "background" &&
            envelope.running ===
              Math.min(fleetLimit(envelope.policy.background.running), envelope.threads))
      : envelope.concurrency === undefined && envelope.running <= 4) &&
    (envelope.version === 1
      ? envelope.taskBudget === undefined &&
        envelope.aggregateTokens !== null &&
        envelope.threadTokens !== null &&
        envelope.sessionTokens !== null
      : envelope.taskBudget !== undefined &&
        envelope.aggregateTokens === null &&
        envelope.threadTokens === null &&
        envelope.sessionTokens === null),
  "Delegation budget fields must match their frozen version.",
);
export type DelegationEnvelope = z.infer<typeof delegationEnvelopeSchema>;
const delegationLimitsSchema = delegationEnvelopeFields
  .pick({
    mode: true,
    running: true,
    queued: true,
    aggregateTokens: true,
    threadTokens: true,
    sessionTokens: true,
  })
  .partial()
  .extend({ budgetTokens: positive.nullable().optional() });
export const fleetProviderEventSchema = taskProviderEventSchema;
export type FleetProviderEvent = z.infer<typeof fleetProviderEventSchema>;
export type FleetUsage = Omit<Extract<FleetProviderEvent, { type: "provider_usage" }>, "type">;

export function resolveFleetPolicy(profile: ContextProfile, input?: FleetPolicy): FleetPolicy {
  const policy = fleetPolicySchema.parse(
    input ?? {
      version: 3,
      background: { running: 8, queued: "unlimited" },
      reserved: { running: 1, queued: 4 },
      maximumAttempts: "unlimited",
      threadTokens: null,
      batchTokens: null,
      sessionTokens: null,
      storageBytes: 32 * 1024 * 1024,
    },
  );
  if (
    (policy.threadTokens !== null && policy.threadTokens > profile.contextWindowTokens) ||
    (policy.batchTokens !== null && policy.batchTokens > 4 * profile.contextWindowTokens) ||
    (policy.sessionTokens !== null && policy.sessionTokens > 16 * profile.contextWindowTokens)
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
    sessionTokens: number | null;
    availableTokens?: number | null;
    threadTokens?: number | null;
    taskBudget?: TaskBudget;
    roles?: DelegationEnvelope["roles"];
    context?: DelegationEnvelope["context"];
    skills?: readonly string[];
    limits?: ManagedDelegationLimits;
  },
): DelegationEnvelope {
  const lane = input.mode === "background" ? policy.background : policy.reserved;
  const { budgetTokens, ...limits } = delegationLimitsSchema.parse(input.limits ?? {});
  if (policy.version === 1 && budgetTokens !== undefined)
    throw new TypeError("Historical envelopes retain their original token policy.");
  const taskId = managedControlDigest(input.origin);
  const taskBudget: TaskBudget =
    budgetTokens === undefined
      ? (input.taskBudget ?? { version: 1, mode: "unbudgeted" })
      : budgetTokens === null
        ? { version: 1, mode: "unbudgeted" }
        : { version: 1, mode: "limited", taskId, grants: [{ id: taskId, tokens: budgetTokens }] };
  const value = {
    version: policy.version,
    ...(policy.version === 3
      ? {
          concurrency:
            limits.running === undefined && input.mode === "background"
              ? { mode: "owner" as const }
              : { mode: "limited" as const, running: limits.running ?? 1 },
        }
      : {}),
    ...(policy.version !== 1 ? { taskBudget } : {}),
    id: randomUUID(),
    origin: input.origin,
    roles: input.roles ?? ["builtin:explore"],
    mode: input.mode,
    threads: input.count,
    running: Math.min(fleetLimit(lane.running), input.count),
    queued: Math.max(
      0,
      input.count -
        (policy.version === 3 && limits.running !== undefined
          ? limits.running
          : fleetLimit(lane.running)),
    ),
    aggregateTokens: minimumTokenCeiling(
      policy.batchTokens,
      input.sessionTokens,
      input.availableTokens ?? input.sessionTokens,
    ),
    threadTokens: minimumTokenCeiling(
      policy.threadTokens,
      input.threadTokens ?? policy.threadTokens,
    ),
    sessionTokens: input.sessionTokens,
    context: input.context ?? "current_request",
    skills: [...(input.skills ?? [])],
    ...limits,
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
    !withinTokenCeiling(envelope.aggregateTokens, input.availableTokens ?? input.sessionTokens)
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
    readonly sessionTokens: number | null;
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
      fleetLimit(
        expected.policy[envelope.mode === "background" ? "background" : "reserved"].running,
      ) &&
    envelope.queued <=
      fleetLimit(
        expected.policy[envelope.mode === "background" ? "background" : "reserved"].queued,
      ) &&
    (envelope.mode !== "foreground" || envelope.threads === 1) &&
    withinTokenCeiling(envelope.aggregateTokens, expected.policy.batchTokens) &&
    withinTokenCeiling(envelope.aggregateTokens, envelope.sessionTokens) &&
    withinTokenCeiling(envelope.threadTokens, expected.policy.threadTokens) &&
    withinTokenCeiling(envelope.sessionTokens, expected.sessionTokens)
  );
}
export function fleetBudget(
  records: readonly ManagedControlRecord[],
  ceiling: number | null,
  select: (record: ManagedControlRecord) => boolean = () => true,
  live?: ReadonlySet<string>,
) {
  let knownUsed = 0;
  let outstandingReserved = 0;
  let unknownReserved = 0;
  let overrun = 0;
  const usages = new Map(
    records.flatMap((record) =>
      record.event.type === "provider_usage" ? [[record.event.requestId, record] as const] : [],
    ),
  );
  const unknown = new Set(
    records.flatMap((record) =>
      record.event.type === "provider_unknown" ? [record.event.requestId] : [],
    ),
  );
  for (const record of records) {
    if (record.event.type !== "provider_reserved" || !select(record)) continue;
    const reservation = record.event;
    const settled = usages.get(reservation.requestId);
    const reserved = reservation.estimatedInput + reservation.maximumOutput;
    if (settled?.event.type === "provider_usage") {
      const used = settled.event.inputTokens + settled.event.outputTokens;
      knownUsed += used;
      overrun += Math.max(0, used - reserved);
    } else if (
      (live !== undefined && !live.has(record.turnId)) ||
      unknown.has(reservation.requestId)
    )
      unknownReserved += reserved;
    else outstandingReserved += reserved;
  }
  return {
    ceiling,
    knownUsed,
    outstandingReserved,
    unknownReserved,
    available:
      ceiling === null
        ? null
        : Math.max(0, ceiling - knownUsed - outstandingReserved - unknownReserved),
    overrun,
  };
}
export function fleetSessionCeiling(
  records: readonly ManagedControlRecord[],
  policy: FleetPolicy,
): number | null {
  if (policy.version !== 1) return null;
  const first = records.find(
    (entry) => entry.event.type === "admitted" && entry.event.envelope !== undefined,
  );
  return minimumTokenCeiling(
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
  if (envelope.version !== 1 && envelope.taskBudget !== undefined) {
    const budget = taskBudgetUsage(
      fleetTaskBudget(records, envelope.taskBudget),
      taskFleetEvents(records, admission),
    );
    if (budget.available !== null && budget.available !== null && budget.available < amount)
      throw new FleetBudgetError("fleet_budget_exhausted");
    return;
  }
  const first = records.find(
    (record) => record.threadId === admission.threadId && record.event.type === "admitted",
  );
  const initialThreadTokens =
    first?.event.type === "admitted"
      ? (first.event.envelope?.threadTokens ?? envelope.threadTokens)
      : envelope.threadTokens;
  const thread = fleetBudget(
    records,
    minimumTokenCeiling(
      initialThreadTokens,
      envelope.threadTokens,
      envelope.policy.threadTokens,
      policy.threadTokens,
    ),
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
    minimumTokenCeiling(envelope.aggregateTokens, envelope.policy.batchTokens, policy.batchTokens),
    (record) => batchTurns.has(record.turnId),
  );
  const session = fleetBudget(
    records,
    minimumTokenCeiling(fleetSessionCeiling(records, envelope.policy), policy.sessionTokens),
  );
  if ([thread, batch, session].some((budget) => budget.overrun > 0))
    throw new FleetBudgetError("fleet_estimator_overrun");
  if (
    [thread, batch, session].some(
      (budget) => budget.available !== null && budget.available < amount,
    )
  )
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

export function minimumTokenCeiling(...values: readonly (number | null)[]): number | null {
  const configured = values.filter((value): value is number => value !== null);
  return configured.length === 0 ? null : Math.min(...configured);
}
export function withinTokenCeiling(value: number | null, ceiling: number | null): boolean {
  return ceiling === null || (value !== null && value <= ceiling);
}
export function taskFleetEvents(
  records: readonly ManagedControlRecord[],
  admission: ManagedControlRecord,
): FleetProviderEvent[] {
  if (admission.event.type !== "admitted") return [];
  const taskBudget = admission.event.envelope?.taskBudget;
  const turns = new Set(
    records.flatMap((record) =>
      record.event.type === "admitted" &&
      (taskBudget?.mode === "limited"
        ? record.event.envelope?.taskBudget?.mode === "limited" &&
          record.event.envelope.taskBudget.taskId === taskBudget.taskId
        : record.threadId === admission.threadId)
        ? [record.turnId]
        : [],
    ),
  );
  return records.flatMap((record) =>
    turns.has(record.turnId) &&
    (record.event.type === "provider_reserved" ||
      record.event.type === "provider_usage" ||
      record.event.type === "provider_unknown")
      ? [record.event]
      : [],
  );
}

export function fleetTaskBudget(
  records: readonly ManagedControlRecord[],
  policy: TaskBudget,
): TaskBudget {
  return latestTaskBudget(
    policy,
    records.flatMap((record) =>
      record.event.type === "admitted" && record.event.envelope?.taskBudget !== undefined
        ? [record.event.envelope.taskBudget]
        : [],
    ),
  );
}
