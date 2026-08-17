import { createHash } from "node:crypto";
import { chmod, type FileHandle, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { valid } from "semver";
import { z } from "zod";
import type { ContextProfile } from "./context-profile.js";
import type { ContextCallUsage, ContextEvidenceV1, ContextSummaryV1 } from "./durable-context.js";
import type { RunResult, RuntimeEvent } from "./index.js";
import { modelDriverErrorCategories } from "./model-driver-error.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { PermissionSubject, ToolCall, ToolEffect, ToolReplayClass } from "./tool-runtime.js";

export type CanonicalRuntimeEvent = Exclude<RuntimeEvent, { readonly type: "model_message_delta" }>;

type V1PermissionSubject = Exclude<
  PermissionSubject,
  { readonly type: "extension_capability" | "patch" }
>;
type V1ToolError = {
  readonly code:
    | "unknown_tool"
    | "invalid_tool_input"
    | "permission_denied"
    | "outside_workspace"
    | "not_found"
    | "already_exists"
    | "ambiguous_match"
    | "binary_file"
    | "file_too_large"
    | "no_match"
    | "overlapping_edits"
    | "artifact_store_failed"
    | "shell_start_failed"
    | "tool_io_failed";
  readonly message: string;
};
type VersionedCanonicalRuntimeEvent<Subject, ToolError> =
  | Exclude<
      CanonicalRuntimeEvent,
      {
        readonly type: "tool_permission_requested" | "tool_permission_decided" | "tool_failed";
      }
    >
  | (Omit<
      Extract<CanonicalRuntimeEvent, { readonly type: "tool_permission_requested" }>,
      "subject"
    > & { readonly subject: Subject })
  | (Omit<
      Extract<CanonicalRuntimeEvent, { readonly type: "tool_permission_decided" }>,
      "subject"
    > & { readonly subject?: Subject | undefined })
  | (Omit<Extract<CanonicalRuntimeEvent, { readonly type: "tool_failed" }>, "error"> & {
      readonly error: ToolError;
    });
type V1CanonicalRuntimeEvent = VersionedCanonicalRuntimeEvent<V1PermissionSubject, V1ToolError>;

export type SessionEventRecord =
  | {
      readonly schemaVersion: 1;
      readonly runId: string;
      readonly sequence: number;
      readonly event: V1CanonicalRuntimeEvent;
    }
  | {
      readonly schemaVersion: 2;
      readonly runId: string;
      readonly sequence: number;
      readonly event: CanonicalRuntimeEvent;
    };

export type SessionGenesisRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_genesis";
    readonly sessionId: string;
    readonly projectId: string;
    readonly targetIdentity: ModelTargetIdentity;
    readonly lineage?: {
      readonly parentSessionId: string;
      readonly parentEventPosition: number;
      readonly prefixDigest: string;
    };
  };
};

export type SessionLogicalRunStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "logical_run_started";
    readonly runId: string;
    readonly userMessage: string;
    readonly limits?: {
      readonly maxTurns?: number;
      readonly maxTokens?: number;
    };
  };
};

export type SessionProviderAttemptStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "provider_attempt_started";
    readonly runId: string;
    readonly turn: number;
    readonly attempt: number;
    readonly targetIdentity: ModelTargetIdentity;
  };
};

export type SessionProviderAttemptInterruptedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "provider_attempt_interrupted";
    readonly runId: string;
    readonly turn: number;
    readonly attempt: number;
  } & (
    | { readonly reason: "process_restart"; readonly result?: never }
    | { readonly reason: "context_overflow"; readonly result?: never }
    | { readonly reason: "run_terminal"; readonly result: RunResult }
  );
};

export type SessionToolIntent = {
  readonly callId: string;
  readonly name: string;
  readonly argumentsDigest: string;
  readonly effect?: ToolEffect | undefined;
  readonly definitionDigest?: string | undefined;
  readonly replay: ToolReplayClass;
};

