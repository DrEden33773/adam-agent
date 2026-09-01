import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { AgentSession } from "./agent-session.js";
import type { ModelDriver, ModelMessage } from "./agent-session-contracts.js";
import type { ArtifactReference, ArtifactStore } from "./artifact-store.js";
import type { ContextProfile } from "./context-profile.js";
import { scoutManagedAgentProfileV1 } from "./managed-agent-profiles.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { ProjectExecutionRootClaim } from "./project-execution-domain.js";
import {
  assemblePromptMessagesV1,
  createPromptContextV1,
  digestPromptRequestV1,
  type PromptContextRecord,
} from "./prompt-assembly.js";
import { sessionDurableContext } from "./session-durable-context.js";
import { modelMessagesFromCompleteRecords } from "./session-history-replay.js";
import type { SessionRecord, SessionStore, SessionStoreDirectory } from "./session-store.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  createReadToolRegistry,
  type JsonValue,
  type PermissionPolicy,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

const maximumManagedAgentTaskBytes = 16 * 1024;
const maximumManagedAgentResultBytes = 16 * 1024;
const childLiveWorkspaceNotice =
  "This child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.";
const managedAgentTaskSchema = z.strictObject({
  task: z
    .string()
    .min(1)
    .refine((task) => Buffer.byteLength(task, "utf8") <= maximumManagedAgentTaskBytes),
});
const managedAgentA2SpawnSchema = managedAgentTaskSchema.extend({
  mode: z.enum(["foreground", "background"]).optional(),
});
const managedAgentListSchema = z.strictObject({
  status: z
    .enum([
      "active",
      "terminal",
      "running",
      "completed",
      "failed",
      "cancelled",
      "recovery_required",
      "inspection_required",
    ])
    .optional(),
  limit: z.number().int().min(1).max(8).optional(),
  cursor: z.string().min(1).max(256).optional(),
});
const managedAgentCancelSchema = z.strictObject({
  agentId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
const managedAgentWaitSchema = z.strictObject({
  agentIds: z.array(z.string().uuid()).min(1).max(2),
  until: z.enum(["any_terminal", "all_terminal"]).optional(),
});
const managedAgentFollowUpSchema = managedAgentTaskSchema.extend({
  agentId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
const targetIdentitySchema = z.strictObject({
  targetId: z.string().min(1).max(256),
  vendor: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  route: z.enum(["direct", "vercel-ai-gateway"]),
  upstreamProviderId: z.string().min(1).max(128).optional(),
  profileVersion: z.number().int().positive(),
  certification: z.enum(["certified", "experimental"]),
});
const thinkingPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestedLevelId: z.string().min(1).max(128),
  effectiveLevelId: z.string().min(1).max(128),
  capability: z.strictObject({
    id: z.string().min(1).max(256),
    version: z.literal(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  mapping: z.discriminatedUnion("thinkingType", [
    z.strictObject({
      requestPath: z.enum(["provider_options.deepseek", "reasoning.effort"]),
      thinkingType: z.literal("disabled"),
    }),
    z.strictObject({
      requestPath: z.enum(["provider_options.deepseek", "reasoning.effort"]),
      thinkingType: z.literal("enabled"),
      reasoningEffort: z.enum(["low", "high", "max"]),
    }),
  ]),
  reasoningArtifact: z.literal("provider_reasoning"),
});
const managedAgentTerminalOutputSchema = z.strictObject({
  agentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  profile: z.literal("scout.v1"),
  profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  status: z.literal("completed"),
  result: z.union([
    z.strictObject({ text: z.string() }),
    z.strictObject({
      artifact: z.strictObject({
        id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        mediaType: z.literal("text/plain; charset=utf-8"),
        byteCount: z.number().int().positive(),
      }),
    }),
  ]),
  targetIdentity: targetIdentitySchema,
  thinkingPolicy: thinkingPolicySchema.optional(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  }),
  cost: z.strictObject({ status: z.literal("unavailable") }),
  transcript: z.strictObject({
    sessionId: z.string().uuid(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
  }),
});

export type ManagedAgentRecord =
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_admitted";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly parentSessionId: string;
      readonly parentToolCallId: string;
      readonly parentRootId: string;
      readonly projectId: `sha256:${string}`;
      readonly profile: "scout.v1";
      readonly mode?: "foreground" | "background";
      readonly profileDigest: `sha256:${string}`;
      readonly limits: {
        readonly maximumTurns: 8;
        readonly maximumTokens: number;
        readonly maximumDeadlineMilliseconds: number;
      };
      readonly deadlineAtUnixMilliseconds?: number;
      readonly admittedAtUnixMilliseconds?: number;
      readonly resume?: {
        readonly sourceAttemptId: string;
        readonly sourceChildSessionId: string;
        readonly sourceTranscriptDigest: `sha256:${string}`;
        readonly replayMessagesDigest: `sha256:${string}`;
        readonly throughSequence: number;
      };
      readonly taskDigest: `sha256:${string}`;
      readonly childInputDigest: `sha256:${string}`;
      readonly targetIdentity: ModelTargetIdentity;
      readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
      readonly repository?: {
        readonly revision: number;
        readonly effectiveDigest: `sha256:${string}`;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_deadline_expired";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_cancel_requested";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "completed";
      readonly result:
        | { readonly text: string }
        | {
            readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount">;
          };
      readonly transcriptDigest: `sha256:${string}`;
      readonly throughSequence: number;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens: number;
      };
      readonly cost: { readonly status: "unavailable" };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "failed";
      readonly error: { readonly code: string; readonly message: string };
      readonly transcriptDigest?: `sha256:${string}`;
      readonly throughSequence?: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "cancelled";
      readonly reason: "caller";
      readonly transcriptDigest: `sha256:${string}`;
      readonly throughSequence: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "recovery_required";
      readonly recoveryPhase?: "pre_genesis" | "interrupted";
      readonly transcriptDigest?: `sha256:${string}`;
      readonly throughSequence?: number;
      readonly error: {
        readonly code: "managed_agent_recovery_required";
        readonly message: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_terminal";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly status: "inspection_required";
      readonly error: {
        readonly code: "managed_agent_inspection_required";
        readonly message: string;
      };
    };

type ManagedAgentRecordInput = ManagedAgentRecord extends infer RecordType
  ? RecordType extends ManagedAgentRecord
    ? Omit<RecordType, "schemaVersion" | "sequence">
    : never
  : never;

export type ManagedAgentStore = {
  append(record: ManagedAgentRecord): Promise<void>;
  read(): Promise<readonly ManagedAgentRecord[]>;
};

export class ManagedAgentStoreError extends Error {
  readonly code: "managed_agent_log_invalid" | "managed_agent_log_too_large";

  constructor(code: ManagedAgentStoreError["code"]) {
    super(
      code === "managed_agent_log_too_large"
        ? "The Managed Agent lifecycle log exceeds its bound."
        : "The Managed Agent lifecycle log is invalid.",
    );
    this.name = "ManagedAgentStoreError";
    this.code = code;
  }
}

const managedAgentRecordSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_cancel_requested"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_deadline_expired"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_admitted"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    parentSessionId: z.uuid(),
    parentToolCallId: z.string().min(1).max(256),
    parentRootId: z.string().min(1).max(256),
    projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    profile: z.literal("scout.v1"),
    mode: z.enum(["foreground", "background"]).optional(),
    profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    limits: z.strictObject({
      maximumTurns: z.literal(8),
      maximumTokens: z.number().int().positive().max(128_000),
      maximumDeadlineMilliseconds: z.number().int().positive().max(600_000),
    }),
    deadlineAtUnixMilliseconds: z.number().int().nonnegative().safe().optional(),
    admittedAtUnixMilliseconds: z.number().int().nonnegative().safe().optional(),
    resume: z
      .strictObject({
        sourceAttemptId: z.uuid(),
        sourceChildSessionId: z.uuid(),
        sourceTranscriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        replayMessagesDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        throughSequence: z.number().int().nonnegative(),
      })
      .optional(),
    taskDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    childInputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    targetIdentity: targetIdentitySchema,
    thinkingPolicy: thinkingPolicySchema.optional(),
    repository: z
      .strictObject({
        revision: z.number().int().positive(),
        effectiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("completed"),
    result: z.union([
      z.strictObject({
        text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 16 * 1024),
      }),
      z.strictObject({
        artifact: z.strictObject({
          id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          mediaType: z.literal("text/plain; charset=utf-8"),
          byteCount: z.number().int().positive(),
        }),
      }),
    ]),
    transcriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative(),
    }),
    cost: z.strictObject({ status: z.literal("unavailable") }),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("failed"),
    error: z.strictObject({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4_096),
    }),
    transcriptDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    throughSequence: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("cancelled"),
    reason: z.literal("caller"),
    transcriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    throughSequence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("recovery_required"),
    recoveryPhase: z.enum(["pre_genesis", "interrupted"]).optional(),
    transcriptDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    throughSequence: z.number().int().nonnegative().optional(),
    error: z.strictObject({
      code: z.literal("managed_agent_recovery_required"),
      message: z.string().min(1).max(4_096),
    }),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_terminal"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    status: z.literal("inspection_required"),
    error: z.strictObject({
      code: z.literal("managed_agent_inspection_required"),
      message: z.string().min(1).max(4_096),
    }),
  }),
]) as z.ZodType<ManagedAgentRecord>;

