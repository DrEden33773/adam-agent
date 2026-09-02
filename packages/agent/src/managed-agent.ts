import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { AgentSession, managedAgentRequestBoundary } from "./agent-session.js";
import type {
  ModelDriver,
  ModelMessage,
  PermissionDecisionCommand,
  PermissionDecisionCommandResult,
  RuntimeEvent,
} from "./agent-session-contracts.js";
import type { ArtifactReference, ArtifactStore } from "./artifact-store.js";
import type { ContextProfile } from "./context-profile.js";
import {
  researchManagedAgentProfileV1,
  researchManagedAgentProfileV2,
  reviewerManagedAgentProfileV1,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
} from "./managed-agent-profiles.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { ProjectExecutionRootClaim } from "./project-execution-domain.js";
import {
  assemblePromptMessagesV1,
  createPromptContextV1,
  createPromptContextV2,
  digestPromptRequestV1,
  type PromptContextRecord,
} from "./prompt-assembly.js";
import {
  type AgentSessionDurableContext,
  sessionDurableContext,
} from "./session-durable-context.js";
import { modelMessagesFromCompleteRecords } from "./session-history-replay.js";
import type { SessionRecord, SessionStore, SessionStoreDirectory } from "./session-store.js";
import type { SkillContextRecordV1 } from "./skills.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  createReadToolRegistry,
  type JsonValue,
  type PermissionPolicy,
  type ToolAdapter,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";

const maximumManagedAgentTaskBytes = 16 * 1024;
const maximumManagedAgentMessageBytes = 8 * 1024;
const maximumManagedAgentReportsPerAttempt = 16;
const maximumManagedAgentResultBytes = 16 * 1024;
const childLiveWorkspaceNotice =
  "This child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.";
type BuiltInManagedAgentProfileId = "scout.v1" | "scout.v2" | "research.v1" | "research.v2";
type ManagedAgentProfileId = "reviewer.v1" | BuiltInManagedAgentProfileId;

function isResearchManagedAgentProfile(
  profile: ManagedAgentProfileId,
): profile is "research.v1" | "research.v2" {
  return profile === "research.v1" || profile === "research.v2";
}

function isCurrentManagedAgentProfile(
  profile: ManagedAgentProfileId,
): profile is "scout.v2" | "research.v2" {
  return profile === "scout.v2" || profile === "research.v2";
}

function managedAgentProfile(profile: ManagedAgentProfileId) {
  return profile === "research.v2"
    ? researchManagedAgentProfileV2
    : profile === "scout.v2"
      ? scoutManagedAgentProfileV2
      : profile === "research.v1"
        ? researchManagedAgentProfileV1
        : profile === "reviewer.v1"
          ? reviewerManagedAgentProfileV1
          : scoutManagedAgentProfileV1;
}