export type SessionModelResponseCompletedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "model_response_completed";
    readonly runId: string;
    readonly turn: number;
    readonly attempt: number;
    readonly targetIdentity: ModelTargetIdentity;
    readonly response: {
      readonly text: string;
      readonly reasoning?: string;
      readonly toolCalls: readonly ToolCall[];
      readonly toolIntents: readonly SessionToolIntent[];
      readonly finishReason: "stop" | "tool_calls";
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly reasoningTokens?: number;
        readonly cachedInputTokens?: number;
        readonly cacheMissInputTokens?: number;
      };
    };
  };
};

export type SessionRuntimeEventRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "runtime_event";
    readonly runId: string;
    readonly event: CanonicalRuntimeEvent;
  };
};

export type SessionContextCompactionStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "context_compaction_started";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly windowNumber: number;
    readonly trigger: "automatic_threshold" | "provider_overflow";
    readonly sourceThrough: number;
    readonly previousCheckpointSequence?: number;
    readonly targetIdentity: ModelTargetIdentity;
    readonly contextProfile: ContextProfile;
    readonly projectionVersion: 1;
    readonly sourceDigest: `sha256:${string}`;
  };
};

export type SessionContextCompactionCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "context_compaction_committed";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly checkpointId: string;
    readonly windowNumber: number;
    readonly trigger: "automatic_threshold" | "provider_overflow";
    readonly sourceThrough: number;
    readonly retainedFrom: number;
    readonly previousCheckpointSequence?: number;
    readonly targetIdentity: ModelTargetIdentity;
    readonly contextProfile: ContextProfile;
    readonly projectionVersion: 1;
    readonly sourceDigest: `sha256:${string}`;
    readonly replacementDigest: `sha256:${string}`;
    readonly summary: ContextSummaryV1;
    readonly evidence: ContextEvidenceV1;
    readonly usage?: ContextCallUsage;
  };
};

export type SessionContextCompactionFailedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "context_compaction_failed";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly windowNumber: number;
    readonly trigger: "automatic_threshold" | "provider_overflow";
    readonly sourceThrough: number;
    readonly reason:
      | "replacement_too_large"
      | "context_window_unrecoverable"
      | "summary_invalid"
      | "model_request_failed"
      | "input_unrecoverable";
    readonly usage?: ContextCallUsage;
  };
};

export type SessionContextCompactionInterruptedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "context_compaction_interrupted";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly windowNumber: number;
    readonly trigger: "automatic_threshold" | "provider_overflow";
    readonly sourceThrough: number;
    readonly reason: "caller_cancelled" | "process_restart";
    readonly usage: ContextCallUsage | { readonly status: "unknown" };
  };
};

export type SessionV3Record =
  | SessionGenesisRecord
  | SessionLogicalRunStartedRecord
  | SessionProviderAttemptStartedRecord
  | SessionProviderAttemptInterruptedRecord
  | SessionModelResponseCompletedRecord
  | SessionContextCompactionStartedRecord
  | SessionContextCompactionCommittedRecord
  | SessionContextCompactionFailedRecord
  | SessionContextCompactionInterruptedRecord
  | SessionRuntimeEventRecord;

export type SessionRecord = SessionEventRecord | SessionV3Record;

export interface SessionStore<RecordType extends SessionRecord = SessionEventRecord> {
  append(record: RecordType): Promise<void>;
  read(): Promise<readonly RecordType[]>;
}

export class SessionStoreError extends Error {
  readonly code: "session_log_exists" | "session_log_invalid" | "session_log_too_large";

  constructor(
    code:
      | "session_log_exists"
      | "session_log_invalid"
      | "session_log_too_large" = "session_log_invalid",
  ) {
    super(
      code === "session_log_exists"
        ? "The session log already exists."
        : code === "session_log_too_large"
          ? "The session log exceeds its read limit."
          : "The session log contains an invalid record.",
    );
    this.name = "SessionStoreError";
    this.code = code;
  }
}