const maximumManagedAgentRecordBytes = 1024 * 1024;

export async function recoverInterruptedManagedAgents(
  store: ManagedAgentStore,
  childSessionStores?: SessionStoreDirectory<SessionRecord>,
  artifactStore?: ArtifactStore,
  parentSessionId?: string,
  now: () => number = Date.now,
): Promise<void> {
  let records = await store.read();
  const terminalAttempts = new Set(
    records.flatMap((record) =>
      record.type === "managed_agent_terminal" ? [record.attemptId] : [],
    ),
  );
  for (const admission of records) {
    if (
      admission.type !== "managed_agent_admitted" ||
      terminalAttempts.has(admission.attemptId) ||
      (parentSessionId !== undefined && admission.parentSessionId !== parentSessionId)
    ) {
      continue;
    }
    const childStore = await childSessionStores?.open(admission.childSessionId);
    const childRecords = await childStore?.read();
    const genesis = childRecords?.[0];
    const repository =
      genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
        ? genesis.record.promptContext?.repository
        : undefined;
    const expectedPromptContext =
      repository === undefined
        ? undefined
        : createPromptContextV1(
            createReadToolRegistry({ workspaceRoot: process.cwd() }),
            repository,
          );
    const logicalRun = childRecords?.find(
      (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
    );
    const validAdmissionIdentity =
      admission.parentRootId === `session:${admission.parentSessionId}` &&
      admission.profile === "scout.v1" &&
      admission.profileDigest === scoutManagedAgentProfileV1.digest &&
      admission.limits.maximumTurns === scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt &&
      admission.limits.maximumTokens <= scoutManagedAgentProfileV1.limits.maximumCumulativeTokens &&
      admission.limits.maximumDeadlineMilliseconds <=
        scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds &&
      ((admission.mode === undefined &&
        admission.admittedAtUnixMilliseconds === undefined &&
        admission.deadlineAtUnixMilliseconds === undefined) ||
        (admission.mode !== undefined &&
          admission.admittedAtUnixMilliseconds !== undefined &&
          admission.deadlineAtUnixMilliseconds !== undefined &&
          admission.deadlineAtUnixMilliseconds - admission.admittedAtUnixMilliseconds ===
            admission.limits.maximumDeadlineMilliseconds));
    let validResume = admission.resume === undefined;
    let resumedMessages: readonly ModelMessage[] = [];
    if (admission.resume !== undefined && childSessionStores !== undefined) {
      const sourceAdmission = records.find(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.attemptId === admission.resume?.sourceAttemptId &&
          record.childSessionId === admission.resume.sourceChildSessionId &&
          record.agentId === admission.agentId,
      );
      const sourceTerminal = records.find(
        (record) =>
          record.type === "managed_agent_terminal" &&
          record.attemptId === admission.resume?.sourceAttemptId,
      );
      const sourceStore = await childSessionStores.open(admission.resume.sourceChildSessionId);
      const sourceRecords = await sourceStore?.read();
      const boundary = managedReplayBoundary(sourceRecords ?? []);
      const sourceAdmissions = records.flatMap((record) =>
        record.type === "managed_agent_admitted" &&
        record.parentSessionId === admission.parentSessionId &&
        record.agentId === admission.agentId &&
        record.sequence < admission.sequence
          ? [record]
          : [],
      );
      const sourceHistories = await Promise.all(
        sourceAdmissions.map((source) =>
          managedAttemptHistory(source, records, childSessionStores),
        ),
      );
      const cumulativeTokens = sourceHistories.reduce(
        (total, history) =>
          total +
          history.usage.inputTokens +
          history.usage.outputTokens +
          history.usage.reasoningTokens,
        0,
      );
      const sourceTranscriptDigest = digest(JSON.stringify(sourceRecords ?? []));
      const sourceThroughSequence = sourceRecords?.at(-1)?.sequence ?? 0;
      const validSourceTerminalLink =
        sourceTerminal === undefined ||
        !("transcriptDigest" in sourceTerminal) ||
        sourceTerminal.transcriptDigest === undefined ||
        (sourceTerminal.transcriptDigest === sourceTranscriptDigest &&
          "throughSequence" in sourceTerminal &&
          sourceTerminal.throughSequence === sourceThroughSequence);
      validResume =
        sourceAdmission !== undefined &&
        sourceTerminal !== undefined &&
        sourceTerminal.type === "managed_agent_terminal" &&
        sourceTerminal.status !== "inspection_required" &&
        (sourceRecords !== undefined ||
          (sourceTerminal.status === "recovery_required" &&
            sourceTerminal.recoveryPhase === "pre_genesis")) &&
        sourceTranscriptDigest === admission.resume.sourceTranscriptDigest &&
        boundary.digest === admission.resume.replayMessagesDigest &&
        boundary.throughSequence === admission.resume.throughSequence &&
        sourceHistories.every((history) => history.valid) &&
        validSourceTerminalLink &&
        admission.limits.maximumTokens ===
          scoutManagedAgentProfileV1.limits.maximumCumulativeTokens - cumulativeTokens;
      resumedMessages = boundary.messages;
    }
    const providerAttempt = childRecords?.find(
      (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
    );
    const currentMessages =
      childRecords === undefined
        ? []
        : modelMessagesFromCompleteRecords(
            providerAttempt === undefined
              ? childRecords
              : childRecords.filter((record) => record.sequence < providerAttempt.sequence),
          );
    const expectedResumedPrompt =
      expectedPromptContext === undefined
        ? undefined
        : assemblePromptMessagesV1(
            [
              {
                role: "developer",
                content:
                  "Managed child profile scout.v1. Work only on the exact delegated task. Use repository reads only. Do not write, execute, use Web or MCP, select Skills, access extensions, spawn, coordinate with peers, or change model and permission authority.",
              },
              ...resumedMessages,
              ...currentMessages,
            ],
            expectedPromptContext,
          );
    const validResumeProjection =
      admission.resume === undefined ||
      providerAttempt === undefined ||
      (providerAttempt.schemaVersion === 3 &&
        providerAttempt.record.type === "provider_attempt_started" &&
        providerAttempt.record.promptProjection !== undefined &&
        expectedResumedPrompt !== undefined &&
        providerAttempt.record.promptProjection.requestProjectionDigest ===
          digestPromptRequestV1(
            expectedResumedPrompt,
            expectedPromptContext?.toolProfile.definitions.map(({ definition }) => definition) ??
              [],
          ));
    const validGenesisIdentity =
      genesis?.schemaVersion === 3 &&
      genesis.record.type === "session_genesis" &&
      genesis.record.sessionId === admission.childSessionId &&
      genesis.record.projectId === admission.projectId &&
      isDeepStrictEqual(genesis.record.targetIdentity, admission.targetIdentity) &&
      isDeepStrictEqual(genesis.record.promptContext, expectedPromptContext) &&
      admission.profileDigest === scoutManagedAgentProfileV1.digest &&
      admission.limits.maximumTurns === scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt &&
      admission.limits.maximumTokens <= scoutManagedAgentProfileV1.limits.maximumCumulativeTokens &&
      admission.limits.maximumDeadlineMilliseconds <=
        scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds &&
      admission.parentRootId === `session:${admission.parentSessionId}` &&
      validResumeProjection &&
      (admission.repository === undefined
        ? repository?.sources.length === 0
        : repository?.revision === admission.repository.revision &&
          repository.effectiveDigest === admission.repository.effectiveDigest);
    if (!validAdmissionIdentity || !validResume) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "inspection_required",
        error: {
          code: "managed_agent_inspection_required",
          message: !validAdmissionIdentity
            ? "The durable Managed Agent admission identity is invalid."
            : "The durable follow-up boundary does not match its source child transcript.",
        },
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    if (childRecords !== undefined && !validGenesisIdentity) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "inspection_required",
        error: {
          code: "managed_agent_inspection_required",
          message: "The durable child identity does not match its Managed Agent admission.",
        },
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    const deadlineRecord = records.find(
      (record) =>
        record.type === "managed_agent_deadline_expired" &&
        record.attemptId === admission.attemptId,
    );
    if (
      deadlineRecord !== undefined ||
      (admission.deadlineAtUnixMilliseconds !== undefined &&
        admission.deadlineAtUnixMilliseconds <= now())
    ) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "failed",
        error: {
          code: "managed_agent_deadline_exceeded",
          message: "The foreground scout exceeded its aggregate deadline.",
        },
        ...(childRecords === undefined
          ? {}
          : {
              transcriptDigest: digest(JSON.stringify(childRecords)),
              throughSequence: childRecords.at(-1)?.sequence ?? 0,
            }),
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    const validRunIdentity =
      logicalRun?.schemaVersion === 3 &&
      logicalRun.record.type === "logical_run_started" &&
      digest(logicalRun.record.userMessage) === admission.childInputDigest &&
      isDeepStrictEqual(logicalRun.record.thinkingPolicy, admission.thinkingPolicy) &&
      isDeepStrictEqual(logicalRun.record.limits, {
        maxTurns: admission.limits.maximumTurns,
        maxTokens: admission.limits.maximumTokens,
      });
    if (childRecords !== undefined && !validRunIdentity) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "inspection_required",
        error: {
          code: "managed_agent_inspection_required",
          message: "The durable child run does not match its Managed Agent admission.",
        },
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    if (childRecords === undefined) {
      const terminal: ManagedAgentRecord = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "recovery_required",
        recoveryPhase: "pre_genesis",
        error: {
          code: "managed_agent_recovery_required",
          message:
            "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
        },
      };
      await store.append(terminal);
      records = [...records, terminal];
      terminalAttempts.add(admission.attemptId);
      continue;
    }
    const childSettlement = childRecords
      ?.flatMap((record) =>
        record.schemaVersion === 1 || record.schemaVersion === 2
          ? [record.event]
          : record.record.type === "runtime_event"
            ? [record.record.event]
            : [],
      )
      .findLast((event) => event.type === "session_settled");
    const transcriptDigest = digest(JSON.stringify(childRecords));
    const throughSequence = childRecords?.at(-1)?.sequence ?? 0;
    const usage = usageFromChildRecords(childRecords ?? []);
    let terminal: ManagedAgentRecord | undefined;
    if (childSettlement?.type === "session_settled") {
      if (childSettlement.result.status === "completed") {
        const answerBytes = Buffer.from(childSettlement.result.answer, "utf8");
        const inlineResult = { text: childSettlement.result.answer } as const;
        const inlineEnvelopeBytes = Buffer.byteLength(
          JSON.stringify({
            agentId: admission.agentId,
            attemptId: admission.attemptId,
            profile: "scout.v1",
            profileDigest: admission.profileDigest,
            status: "completed",
            result: inlineResult,
            targetIdentity: admission.targetIdentity,
            ...(admission.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: admission.thinkingPolicy }),
            transcript: {
              sessionId: admission.childSessionId,
              digest: transcriptDigest,
              throughSequence,
            },
            usage,
            cost: { status: "unavailable" },
          }),
          "utf8",
        );
        const recoveredResult =
          inlineEnvelopeBytes <= maximumManagedAgentResultBytes
            ? inlineResult
            : artifactStore === undefined
              ? undefined
              : {
                  artifact: await artifactStore
                    .write({
                      bytes: answerBytes,
                      mediaType: "text/plain; charset=utf-8",
                      source: {
                        type: "managed_agent_result",
                        schemaVersion: 1,
                        agentId: admission.agentId,
                        attemptId: admission.attemptId,
                        childSessionId: admission.childSessionId,
                        totalBytes: answerBytes.byteLength,
                      },
                    })
                    .then(({ id, mediaType, byteCount }) => ({ id, mediaType, byteCount })),
                };
        if (recoveredResult !== undefined) {
          terminal = {
            schemaVersion: 1,
            type: "managed_agent_terminal",
            sequence: records.length + 1,
            agentId: admission.agentId,
            attemptId: admission.attemptId,
            childSessionId: admission.childSessionId,
            status: "completed",
            result: recoveredResult,
            transcriptDigest,
            throughSequence,
            usage,
            cost: { status: "unavailable" },
          };
        }
      } else if (childSettlement.result.status === "cancelled") {
        terminal = {
          schemaVersion: 1,
          type: "managed_agent_terminal",
          sequence: records.length + 1,
          agentId: admission.agentId,
          attemptId: admission.attemptId,
          childSessionId: admission.childSessionId,
          status: "cancelled",
          reason: "caller",
          transcriptDigest,
          throughSequence,
        };
      } else {
        const error =
          childSettlement.result.status === "failed"
            ? childSettlement.result.error
            : {
                code: "model_output_truncated",
                message: "The foreground scout reached its output limit.",
              };
        terminal = {
          schemaVersion: 1,
          type: "managed_agent_terminal",
          sequence: records.length + 1,
          agentId: admission.agentId,
          attemptId: admission.attemptId,
          childSessionId: admission.childSessionId,
          status: "failed",
          error: { code: error.code, message: error.message.slice(0, 4_096) },
          transcriptDigest,
          throughSequence,
        };
      }
    }
    if (terminal === undefined) {
      terminal = {
        schemaVersion: 1,
        type: "managed_agent_terminal",
        sequence: records.length + 1,
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        childSessionId: admission.childSessionId,
        status: "recovery_required",
        recoveryPhase: "interrupted",
        transcriptDigest,
        throughSequence,
        error: {
          code: "managed_agent_recovery_required",
          message:
            "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
        },
      };
    }
    await store.append(terminal);
    records = [...records, terminal];
    terminalAttempts.add(admission.attemptId);
  }
}