function managedAdmissionLimitsAreValid(
  admission: Extract<ManagedAgentRecord, { readonly type: "managed_agent_admitted" }>,
  contextWindowTokens?: number,
): boolean {
  if (isCurrentManagedAgentProfile(admission.profile)) {
    const profile =
      admission.profile === "research.v2"
        ? researchManagedAgentProfileV2
        : scoutManagedAgentProfileV2;
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
const managedAgentListSchema = z.strictObject({
  status: z
    .enum([
      "active",
      "terminal",
      "running",
      "stalled",
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
const managedAgentReportSchema = z.strictObject({
  kind: z.enum(["progress", "finding"]),
  message: z
    .string()
    .min(1)
    .refine((message) => Buffer.byteLength(message, "utf8") <= maximumManagedAgentMessageBytes),
});
const managedAgentRequestParentInputSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .refine((question) => Buffer.byteLength(question, "utf8") <= maximumManagedAgentMessageBytes),
});
const managedRecordReceiptSchema = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
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
  profile: z.enum(["reviewer.v1", "scout.v1", "scout.v2", "research.v1", "research.v2"]),
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
      readonly effectiveToolProfileDigest?: `sha256:${string}`;
      readonly skillActivationDigest?: `sha256:${string}`;
      readonly selectedSkills?: readonly {
        readonly qualifiedId: string;
        readonly skillMdDigest: `sha256:${string}`;
        readonly manifestDigest: `sha256:${string}`;
      }[];
      readonly limits: {
        readonly maximumTurns?: number;
        readonly maximumTokens: number;
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

class ManagedAgentCapacityError extends Error {}

const managedAgentRecordSchema = z.union([
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
    profile: z.enum(["reviewer.v1", "scout.v1", "scout.v2", "research.v1", "research.v2"]),
    mode: z.enum(["foreground", "background"]).optional(),
    profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    usageAccountingVersion: z.literal(2).optional(),
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
      maximumTokens: z.number().int().positive().safe(),
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

export async function recoverInterruptedManagedAgents(
  store: ManagedAgentStore,
  childSessionStores?: SessionStoreDirectory<SessionRecord>,
  artifactStore?: ArtifactStore,
  parentSessionId?: string,
  now: () => number = Date.now,
  parentRecords?: readonly SessionRecord[],
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
      (parentSessionId !== undefined && admission.parentSessionId !== parentSessionId)
    ) {
      continue;
    }
    const existingTerminal = records.find(
      (record) =>
        record.type === "managed_agent_terminal" && record.attemptId === admission.attemptId,
    );
    if (admission.profile === "reviewer.v1") {
      continue;
    }
    const childStore = await childSessionStores?.open(admission.childSessionId);
    const childRecords = await childStore?.read();
    const genesis = childRecords?.[0];
    const repository =
      genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
        ? genesis.record.promptContext?.repository
        : undefined;
    const managedProfile = managedAgentProfile(admission.profile);
    const genesisPromptContext =
      genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
        ? genesis.record.promptContext
        : undefined;
    const expectedPromptContext =
      admission.effectiveToolProfileDigest !== undefined
        ? genesisPromptContext
        : repository === undefined
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
      admission.profileDigest === managedProfile.digest &&
      managedAdmissionLimitsAreValid(
        admission,
        genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
          ? genesis.record.contextProfile?.contextWindowTokens
          : undefined,
      );
    const childCoordinationEvents = (childRecords ?? []).flatMap((record) => {
      const event =
        record.schemaVersion === 1 || record.schemaVersion === 2
          ? record.event
          : record.record.type === "runtime_event"
            ? record.record.event
            : undefined;
      return event === undefined ? [] : [{ event, sequence: record.sequence }];
    });
    const providerDeliveryLinks = (childRecords ?? []).flatMap((record) =>
      record.schemaVersion === 3 && record.record.type === "provider_attempt_started"
        ? (record.record.managedAgentDeliveries ?? [])
        : [],
    );
    const outputString = (output: JsonValue, key: string): string | undefined => {
      if (output === null || typeof output !== "object" || Array.isArray(output)) {
        return undefined;
      }
      const object = output as { readonly [key: string]: JsonValue };
      return typeof object[key] === "string" ? object[key] : undefined;
    };
    const outputReceipt = (
      output: JsonValue,
      key: string,
    ): { readonly id: string; readonly revision: number; readonly digest: string } | undefined => {
      if (output === null || typeof output !== "object" || Array.isArray(output)) {
        return undefined;
      }
      const value = (output as { readonly [key: string]: JsonValue })[key];
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const parsed = managedRecordReceiptSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    };
    const ordinaryReceipts = childCoordinationEvents.flatMap(({ event, sequence }) => {
      if (event.type !== "user_message") {
        return [];
      }
      const match = /Parent message \((sha256:[0-9a-f]{64})\):/u.exec(event.text);
      return match?.[1] === undefined ? [] : [{ id: match[1], sequence, text: event.text }];
    });
    const completedCoordination = childCoordinationEvents.flatMap(({ event, sequence }) =>
      event.type === "tool_completed" &&
      (event.name === "report_to_parent" || event.name === "request_parent_input")
        ? [{ event, sequence }]
        : [],
    );
    const parentSendResults = (parentRecords ?? []).flatMap((record) => {
      const event =
        record.schemaVersion === 1 || record.schemaVersion === 2
          ? record.event
          : record.record.type === "runtime_event"
            ? record.record.event
            : undefined;
      return event?.type === "tool_completed" && event.name === "send_agent_message"
        ? [event.output]
        : [];
    });
    const managerDeliveryRecords = records.flatMap((record) =>
      (record.type === "managed_agent_parent_message_enqueued" ||
        record.type === "managed_agent_parent_reply_enqueued") &&
      record.attemptId === admission.attemptId
        ? [record]
        : [],
    );
    const allManagerDeliveryRecords = records.flatMap((record) =>
      record.type === "managed_agent_parent_message_enqueued" ||
      record.type === "managed_agent_parent_reply_enqueued"
        ? [record]
        : [],
    );
    const parentSourceTruthIsValid = parentSendResults.every((output) => {
      const agentId = outputString(output, "agentId");
      const attemptId = outputString(output, "attemptId");
      const sourceReceipt = outputReceipt(output, "record");
      if (agentId === undefined || attemptId === undefined || sourceReceipt === undefined) {
        return false;
      }
      const sourceAdmission = records.find(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.agentId === agentId &&
          record.attemptId === attemptId,
      );
      const managerRecord = allManagerDeliveryRecords.find(
        (record) =>
          record.agentId === agentId &&
          record.attemptId === attemptId &&
          managedRecordReceipt(record).id === sourceReceipt.id,
      );
      return (
        sourceAdmission !== undefined &&
        managerRecord !== undefined &&
        isDeepStrictEqual(sourceReceipt, managedRecordReceipt(managerRecord))
      );
    });
    const deliveryLinksAreValid =
      new Set(providerDeliveryLinks.map((link) => link.id)).size === providerDeliveryLinks.length &&
      providerDeliveryLinks.every((link) => {
        const managerRecord = managerDeliveryRecords.find((record) => record.messageId === link.id);
        return (
          managerRecord !== undefined && managedRecordReceipt(managerRecord).digest === link.digest
        );
      });
    const coordinationSourceIsValid =
      deliveryLinksAreValid &&
      parentSourceTruthIsValid &&
      ordinaryReceipts.every(({ id, text }) => {
        const managerRecord = managerDeliveryRecords.find(
          (record) =>
            record.type === "managed_agent_parent_message_enqueued" && record.messageId === id,
        );
        return (
          managerRecord !== undefined &&
          text === `Parent message (${managerRecord.messageId}): ${managerRecord.message}`
        );
      }) &&
      completedCoordination.every(({ event }) => {
        if (event.name === "report_to_parent") {
          const reportId = outputString(event.output, "reportId");
          const sourceReceipt = outputReceipt(event.output, "record");
          const managerRecord = records.find(
            (record) =>
              record.type === "managed_agent_child_reported" &&
              record.attemptId === admission.attemptId &&
              record.reportId === reportId,
          );
          return (
            managerRecord !== undefined &&
            sourceReceipt !== undefined &&
            isDeepStrictEqual(sourceReceipt, managedRecordReceipt(managerRecord))
          );
        }
        const attentionId = outputString(event.output, "attentionId");
        const messageId = outputString(event.output, "messageId");
        const sourceAttentionReceipt = outputReceipt(event.output, "attentionRecord");
        const sourceReplyReceipt = outputReceipt(event.output, "replyRecord");
        const attentionRecord = records.find(
          (record) =>
            record.type === "managed_agent_attention_requested" &&
            record.attemptId === admission.attemptId &&
            record.attentionId === attentionId,
        );
        const replyRecord = records.find(
          (record) =>
            record.type === "managed_agent_parent_reply_enqueued" &&
            record.attemptId === admission.attemptId &&
            record.attentionId === attentionId &&
            record.messageId === messageId,
        );
        return (
          attentionRecord !== undefined &&
          replyRecord !== undefined &&
          sourceAttentionReceipt !== undefined &&
          sourceReplyReceipt !== undefined &&
          isDeepStrictEqual(sourceAttentionReceipt, managedRecordReceipt(attentionRecord)) &&
          isDeepStrictEqual(sourceReplyReceipt, managedRecordReceipt(replyRecord))
        );
      });
    if (validAdmissionIdentity && coordinationSourceIsValid) {
      for (const message of records.flatMap((record) =>
        record.type === "managed_agent_parent_message_enqueued" &&
        record.attemptId === admission.attemptId
          ? [record]
          : [],
      )) {
        const delivery = providerDeliveryLinks.find(
          (link) =>
            link.id === message.messageId && link.digest === managedRecordReceipt(message).digest,
        );
        if (
          delivery !== undefined &&
          !records.some(
            (record) =>
              record.type === "managed_agent_parent_message_delivered" &&
              record.messageId === message.messageId,
          )
        ) {
          const delivered: ManagedAgentRecord = {
            schemaVersion: 1,
            type: "managed_agent_parent_message_delivered",
            sequence: records.length + 1,
            agentId: message.agentId,
            attemptId: message.attemptId,
            childSessionId: message.childSessionId,
            messageId: message.messageId,
          };
          await store.append(delivered);
          records = [...records, delivered];
        }
      }
      for (const reply of records.flatMap((record) =>
        record.type === "managed_agent_parent_reply_enqueued" &&
        record.attemptId === admission.attemptId
          ? [record]
          : [],
      )) {
        const delivery = providerDeliveryLinks.find(
          (link) =>
            link.id === reply.messageId && link.digest === managedRecordReceipt(reply).digest,
        );
        if (
          delivery !== undefined &&
          !records.some(
            (record) =>
              record.type === "managed_agent_parent_reply_delivered" &&
              record.messageId === reply.messageId,
          )
        ) {
          const delivered: ManagedAgentRecord = {
            schemaVersion: 1,
            type: "managed_agent_parent_reply_delivered",
            sequence: records.length + 1,
            agentId: reply.agentId,
            attemptId: reply.attemptId,
            childSessionId: reply.childSessionId,
            attentionId: reply.attentionId,
            messageId: reply.messageId,
          };
          await store.append(delivered);
          records = [...records, delivered];
        }
      }
    }
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
      const cumulativeTokens = managedCumulativeTokens(
        sourceHistories,
        admission.usageAccountingVersion ?? 1,
      );
      const cumulativeBudget = isCurrentManagedAgentProfile(admission.profile)
        ? sourceAdmissions[0]?.limits.maximumTokens
        : admission.profile === "research.v1"
          ? researchManagedAgentProfileV1.limits.maximumCumulativeTokens
          : scoutManagedAgentProfileV1.limits.maximumCumulativeTokens;
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
        cumulativeBudget !== undefined &&
        admission.limits.maximumTokens === cumulativeBudget - cumulativeTokens;
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
                content: isResearchManagedAgentProfile(admission.profile)
                  ? `Managed child profile ${admission.profile}. Work only on the exact delegated research task with the admitted repository reads, selected Skills, Web evidence, and parent-only coordination. Do not write, execute, use MCP, access ambient extensions, spawn, coordinate with peers, or change model and permission authority.`
                  : `Managed child profile ${admission.profile}. Work only on the exact delegated task. Use repository reads only. Do not write, execute, use Web or MCP, select Skills, access extensions, spawn, coordinate with peers, or change model and permission authority.`,
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
    const effectiveToolNames = genesisPromptContext?.toolProfile.definitions.map(
      (definition) => definition.name,
    );
    const allowedToolNames = new Set(
      isResearchManagedAgentProfile(admission.profile)
        ? managedProfile.toolNames
        : ["read_file", "search_repository", "report_to_parent", "request_parent_input"],
    );
    const validEffectiveProfile =
      effectiveToolNames?.includes("read_file") === true &&
      effectiveToolNames.includes("search_repository") &&
      effectiveToolNames.every((name) => allowedToolNames.has(name));
    const genesisSkillContext =
      genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
        ? genesis.record.skillContext
        : undefined;
    const genesisSelectedSkills = genesisSkillContext?.active.map((activation) => ({
      qualifiedId: activation.qualifiedId,
      skillMdDigest: activation.skillMdDigest,
      manifestDigest: activation.manifest.digest,
    }));
    const validSelectedSkills =
      isDeepStrictEqual(genesisSelectedSkills, admission.selectedSkills) &&
      (admission.skillActivationDigest === undefined
        ? genesisSkillContext === undefined
        : genesisSkillContext?.activationDigest === admission.skillActivationDigest);
    const validGenesisIdentity =
      genesis?.schemaVersion === 3 &&
      genesis.record.type === "session_genesis" &&
      genesis.record.sessionId === admission.childSessionId &&
      genesis.record.projectId === admission.projectId &&
      isDeepStrictEqual(genesis.record.targetIdentity, admission.targetIdentity) &&
      isDeepStrictEqual(genesis.record.promptContext, expectedPromptContext) &&
      (admission.effectiveToolProfileDigest === undefined ||
        genesis.record.promptContext?.toolProfile.digest ===
          admission.effectiveToolProfileDigest) &&
      validEffectiveProfile &&
      validSelectedSkills &&
      coordinationSourceIsValid &&
      admission.profileDigest === managedProfile.digest &&
      managedAdmissionLimitsAreValid(
        admission,
        genesis.record.contextProfile?.contextWindowTokens,
      ) &&
      admission.parentRootId === `session:${admission.parentSessionId}` &&
      validResumeProjection &&
      (admission.repository === undefined
        ? repository?.sources.length === 0
        : repository?.revision === admission.repository.revision &&
          repository.effectiveDigest === admission.repository.effectiveDigest);
    if (existingTerminal?.type === "managed_agent_terminal") {
      if (
        existingTerminal.status !== "inspection_required" &&
        !records.some(
          (record) =>
            record.type === "managed_agent_inspection_required" &&
            record.attemptId === admission.attemptId,
        ) &&
        ((isCurrentManagedAgentProfile(admission.profile) && childRecords === undefined) ||
          (childRecords !== undefined &&
            (!validAdmissionIdentity || !validResume || !validGenesisIdentity)))
      ) {
        const inspection: ManagedAgentRecord = {
          schemaVersion: 1,
          type: "managed_agent_inspection_required",
          sequence: records.length + 1,
          agentId: admission.agentId,
          attemptId: admission.attemptId,
          childSessionId: admission.childSessionId,
          error: {
            code: "managed_agent_inspection_required",
            message: "The durable child coordination receipt does not match manager truth.",
          },
        };
        await store.append(inspection);
        records = [...records, inspection];
      }
      continue;
    }
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
      isDeepStrictEqual(
        logicalRun.record.limits,
        admission.limits.maximumTurns === undefined
          ? { maxTokens: admission.limits.maximumTokens }
          : {
              maxTurns: admission.limits.maximumTurns,
              maxTokens: admission.limits.maximumTokens,
            },
      );
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
    const providerCalls = providerCallsFromChildRecords(childRecords ?? []);
    let terminal: ManagedAgentRecord | undefined;
    if (childSettlement?.type === "session_settled") {
      if (childSettlement.result.status === "completed") {
        const answerBytes = Buffer.from(childSettlement.result.answer, "utf8");
        const inlineResult = { text: childSettlement.result.answer } as const;
        const inlineEnvelopeBytes = Buffer.byteLength(
          JSON.stringify({
            agentId: admission.agentId,
            attemptId: admission.attemptId,
            profile: admission.profile,
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
            ...(isCurrentManagedAgentProfile(admission.profile) ? { providerCalls } : {}),
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
            ...(isCurrentManagedAgentProfile(admission.profile) ? { providerCalls } : {}),
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
          candidate.limits.maximumTokens > previous.limits.maximumTokens ||
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
      !isCurrentManagedAgentProfile(admission.profile) ||
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

export type ManagedAgentSummary = {
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
  readonly context?: { readonly contextWindowTokens: number };
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
    const currentUsage = records.reduce(
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
            context: { contextWindowTokens: identityAdmissions[0]?.limits.maximumTokens ?? 0 },
            usage: currentUsage,
            budget: {
              maximumCumulativeTokens,
              usedTokens,
              remainingTokens: Math.max(0, maximumCumulativeTokens - usedTokens),
            },
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
      const currentHistory = histories.at(-1);
      const activeTool = currentManagedAgentTool(currentHistory ?? []);
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
      if (histories.some((history) => history === undefined)) {
        return {
          ...agent,
          status,
          phase,
          transcript,
          attemptHistory,
          ...projectedActiveTool,
          ...projectedPartialOutput,
          ...watchdog,
        };
      }
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
        ...(agent.usage === undefined ? {} : { usage }),
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
  return {
    counts: {
      active: agents.filter((agent) => isManagedAgentActiveStatus(agent.status)).length,
      terminal: agents.filter((agent) => !isManagedAgentActiveStatus(agent.status)).length,
      attention: agents.filter(
        (agent) =>
          agent.status === "permission_required" ||
          agent.status === "stalled" ||
          agent.status === "waiting_for_parent",
      ).length,
    },
    agents,
  };
}

function boundedManagedAgentListAgents(
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

export type AgentManager = {
  readonly parentRootId: string;
  readonly parentSessionId: string;
  readonly builtInProfileVersion: 1 | 2;
  readonly contextWindowTokens: number;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  promptSummary(): string;
  selectedSkillIdentities(
    skills: readonly string[],
  ): readonly { readonly qualifiedId: string; readonly digest: `sha256:${string}` }[] | undefined;
  snapshot(): Promise<ManagedAgentSnapshot>;
  decidePermission(command: PermissionDecisionCommand): PermissionDecisionCommandResult;
  rebindParentRoot(parentRoot: ProjectExecutionRootClaim): void;
  rebindResearchContext(context: ManagedAgentResearchContext | undefined): void;
  spawnForeground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
    readonly profile?: BuiltInManagedAgentProfileId;
    readonly skills?: readonly string[];
    readonly approvedSkills?: readonly {
      readonly qualifiedId: string;
      readonly digest: `sha256:${string}`;
    }[];
  }): Promise<ToolResult>;
  spawnBackground(input: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
    readonly profile?: BuiltInManagedAgentProfileId;
    readonly skills?: readonly string[];
    readonly approvedSkills?: readonly {
      readonly qualifiedId: string;
      readonly digest: `sha256:${string}`;
    }[];
  }): Promise<ToolResult>;
  runReviewer(input: {
    readonly callId: string;
    readonly managedRole: string;
    readonly maximumDeadlineMilliseconds: number;
    readonly maximumTokens: number;
    readonly maximumTurns: number;
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
    readonly until: "any_terminal" | "all_terminal" | "attention";
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
  send(input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly callId: string;
    readonly message: string;
    readonly attentionId?: string;
    readonly sourceRunId?: string;
    readonly sourceTurn?: number;
    readonly sourceProviderAttempt?: number;
  }): Promise<ToolResult>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
};

export type ManagedAgentResearchContext = {
  readonly repository?: PromptContextRecord["repository"];
  readonly tools?: ToolRegistry;
  readonly skillIdentities?: readonly {
    readonly qualifiedId: string;
    readonly digest: `sha256:${string}`;
  }[];
  readonly resolveSkills?: (input: {
    readonly skills: readonly string[];
    readonly attemptId: string;
    readonly childSessionId: string;
  }) => Promise<{
    readonly context: SkillContextRecordV1;
    readonly contents: ReadonlyMap<string, string>;
  }>;
  readonly authorizeProjectContextLoad?: AgentSessionDurableContext["authorizeProjectContextLoad"];
  readonly extensionSkillSources?: AgentSessionDurableContext["extensionSkillSources"];
  readonly withCurrentExtensionSkillSources?: AgentSessionDurableContext["withCurrentExtensionSkillSources"];
};

export type ManagedAgentDeadlineScheduler = {
  schedule(delayMilliseconds: number, onDeadline: () => void): { cancel(): void };
};

export type ManagedAgentInactivityScheduler = {
  schedule(delayMilliseconds: number, onInactivity: () => void): { cancel(): void };
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
  readonly parentCoordination?: { readonly interactive: boolean | (() => boolean) };
  readonly researchTools?: ToolRegistry;
  readonly researchSkillIdentities?: readonly {
    readonly qualifiedId: string;
    readonly digest: `sha256:${string}`;
  }[];
  readonly resolveResearchSkills?: (input: {
    readonly skills: readonly string[];
    readonly attemptId: string;
    readonly childSessionId: string;
  }) => Promise<{
    readonly context: SkillContextRecordV1;
    readonly contents: ReadonlyMap<string, string>;
  }>;
  readonly onChildPermissionEvent?: (event: RuntimeEvent) => void;
  readonly onChildRuntimeEvent?: (input: {
    readonly agentId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly event: RuntimeEvent;
  }) => void;
  readonly onManagedAgentStateChanged?: () => void;
  readonly deadlineScheduler?: ManagedAgentDeadlineScheduler;
  readonly inactivityScheduler?: ManagedAgentInactivityScheduler;
  readonly closeDrainScheduler?: ManagedAgentDeadlineScheduler;
  readonly parentRoot: ProjectExecutionRootClaim;
  readonly parentSessionId?: string;
  readonly projectId: `sha256:${string}`;
  readonly repository?: PromptContextRecord["repository"];
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  readonly workspaceRoot: string;
  readonly now?: () => number;
  readonly builtInProfileVersion?: 1 | 2;
}): AgentManager {
  let currentParentRoot = options.parentRoot;
  let currentResearchContext: ManagedAgentResearchContext | undefined = {
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    ...(options.researchTools === undefined ? {} : { tools: options.researchTools }),
    ...(options.researchSkillIdentities === undefined
      ? {}
      : { skillIdentities: options.researchSkillIdentities }),
    ...(options.resolveResearchSkills === undefined
      ? {}
      : { resolveSkills: options.resolveResearchSkills }),
  };
  let boundParentSessionId = options.parentSessionId ?? "00000000-0000-4000-8000-000000000001";
  let appendQueue = Promise.resolve();
  const appendManagedRecord = async (
    input: ManagedAgentRecordInput,
    guard: () => boolean = () => true,
  ): Promise<boolean> => {
    let appended = false;
    const operation = appendQueue.then(async () => {
      const records = await options.managedStore.read();
      if (!guard()) {
        return;
      }
      if (
        input.type === "managed_agent_admitted" &&
        input.profile !== "reviewer.v1" &&
        records.filter(
          (record) =>
            record.type === "managed_agent_admitted" &&
            record.parentSessionId === input.parentSessionId,
        ).length >= 16
      ) {
        throw new ManagedAgentCapacityError();
      }
      await options.managedStore.append({
        ...input,
        schemaVersion: 1,
        sequence: records.length + 1,
      });
      appended = true;
      options.onManagedAgentStateChanged?.();
    });
    appendQueue = operation.catch(() => undefined);
    await operation;
    return appended;
  };
  const hasInteractiveParentSink = (): boolean => {
    const interactive = options.parentCoordination?.interactive;
    return typeof interactive === "function" ? interactive() : interactive === true;
  };
  type ForceManagedAgentRecovery = () => Promise<
    "forced" | "already_terminal" | "terminal_in_progress"
  >;
  type AdmittedIdentity = {
    readonly agentId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly effectiveToolProfileDigest: `sha256:${string}`;
    readonly skillActivationDigest?: `sha256:${string}`;
    readonly forceRecovery: ForceManagedAgentRecovery;
  };
  type SpawnInput = {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly signal: AbortSignal;
    readonly task: string;
    readonly profile?: ManagedAgentProfileId;
    readonly skills?: readonly string[];
    readonly approvedSkills?: readonly {
      readonly qualifiedId: string;
      readonly digest: `sha256:${string}`;
    }[];
    readonly preserveLegacyProfile?: boolean;
    readonly managedRole?: string;
    readonly maximumTurns?: number;
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
    readonly onAdmitted?: (identity: AdmittedIdentity) => void;
    readonly onManagerAdmitted?: (forceRecovery: ForceManagedAgentRecovery) => void;
  };
  const activeAttempts = new Map<
    string,
    {
      readonly attemptId: string;
      readonly controller: AbortController;
      readonly completion: Promise<ToolResult>;
      readonly forceRecovery: ForceManagedAgentRecovery;
      readonly childSessionId: string;
      revision: number;
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
  const coordinationStates = new Map<
    string,
    {
      attentionId: string | undefined;
      attention: Promise<void>;
      notifyAttention: () => void;
      readonly resetAttention: () => void;
      reply:
        | {
            readonly attentionId: string;
            readonly promise: Promise<ToolResult>;
            readonly resolve: (result: ToolResult) => void;
          }
        | undefined;
    }
  >();
  const inactivityControls = new Map<
    string,
    {
      readonly pauseParent: () => void;
      readonly resume: () => void;
      readonly progress: () => void;
      readonly settled: () => Promise<void>;
      readonly state: () => "running" | "paused_permission" | "paused_parent" | "stalled";
    }
  >();
  const childPermissionSessions = new Map<string, AgentSession>();
  const childPermissionRequests = new Map<
    string,
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >();
  const childPermissionQueue: RuntimeEvent[] = [];
  let activeChildPermissionRequestId: string | undefined;
  const publishNextChildPermission = () => {
    if (activeChildPermissionRequestId !== undefined) {
      return;
    }
    while (childPermissionQueue.length > 0) {
      const next = childPermissionQueue.shift();
      if (
        next?.type !== "tool_permission_requested" ||
        !childPermissionSessions.has(next.requestId)
      ) {
        continue;
      }
      activeChildPermissionRequestId = next.requestId;
      options.onChildPermissionEvent?.(next);
      return;
    }
  };
  const observeChildPermissionEvent = (child: AgentSession, event: RuntimeEvent) => {
    if (event.type === "tool_permission_requested") {
      childPermissionSessions.set(event.requestId, child);
      childPermissionRequests.set(event.requestId, event);
      childPermissionQueue.push(event);
      publishNextChildPermission();
      return;
    }
    if (
      event.type === "tool_permission_decided" &&
      event.requestId !== undefined &&
      event.requestId === activeChildPermissionRequestId
    ) {
      childPermissionSessions.delete(event.requestId);
      childPermissionRequests.delete(event.requestId);
      activeChildPermissionRequestId = undefined;
      options.onChildPermissionEvent?.(event);
      publishNextChildPermission();
    }
  };
  const createCoordinationState = () => {
    const state: {
      attentionId: string | undefined;
      attention: Promise<void>;
      notifyAttention: () => void;
      readonly resetAttention: () => void;
      reply: undefined;
    } = {
      attentionId: undefined,
      attention: Promise.resolve(),
      notifyAttention: () => {},
      resetAttention() {
        const attention = Promise.withResolvers<void>();
        state.attention = attention.promise;
        state.notifyAttention = () => attention.resolve();
      },
      reply: undefined,
    };
    state.resetAttention();
    return state;
  };
  const prepareParentMessageDelivery = async (
    agentId: string,
    attemptId: string,
    childSessionId: string,
  ) => {
    const records = await options.managedStore.read();
    const pending = records.flatMap((record) =>
      record.type === "managed_agent_parent_message_enqueued" &&
      record.agentId === agentId &&
      record.attemptId === attemptId &&
      !records.some(
        (candidate) =>
          candidate.type === "managed_agent_parent_message_delivered" &&
          candidate.messageId === record.messageId,
      )
        ? [record]
        : [],
    );
    const pendingReplies = records.flatMap((record) =>
      record.type === "managed_agent_parent_reply_enqueued" &&
      record.agentId === agentId &&
      record.attemptId === attemptId &&
      !records.some(
        (candidate) =>
          candidate.type === "managed_agent_parent_reply_delivered" &&
          candidate.messageId === record.messageId,
      )
        ? [record]
        : [],
    );
    return {
      messages: pending.map((record) => ({ id: record.messageId, text: record.message })),
      deliveries: [...pending, ...pendingReplies].map((record) => ({
        id: record.messageId,
        digest: managedRecordReceipt(record).digest,
      })),
      async acknowledge() {
        for (const record of pending) {
          const current = await options.managedStore.read();
          if (
            current.some(
              (candidate) =>
                candidate.type === "managed_agent_parent_message_delivered" &&
                candidate.messageId === record.messageId,
            )
          ) {
            continue;
          }
          await appendManagedRecord({
            type: "managed_agent_parent_message_delivered",
            agentId,
            attemptId,
            childSessionId,
            messageId: record.messageId,
          });
          const active = activeAttempts.get(agentId);
          if (active?.attemptId === attemptId) {
            active.revision += 1;
          }
        }
        for (const record of pendingReplies) {
          const current = await options.managedStore.read();
          if (
            current.some(
              (candidate) =>
                candidate.type === "managed_agent_parent_reply_delivered" &&
                candidate.messageId === record.messageId,
            )
          ) {
            continue;
          }
          await appendManagedRecord({
            type: "managed_agent_parent_reply_delivered",
            agentId,
            attemptId,
            childSessionId,
            attentionId: record.attentionId,
            messageId: record.messageId,
          });
          inactivityControls.get(attemptId)?.resume();
          const active = activeAttempts.get(agentId);
          if (active?.attemptId === attemptId) {
            active.revision += 1;
          }
        }
      },
    };
  };
  const childCoordinationRegistry = (input: {
    readonly agentId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly allowInputRequest: boolean;
  }): ToolRegistry => {
    const report = createInternalToolAdapter(
      {
        definition: {
          name: "report_to_parent",
          description: "Report one bounded progress update or finding to the owning parent.",
          inputSchema: z.toJSONSchema(managedAgentReportSchema),
        },
        outputSchema: z.custom<JsonValue>(),
        effect: "delegate",
        cancellation: "unsupported",
        maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
        prepare(argumentsJson, identity) {
          const parsed = managedAgentReportSchema.safeParse(parseJson(argumentsJson));
          if (
            !parsed.success ||
            identity?.runId === undefined ||
            identity.turn === undefined ||
            identity.attempt === undefined
          ) {
            return toolFailure("invalid_tool_input", "Tool input is invalid.");
          }
          const sourceRunId = identity.runId;
          const sourceTurn = identity.turn;
          const sourceProviderAttempt = identity.attempt;
          const argumentsDigest = digest(JSON.stringify(parsed.data));
          return {
            status: "ready",
            permissionSubject: {
              type: "parent_coordination",
              operation: "report" as const,
              parentRootId: currentParentRoot.rootId,
              parentSessionId: boundParentSessionId,
              agentId: input.agentId,
              attemptId: input.attemptId,
              childSessionId: input.childSessionId,
              childToolCallId: identity?.callId ?? "unavailable",
              sourceRunId,
              sourceTurn,
              sourceProviderAttempt,
              messageDigest: digest(parsed.data.message),
            },
            async execute(context) {
              const records = await options.managedStore.read();
              const existing = records
                .flatMap((record) =>
                  record.type === "managed_agent_child_reported" ? [record] : [],
                )
                .find(
                  (record) =>
                    record.attemptId === input.attemptId &&
                    record.childToolCallId === context.callId &&
                    record.sourceRunId === sourceRunId &&
                    record.sourceTurn === sourceTurn &&
                    record.sourceProviderAttempt === sourceProviderAttempt,
                );
              if (existing !== undefined) {
                return existing.argumentsDigest === argumentsDigest
                  ? {
                      status: "completed",
                      output: {
                        reportId: existing.reportId,
                        revision: existing.sequence,
                        record: managedRecordReceipt(existing),
                        status: "reported",
                      },
                    }
                  : toolFailure(
                      "managed_agent_unavailable",
                      "The child report identity was reused with different arguments.",
                    );
              }
              if (
                records.filter(
                  (record) =>
                    record.type === "managed_agent_child_reported" &&
                    record.attemptId === input.attemptId,
                ).length >= maximumManagedAgentReportsPerAttempt
              ) {
                return toolFailure(
                  "managed_agent_capacity_exceeded",
                  "The child reached its bounded parent-report count.",
                );
              }
              const reportId = digest(
                JSON.stringify({
                  parentRootId: currentParentRoot.rootId,
                  sourceSessionId: input.childSessionId,
                  sourceAttemptId: input.attemptId,
                  sourceToolCallId: context.callId,
                  sourceRunId,
                  sourceTurn,
                  sourceProviderAttempt,
                  toolName: "report_to_parent",
                  argumentsDigest,
                }),
              );
              await appendManagedRecord({
                type: "managed_agent_child_reported",
                agentId: input.agentId,
                attemptId: input.attemptId,
                childSessionId: input.childSessionId,
                reportId,
                childToolCallId: context.callId,
                sourceRunId,
                sourceTurn,
                sourceProviderAttempt,
                argumentsDigest,
                kind: parsed.data.kind,
                message: parsed.data.message,
              });
              inactivityControls.get(input.attemptId)?.progress();
              const active = activeAttempts.get(input.agentId);
              if (active?.attemptId === input.attemptId) {
                active.revision += 1;
              }
              const appended = (await options.managedStore.read())
                .flatMap((record) =>
                  record.type === "managed_agent_child_reported" ? [record] : [],
                )
                .find((record) => record.reportId === reportId);
              if (appended === undefined) {
                return toolFailure(
                  "managed_agent_unavailable",
                  "The exact child report is unavailable.",
                );
              }
              return {
                status: "completed",
                output: {
                  reportId,
                  revision: appended.sequence,
                  record: managedRecordReceipt(appended),
                  status: "reported",
                },
              };
            },
          };
        },
      },
      "never",
    );
    const requestInput = createInternalToolAdapter(
      {
        definition: {
          name: "request_parent_input",
          description: "Request one bounded exact reply from the owning interactive parent.",
          inputSchema: z.toJSONSchema(managedAgentRequestParentInputSchema),
        },
        outputSchema: z.custom<JsonValue>(),
        effect: "delegate",
        cancellation: "abort_signal",
        maximumResult: { maximumBytes: maximumManagedAgentResultBytes },
        prepare(argumentsJson, identity) {
          const parsed = managedAgentRequestParentInputSchema.safeParse(parseJson(argumentsJson));
          if (
            !parsed.success ||
            identity?.runId === undefined ||
            identity.turn === undefined ||
            identity.attempt === undefined
          ) {
            return toolFailure("invalid_tool_input", "Tool input is invalid.");
          }
          const sourceRunId = identity.runId;
          const sourceTurn = identity.turn;
          const sourceProviderAttempt = identity.attempt;
          const argumentsDigest = digest(JSON.stringify(parsed.data));
          return {
            status: "ready",
            permissionSubject: {
              type: "parent_coordination",
              operation: "request_input" as const,
              parentRootId: currentParentRoot.rootId,
              parentSessionId: boundParentSessionId,
              agentId: input.agentId,
              attemptId: input.attemptId,
              childSessionId: input.childSessionId,
              childToolCallId: identity?.callId ?? "unavailable",
              sourceRunId,
              sourceTurn,
              sourceProviderAttempt,
              messageDigest: digest(parsed.data.question),
            },
            async execute(context) {
              if (!hasInteractiveParentSink()) {
                return toolFailure(
                  "managed_agent_unavailable",
                  "The interactive parent reply sink is unavailable.",
                );
              }
              const state = coordinationStates.get(input.attemptId);
              const records = await options.managedStore.read();
              const existing = records
                .flatMap((record) =>
                  record.type === "managed_agent_attention_requested" ? [record] : [],
                )
                .find(
                  (record) =>
                    record.attemptId === input.attemptId &&
                    record.childToolCallId === context.callId &&
                    record.sourceRunId === sourceRunId &&
                    record.sourceTurn === sourceTurn &&
                    record.sourceProviderAttempt === sourceProviderAttempt,
                );
              if (existing !== undefined) {
                if (existing.argumentsDigest !== argumentsDigest) {
                  return toolFailure(
                    "managed_agent_unavailable",
                    "The child attention identity was reused with different arguments.",
                  );
                }
                const reply = records
                  .flatMap((record) =>
                    record.type === "managed_agent_parent_reply_enqueued" ? [record] : [],
                  )
                  .find((record) => record.attentionId === existing.attentionId);
                if (reply !== undefined) {
                  return {
                    status: "completed",
                    output: {
                      attentionId: existing.attentionId,
                      messageId: reply.messageId,
                      reply: reply.message,
                      revision: reply.sequence,
                      attentionRecord: managedRecordReceipt(existing),
                      replyRecord: managedRecordReceipt(reply),
                    },
                  };
                }
                if (state?.reply?.attentionId === existing.attentionId) {
                  return state.reply.promise;
                }
              }
              if (state === undefined || state.attentionId !== undefined) {
                return toolFailure(
                  "managed_agent_unavailable",
                  "The child cannot open another parent-input request.",
                );
              }
              const attentionId = randomUUID();
              const effectId = digest(
                JSON.stringify({
                  parentRootId: currentParentRoot.rootId,
                  sourceSessionId: input.childSessionId,
                  sourceAttemptId: input.attemptId,
                  sourceToolCallId: context.callId,
                  sourceRunId,
                  sourceTurn,
                  sourceProviderAttempt,
                  toolName: "request_parent_input",
                  argumentsDigest,
                }),
              );
              await appendManagedRecord({
                type: "managed_agent_attention_requested",
                agentId: input.agentId,
                attemptId: input.attemptId,
                childSessionId: input.childSessionId,
                attentionId,
                effectId,
                childToolCallId: context.callId,
                sourceRunId,
                sourceTurn,
                sourceProviderAttempt,
                argumentsDigest,
                question: parsed.data.question,
              });
              inactivityControls.get(input.attemptId)?.pauseParent();
              state.attentionId = attentionId;
              state.notifyAttention();
              const active = activeAttempts.get(input.agentId);
              if (active?.attemptId === input.attemptId) {
                active.revision += 1;
              }
              const reply = Promise.withResolvers<ToolResult>();
              state.reply = {
                attentionId,
                promise: reply.promise,
                resolve(result) {
                  context.signal.removeEventListener("abort", abort);
                  state.reply = undefined;
                  state.attentionId = undefined;
                  state.resetAttention();
                  reply.resolve(result);
                },
              };
              const abort = () => {
                state.reply = undefined;
                state.attentionId = undefined;
                state.resetAttention();
                reply.resolve(
                  toolFailure(
                    "managed_agent_cancelled",
                    "The parent-input request ended before an exact reply.",
                  ),
                );
              };
              if (context.signal.aborted) {
                abort();
              } else {
                context.signal.addEventListener("abort", abort, { once: true });
              }
              return reply.promise;
            },
          };
        },
      },
      "never",
    );
    return createInternalToolRegistry([report, ...(input.allowInputRequest ? [requestInput] : [])]);
  };
  const knownAgentIds = new Set<string>();
  const stalledAttemptIds = new Set<string>();
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
    const profile =
      input.profile ?? (options.builtInProfileVersion === 2 ? "scout.v2" : "scout.v1");
    const existingAdmissions = (await options.managedStore.read()).filter(
      (record) =>
        record.type === "managed_agent_admitted" &&
        record.parentSessionId === input.parentSessionId,
    );
    if (profile !== "reviewer.v1" && existingAdmissions.length >= 16) {
      return toolFailure(
        "managed_agent_capacity_exceeded",
        "This parent session already owns the maximum sixteen managed child attempts.",
      );
    }
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
    coordinationStates.set(attemptId, createCoordinationState());
    const taskDigest = digest(input.task);
    const managedProfile = managedAgentProfile(profile);
    const currentProfile = isCurrentManagedAgentProfile(profile);
    const legacyProfile = currentProfile
      ? undefined
      : profile === "research.v1"
        ? researchManagedAgentProfileV1
        : profile === "reviewer.v1"
          ? reviewerManagedAgentProfileV1
          : scoutManagedAgentProfileV1;
    if (
      ((profile === "scout.v1" || profile === "scout.v2") && input.skills !== undefined) ||
      (input.skills !== undefined &&
        (input.skills.length > 8 || new Set(input.skills).size !== input.skills.length))
    ) {
      return toolFailure("invalid_tool_input", "The managed-child profile selection is invalid.");
    }
    let selectedSkillProjection:
      | {
          readonly context: SkillContextRecordV1;
          readonly contents: ReadonlyMap<string, string>;
        }
      | undefined;
    try {
      selectedSkillProjection =
        isResearchManagedAgentProfile(profile) && (input.skills?.length ?? 0) > 0
          ? await currentResearchContext?.resolveSkills?.({
              skills: input.skills ?? [],
              attemptId,
              childSessionId,
            })
          : undefined;
    } catch {
      return toolFailure(
        "invalid_tool_input",
        "The exact selected managed-child Skills are unavailable.",
      );
    }
    if (
      isResearchManagedAgentProfile(profile) &&
      (input.skills?.length ?? 0) > 0 &&
      selectedSkillProjection === undefined
    ) {
      return toolFailure(
        "invalid_tool_input",
        "The exact selected managed-child Skills are unavailable.",
      );
    }
    const resolvedSkillIdentities = selectedSkillProjection?.context.active.map((activation) => ({
      qualifiedId: activation.qualifiedId,
      digest: activation.skillMdDigest,
    }));
    if (
      input.skills !== undefined &&
      !isDeepStrictEqual(resolvedSkillIdentities, input.approvedSkills)
    ) {
      return toolFailure(
        "invalid_tool_input",
        "The selected managed-child Skill identity changed after approval.",
      );
    }
    const maximumTokens =
      input.maximumTokens ??
      (currentProfile
        ? options.childContextProfile.contextWindowTokens
        : (legacyProfile as NonNullable<typeof legacyProfile>).limits.maximumCumulativeTokens);
    const maximumTurns = currentProfile
      ? undefined
      : (input.maximumTurns ??
        (legacyProfile as NonNullable<typeof legacyProfile>).limits.maximumTurnsPerAttempt);
    const maximumDeadlineMilliseconds = currentProfile
      ? undefined
      : (input.maximumDeadlineMilliseconds ??
        (legacyProfile as NonNullable<typeof legacyProfile>).limits.maximumDeadlineMilliseconds);
    const maximumInactivityMilliseconds = currentProfile
      ? profile === "research.v2"
        ? researchManagedAgentProfileV2.limits.maximumInactivityMilliseconds
        : scoutManagedAgentProfileV2.limits.maximumInactivityMilliseconds
      : undefined;
    const admittedAtUnixMilliseconds =
      input.admittedAtUnixMilliseconds ?? (options.now ?? Date.now)();
    const deadlineAtUnixMilliseconds =
      maximumDeadlineMilliseconds === undefined
        ? undefined
        : (input.deadlineAtUnixMilliseconds ??
          admittedAtUnixMilliseconds + maximumDeadlineMilliseconds);
    const childClaim = await currentParentRoot.claimChild({ childId: agentId });
    const childController = new AbortController();
    let deadlineExpired = false;
    let deadlineRequested = false;
    let deadlineOperation: Promise<void> | undefined;
    let inactivityTimer: { cancel(): void } | undefined;
    let inactivityPauseReason: "permission" | "parent" | undefined;
    let inactivityGeneration = 0;
    let inactivitySettlement = Promise.resolve();
    let inactivityFailure: unknown;
    let lastAssistantDelta: string | undefined;
    const lastReasoningDeltas = new Map<string, string>();
    let admissionCommitted = false;
    let terminalCommitStarted = false;
    let terminalCommitted = false;
    let releaseChildClaim = true;
    let childClaimReleased = false;
    let unsubscribeChildPermissions = () => {};
    let ownedChild: AgentSession | undefined;
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
    const commitInactivityStall = async (generation: number): Promise<void> => {
      if (!currentProfile || terminalCommitStarted || generation !== inactivityGeneration) {
        return;
      }
      const records = await options.managedStore.read();
      const latestLiveness = records.findLast(
        (record) =>
          (record.type === "managed_agent_stalled" || record.type === "managed_agent_resumed") &&
          record.attemptId === attemptId,
      );
      if (
        generation !== inactivityGeneration ||
        latestLiveness?.type === "managed_agent_stalled" ||
        records.some(
          (record) => record.type === "managed_agent_terminal" && record.attemptId === attemptId,
        )
      ) {
        return;
      }
      const appended = await appendManagedRecord(
        {
          type: "managed_agent_stalled",
          agentId,
          attemptId,
          childSessionId,
          maximumInactivityMilliseconds: 300_000,
        },
        () => generation === inactivityGeneration && !terminalCommitStarted,
      );
      if (!appended) {
        return;
      }
      stalledAttemptIds.add(attemptId);
      const active = activeAttempts.get(agentId);
      if (active?.attemptId === attemptId) {
        active.revision += 1;
      }
      if (generation === inactivityGeneration) {
        coordinationStates.get(attemptId)?.notifyAttention();
      }
    };
    const enqueueInactivity = (operation: () => Promise<void>): Promise<void> => {
      const queued = inactivitySettlement.then(operation).catch((error: unknown) => {
        inactivityFailure ??= error;
        throw error;
      });
      inactivitySettlement = queued.catch(() => undefined);
      return queued;
    };
    const resetInactivity = (): void => {
      if (maximumInactivityMilliseconds === undefined || inactivityPauseReason !== undefined) {
        return;
      }
      inactivityGeneration += 1;
      const generation = inactivityGeneration;
      inactivityTimer?.cancel();
      inactivityTimer = (options.inactivityScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
        maximumInactivityMilliseconds,
        () => {
          void enqueueInactivity(() => commitInactivityStall(generation)).catch(() => undefined);
        },
      );
    };
    const invalidateInactivityWindow = (): void => {
      inactivityGeneration += 1;
      inactivityTimer?.cancel();
      inactivityTimer = undefined;
    };
    const enqueueInactivityProgress = (startNextWindow: boolean): void => {
      invalidateInactivityWindow();
      void enqueueInactivity(async () => {
        if (terminalCommitStarted) {
          return;
        }
        if (stalledAttemptIds.has(attemptId)) {
          await appendManagedRecord({
            type: "managed_agent_resumed",
            agentId,
            attemptId,
            childSessionId,
          });
          stalledAttemptIds.delete(attemptId);
          const active = activeAttempts.get(agentId);
          if (active?.attemptId === attemptId) {
            active.revision += 1;
          }
          const coordination = coordinationStates.get(attemptId);
          if (coordination?.attentionId === undefined) {
            coordination?.resetAttention();
          }
        }
        if (startNextWindow && inactivityPauseReason === undefined) {
          resetInactivity();
        }
      }).catch(() => undefined);
    };
    const pauseInactivity = (reason: "permission" | "parent"): void => {
      if (maximumInactivityMilliseconds === undefined) {
        return;
      }
      inactivityPauseReason = reason;
      enqueueInactivityProgress(false);
    };
    const resumeInactivity = (): void => {
      if (maximumInactivityMilliseconds === undefined || inactivityPauseReason === undefined) {
        return;
      }
      inactivityPauseReason = undefined;
      enqueueInactivityProgress(true);
    };
    const recordInactivityProgress = (): void => {
      enqueueInactivityProgress(true);
    };
    inactivityControls.set(attemptId, {
      pauseParent: () => pauseInactivity("parent"),
      resume: resumeInactivity,
      progress: recordInactivityProgress,
      state: () =>
        stalledAttemptIds.has(attemptId)
          ? "stalled"
          : inactivityPauseReason === "permission"
            ? "paused_permission"
            : inactivityPauseReason === "parent"
              ? "paused_parent"
              : "running",
      async settled() {
        await inactivitySettlement;
        if (inactivityFailure !== undefined) {
          throw inactivityFailure;
        }
      },
    });
    const abortFromCaller = () => childController.abort(input.signal.reason);
    if (input.signal.aborted) {
      abortFromCaller();
    } else {
      input.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const deadline =
      maximumDeadlineMilliseconds === undefined
        ? { cancel() {} }
        : (options.deadlineScheduler ?? nodeManagedAgentDeadlineScheduler).schedule(
            maximumDeadlineMilliseconds,
            () => {
              void commitDeadlineExpiration().catch(() => {
                childController.abort(new Error("Managed Agent deadline persistence failed."));
              });
            },
          );
    let partialOutputText = "";
    let partialOutputByteCount = 0;
    const resetPartialOutput = () => {
      partialOutputText = "";
      partialOutputByteCount = 0;
    };
    const partialOutput = (): ManagedAgentSummary["partialOutput"] =>
      partialOutputByteCount === 0
        ? undefined
        : {
            text: partialOutputText,
            byteCount: partialOutputByteCount,
            truncated: partialOutputByteCount > Buffer.byteLength(partialOutputText, "utf8"),
          };
    try {
      const readTools =
        profile === "reviewer.v1"
          ? createInternalToolRegistry([])
          : createReadToolRegistry({ workspaceRoot: options.workspaceRoot });
      const researchTools = currentResearchContext?.tools;
      const effectiveResearchTools =
        !isResearchManagedAgentProfile(profile) || researchTools === undefined
          ? undefined
          : {
              definitions: () =>
                researchTools
                  ?.definitions()
                  .filter(
                    (definition) =>
                      definition.name !== "read_skill_resource" ||
                      selectedSkillProjection !== undefined,
                  ) ?? [],
              resolve(name: string) {
                if (name === "read_skill_resource" && selectedSkillProjection === undefined) {
                  return undefined;
                }
                const adapter = researchTools.resolve(name);
                if (adapter === undefined || (name !== "web_search" && name !== "web_fetch")) {
                  return adapter;
                }
                const wrapped: ToolAdapter = {
                  ...adapter,
                  prepare(argumentsJson) {
                    const prepared = adapter.prepare(argumentsJson);
                    if (
                      prepared.status !== "ready" ||
                      prepared.permissionSubject.type !== "web_request"
                    ) {
                      return prepared;
                    }
                    const subject = prepared.permissionSubject;
                    return {
                      ...prepared,
                      permissionSubject: {
                        type: "managed_agent_web_request",
                        operation: subject.operation,
                        parentRootId: currentParentRoot.rootId,
                        parentSessionId: boundParentSessionId,
                        agentId,
                        attemptId,
                        childSessionId,
                        profile,
                        providerOrigin: subject.providerOrigin,
                        queryOrUrl: subject.operation === "search" ? subject.query : subject.url,
                        argumentsDigest: digest(JSON.stringify(parseJson(argumentsJson))),
                      },
                    };
                  },
                };
                return wrapped;
              },
            };
      const coordinationTools =
        options.parentCoordination === undefined
          ? undefined
          : childCoordinationRegistry({
              agentId,
              attemptId,
              childSessionId,
              allowInputRequest: input.mode === "background" && hasInteractiveParentSink(),
            });
      const registries = [
        readTools,
        ...(effectiveResearchTools === undefined ? [] : [effectiveResearchTools]),
        ...(coordinationTools === undefined ? [] : [coordinationTools]),
      ];
      const childDefinitions = registries.flatMap((registry) => registry.definitions());
      if (
        new Set(childDefinitions.map((definition) => definition.name)).size !==
        childDefinitions.length
      ) {
        throw new TypeError("The effective managed-child Tool Profile contains duplicate names.");
      }
      const childTools: ToolRegistry = {
        definitions: () => childDefinitions,
        resolve: (name) =>
          registries.find((registry) => registry.resolve(name) !== undefined)?.resolve(name),
      };
      const childPromptContext =
        selectedSkillProjection === undefined
          ? createPromptContextV1(childTools, currentResearchContext?.repository)
          : createPromptContextV2(
              childTools,
              currentResearchContext?.repository ?? createPromptContextV1(undefined).repository,
              selectedSkillProjection.context,
            );
      await appendManagedRecord({
        type: "managed_agent_admitted",
        agentId,
        attemptId,
        childSessionId,
        parentSessionId: input.parentSessionId,
        parentToolCallId: input.callId,
        parentRootId: currentParentRoot.rootId,
        projectId: options.projectId,
        profile,
        mode: input.mode,
        profileDigest: managedProfile.digest,
        usageAccountingVersion: 2,
        ...(input.preserveLegacyProfile === true
          ? {}
          : { effectiveToolProfileDigest: childPromptContext.toolProfile.digest }),
        ...(selectedSkillProjection === undefined
          ? {}
          : {
              skillActivationDigest: selectedSkillProjection.context.activationDigest,
              selectedSkills: selectedSkillProjection.context.active.map((activation) => ({
                qualifiedId: activation.qualifiedId,
                skillMdDigest: activation.skillMdDigest,
                manifestDigest: activation.manifest.digest,
              })),
            }),
        limits: {
          maximumTokens,
          ...(maximumTurns === undefined ? {} : { maximumTurns }),
          ...(maximumDeadlineMilliseconds === undefined ? {} : { maximumDeadlineMilliseconds }),
          ...(maximumInactivityMilliseconds === undefined ? {} : { maximumInactivityMilliseconds }),
        },
        ...(deadlineAtUnixMilliseconds === undefined ? {} : { deadlineAtUnixMilliseconds }),
        admittedAtUnixMilliseconds,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        taskDigest,
        childInputDigest: digest(childTaskMessage(input.task, profile)),
        targetIdentity: options.targetIdentity,
        ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
        ...(currentResearchContext?.repository === undefined
          ? {}
          : {
              repository: {
                revision: currentResearchContext.repository.revision,
                effectiveDigest: currentResearchContext.repository.effectiveDigest,
              },
            }),
      });
      admissionCommitted = true;
      input.onManagerAdmitted?.(forceRecovery);
      resetInactivity();
      if (deadlineRequested) {
        await commitDeadlineExpiration();
      }
      const childStore = await options.childSessionStores.create(childSessionId);
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
          ...(selectedSkillProjection === undefined
            ? {}
            : { skillContext: selectedSkillProjection.context }),
        },
      });
      const initialMessages: ModelMessage[] = [
        {
          role: "developer",
          content:
            profile === "reviewer.v1"
              ? (input.managedRole ?? "Managed child profile reviewer.v1.")
              : isResearchManagedAgentProfile(profile)
                ? `Managed child profile ${profile}. Work only on the exact delegated research task with the admitted repository reads, selected Skills, Web evidence, and parent-only coordination. Do not write, execute, use MCP, access ambient extensions, spawn, coordinate with peers, or change model and permission authority.`
                : `Managed child profile ${profile}. Work only on the exact delegated task. Use repository reads only. Do not write, execute, use Web or MCP, select Skills, access extensions, spawn, coordinate with peers, or change model and permission authority.`,
        },
        ...(input.resumedMessages ?? []),
      ];
      const childPermissions: PermissionPolicy = {
        decide(permission) {
          if (permission.subject.type === "parent_coordination") {
            return options.parentCoordination === undefined ? "deny" : "allow";
          }
          if (permission.subject.type === "managed_agent_web_request") {
            if (!isResearchManagedAgentProfile(profile)) {
              return "deny";
            }
            const decision = options.parentPermissions.decide(permission);
            return decision === "ask" && options.onChildPermissionEvent === undefined
              ? "deny"
              : decision === "ask" && !hasInteractiveParentSink()
                ? "deny"
                : decision;
          }
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
          ...(selectedSkillProjection === undefined
            ? {}
            : {
                skillContext: selectedSkillProjection.context,
                activeSkillContents: selectedSkillProjection.contents,
              }),
          repositoryWorkspaceRoot: options.workspaceRoot,
          ...(currentResearchContext?.authorizeProjectContextLoad === undefined
            ? {}
            : {
                authorizeProjectContextLoad: currentResearchContext.authorizeProjectContextLoad,
              }),
          ...(currentResearchContext?.extensionSkillSources === undefined
            ? {}
            : { extensionSkillSources: currentResearchContext.extensionSkillSources }),
          ...(currentResearchContext?.withCurrentExtensionSkillSources === undefined
            ? {}
            : {
                withCurrentExtensionSkillSources:
                  currentResearchContext.withCurrentExtensionSkillSources,
              }),
          afterLogicalRunStarted: () => {
            input.onAdmitted?.({
              agentId,
              attemptId,
              childSessionId,
              effectiveToolProfileDigest: childPromptContext.toolProfile.digest,
              ...(selectedSkillProjection === undefined
                ? {}
                : { skillActivationDigest: selectedSkillProjection.context.activationDigest }),
              forceRecovery,
            });
          },
          sessionId: childSessionId,
          targetIdentity: options.targetIdentity,
          ...(options.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: options.thinkingPolicy }),
        },
        [managedAgentRequestBoundary]: () =>
          prepareParentMessageDelivery(agentId, attemptId, childSessionId),
      };
      const child = new AgentSession(childDependencies);
      ownedChild = child;
      unsubscribeChildPermissions = child.subscribe((event) => {
        options.onChildRuntimeEvent?.({ agentId, attemptId, childSessionId, event });
        observeChildPermissionEvent(child, event);
        if (event.type === "model_message_started" || event.type === "model_message_completed") {
          resetPartialOutput();
        } else if (event.type === "model_message_delta") {
          partialOutputByteCount += Buffer.byteLength(event.text, "utf8");
          partialOutputText = boundedUtf8Prefix(`${partialOutputText}${event.text}`, 16 * 1024);
        }
        if (event.type === "tool_permission_requested") {
          pauseInactivity("permission");
          return;
        }
        if (event.type === "tool_permission_decided") {
          resumeInactivity();
          return;
        }
        if (
          event.type === "model_message_delta" &&
          event.text.length > 0 &&
          event.text !== lastAssistantDelta
        ) {
          lastAssistantDelta = event.text;
          recordInactivityProgress();
          return;
        }
        if (event.type === "model_reasoning_started") {
          recordInactivityProgress();
          return;
        }
        if (
          event.type === "model_reasoning_updated" &&
          event.text.length > 0 &&
          event.text !== lastReasoningDeltas.get(event.id)
        ) {
          lastReasoningDeltas.set(event.id, event.text);
          recordInactivityProgress();
          return;
        }
        if (event.type === "model_reasoning_settled") {
          recordInactivityProgress();
          return;
        }
        if (
          event.type === "model_message_started" ||
          event.type === "model_message_completed" ||
          event.type === "tool_requested" ||
          event.type === "tool_started" ||
          event.type === "tool_completed" ||
          event.type === "tool_failed" ||
          event.type === "context_compaction_started" ||
          event.type === "context_compaction_committed" ||
          event.type === "context_compaction_failed" ||
          event.type === "context_compaction_interrupted"
        ) {
          recordInactivityProgress();
        }
      });
      const result = await child.run(
        {
          text: childTaskMessage(input.task, profile),
        },
        {
          signal: childController.signal,
          limits: {
            ...(maximumTurns === undefined ? {} : { maxTurns: maximumTurns }),
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
      const providerCalls = providerCallsFromChildRecords(childRecords);
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
        const failedPartialOutput = partialOutput();
        terminalCommitStarted = true;
        await appendManagedRecord({
          type: "managed_agent_terminal",
          agentId,
          attemptId,
          childSessionId,
          status: "failed",
          error,
          ...(failedPartialOutput === undefined ? {} : { partialOutput: failedPartialOutput }),
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
        profile,
        profileDigest: managedProfile.digest,
        effectiveToolProfileDigest: childPromptContext.toolProfile.digest,
        ...(selectedSkillProjection === undefined
          ? {}
          : { skillActivationDigest: selectedSkillProjection.context.activationDigest }),
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
        ...(currentProfile ? { providerCalls } : {}),
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
          const interruptedPartialOutput = partialOutput();
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
                  ...(interruptedPartialOutput === undefined
                    ? {}
                    : { partialOutput: interruptedPartialOutput }),
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
      if (error instanceof ManagedAgentCapacityError) {
        return toolFailure(
          "managed_agent_capacity_exceeded",
          "This parent session already owns the maximum sixteen managed child attempts.",
        );
      }
      return toolFailure(
        "managed_agent_unavailable",
        "The foreground scout could not be started safely.",
      );
    } finally {
      for (const [requestId, child] of childPermissionSessions) {
        if (child === ownedChild) {
          const request = childPermissionRequests.get(requestId);
          const surfaced = activeChildPermissionRequestId === requestId;
          child.decidePermission({ requestId, decision: "deny" });
          childPermissionSessions.delete(requestId);
          childPermissionRequests.delete(requestId);
          if (surfaced && request !== undefined) {
            options.onChildPermissionEvent?.({
              type: "tool_permission_decided",
              callId: request.callId,
              name: request.name,
              decision: "deny",
              requestId,
              effect: request.effect,
              scope: request.scope,
              subject: request.subject,
              ...(request.changePreviewRef === undefined
                ? {}
                : { changePreviewRef: request.changePreviewRef }),
            });
          }
        }
      }
      unsubscribeChildPermissions();
      if (
        activeChildPermissionRequestId !== undefined &&
        !childPermissionSessions.has(activeChildPermissionRequestId)
      ) {
        activeChildPermissionRequestId = undefined;
        publishNextChildPermission();
      }
      deadline.cancel();
      inactivityGeneration += 1;
      inactivityTimer?.cancel();
      stalledAttemptIds.delete(attemptId);
      inactivityControls.delete(attemptId);
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
    let resolveAdmission: (identity: AdmittedIdentity) => void = () => {};
    const admitted = new Promise<AdmittedIdentity>((resolve) => {
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
    const admittedRecords = await options.managedStore.read();
    const admissionRecord = admittedRecords.find(
      (record) =>
        record.type === "managed_agent_admitted" && record.attemptId === identity.attemptId,
    );
    if (admissionRecord?.type !== "managed_agent_admitted") {
      return toolFailure("managed_agent_unavailable", "The durable child admission is missing.");
    }
    const admittedRevision = admittedRecords.filter(
      (record) => record.agentId === identity.agentId,
    ).length;
    activeAttempts.set(identity.agentId, {
      attemptId: identity.attemptId,
      childSessionId: identity.childSessionId,
      controller,
      completion,
      forceRecovery: identity.forceRecovery,
      revision: admittedRevision,
    });
    knownAgentIds.add(identity.agentId);
    input.signal.removeEventListener("abort", abortFromCaller);
    if (managerClosing) {
      try {
        await manager.cancel({ agentId: identity.agentId, expectedRevision: admittedRevision });
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
        profile: input.profile ?? (options.builtInProfileVersion === 2 ? "scout.v2" : "scout.v1"),
        profileDigest: managedAgentProfile(
          input.profile ?? (options.builtInProfileVersion === 2 ? "scout.v2" : "scout.v1"),
        ).digest,
        ...(identity.effectiveToolProfileDigest === undefined
          ? {}
          : { effectiveToolProfileDigest: identity.effectiveToolProfileDigest }),
        ...(identity.skillActivationDigest === undefined
          ? {}
          : { skillActivationDigest: identity.skillActivationDigest }),
        mode: "background",
        status: "running",
        revision: admittedRevision,
        record: managedRecordReceipt(admissionRecord),
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
    let resolveAdmission: (identity: AdmittedIdentity) => void = () => {};
    const admitted = new Promise<AdmittedIdentity>((resolve) => {
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
    const admittedRevision = (await options.managedStore.read()).filter(
      (record) => record.agentId === identity.agentId,
    ).length;
    activeAttempts.set(identity.agentId, {
      attemptId: identity.attemptId,
      childSessionId: identity.childSessionId,
      controller,
      completion,
      forceRecovery: identity.forceRecovery,
      revision: admittedRevision,
    });
    knownAgentIds.add(identity.agentId);
    try {
      return await completion;
    } finally {
      activeAttempts.delete(identity.agentId);
      input.signal.removeEventListener("abort", abortFromCaller);
    }
  };
  const runReviewer: AgentManager["runReviewer"] = async (input) => {
    if (
      !Number.isSafeInteger(input.maximumTurns) ||
      input.maximumTurns <= 0 ||
      input.maximumTurns > reviewerManagedAgentProfileV1.limits.maximumTurnsPerAttempt
    ) {
      return toolFailure("invalid_tool_input", "The managed reviewer limits are invalid.");
    }
    return runAttempt({
      ...input,
      mode: "foreground",
      profile: "reviewer.v1",
    });
  };
  const manager: AgentManager = {
    parentRootId: options.parentRoot.rootId,
    builtInProfileVersion: options.builtInProfileVersion ?? 1,
    contextWindowTokens: options.childContextProfile.contextWindowTokens,
    get parentSessionId() {
      return boundParentSessionId;
    },
    targetIdentity: options.targetIdentity,
    ...(options.thinkingPolicy === undefined ? {} : { thinkingPolicy: options.thinkingPolicy }),
    promptSummary() {
      const ids = [...knownAgentIds].sort();
      const active = activeAttempts.size;
      const terminal = ids.length - active;
      const attention =
        [...coordinationStates.values()].filter((state) => state.attentionId !== undefined).length +
        stalledAttemptIds.size;
      const prefix = `Managed agents: ${active} active, ${terminal} terminal, ${attention} need attention; IDs: `;
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
    selectedSkillIdentities(skills) {
      const available = new Map(
        (currentResearchContext?.skillIdentities ?? []).map((entry) => [entry.qualifiedId, entry]),
      );
      const selected = skills.flatMap((skill) => {
        const entry = available.get(skill);
        return entry === undefined ? [] : [entry];
      });
      return selected.length === skills.length ? selected : undefined;
    },
    decidePermission(command) {
      const child = childPermissionSessions.get(command.requestId);
      return (
        child?.decidePermission(command) ?? {
          status: "rejected",
          error: {
            code: "permission_request_not_pending",
            message: "The child permission request is not pending.",
          },
        }
      );
    },
    rebindParentRoot(parentRoot) {
      if (parentRoot.rootId !== manager.parentRootId) {
        throw new TypeError("The managed-child parent root cannot change.");
      }
      currentParentRoot = parentRoot;
    },
    rebindResearchContext(context) {
      currentResearchContext = context;
    },
    runReviewer,
    spawnForeground,
    spawnBackground,
    async snapshot() {
      await Promise.all([...inactivityControls.values()].map((control) => control.settled()));
      const records = await options.managedStore.read();
      const snapshot = await managedAgentSnapshotWithChildHistories({
        records,
        parentSessionId: manager.parentSessionId,
        childSessionStores: options.childSessionStores,
        permissionRequired: (agentId) =>
          [...childPermissionRequests.values()].some(
            (request) =>
              request.subject.type === "managed_agent_web_request" &&
              request.subject.agentId === agentId,
          ),
        watchdogState: (attemptId) => inactivityControls.get(attemptId)?.state(),
      });
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
          return isManagedAgentActiveStatus(agent.status);
        }
        if (input.status === "terminal") {
          return !isManagedAgentActiveStatus(agent.status);
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
        const cancelRecord = (await options.managedStore.read()).findLast(
          (record) =>
            record.type === "managed_agent_cancel_requested" &&
            record.agentId === input.agentId &&
            record.attemptId === active.attemptId,
        );
        if (cancelRecord?.type !== "managed_agent_cancel_requested") {
          return toolFailure(
            "managed_agent_unavailable",
            "The exact managed-child cancellation receipt is unavailable.",
          );
        }
        active.controller.abort(new Error("Managed child cancelled by its parent."));
        await active.completion;
        return {
          status: "completed",
          output: {
            agentId: input.agentId,
            attemptId: active.attemptId,
            status: "cancelled",
            revision: input.expectedRevision + 2,
            record: managedRecordReceipt(cancelRecord),
          },
        };
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
      const cumulativeTokens = managedCumulativeTokens(attemptHistories, 2);
      const deadlineAtUnixMilliseconds = admissions[0]?.deadlineAtUnixMilliseconds;
      const followUpNow = (options.now ?? Date.now)();
      const currentFollowUp = latest !== undefined && isCurrentManagedAgentProfile(latest.profile);
      const legacyFollowUpProfile =
        latest?.profile === "research.v1"
          ? researchManagedAgentProfileV1
          : scoutManagedAgentProfileV1;
      const remainingDeadlineMilliseconds = currentFollowUp
        ? undefined
        : deadlineAtUnixMilliseconds === undefined
          ? legacyFollowUpProfile.limits.maximumDeadlineMilliseconds
          : deadlineAtUnixMilliseconds - followUpNow;
      const cumulativeBudget = currentFollowUp
        ? admissions[0]?.limits.maximumTokens
        : legacyFollowUpProfile.limits.maximumCumulativeTokens;
      const remainingTokens = (cumulativeBudget ?? 0) - cumulativeTokens;
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
        records.some(
          (record) =>
            record.type === "managed_agent_inspection_required" &&
            record.attemptId === latest.attemptId,
        ) ||
        attemptHistories.some((history) => !history.valid) ||
        input.expectedRevision !== expectedRevision ||
        admissions.length >= 4 ||
        totalAttempts >= 16 ||
        remainingTokens <= 0 ||
        (remainingDeadlineMilliseconds !== undefined && remainingDeadlineMilliseconds <= 0)
      ) {
        return toolFailure(
          "invalid_tool_input",
          "The managed child is not terminal at the expected revision or has no remaining attempt budget.",
        );
      }
      return spawnBackground({
        ...input,
        agentId: input.agentId,
        ...(remainingDeadlineMilliseconds === undefined
          ? {}
          : {
              deadlineAtUnixMilliseconds:
                deadlineAtUnixMilliseconds ?? followUpNow + remainingDeadlineMilliseconds,
              admittedAtUnixMilliseconds: followUpNow,
              maximumDeadlineMilliseconds: remainingDeadlineMilliseconds,
            }),
        maximumTokens: remainingTokens,
        ...(latest === undefined
          ? {}
          : {
              profile: latest.profile,
              ...(latest.selectedSkills === undefined
                ? {}
                : {
                    skills: latest.selectedSkills.map((skill) => skill.qualifiedId),
                    approvedSkills: latest.selectedSkills.map((skill) => ({
                      qualifiedId: skill.qualifiedId,
                      digest: skill.skillMdDigest,
                    })),
                  }),
              ...(latest.effectiveToolProfileDigest === undefined
                ? { preserveLegacyProfile: true }
                : {}),
            }),
        ...(resume === undefined ? {} : { resume }),
        resumedMessages,
        revision: expectedRevision + 1,
      });
    },
    async send(input) {
      const active = activeAttempts.get(input.agentId);
      const argumentsDigest = digest(
        JSON.stringify({
          agentId: input.agentId,
          expectedRevision: input.expectedRevision,
          message: input.message,
          ...(input.attentionId === undefined ? {} : { attentionId: input.attentionId }),
        }),
      );
      const records = await options.managedStore.read();
      const existingReply = records
        .flatMap((record) =>
          record.type === "managed_agent_parent_reply_enqueued" ? [record] : [],
        )
        .find(
          (record) =>
            record.agentId === input.agentId &&
            record.parentToolCallId === input.callId &&
            record.sourceRunId === input.sourceRunId &&
            record.sourceTurn === input.sourceTurn &&
            record.sourceProviderAttempt === input.sourceProviderAttempt,
        );
      if (existingReply !== undefined) {
        if (existingReply.argumentsDigest !== argumentsDigest) {
          return toolFailure(
            "managed_agent_unavailable",
            "The parent reply identity was reused with different arguments.",
          );
        }
        const activeState = coordinationStates.get(existingReply.attemptId);
        const replyRevision = records.filter(
          (record) =>
            record.agentId === existingReply.agentId && record.sequence <= existingReply.sequence,
        ).length;
        const attentionRecord = records.find(
          (record) =>
            record.type === "managed_agent_attention_requested" &&
            record.attentionId === existingReply.attentionId,
        );
        if (
          activeState?.reply?.attentionId === existingReply.attentionId &&
          attentionRecord?.type === "managed_agent_attention_requested"
        ) {
          activeState.reply.resolve({
            status: "completed",
            output: {
              attentionId: existingReply.attentionId,
              messageId: existingReply.messageId,
              reply: existingReply.message,
              revision: replyRevision,
              attentionRecord: managedRecordReceipt(attentionRecord),
              replyRecord: managedRecordReceipt(existingReply),
            },
          });
        }
        return {
          status: "completed",
          output: {
            agentId: existingReply.agentId,
            attemptId: existingReply.attemptId,
            attentionId: existingReply.attentionId,
            messageId: existingReply.messageId,
            delivery: records.some(
              (record) =>
                record.type === "managed_agent_parent_reply_delivered" &&
                record.messageId === existingReply.messageId,
            )
              ? "delivered"
              : "enqueued",
            revision: records.filter((record) => record.agentId === input.agentId).length,
            record: managedRecordReceipt(existingReply),
          },
        };
      }
      const existing = records
        .flatMap((record) =>
          record.type === "managed_agent_parent_message_enqueued" ? [record] : [],
        )
        .find(
          (record) =>
            record.agentId === input.agentId &&
            record.parentToolCallId === input.callId &&
            record.sourceRunId === input.sourceRunId &&
            record.sourceTurn === input.sourceTurn &&
            record.sourceProviderAttempt === input.sourceProviderAttempt,
        );
      if (existing !== undefined) {
        if (existing.argumentsDigest !== argumentsDigest) {
          return toolFailure(
            "managed_agent_unavailable",
            "The parent message identity was reused with different arguments.",
          );
        }
        const delivered = records.some(
          (record) =>
            record.type === "managed_agent_parent_message_delivered" &&
            record.messageId === existing.messageId,
        );
        return {
          status: "completed",
          output: {
            agentId: existing.agentId,
            attemptId: existing.attemptId,
            messageId: existing.messageId,
            delivery: delivered ? "delivered" : "enqueued",
            revision: records.filter((record) => record.agentId === input.agentId).length,
            record: managedRecordReceipt(existing),
          },
        };
      }
      if (input.attentionId !== undefined) {
        const state = active === undefined ? undefined : coordinationStates.get(active.attemptId);
        if (
          active === undefined ||
          input.expectedRevision !== active.revision ||
          state?.attentionId !== input.attentionId ||
          state.reply?.attentionId !== input.attentionId
        ) {
          return toolFailure(
            "invalid_tool_input",
            "The managed child attention identity or revision is stale.",
          );
        }
        const messageId = digest(
          JSON.stringify({
            parentRootId: manager.parentRootId,
            parentSessionId: manager.parentSessionId,
            attemptId: active.attemptId,
            callId: input.callId,
            toolName: "send_agent_message",
            argumentsDigest,
            ...(input.sourceRunId === undefined
              ? {}
              : {
                  sourceRunId: input.sourceRunId,
                  sourceTurn: input.sourceTurn,
                  sourceProviderAttempt: input.sourceProviderAttempt,
                }),
          }),
        );
        try {
          await appendManagedRecord({
            type: "managed_agent_parent_reply_enqueued",
            agentId: input.agentId,
            attemptId: active.attemptId,
            childSessionId: active.childSessionId,
            attentionId: input.attentionId,
            messageId,
            parentToolCallId: input.callId,
            expectedRevision: input.expectedRevision,
            ...(input.sourceRunId === undefined
              ? {}
              : {
                  sourceRunId: input.sourceRunId,
                  sourceTurn: input.sourceTurn,
                  sourceProviderAttempt: input.sourceProviderAttempt,
                }),
            argumentsDigest,
            message: input.message,
          });
        } catch {
          return toolFailure(
            "invalid_tool_input",
            "The managed child revision changed before the reply became durable.",
          );
        }
        active.revision += 1;
        const replyRecord = (await options.managedStore.read()).find(
          (record) =>
            record.type === "managed_agent_parent_reply_enqueued" && record.messageId === messageId,
        );
        if (replyRecord?.type !== "managed_agent_parent_reply_enqueued") {
          return toolFailure("managed_agent_unavailable", "The exact parent reply is unavailable.");
        }
        const attentionRecord = records.find(
          (record) =>
            record.type === "managed_agent_attention_requested" &&
            record.attentionId === input.attentionId,
        );
        if (attentionRecord?.type !== "managed_agent_attention_requested") {
          return toolFailure(
            "managed_agent_unavailable",
            "The exact attention record is unavailable.",
          );
        }
        state.reply.resolve({
          status: "completed",
          output: {
            attentionId: input.attentionId,
            messageId,
            reply: input.message,
            revision: active.revision,
            attentionRecord: managedRecordReceipt(attentionRecord),
            replyRecord: managedRecordReceipt(replyRecord),
          },
        });
        return {
          status: "completed",
          output: {
            agentId: input.agentId,
            attemptId: active.attemptId,
            attentionId: input.attentionId,
            messageId,
            delivery: "enqueued",
            revision: active.revision,
            record: managedRecordReceipt(replyRecord),
          },
        };
      }
      if (
        active === undefined ||
        input.expectedRevision !== active.revision ||
        coordinationStates.get(active.attemptId)?.attentionId !== undefined ||
        records.filter(
          (record) =>
            record.type === "managed_agent_parent_message_enqueued" &&
            record.attemptId === active.attemptId &&
            !records.some(
              (candidate) =>
                candidate.type === "managed_agent_parent_message_delivered" &&
                candidate.messageId === record.messageId,
            ),
        ).length >= 4
      ) {
        return toolFailure(
          "invalid_tool_input",
          "The managed child identity, revision, or ordinary-message shape is invalid.",
        );
      }
      const messageId = digest(
        JSON.stringify({
          parentRootId: manager.parentRootId,
          parentSessionId: manager.parentSessionId,
          attemptId: active.attemptId,
          callId: input.callId,
          toolName: "send_agent_message",
          argumentsDigest,
          ...(input.sourceRunId === undefined
            ? {}
            : {
                sourceRunId: input.sourceRunId,
                sourceTurn: input.sourceTurn,
                sourceProviderAttempt: input.sourceProviderAttempt,
              }),
        }),
      );
      try {
        await appendManagedRecord({
          type: "managed_agent_parent_message_enqueued",
          agentId: input.agentId,
          attemptId: active.attemptId,
          childSessionId: active.childSessionId,
          messageId,
          parentToolCallId: input.callId,
          expectedRevision: input.expectedRevision,
          ...(input.sourceRunId === undefined
            ? {}
            : {
                sourceRunId: input.sourceRunId,
                sourceTurn: input.sourceTurn,
                sourceProviderAttempt: input.sourceProviderAttempt,
              }),
          argumentsDigest,
          message: input.message,
        });
      } catch {
        return toolFailure(
          "invalid_tool_input",
          "The managed child revision changed before the message became durable.",
        );
      }
      active.revision += 1;
      const enqueuedRecord = (await options.managedStore.read()).find(
        (record) =>
          record.type === "managed_agent_parent_message_enqueued" && record.messageId === messageId,
      );
      if (enqueuedRecord?.type !== "managed_agent_parent_message_enqueued") {
        return toolFailure("managed_agent_unavailable", "The exact parent message is unavailable.");
      }
      return {
        status: "completed",
        output: {
          agentId: input.agentId,
          attemptId: active.attemptId,
          messageId,
          delivery: "enqueued",
          revision: active.revision,
          record: managedRecordReceipt(enqueuedRecord),
        },
      };
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
        input.until === "attention"
          ? input.agentIds.some((agentId) => byId.get(agentId)?.status !== "running")
          : input.until === "any_terminal"
            ? input.agentIds.some((agentId) => {
                const status = byId.get(agentId)?.status;
                return status !== undefined && !isManagedAgentActiveStatus(status);
              })
            : input.agentIds.every((agentId) => {
                const status = byId.get(agentId)?.status;
                return status !== undefined && !isManagedAgentActiveStatus(status);
              });
      if (conditionMet) {
        return manager.list();
      }
      const completions: Promise<unknown>[] = [];
      for (const agentId of input.agentIds) {
        const active = activeAttempts.get(agentId);
        if (active === undefined) {
          continue;
        }
        if (input.until === "attention") {
          const attention = coordinationStates.get(active.attemptId)?.attention;
          if (attention !== undefined) {
            completions.push(Promise.race([attention, active.completion]));
          }
        } else {
          completions.push(active.completion);
        }
      }
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
        input.until === "any_terminal" || input.until === "attention"
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
  readonly profile?:
    | "managed-agent-tools.a1.v1"
    | "managed-agent-tools.a2-long-lived.v1"
    | "managed-agent-tools.a3-long-lived.v1"
    | "managed-agent-tools.a1.v2"
    | "managed-agent-tools.a2-long-lived.v2"
    | "managed-agent-tools.a3-long-lived.v2";
}): ToolRegistry {
  const profile = options.profile ?? "managed-agent-tools.a1.v1";
  const current = profile.endsWith(".v2");
  const a3 = profile.includes(".a3-long-lived.");
  const a2 = profile.includes(".a2-long-lived.");
  const spawnSchema = a3
    ? current
      ? managedAgentA3SpawnSchemaV2
      : managedAgentA3SpawnSchema
    : a2
      ? managedAgentA2SpawnSchema
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
          profile: z.enum(["scout.v1", "scout.v2", "research.v1", "research.v2"]),
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
        const a3Input = a3
          ? current
            ? managedAgentA3SpawnSchemaV2.parse(parsed.data)
            : managedAgentA3SpawnSchema.parse(parsed.data)
          : undefined;
        const selectedSkillIdentities =
          a3Input?.skills === undefined
            ? undefined
            : options.manager.selectedSkillIdentities(a3Input.skills);
        if (a3Input?.skills !== undefined && selectedSkillIdentities === undefined) {
          return toolFailure(
            "invalid_tool_input",
            "The exact selected managed-child Skills are unavailable.",
          );
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_spawn",
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
            profile: a3Input?.profile ?? (current ? "scout.v2" : "scout.v1"),
            ...(!a2 && !a3
              ? {}
              : {
                  mode:
                    "mode" in parsed.data && parsed.data.mode === "background"
                      ? "background"
                      : "foreground",
                }),
            profileDigest: managedAgentProfile(
              a3Input?.profile ?? (current ? "scout.v2" : "scout.v1"),
            ).digest,
            ...(selectedSkillIdentities === undefined
              ? {}
              : { selectedSkills: selectedSkillIdentities }),
            ...(!a3
              ? {}
              : {
                  parentCoordination: {
                    reportToParent: true as const,
                    requestParentInput: "mode" in parsed.data && parsed.data.mode === "background",
                    maximumMessageBytes: 8_192 as const,
                    maximumPendingMessages: 4 as const,
                  },
                }),
            targetIdentity: options.manager.targetIdentity,
            taskDigest: digest(parsed.data.task),
            limits: current
              ? {
                  maximumTokens: options.manager.contextWindowTokens,
                  maximumInactivityMilliseconds:
                    scoutManagedAgentProfileV2.limits.maximumInactivityMilliseconds,
                }
              : {
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
              ...(a3Input === undefined
                ? {}
                : {
                    profile: a3Input.profile,
                    ...(a3Input.skills === undefined ? {} : { skills: a3Input.skills }),
                    ...(selectedSkillIdentities === undefined
                      ? {}
                      : { approvedSkills: selectedSkillIdentities }),
                  }),
            });
          },
        };
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
        return {
          status: "ready",
          permissionSubject: {
            type: "managed_agent_control",
            action: "send" as const,
            parentRootId: options.manager.parentRootId,
            parentSessionId: options.manager.parentSessionId,
            agentId: parsed.data.agentId,
            expectedRevision: parsed.data.expectedRevision,
            messageDigest: digest(parsed.data.message),
            sourceRunId: identity.runId,
            sourceTurn: identity.turn,
            sourceProviderAttempt: identity.attempt,
          },
          execute: (context) =>
            options.manager.send({
              agentId: parsed.data.agentId,
              expectedRevision: parsed.data.expectedRevision,
              message: parsed.data.message,
              ...(parsed.data.attentionId === undefined
                ? {}
                : { attentionId: parsed.data.attentionId }),
              ...(context.sourceRunId === undefined ||
              context.sourceTurn === undefined ||
              context.sourceProviderAttempt === undefined
                ? {}
                : {
                    sourceRunId: context.sourceRunId,
                    sourceTurn: context.sourceTurn,
                    sourceProviderAttempt: context.sourceProviderAttempt,
                  }),
              callId: context.callId,
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
    ...(a3 ? [sendAdapter] : []),
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

function managedRecordReceipt(record: ManagedAgentRecord): {
  readonly id: string;
  readonly revision: number;
  readonly digest: `sha256:${string}`;
} {
  const id =
    record.type === "managed_agent_admitted"
      ? record.attemptId
      : record.type === "managed_agent_child_reported"
        ? record.reportId
        : record.type === "managed_agent_attention_requested"
          ? record.effectId
          : "messageId" in record
            ? record.messageId
            : `${record.attemptId}:${record.type}`;
  return { id, revision: record.sequence, digest: digest(JSON.stringify(record)) };
}

function childTaskMessage(task: string, profile: ManagedAgentProfileId = "scout.v1"): string {
  return profile === "reviewer.v1" ? task : `${task}\n\n${childLiveWorkspaceNotice}`;
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

function managedCumulativeTokens(
  histories: readonly {
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens: number;
    };
  }[],
  usageAccountingVersion: 1 | 2,
): number {
  return histories.reduce(
    (total, history) =>
      total +
      history.usage.inputTokens +
      history.usage.outputTokens +
      (usageAccountingVersion === 1 ? history.usage.reasoningTokens : 0),
    0,
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
