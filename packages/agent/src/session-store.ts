import { createHash } from "node:crypto";
import { chmod, type FileHandle, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { valid } from "semver";
import { z } from "zod";
import type { RunResult, RuntimeEvent } from "./agent-session-contracts.js";
import type { ArtifactReference, ModelResponseArtifactSource } from "./artifact-store.js";
import type { ContextProfile } from "./context-profile.js";
import type { ContextCallUsage, ContextEvidenceV1, ContextSummaryV1 } from "./durable-context.js";
import { maximumInlineModelResponseFieldBytes } from "./durable-model-response-policy.js";
import type { McpToolProfileV1 } from "./mcp-profile-contracts.js";
import { modelDriverErrorCategories } from "./model-driver-error.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import {
  type PromptContextRecord,
  type PromptContextRecordV1,
  promptContextRecordSchema,
  type RepositoryInstructionFailureCode,
  repositoryInstructionFailureCodesV1,
  repositoryInstructionRevisionV1Schema,
  type Sha256Digest,
} from "./prompt-assembly.js";
import { normalizedSessionTitle, sessionTitleFallback } from "./session-naming.js";
import { type SkillContextRecordV1, skillContextRecordV1Schema } from "./skills.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import type { PermissionSubject, ToolCall, ToolEffect, ToolReplayClass } from "./tool-runtime.js";

export type CanonicalRuntimeEvent = Exclude<
  RuntimeEvent,
  {
    readonly type: "model_message_delta" | "model_reasoning_updated" | "mcp_catalog_state_changed";
  }
>;

type V1PermissionSubject = Exclude<
  PermissionSubject,
  { readonly type: "extension_capability" | "mcp_tool" | "patch" | "skill" }
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
    readonly naming?: {
      readonly profileVersion: 1;
      readonly fallbackTitle: string;
    };
    readonly promptContext?: PromptContextRecord;
    readonly skillContext?: SkillContextRecordV1;
    readonly lineage?:
      | {
          readonly parentSessionId: string;
          readonly parentEventPosition: number;
          readonly prefixDigest: string;
        }
      | {
          readonly recordVersion: 2;
          readonly parentSessionId: string;
          readonly sourceSessionId: string;
          readonly sourceEventPosition: number;
          readonly sourcePrefixDigest: string;
        };
  } & (
    | {
        readonly recordVersion?: never;
        readonly contextProfile?: never;
      }
    | {
        readonly recordVersion: 2;
        readonly contextProfile: ContextProfile;
      }
  );
};

export type SessionMcpWorkspaceConfirmedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_workspace_confirmed";
    readonly recordVersion: 1;
    readonly sourceDigest: Sha256Digest;
    readonly canonicalizerVersion: 1;
  };
};

export type SessionMcpServerDefinitionApprovedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_server_definition_approved";
    readonly recordVersion: 1;
    readonly sourceDigest: Sha256Digest;
    readonly serverId: string;
    readonly definitionDigest: Sha256Digest;
  };
};

export type SessionMcpActivationStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_activation_started";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly attempt: number;
    readonly reason: "initial" | "explicit_retry" | "idle_reactivate";
    readonly servers: readonly {
      readonly serverId: string;
      readonly definitionDigest: Sha256Digest;
      readonly startupEffects: readonly ["execute"] | readonly ["execute", "network"];
    }[];
  };
};

export type SessionMcpActivationSettledRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_activation_settled";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly attempt: number;
    readonly status: "ready" | "failed" | "cancelled";
    readonly catalogDigest?: Sha256Digest;
    readonly servers: readonly {
      readonly serverId: string;
      readonly definitionDigest: Sha256Digest;
      readonly protocolVersion: string;
      readonly serverName: string;
      readonly serverVersion: string;
      readonly capabilityDigest: Sha256Digest;
      readonly launchIdentityDigest: Sha256Digest;
    }[];
    readonly error?: {
      readonly code:
        | "mcp_bootstrap_failed"
        | "mcp_catalog_invalid"
        | "mcp_catalog_too_large"
        | "mcp_initialize_failed"
        | "mcp_shutdown_unconfirmed"
        | "mcp_start_failed"
        | "mcp_startup_timeout";
      readonly serverId?: string;
    };
  };
};

export type SessionMcpServerClosedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_server_closed";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly attempt: number;
    readonly serverId: string;
    readonly definitionDigest: Sha256Digest;
    readonly reason: "idle" | "session_close" | "peer_failure" | "stale" | "failed";
  };
};

export type SessionMcpToolProfileCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "mcp_tool_profile_committed";
    readonly recordVersion: 1;
    readonly profile: McpToolProfileV1;
    readonly previousAssemblyIdentityDigest: Sha256Digest;
    readonly assemblyIdentityDigest: Sha256Digest;
  };
};

export type SessionMcpCatalogStateChangedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record:
    | {
        readonly type: "mcp_catalog_state_changed";
        readonly recordVersion: 1;
        readonly runId?: string;
        readonly generationId: string;
        readonly serverId: string;
        readonly catalogDigest: Sha256Digest;
        readonly status: "stale";
        readonly reason: "list_changed" | "server_closed" | "shutdown_unconfirmed";
      }
    | {
        readonly type: "mcp_catalog_state_changed";
        readonly recordVersion: 1;
        readonly generationId: string;
        readonly serverId: string;
        readonly catalogDigest: Sha256Digest;
        readonly status: "ready";
        readonly reason: "revalidated";
      };
};