export function validateManagedAgentRecord(
  input: unknown,
  history: readonly ManagedAgentRecord[],
): {
  readonly byteLength: number;
  readonly record: ManagedAgentRecord;
  readonly serialized: string;
} {
  const parsed = managedAgentRecordSchema.safeParse(input);
  if (!parsed.success || parsed.data.sequence !== history.length + 1) {
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
  }
  const candidate = parsed.data;
  if (candidate.type === "managed_agent_admitted") {
    const previousAdmissions = history.flatMap((record) =>
      record.type === "managed_agent_admitted" && record.agentId === candidate.agentId
        ? [record]
        : [],
    );
    const previous = previousAdmissions.at(-1);
    const previousTerminal =
      previous === undefined
        ? undefined
        : history.find(
            (record) =>
              record.type === "managed_agent_terminal" && record.attemptId === previous.attemptId,
          );
    if (
      history.some(
        (record) =>
          record.attemptId === candidate.attemptId ||
          record.childSessionId === candidate.childSessionId,
      ) ||
      previousAdmissions.length >= 4 ||
      (previous === undefined) !== (candidate.resume === undefined) ||
      (previous !== undefined && candidate.mode !== "background") ||
      (previousTerminal?.type === "managed_agent_terminal" &&
        previousTerminal.status === "inspection_required") ||
      (previous !== undefined &&
        candidate.resume !== undefined &&
        (candidate.resume.sourceAttemptId !== previous.attemptId ||
          candidate.resume.sourceChildSessionId !== previous.childSessionId)) ||
      (previous !== undefined &&
        (previous.parentSessionId !== candidate.parentSessionId ||
          previous.parentRootId !== candidate.parentRootId ||
          previous.projectId !== candidate.projectId ||
          previous.profile !== candidate.profile ||
          previous.profileDigest !== candidate.profileDigest ||
          !isDeepStrictEqual(previous.targetIdentity, candidate.targetIdentity) ||
          !isDeepStrictEqual(previous.thinkingPolicy, candidate.thinkingPolicy) ||
          !isDeepStrictEqual(previous.repository, candidate.repository) ||
          candidate.limits.maximumTurns > previous.limits.maximumTurns ||
          candidate.limits.maximumTokens > previous.limits.maximumTokens ||
          candidate.limits.maximumDeadlineMilliseconds >
            previous.limits.maximumDeadlineMilliseconds ||
          candidate.deadlineAtUnixMilliseconds !== previous.deadlineAtUnixMilliseconds ||
          !history.some(
            (record) =>
              record.type === "managed_agent_terminal" && record.attemptId === previous.attemptId,
          )))
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (
    candidate.type === "managed_agent_deadline_expired" ||
    candidate.type === "managed_agent_cancel_requested"
  ) {
    const admission = history.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === candidate.attemptId,
    );
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      (candidate.type === "managed_agent_cancel_requested" &&
        candidate.expectedRevision !==
          history.filter((record) => record.agentId === candidate.agentId).length) ||
      history.some(
        (record) =>
          (record.type === candidate.type || record.type === "managed_agent_terminal") &&
          record.attemptId === candidate.attemptId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else {
    const admission = history.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === candidate.attemptId,
    );
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      ) ||
      (candidate.status === "recovery_required" &&
        admission?.type === "managed_agent_admitted" &&
        admission.mode !== undefined &&
        !(
          (candidate.recoveryPhase === "pre_genesis" &&
            candidate.transcriptDigest === undefined &&
            candidate.throughSequence === undefined) ||
          (candidate.recoveryPhase === "interrupted" &&
            candidate.transcriptDigest !== undefined &&
            candidate.throughSequence !== undefined)
        ))
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  }
  const serialized = JSON.stringify(candidate);
  const byteLength = Buffer.byteLength(serialized, "utf8") + 1;
  if (byteLength > maximumManagedAgentRecordBytes) {
    throw new ManagedAgentStoreError("managed_agent_log_too_large");
  }
  return { byteLength, record: candidate, serialized };
}

export type ManagedAgentSummary = {
  readonly agentId: string;
  readonly attemptId: string;
  readonly profile: "scout.v1";
  readonly mode: "foreground" | "background";
  readonly status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "recovery_required"
    | "inspection_required";
  readonly revision: number;
  readonly result?:
    | { readonly text: string }
    | { readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount"> };
  readonly error?: { readonly code: string; readonly message: string };
  readonly resultByteCount?: number;
  readonly resultTruncated?: boolean;
};

export type ManagedAgentSnapshot = {
  readonly counts: { readonly active: number; readonly completed: number; readonly attention: 0 };
  readonly agents: readonly ManagedAgentSummary[];
};

export function managedAgentSnapshotFromRecords(
  records: readonly ManagedAgentRecord[],
  parentSessionId: string,
): ManagedAgentSnapshot {
  const admissions = records.flatMap((record) =>
    record.type === "managed_agent_admitted" && record.parentSessionId === parentSessionId
      ? [record]
      : [],
  );
  const latestAdmissions = [...admissions]
    .reverse()
    .filter(
      (admission, index, entries) =>
        entries.findIndex((candidate) => candidate.agentId === admission.agentId) === index,
    )
    .reverse();
  const agents: ManagedAgentSummary[] = latestAdmissions.map((admission) => {
    const revision = records.filter((record) => record.agentId === admission.agentId).length;
    const terminal = records.find(
      (record) =>
        record.type === "managed_agent_terminal" && record.attemptId === admission.attemptId,
    );
    return {
      agentId: admission.agentId,
      attemptId: admission.attemptId,
      profile: admission.profile,
      mode: admission.mode ?? "foreground",
      status: terminal?.type === "managed_agent_terminal" ? terminal.status : "running",
      revision,
      ...(terminal?.type !== "managed_agent_terminal" || terminal.status !== "completed"
        ? {}
        : { result: terminal.result }),
      ...(terminal?.type !== "managed_agent_terminal" ||
      terminal.status === "completed" ||
      terminal.status === "cancelled"
        ? {}
        : { error: terminal.error }),
    };
  });
  return {
    counts: {
      active: agents.filter((agent) => agent.status === "running").length,
      completed: agents.filter((agent) => agent.status !== "running").length,
      attention: 0,
    },
    agents,
  };
}

function boundedManagedAgentListAgents(
  agents: readonly ManagedAgentSummary[],
): readonly ManagedAgentSummary[] {
  const maximumTextBytes =
    agents.length === 1 ? Number.POSITIVE_INFINITY : Math.floor((10 * 1024) / agents.length);
  return agents.map((agent) => {
    const boundedAgent =
      agent.error === undefined
        ? agent
        : {
            ...agent,
            error: { ...agent.error, message: boundedUtf8Prefix(agent.error.message, 512) },
          };
    const text =
      boundedAgent.result !== undefined && "text" in boundedAgent.result
        ? boundedAgent.result.text
        : undefined;
    if (text === undefined) {
      return boundedAgent;
    }
    const byteCount = Buffer.byteLength(text, "utf8");
    if (byteCount <= maximumTextBytes) {
      return { ...boundedAgent, resultByteCount: byteCount, resultTruncated: false };
    }
    return {
      ...boundedAgent,
      result: { text: boundedUtf8Prefix(text, maximumTextBytes) },
      resultByteCount: byteCount,
      resultTruncated: true,
    };
  });
}

export type AgentManager = {
  readonly parentRootId: string;
  readonly parentSessionId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  promptSummary(): string;
  snapshot(): Promise<ManagedAgentSnapshot>;
  rebindParentRoot(parentRoot: ProjectExecutionRootClaim): void;
  spawnForeground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
  }): Promise<ToolResult>;
  spawnBackground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
  }): Promise<ToolResult>;
  list(input?: {
    readonly status?: "active" | "terminal" | ManagedAgentSummary["status"];
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<ToolResult>;
  wait(input: {
    readonly agentIds: readonly string[];
    readonly until: "any_terminal" | "all_terminal";
    readonly signal: AbortSignal;
  }): Promise<ToolResult>;
  cancel(input: {
    readonly agentId: string;
    readonly expectedRevision: number;
  }): Promise<ToolResult>;
  followUp(input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
  }): Promise<ToolResult>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
};

