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
import { createPromptContextV1, type PromptContextRecord } from "./prompt-assembly.js";
import { sessionDurableContext } from "./session-durable-context.js";
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
      readonly profileDigest: `sha256:${string}`;
      readonly limits: {
        readonly maximumTurns: 8;
        readonly maximumTokens: 128_000;
        readonly maximumDeadlineMilliseconds: 600_000;
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
    profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    limits: z.strictObject({
      maximumTurns: z.literal(8),
      maximumTokens: z.literal(128_000),
      maximumDeadlineMilliseconds: z.literal(600_000),
    }),
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
): Promise<void> {
  let records = await store.read();
  const terminalAttempts = new Set(
    records.flatMap((record) =>
      record.type === "managed_agent_terminal" ? [record.attemptId] : [],
    ),
  );
  for (const admission of records) {
    if (admission.type !== "managed_agent_admitted" || terminalAttempts.has(admission.attemptId)) {
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
    const validGenesisIdentity =
      genesis?.schemaVersion === 3 &&
      genesis.record.type === "session_genesis" &&
      genesis.record.sessionId === admission.childSessionId &&
      genesis.record.projectId === admission.projectId &&
      isDeepStrictEqual(genesis.record.targetIdentity, admission.targetIdentity) &&
      isDeepStrictEqual(genesis.record.promptContext, expectedPromptContext) &&
      admission.profileDigest === scoutManagedAgentProfileV1.digest &&
      isDeepStrictEqual(admission.limits, {
        maximumTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
        maximumTokens: scoutManagedAgentProfileV1.limits.maximumCumulativeTokens,
        maximumDeadlineMilliseconds: scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds,
      }) &&
      admission.parentRootId === `session:${admission.parentSessionId}` &&
      (admission.repository === undefined
        ? repository?.sources.length === 0
        : repository?.revision === admission.repository.revision &&
          repository.effectiveDigest === admission.repository.effectiveDigest);
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
    if (deadlineRecord !== undefined) {
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
    if (
      history.some(
        (record) =>
          record.agentId === candidate.agentId ||
          record.attemptId === candidate.attemptId ||
          record.childSessionId === candidate.childSessionId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_deadline_expired") {
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
          (record.type === "managed_agent_deadline_expired" ||
            record.type === "managed_agent_terminal") &&
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
      )
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

export type AgentManager = {
  readonly parentRootId: string;
  readonly parentSessionId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  spawnForeground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
  }): Promise<ToolResult>;
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
  readonly parentRoot: ProjectExecutionRootClaim;
  readonly parentSessionId?: string;
  readonly projectId: `sha256:${string}`;
  readonly repository?: PromptContextRecord["repository"];
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  readonly workspaceRoot: string;
}): AgentManager {
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
  return {
    parentRootId: options.parentRoot.rootId,
    parentSessionId: options.parentSessionId ?? "00000000-0000-4000-8000-000000000001",
    targetIdentity: options.targetIdentity,
    ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
    async spawnForeground(input) {
      const existingAdmissions = (await options.managedStore.read()).filter(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.parentSessionId === input.parentSessionId,
      );
      if (new Set(existingAdmissions.map((record) => record.agentId)).size >= 8) {
        return toolFailure(
          "managed_agent_capacity_exceeded",
          "This parent session already owns the maximum eight managed child identities.",
        );
      }
      const agentId = randomUUID();
      const attemptId = randomUUID();
      const childSessionId = randomUUID();
      const taskDigest = digest(input.task);
      const childClaim = await options.parentRoot.claimChild({ childId: agentId });
      const childController = new AbortController();
      let deadlineExpired = false;
      let deadlineRequested = false;
      let deadlineOperation: Promise<void> | undefined;
      let admissionCommitted = false;
      let terminalCommitStarted = false;
      let terminalCommitted = false;
      let releaseChildClaim = true;
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
        scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds,
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
          parentRootId: options.parentRoot.rootId,
          projectId: options.projectId,
          profile: "scout.v1",
          profileDigest: scoutManagedAgentProfileV1.digest,
          limits: {
            maximumTurns: scoutManagedAgentProfileV1.limits.maximumTurnsPerAttempt,
            maximumTokens: scoutManagedAgentProfileV1.limits.maximumCumulativeTokens,
            maximumDeadlineMilliseconds:
              scoutManagedAgentProfileV1.limits.maximumDeadlineMilliseconds,
          },
          taskDigest,
          childInputDigest: digest(childTaskMessage(input.task)),
          targetIdentity: options.targetIdentity,
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
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
              maxTokens: scoutManagedAgentProfileV1.limits.maximumCumulativeTokens,
            },
          },
        );
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
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
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
          await childClaim.release();
        }
      }
    },
  };
}

export function createManagedAgentToolRegistry(options: {
  readonly manager: AgentManager;
}): ToolRegistry {
  const adapter = createInternalToolAdapter(
    {
      definition: {
        name: "spawn_agent",
        description:
          "Run one foreground read-only scout with fresh bounded context. It cannot run in background, select Skills, write, execute, spawn, inherit extensions, or change its model or permissions.",
        inputSchema: z.toJSONSchema(managedAgentTaskSchema),
      },
      outputSchema: managedAgentTerminalOutputSchema as z.ZodType<JsonValue>,
      effect: "delegate",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = managedAgentTaskSchema.safeParse(parseJson(argumentsJson));
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
            return options.manager.spawnForeground({
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
  return createInternalToolRegistry([adapter]);
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
