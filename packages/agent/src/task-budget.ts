import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionRecord } from "./session-store.js";

const tokens = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const taskBudgetSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ version: z.literal(1), mode: z.literal("unbudgeted") }),
    z.strictObject({
      version: z.literal(1),
      mode: z.literal("limited"),
      taskId: digest,
      grants: z
        .array(z.strictObject({ id: digest, tokens: tokens.positive() }))
        .min(1)
        .max(16),
    }),
  ])
  .refine(
    (policy) =>
      policy.mode === "unbudgeted" ||
      (new Set(policy.grants.map((grant) => grant.id)).size === policy.grants.length &&
        Number.isSafeInteger(policy.grants.reduce((sum, grant) => sum + grant.tokens, 0))),
    "Task grants must be unique and have a safe total.",
  );
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const taskProviderEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("provider_reserved"),
    requestId: z.uuid(),
    purpose: z.enum(["ordinary", "compaction"]),
    estimatedInput: tokens,
    maximumOutput: tokens.positive(),
    source: z.strictObject({ sequence: tokens.positive(), digest }),
  }),
  z.strictObject({
    type: z.literal("provider_usage"),
    requestId: z.uuid(),
    inputTokens: tokens,
    outputTokens: tokens,
    reasoningTokens: tokens,
  }),
  z.strictObject({ type: z.literal("provider_unknown"), requestId: z.uuid() }),
]);
export type TaskProviderEvent = z.infer<typeof taskProviderEventSchema>;

/** Shared accounting; each durable reservation represents one exact provider attempt. */
export function taskBudgetUsage(policy: TaskBudget, events: readonly TaskProviderEvent[]) {
  let knownUsed = 0;
  let outstandingReserved = 0;
  let unknownReserved = 0;
  let overrun = 0;
  const usages = new Map(
    events.flatMap((event) =>
      event.type === "provider_usage" ? [[event.requestId, event] as const] : [],
    ),
  );
  const unknown = new Set(
    events.flatMap((event) => (event.type === "provider_unknown" ? [event.requestId] : [])),
  );
  for (const event of events) {
    if (event.type !== "provider_reserved") continue;
    const usage = usages.get(event.requestId);
    const reserved = event.estimatedInput + event.maximumOutput;
    if (usage?.type === "provider_usage") {
      const used = usage.inputTokens + usage.outputTokens;
      knownUsed += used;
      overrun += Math.max(0, used - reserved);
    } else if (unknown.has(event.requestId)) {
      unknownReserved += reserved;
    } else outstandingReserved += reserved;
  }
  const ceiling =
    policy.mode === "unbudgeted"
      ? null
      : policy.grants.reduce((sum, grant) => sum + grant.tokens, 0);
  return {
    ceiling,
    knownUsed,
    outstandingReserved,
    unknownReserved,
    overrun,
    available:
      ceiling === null
        ? null
        : unknownReserved > 0
          ? 0
          : Math.max(0, ceiling - knownUsed - outstandingReserved),
  };
}

export function taskRequestMaximumOutput(
  policy: TaskBudget,
  events: readonly TaskProviderEvent[],
  estimatedInput: number,
  maximumOutput: number,
): number {
  const budget = taskBudgetUsage(policy, events);
  return budget.available === null
    ? maximumOutput
    : Math.max(0, Math.min(maximumOutput, budget.available - estimatedInput));
}

export function taskBudgetClosingAdvice(
  policy: TaskBudget,
  events: readonly TaskProviderEvent[],
  request: {
    readonly messages: unknown;
    readonly tools: unknown;
    readonly maximumOutputTokens: number;
  },
): { readonly closing: true; readonly summary: string } | undefined {
  const available = taskBudgetUsage(policy, events).available;
  if (
    available === null ||
    available <= 0 ||
    !events.some((event) => event.type === "provider_reserved")
  )
    return undefined;
  const estimatedInput = Math.ceil(
    Buffer.byteLength(
      JSON.stringify({ messages: request.messages, tools: request.tools }),
      "utf8",
    ) / 4,
  );
  if (available >= 2 * (estimatedInput + request.maximumOutputTokens)) return undefined;
  return {
    closing: true,
    summary: `Task budget closing request. At most ${available} shared task tokens remain. Return a concise report using evidence and artifact references already obtained. State what remains incomplete or unverified. Do not request more tools, invent evidence, or claim unfinished research is complete.`,
  };
}

export function addTaskBudgetGrant(
  policy: TaskBudget,
  amount: number,
  authorizationId: string,
): TaskBudget {
  if (policy.mode !== "limited")
    throw new TypeError("Only an explicitly budgeted task accepts additional tokens.");
  return taskBudgetSchema.parse({
    ...policy,
    grants: [...policy.grants, { id: authorizationId, tokens: amount }],
  });
}