export type SessionLogicalRunStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "logical_run_started";
    readonly runId: string;
    readonly userMessage: string;
    readonly naming?: {
      readonly profileVersion: 1;
      readonly fallbackTitle: string;
    };
    readonly skills?: readonly {
      readonly selection: string;
      readonly requestId: string;
    }[];
    readonly limits?: {
      readonly maxTurns?: number;
      readonly maxTokens?: number;
    };
    readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
  };
};

export type SessionManualNameSetRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_manual_name_set";
    readonly recordVersion: 1;
    readonly name: string;
  };
};

export type SessionManualNameClearedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_manual_name_cleared";
    readonly recordVersion: 1;
  };
};

export type SessionTitleGenerationStartedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_title_generation_started";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly reason: "automatic" | "regenerate";
    readonly targetIdentity: ModelTargetIdentity;
  };
};

export type SessionTitleGenerationCompletedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_title_generation_completed";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly title: string;
    readonly usage:
      | { readonly status: "unknown" }
      | { readonly status: "known"; readonly inputTokens: number; readonly outputTokens: number };
  };
};

export type SessionTitleGenerationFailedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_title_generation_failed";
    readonly recordVersion: 1;
    readonly generationId: string;
    readonly reason: "model_request_failed" | "invalid_title" | "process_restart";
  };
};

export type SessionTitleGenerationSkippedManualRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "session_title_generation_skipped_manual";
    readonly recordVersion: 1;
  };
};

export type SessionSkillActivationBatchCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_activation_batch_committed";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly previousActivationDigest: Sha256Digest;
    readonly skillContext: SkillContextRecordV1;
    readonly assemblyIdentityDigest: Sha256Digest;
    readonly outcomes: readonly {
      readonly selection: string;
      readonly requestId: string;
      readonly qualifiedId: string;
      readonly status: "activated" | "already_selected" | "already_active";
      readonly activationIndex: number;
    }[];
  };
};

export type SessionSkillActivatedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_activated";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly catalogRevision: number;
    readonly activationIndex: number;
    readonly qualifiedId: string;
    readonly reason: "user_explicit" | "model_selected";
    readonly skillMdDigest: Sha256Digest;
    readonly manifestDigest: Sha256Digest;
  };
};

export type SessionSkillCatalogCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_catalog_committed";
    readonly recordVersion: 1;
    readonly previousRevision: number;
    readonly previousRegistryDigest: Sha256Digest;
    readonly skillContext: SkillContextRecordV1;
    readonly assemblyIdentityDigest: Sha256Digest;
    readonly reason?: "extension_reconciliation";
  };
};

export type SessionSkillCatalogFailedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_catalog_failed";
    readonly recordVersion: 1;
    readonly activeRevision: number;
    readonly activeRegistryDigest: Sha256Digest;
    readonly error: { readonly code: "skill_catalog_unavailable" };
  };
};

export type SessionSkillRevokedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_revoked";
    readonly recordVersion: 1;
    readonly catalogRevision: number;
    readonly activationIndex: number;
    readonly qualifiedId: string;
    readonly reason: "extension_disabled";
    readonly sourceEpoch: {
      readonly lifecycleRevision: number;
      readonly lifecycleDigest: Sha256Digest;
    };
  };
};

export type SessionPathContextCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "path_context_committed";
    readonly recordVersion: 1;
    readonly previousRepositoryRevision: number;
    readonly previousRepositoryDigest: Sha256Digest;
    readonly previousSkillRevision: number;
    readonly previousSkillRegistryDigest: Sha256Digest;
    readonly repository: PromptContextRecordV1["repository"];
    readonly skillContext: SkillContextRecordV1;
    readonly assemblyIdentityDigest: Sha256Digest;
    readonly trigger: {
      readonly runId: string;
      readonly callId: string;
      readonly name: "read_file" | "write_file" | "edit_file";
      readonly argumentsDigest: Sha256Digest;
      readonly disposition: "read_continue" | "mutation_retry_required";
    };
  };
};

export type SessionPathContextFailedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "path_context_failed";
    readonly recordVersion: 1;
    readonly activeRepositoryRevision: number;
    readonly activeRepositoryDigest: Sha256Digest;
    readonly activeSkillRevision: number;
    readonly activeSkillRegistryDigest: Sha256Digest;
    readonly error: { readonly code: "project_context_unavailable" };
    readonly trigger: {
      readonly runId: string;
      readonly callId: string;
      readonly name: "read_file" | "write_file" | "edit_file";
      readonly argumentsDigest: Sha256Digest;
      readonly disposition: "unavailable";
    };
  };
};

export type SessionSkillResourceReadCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "skill_resource_read_committed";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly callId: string;
    readonly qualifiedId: string;
    readonly activationIndex: number;
    readonly catalogRevision: number;
    readonly manifestRevision: 1;
    readonly path: string;
    readonly offset: number;
    readonly byteCount: number;
    readonly totalByteCount: number;
    readonly eof: boolean;
    readonly fileDigest: Sha256Digest;
    readonly pageDigest: Sha256Digest;
    readonly content: string;
    readonly executionToken?: string;
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
    readonly promptProjection?: {
      readonly version: 1;
      readonly assemblyIdentityDigest: Sha256Digest;
      readonly requestProjectionDigest: Sha256Digest;
    };
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
    readonly response: SessionModelResponse;
  };
};

type SessionResponseUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheMissInputTokens?: number;
};

export type SessionModelResponseField =
  | { readonly storage: "inline"; readonly text: string }
  | {
      readonly storage: "artifact";
      readonly reference: ArtifactReference<ModelResponseArtifactSource>;
    };

