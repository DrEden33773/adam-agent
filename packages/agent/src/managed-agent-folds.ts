import type {
  ManagedAgentExport,
  ManagedControlIdentity,
  ManagedControlLink,
  ManagedControlOutcome,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";
import { agentExportFields, presentationAgentExportMaximumBytes } from "@adam-agent/presentation";
import { latestTaskBudget, taskBudgetContinues } from "./task-budget.js";

export type {
  ManagedControlIdentity,
  ManagedControlLink,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";

import { z } from "zod";
import { type ManagedAgentRecord, ManagedAgentStoreError } from "./managed-agent.js";
import { managedReviewPolicyDigest } from "./managed-review-policy.js";
import { promptContextRecordV1Schema, promptContextRecordV2Schema } from "./prompt-assembly.js";
import { agentRoleDefinitionSchema, agentRoleIdSchema } from "./role-catalog.js";
import {
  contextProfileSchema,
  modelTargetIdentitySchema,
  type SessionRecord,
  thinkingPolicySnapshotV1Schema,
} from "./session-store.js";
import { skillContextRecordV1Schema } from "./skills.js";

export const managedAliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}_-]+$/u);
const managedHandleSchema = z
  .string()
  .max(96)
  .regex(/^@[\p{L}\p{N}_-]+-[1-9]\d*$/u);
export const managedNameKey = (value: string): string =>
  value.replace(/^@/u, "").normalize("NFKC").toLocaleLowerCase();

export { managedControlDigest } from "./fleet-ledger.js";

import {
  type DelegationContext,
  type DelegationEnvelope,
  delegationContextSchema,
  delegationEnvelopeSchema,
  type FleetProviderEvent,
  fleetProviderEventSchema,
  managedControlDigest,
} from "./fleet-ledger.js";

import { inputResourceOccurrenceV1Schema } from "./input-resources.js";

export const managedControlFrozenSchema = z.strictObject({
  version: z.literal(1),
  review: z
    .strictObject({
      policyVersion: z.literal(1),
      policyDigest: z
        .templateLiteral(["sha256:", z.string()])
        .refine((value) => /^sha256:[a-f0-9]{64}$/u.test(value)),
      reviewRunId: z.uuid(),
      requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      evidence: z.strictObject({
        id: z.templateLiteral(["sha256:", z.string()]),
        byteCount: z
          .number()
          .int()
          .nonnegative()
          .max(13 * 1024 * 1024),
      }),
      maximumTokens: z.number().int().positive(),
      totalMilliseconds: z.number().int().positive().max(1_800_000),
    })
    .optional(),
  roleDefinition: agentRoleDefinitionSchema.optional(),
  parentBranchId: z.uuid(),
  targetIdentity: modelTargetIdentitySchema,
  contextProfile: contextProfileSchema,
  thinkingPolicy: thinkingPolicySnapshotV1Schema.optional(),
  promptContext: z.union([promptContextRecordV1Schema, promptContextRecordV2Schema]),
  skillContext: skillContextRecordV1Schema.optional(),
  inputResources: z.array(inputResourceOccurrenceV1Schema).max(8).optional(),
  artifactSources: z
    .array(
      z.strictObject({
        parentSessionId: z.uuid(),
        sequence: z.number().int().positive(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        occurrenceId: z.string().min(1).max(256),
      }),
    )
    .max(8)
    .optional(),
  parentRequest: z.string().max(64 * 1024),
  permissionEffects: z.union([
    z.tuple([]),
    z.tuple([z.literal("read")]),
    z.tuple([z.literal("read"), z.literal("network")]),
  ]),
  permissionNetworkCeiling: z.enum(["allow", "ask", "deny"]).optional(),
  permissionReadCeiling: z.enum(["allow", "ask", "deny"]),
});
export type ManagedControlFrozen = z.infer<typeof managedControlFrozenSchema>;

export type ManagedControlEvent =
  | {
      readonly type: "exported";
      readonly completion: ManagedControlLink;
      readonly fields: ManagedAgentExport["fields"];
      readonly artifact: ManagedAgentExport["artifact"];
    }
  | { readonly type: "seen" | "suppressed"; readonly completion: ManagedControlLink }
  | { readonly type: "admission_paused"; readonly reason: "plan" }
  | { readonly type: "suspend_requested" | "thread_closed" }
  | {
      readonly type: "child_report" | "parent_input_requested";
      readonly id: `sha256:${string}`;
      readonly text: string;
      readonly source: {
        readonly runId: string;
        readonly turn: number;
        readonly attempt: number;
        readonly callId: string;
      };
    }
  | {
      readonly type: "input_accepted";
      readonly inputId: string;
      readonly text: string;
      readonly mode: "cooperative" | "interrupt";
      readonly messageId: `sha256:${string}`;
    }
  | {
      readonly type: "input_delivered";
      readonly inputId: string;
      readonly childReceipt: ManagedControlLink;
    }
  | {
      readonly type: "input_undelivered";
      readonly inputId: string;
      readonly reason: "settled" | "cancelled" | "restart";
    }
  | FleetProviderEvent
  | {
      readonly type: "budget_blocked";
      readonly purpose?: "ordinary" | "compaction";
      readonly source?: { readonly sequence: number; readonly digest: string };
      readonly code: "fleet_budget_exhausted" | "fleet_estimator_overrun";
      readonly message: string;
    }
  | {
      readonly type: "capacity_wait";
      readonly reason: "permission" | "parent_input" | "capacity" | "plan";
      readonly requestId?: string;
    }
  | { readonly type: "capacity_acquired" }
  | {
      readonly type: "admitted";
      readonly role: string;
      readonly handle?: string;
      readonly alias?: string;
      readonly context?: DelegationContext;
      readonly skills?: readonly string[];
      readonly artifacts?: readonly string[];
      readonly description: string;
      readonly task: string;
      readonly lane?: "background" | "reserved";
      readonly batchId?: string;
      readonly inputId?: string;
      readonly frozen?: ManagedControlFrozen;
      readonly envelope?: DelegationEnvelope;
    }
  | { readonly type: "started"; readonly atUnixMilliseconds?: number }
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
  appendBatchNext(
    records: readonly Omit<ManagedControlRecord, "sequence">[],
  ): Promise<readonly ManagedControlRecord[]>;
};

const linkSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const boundedText = (maximum: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maximum);
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("admission_paused"), reason: z.literal("plan") }),
  z.strictObject({ type: z.enum(["suspend_requested", "thread_closed"]) }),
  z.strictObject({
    type: z.enum(["child_report", "parent_input_requested"]),
    id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    text: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text, "utf8") <= 8192),
    source: z.strictObject({
      runId: z.uuid(),
      turn: z.number().int().positive(),
      attempt: z.number().int().positive(),
      callId: z.string().min(1).max(256),
    }),
  }),
  ...fleetProviderEventSchema.options,
  z.strictObject({
    type: z.literal("input_accepted"),
    inputId: z.uuid(),
    text: z
      .string()
      .min(1)
      .refine((text) => Buffer.byteLength(text, "utf8") <= 8192),
    mode: z.enum(["cooperative", "interrupt"]),
    messageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    type: z.literal("input_delivered"),
    inputId: z.uuid(),
    childReceipt: linkSchema,
  }),
  z.strictObject({
    type: z.literal("input_undelivered"),
    inputId: z.uuid(),
    reason: z.enum(["settled", "cancelled", "restart"]),
  }),
  z.strictObject({
    type: z.literal("budget_blocked"),
    purpose: z.enum(["ordinary", "compaction"]).optional(),
    source: z
      .strictObject({
        sequence: z.number().int().positive(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      })
      .optional(),
    code: z.enum(["fleet_budget_exhausted", "fleet_estimator_overrun"]),
    message: z.string().min(1).max(1024),
  }),
  z.strictObject({
    type: z.literal("capacity_wait"),
    reason: z.enum(["permission", "parent_input", "capacity", "plan"]),
    requestId: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({ type: z.literal("capacity_acquired") }),
  z.strictObject({
    type: z.literal("admitted"),
    role: z.union([agentRoleIdSchema, z.literal("builtin:reviewer")]),
    handle: managedHandleSchema.optional(),
    alias: managedAliasSchema.optional(),
    context: delegationContextSchema.optional(),
    skills: z.array(z.string().min(1).max(512)).max(8).optional(),
    artifacts: z.array(z.string().min(1).max(256)).max(8).optional(),
    description: boundedText(256).refine((value) => value.length > 0 && !/\p{Cc}/u.test(value)),
    task: boundedText(16 * 1024).refine((value) => value.trim().length > 0),
    lane: z.enum(["background", "reserved"]).optional(),
    batchId: z.uuid().optional(),
    inputId: z.uuid().optional(),
    frozen: managedControlFrozenSchema.optional(),
    envelope: delegationEnvelopeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("exported"),
    completion: linkSchema,
    fields: z
      .array(z.enum(agentExportFields))
      .min(1)
      .max(agentExportFields.length)
      .refine((fields) => new Set(fields).size === fields.length),
    artifact: z.strictObject({
      id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      mediaType: z.literal("application/json"),
      byteCount: z.number().int().positive().max(presentationAgentExportMaximumBytes),
      source: z.literal("agent_export"),
    }),
  }),
  z.strictObject({ type: z.enum(["seen", "suppressed"]), completion: linkSchema }),
  z.strictObject({
    type: z.literal("started"),
    atUnixMilliseconds: z.number().int().nonnegative().optional(),
  }),
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
    atUnixMilliseconds: z.number().int().nonnegative().optional(),
    artifact: z
      .strictObject({
        id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        byteCount: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
        mediaType: z.literal("text/plain; charset=utf-8"),
      })
      .optional(),
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
      record.schemaVersion !== 3 &&
      (record.event.context !== undefined || record.event.skills !== undefined)
    )
      return invalid();
    const priorAdmission = threadRecords.findLast((entry) => entry.event.type === "admitted");
    const priorEnvelope =
      priorAdmission?.event.type === "admitted" ? priorAdmission.event.envelope : undefined;
    const envelope = record.event.envelope;
    // v3 scheduling semantics cannot be attached to a historical thread on replay.
    if (
      priorEnvelope !== undefined &&
      envelope !== undefined &&
      (priorEnvelope.version === 3 || envelope.version === 3) &&
      priorEnvelope.version !== envelope.version
    )
      return invalid();
    const taskBudget = record.event.envelope?.taskBudget;
    if (taskBudget !== undefined) {
      const priorBudget =
        priorAdmission?.event.type === "admitted"
          ? priorAdmission.event.envelope?.taskBudget
          : undefined;
      if (
        priorAdmission !== undefined
          ? priorBudget === undefined ||
            !taskBudgetContinues(
              latestTaskBudget(
                priorBudget,
                previous.flatMap((entry) =>
                  entry.event.type === "admitted" && entry.event.envelope?.taskBudget !== undefined
                    ? [entry.event.envelope.taskBudget]
                    : [],
                ),
              ),
              taskBudget,
              managedControlDigest(record.event.envelope?.origin),
            )
          : taskBudget.mode === "limited" &&
            record.event.frozen?.review === undefined &&
            (taskBudget.taskId !== managedControlDigest(record.event.envelope?.origin) ||
              taskBudget.grants.length !== 1 ||
              taskBudget.grants[0]?.id !== taskBudget.taskId)
      )
        return invalid();
    } else if (
      priorAdmission?.event.type === "admitted" &&
      priorAdmission.event.envelope?.taskBudget !== undefined
    )
      return invalid();
    const admittedInputId = record.event.inputId;
    const modern = [
      record.event.lane,
      record.event.batchId,
      record.event.frozen,
      record.event.envelope,
    ];
    if (
      (modern.some((value) => value !== undefined) &&
        modern.some((value) => value === undefined)) ||
      (record.event.inputId !== undefined &&
        (record.event.envelope === undefined ||
          previous.some((entry) => managedAcceptedInput(entry)?.inputId === admittedInputId)))
    )
      return invalid();

    if (
      turnRecords.length > 0 ||
      previous.some(
        (entry) =>
          entry.attemptId === record.attemptId || entry.childSessionId === record.childSessionId,
      )
    )
      return invalid();
    if (record.event.role === "builtin:reviewer") {
      const frozen = record.event.frozen;
      if (
        frozen?.review === undefined ||
        record.event.lane !== "reserved" ||
        record.event.envelope?.origin.id !== frozen.review.reviewRunId ||
        record.event.envelope.roles.length !== 1 ||
        record.event.envelope.roles[0] !== "builtin:reviewer" ||
        frozen.permissionEffects.length !== 0 ||
        frozen.skillContext !== undefined ||
        frozen.roleDefinition !== undefined ||
        frozen.inputResources !== undefined ||
        record.event.handle !== undefined ||
        record.event.alias !== undefined ||
        threadRecords.length !== 0
      )
        return invalid();
      if (
        previous.some(
          (entry) =>
            entry.event.type === "admitted" &&
            entry.event.frozen?.review?.reviewRunId === frozen.review?.reviewRunId,
        )
      )
        return invalid();
      if (
        frozen.review.policyDigest !==
        managedReviewPolicyDigest({
          maximumTokens: frozen.review.maximumTokens,
          totalMilliseconds: frozen.review.totalMilliseconds,
          targetIdentity: frozen.targetIdentity,
          contextProfile: frozen.contextProfile,
          ...(frozen.thinkingPolicy === undefined ? {} : { thinkingPolicy: frozen.thinkingPolicy }),
        })
      )
        return invalid();
    } else if (record.event.frozen?.review !== undefined) return invalid();
    const last = threadRecords.findLast(
      (entry) =>
        entry.event.type !== "provider_reserved" &&
        entry.event.type !== "provider_usage" &&
        entry.event.type !== "provider_unknown" &&
        entry.event.type !== "seen" &&
        entry.event.type !== "suppressed" &&
        entry.event.type !== "exported",
    );
    if (last !== undefined && last.event.type !== "completion" && last.event.type !== "consumed")
      return invalid();
    if (threadRecords.some((entry) => entry.event.type === "thread_closed")) return invalid();
    const first = threadRecords[0];
    if (record.event.handle !== undefined || record.event.alias !== undefined) {
      if (record.schemaVersion !== 3 || record.event.handle === undefined) return invalid();
      if (first === undefined) {
        const names = new Set(["main"]);
        for (const thread of foldManagedControl(previous, record.parentSessionId).threads) {
          if (thread.role === "builtin:reviewer") continue;
          names.add(managedNameKey(thread.handle));
          if (thread.alias !== undefined) names.add(managedNameKey(thread.alias));
        }
        for (const value of [record.event.handle, record.event.alias]) {
          if (value === undefined) continue;
          const key = managedNameKey(value);
          if (names.has(key)) return invalid();
          names.add(key);
        }
      }
    }
    if (
      first?.event.type === "admitted" &&
      (first.event.role !== record.event.role ||
        first.event.description !== record.event.description ||
        first.event.handle !== record.event.handle ||
        first.event.alias !== record.event.alias)
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
    if (record.event.type === "exported") {
      const event = record.event;
      const completion = turnRecords.find((entry) => entry.event.type === "completion");
      if (
        completion === undefined ||
        event.completion.sequence !== completion.sequence ||
        event.completion.digest !== managedControlDigest(completion) ||
        turnRecords.some(
          (entry) =>
            entry.event.type === "exported" && entry.event.artifact.id === event.artifact.id,
        )
      )
        return invalid();
      return record;
    }
    if (record.event.type === "seen" || record.event.type === "suppressed") {
      const completion = turnRecords.find((entry) => entry.event.type === "completion");
      if (
        completion === undefined ||
        record.event.completion.sequence !== completion.sequence ||
        record.event.completion.digest !== managedControlDigest(completion) ||
        turnRecords.some((entry) => entry.event.type === record.event.type) ||
        (record.event.type === "suppressed" &&
          turnRecords.some((entry) => entry.event.type === "consumed"))
      )
        return invalid();
      return record;
    }
    if (
      record.event.type === "admission_paused" ||
      record.event.type === "suspend_requested" ||
      record.event.type === "thread_closed"
    ) {
      if (
        record.event.type === "thread_closed"
          ? !turnRecords.some((entry) => entry.event.type === "completion") ||
            threadRecords.some((entry) => entry.event.type === "thread_closed")
          : turnRecords.some((entry) => entry.event.type === "outcome")
      )
        return invalid();
      return record;
    }
    if (record.event.type === "child_report" || record.event.type === "parent_input_requested") {
      if (
        turnRecords.some(
          (entry) =>
            entry.event.type === "outcome" ||
            ((entry.event.type === "child_report" ||
              entry.event.type === "parent_input_requested") &&
              (record.event.type === "child_report" ||
                record.event.type === "parent_input_requested") &&
              entry.event.id === record.event.id),
        )
      )
        return invalid();
      return record;
    }
    if (
      record.event.type === "input_accepted" ||
      record.event.type === "input_delivered" ||
      record.event.type === "input_undelivered"
    ) {
      const event = record.event;
      const input = previous.find(
        (entry) => managedAcceptedInput(entry)?.inputId === event.inputId,
      );
      if (event.type === "input_accepted") {
        if (
          input !== undefined ||
          !turnRecords.some((entry) => entry.event.type === "started") ||
          turnRecords.some((entry) => entry.event.type === "outcome")
        )
          return invalid();
      } else if (
        input?.turnId !== record.turnId ||
        previous.some(
          (entry) =>
            (entry.event.type === "input_delivered" || entry.event.type === "input_undelivered") &&
            entry.event.inputId === event.inputId,
        )
      )
        return invalid();
      return record;
    }
    if (
      record.event.type === "provider_reserved" ||
      record.event.type === "provider_usage" ||
      record.event.type === "provider_unknown"
    ) {
      const event = record.event;
      const reservation = previous.find(
        (entry) =>
          entry.event.type === "provider_reserved" && entry.event.requestId === event.requestId,
      );
      if (event.type === "provider_reserved") {
        if (
          reservation !== undefined ||
          !turnRecords.some((entry) => entry.event.type === "started") ||
          turnRecords.some((entry) => entry.event.type === "outcome")
        )
          return invalid();
      } else if (
        reservation?.turnId !== record.turnId ||
        previous.some(
          (entry) =>
            entry.event.type === event.type &&
            "requestId" in entry.event &&
            entry.event.requestId === event.requestId,
        ) ||
        (event.type === "provider_unknown" &&
          previous.some(
            (entry) =>
              entry.event.type === "provider_usage" && entry.event.requestId === event.requestId,
          ))
      )
        return invalid();
      return record;
    }
    if (
      record.event.type === "budget_blocked" ||
      record.event.type === "capacity_wait" ||
      record.event.type === "capacity_acquired"
    ) {
      if (
        !turnRecords.some((entry) => entry.event.type === "started") ||
        turnRecords.some((entry) => entry.event.type === "outcome")
      )
        return invalid();
      return record;
    }
    if (
      record.event.type !== "execution_progress" &&
      turnRecords.some((entry) => entry.event.type === record.event.type)
    )
      return invalid();
    const last = turnRecords.findLast(
      (entry) =>
        entry.event.type !== "admission_paused" &&
        entry.event.type !== "suspend_requested" &&
        entry.event.type !== "thread_closed" &&
        entry.event.type !== "child_report" &&
        entry.event.type !== "parent_input_requested" &&
        entry.event.type !== "input_accepted" &&
        entry.event.type !== "input_delivered" &&
        entry.event.type !== "input_undelivered" &&
        entry.event.type !== "capacity_wait" &&
        entry.event.type !== "capacity_acquired" &&
        entry.event.type !== "provider_reserved" &&
        entry.event.type !== "provider_usage" &&
        entry.event.type !== "provider_unknown" &&
        entry.event.type !== "budget_blocked" &&
        entry.event.type !== "seen" &&
        entry.event.type !== "suppressed" &&
        entry.event.type !== "exported",
    );
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
    if (
      event.type === "child_report" ||
      event.type === "parent_input_requested" ||
      event.type === "input_accepted" ||
      event.type === "input_delivered" ||
      event.type === "input_undelivered" ||
      event.type === "budget_blocked" ||
      event.type === "consumed" ||
      event.type === "seen" ||
      event.type === "suppressed" ||
      event.type === "exported" ||
      event.type === "provider_reserved" ||
      event.type === "provider_usage" ||
      event.type === "provider_unknown"
    )
      continue;
    if (event.type === "admitted") {
      const existing = threads.get(record.threadId);
      threads.set(record.threadId, {
        parentSessionId,
        ...(existing === undefined
          ? {}
          : { previousTurns: [...(existing.previousTurns ?? []), existing.turn] }),
        lifecycle: "open",
        displayName:
          event.role === "builtin:reviewer"
            ? "Reviewer"
            : (event.frozen?.roleDefinition?.name ?? "Explore"),
        handle:
          existing?.handle ??
          event.handle ??
          `@${event.role === "builtin:reviewer" ? "reviewer" : (event.frozen?.roleDefinition?.name.toLocaleLowerCase() ?? "explore")}-${threads.size + 1}`,
        ...(event.alias === undefined ? {} : { alias: event.alias }),
        residency: "live",
        threadId: record.threadId,
        role: event.role,
        description: event.description,
        turn: {
          turnId: record.turnId,
          admissionSequence: record.sequence,
          ...(event.envelope === undefined ? {} : { envelope: event.envelope }),
          attemptId: record.attemptId,
          childSessionId: record.childSessionId,
          phase: "starting",
          label: "Starting",
          recovery: "none",
          ...(event.frozen === undefined
            ? {}
            : {
                configuration: {
                  digest: managedControlDigest(event.frozen),
                  parentBranchId: event.frozen.parentBranchId,
                  targetId: event.frozen.targetIdentity.targetId,
                  thinking: event.frozen.thinkingPolicy?.effectiveLevelId ?? "default",
                  contextWindowTokens: event.frozen.contextProfile.contextWindowTokens,
                },
              }),
          health: "healthy",
          waitReason: "none",
          ownerPhase: "waiting",
          lastOutcome: "none",
          ...(event.lane === undefined
            ? {}
            : { phase: "queued" as const, label: "Queued", lane: event.lane }),
        },
      });
      continue;
    }
    const thread = threads.get(record.threadId);
    if (thread === undefined || thread.turn.turnId !== record.turnId)
      throw new Error("Invalid managed control history.");
    if (event.type === "completion" || event.type === "cancel_requested") continue;
    if (event.type === "admission_paused") {
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...thread.turn,
          phase: "waiting",
          waitReason: "plan",
          label: "Paused by current Plan policy",
        },
      });
      continue;
    }
    if (event.type === "thread_closed") {
      threads.set(record.threadId, { ...thread, lifecycle: "closed" });
      continue;
    }
    if (event.type === "suspend_requested") {
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...thread.turn,
          phase: "waiting",
          waitReason: "suspended",
          label: "Suspended · Resume or cancel",
        },
      });
      continue;
    }
    if (event.type === "capacity_wait" || event.type === "capacity_acquired") {
      const turn = { ...thread.turn };
      const question =
        event.type === "capacity_wait" && event.reason === "parent_input"
          ? records.find(
              (entry) =>
                entry.turnId === record.turnId &&
                entry.event.type === "parent_input_requested" &&
                entry.event.id === event.requestId,
            )
          : undefined;
      delete turn.attention;
      threads.set(record.threadId, {
        ...thread,
        turn: {
          ...turn,
          phase: event.type === "capacity_wait" ? "waiting" : "executing",
          waitReason: event.type === "capacity_wait" ? event.reason : "none",
          label:
            event.type === "capacity_acquired"
              ? "Running"
              : event.reason === "permission"
                ? "Waiting for permission"
                : event.reason === "parent_input"
                  ? "Waiting for you"
                  : event.reason === "plan"
                    ? "Paused by current Plan policy"
                    : "Waiting for capacity",
          ...(event.type === "capacity_wait" &&
          event.requestId !== undefined &&
          (event.reason === "permission" || event.reason === "parent_input")
            ? {
                attention: {
                  id: event.requestId,
                  kind: event.reason,
                  ...(question?.event.type === "parent_input_requested"
                    ? { question: question.event.text }
                    : {}),
                },
              }
            : {}),
          ...(turn.watchdog === undefined
            ? {}
            : {
                watchdog: {
                  ...turn.watchdog,
                  state: event.type === "capacity_wait" ? "stopped" : "running",
                },
              }),
        },
      });
      continue;
    }
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
        ...(event.type === "started"
          ? {
              hasStarted: true as const,
              ...(event.atUnixMilliseconds === undefined
                ? {}
                : { startedAtUnixMilliseconds: event.atUnixMilliseconds }),
            }
          : {}),
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
    exports: records.flatMap((record) =>
      record.parentSessionId === parentSessionId && record.event.type === "exported"
        ? [
            {
              parentSessionId,
              threadId: record.threadId,
              turnId: record.turnId,
              completion: record.event.completion,
              fields: record.event.fields,
              artifact: record.event.artifact,
            },
          ]
        : [],
    ),
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
          ...(records.some((entry) => entry.turnId === record.turnId && entry.event.type === "seen")
            ? { userSeen: true as const }
            : {}),
          consumption: records.some(
            (entry) => entry.turnId === record.turnId && entry.event.type === "consumed",
          )
            ? ("consumed" as const)
            : records.some(
                  (entry) => entry.turnId === record.turnId && entry.event.type === "suppressed",
                )
              ? ("suppressed" as const)
              : ("pending" as const),
        },
      ];
    }),
    status: "ready",
    parentSessionId,
    revision: records.at(-1)?.sequence ?? 0,
    threads: [...threads.values()].map((thread) => ({
      ...thread,
      inputs: records.flatMap((record) => {
        const event = managedAcceptedInput(record);
        if (record.threadId !== thread.threadId || event === undefined) return [];
        const terminal = records.find(
          (entry) =>
            (entry.event.type === "input_delivered" || entry.event.type === "input_undelivered") &&
            entry.event.inputId === event.inputId,
        );
        return [
          {
            id: event.inputId,
            turnId: record.turnId,
            status:
              terminal?.event.type === "input_delivered"
                ? ("delivered" as const)
                : terminal?.event.type === "input_undelivered"
                  ? ("undelivered" as const)
                  : ("accepted" as const),
            ...(terminal?.event.type === "input_undelivered"
              ? { reason: terminal.event.reason }
              : {}),
          },
        ];
      }),
    })),
  };
}