export type ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): { cancel(): void };
};

const nodeManagedAgentDeadlineScheduler: ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds, onDeadline) {
    const timer = setTimeout(onDeadline, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export function createAgentManager(options: {
  readonly childContextProfile: ContextProfile;
  readonly childModel: ModelDriver;
  readonly artifactStore?: ArtifactStore;
  readonly childSessionStores: SessionStoreDirectory<SessionRecord>;
  readonly managedStore: ManagedAgentStore;
  readonly parentPermissions: PermissionPolicy;
  readonly deadlineScheduler?: ManagedAgentDeadlineScheduler;
  readonly closeDrainScheduler?: ManagedAgentDeadlineScheduler;
  readonly parentRoot: ProjectExecutionRootClaim;
  readonly parentSessionId?: string;
  readonly projectId: `sha256:${string}`;
  readonly repository?: PromptContextRecord["repository"];
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  readonly workspaceRoot: string;
  readonly now?: () => number;
}): AgentManager {
  let currentParentRoot = options.parentRoot;
  let boundParentSessionId = options.parentSessionId ?? "00000000-0000-4000-8000-000000000001";
  let appendQueue = Promise.resolve();
  const appendManagedRecord = async (input: ManagedAgentRecordInput): Promise<void> => {
    const operation = appendQueue.then(async () => {
      const records = await options.managedStore.read();
      await options.managedStore.append({
        ...input,
        schemaVersion: 1,
        sequence: records.length + 1,
      });
    });
    appendQueue = operation.catch(() => undefined);
    await operation;
  };
  type ForceManagedAgentRecovery = () => Promise<
    "forced" | "already_terminal" | "terminal_in_progress"
  >;
  type SpawnInput = {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
    readonly mode: "foreground" | "background";
    readonly agentId?: string;
    readonly revision?: number;
    readonly maximumTokens?: number;
    readonly maximumDeadlineMilliseconds?: number;
    readonly deadlineAtUnixMilliseconds?: number;
    readonly admittedAtUnixMilliseconds?: number;
    readonly resume?: Extract<
      ManagedAgentRecord,
      { readonly type: "managed_agent_admitted" }
    >["resume"];
    readonly resumedMessages?: readonly ModelMessage[];
    readonly onAdmitted?: (identity: {
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly forceRecovery: ForceManagedAgentRecovery;
    }) => void;
    readonly onManagerAdmitted?: (forceRecovery: ForceManagedAgentRecovery) => void;
  };
  const activeAttempts = new Map<
    string,
    {
      readonly attemptId: string;
      readonly controller: AbortController;
      readonly completion: Promise<ToolResult>;
      readonly forceRecovery: ForceManagedAgentRecovery;
      readonly revision: number;
      cancelPromise?: Promise<ToolResult>;
    }
  >();
  const pendingAdmissions = new Map<
    symbol,
    {
      readonly controller: AbortController;
      readonly completion: Promise<ToolResult>;
      forceRecovery?: ForceManagedAgentRecovery;
    }
  >();
  const knownAgentIds = new Set<string>();
  let reservedSlots = 0;
  let reservedNewIdentities = 0;
  let managerClosing = false;
  let managerClosePromise: Promise<void> | undefined;
  const reserveAdmission = (newIdentity: boolean): ToolResult | undefined => {
    if (managerClosing) {
      return toolFailure("managed_agent_unavailable", "The managed-child host is closing.");
    }
    if (activeAttempts.size + reservedSlots >= 2) {
      return toolFailure(
        "managed_agent_capacity_exceeded",
        "This project already owns the maximum two active managed children.",
      );
    }
    if (newIdentity && knownAgentIds.size + reservedNewIdentities >= 8) {
      return toolFailure(
        "managed_agent_capacity_exceeded",
        "This parent session already owns the maximum eight managed child identities.",
      );
    }
    reservedSlots += 1;
    if (newIdentity) {
      reservedNewIdentities += 1;
    }
    return undefined;
  };
  const releaseAdmissionReservation = (newIdentity: boolean): void => {
    reservedSlots -= 1;
    if (newIdentity) {
      reservedNewIdentities -= 1;
    }
  };
  const runAttempt = async (input: SpawnInput): Promise<ToolResult> => {
    if (
      options.parentSessionId === undefined &&
      boundParentSessionId === "00000000-0000-4000-8000-000000000001"
    ) {
      boundParentSessionId = input.parentSessionId;
    }
    if (input.parentSessionId !== boundParentSessionId) {
      return toolFailure(
        "managed_agent_unavailable",
        "The managed-child parent session does not match this host.",
      );
    }
    const existingAdmissions = (await options.managedStore.read()).filter(
      (record) =>
        record.type === "managed_agent_admitted" &&
        record.parentSessionId === input.parentSessionId,
    );
    if (
      input.agentId === undefined &&
      new Set(existingAdmissions.map((record) => record.agentId)).size >= 8
    ) {
      return toolFailure(
        "managed_agent_capacity_exceeded",
        "This parent session already owns the maximum eight managed child identities.",
      );
    }
    const agentId = input.agentId ?? randomUUID();
    const attemptId = randomUUID();
    const childSessionId = randomUUID();
    const taskDigest = digest(input.task);
    const maximumTokens =
      input.maximumTokens ?? scoutManagedAgentProfileV1.limits.maximumCumulativeTokens;
    const maximumDeadlineMilliseconds =
      input.maximumDeadlineMilliseconds ??
      scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds;
    const admittedAtUnixMilliseconds =
      input.admittedAtUnixMilliseconds ?? (options.now ?? Date.now)();
    const deadlineAtUnixMilliseconds =
      input.deadlineAtUnixMilliseconds ?? admittedAtUnixMilliseconds + maximumDeadlineMilliseconds;
    const childClaim = await currentParentRoot.claimChild({ childId: agentId });
    const childController = new AbortController();
    let deadlineExpired = false;
    let deadlineRequested = false;
    let deadlineOperation: Promise<void> | undefined;
    let admissionCommitted = false;
    let terminalCommitStarted = false;
    let terminalCommitted = false;
    let releaseChildClaim = true;
    let childClaimReleased = false;
    const releaseClaimOnce = async (): Promise<void> => {
      if (childClaimReleased) {
        return;
      }
      childClaimReleased = true;
      await childClaim.release();
    };
    const forceRecovery: ForceManagedAgentRecovery = async () => {
      if (terminalCommitted) {
        return "already_terminal";
      }
      if (!admissionCommitted || terminalCommitStarted) {
        return "terminal_in_progress";
      }
      terminalCommitStarted = true;
      const recoveryStore = await options.childSessionStores.open(childSessionId);
      const recoveryRecords = await recoveryStore?.read();
      await appendManagedRecord({
        type: "managed_agent_terminal",
        agentId,
        attemptId,
        childSessionId,
        status: "recovery_required",
        recoveryPhase: recoveryRecords === undefined ? "pre_genesis" : "interrupted",
        ...(recoveryRecords === undefined
          ? {}
          : {
              transcriptDigest: digest(JSON.stringify(recoveryRecords)),
              throughSequence: recoveryRecords.at(-1)?.sequence ?? 0,
            }),
        error: {
          code: "managed_agent_recovery_required",
          message:
            "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
        },
      });
      terminalCommitted = true;
      releaseChildClaim = false;
      await releaseClaimOnce();
      activeAttempts.delete(agentId);
      return "forced";
    };
    const commitDeadlineExpiration = (): Promise<void> => {
      if (terminalCommitStarted) {
        return Promise.resolve();
      }
      if (!admissionCommitted) {
        deadlineRequested = true;
        return Promise.resolve();
      }
      deadlineOperation ??= appendManagedRecord({
        type: "managed_agent_deadline_expired",
        agentId,
        attemptId,
        childSessionId,
      }).then(() => {
        deadlineExpired = true;
        childController.abort(new Error("Managed Agent deadline exceeded."));
      });
      return deadlineOperation;
    };
    const abortFromCaller = () => childController.abort(input.signal.reason);
    if (input.signal.aborted) {
      abortFromCaller();
    } else {
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const deadline = (options.deadlineScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
      maximumDeadlineMilliseconds,
      () => {
        void commitDeadlineExpiration().catch(() => {
          childController.abort(new Error("Managed Agent deadline persistence failed."));
        });
      },
    );
    try {
      await appendManagedRecord({
        type: "managed_agent_admitted",
        agentId,
        attemptId,
        childSessionId,
        parentSessionId: input.parentSessionId,
        parentToolCallId: input.callId,
        parentRootId: currentParentRoot.rootId,
        projectId: options.projectId,
        profile: "scout.v1",
        mode: input.mode,
        profileDigest: scoutManagedAgentProfileV1.digest,
        limits: {
          maximumTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
          maximumTokens,
          maximumDeadlineMilliseconds,
        },
        deadlineAtUnixMilliseconds,
        admittedAtUnixMilliseconds,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        taskDigest,
        childInputDigest: digest(childTaskMessage(input.task)),
        targetIdentity: options.targetIdentity,
        ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
        ...(options.repository === undefined
          ? {}
          : {
              repository: {
                revision: options.repository.revision,
                effectiveDigest: options.repository.effectiveDigest,
              },
            }),
      });
      admissionCommitted = true;
      input.onManagerAdmitted?.(forceRecovery);
      if (deadlineRequested) {
        await commitDeadlineExpiration();
      }
      const childStore = await options.childSessionStores.create(childSessionId);
      const childTools = createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
      const childPromptContext = createPromptContextV1(childTools, options.repository);
      await childStore.append({
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "session_genesis",
          recordVersion: 2,
          sessionId: childSessionId,
          projectId: options.projectId,
          targetIdentity: options.targetIdentity,
          contextProfile: options.childContextProfile,
          promptContext: childPromptContext,
        },
      });
      const initialMessages: ModelMessage[] = [
        {
          role: "developer",
          content:
            "Managed child profile scout.v1. Work only on the exact delegated task. Use repository reads only. Do not write, execute, use Web or MCP, select Skills, access extensions, spawn, coordinate with peers, or change model and permission authority.",
        },
        ...(input.resumedMessages ?? []),
      ];
      const childPermissions: PermissionPolicy = {
        decide(permission) {
          if (permission.effect !== "read") {
            return "deny";
          }
          return options.parentPermissions.decide(permission) === "allow" ? "allow" : "deny";
        },
      };
      const childDependencies = {
        contextProfile: options.childContextProfile,
        model: options.childModel,
        permissions: childPermissions,
        store: childStore as SessionStore,
        tools: childTools,
        [sessionDurableContext]: {
          initialMessages,
          nextSequence: 2,
          projectId: options.projectId,
          promptContext: childPromptContext,
          repositoryWorkspaceRoot: options.workspaceRoot,
          authorizeProjectContextLoad: async () => true,
          afterLogicalRunStarted: () => {
            input.onAdmitted?.({ agentId, attemptId, childSessionId, forceRecovery });
          },
          sessionId: childSessionId,
          targetIdentity: options.targetIdentity,
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
        },
      };
      const child = new AgentSession(childDependencies);
      const result = await child.run(
        {
          text: childTaskMessage(input.task),
        },
        {
          signal: childController.signal,
          limits: {
            maxTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
            maxTokens: maximumTokens,
          },
        },
      );
      if (terminalCommitted) {
        return toolFailure(
          "managed_agent_unavailable",
          "The child attempt was fenced as recovery-required during close.",
        );
      }
      const childRecords = await childStore.read();
      const transcriptDigest = digest(JSON.stringify(childRecords));
      const throughSequence = childRecords.at(-1)?.sequence ?? 0;
      const usage = usageFromChildRecords(childRecords);
      const settleExpiredDeadline = async (): Promise<boolean> => {
        await deadlineOperation;
        if (!deadlineExpired) {
          return false;
        }
        terminalCommitStarted = true;
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "failed",
          error: {
            code: "managed_agent_deadline_exceeded",
            message: "The foreground scout exceeded its aggregate deadline.",
          },
          transcriptDigest,
          throughSequence,
        });
        terminalCommitted = true;
        return true;
      };
      if (await settleExpiredDeadline()) {
        return toolFailure(
          "managed_agent_deadline_exceeded",
          "The foreground scout deadline expired.",
        );
      }
      if (result.status === "cancelled") {
        terminalCommitStarted = true;
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "cancelled",
          reason: "caller",
          transcriptDigest,
          throughSequence,
        });
        terminalCommitted = true;
        return toolFailure("managed_agent_cancelled", "The foreground scout was cancelled.");
      }
      if (result.status !== "completed") {
        const error =
          result.status === "failed"
            ? { code: result.error.code, message: result.error.message }
            : {
                code: "model_output_truncated",
                message: "The foreground scout reached its output limit.",
              };
        terminalCommitStarted = true;
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "failed",
          error,
          transcriptDigest,
          throughSequence,
        });
        terminalCommitted = true;
        return toolFailure("managed_agent_failed", "The foreground scout did not complete.");
      }
      const resultBytes = Buffer.from(result.answer, "utf8");
      const createTerminalOutput = (
        terminalResult:
          | { readonly text: string }
          | {
              readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount">;
            },
      ) => ({
        agentId,
        attemptId,
        profile: "scout.v1" as const,
        profileDigest: scoutManagedAgentProfileV1.digest,
        status: "completed" as const,
        result: terminalResult,
        targetIdentity: options.targetIdentity,
        ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
        transcript: {
          sessionId: childSessionId,
          digest: transcriptDigest,
          throughSequence,
        },
        usage,
        cost: { status: "unavailable" as const },
      });
      const inlineResult = { text: result.answer } as const;
      const terminalResult =
        Buffer.byteLength(JSON.stringify(createTerminalOutput(inlineResult)), "utf8") <=
        maximumManagedAgentResultBytes
          ? inlineResult
          : options.artifactStore === undefined
            ? undefined
            : {
                artifact: await options.artifactStore
                  .write({
                    bytes: resultBytes,
                    mediaType: "text/plain; charset=utf-8",
                    source: {
                      type: "managed_agent_result",
                      schemaVersion: 1,
                      agentId,
                      attemptId,
                      childSessionId,
                      totalBytes: resultBytes.byteLength,
                    },
                  })
                  .then(({ id, mediaType, byteCount }) => ({ id, mediaType, byteCount })),
              };
      if (terminalCommitted) {
        return toolFailure(
          "managed_agent_unavailable",
          "The child attempt was fenced as recovery-required during close.",
        );
      }
      if (terminalResult === undefined) {
        terminalCommitStarted = true;
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "failed",
          error: {
            code: "managed_agent_result_too_large",
            message: "The foreground scout result exceeds its inline bound.",
          },
          transcriptDigest,
          throughSequence,
        });
        terminalCommitted = true;
        return toolFailure(
          "managed_agent_result_too_large",
          "The foreground scout result exceeds its bound.",
        );
      }
      if (await settleExpiredDeadline()) {
        return toolFailure(
          "managed_agent_deadline_exceeded",
          "The foreground scout deadline expired.",
        );
      }
      terminalCommitStarted = true;
      await appendManagedRecord({
        type: "managed_agent_terminal",
        agentId,
        attemptId,
        childSessionId,
        status: "completed",
        result: terminalResult,
        transcriptDigest,
        throughSequence,
        usage,
        cost: { status: "unavailable" },
      });
      terminalCommitted = true;
      return {
        status: "completed",
        output: createTerminalOutput(terminalResult),
      };
    } catch (error) {
      if (admissionCommitted && !terminalCommitted) {
        try {
          await deadlineOperation;
          terminalCommitStarted = true;
          let recoveryRecords: readonly SessionRecord[] | undefined;
          try {
            const recoveryStore = await options.childSessionStores.open(childSessionId);
            recoveryRecords = await recoveryStore?.read();
          } catch {
            recoveryRecords = undefined;
          }
          await appendManagedRecord(
            deadlineExpired
              ? {
                  type: "managed_agent_terminal",
                  agentId,
                  attemptId,
                  childSessionId,
                  status: "failed",
                  error: {
                    code: "managed_agent_deadline_exceeded",
                    message: "The foreground scout exceeded its aggregate deadline.",
                  },
                }
              : {
                  type: "managed_agent_terminal",
                  agentId,
                  attemptId,
                  childSessionId,
                  status: "recovery_required",
                  recoveryPhase: recoveryRecords === undefined ? "pre_genesis" : "interrupted",
                  ...(recoveryRecords === undefined
                    ? {}
                    : {
                        transcriptDigest: digest(JSON.stringify(recoveryRecords)),
                        throughSequence: recoveryRecords.at(-1)?.sequence ?? 0,
                      }),
                  error: {
                    code: "managed_agent_recovery_required",
                    message:
                      "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
                  },
                },
          );
          terminalCommitted = true;
        } catch {
          releaseChildClaim = false;
          throw error;
        }
      }
      return toolFailure(
        "managed_agent_unavailable",
        "The foreground scout could not be started safely.",
      );
    } finally {
      deadline.cancel();
      input.signal.removeEventListener("abort", abortFromCaller);
      if (releaseChildClaim) {
        await releaseClaimOnce();
      }
    }
  };
  const spawnBackground = async (
    input: Omit<SpawnInput, "onAdmitted" | "onManagerAdmitted" | "mode">,
  ): Promise<ToolResult> => {
    const newIdentity = input.agentId === undefined;
    const rejected = reserveAdmission(newIdentity);
    if (rejected !== undefined) {
      return rejected;
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) {
      abortFromCaller();
    } else {
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    let resolveAdmission: (identity: {
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly forceRecovery: ForceManagedAgentRecovery;
    }) => void = () => {};
    const admitted = new Promise<{
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly forceRecovery: ForceManagedAgentRecovery;
    }>((resolve) => {
      resolveAdmission = resolve;
    });
    const pendingId = Symbol("managed-agent-background-admission");
    let pendingEntry:
      | {
          readonly controller: AbortController;
          readonly completion: Promise<ToolResult>;
          forceRecovery?: ForceManagedAgentRecovery;
        }
      | undefined;
    const completion = runAttempt({
      ...input,
      mode: "background",
      signal: controller.signal,
      onAdmitted(identity) {
        if (pendingEntry !== undefined) {
          pendingEntry.forceRecovery = identity.forceRecovery;
        }
        resolveAdmission(identity);
      },
      onManagerAdmitted(forceRecovery) {
        if (pendingEntry !== undefined) {
          pendingEntry.forceRecovery = forceRecovery;
        }
      },
    });
    pendingEntry = { controller, completion };
    pendingAdmissions.set(pendingId, pendingEntry);
    const identity = await Promise.race([
      admitted,
      completion.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (identity === undefined) {
      pendingAdmissions.delete(pendingId);
      releaseAdmissionReservation(newIdentity);
      input.signal.removeEventListener("abort", abortFromCaller);
      return completion;
    }
    pendingAdmissions.delete(pendingId);
    releaseAdmissionReservation(newIdentity);
    activeAttempts.set(identity.agentId, {
      attemptId: identity.attemptId,
      controller,
      completion,
      forceRecovery: identity.forceRecovery,
      revision: input.revision ?? 1,
    });
    knownAgentIds.add(identity.agentId);
    input.signal.removeEventListener("abort", abortFromCaller);
    if (managerClosing) {
      try {
        await manager.cancel({ agentId: identity.agentId, expectedRevision: input.revision ?? 1 });
      } finally {
        activeAttempts.delete(identity.agentId);
      }
      return toolFailure(
        "managed_agent_unavailable",
        "The managed-child host closed during admission.",
      );
    }
    void completion.then(
      () => activeAttempts.delete(identity.agentId),
      () => activeAttempts.delete(identity.agentId),
    );
    return {
      status: "completed",
      output: {
        agentId: identity.agentId,
        attemptId: identity.attemptId,
        childSessionId: identity.childSessionId,
        profile: "scout.v1",
        mode: "background",
        status: "running",
        revision: input.revision ?? 1,
      },
    };
  };
  const spawnForeground = async (
    input: Omit<SpawnInput, "onAdmitted" | "onManagerAdmitted" | "mode" | "agentId" | "revision">,
  ): Promise<ToolResult> => {
    const rejected = reserveAdmission(true);
    if (rejected !== undefined) {
      return rejected;
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) {
      abortFromCaller();
    } else {
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    let resolveAdmission: (identity: {
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly forceRecovery: ForceManagedAgentRecovery;
    }) => void = () => {};
    const admitted = new Promise<{
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly forceRecovery: ForceManagedAgentRecovery;
    }>((resolve) => {
      resolveAdmission = resolve;
    });
    const pendingId = Symbol("managed-agent-foreground-admission");
    let pendingEntry:
      | {
          readonly controller: AbortController;
          readonly completion: Promise<ToolResult>;
          forceRecovery?: ForceManagedAgentRecovery;
        }
      | undefined;
    const completion = runAttempt({
      ...input,
      mode: "foreground",
      signal: controller.signal,
      onAdmitted(identity) {
        if (pendingEntry !== undefined) {
          pendingEntry.forceRecovery = identity.forceRecovery;
        }
        resolveAdmission(identity);
      },
      onManagerAdmitted(forceRecovery) {
        if (pendingEntry !== undefined) {
          pendingEntry.forceRecovery = forceRecovery;
        }
      },
    });
    pendingEntry = { controller, completion };
    pendingAdmissions.set(pendingId, pendingEntry);
    const identity = await Promise.race([
      admitted,
      completion.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (identity === undefined) {
      pendingAdmissions.delete(pendingId);
      releaseAdmissionReservation(true);
      input.signal.removeEventListener("abort", abortFromCaller);
      return completion;
    }
    pendingAdmissions.delete(pendingId);
    releaseAdmissionReservation(true);
    activeAttempts.set(identity.agentId, {
      attemptId: identity.attemptId,
      controller,
      completion,
      forceRecovery: identity.forceRecovery,
      revision: 1,
    });
    knownAgentIds.add(identity.agentId);
    try {
      return await completion;
    } finally {
      activeAttempts.delete(identity.agentId);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
  };
  const manager: AgentManager = {
    parentRootId: options.parentRoot.rootId,
    get parentSessionId() {
      return boundParentSessionId;
    },
    targetIdentity: options.targetIdentity,
    ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
    promptSummary() {
      const ids = [...knownAgentIds].sort();
      const active = activeAttempts.size;
      const completed = ids.length - active;
      const prefix = `Managed agents: ${active} active, ${completed} completed, 0 need attention; IDs: `;
      let summary = prefix;
      for (const id of ids) {
        const next = `${summary === prefix ? "" : ", "}${id}`;
        if (Buffer.byteLength(summary + next, "utf8") > 1024) {
          break;
        }
        summary += next;
      }
      return summary;
    },
    rebindParentRoot(parentRoot) {
      if (parentRoot.rootId !== manager.parentRootId) {
        throw new TypeError("The managed-child parent root cannot change.");
      }
      currentParentRoot = parentRoot;
    },
    spawnForeground,
    spawnBackground,
    async snapshot() {
      const records = await options.managedStore.read();
      const snapshot = managedAgentSnapshotFromRecords(records, manager.parentSessionId);
      for (const agent of snapshot.agents) {
        knownAgentIds.add(agent.agentId);
      }
      return snapshot;
    },
    async list(input = {}) {
      const snapshot = await manager.snapshot();
      const offset =
        input.cursor === undefined
          ? 0
          : /^managed-agent:[0-8]$/u.test(input.cursor)
            ? Number(input.cursor.slice("managed-agent:".length))
            : -1;
      if (offset < 0) {
        return toolFailure("invalid_tool_input", "The managed-child list cursor is invalid.");
      }
      const filtered = snapshot.agents.filter((agent) => {
        if (input.status === undefined) {
          return true;
        }
        if (input.status === "active") {
          return agent.status === "running";
        }
        if (input.status === "terminal") {
          return agent.status !== "running";
        }
        return agent.status === input.status;
      });
      const limit = input.limit ?? 8;
      const agents = boundedManagedAgentListAgents(filtered.slice(offset, offset + limit));
      const nextOffset = offset + agents.length;
      return {
        status: "completed",
        output: {
          ...snapshot,
          agents,
          nextCursor: nextOffset < filtered.length ? `managed-agent:${nextOffset}` : null,
        },
      };
    },
    async cancel(input) {
      const active = activeAttempts.get(input.agentId);
      if (active === undefined || input.expectedRevision !== active.revision) {
        return toolFailure(
          "invalid_tool_input",
          "The managed child identity or revision is stale.",
        );
      }
      if (active.cancelPromise !== undefined) {
        return active.cancelPromise;
      }
      const cancellation = (async (): Promise<ToolResult> => {
        const records = await options.managedStore.read();
        const admission = records.find(
          (record) =>
            record.type === "managed_agent_admitted" && record.attemptId === active.attemptId,
        );
        if (admission === undefined) {
          return toolFailure("managed_agent_unavailable", "The active child admission is missing.");
        }
        await appendManagedRecord({
          type: "managed_agent_cancel_requested",
          agentId: input.agentId,
          attemptId: active.attemptId,
          childSessionId: admission.childSessionId,
          expectedRevision: input.expectedRevision,
        });
        active.controller.abort(new Error("Managed child cancelled by its parent."));
        await active.completion;
        return manager.list().then((result) => {
          if (
            result.status !== "completed" ||
            result.output === null ||
            typeof result.output !== "object" ||
            !("agents" in result.output)
          ) {
            return result;
          }
          // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          const agents = result.output["agents"];
          const agent = Array.isArray(agents)
            ? agents.find(
                (candidate) =>
                  candidate !== null &&
                  typeof candidate === "object" &&
                  "agentId" in candidate &&
                  // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
                  candidate["agentId"] === input.agentId,
              )
            : undefined;
          return {
            status: "completed",
            output: agent ?? {
              agentId: input.agentId,
              status: "cancelled",
              revision: input.expectedRevision + 2,
            },
          };
        });
      })();
      active.cancelPromise = cancellation;
      return cancellation;
    },
    async followUp(input) {
      const records = await options.managedStore.read();
      const admissions = records.flatMap((record) =>
        record.type === "managed_agent_admitted" &&
        record.parentSessionId === manager.parentSessionId &&
        record.agentId === input.agentId
          ? [record]
          : [],
      );
      const latest = admissions.at(-1);
      const terminal =
        latest === undefined
          ? undefined
          : records.find(
              (record) =>
                record.type === "managed_agent_terminal" && record.attemptId === latest.attemptId,
            );
      const expectedRevision = records.filter((record) => record.agentId === input.agentId).length;
      const totalAttempts = records.filter(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.parentSessionId === manager.parentSessionId,
      ).length;
      const attemptHistories = await Promise.all(
        admissions.map((admission) =>
          managedAttemptHistory(admission, records, options.childSessionStores),
        ),
      );
      const cumulativeTokens = attemptHistories.reduce(
        (total, history) =>
          total +
          history.usage.inputTokens +
          history.usage.outputTokens +
          history.usage.reasoningTokens,
        0,
      );
      const deadlineAtUnixMilliseconds = admissions[0]?.deadlineAtUnixMilliseconds;
      const followUpNow = (options.now ?? Date.now)();
      const remainingDeadlineMilliseconds =
        deadlineAtUnixMilliseconds === undefined
          ? scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds
          : deadlineAtUnixMilliseconds - followUpNow;
      const remainingTokens =
        scoutManagedAgentProfileV1.limits.maximumCumulativeTokens - cumulativeTokens;
      const sourceRecords = attemptHistories.at(-1)?.childRecords ?? [];
      const replayBoundary = managedReplayBoundary(sourceRecords);
      const resumedMessages = replayBoundary.messages;
      const resume =
        latest === undefined
          ? undefined
          : {
              sourceAttemptId: latest.attemptId,
              sourceChildSessionId: latest.childSessionId,
              sourceTranscriptDigest: digest(JSON.stringify(sourceRecords)),
              replayMessagesDigest: replayBoundary.digest,
              throughSequence: replayBoundary.throughSequence,
            };
      if (
        latest === undefined ||
        terminal === undefined ||
        terminal.type !== "managed_agent_terminal" ||
        terminal.status === "inspection_required" ||
        attemptHistories.some((history) => !history.valid) ||
        input.expectedRevision !== expectedRevision ||
        admissions.length >= 4 ||
        totalAttempts >= 16 ||
        remainingTokens <= 0 ||
        remainingDeadlineMilliseconds <= 0
      ) {
        return toolFailure(
          "invalid_tool_input",
          "The managed child is not terminal at the expected revision or has no remaining attempt budget.",
        );
      }
      return spawnBackground({
        ...input,
        agentId: input.agentId,
        deadlineAtUnixMilliseconds:
          deadlineAtUnixMilliseconds ?? followUpNow + remainingDeadlineMilliseconds,
        admittedAtUnixMilliseconds: followUpNow,
        maximumDeadlineMilliseconds: remainingDeadlineMilliseconds,
        maximumTokens: remainingTokens,
        ...(resume === undefined ? {} : { resume }),
        resumedMessages,
        revision: expectedRevision + 1,
      });
    },
    async wait(input) {
      const snapshot = await manager.snapshot();
      const byId = new Map(snapshot.agents.map((agent) => [agent.agentId, agent]));
      if (
        input.agentIds.length === 0 ||
        input.agentIds.length > 2 ||
        new Set(input.agentIds).size !== input.agentIds.length ||
        input.agentIds.some((agentId) => !byId.has(agentId))
      ) {
        return toolFailure(
          "invalid_tool_input",
          "The selected managed child identities are invalid.",
        );
      }
      const conditionMet =
        input.until === "any_terminal"
          ? input.agentIds.some((agentId) => byId.get(agentId)?.status !== "running")
          : input.agentIds.every((agentId) => byId.get(agentId)?.status !== "running");
      if (conditionMet) {
        return manager.list();
      }
      const completions = input.agentIds.flatMap((agentId) => {
        const completion = activeAttempts.get(agentId)?.completion;
        return completion === undefined ? [] : [completion];
      });
      if (completions.length === 0) {
        return toolFailure(
          "managed_agent_unavailable",
          "The selected managed children have no causally active attempts.",
        );
      }
      let resolveAbort = () => {};
      const aborted = new Promise<"aborted">((resolve) => {
        resolveAbort = () => resolve("aborted");
      });
      if (input.signal.aborted) {
        resolveAbort();
      } else {
        input.signal.addEventListener("abort", resolveAbort, { once: true });
      }
      const settlement =
        input.until === "any_terminal"
          ? Promise.race(completions).then(() => "settled" as const)
          : Promise.allSettled(completions).then(() => "settled" as const);
      const outcome = await Promise.race([settlement, aborted]);
      input.signal.removeEventListener("abort", resolveAbort);
      return outcome === "aborted"
        ? toolFailure("managed_agent_cancelled", "Waiting stopped without cancelling a child.")
        : manager.list();
    },
    async waitForIdle() {
      await Promise.allSettled([...activeAttempts.values()].map((attempt) => attempt.completion));
    },
    close() {
      managerClosing = true;
      managerClosePromise ??= (async () => {
        const attempts = [...activeAttempts.entries()];
        const pending = [...pendingAdmissions.values()];
        for (const admission of pending) {
          admission.controller.abort(new Error("Managed-child host is closing."));
        }
        if (attempts.length === 0 && pending.length === 0) {
          return;
        }
        const settlements = Promise.allSettled([
          ...pending.map((admission) => admission.completion),
          ...attempts.map(([agentId, attempt]) =>
            manager.cancel({ agentId, expectedRevision: attempt.revision }),
          ),
        ]);
        let expireDrain = () => {};
        const expired = new Promise<"expired">((resolve) => {
          expireDrain = () => resolve("expired");
        });
        const drain = (options.closeDrainScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
          10_000,
          expireDrain,
        );
        const outcome = await Promise.race([settlements.then(() => "settled" as const), expired]);
        drain.cancel();
        if (outcome === "expired" || activeAttempts.size > 0 || pendingAdmissions.size > 0) {
          const activeUnsettled = [...activeAttempts.entries()];
          const pendingUnsettled = [...pendingAdmissions.entries()];
          const forceOperations = [
            ...activeUnsettled.map(([agentId, attempt]) => ({
              key: agentId,
              kind: "active" as const,
              operation: attempt.forceRecovery(),
            })),
            ...pendingUnsettled.flatMap(([pendingId, attempt]) =>
              attempt.forceRecovery === undefined
                ? []
                : [
                    {
                      key: pendingId,
                      kind: "pending" as const,
                      operation: attempt.forceRecovery(),
                    },
                  ],
            ),
          ];
          const forced = await Promise.allSettled(
            forceOperations.map(({ operation }) => operation),
          );
          if (forced.some((result) => result.status === "rejected")) {
            throw new ManagedAgentStoreError("managed_agent_log_invalid");
          }
          for (const [index, operation] of forceOperations.entries()) {
            const result = forced[index];
            if (result?.status !== "fulfilled" || result.value === "terminal_in_progress") {
              continue;
            }
            if (operation.kind === "active") {
              activeAttempts.delete(operation.key);
            } else {
              pendingAdmissions.delete(operation.key);
            }
          }
          const stillPending = [...pendingAdmissions.values()];
          const stillActive = [...activeAttempts.values()];
          if (stillPending.length > 0 || stillActive.length > 0) {
            await Promise.allSettled([
              ...stillPending.map((attempt) => attempt.completion),
              ...stillActive.map((attempt) => attempt.completion),
            ]);
          }
          void settlements.catch(() => undefined);
        }
      })();
      return managerClosePromise;
    },
  };
  return manager;
}

export function createManagedAgentToolRegistry(options: {
  readonly manager: AgentManager;
  readonly profile?: "managed-agent-tools.a1.v1" | "managed-agent-tools.a2-long-lived.v1";
}): ToolRegistry {
  const profile = options.profile ?? "managed-agent-tools.a1.v1";
  const spawnSchema =
    profile === "managed-agent-tools.a2-long-lived.v1"
      ? managedAgentA2SpawnSchema
      : managedAgentTaskSchema;
  const adapter = createInternalToolAdapter(
    {
      definition: {
        name: "spawn_agent",
        description:
          profile === "managed-agent-tools.a2-long-lived.v1"
            ? "Start one foreground or same-process background read-only scout. Background requires the long-lived interactive session host; the scout cannot write, execute, spawn, inherit extensions, or change its model or permissions."
            : "Run one foreground read-only scout with fresh bounded context. It cannot run in background, select Skills, write, execute, spawn, inherit extensions, or change its model or permissions.",
        inputSchema: z.toJSONSchema(spawnSchema),
      },
      outputSchema: z.union([
        managedAgentTerminalOutputSchema,
        z.strictObject({
          agentId: z.string().uuid(),
          attemptId: z.string().uuid(),
          childSessionId: z.string().uuid(),
          profile: z.literal("scout.v1"),
          mode: z.literal("background"),
          status: z.literal("running"),
          revision: z.literal(1),
        }),
      ]) as z.ZodType<JsonValue>,
      effect: "delegate",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = spawnSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_spawn",
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
            profile: "scout.v1",
            ...(profile !== "managed-agent-tools.a2-long-lived.v1"
              ? {}
              : {
                  mode:
                    "mode" in parsed.data && parsed.data.mode === "background"
                      ? "background"
                      : "foreground",
                }),
            profileDigest: scoutManagedAgentProfileV1.digest,
            targetIdentity: options.manager.targetIdentity,
            taskDigest: digest(parsed.data.task),
            limits: {
              maximumTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
              maximumTokens: scoutManagedAgentProfileV1.limits.maximumCumulativeTokens,
              maximumDeadlineMilliseconds:
                scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds,
            },
            ...(options.manager.thinkingPolicy === undefined
              ? {}
              : { thinkingPolicy: options.manager.thinkingPolicy }),
          },
          execute(context) {
            const spawn =
              "mode" in parsed.data && parsed.data.mode === "background"
                ? options.manager.spawnBackground
                : options.manager.spawnForeground;
            return spawn({
              callId: context.callId,
              parentSessionId: context.sessionId,
              signal: context.signal,
              task: parsed.data.task,
            });
          },
        };
      },
    },
    "never",
  );
  if (profile === "managed-agent-tools.a1.v1") {
    return createInternalToolRegistry([adapter]);
  }
  const listAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "list_agents",
        description:
          "List bounded managed-child status and result summaries for this exact parent session.",
        inputSchema: z.toJSONSchema(managedAgentListSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "read",
      cancellation: "unsupported",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentListSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "list",
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
          },
          execute: () =>
            options.manager.list({
              ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
              ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
              ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
            }),
        };
      },
    },
    "never",
  );
  const cancelAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "cancel_agent",
        description:
          "Cancel one exact active child. Adam reports terminal state only after causal model/tool settlement or recovery-required truth.",
        inputSchema: z.toJSONSchema(managedAgentCancelSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "delegate",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentCancelSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "cancel" as const,
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
            agentId: parsed.data.agentId,
            expectedRevision: parsed.data.expectedRevision,
          },
          execute: () => options.manager.cancel(parsed.data),
        };
      },
    },
    "never",
  );
  const waitAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "wait_agents",
        description:
          "Wait causally for selected managed children to reach terminal state. Cancelling this wait does not cancel a child.",
        inputSchema: z.toJSONSchema(managedAgentWaitSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "read",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentWaitSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success || new Set(parsed.data.agentIds).size !== parsed.data.agentIds.length) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "wait" as const,
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
          },
          execute: (context) =>
            options.manager.wait({
              agentIds: parsed.data.agentIds,
              until: parsed.data.until ?? "all_terminal",
              signal: context.signal,
            }),
        };
      },
    },
    "never",
  );
  const followUpAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "follow_up_agent",
        description:
          "Start an explicit new attempt for one terminal child after current authority and remaining limits are revalidated.",
        inputSchema: z.toJSONSchema(managedAgentFollowUpSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "delegate",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentFollowUpSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "follow_up" as const,
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
            agentId: parsed.data.agentId,
            expectedRevision: parsed.data.expectedRevision,
            taskDigest: digest(parsed.data.task),
          },
          execute: (context) =>
            options.manager.followUp({
              ...parsed.data,
              callId: context.callId,
              parentSessionId: context.sessionId,
              signal: context.signal,
            }),
        };
      },
    },
    "never",
  );
  return createInternalToolRegistry([
    adapter,
    listAdapter,
    waitAdapter,
    followUpAdapter,
    cancelAdapter,
  ]);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function childTaskMessage(task: string): string {
  return `${task}\n\n${childLiveWorkspaceNotice}`;
}