const ordinaryRunErrorCodeSchema = z.enum([
  "model_stream_incomplete",
  "model_protocol_invalid",
  "model_output_truncated",
  "model_content_filtered",
  "replay_envelope_too_large",
  "invalid_run_limits",
  "run_already_active",
  "session_persistence_failed",
  "tool_effect_indeterminate",
  "turn_limit_exceeded",
  "token_limit_exceeded",
  "token_usage_missing",
  "context_compaction_invalid",
  "context_compaction_input_unrecoverable",
  "context_window_unrecoverable",
]);
type RunFailure = Extract<RunResult, { readonly status: "failed" }>["error"];
const runFailureSchema: z.ZodType<RunFailure> = z.discriminatedUnion("code", [
  z.strictObject({
    code: ordinaryRunErrorCodeSchema,
    message: z.string(),
  }),
  z.strictObject({
    code: z.enum(["model_resource_exhausted", "model_finish_unknown"]),
    message: z.string(),
    providerReason: z.string().max(128).optional(),
  }),
  z.strictObject({
    code: z.literal("model_request_failed"),
    message: z.string(),
    category: z.enum(modelDriverErrorCategories),
    status: z.number().int().min(100).max(599).optional(),
    providerCode: z.string().max(128).optional(),
    requestId: z.string().max(128).optional(),
  }),
  z.strictObject({
    code: z.literal("context_compaction_failed"),
    message: z.string(),
    category: z.enum(modelDriverErrorCategories),
    status: z.number().int().min(100).max(599).optional(),
    providerCode: z.string().max(128).optional(),
    requestId: z.string().max(128).optional(),
  }),
]);
const runResultSchema: z.ZodType<RunResult> = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), answer: z.string() }),
  z.strictObject({
    status: z.literal("cancelled"),
    error: z.strictObject({
      code: z.literal("session_cancelled"),
      message: z.string(),
    }),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: runFailureSchema,
  }),
]);
const v1ToolErrorSchema = z.strictObject({
  code: z.enum([
    "unknown_tool",
    "invalid_tool_input",
    "permission_denied",
    "outside_workspace",
    "not_found",
    "already_exists",
    "ambiguous_match",
    "binary_file",
    "file_too_large",
    "no_match",
    "overlapping_edits",
    "artifact_store_failed",
    "shell_start_failed",
    "tool_io_failed",
  ]),
  message: z.string(),
});
const canonicalPatchPathSchema = z.string().refine(isCanonicalPatchPath);
const v2ToolErrorSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.enum([
      "unknown_tool",
      "invalid_tool_input",
      "permission_denied",
      "outside_workspace",
      "not_found",
      "already_exists",
      "ambiguous_match",
      "binary_file",
      "file_too_large",
      "no_match",
      "overlapping_edits",
      "path_conflict",
      "artifact_store_failed",
      "shell_start_failed",
      "tool_effect_indeterminate",
      "tool_io_failed",
    ]),
    message: z.string(),
  }),
  z.strictObject({
    code: z.literal("patch_recovery_cleanup_failed"),
    message: z.string(),
    settlement: z.enum(["committed", "rolled_back"]),
    recoveryReference: z.strictObject({ id: z.uuid() }),
  }),
  z.strictObject({
    code: z.literal("patch_state_uncertain"),
    message: z.string(),
    affectedPaths: z
      .array(canonicalPatchPathSchema)
      .min(1)
      .max(64)
      .refine((paths) =>
        paths.every((path, index) => {
          const previousPath = paths[index - 1];
          return index === 0 || (previousPath !== undefined && previousPath < path);
        }),
      ),
    recoveryReference: z.strictObject({ id: z.uuid() }),
  }),
]);
const v1PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]);
const persistedPatchOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["create", "delete", "update"]),
    path: canonicalPatchPathSchema,
  }),
  z.strictObject({
    kind: z.literal("move"),
    from: canonicalPatchPathSchema,
    to: canonicalPatchPathSchema,
  }),
]);
const patchPermissionSubjectSchema = z
  .strictObject({
    type: z.literal("patch"),
    version: z.literal(1),
    operations: z.array(persistedPatchOperationSchema).min(1).max(32),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .superRefine((subject, context) => {
    const paths: string[] = [];
    for (const operation of subject.operations) {
      const operationPaths =
        operation.kind === "move" ? [operation.from, operation.to] : [operation.path];
      for (const path of operationPaths) {
        if (
          paths.some(
            (existingPath) =>
              path === existingPath ||
              path.startsWith(`${existingPath}/`) ||
              existingPath.startsWith(`${path}/`),
          )
        ) {
          context.addIssue({ code: "custom", message: "Patch paths must not conflict." });
          return;
        }
        paths.push(path);
      }
    }
  });
const extensionCapabilityPermissionSubjectSchema = z.strictObject({
  type: z.literal("extension_capability"),
  capabilityId: z.string().min(1).max(256),
  contributionId: z.string().min(1).max(256),
  extensionId: z.string().min(1).max(256),
  extensionVersion: z
    .string()
    .min(1)
    .max(128)
    .refine((version) => valid(version) !== null),
  operationId: z.uuid(),
});
const v2PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  extensionCapabilityPermissionSubjectSchema,
  patchPermissionSubjectSchema,
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]);

function isCanonicalPatchPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
function createCanonicalRuntimeEventSchema(options: {
  readonly permissionSubject: z.ZodType;
  readonly toolError: z.ZodType;
}): z.ZodType<CanonicalRuntimeEvent> {
  return z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user_message"), text: z.string() }),
    z.strictObject({ type: z.literal("model_message_started") }),
    z.strictObject({ type: z.literal("model_message_completed"), text: z.string() }),
    z
      .strictObject({
        type: z.literal("model_usage"),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        reasoningTokens: z.number().int().nonnegative().optional(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        cacheMissInputTokens: z.number().int().nonnegative().optional(),
      })
      .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens),
    z.strictObject({
      type: z.literal("tool_requested"),
      callId: z.string(),
      name: z.string(),
    }),
    z.strictObject({
      type: z.literal("tool_permission_requested"),
      requestId: z.string(),
      callId: z.string(),
      name: z.string(),
      effect: z.enum(["read", "write", "execute", "network", "delegate", "administrative"]),
      scope: z.literal("call"),
      subject: options.permissionSubject,
    }),
    z.strictObject({
      type: z.literal("tool_permission_decided"),
      callId: z.string(),
      name: z.string(),
      decision: z.enum(["allow", "deny"]),
      requestId: z.string().optional(),
      effect: z
        .enum(["read", "write", "execute", "network", "delegate", "administrative"])
        .optional(),
      scope: z.literal("call").optional(),
      subject: options.permissionSubject.optional(),
    }),
    z.strictObject({
      type: z.literal("tool_started"),
      callId: z.string(),
      name: z.string(),
    }),
    z.strictObject({
      type: z.literal("tool_completed"),
      callId: z.string(),
      name: z.string(),
      output: z.json(),
    }),
    z.strictObject({
      type: z.literal("tool_failed"),
      callId: z.string(),
      name: z.string(),
      error: options.toolError,
    }),
    z.strictObject({ type: z.literal("session_interrupted"), reason: z.literal("cancelled") }),
    z.strictObject({ type: z.literal("session_settled"), result: runResultSchema }),
  ]) as z.ZodType<CanonicalRuntimeEvent>;
}

const v1CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v1PermissionSubjectSchema,
  toolError: v1ToolErrorSchema,
}) as z.ZodType<V1CanonicalRuntimeEvent>;
const v2CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v2PermissionSubjectSchema,
  toolError: v2ToolErrorSchema,
});
const modelTargetIdentitySchema = z.strictObject({
  targetId: z.string().min(1).max(256),
  vendor: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  route: z.enum(["direct", "vercel-ai-gateway"]),
  upstreamProviderId: z.string().min(1).max(128).optional(),
  profileVersion: z.number().int().positive(),
  certification: z.enum(["certified", "experimental"]),
}) as unknown as z.ZodType<ModelTargetIdentity>;
const sessionRunLimitsSchema = z.strictObject({
  maxTurns: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});
