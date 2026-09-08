import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ArtifactReference } from "./artifact-store.js";
import {
  researchManagedAgentProfileV1,
  researchManagedAgentProfileV2,
  researchManagedAgentProfileV3,
  reviewerManagedAgentProfileV1,
  reviewerManagedAgentProfileV2,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
  scoutManagedAgentProfileV3,
} from "./managed-agent-profiles.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import { contextUsageSnapshotFromRecords } from "./session-history-folds.js";
import type { SessionRecord, SessionStoreDirectory } from "./session-store.js";
import {
  latestTaskBudget,
  type TaskBudget,
  type TaskProviderEvent,
  taskBudgetContinues,
  taskBudgetSchema,
  taskBudgetUsage,
  taskProviderEventSchema,
} from "./task-budget.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  type JsonValue,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

const maximumManagedAgentTaskBytes = 16 * 1024;
const maximumManagedAgentMessageBytes = 8 * 1024;
const maximumManagedAgentResultBytes = 16 * 1024;
type BuiltInManagedAgentProfileId =
  | "scout.v1"
  | "scout.v2"
  | "scout.v3"
  | "research.v1"
  | "research.v2"
  | "research.v3";
type ManagedAgentProfileId = "reviewer.v1" | BuiltInManagedAgentProfileId;

function isResearchManagedAgentProfile(
  profile: ManagedAgentProfileId,
): profile is "research.v1" | "research.v2" | "research.v3" {
  return profile === "research.v1" || profile === "research.v2" || profile === "research.v3";
}

function isCurrentManagedAgentProfile(
  profile: ManagedAgentProfileId,
): profile is "scout.v2" | "research.v2" | "scout.v3" | "research.v3" {
  return (
    profile === "scout.v2" ||
    profile === "research.v2" ||
    profile === "scout.v3" ||
    profile === "research.v3"
  );
}

function managedAgentProfile(profile: ManagedAgentProfileId) {
  return profile === "research.v3"
    ? researchManagedAgentProfileV3
    : profile === "scout.v3"
      ? scoutManagedAgentProfileV3
      : profile === "research.v2"
        ? researchManagedAgentProfileV2
        : profile === "scout.v2"
          ? scoutManagedAgentProfileV2
          : profile === "research.v1"
            ? researchManagedAgentProfileV1
            : profile === "reviewer.v1"
              ? reviewerManagedAgentProfileV1
              : scoutManagedAgentProfileV1;
}

function isCurrentManagedAgentAdmission(
  admission: Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }>,
): boolean {
  return (
    isCurrentManagedAgentProfile(admission.profile) ||
    (admission.profile === "reviewer.v1" &&
      admission.profileDigest === reviewerManagedAgentProfileV2.digest)
  );
}

function managedAdmissionLimitsAreValid(
  admission: Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }>,
  contextWindowTokens?: number,
): boolean {
  if (admission.profile.endsWith(".v3")) {
    return (
      admission.taskBudget !== undefined &&
      admission.limits.maximumTokens === null &&
      admission.limits.contextWindowTokens === contextWindowTokens &&
      contextWindowTokens !== undefined &&
      admission.limits.maximumTurns === undefined &&
      admission.limits.maximumDeadlineMilliseconds === undefined &&
      admission.deadlineAtUnixMilliseconds === undefined &&
      admission.limits.maximumInactivityMilliseconds === 300_000
    );
  }
  if (
    admission.limits.maximumTokens === null ||
    admission.taskBudget !== undefined ||
    admission.limits.contextWindowTokens !== undefined
  )
    return false;
  if (isCurrentManagedAgentAdmission(admission)) {
    const profile =
      admission.profile === "research.v2"
        ? researchManagedAgentProfileV2
        : admission.profile === "scout.v2"
          ? scoutManagedAgentProfileV2
          : reviewerManagedAgentProfileV2;
    return (
      admission.limits.maximumTurns === undefined &&
      admission.limits.maximumDeadlineMilliseconds === undefined &&
      admission.limits.maximumInactivityMilliseconds ===
        profile.limits.maximumInactivityMilliseconds &&
      admission.deadlineAtUnixMilliseconds === undefined &&
      contextWindowTokens !== undefined &&
      (admission.resume === undefined
        ? admission.limits.maximumTokens === contextWindowTokens
        : admission.limits.maximumTokens <= contextWindowTokens)
    );
  }
  const profile =
    admission.profile === "research.v1"
      ? researchManagedAgentProfileV1
      : admission.profile === "reviewer.v1"
        ? reviewerManagedAgentProfileV1
        : scoutManagedAgentProfileV1;
  return (
    admission.limits.maximumInactivityMilliseconds === undefined &&
    admission.limits.maximumTurns === profile.limits.maximumTurnsPerAttempt &&
    admission.limits.maximumTokens <= profile.limits.maximumCumulativeTokens &&
    admission.limits.maximumDeadlineMilliseconds !== undefined &&
    admission.limits.maximumDeadlineMilliseconds <= profile.limits.maximumDeadlineMilliseconds &&
    ((admission.mode === undefined &&
      admission.admittedAtUnixMilliseconds === undefined &&
      admission.deadlineAtUnixMilliseconds === undefined) ||
      (admission.mode !== undefined &&
        admission.admittedAtUnixMilliseconds !== undefined &&
        admission.deadlineAtUnixMilliseconds !== undefined &&
        admission.deadlineAtUnixMilliseconds - admission.admittedAtUnixMilliseconds ===
          admission.limits.maximumDeadlineMilliseconds))
  );
}
const managedAgentTaskSchema = z.strictObject({
  task: z
    .string()
    .min(1)
    .refine((task) => Buffer.byteLength(task, "utf8") <= maximumManagedAgentTaskBytes),
});
const managedAgentA2SpawnSchema = managedAgentTaskSchema.extend({
  mode: z.enum(["foreground", "background"]).optional(),
});
const managedAgentA3SpawnSchema = managedAgentTaskSchema
  .extend({
    profile: z.enum(["scout.v1", "research.v1"]),
    skills: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
    mode: z.enum(["foreground", "background"]).optional(),
  })
  .superRefine((input, context) => {
    if (input.profile === "scout.v1" && input.skills !== undefined) {
      context.addIssue({ code: "custom", message: "Only research.v1 accepts selected Skills." });
    }
  });
const managedAgentA3SpawnSchemaV2 = managedAgentTaskSchema
  .extend({
    profile: z.enum(["scout.v2", "research.v2"]),
    skills: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
    mode: z.enum(["foreground", "background"]).optional(),
  })
  .superRefine((input, context) => {
    if (input.profile === "scout.v2" && input.skills !== undefined) {
      context.addIssue({ code: "custom", message: "Only research.v2 accepts selected Skills." });
    }
  });
const managedAgentTaskSchemaV3 = managedAgentTaskSchema
  .extend({
    shareBudgetWithAgentId: z
      .uuid()
      .optional()
      .describe(
        "Join an existing explicit task budget only with fresh user approval; this does not add tokens.",
      ),
    budgetTokens: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe(
        "Only set when the user requests a task budget. Shared across all attempts; requires a fresh user decision. Omit by default.",
      ),
  })
  .refine(
    (input) => input.budgetTokens === undefined || input.shareBudgetWithAgentId === undefined,
    "Choose a new budget or an existing task budget, not both.",
  );
const managedAgentA3SpawnSchemaV3 = managedAgentTaskSchema
  .extend({
    shareBudgetWithAgentId: z
      .uuid()
      .optional()
      .describe(
        "Join an existing explicit task budget only with fresh user approval; this does not add tokens.",
      ),
    budgetTokens: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe(
        "Only set when the user requests a task budget. Shared across all attempts; requires a fresh user decision. Omit by default.",
      ),
    profile: z.enum(["scout.v3", "research.v3"]),
    skills: z.array(z.string().min(1).max(512)).min(1).max(8).optional(),
    mode: z.enum(["foreground", "background"]).optional(),
  })
  .superRefine((input, context) => {
    if (input.budgetTokens !== undefined && input.shareBudgetWithAgentId !== undefined)
      context.addIssue({
        code: "custom",
        message: "Choose a new budget or an existing task budget, not both.",
      });
    if (input.profile === "scout.v3" && input.skills !== undefined) {
      context.addIssue({ code: "custom", message: "Only research.v3 accepts selected Skills." });
    }
  });