function boundedUtf8Prefix(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function usageFromChildRecords(records: readonly SessionRecord[]): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
} {
  return records.reduce(
    (total, record) => {
      const response =
        record.schemaVersion === 3 && record.record.type === "model_response_completed"
          ? record.record.response
          : undefined;
      const compactionUsage =
        record.schemaVersion === 3 &&
        (record.record.type === "context_compaction_committed" ||
          record.record.type === "context_compaction_failed")
          ? record.record.usage
          : record.schemaVersion === 3 &&
              record.record.type === "context_compaction_interrupted" &&
              !("status" in record.record.usage)
            ? record.record.usage
            : undefined;
      const usage = response?.usage ?? compactionUsage;
      return usage === undefined
        ? total
        : {
            inputTokens: total.inputTokens + usage.inputTokens,
            outputTokens: total.outputTokens + usage.outputTokens,
            reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
          };
    },
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
}

function managedReplayBoundary(records: readonly SessionRecord[]): {
  readonly messages: readonly ModelMessage[];
  readonly digest: `sha256:${string}`;
  readonly throughSequence: number;
} {
  const messages = modelMessagesFromCompleteRecords(records);
  const replayDigest = digest(JSON.stringify(messages));
  let throughSequence = 0;
  for (let length = records.length; length > 0; length -= 1) {
    const previousDigest = digest(
      JSON.stringify(modelMessagesFromCompleteRecords(records.slice(0, length - 1))),
    );
    if (previousDigest !== replayDigest) {
      throughSequence = records[length - 1]?.sequence ?? 0;
      break;
    }
  }
  return { messages, digest: replayDigest, throughSequence };
}

async function managedAttemptHistory(
  admission: Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }>,
  managerRecords: readonly ManagedAgentRecord[],
  childSessionStores: SessionStoreDirectory<SessionRecord>,
): Promise<{
  readonly valid: boolean;
  readonly childRecords: readonly SessionRecord[];
  readonly usage: ReturnType<typeof usageFromChildRecords>;
}> {
  const terminal = managerRecords.find(
    (record) =>
      record.type === "managed_agent_terminal" && record.attemptId === admission.attemptId,
  );
  let childRecords: readonly SessionRecord[] | undefined;
  try {
    const store = await childSessionStores.open(admission.childSessionId);
    childRecords = await store?.read();
  } catch {
    childRecords = undefined;
  }
  const linkedDigest =
    terminal !== undefined && "transcriptDigest" in terminal
      ? terminal.transcriptDigest
      : undefined;
  const linkedThrough =
    terminal !== undefined && "throughSequence" in terminal ? terminal.throughSequence : undefined;
  const preGenesisRecovery =
    terminal?.type === "managed_agent_terminal" &&
    terminal.status === "recovery_required" &&
    terminal.recoveryPhase === "pre_genesis";
  const valid =
    terminal !== undefined &&
    terminal.type === "managed_agent_terminal" &&
    (preGenesisRecovery
      ? childRecords === undefined && linkedDigest === undefined && linkedThrough === undefined
      : linkedDigest !== undefined &&
        linkedThrough !== undefined &&
        childRecords !== undefined &&
        digest(JSON.stringify(childRecords)) === linkedDigest &&
        (childRecords.at(-1)?.sequence ?? 0) === linkedThrough);
  const records = childRecords ?? [];
  return { valid, childRecords: records, usage: usageFromChildRecords(records) };
}

function toolFailure(
  code:
    | "invalid_tool_input"
    | "managed_agent_cancelled"
    | "managed_agent_capacity_exceeded"
    | "managed_agent_deadline_exceeded"
    | "managed_agent_failed"
    | "managed_agent_result_too_large"
    | "managed_agent_unavailable",
  message: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
}