export type SessionModelResponse =
  | {
      readonly recordVersion?: never;
      readonly text: string;
      readonly reasoning?: string;
      readonly toolCalls: readonly ToolCall[];
      readonly toolIntents: readonly SessionToolIntent[];
      readonly finishReason: "stop" | "tool_calls";
      readonly usage?: SessionResponseUsage;
    }
  | {
      readonly recordVersion: 2;
      readonly text: SessionModelResponseField;
      readonly reasoning?: SessionModelResponseField;
      readonly toolCalls: readonly ToolCall[];
      readonly toolIntents: readonly SessionToolIntent[];
      readonly finishReason: "length" | "stop" | "tool_calls";
      readonly usage?: SessionResponseUsage;
    };

export type SessionModelResponsePublishedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "model_response_published";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly responseSequence: number;
  };
};

export type SessionRunSettledRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "run_settled";
    readonly recordVersion: 1;
    readonly runId: string;
    readonly responseSequence: number;
  } & (
    | { readonly status: "completed"; readonly reason?: never }
    | { readonly status: "incomplete"; readonly reason: "output_limit" }
  );
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

export type SessionRepositoryInstructionsCommittedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "repository_instructions_committed";
    readonly recordVersion: 1;
    readonly previousRevision: number;
    readonly previousEffectiveDigest: Sha256Digest;
    readonly repository: PromptContextRecord["repository"];
    readonly assemblyIdentityDigest: Sha256Digest;
    readonly trigger?: {
      readonly runId: string;
      readonly callId: string;
      readonly name: "read_file" | "write_file" | "edit_file";
      readonly argumentsDigest: Sha256Digest;
      readonly disposition: "read_continue" | "mutation_retry_required";
    };
  };
};

export type SessionRepositoryInstructionsFailedRecord = {
  readonly schemaVersion: 3;
  readonly sequence: number;
  readonly record: {
    readonly type: "repository_instructions_failed";
    readonly recordVersion: 1;
    readonly activeRevision: number;
    readonly activeEffectiveDigest: Sha256Digest;
    readonly error: { readonly code: RepositoryInstructionFailureCode };
    readonly trigger?: {
      readonly runId: string;
      readonly callId: string;
      readonly name: "read_file" | "write_file" | "edit_file";
      readonly argumentsDigest: Sha256Digest;
      readonly disposition: "unavailable";
    };
  };
};

export type SessionV3Record =
  | SessionGenesisRecord
  | SessionMcpWorkspaceConfirmedRecord
  | SessionMcpServerDefinitionApprovedRecord
  | SessionMcpActivationStartedRecord
  | SessionMcpActivationSettledRecord
  | SessionMcpServerClosedRecord
  | SessionMcpToolProfileCommittedRecord
  | SessionMcpCatalogStateChangedRecord
  | SessionLogicalRunStartedRecord
  | SessionManualNameSetRecord
  | SessionManualNameClearedRecord
  | SessionTitleGenerationStartedRecord
  | SessionTitleGenerationCompletedRecord
  | SessionTitleGenerationFailedRecord
  | SessionTitleGenerationSkippedManualRecord
  | SessionSkillActivationBatchCommittedRecord
  | SessionSkillActivatedRecord
  | SessionSkillCatalogCommittedRecord
  | SessionSkillCatalogFailedRecord
  | SessionSkillRevokedRecord
  | SessionPathContextCommittedRecord
  | SessionPathContextFailedRecord
  | SessionSkillResourceReadCommittedRecord
  | SessionProviderAttemptStartedRecord
  | SessionProviderAttemptInterruptedRecord
  | SessionModelResponseCompletedRecord
  | SessionModelResponsePublishedRecord
  | SessionRunSettledRecord
  | SessionContextCompactionStartedRecord
  | SessionContextCompactionCommittedRecord
  | SessionContextCompactionFailedRecord
  | SessionContextCompactionInterruptedRecord
  | SessionRepositoryInstructionsCommittedRecord
  | SessionRepositoryInstructionsFailedRecord
  | SessionRuntimeEventRecord;

export type SessionRecord = SessionEventRecord | SessionV3Record;

export interface SessionStore<RecordType extends SessionRecord = SessionEventRecord> {
  append(record: RecordType): Promise<void>;
  read(): Promise<readonly RecordType[]>;
}

export interface SessionStoreDirectoryEntry {
  readonly sessionId: string;
  readonly modifiedAtMilliseconds: number;
}