const managedAgentListStatusSchemaV1 = z.enum([
  "active",
  "terminal",
  "running",
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
  "inspection_required",
]);
const managedAgentListStatusSchemaV2 = z.enum([
  "active",
  "terminal",
  "running",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
  "inspection_required",
]);
const managedAgentListSchemaV1 = z.strictObject({
  status: managedAgentListStatusSchemaV1.optional(),
  limit: z.number().int().min(1).max(8).optional(),
  cursor: z.string().min(1).max(256).optional(),
});
const managedAgentListSchemaV2 = z.strictObject({
  status: managedAgentListStatusSchemaV2.optional(),
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
const managedAgentA3WaitSchema = managedAgentWaitSchema.extend({
  until: z.enum(["any_terminal", "all_terminal", "attention"]).optional(),
});
const managedAgentFollowUpSchema = managedAgentTaskSchema.extend({
  agentId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
const managedAgentSendSchema = z.strictObject({
  agentId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  message: z
    .string()
    .min(1)
    .refine((message) => Buffer.byteLength(message, "utf8") <= maximumManagedAgentMessageBytes),
  attentionId: z.string().uuid().optional(),
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
  profile: z.enum([
    "reviewer.v1",
    "scout.v1",
    "scout.v2",
    "scout.v3",
    "research.v1",
    "research.v2",
    "research.v3",
  ]),
  profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  effectiveToolProfileDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
  skillActivationDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
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
      readonly type: "managed_agent_provider_blocked";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly purpose: "ordinary" | "compaction";
      readonly source: { readonly sequence: number; readonly digest: string };
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_provider";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly event: TaskProviderEvent;
    }
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
      readonly profile: ManagedAgentProfileId;
      readonly mode?: "foreground" | "background";
      readonly profileDigest: `sha256:${string}`;
      readonly usageAccountingVersion?: 2;
      readonly taskBudget?: TaskBudget;
      readonly budgetSourceAgentId?: string;
      readonly effectiveToolProfileDigest?: `sha256:${string}`;
      readonly skillActivationDigest?: `sha256:${string}`;
      readonly selectedSkills?: readonly {
        readonly qualifiedId: string;
        readonly skillMdDigest: `sha256:${string}`;
        readonly manifestDigest: `sha256:${string}`;
      }[];
      readonly limits: {
        readonly maximumTurns?: number;
        readonly maximumTokens: number | null;
        readonly contextWindowTokens?: number;
        readonly maximumDeadlineMilliseconds?: number;
        readonly maximumInactivityMilliseconds?: number;
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
      readonly type: "managed_agent_parent_message_enqueued";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly messageId: `sha256:${string}`;
      readonly parentToolCallId: string;
      readonly expectedRevision: number;
      readonly sourceRunId?: string;
      readonly sourceTurn?: number;
      readonly sourceProviderAttempt?: number;
      readonly argumentsDigest: `sha256:${string}`;
      readonly message: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_parent_message_delivered";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly messageId: `sha256:${string}`;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_child_reported";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly reportId: `sha256:${string}`;
      readonly childToolCallId: string;
      readonly sourceRunId: string;
      readonly sourceTurn: number;
      readonly sourceProviderAttempt: number;
      readonly argumentsDigest: `sha256:${string}`;
      readonly kind: "progress" | "finding";
      readonly message: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_attention_requested";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly attentionId: string;
      readonly effectId: `sha256:${string}`;
      readonly childToolCallId: string;
      readonly sourceRunId: string;
      readonly sourceTurn: number;
      readonly sourceProviderAttempt: number;
      readonly argumentsDigest: `sha256:${string}`;
      readonly question: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_parent_reply_enqueued";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly attentionId: string;
      readonly messageId: `sha256:${string}`;
      readonly parentToolCallId: string;
      readonly expectedRevision: number;
      readonly sourceRunId?: string;
      readonly sourceTurn?: number;
      readonly sourceProviderAttempt?: number;
      readonly argumentsDigest: `sha256:${string}`;
      readonly message: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_parent_reply_delivered";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly attentionId: string;
      readonly messageId: `sha256:${string}`;
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
      readonly type: "managed_agent_stalled";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly maximumInactivityMilliseconds: 300_000;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_resumed";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "managed_agent_inspection_required";
      readonly sequence: number;
      readonly agentId: string;
      readonly attemptId: string;
      readonly childSessionId: string;
      readonly error: {
        readonly code: "managed_agent_inspection_required";
        readonly message: string;
      };
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
      readonly providerCalls?: number;
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
      readonly partialOutput?: {
        readonly text: string;
        readonly byteCount: number;
        readonly truncated: boolean;
      };
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
      readonly partialOutput?: {
        readonly text: string;
        readonly byteCount: number;
        readonly truncated: boolean;
      };
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
    type: z.literal("managed_agent_provider_blocked"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    purpose: z.enum(["ordinary", "compaction"]),
    source: z.strictObject({
      sequence: z.number().int().positive(),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    }),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_provider"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    event: taskProviderEventSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_parent_message_enqueued"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    messageId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    parentToolCallId: z.string().min(1).max(256),
    expectedRevision: z.number().int().positive(),
    sourceRunId: z.uuid().optional(),
    sourceTurn: z.number().int().positive().optional(),
    sourceProviderAttempt: z.number().int().positive().optional(),
    argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    message: z
      .string()
      .min(1)
      .refine((message) => Buffer.byteLength(message, "utf8") <= maximumManagedAgentMessageBytes),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_parent_message_delivered"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    messageId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_child_reported"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    reportId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    childToolCallId: z.string().min(1).max(256),
    sourceRunId: z.uuid(),
    sourceTurn: z.number().int().positive(),
    sourceProviderAttempt: z.number().int().positive(),
    argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    kind: z.enum(["progress", "finding"]),
    message: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= maximumManagedAgentMessageBytes),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_attention_requested"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    attentionId: z.uuid(),
    effectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    childToolCallId: z.string().min(1).max(256),
    sourceRunId: z.uuid(),
    sourceTurn: z.number().int().positive(),
    sourceProviderAttempt: z.number().int().positive(),
    argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    question: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= maximumManagedAgentMessageBytes),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_parent_reply_enqueued"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    attentionId: z.uuid(),
    messageId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    parentToolCallId: z.string().min(1).max(256),
    expectedRevision: z.number().int().positive(),
    sourceRunId: z.uuid().optional(),
    sourceTurn: z.number().int().positive().optional(),
    sourceProviderAttempt: z.number().int().positive().optional(),
    argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    message: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= maximumManagedAgentMessageBytes),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_parent_reply_delivered"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    attentionId: z.uuid(),
    messageId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
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
    type: z.literal("managed_agent_stalled"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    maximumInactivityMilliseconds: z.literal(300_000),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_resumed"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal("managed_agent_inspection_required"),
    sequence: z.number().int().positive(),
    agentId: z.uuid(),
    attemptId: z.uuid(),
    childSessionId: z.uuid(),
    error: z.strictObject({
      code: z.literal("managed_agent_inspection_required"),
      message: z.string().min(1).max(4_096),
    }),
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
    profile: z.enum([
      "reviewer.v1",
      "scout.v1",
      "scout.v2",
      "scout.v3",
      "research.v1",
      "research.v2",
      "research.v3",
    ]),
    mode: z.enum(["foreground", "background"]).optional(),
    profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    usageAccountingVersion: z.literal(2).optional(),
    taskBudget: taskBudgetSchema.optional(),
    budgetSourceAgentId: z.uuid().optional(),
    effectiveToolProfileDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    skillActivationDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    selectedSkills: z
      .array(
        z.strictObject({
          qualifiedId: z.string().min(1).max(512),
          skillMdDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        }),
      )
      .max(8)
      .optional(),
    limits: z.strictObject({
      maximumTurns: z.number().int().min(1).max(8).optional(),
      maximumTokens: z.number().int().positive().safe().nullable(),
      contextWindowTokens: z.number().int().positive().safe().optional(),
      maximumDeadlineMilliseconds: z.number().int().positive().max(600_000).optional(),
      maximumInactivityMilliseconds: z.number().int().positive().max(300_000).optional(),
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
    providerCalls: z.number().int().positive().optional(),
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
    partialOutput: z
      .strictObject({
        text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 16 * 1024),
        byteCount: z.number().int().positive(),
        truncated: z.boolean(),
      })
      .optional(),
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
    partialOutput: z
      .strictObject({
        text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 16 * 1024),
        byteCount: z.number().int().positive(),
        truncated: z.boolean(),
      })
      .optional(),
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

function validManagedTaskBudgetAdmission(
  candidate: Extract<ManagedAgentRecord, { type: "managed_agent_admitted" }>,
  history: readonly ManagedAgentRecord[],
): boolean {
  if (!candidate.profile.endsWith(".v3"))
    return candidate.taskBudget === undefined && candidate.budgetSourceAgentId === undefined;
  const budget = candidate.taskBudget;
  if (budget === undefined) return false;
  const admissions = history.flatMap((record) =>
    record.type === "managed_agent_admitted" && record.parentSessionId === candidate.parentSessionId
      ? [record]
      : [],
  );
  const policies = admissions.flatMap((record) =>
    record.taskBudget === undefined ? [] : [record.taskBudget],
  );
  const previous = admissions.findLast((record) => record.agentId === candidate.agentId);
  if (previous !== undefined)
    return (
      previous.taskBudget !== undefined &&
      previous.budgetSourceAgentId === candidate.budgetSourceAgentId &&
      taskBudgetContinues(
        latestTaskBudget(previous.taskBudget, policies),
        budget,
        digest(`${candidate.parentSessionId}:${candidate.parentToolCallId}`),
      )
    );
  if (candidate.budgetSourceAgentId !== undefined) {
    const source = admissions.findLast(
      (record) => record.agentId === candidate.budgetSourceAgentId,
    );
    return (
      source?.taskBudget?.mode === "limited" &&
      isDeepStrictEqual(latestTaskBudget(source.taskBudget, policies), budget)
    );
  }
  const grantId = digest(`${candidate.parentSessionId}:${candidate.parentToolCallId}`);
  return (
    budget.mode === "unbudgeted" ||
    (budget.taskId === grantId && budget.grants.length === 1 && budget.grants[0]?.id === grantId)
  );
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
  if (candidate.type === "managed_agent_provider_blocked") {
    const admission = history.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === candidate.attemptId,
    );
    if (
      admission?.type !== "managed_agent_admitted" ||
      admission.taskBudget?.mode !== "limited" ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      history.some(
        (record) =>
          record.attemptId === candidate.attemptId &&
          (record.type === "managed_agent_terminal" ||
            (record.type === "managed_agent_provider_blocked" &&
              record.source.sequence === candidate.source.sequence)),
      )
    )
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
  } else if (candidate.type === "managed_agent_provider") {
    const admission = history.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === candidate.attemptId,
    );
    const prior = history.flatMap((record) =>
      record.type === "managed_agent_provider" &&
      record.event.requestId === candidate.event.requestId
        ? [record]
        : [],
    );
    if (
      admission?.type !== "managed_agent_admitted" ||
      !admission.profile.endsWith(".v3") ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      (candidate.event.type === "provider_reserved"
        ? prior.length !== 0 ||
          history.some(
            (record) =>
              record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
          )
        : !prior.some(
            (record) =>
              record.event.type === "provider_reserved" &&
              record.attemptId === candidate.attemptId &&
              record.childSessionId === candidate.childSessionId,
          ) || prior.some((record) => record.event.type === candidate.event.type))
    )
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
  } else if (candidate.type === "managed_agent_admitted") {
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
      !validManagedTaskBudgetAdmission(candidate, history) ||
      history.some(
        (record) =>
          record.attemptId === candidate.attemptId ||
          record.childSessionId === candidate.childSessionId,
      ) ||
      (isCurrentManagedAgentProfile(candidate.profile) &&
        history.filter(
          (record) =>
            record.type === "managed_agent_admitted" &&
            record.parentSessionId === candidate.parentSessionId,
        ).length >= 16) ||
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
          (previous.usageAccountingVersion === 2 && candidate.usageAccountingVersion !== 2) ||
          previous.effectiveToolProfileDigest !== candidate.effectiveToolProfileDigest ||
          previous.skillActivationDigest !== candidate.skillActivationDigest ||
          !isDeepStrictEqual(previous.selectedSkills, candidate.selectedSkills) ||
          !isDeepStrictEqual(previous.targetIdentity, candidate.targetIdentity) ||
          !isDeepStrictEqual(previous.thinkingPolicy, candidate.thinkingPolicy) ||
          !isDeepStrictEqual(previous.repository, candidate.repository) ||
          (candidate.limits.maximumTurns ?? Number.POSITIVE_INFINITY) >
            (previous.limits.maximumTurns ?? Number.POSITIVE_INFINITY) ||
          (candidate.limits.maximumTokens !== null &&
            previous.limits.maximumTokens !== null &&
            candidate.limits.maximumTokens > previous.limits.maximumTokens) ||
          (candidate.limits.maximumDeadlineMilliseconds ?? Number.POSITIVE_INFINITY) >
            (previous.limits.maximumDeadlineMilliseconds ?? Number.POSITIVE_INFINITY) ||
          candidate.deadlineAtUnixMilliseconds !== previous.deadlineAtUnixMilliseconds ||
          !history.some(
            (record) =>
              record.type === "managed_agent_terminal" && record.attemptId === previous.attemptId,
          )))
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_parent_message_enqueued") {
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
    const expectedArgumentsDigest = digest(
      JSON.stringify({
        agentId: candidate.agentId,
        expectedRevision: candidate.expectedRevision,
        message: candidate.message,
      }),
    );
    const expectedMessageId =
      admission === undefined
        ? undefined
        : digest(
            JSON.stringify({
              parentRootId: admission.parentRootId,
              parentSessionId: admission.parentSessionId,
              attemptId: candidate.attemptId,
              callId: candidate.parentToolCallId,
              toolName: "send_agent_message",
              argumentsDigest: expectedArgumentsDigest,
              ...(candidate.sourceRunId === undefined
                ? {}
                : {
                    sourceRunId: candidate.sourceRunId,
                    sourceTurn: candidate.sourceTurn,
                    sourceProviderAttempt: candidate.sourceProviderAttempt,
                  }),
            }),
          );
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      !(
        (candidate.sourceRunId === undefined &&
          candidate.sourceTurn === undefined &&
          candidate.sourceProviderAttempt === undefined) ||
        (candidate.sourceRunId !== undefined &&
          candidate.sourceTurn !== undefined &&
          candidate.sourceProviderAttempt !== undefined)
      ) ||
      candidate.expectedRevision !==
        history.filter((record) => record.agentId === candidate.agentId).length ||
      candidate.argumentsDigest !== expectedArgumentsDigest ||
      candidate.messageId !== expectedMessageId ||
      history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      ) ||
      history.some(
        (record) =>
          record.type === "managed_agent_parent_message_enqueued" &&
          (record.messageId === candidate.messageId ||
            (record.attemptId === candidate.attemptId &&
              record.parentToolCallId === candidate.parentToolCallId &&
              record.sourceRunId === candidate.sourceRunId &&
              record.sourceTurn === candidate.sourceTurn &&
              record.sourceProviderAttempt === candidate.sourceProviderAttempt)),
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_parent_message_delivered") {
    const enqueued = history.find(
      (record) =>
        record.type === "managed_agent_parent_message_enqueued" &&
        record.messageId === candidate.messageId,
    );
    if (
      enqueued === undefined ||
      enqueued.agentId !== candidate.agentId ||
      enqueued.attemptId !== candidate.attemptId ||
      enqueued.childSessionId !== candidate.childSessionId ||
      history.some(
        (record) =>
          record.type === "managed_agent_parent_message_delivered" &&
          record.messageId === candidate.messageId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (
    candidate.type === "managed_agent_child_reported" ||
    candidate.type === "managed_agent_attention_requested"
  ) {
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
    const duplicate = history.some((record) =>
      candidate.type === "managed_agent_child_reported"
        ? record.type === "managed_agent_child_reported" &&
          (record.reportId === candidate.reportId ||
            (record.attemptId === candidate.attemptId &&
              record.childToolCallId === candidate.childToolCallId &&
              record.sourceRunId === candidate.sourceRunId &&
              record.sourceTurn === candidate.sourceTurn &&
              record.sourceProviderAttempt === candidate.sourceProviderAttempt))
        : record.type === "managed_agent_attention_requested" &&
          (record.attentionId === candidate.attentionId ||
            (record.attemptId === candidate.attemptId &&
              record.childToolCallId === candidate.childToolCallId &&
              record.sourceRunId === candidate.sourceRunId &&
              record.sourceTurn === candidate.sourceTurn &&
              record.sourceProviderAttempt === candidate.sourceProviderAttempt)),
    );
    const expectedArgumentsDigest = digest(
      JSON.stringify(
        candidate.type === "managed_agent_child_reported"
          ? { kind: candidate.kind, message: candidate.message }
          : { question: candidate.question },
      ),
    );
    const expectedEffectId =
      admission === undefined
        ? undefined
        : digest(
            JSON.stringify({
              parentRootId: admission.parentRootId,
              sourceSessionId: candidate.childSessionId,
              sourceAttemptId: candidate.attemptId,
              sourceToolCallId: candidate.childToolCallId,
              sourceRunId: candidate.sourceRunId,
              sourceTurn: candidate.sourceTurn,
              sourceProviderAttempt: candidate.sourceProviderAttempt,
              toolName:
                candidate.type === "managed_agent_child_reported"
                  ? "report_to_parent"
                  : "request_parent_input",
              argumentsDigest: expectedArgumentsDigest,
            }),
          );
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      candidate.argumentsDigest !== expectedArgumentsDigest ||
      (candidate.type === "managed_agent_child_reported"
        ? candidate.reportId !== expectedEffectId
        : candidate.effectId !== expectedEffectId) ||
      duplicate ||
      history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_parent_reply_enqueued") {
    const attention = history.find(
      (record) =>
        record.type === "managed_agent_attention_requested" &&
        record.attentionId === candidate.attentionId,
    );
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
    const expectedArgumentsDigest = digest(
      JSON.stringify({
        agentId: candidate.agentId,
        expectedRevision: candidate.expectedRevision,
        message: candidate.message,
        attentionId: candidate.attentionId,
      }),
    );
    const expectedMessageId =
      admission === undefined
        ? undefined
        : digest(
            JSON.stringify({
              parentRootId: admission.parentRootId,
              parentSessionId: admission.parentSessionId,
              attemptId: candidate.attemptId,
              callId: candidate.parentToolCallId,
              toolName: "send_agent_message",
              argumentsDigest: expectedArgumentsDigest,
              ...(candidate.sourceRunId === undefined
                ? {}
                : {
                    sourceRunId: candidate.sourceRunId,
                    sourceTurn: candidate.sourceTurn,
                    sourceProviderAttempt: candidate.sourceProviderAttempt,
                  }),
            }),
          );
    if (
      admission === undefined ||
      attention === undefined ||
      attention.agentId !== candidate.agentId ||
      attention.attemptId !== candidate.attemptId ||
      attention.childSessionId !== candidate.childSessionId ||
      !(
        (candidate.sourceRunId === undefined &&
          candidate.sourceTurn === undefined &&
          candidate.sourceProviderAttempt === undefined) ||
        (candidate.sourceRunId !== undefined &&
          candidate.sourceTurn !== undefined &&
          candidate.sourceProviderAttempt !== undefined)
      ) ||
      candidate.expectedRevision !==
        history.filter((record) => record.agentId === candidate.agentId).length ||
      candidate.argumentsDigest !== expectedArgumentsDigest ||
      candidate.messageId !== expectedMessageId ||
      history.some(
        (record) =>
          (record.type === "managed_agent_parent_reply_enqueued" &&
            (record.attentionId === candidate.attentionId ||
              (record.parentToolCallId === candidate.parentToolCallId &&
                record.sourceRunId === candidate.sourceRunId &&
                record.sourceTurn === candidate.sourceTurn &&
                record.sourceProviderAttempt === candidate.sourceProviderAttempt))) ||
          (record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId),
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_parent_reply_delivered") {
    const reply = history
      .flatMap((record) => (record.type === "managed_agent_parent_reply_enqueued" ? [record] : []))
      .find((record) => record.messageId === candidate.messageId);
    if (
      reply === undefined ||
      reply.agentId !== candidate.agentId ||
      reply.attemptId !== candidate.attemptId ||
      reply.childSessionId !== candidate.childSessionId ||
      reply.attentionId !== candidate.attentionId ||
      history.some(
        (record) =>
          record.type === "managed_agent_parent_reply_delivered" &&
          record.messageId === candidate.messageId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (candidate.type === "managed_agent_inspection_required") {
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
    if (
      admission === undefined ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      !history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      ) ||
      history.some(
        (record) =>
          record.type === "managed_agent_inspection_required" &&
          record.attemptId === candidate.attemptId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (
    candidate.type === "managed_agent_stalled" ||
    candidate.type === "managed_agent_resumed"
  ) {
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
    const latestLiveness = history.findLast(
      (record) =>
        (record.type === "managed_agent_stalled" || record.type === "managed_agent_resumed") &&
        record.attemptId === candidate.attemptId,
    );
    if (
      admission === undefined ||
      !isCurrentManagedAgentAdmission(admission) ||
      admission.agentId !== candidate.agentId ||
      admission.childSessionId !== candidate.childSessionId ||
      (candidate.type === "managed_agent_stalled" &&
        (candidate.maximumInactivityMilliseconds !==
          admission.limits.maximumInactivityMilliseconds ||
          latestLiveness?.type === "managed_agent_stalled")) ||
      (candidate.type === "managed_agent_resumed" &&
        latestLiveness?.type !== "managed_agent_stalled") ||
      history.some(
        (record) =>
          record.type === "managed_agent_terminal" && record.attemptId === candidate.attemptId,
      )
    ) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  } else if (
    candidate.type === "managed_agent_deadline_expired" ||
    candidate.type === "managed_agent_cancel_requested"
  ) {
    const admission = history
      .flatMap((record) => (record.type === "managed_agent_admitted" ? [record] : []))
      .find((record) => record.attemptId === candidate.attemptId);
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

/** Checks retained child evidence without repairing, replaying or rewriting history. */
export function validateHistoricalManagedAgentChildHistory(input: {
  readonly admission: Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }>;
  readonly terminal?: Extract<ManagedAgentRecord, { readonly type: "managed_agent_terminal" }>;
  readonly records: readonly SessionRecord[];
}): boolean {
  const { admission, terminal, records } = input;
  const genesis = records[0];
  if (genesis?.schemaVersion !== 3 || genesis.record.type !== "session_genesis") return false;
  const identity = genesis.record;
  const profile =
    admission.profile === "reviewer.v1" &&
    admission.profileDigest === reviewerManagedAgentProfileV2.digest
      ? reviewerManagedAgentProfileV2
      : managedAgentProfile(admission.profile);
  const context = identity.promptContext;
  const names = context?.toolProfile.definitions.map(({ name }) => name);
  const allowed = new Set<string>(
    isResearchManagedAgentProfile(admission.profile) || admission.profile === "reviewer.v1"
      ? profile.toolNames
      : ["read_file", "search_repository", "report_to_parent", "request_parent_input"],
  );
  const validTools =
    admission.profile === "reviewer.v1"
      ? names?.length === 0
      : names?.includes("read_file") === true &&
        names.includes("search_repository") &&
        names.every((name) => allowed.has(name));
  const selectedSkills = identity.skillContext?.active.map((activation) => ({
    qualifiedId: activation.qualifiedId,
    skillMdDigest: activation.skillMdDigest,
    manifestDigest: activation.manifest.digest,
  }));
  if (
    identity.sessionId !== admission.childSessionId ||
    identity.projectId !== admission.projectId ||
    admission.parentRootId !== `session:${admission.parentSessionId}` ||
    !isDeepStrictEqual(identity.targetIdentity, admission.targetIdentity) ||
    admission.profileDigest !== profile.digest ||
    !managedAdmissionLimitsAreValid(admission, identity.contextProfile?.contextWindowTokens) ||
    !validTools ||
    (admission.effectiveToolProfileDigest !== undefined &&
      context?.toolProfile.digest !== admission.effectiveToolProfileDigest) ||
    !isDeepStrictEqual(selectedSkills, admission.selectedSkills) ||
    (admission.skillActivationDigest === undefined
      ? identity.skillContext !== undefined
      : identity.skillContext?.activationDigest !== admission.skillActivationDigest) ||
    (admission.repository === undefined
      ? (context?.repository.sources.length ?? 0) !== 0
      : context?.repository.revision !== admission.repository.revision ||
        context.repository.effectiveDigest !== admission.repository.effectiveDigest)
  )
    return false;
  const logicalRun = records.find(
    (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
  );
  if (
    logicalRun?.schemaVersion === 3 &&
    logicalRun.record.type === "logical_run_started" &&
    (digest(logicalRun.record.userMessage) !== admission.childInputDigest ||
      !isDeepStrictEqual(logicalRun.record.thinkingPolicy, admission.thinkingPolicy) ||
      !isDeepStrictEqual(
        logicalRun.record.limits,
        admission.limits.maximumTurns === undefined
          ? admission.limits.maximumTokens === null
            ? {}
            : { maxTokens: admission.limits.maximumTokens }
          : { maxTurns: admission.limits.maximumTurns, maxTokens: admission.limits.maximumTokens },
      ))
  )
    return false;
  return (
    terminal === undefined ||
    (terminal.agentId === admission.agentId &&
      terminal.attemptId === admission.attemptId &&
      terminal.childSessionId === admission.childSessionId &&
      (!("transcriptDigest" in terminal) ||
        terminal.transcriptDigest === undefined ||
        (terminal.transcriptDigest === digest(JSON.stringify(records)) &&
          "throughSequence" in terminal &&
          terminal.throughSequence === records.at(-1)?.sequence)))
  );
}

export type ManagedAgentSummary = {
  readonly taskBudget?: {
    readonly policy: TaskBudget;
    readonly usage: ReturnType<typeof taskBudgetUsage>;
  };
  readonly readOnly?: true;
  readonly agentId: string;
  readonly attemptId: string;
  readonly profile: BuiltInManagedAgentProfileId;
  readonly mode: "foreground" | "background";
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  readonly status:
    | "running"
    | "permission_required"
    | "stalled"
    | "waiting_for_parent"
    | "completed"
    | "failed"
    | "cancelled"
    | "recovery_required"
    | "inspection_required";
  readonly revision: number;
  readonly phase:
    | "model"
    | "tool"
    | "permission_required"
    | "waiting_for_parent"
    | "stalled"
    | "terminal";
  readonly activeTool?: {
    readonly callId: string;
    readonly name: string;
    readonly status: "requested" | "running" | "permission_required";
  };
  readonly transcript: {
    readonly childSessionId: string;
    readonly throughSequence: number;
  };
  readonly attemptHistory: readonly {
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly status: ManagedAgentSummary["status"];
    readonly current: boolean;
    readonly throughSequence: number;
  }[];
  readonly result?:
    | { readonly text: string }
    | { readonly artifact: Pick<ArtifactReference, "id" | "mediaType" | "byteCount"> };
  readonly error?: { readonly code: string; readonly message: string };
  readonly partialOutput?: {
    readonly text: string;
    readonly byteCount: number;
    readonly truncated: boolean;
  };
  readonly attention?: {
    readonly attentionId: string;
    readonly question: string;
    readonly status: "waiting" | "orphaned";
  };
  readonly reports: readonly {
    readonly reportId: `sha256:${string}`;
    readonly kind: "progress" | "finding";
    readonly message: string;
    readonly revision: number;
    readonly messageByteCount: number;
    readonly messageTruncated: boolean;
  }[];
  readonly messages: readonly {
    readonly messageId: `sha256:${string}`;
    readonly kind: "message" | "reply";
    readonly message: string;
    readonly messageByteCount: number;
    readonly messageTruncated: boolean;
    readonly status: "enqueued" | "delivered";
    readonly revision: number;
    readonly attentionId?: string;
  }[];
  readonly resultByteCount?: number;
  readonly resultTruncated?: boolean;
  readonly context?: {
    readonly contextWindowTokens: number;
    readonly occupancy?:
      | { readonly source: "provider_reported" | "estimated"; readonly tokens: number }
      | { readonly source: "unknown" };
  };
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly providerCalls: number;
  };
  readonly budget?: {
    readonly maximumCumulativeTokens: number;
    readonly usedTokens: number;
    readonly remainingTokens: number;
  };
  readonly attempts?: {
    readonly childAttempts: number;
    readonly maximumChildAttempts: 4;
    readonly parentAttempts: number;
    readonly maximumParentAttempts: 16;
  };
  readonly watchdog?: {
    readonly state: "running" | "paused_permission" | "paused_parent" | "stalled" | "terminal";
    readonly maximumInactivityMilliseconds: 300_000;
  };
};

export type ManagedAgentSnapshot = {
  readonly counts: {
    readonly active: number;
    readonly terminal: number;
    readonly attention: number;
  };
  readonly agents: readonly ManagedAgentSummary[];
};

export function isManagedAgentActiveStatus(status: ManagedAgentSummary["status"]): boolean {
  return (
    status === "running" ||
    status === "permission_required" ||
    status === "stalled" ||
    status === "waiting_for_parent"
  );
}

export function managedAgentSnapshotFromRecords(
  records: readonly ManagedAgentRecord[],
  parentSessionId: string,
): ManagedAgentSnapshot {
  const admissions = records.filter(
    (
      record,
    ): record is Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }> & {
      readonly profile: BuiltInManagedAgentProfileId;
    } =>
      record.type === "managed_agent_admitted" &&
      record.profile !== "reviewer.v1" &&
      record.parentSessionId === parentSessionId,
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
    const inspection = records.findLast(
      (record) =>
        record.type === "managed_agent_inspection_required" &&
        record.attemptId === admission.attemptId,
    );
    const latestLiveness = records.findLast(
      (record) =>
        (record.type === "managed_agent_stalled" || record.type === "managed_agent_resumed") &&
        record.attemptId === admission.attemptId,
    );
    const attention = records
      .flatMap((record) =>
        record.type === "managed_agent_attention_requested" &&
        record.attemptId === admission.attemptId
          ? [record]
          : [],
      )
      .findLast(
        (record) =>
          !records.some(
            (candidate) =>
              candidate.type === "managed_agent_parent_reply_enqueued" &&
              candidate.attentionId === record.attentionId,
          ),
      );
    const reports = records
      .flatMap((record) =>
        record.type === "managed_agent_child_reported" && record.attemptId === admission.attemptId
          ? [record]
          : [],
      )
      .slice(-4)
      .map((record) => {
        const messageByteCount = Buffer.byteLength(record.message, "utf8");
        return {
          reportId: record.reportId,
          kind: record.kind,
          message: boundedUtf8Prefix(record.message, 512),
          revision: record.sequence,
          messageByteCount,
          messageTruncated: messageByteCount > 512,
        };
      });
    const messages = records
      .flatMap((record) =>
        (record.type === "managed_agent_parent_message_enqueued" ||
          record.type === "managed_agent_parent_reply_enqueued") &&
        record.agentId === admission.agentId
          ? [record]
          : [],
      )
      .slice(-4)
      .map((record) => {
        const messageByteCount = Buffer.byteLength(record.message, "utf8");
        return {
          messageId: record.messageId,
          kind:
            record.type === "managed_agent_parent_reply_enqueued"
              ? ("reply" as const)
              : ("message" as const),
          message: boundedUtf8Prefix(record.message, 512),
          messageByteCount,
          messageTruncated: messageByteCount > 512,
          status: records.some(
            (candidate) =>
              (candidate.type === "managed_agent_parent_message_delivered" ||
                candidate.type === "managed_agent_parent_reply_delivered") &&
              candidate.messageId === record.messageId,
          )
            ? ("delivered" as const)
            : ("enqueued" as const),
          revision: record.sequence,
          ...(record.type === "managed_agent_parent_reply_enqueued"
            ? { attentionId: record.attentionId }
            : {}),
        };
      });
    const identityAdmissions = admissions.filter(
      (candidate) => candidate.agentId === admission.agentId,
    );
    const currentProfile = isCurrentManagedAgentProfile(admission.profile);
    let currentUsage = records.reduce(
      (total, record) => {
        if (
          record.type !== "managed_agent_terminal" ||
          record.status !== "completed" ||
          !identityAdmissions.some((candidate) => candidate.attemptId === record.attemptId)
        ) {
          return total;
        }
        return {
          inputTokens: total.inputTokens + record.usage.inputTokens,
          outputTokens: total.outputTokens + record.usage.outputTokens,
          reasoningTokens: total.reasoningTokens + record.usage.reasoningTokens,
          providerCalls: total.providerCalls + (record.providerCalls ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, providerCalls: 0 },
    );
    const admittedBudget = admission.taskBudget;
    const taskEvents = records.flatMap((record) =>
      record.type === "managed_agent_provider" &&
      identityAdmissions.some((entry) => entry.attemptId === record.attemptId)
        ? [record.event]
        : [],
    );
    const taskPolicy =
      admittedBudget === undefined
        ? undefined
        : latestTaskBudget(
            admittedBudget,
            admissions.flatMap((entry) =>
              entry.taskBudget === undefined ? [] : [entry.taskBudget],
            ),
          );
    const budgetMembers = new Set(
      admissions.flatMap((record) =>
        taskPolicy?.mode === "limited" &&
        record.taskBudget?.mode === "limited" &&
        record.taskBudget.taskId === taskPolicy.taskId
          ? [record.attemptId]
          : [],
      ),
    );
    const budgetEvents =
      taskPolicy?.mode === "limited"
        ? records.flatMap((record) =>
            record.type === "managed_agent_provider" && budgetMembers.has(record.attemptId)
              ? [record.event]
              : [],
          )
        : taskEvents;
    if (taskPolicy !== undefined) {
      currentUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, providerCalls: 0 };
      for (const event of taskEvents) {
        if (event.type === "provider_usage") {
          currentUsage.inputTokens += event.inputTokens;
          currentUsage.outputTokens += event.outputTokens;
          currentUsage.reasoningTokens += event.reasoningTokens;
        } else if (event.type === "provider_reserved") currentUsage.providerCalls += 1;
      }
    }
    const maximumCumulativeTokens = identityAdmissions[0]?.limits.maximumTokens;
    const usedTokens = currentUsage.inputTokens + currentUsage.outputTokens;
    const projectedStatus =
      inspection?.type === "managed_agent_inspection_required"
        ? "inspection_required"
        : terminal?.type === "managed_agent_terminal"
          ? terminal.status
          : attention === undefined
            ? latestLiveness?.type !== "managed_agent_stalled"
              ? "running"
              : "stalled"
            : "waiting_for_parent";
    const attemptHistory = identityAdmissions.map((attemptAdmission) => {
      const attemptTerminal = records.find(
        (record) =>
          record.type === "managed_agent_terminal" &&
          record.attemptId === attemptAdmission.attemptId,
      );
      const attemptInspection = records.findLast(
        (record) =>
          record.type === "managed_agent_inspection_required" &&
          record.attemptId === attemptAdmission.attemptId,
      );
      const current = attemptAdmission.attemptId === admission.attemptId;
      const status: ManagedAgentSummary["status"] = current
        ? projectedStatus
        : attemptInspection?.type === "managed_agent_inspection_required"
          ? "inspection_required"
          : attemptTerminal?.type === "managed_agent_terminal"
            ? attemptTerminal.status
            : "recovery_required";
      return {
        attemptId: attemptAdmission.attemptId,
        childSessionId: attemptAdmission.childSessionId,
        status,
        current,
        throughSequence:
          attemptTerminal?.type === "managed_agent_terminal" &&
          "throughSequence" in attemptTerminal &&
          attemptTerminal.throughSequence !== undefined
            ? attemptTerminal.throughSequence
            : 0,
      };
    });
    return {
      agentId: admission.agentId,
      attemptId: admission.attemptId,
      profile: admission.profile,
      mode: admission.mode ?? "foreground",
      targetIdentity: admission.targetIdentity,
      ...(admission.thinkingPolicy === undefined
        ? {}
        : { thinkingPolicy: admission.thinkingPolicy }),
      status: projectedStatus,
      revision,
      phase:
        projectedStatus === "stalled"
          ? "stalled"
          : projectedStatus === "waiting_for_parent"
            ? "waiting_for_parent"
            : isManagedAgentActiveStatus(projectedStatus)
              ? "model"
              : "terminal",
      transcript: {
        childSessionId: admission.childSessionId,
        throughSequence:
          terminal?.type === "managed_agent_terminal" &&
          "throughSequence" in terminal &&
          terminal.throughSequence !== undefined
            ? terminal.throughSequence
            : 0,
      },
      attemptHistory,
      reports,
      messages,
      ...(inspection !== undefined ||
      terminal?.type !== "managed_agent_terminal" ||
      terminal.status !== "completed"
        ? {}
        : { result: terminal.result }),
      ...(inspection?.type === "managed_agent_inspection_required"
        ? { error: inspection.error }
        : terminal?.type !== "managed_agent_terminal" ||
            terminal.status === "completed" ||
            terminal.status === "cancelled"
          ? {}
          : { error: terminal.error }),
      ...(terminal?.type === "managed_agent_terminal" &&
      (terminal.status === "failed" || terminal.status === "recovery_required") &&
      terminal.partialOutput !== undefined
        ? { partialOutput: terminal.partialOutput }
        : {}),
      ...(attention === undefined
        ? {}
        : {
            attention: {
              attentionId: attention.attentionId,
              question: attention.question,
              status: terminal === undefined ? ("waiting" as const) : ("orphaned" as const),
            },
          }),
      ...(currentProfile && maximumCumulativeTokens !== undefined
        ? {
            ...(taskPolicy === undefined
              ? {}
              : {
                  taskBudget: {
                    policy: taskPolicy,
                    usage: taskBudgetUsage(taskPolicy, budgetEvents),
                  },
                }),
            context: {
              contextWindowTokens:
                identityAdmissions[0]?.limits.contextWindowTokens ??
                identityAdmissions[0]?.limits.maximumTokens ??
                0,
            },
            usage: currentUsage,
            ...(maximumCumulativeTokens === null
              ? {}
              : {
                  budget: {
                    maximumCumulativeTokens,
                    usedTokens,
                    remainingTokens: Math.max(0, maximumCumulativeTokens - usedTokens),
                  },
                }),
            attempts: {
              childAttempts: identityAdmissions.length,
              maximumChildAttempts: 4 as const,
              parentAttempts: admissions.length,
              maximumParentAttempts: 16 as const,
            },
            watchdog: {
              state:
                projectedStatus === "stalled"
                  ? ("stalled" as const)
                  : projectedStatus === "waiting_for_parent"
                    ? ("paused_parent" as const)
                    : projectedStatus === "running"
                      ? ("running" as const)
                      : ("terminal" as const),
              maximumInactivityMilliseconds: 300_000 as const,
            },
          }
        : {}),
    };
  });
  return {
    counts: {
      active: agents.filter((agent) => isManagedAgentActiveStatus(agent.status)).length,
      terminal: agents.filter((agent) => !isManagedAgentActiveStatus(agent.status)).length,
      attention: agents.filter(
        (agent) => agent.status === "stalled" || agent.status === "waiting_for_parent",
      ).length,
    },
    agents,
  };
}

export async function managedAgentSnapshotWithChildHistories(input: {
  readonly records: readonly ManagedAgentRecord[];
  readonly parentSessionId: string;
  readonly childSessionStores: SessionStoreDirectory<SessionRecord>;
  readonly permissionRequired?: (agentId: string) => boolean;
  readonly watchdogState?: (
    attemptId: string,
  ) => "running" | "paused_permission" | "paused_parent" | "stalled" | undefined;
}): Promise<ManagedAgentSnapshot> {
  const snapshot = managedAgentSnapshotFromRecords(input.records, input.parentSessionId);
  const agents = await Promise.all(
    snapshot.agents.map(async (agent) => {
      const admissions = input.records.flatMap((record) =>
        record.type === "managed_agent_admitted" && record.agentId === agent.agentId
          ? [record]
          : [],
      );
      const histories = await Promise.all(
        admissions.map(async (admission) => {
          try {
            const store = await input.childSessionStores.open(admission.childSessionId);
            return (await store?.read()) ?? [];
          } catch {
            return undefined;
          }
        }),
      );
      const validHistories = admissions.map((admission, index) => {
        const records = histories[index];
        const terminal = input.records.find(
          (record): record is Extract<ManagedAgentRecord, { type: "managed_agent_terminal" }> =>
            record.type === "managed_agent_terminal" && record.attemptId === admission.attemptId,
        );
        return (
          records !== undefined &&
          validateHistoricalManagedAgentChildHistory({
            admission,
            records,
            ...(terminal === undefined ? {} : { terminal }),
          })
        );
      });
      if (validHistories.some((valid) => !valid)) {
        const { result: _result, ...retained } = agent;
        return {
          ...retained,
          readOnly: true as const,
          status: "inspection_required" as const,
          phase: "terminal" as const,
          error: {
            code: "managed_agent_inspection_required",
            message:
              "The retained child history does not match its exact admission or terminal evidence.",
          },
          attemptHistory: agent.attemptHistory.map((attempt, index) => ({
            ...attempt,
            ...(validHistories[index] ? {} : { status: "inspection_required" as const }),
          })),
        };
      }
      const currentHistory = histories.at(-1);
      const activeTool = currentManagedAgentTool(currentHistory ?? []);
      const occupancy = currentManagedAgentContextOccupancy(currentHistory ?? []);
      const partialOutput = agent.partialOutput;
      const transcript = {
        ...agent.transcript,
        throughSequence: currentHistory?.at(-1)?.sequence ?? agent.transcript.throughSequence,
      };
      const permissionRequired = input.permissionRequired?.(agent.agentId) ?? false;
      const status =
        permissionRequired && isManagedAgentActiveStatus(agent.status)
          ? ("permission_required" as const)
          : agent.status;
      const attemptHistory = agent.attemptHistory.map((attempt, index) => ({
        ...attempt,
        throughSequence: histories[index]?.at(-1)?.sequence ?? attempt.throughSequence,
        ...(attempt.current ? { status } : {}),
      }));
      const phase =
        status === "permission_required"
          ? ("permission_required" as const)
          : status === "stalled"
            ? ("stalled" as const)
            : status === "waiting_for_parent"
              ? ("waiting_for_parent" as const)
              : !isManagedAgentActiveStatus(status)
                ? ("terminal" as const)
                : activeTool === undefined
                  ? ("model" as const)
                  : ("tool" as const);
      const projectedActiveTool =
        activeTool === undefined
          ? {}
          : {
              activeTool: {
                ...activeTool,
                status:
                  status === "permission_required"
                    ? ("permission_required" as const)
                    : activeTool.status,
              },
            };
      const projectedPartialOutput =
        partialOutput === undefined || (status !== "failed" && status !== "recovery_required")
          ? {}
          : { partialOutput };
      const liveWatchdogState = input.watchdogState?.(agent.attemptId);
      const watchdog =
        liveWatchdogState === undefined || agent.watchdog === undefined
          ? {}
          : { watchdog: { ...agent.watchdog, state: liveWatchdogState } };
      const context =
        agent.context === undefined
          ? {}
          : {
              context: {
                ...agent.context,
                ...(occupancy === undefined ? {} : { occupancy }),
              },
            };
      const usage = histories.reduce(
        (total, history) => {
          const next = usageFromChildRecords(history ?? []);
          return {
            inputTokens: total.inputTokens + next.inputTokens,
            outputTokens: total.outputTokens + next.outputTokens,
            reasoningTokens: total.reasoningTokens + next.reasoningTokens,
            providerCalls: total.providerCalls + providerCallsFromChildRecords(history ?? []),
          };
        },
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, providerCalls: 0 },
      );
      const usedTokens = usage.inputTokens + usage.outputTokens;
      return {
        ...agent,
        status,
        phase,
        transcript,
        attemptHistory,
        ...projectedActiveTool,
        ...projectedPartialOutput,
        ...context,
        ...(agent.usage === undefined || agent.taskBudget !== undefined ? {} : { usage }),
        ...(agent.budget === undefined
          ? {}
          : {
              budget: {
                ...agent.budget,
                usedTokens,
                remainingTokens: Math.max(0, agent.budget.maximumCumulativeTokens - usedTokens),
              },
            }),
        ...watchdog,
      };
    }),
  );
  const historicalAgents = agents.map((agent) => ({
    ...agent,
    readOnly: true as const,
    ...(isManagedAgentActiveStatus(agent.status)
      ? { status: "recovery_required" as const, phase: "terminal" as const }
      : {}),
  }));
  return {
    agents: historicalAgents,
    counts: { active: 0, terminal: historicalAgents.length, attention: 0 },
  };
}

export type ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): { cancel(): void };
};

export type ManagedAgentInactivityScheduler = {
  schedule(delayMilliseconds: number, onInactivity: () => void): { cancel(): void };
};

export const nodeManagedAgentDeadlineScheduler: ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds, onDeadline) {
    const timer = setTimeout(onDeadline, delayMilliseconds);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export function createHistoricalManagedAgentToolRegistry(options: {
  readonly history?: {
    readonly parentSessionId: string;
    read(): Promise<ManagedAgentSnapshot>;
  };
  readonly profile?:
    | "managed-agent-tools.a1.v1"
    | "managed-agent-tools.a2-long-lived.v1"
    | "managed-agent-tools.a3-long-lived.v1"
    | "managed-agent-tools.a1.v2"
    | "managed-agent-tools.a2-long-lived.v2"
    | "managed-agent-tools.a3-long-lived.v2"
    | "managed-agent-tools.a3-long-lived.v3"
    | "managed-agent-tools.a1.v3";
}): ToolRegistry {
  const profile = options.profile ?? "managed-agent-tools.a1.v1";
  const taskBudgetProfile = profile.endsWith(".v3");
  const current = profile.endsWith(".v2") || taskBudgetProfile;
  const a3 = profile.includes(".a3-long-lived.");
  const a2 = profile.includes(".a2-long-lived.");
  const listSchema = current ? managedAgentListSchemaV2 : managedAgentListSchemaV1;
  const spawnSchema = a3
    ? current
      ? taskBudgetProfile
        ? managedAgentA3SpawnSchemaV3
        : managedAgentA3SpawnSchemaV2
      : managedAgentA3SpawnSchema
    : a2
      ? managedAgentA2SpawnSchema
      : taskBudgetProfile
        ? managedAgentTaskSchemaV3
        : managedAgentTaskSchema;
  const adapter = createInternalToolAdapter(
    {
      definition: {
        name: "spawn_agent",
        description: a3
          ? "Start one single-level managed child with a code-owned non-mutating profile. The child cannot spawn peers, write or execute, inherit ambient extensions, or change its model or permissions."
          : a2
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
          profile: z.enum([
            "scout.v1",
            "scout.v2",
            "scout.v3",
            "research.v1",
            "research.v2",
            "research.v3",
          ]),
          profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          effectiveToolProfileDigest: z
            .string()
            .regex(/^sha256:[0-9a-f]{64}$/u)
            .optional(),
          skillActivationDigest: z
            .string()
            .regex(/^sha256:[0-9a-f]{64}$/u)
            .optional(),
          mode: z.literal("background"),
          status: z.literal("running"),
          revision: z.number().int().positive(),
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
        return toolFailure(
          "managed_agent_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
      },
    },
    "never",
  );
  if (!a2 && !a3) {
    return createInternalToolRegistry([adapter]);
  }
  const listAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "list_agents",
        description:
          "List bounded managed-child status and result summaries for this exact parent session.",
        inputSchema: z.toJSONSchema(listSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "read",
      cancellation: "unsupported",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson, identity) {
        const parsed = listSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        const history = options.history;
        if (
          history === undefined ||
          (identity !== undefined && identity.sessionId !== history.parentSessionId)
        )
          return toolFailure(
            "managed_agent_unavailable",
            "Historical agent reads require their exact parent Session.",
          );
        const cursor = parsed.data.cursor;
        const offset =
          cursor === undefined
            ? 0
            : /^managed-agent:(?:0|[1-9][0-9]*)$/u.test(cursor)
              ? Number(cursor.slice("managed-agent:".length))
              : -1;
        if (!Number.isSafeInteger(offset) || offset < 0)
          return toolFailure("invalid_tool_input", "The managed-child list cursor is invalid.");
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "list",
            parentRootId: `session:${history.parentSessionId}`,
            parentSessionId: history.parentSessionId,
          },
          async execute(context) {
            if (context.sessionId !== history.parentSessionId)
              return toolFailure(
                "managed_agent_unavailable",
                "Historical agent reads require their exact parent Session.",
              );
            const snapshot = await history.read();
            const filtered = snapshot.agents.filter((agent) => {
              const status = parsed.data.status;
              if (status === undefined) return true;
              if (status === "active") return isManagedAgentActiveStatus(agent.status);
              if (status === "terminal") return !isManagedAgentActiveStatus(agent.status);
              return agent.status === status;
            });
            if (offset > filtered.length)
              return toolFailure(
                "invalid_tool_input",
                "The managed-child list cursor is outside this historical result.",
              );
            const available = filtered.slice(offset, offset + (parsed.data.limit ?? 8));
            for (let count = available.length; count >= 0; count--) {
              const agents = boundedHistoricalManagedAgentList(available.slice(0, count));
              const nextOffset = offset + count;
              const output = {
                ...snapshot,
                agents,
                nextCursor: nextOffset < filtered.length ? `managed-agent:${nextOffset}` : null,
              };
              if (
                Buffer.byteLength(JSON.stringify(output), "utf8") <= maximumManagedAgentResultBytes
              )
                return count === 0 && available.length > 0
                  ? toolFailure(
                      "managed_agent_result_too_large",
                      "The historical child summary exceeds the bounded list envelope. Inspect its retained transcript.",
                    )
                  : { status: "completed", output };
            }
            return toolFailure(
              "managed_agent_result_too_large",
              "The historical child list exceeds its result envelope.",
            );
          },
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
        return toolFailure(
          "managed_agent_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
      },
    },
    "never",
  );
  const waitAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "wait_agents",
        description: a3
          ? "Wait causally for selected managed children to reach terminal state or request parent attention. Cancelling this wait does not cancel a child."
          : "Wait causally for selected managed children to reach terminal state. Cancelling this wait does not cancel a child.",
        inputSchema: z.toJSONSchema(a3 ? managedAgentA3WaitSchema : managedAgentWaitSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "read",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson) {
        const parsed = (a3 ? managedAgentA3WaitSchema : managedAgentWaitSchema).safeParse(
          parseJson(argumentsJson),
        );
        if (!parsed.success || new Set(parsed.data.agentIds).size !== parsed.data.agentIds.length) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return toolFailure(
          "managed_agent_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
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
        return toolFailure(
          "managed_agent_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
      },
    },
    "never",
  );
  const sendAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "send_agent_message",
        description:
          "Queue one bounded parent message for an active child. A waiting child requires its exact attention ID; enqueued or delivered does not mean the child followed it.",
        inputSchema: z.toJSONSchema(managedAgentSendSchema),
      },
      outputSchema: z.custom<JsonValue>(),
      effect: "delegate",
      cancellation: "unsupported",
      maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
      prepare(argumentsJson, identity) {
        const parsed = managedAgentSendSchema.safeParse(parseJson(argumentsJson));
        if (
          !parsed.success ||
          identity?.runId === undefined ||
          identity.turn === undefined ||
          identity.attempt === undefined
        ) {
          return toolFailure("invalid_tool_input", "Tool input is invalid.");
        }
        return toolFailure(
          "managed_agent_unavailable",
          "Historical agent controls are read-only. Start a new current Session to delegate work.",
        );
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
    ...(a3 ? [sendAdapter] : []),
  ]);
}

function boundedHistoricalManagedAgentList(
  agents: readonly ManagedAgentSummary[],
): readonly ManagedAgentSummary[] {
  const maximumTextBytes = Math.floor((10 * 1024) / Math.max(1, agents.length));
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

function providerCallsFromChildRecords(records: readonly SessionRecord[]): number {
  return records.filter(
    (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
  ).length;
}

function currentManagedAgentContextOccupancy(
  records: readonly SessionRecord[],
):
  | { readonly source: "provider_reported" | "estimated"; readonly tokens: number }
  | { readonly source: "unknown" }
  | undefined {
  const active = contextUsageSnapshotFromRecords(records)?.active;
  if (active === undefined || active.source === "unknown") {
    return active === undefined ? undefined : { source: "unknown" };
  }
  return { source: active.source, tokens: active.tokens };
}

function currentManagedAgentTool(
  records: readonly SessionRecord[],
): ManagedAgentSummary["activeTool"] {
  const active = new Map<
    string,
    { readonly callId: string; readonly name: string; status: "requested" | "running" }
  >();
  for (const record of records) {
    const event =
      record.schemaVersion === 1 || record.schemaVersion === 2
        ? record.event
        : record.record.type === "runtime_event"
          ? record.record.event
          : undefined;
    if (event?.type === "tool_requested") {
      active.set(event.callId, { callId: event.callId, name: event.name, status: "requested" });
    } else if (event?.type === "tool_started") {
      const existing = active.get(event.callId);
      active.set(event.callId, {
        callId: event.callId,
        name: existing?.name ?? event.name,
        status: "running",
      });
    } else if (event?.type === "tool_completed" || event?.type === "tool_failed") {
      active.delete(event.callId);
    }
  }
  return [...active.values()].at(-1);
}

function toolFailure(
  code: "invalid_tool_input" | "managed_agent_unavailable" | "managed_agent_result_too_large",
  message: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
}