const toolCallSchema: z.ZodType<ToolCall> = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  argumentsJson: z.string().max(512 * 1024),
});
const sessionToolIntentSchema: z.ZodType<SessionToolIntent> = z.strictObject({
  callId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  effect: z.enum(["read", "write", "execute", "network", "delegate", "administrative"]).optional(),
  definitionDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
  replay: z.enum(["safe", "never"]),
});
const responseUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheMissInputTokens: z.number().int().nonnegative().optional(),
});
const contextProfileSchema: z.ZodType<ContextProfile> = z.strictObject({
  version: z.number().int().positive(),
  contextWindowTokens: z.number().int().positive(),
  maximumOutputTokens: z.number().int().positive(),
  compactAtTokens: z.number().int().positive(),
  postCompactTargetTokens: z.number().int().positive(),
  retainedTargetTokens: z.number().int().nonnegative(),
  estimatorVersion: z.literal(1),
});
const contextSummarySchema: z.ZodType<ContextSummaryV1> = z.strictObject({
  schemaVersion: z.literal(1),
  objective: z
    .string()
    .min(1)
    .max(64 * 1024),
  constraints: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  progress: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  unresolvedQuestions: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  failures: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  remainingVerification: z
    .array(
      z
        .string()
        .min(1)
        .max(16 * 1024),
    )
    .max(128),
  nextSafeAction: z
    .string()
    .min(1)
    .max(64 * 1024),
});
const contextEvidenceSchema: z.ZodType<ContextEvidenceV1> = z.strictObject({
  schemaVersion: z.literal(1),
  modifiedFiles: z
    .array(
      z.strictObject({
        sessionId: z.uuid().optional(),
        path: z.string().min(1).max(4096),
        callId: z.string().min(1).max(256),
        sequence: z.number().int().positive(),
      }),
    )
    .max(256),
  permissions: z
    .array(
      z.strictObject({
        sessionId: z.uuid().optional(),
        callId: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        decision: z.enum(["allow", "deny"]),
        effect: z.string().min(1).max(64).optional(),
        subject: v2PermissionSubjectSchema.optional(),
        sequence: z.number().int().positive(),
      }),
    )
    .max(512),
  toolResults: z
    .array(
      z.strictObject({
        sessionId: z.uuid().optional(),
        callId: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        status: z.enum(["completed", "failed"]),
        sequence: z.number().int().positive(),
        artifactIds: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/u)).max(64),
      }),
    )
    .max(512),
  failures: z
    .array(
      z.strictObject({
        sessionId: z.uuid().optional(),
        callId: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        code: z.string().min(1).max(128),
        sequence: z.number().int().positive(),
      }),
    )
    .max(512),
});
const sessionV3RecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session_genesis"),
    sessionId: z.uuid(),
    projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    targetIdentity: modelTargetIdentitySchema,
    lineage: z
      .strictObject({
        parentSessionId: z.uuid(),
        parentEventPosition: z.number().int().positive(),
        prefixDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("logical_run_started"),
    runId: z.uuid(),
    userMessage: z.string().max(512 * 1024),
    limits: sessionRunLimitsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("provider_attempt_started"),
    runId: z.uuid(),
    turn: z.number().int().positive(),
    attempt: z.number().int().positive(),
    targetIdentity: modelTargetIdentitySchema,
  }),
  z.strictObject({
    type: z.literal("provider_attempt_interrupted"),
    runId: z.uuid(),
    turn: z.number().int().positive(),
    attempt: z.number().int().positive(),
    reason: z.enum(["process_restart", "context_overflow", "run_terminal"]),
    result: runResultSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("model_response_completed"),
    runId: z.uuid(),
    turn: z.number().int().positive(),
    attempt: z.number().int().positive(),
    targetIdentity: modelTargetIdentitySchema,
    response: z.strictObject({
      text: z.string().max(512 * 1024),
      reasoning: z
        .string()
        .max(512 * 1024)
        .optional(),
      toolCalls: z.array(toolCallSchema).max(128),
      toolIntents: z.array(sessionToolIntentSchema).max(128),
      finishReason: z.enum(["stop", "tool_calls"]),
      usage: responseUsageSchema.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal("runtime_event"),
    runId: z.uuid(),
    event: v2CanonicalRuntimeEventSchema,
  }),
  z.strictObject({
    type: z.literal("context_compaction_started"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    windowNumber: z.number().int().positive(),
    trigger: z.enum(["automatic_threshold", "provider_overflow"]),
    sourceThrough: z.number().int().positive(),
    previousCheckpointSequence: z.number().int().positive().optional(),
    targetIdentity: modelTargetIdentitySchema,
    contextProfile: contextProfileSchema,
    projectionVersion: z.literal(1),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    type: z.literal("context_compaction_committed"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    checkpointId: z.uuid(),
    windowNumber: z.number().int().positive(),
    trigger: z.enum(["automatic_threshold", "provider_overflow"]),
    sourceThrough: z.number().int().positive(),
    retainedFrom: z.number().int().positive(),
    previousCheckpointSequence: z.number().int().positive().optional(),
    targetIdentity: modelTargetIdentitySchema,
    contextProfile: contextProfileSchema,
    projectionVersion: z.literal(1),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    replacementDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    summary: contextSummarySchema,
    evidence: contextEvidenceSchema,
    usage: responseUsageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("context_compaction_failed"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    windowNumber: z.number().int().positive(),
    trigger: z.enum(["automatic_threshold", "provider_overflow"]),
    sourceThrough: z.number().int().positive(),
    reason: z.enum([
      "replacement_too_large",
      "context_window_unrecoverable",
      "summary_invalid",
      "model_request_failed",
      "input_unrecoverable",
    ]),
    usage: responseUsageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("context_compaction_interrupted"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    attemptId: z.uuid(),
    attemptNumber: z.number().int().positive(),
    windowNumber: z.number().int().positive(),
    trigger: z.enum(["automatic_threshold", "provider_overflow"]),
    sourceThrough: z.number().int().positive(),
    reason: z.enum(["caller_cancelled", "process_restart"]),
    usage: z.union([responseUsageSchema, z.strictObject({ status: z.literal("unknown") })]),
  }),
]);
const sessionRecordSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
    event: v1CanonicalRuntimeEventSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
    event: v2CanonicalRuntimeEventSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(3),
    sequence: z.number().int().positive(),
    record: sessionV3RecordSchema,
  }),
]) as unknown as z.ZodType<SessionRecord>;
const maxSessionLogBytes = 8 * 1024 * 1024;
const maxSessionRecordBytes = 1024 * 1024;