export interface SessionStoreDirectory<RecordType extends SessionRecord = SessionRecord> {
  create(sessionId: string): Promise<SessionStore<RecordType>>;
  listSessionEntries(): Promise<readonly SessionStoreDirectoryEntry[]>;
  listSessionIds(): Promise<readonly string[]>;
  open(sessionId: string): Promise<SessionStore<RecordType> | undefined>;
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
  "model_response_artifact_quota_exceeded",
  "model_response_too_large",
  "replay_envelope_too_large",
  "invalid_run_limits",
  "run_already_active",
  "session_persistence_failed",
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
    code: z.literal("tool_effect_indeterminate"),
    reason: z.enum([
      "mcp_request_timeout",
      "mcp_caller_cancelled",
      "mcp_connection_closed",
      "mcp_protocol_error",
      "process_restart",
    ]),
    message: z.string(),
  }),
  z.strictObject({
    code: ordinaryRunErrorCodeSchema,
    message: z.string(),
  }),
  z.strictObject({
    code: z.literal("skill_activation_failed"),
    message: z.string(),
    ambiguity: z
      .strictObject({
        selection: z.string().min(1).max(16_384),
        candidates: z.array(z.string().min(1).max(16_384)).max(8),
        omittedCount: z.number().int().nonnegative().max(248),
      })
      .optional(),
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
const legacyRunFailureSchema = z.union([
  runFailureSchema,
  z.strictObject({
    code: z.literal("tool_effect_indeterminate"),
    message: z.string(),
  }),
]);
const runResultSchema: z.ZodType<RunResult> = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), answer: z.string() }),
  z.strictObject({
    status: z.literal("incomplete"),
    reason: z.literal("output_limit"),
    answer: z.string(),
  }),
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
const legacyRunResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), answer: z.string() }),
  z.strictObject({
    status: z.literal("incomplete"),
    reason: z.literal("output_limit"),
    answer: z.string(),
  }),
  z.strictObject({
    status: z.literal("cancelled"),
    error: z.strictObject({
      code: z.literal("session_cancelled"),
      message: z.string(),
    }),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: legacyRunFailureSchema,
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
      "repository_context_changed",
      "repository_instructions_unavailable",
      "project_context_changed",
      "project_context_unavailable",
      "skill_unavailable",
      "skill_resource_unavailable",
      "skill_resource_changed",
      "unsupported_binary_resource",
      "resource_page_too_small",
      "skill_resource_quota_exceeded",
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
const currentToolErrorSchema = z.union([
  v2ToolErrorSchema,
  z.strictObject({
    code: z.literal("tool_effect_indeterminate"),
    reason: z.enum([
      "mcp_request_timeout",
      "mcp_caller_cancelled",
      "mcp_connection_closed",
      "mcp_protocol_error",
      "process_restart",
    ]),
    message: z.string(),
  }),
  z.strictObject({
    code: z.enum([
      "mcp_output_invalid",
      "mcp_output_unsupported",
      "mcp_protocol_error",
      "mcp_result_too_large",
    ]),
    message: z.string(),
  }),
  z.strictObject({
    code: z.literal("mcp_catalog_stale"),
    message: z.string(),
    generationId: z.uuid(),
    serverId: z.string().min(1).max(128),
    catalogDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
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
const skillPermissionSubjectSchema = z.strictObject({
  type: z.literal("skill"),
  operation: z.enum(["activate", "read_resource"]),
  qualifiedId: z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => /^[\x20-\x7e]+$/u.test(value)),
  path: z.string().min(1).max(4_096).optional(),
});
const v2PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  extensionCapabilityPermissionSubjectSchema,
  patchPermissionSubjectSchema,
  skillPermissionSubjectSchema,
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]);
const mcpPermissionSubjectSchema = z.strictObject({
  type: z.literal("mcp_tool"),
  serverId: z.string().min(1).max(128),
  originalName: z.string().min(1).max(256),
  qualifiedName: z.string().min(1).max(64),
  serverDefinitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
const currentPermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  extensionCapabilityPermissionSubjectSchema,
  patchPermissionSubjectSchema,
  skillPermissionSubjectSchema,
  mcpPermissionSubjectSchema,
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]) as unknown as z.ZodType<PermissionSubject>;

function isCanonicalPatchPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
const changePreviewArtifactReferenceSchema = z.strictObject({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  mediaType: z.literal("text/x-diff; charset=utf-8"),
  byteCount: z
    .number()
    .int()
    .positive()
    .max(64 * 1024),
  source: z.strictObject({
    type: z.literal("change_preview"),
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(128),
    runId: z.uuid(),
    callId: z.string().min(1).max(256),
    toolName: z.enum(["write_file", "edit_file"]),
    argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    provenance: z.literal("prepared_tool_change"),
  }),
});
function createCanonicalRuntimeEventSchema(options: {
  readonly permissionSubject: z.ZodType;
  readonly runResult: z.ZodType;
  readonly toolError: z.ZodType;
}): z.ZodType<CanonicalRuntimeEvent> {
  return z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user_message"), text: z.string() }),
    z.strictObject({ type: z.literal("model_message_started") }),
    z.strictObject({
      type: z.literal("model_reasoning_started"),
      id: z.string().min(1).max(512),
      artifactType: z.literal("provider_reasoning"),
    }),
    z.strictObject({
      type: z.literal("model_reasoning_settled"),
      id: z.string().min(1).max(512),
      status: z.enum(["completed", "interrupted", "failed"]),
    }),
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
      type: z.literal("repository_instructions_activated"),
      revision: z.number().int().positive(),
      effectiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      reason: z.literal("path_scope_activation"),
    }),
    z.strictObject({
      type: z.literal("tool_permission_requested"),
      requestId: z.string(),
      callId: z.string(),
      name: z.string(),
      effect: z.enum(["read", "write", "execute", "network", "delegate", "administrative"]),
      scope: z.literal("call"),
      subject: options.permissionSubject,
      changePreviewRef: changePreviewArtifactReferenceSchema.optional(),
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
      changePreviewRef: changePreviewArtifactReferenceSchema.optional(),
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
    z.strictObject({ type: z.literal("session_settled"), result: options.runResult }),
  ]) as z.ZodType<CanonicalRuntimeEvent>;
}

const v1CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v1PermissionSubjectSchema,
  runResult: legacyRunResultSchema,
  toolError: v1ToolErrorSchema,
}) as z.ZodType<V1CanonicalRuntimeEvent>;
const v2CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v2PermissionSubjectSchema,
  runResult: legacyRunResultSchema,
  toolError: v2ToolErrorSchema,
});
const currentCanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: currentPermissionSubjectSchema,
  runResult: runResultSchema,
  toolError: currentToolErrorSchema,
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
const modelResponseArtifactSourceSchema = z.strictObject({
  type: z.literal("model_response"),
  schemaVersion: z.literal(1),
  field: z.enum(["text", "reasoning"]),
  projectId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(128),
  runId: z.uuid(),
  turn: z.number().int().positive(),
  attempt: z.number().int().positive(),
  targetIdentity: modelTargetIdentitySchema,
  provenance: z.literal("provider_model_response"),
});
const modelResponseArtifactReferenceSchema = z.strictObject({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  mediaType: z.literal("text/plain; charset=utf-8"),
  byteCount: z.number().int().positive(),
  source: modelResponseArtifactSourceSchema,
});
const modelResponseFieldSchema = z.discriminatedUnion("storage", [
  z.strictObject({
    storage: z.literal("inline"),
    text: z
      .string()
      .max(maximumInlineModelResponseFieldBytes)
      .refine((text) => Buffer.byteLength(text, "utf8") <= maximumInlineModelResponseFieldBytes),
  }),
  z.strictObject({
    storage: z.literal("artifact"),
    reference: modelResponseArtifactReferenceSchema,
  }),
]);
const sessionRunLimitsSchema = z.strictObject({
  maxTurns: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});