/** A newline-complete prefix is not a complete admission batch. Never expose partial grants. */
export function validateManagedControlBatches(records: readonly ManagedControlRecord[]): void {
  const batches = new Map<string, ManagedControlRecord[]>();
  for (const record of records) {
    if (record.event.type !== "admitted" || record.event.envelope === undefined) continue;
    const key = `${record.parentSessionId}:${record.event.envelope.id}`;
    const batch = batches.get(key) ?? [];
    batch.push(record);
    batches.set(key, batch);
  }
  for (const batch of batches.values()) {
    const first = batch[0];
    if (first?.event.type !== "admitted" || first.event.envelope === undefined)
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    const envelope = first.event.envelope;
    if (
      batch.length !== envelope.threads ||
      envelope.threads > envelope.running + envelope.queued ||
      batch.some(
        (record, index) =>
          record.sequence !== first.sequence + index ||
          record.event.type !== "admitted" ||
          record.event.batchId !== envelope.id ||
          managedControlDigest(record.event.envelope) !== managedControlDigest(envelope),
      )
    )
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
  }
}

export function managedAcceptedInput(
  record: ManagedControlRecord,
):
  | { readonly inputId: string; readonly text: string; readonly messageId?: `sha256:${string}` }
  | undefined {
  if (record.event.type === "input_accepted") return record.event;
  if (record.event.type === "admitted" && record.event.inputId !== undefined)
    return { inputId: record.event.inputId, text: record.event.task };
  return undefined;
}