export function taskBudgetContinues(
  previous: TaskBudget,
  next: TaskBudget,
  authorizationId?: string,
): boolean {
  if (previous.mode === "unbudgeted") return next.mode === "unbudgeted";
  if (next.mode !== "limited" || next.taskId !== previous.taskId) return false;
  if (
    !previous.grants.every(
      (grant, index) =>
        grant.id === next.grants[index]?.id && grant.tokens === next.grants[index]?.tokens,
    )
  )
    return false;
  return (
    next.grants.length === previous.grants.length ||
    (authorizationId !== undefined &&
      next.grants.length === previous.grants.length + 1 &&
      next.grants.at(-1)?.id === authorizationId)
  );
}

export function latestTaskBudget(policy: TaskBudget, policies: readonly TaskBudget[]): TaskBudget {
  if (policy.mode === "unbudgeted") return policy;
  return policies.reduce(
    (latest, candidate) =>
      taskBudgetContinues(latest, candidate) ||
      (candidate.mode === "limited" &&
        latest.mode === "limited" &&
        candidate.grants.length > latest.grants.length &&
        taskBudgetContinues(latest, candidate, candidate.grants.at(-1)?.id))
        ? candidate
        : latest,
    policy,
  );
}

export type TaskProviderReceipt = {
  readonly purpose: "ordinary" | "compaction";
  readonly source: { readonly sequence: number; readonly digest: string };
  readonly blocked: boolean;
};

function isDispatchedModelEvent(type: string): boolean {
  return (
    type === "model_usage" ||
    type === "model_message_completed" ||
    type === "model_reasoning_started" ||
    type === "model_reasoning_settled"
  );
}

/** Every v3 provider boundary has either a reservation or an explicit no-dispatch receipt. */
export function validateTaskProviderReceipts(
  childRecords: readonly SessionRecord[] | undefined,
  receipts: readonly TaskProviderReceipt[],
  allowPendingSource = false,
): boolean {
  const sources = new Map(childRecords?.map((record) => [record.sequence, record]));
  const seen = new Set<number>();
  const boundaries =
    childRecords?.filter(
      (record) =>
        record.schemaVersion === 3 &&
        (record.record.type === "provider_attempt_started" ||
          record.record.type === "context_compaction_started"),
    ) ?? [];
  const nextBoundary = new Map(
    boundaries.map((source, index) => [source.sequence, boundaries[index + 1]?.sequence]),
  );

  for (const receipt of receipts) {
    const source = sources.get(receipt.source.sequence);
    if (
      source?.schemaVersion !== 3 ||
      source.record.type !==
        (receipt.purpose === "ordinary"
          ? "provider_attempt_started"
          : "context_compaction_started") ||
      `sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}` !==
        receipt.source.digest ||
      seen.has(source.sequence)
    )
      return false;
    seen.add(source.sequence);
    if (
      receipt.blocked &&
      childRecords?.some((record) => {
        if (record.schemaVersion !== 3) return false;
        if (source.record.type === "provider_attempt_started") {
          if (record.record.type === "runtime_event") {
            const end = nextBoundary.get(source.sequence);
            return (
              record.sequence > source.sequence &&
              (end === undefined || record.sequence < end) &&
              record.record.runId === source.record.runId &&
              isDispatchedModelEvent(record.record.event.type)
            );
          }
          if (record.record.type === "provider_attempt_interrupted")
            return (
              record.record.runId === source.record.runId &&
              record.record.turn === source.record.turn &&
              record.record.attempt === source.record.attempt &&
              record.record.reason === "run_terminal" &&
              (record.record.partialOutput?.byteCount ?? 0) > 0
            );
          return (
            record.record.type === "model_response_completed" &&
            record.record.runId === source.record.runId &&
            record.record.turn === source.record.turn &&
            record.record.attempt === source.record.attempt
          );
        }
        return (
          source.record.type === "context_compaction_started" &&
          (record.record.type === "context_compaction_committed" ||
            record.record.type === "context_compaction_failed" ||
            record.record.type === "context_compaction_interrupted") &&
          record.record.attemptId === source.record.attemptId &&
          (record.record.type === "context_compaction_committed" ||
            (record.record.usage !== undefined && !("status" in record.record.usage)))
        );
      })
    )
      return false;
  }
  return (
    boundaries.every((source) => {
      if (seen.has(source.sequence)) return true;
      if (!allowPendingSource || source !== boundaries.at(-1) || source.schemaVersion !== 3)
        return false;
      return !childRecords?.some((record) => {
        if (record.schemaVersion !== 3 || record.sequence <= source.sequence) return false;
        if (source.record.type === "provider_attempt_started")
          return (
            ((record.record.type === "model_response_completed" ||
              record.record.type === "provider_attempt_interrupted") &&
              record.record.runId === source.record.runId &&
              record.record.turn === source.record.turn &&
              record.record.attempt === source.record.attempt) ||
            (record.record.type === "runtime_event" &&
              record.record.runId === source.record.runId &&
              isDispatchedModelEvent(record.record.event.type))
          );
        return (
          source.record.type === "context_compaction_started" &&
          (record.record.type === "context_compaction_committed" ||
            record.record.type === "context_compaction_failed" ||
            record.record.type === "context_compaction_interrupted") &&
          record.record.attemptId === source.record.attemptId
        );
      });
    }) &&
    (childRecords !== undefined || receipts.length === 0)
  );
}