const thinkingPolicyMappingV1Schema = z.union([
  z.strictObject({
    requestPath: z.literal("provider_options.deepseek"),
    thinkingType: z.literal("disabled"),
  }),
  z.strictObject({
    requestPath: z.literal("provider_options.deepseek"),
    thinkingType: z.literal("enabled"),
    reasoningEffort: z.enum(["low", "high", "max"]),
  }),
]);
const thinkingPolicySnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  requestedLevelId: z.string().min(1).max(64),
  effectiveLevelId: z.string().min(1).max(64),
  capability: z.strictObject({
    id: z.string().min(1).max(256),
    version: z.literal(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  mapping: thinkingPolicyMappingV1Schema,
  reasoningArtifact: z.literal("provider_reasoning"),
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
  ordinaryOutputReserveTokens: z.number().int().nonnegative().optional(),
  compactionSummaryMaximumOutputTokens: z.number().int().positive().optional(),
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
        subject: currentPermissionSubjectSchema.optional(),
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
const sessionGenesisV1RecordSchema = z.strictObject({
  type: z.literal("session_genesis"),
  sessionId: z.uuid(),
  projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  targetIdentity: modelTargetIdentitySchema,
  naming: z
    .strictObject({
      profileVersion: z.literal(1),
      fallbackTitle: z
        .string()
        .min(1)
        .max(1_024)
        .refine((value) => sessionTitleFallback(value) === value),
    })
    .optional(),
  promptContext: promptContextRecordSchema.optional(),
  skillContext: skillContextRecordV1Schema.optional(),
  lineage: z
    .union([
      z.strictObject({
        parentSessionId: z.uuid(),
        parentEventPosition: z.number().int().positive(),
        prefixDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      }),
      z.strictObject({
        recordVersion: z.literal(2),
        parentSessionId: z.uuid(),
        sourceSessionId: z.uuid(),
        sourceEventPosition: z.number().int().positive(),
        sourcePrefixDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      }),
    ])
    .optional(),
});
const sessionGenesisV2RecordSchema = sessionGenesisV1RecordSchema.extend({
  recordVersion: z.literal(2),
  contextProfile: contextProfileSchema,
});
const sessionV3RecordSchema = z.union([
  sessionGenesisV1RecordSchema,
  sessionGenesisV2RecordSchema,
  z.strictObject({
    type: z.literal("mcp_workspace_confirmed"),
    recordVersion: z.literal(1),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    canonicalizerVersion: z.literal(1),
  }),
  z.strictObject({
    type: z.literal("mcp_server_definition_approved"),
    recordVersion: z.literal(1),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    serverId: z.string().min(1).max(128),
    definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    type: z.literal("mcp_activation_started"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    attempt: z.number().int().positive(),
    reason: z.enum(["initial", "explicit_retry", "idle_reactivate"]),
    servers: z
      .array(
        z.strictObject({
          serverId: z.string().min(1).max(128),
          definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          startupEffects: z.union([
            z.tuple([z.literal("execute")]),
            z.tuple([z.literal("execute"), z.literal("network")]),
          ]),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.strictObject({
    type: z.literal("mcp_activation_settled"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    attempt: z.number().int().positive(),
    status: z.enum(["ready", "failed", "cancelled"]),
    catalogDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    servers: z
      .array(
        z.strictObject({
          serverId: z.string().min(1).max(128),
          definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          protocolVersion: z.string().min(1).max(64),
          serverName: z.string().min(1).max(256),
          serverVersion: z.string().min(1).max(128),
          capabilityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          launchIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        }),
      )
      .max(4),
    error: z
      .strictObject({
        code: z.enum([
          "mcp_bootstrap_failed",
          "mcp_catalog_invalid",
          "mcp_catalog_too_large",
          "mcp_initialize_failed",
          "mcp_shutdown_unconfirmed",
          "mcp_start_failed",
          "mcp_startup_timeout",
        ]),
        serverId: z.string().min(1).max(128).optional(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("mcp_server_closed"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    attempt: z.number().int().positive(),
    serverId: z.string().min(1).max(128),
    definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    reason: z.enum(["idle", "session_close", "peer_failure", "stale", "failed"]),
  }),
  z.strictObject({
    type: z.literal("mcp_tool_profile_committed"),
    recordVersion: z.literal(1),
    profile: z.strictObject({
      version: z.literal(1),
      generationId: z.uuid(),
      sdk: z.strictObject({
        package: z.literal("@modelcontextprotocol/client"),
        version: z.literal("2.0.0"),
      }),
      projectorVersion: z.literal(1),
      servers: z
        .array(
          z.strictObject({
            serverId: z.string().min(1).max(128),
            definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            protocolVersion: z.string().min(1).max(64),
            serverName: z.string().min(1).max(256),
            serverVersion: z.string().min(1).max(128),
            capabilityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            launchIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          }),
        )
        .min(1)
        .max(4),
      tools: z
        .array(
          z.strictObject({
            serverId: z.string().min(1).max(128),
            serverDefinitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            originalName: z.string().min(1).max(256),
            qualifiedName: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[A-Za-z0-9_]+$/u),
            definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            modelDescription: z.string().max(2 * 1024),
            rawSchema: z.strictObject({
              dialect: z.enum(["unstamped", "2020-12", "2019-09", "draft-07", "draft-06"]),
              provenance: z.literal("tools/list"),
              value: z.record(z.string(), z.unknown()),
              digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            }),
            modelProjection: z.strictObject({
              version: z.literal(1),
              schema: z.record(z.string(), z.unknown()),
              digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            }),
            effect: z.enum(["read", "write", "execute", "network", "delegate", "administrative"]),
            replay: z.literal("never"),
            cancellation: z.literal("abort_signal"),
            outputPolicy: z.strictObject({
              version: z.literal(1),
              maximumInlineBytes: z.literal(64 * 1024),
              maximumRawBytes: z.literal(8 * 1024 * 1024),
              supportedContent: z.tuple([z.literal("text"), z.literal("structured_json")]),
            }),
          }),
        )
        .min(1)
        .max(20),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    }),
    previousAssemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    type: z.literal("mcp_catalog_state_changed"),
    recordVersion: z.literal(1),
    runId: z.uuid().optional(),
    generationId: z.uuid(),
    serverId: z.string().min(1).max(128),
    catalogDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    status: z.literal("stale"),
    reason: z.enum(["list_changed", "server_closed", "shutdown_unconfirmed"]),
  }),
  z.strictObject({
    type: z.literal("mcp_catalog_state_changed"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    serverId: z.string().min(1).max(128),
    catalogDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    status: z.literal("ready"),
    reason: z.literal("revalidated"),
  }),
  z.strictObject({
    type: z.literal("logical_run_started"),
    runId: z.uuid(),
    userMessage: z.string().max(512 * 1024),
    naming: z
      .strictObject({
        profileVersion: z.literal(1),
        fallbackTitle: z
          .string()
          .min(1)
          .max(1_024)
          .refine((value) => sessionTitleFallback(value) === value),
      })
      .optional(),
    skills: z
      .array(
        z.strictObject({
          selection: z
            .string()
            .min(1)
            .max(16_384)
            .refine((value) => /^[\x20-\x7e]+$/u.test(value)),
          requestId: z.string().min(1).max(256),
        }),
      )
      .max(8)
      .optional(),
    limits: sessionRunLimitsSchema.optional(),
    thinkingPolicy: thinkingPolicySnapshotV1Schema.optional(),
  }),
  z.strictObject({
    type: z.literal("session_manual_name_set"),
    recordVersion: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => normalizedSessionTitle(value) === value),
  }),
  z.strictObject({
    type: z.literal("session_manual_name_cleared"),
    recordVersion: z.literal(1),
  }),
  z.strictObject({
    type: z.literal("session_title_generation_started"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    reason: z.enum(["automatic", "regenerate"]),
    targetIdentity: modelTargetIdentitySchema,
  }),
  z.strictObject({
    type: z.literal("session_title_generation_completed"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    title: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => normalizedSessionTitle(value) === value),
    usage: z.union([
      z.strictObject({ status: z.literal("unknown") }),
      z.strictObject({
        status: z.literal("known"),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal("session_title_generation_failed"),
    recordVersion: z.literal(1),
    generationId: z.uuid(),
    reason: z.enum(["model_request_failed", "invalid_title", "process_restart"]),
  }),
  z.strictObject({
    type: z.literal("session_title_generation_skipped_manual"),
    recordVersion: z.literal(1),
  }),
  z.strictObject({
    type: z.literal("skill_activation_batch_committed"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    previousActivationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    skillContext: skillContextRecordV1Schema,
    assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    outcomes: z
      .array(
        z.strictObject({
          selection: z
            .string()
            .min(1)
            .max(16_384)
            .refine((value) => /^[\x20-\x7e]+$/u.test(value)),
          requestId: z.string().min(1).max(512),
          qualifiedId: z.string().min(1).max(16_384),
          status: z.enum(["activated", "already_selected", "already_active"]),
          activationIndex: z.number().int().positive().max(256),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("skill_activated"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    catalogRevision: z.number().int().positive(),
    activationIndex: z.number().int().positive().max(256),
    qualifiedId: z.string().min(1).max(16_384),
    reason: z.enum(["user_explicit", "model_selected"]),
    skillMdDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }),
  z.strictObject({
    type: z.literal("skill_catalog_committed"),
    recordVersion: z.literal(1),
    previousRevision: z.number().int().positive(),
    previousRegistryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    skillContext: skillContextRecordV1Schema,
    assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    reason: z.literal("extension_reconciliation").optional(),
  }),
  z.strictObject({
    type: z.literal("skill_catalog_failed"),
    recordVersion: z.literal(1),
    activeRevision: z.number().int().positive(),
    activeRegistryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    error: z.strictObject({ code: z.literal("skill_catalog_unavailable") }),
  }),
  z.strictObject({
    type: z.literal("skill_revoked"),
    recordVersion: z.literal(1),
    catalogRevision: z.number().int().positive(),
    activationIndex: z.number().int().positive().max(256),
    qualifiedId: z.string().min(1).max(16_384),
    reason: z.literal("extension_disabled"),
    sourceEpoch: z.strictObject({
      lifecycleRevision: z.number().int().nonnegative(),
      lifecycleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    }),
  }),
  z.strictObject({
    type: z.literal("path_context_committed"),
    recordVersion: z.literal(1),
    previousRepositoryRevision: z.number().int().positive(),
    previousRepositoryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    previousSkillRevision: z.number().int().positive(),
    previousSkillRegistryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    repository: repositoryInstructionRevisionV1Schema,
    skillContext: skillContextRecordV1Schema,
    assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    trigger: z.strictObject({
      runId: z.uuid(),
      callId: z.string().min(1).max(256),
      name: z.enum(["read_file", "write_file", "edit_file"]),
      argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      disposition: z.enum(["read_continue", "mutation_retry_required"]),
    }),
  }),
  z.strictObject({
    type: z.literal("path_context_failed"),
    recordVersion: z.literal(1),
    activeRepositoryRevision: z.number().int().positive(),
    activeRepositoryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    activeSkillRevision: z.number().int().positive(),
    activeSkillRegistryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    error: z.strictObject({ code: z.literal("project_context_unavailable") }),
    trigger: z.strictObject({
      runId: z.uuid(),
      callId: z.string().min(1).max(256),
      name: z.enum(["read_file", "write_file", "edit_file"]),
      argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      disposition: z.literal("unavailable"),
    }),
  }),
  z.strictObject({
    type: z.literal("skill_resource_read_committed"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    callId: z.string().min(1).max(256),
    qualifiedId: z.string().min(1).max(16_384),
    activationIndex: z.number().int().positive().max(256),
    catalogRevision: z.number().int().positive(),
    manifestRevision: z.literal(1),
    path: z.string().min(1).max(4_096),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
    byteCount: z.number().int().nonnegative().max(65_536),
    totalByteCount: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
    eof: z.boolean(),
    fileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    pageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    content: z.string().max(65_536),
    executionToken: z.string().max(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal("provider_attempt_started"),
    runId: z.uuid(),
    turn: z.number().int().positive(),
    attempt: z.number().int().positive(),
    targetIdentity: modelTargetIdentitySchema,
    promptProjection: z
      .strictObject({
        version: z.literal(1),
        assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        requestProjectionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("repository_instructions_committed"),
    recordVersion: z.literal(1),
    previousRevision: z.number().int().positive(),
    previousEffectiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    repository: repositoryInstructionRevisionV1Schema,
    assemblyIdentityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    trigger: z
      .strictObject({
        runId: z.uuid(),
        callId: z.string().min(1).max(256),
        name: z.enum(["read_file", "write_file", "edit_file"]),
        argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        disposition: z.enum(["read_continue", "mutation_retry_required"]),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("repository_instructions_failed"),
    recordVersion: z.literal(1),
    activeRevision: z.number().int().positive(),
    activeEffectiveDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    error: z.strictObject({ code: z.enum(repositoryInstructionFailureCodesV1) }),
    trigger: z
      .strictObject({
        runId: z.uuid(),
        callId: z.string().min(1).max(256),
        name: z.enum(["read_file", "write_file", "edit_file"]),
        argumentsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        disposition: z.literal("unavailable"),
      })
      .optional(),
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
    response: z.union([
      z.strictObject({
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
      z.strictObject({
        recordVersion: z.literal(2),
        text: modelResponseFieldSchema,
        reasoning: modelResponseFieldSchema.optional(),
        toolCalls: z.array(toolCallSchema).max(128),
        toolIntents: z.array(sessionToolIntentSchema).max(128),
        finishReason: z.enum(["length", "stop", "tool_calls"]),
        usage: responseUsageSchema.optional(),
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal("model_response_published"),
    recordVersion: z.literal(1),
    runId: z.uuid(),
    responseSequence: z.number().int().positive(),
  }),
  z.union([
    z.strictObject({
      type: z.literal("run_settled"),
      recordVersion: z.literal(1),
      runId: z.uuid(),
      responseSequence: z.number().int().positive(),
      status: z.literal("completed"),
    }),
    z.strictObject({
      type: z.literal("run_settled"),
      recordVersion: z.literal(1),
      runId: z.uuid(),
      responseSequence: z.number().int().positive(),
      status: z.literal("incomplete"),
      reason: z.literal("output_limit"),
    }),
  ]),
  z.strictObject({
    type: z.literal("runtime_event"),
    runId: z.uuid(),
    event: currentCanonicalRuntimeEventSchema,
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
const maxSessionLogBytes = 32 * 1024 * 1024;
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

export function createInMemorySessionStoreDirectory<
  RecordType extends SessionRecord = SessionRecord,
>(): SessionStoreDirectory<RecordType> {
  const stores = new Map<
    string,
    { readonly store: SessionStore<RecordType>; modifiedAtMilliseconds: number }
  >();
  let lastModifiedAtMilliseconds = 0;
  const nextModifiedAtMilliseconds = () => {
    lastModifiedAtMilliseconds = Math.max(Date.now(), lastModifiedAtMilliseconds + 1);
    return lastModifiedAtMilliseconds;
  };
  return {
    async create(sessionId) {
      validateSessionId(sessionId);
      if (stores.has(sessionId)) {
        throw new SessionStoreError("session_log_exists");
      }
      const backing = createInMemorySessionStore<RecordType>();
      const entry = {
        modifiedAtMilliseconds: nextModifiedAtMilliseconds(),
        store: {
          async append(record: RecordType) {
            await backing.append(record);
            entry.modifiedAtMilliseconds = nextModifiedAtMilliseconds();
          },
          read: () => backing.read(),
        },
      };
      stores.set(sessionId, entry);
      return entry.store;
    },
    async listSessionEntries() {
      return [...stores.entries()]
        .map(([sessionId, entry]) => ({
          sessionId,
          modifiedAtMilliseconds: entry.modifiedAtMilliseconds,
        }))
        .sort((left, right) =>
          left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
        );
    },
    async listSessionIds() {
      return [...stores.keys()].sort();
    },
    async open(sessionId) {
      validateSessionId(sessionId);
      const entry = stores.get(sessionId);
      return entry !== undefined && (await entry.store.read()).length > 0 ? entry.store : undefined;
    },
  };
}

export function createJsonlSessionStoreDirectory<
  RecordType extends SessionRecord = SessionRecord,
>(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): SessionStoreDirectory<RecordType> {
  return {
    create(sessionId) {
      return createJsonlSessionStore<RecordType>({ ...options, sessionId });
    },
    async listSessionEntries() {
      const { sessionsDirectory } = await resolveProjectSessionDirectories(options);
      try {
        const files = (await readdir(sessionsDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.jsonl$/u.test(entry.name))
          .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        const entries = await Promise.all(
          files.map(async (file) => {
            try {
              const metadata = await stat(join(sessionsDirectory, file.name));
              return {
                sessionId: file.name.slice(0, -".jsonl".length),
                modifiedAtMilliseconds: metadata.mtimeMs,
              };
            } catch (error) {
              if (isNodeError(error) && error.code === "ENOENT") {
                return null;
              }
              throw error;
            }
          }),
        );
        return entries.filter(
          (
            entry,
          ): entry is { readonly sessionId: string; readonly modifiedAtMilliseconds: number } =>
            entry !== null,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async listSessionIds() {
      const { sessionsDirectory } = await resolveProjectSessionDirectories(options);
      try {
        return (await readdir(sessionsDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.jsonl$/u.test(entry.name))
          .map((entry) => entry.name.slice(0, -".jsonl".length))
          .sort();
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async open(sessionId) {
      validateSessionId(sessionId);
      const sessionPath = await resolveSessionPath({ ...options, sessionId });
      const log = await readBoundedSessionLog(sessionPath);
      if (log === undefined || log.records.length === 0) {
        return undefined;
      }
      return createJsonlStore<RecordType>(sessionPath, log.records.length + 1, log.storedBytes);
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

  const { projectDirectory, projectsDirectory, sessionsDirectory } =
    await resolveProjectSessionDirectories(options);
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
  const log = await readBoundedSessionLog(sessionPath);
  if (log === undefined || log.records.length === 0) {
    throw new SessionStoreError();
  }
  return createJsonlStore<RecordType>(sessionPath, log.records.length + 1, log.storedBytes);
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
      const log = await readBoundedSessionLog(sessionPath);
      return (log?.records ?? []) as readonly RecordType[];
    },
  };
}

export async function readJsonlSessionRecords(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<readonly SessionRecord[]> {
  const sessionPath = await resolveSessionPath(options);
  const log = await readBoundedSessionLog(sessionPath);
  return log?.records ?? [];
}

async function resolveSessionPath(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<string> {
  validateSessionId(options.sessionId);
  const { sessionsDirectory } = await resolveProjectSessionDirectories(options);
  return join(sessionsDirectory, `${options.sessionId}.jsonl`);
}

async function resolveProjectSessionDirectories(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<{
  readonly projectDirectory: string;
  readonly projectsDirectory: string;
  readonly sessionsDirectory: string;
}> {
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectId = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const projectsDirectory = join(options.stateRoot ?? defaultStateRoot(), "projects");
  const projectDirectory = join(projectsDirectory, projectId);
  return {
    projectDirectory,
    projectsDirectory,
    sessionsDirectory: join(projectDirectory, "sessions"),
  };
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

async function readBoundedSessionLog(
  sessionPath: string,
): Promise<
  { readonly records: readonly SessionRecord[]; readonly storedBytes: number } | undefined
> {
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
    const records: SessionRecord[] = [];
    const lineChunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let lineBytes = 0;
    let offset = 0;
    while (true) {
      const { bytesRead } = await file.read(readBuffer, 0, readBuffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      if (offset + bytesRead > maxSessionLogBytes) {
        throw new SessionStoreError("session_log_too_large");
      }
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (readBuffer[index] !== 0x0a) {
          continue;
        }
        const segment = readBuffer.subarray(segmentStart, index);
        if (segment.length > 0) {
          lineChunks.push(Buffer.from(segment));
          lineBytes += segment.length;
        }
        if (lineBytes > maxSessionRecordBytes) {
          throw new SessionStoreError("session_log_too_large");
        }
        records.push(parseSessionRecordBytes(Buffer.concat(lineChunks, lineBytes)));
        lineChunks.length = 0;
        lineBytes = 0;
        segmentStart = index + 1;
      }
      const remainder = readBuffer.subarray(segmentStart, bytesRead);
      if (remainder.length > 0) {
        lineChunks.push(Buffer.from(remainder));
        lineBytes += remainder.length;
        if (lineBytes > maxSessionRecordBytes) {
          throw new SessionStoreError("session_log_too_large");
        }
      }
      offset += bytesRead;
    }
    if (lineBytes !== 0) {
      throw new SessionStoreError();
    }
    return { records: validateRecordSequence(records), storedBytes: offset };
  } finally {
    await file.close();
  }
}

function parseSessionRecordBytes(bytes: Uint8Array): SessionRecord {
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SessionStoreError();
  }
  return parseSessionRecord(line);
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