export function isSessionRecordWithinSizeLimit(record: SessionRecord): boolean {
  return Buffer.byteLength(JSON.stringify(record), "utf8") <= maxSessionRecordBytes;
}

export function createInMemorySessionStore<
  RecordType extends SessionRecord = SessionEventRecord,
>(): SessionStore<RecordType> {
  const records: RecordType[] = [];
  let nextSequence = 1;
  let storedBytes = 0;
  return {
    async append(record) {
      const { record: validatedRecord, storedByteLength } =
        validateBoundedSessionEventRecord(record);
      if (validatedRecord.sequence !== nextSequence) {
        throw new SessionStoreError();
      }
      if (storedBytes + storedByteLength > maxSessionLogBytes) {
        throw new SessionStoreError("session_log_too_large");
      }
      records.push(validatedRecord as RecordType);
      nextSequence += 1;
      storedBytes += storedByteLength;
    },
    async read() {
      return validateRecordSequence([...records]) as readonly RecordType[];
    },
  };
}

export async function createJsonlSessionStore<
  RecordType extends SessionRecord = SessionEventRecord,
>(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<SessionStore<RecordType>> {
  validateSessionId(options.sessionId);

  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectId = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const projectsDirectory = join(stateRoot, "projects");
  const projectDirectory = join(projectsDirectory, projectId);
  const sessionsDirectory = join(projectDirectory, "sessions");
  for (const directory of [projectsDirectory, projectDirectory, sessionsDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const sessionPath = join(sessionsDirectory, `${options.sessionId}.jsonl`);
  try {
    const file = await open(sessionPath, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new SessionStoreError("session_log_exists");
    }
    throw error;
  }
  return createJsonlStore(sessionPath, 1, 0);
}

export async function openJsonlSessionStore<
  RecordType extends SessionRecord = SessionRecord,
>(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<SessionStore<RecordType>> {
  validateSessionId(options.sessionId);
  const sessionPath = await resolveSessionPath(options);
  const content = await readBoundedSessionLog(sessionPath);
  if (content === undefined || content.length === 0 || !content.endsWith("\n")) {
    throw new SessionStoreError();
  }
  const records = validateRecordSequence(
    content
      .slice(0, -1)
      .split("\n")
      .map((line) => parseSessionRecord(line)),
  );
  return createJsonlStore<RecordType>(
    sessionPath,
    records.length + 1,
    Buffer.byteLength(content, "utf8"),
  );
}

function createJsonlStore<RecordType extends SessionRecord>(
  sessionPath: string,
  initialNextSequence: number,
  initialStoredBytes: number,
): SessionStore<RecordType> {
  let nextSequence = initialNextSequence;
  let storedBytes = initialStoredBytes;
  let appendQueue = Promise.resolve();

  return {
    append(record) {
      const operation = appendQueue.then(async () => {
        const {
          record: validatedRecord,
          serialized,
          storedByteLength,
        } = validateBoundedSessionEventRecord(record);
        if (validatedRecord.sequence !== nextSequence) {
          throw new SessionStoreError();
        }
        if (storedBytes + storedByteLength > maxSessionLogBytes) {
          throw new SessionStoreError("session_log_too_large");
        }
        const file = await open(sessionPath, "a", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(`${serialized}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        nextSequence += 1;
        storedBytes += storedByteLength;
      });
      appendQueue = operation.catch(() => {});
      return operation;
    },
    async read() {
      await appendQueue;
      const content = await readBoundedSessionLog(sessionPath);
      if (content === undefined) {
        return [];
      }
      if (content.length === 0) {
        return [];
      }
      if (!content.endsWith("\n")) {
        throw new SessionStoreError();
      }
      const lines = content.slice(0, -1).split("\n");
      if (lines.some((line) => Buffer.byteLength(line, "utf8") > maxSessionRecordBytes)) {
        throw new SessionStoreError("session_log_too_large");
      }
      const records = lines.map((line) => parseSessionRecord(line));
      return validateRecordSequence(records) as readonly RecordType[];
    },
  };
}

export async function readJsonlSessionRecords(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<readonly SessionRecord[]> {
  const sessionPath = await resolveSessionPath(options);
  const content = await readBoundedSessionLog(sessionPath);
  if (content === undefined || content.length === 0) {
    return [];
  }
  if (!content.endsWith("\n")) {
    throw new SessionStoreError();
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines.some((line) => Buffer.byteLength(line, "utf8") > maxSessionRecordBytes)) {
    throw new SessionStoreError("session_log_too_large");
  }
  return validateRecordSequence(lines.map((line) => parseSessionRecord(line)));
}

async function resolveSessionPath(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<string> {
  validateSessionId(options.sessionId);
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectId = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  return join(stateRoot, "projects", projectId, "sessions", `${options.sessionId}.jsonl`);
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

async function readBoundedSessionLog(sessionPath: string): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(sessionPath, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size > maxSessionLogBytes) {
      throw new SessionStoreError("session_log_too_large");
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseSessionRecord(line: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SessionStoreError();
  }
  return validateSessionRecord(parsed);
}

function validateSessionRecord(value: unknown): SessionRecord {
  const result = sessionRecordSchema.safeParse(value);
  if (!result.success) {
    throw new SessionStoreError();
  }
  return result.data;
}

function validateBoundedSessionEventRecord(value: unknown): {
  readonly record: SessionRecord;
  readonly serialized: string;
  readonly storedByteLength: number;
} {
  const record = validateSessionRecord(value);
  const serialized = JSON.stringify(record);
  if (!isSessionRecordWithinSizeLimit(record)) {
    throw new SessionStoreError("session_log_too_large");
  }
  return { record, serialized, storedByteLength: Buffer.byteLength(serialized, "utf8") + 1 };
}

function validateRecordSequence(records: readonly SessionRecord[]): readonly SessionRecord[] {
  if (records.some((record, index) => record.sequence !== index + 1)) {
    throw new SessionStoreError();
  }
  return records;
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) {
    throw new TypeError("The session ID must be a safe filename segment.");
  }
}
