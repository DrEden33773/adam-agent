import type { ArtifactReference, ChangePreviewArtifactSource } from "./artifact-store.js";
import type { ContextCallUsage } from "./durable-context.js";
import type { InputResourceOccurrenceV1 } from "./input-resources.js";
import type { ModelDriverDiagnosticCode, ModelDriverErrorCategory } from "./model-driver-error.js";
import type { PastedTextOccurrenceV1 } from "./pasted-text.js";
import type { ApprovedPlanProjectionV1 } from "./plan-mode.js";
import type { SessionUserContentElementV1 } from "./structured-user-content.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
import type {
  ModelToolDefinition,
  PermissionSubject,
  ToolCall,
  ToolEffect,
  ToolResult,
} from "./tool-runtime.js";

export type UserInput = {
  readonly text: string;
  readonly skills?: readonly string[];
  readonly inputResources?: readonly InputResourceOccurrenceV1[];
  readonly userContent?: readonly SessionUserContentElementV1[];
  readonly pastedTexts?: readonly PastedTextOccurrenceV1[];
  readonly pastedTextContents?: ReadonlyMap<string, string>;
};

export type RunOptions = {
  readonly signal?: AbortSignal;
  readonly limits?: {
    readonly maxTurns?: number;
    readonly maxTokens?: number;
  };
};

export type ModelModalityProfile = {
  readonly profileVersion: 1;
  readonly explicitUserImages: "supported" | "unsupported";
  readonly imageToolResults: "supported" | "unsupported";
};

export type ModelUserContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly artifactId: `sha256:${string}`;
      readonly mediaType: "image/jpeg" | "image/png";
      readonly bytes: Uint8Array;
    };

export type ModelUserContent = string | readonly ModelUserContentPart[];

export type ModelMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "developer"; readonly content: string }
  | { readonly role: "user"; readonly content: ModelUserContent }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoning?: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolResult;
      readonly content?: readonly ModelUserContentPart[];
    };

export type ModelRequest = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly maximumOutputTokens: number;
  readonly purpose?: "ordinary" | "title" | "compaction";
  readonly signal: AbortSignal;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1;
};

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "reasoning_start";
      readonly id: string;
      readonly artifactType: "provider_reasoning";
    }
  | { readonly type: "reasoning_delta"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning_end"; readonly id: string }
  | { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly id: string; readonly json: string }
  | { readonly type: "tool_call_end"; readonly id: string }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly reasoningTokens?: number | undefined;
      readonly cachedInputTokens?: number | undefined;
      readonly cacheMissInputTokens?: number | undefined;
    }
  | {
      readonly type: "finish";
      readonly reason:
        | "stop"
        | "tool_calls"
        | "length"
        | "content_filter"
        | "resource_exhausted"
        | "unknown";
      readonly rawReason?: string | undefined;
    };

export interface ModelDriver {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export type RunResult =
  | {
      readonly status: "completed";
      readonly answer: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: "output_limit";
      readonly answer: string;
    }
  | {
      readonly status: "cancelled";
      readonly error: {
        readonly code: "session_cancelled";
        readonly message: string;
      };
    }
  | {
      readonly status: "failed";
      readonly error:
        | {
            readonly code:
              | "model_stream_incomplete"
              | "model_protocol_invalid"
              | "model_output_truncated"
              | "model_content_filtered"
              | "model_response_artifact_quota_exceeded"
              | "model_response_too_large"
              | "replay_envelope_too_large"
              | "invalid_run_limits"
              | "input_resource_invalid"
              | "input_resource_limit_exceeded"
              | "input_resource_unsupported"
              | "run_already_active"
              | "session_persistence_failed"
              | "turn_limit_exceeded"
              | "token_limit_exceeded"
              | "token_usage_missing"
              | "context_compaction_input_unrecoverable"
              | "context_compaction_invalid"
              | "context_window_unrecoverable";
            readonly message: string;
          }
        | {
            readonly code: "tool_effect_indeterminate";
            readonly reason:
              | "mcp_request_timeout"
              | "mcp_caller_cancelled"
              | "mcp_connection_closed"
              | "mcp_protocol_error"
              | "process_restart";
            readonly message: string;
          }
        | {
            readonly code: "skill_activation_failed";
            readonly message: string;
            readonly ambiguity?:
              | {
                  readonly selection: string;
                  readonly candidates: readonly string[];
                  readonly omittedCount: number;
                }
              | undefined;
          }
        | {
            readonly code: "model_resource_exhausted" | "model_finish_unknown";
            readonly message: string;
            readonly providerReason?: string | undefined;
          }
        | {
            readonly code: "model_request_failed";
            readonly message: string;
            readonly category: ModelDriverErrorCategory;
            readonly diagnosticCode?: ModelDriverDiagnosticCode | undefined;
            readonly status?: number | undefined;
            readonly providerCode?: string | undefined;
            readonly requestId?: string | undefined;
          }
        | {
            readonly code: "context_compaction_failed";
            readonly message: string;
            readonly category: ModelDriverErrorCategory;
            readonly diagnosticCode?: ModelDriverDiagnosticCode | undefined;
            readonly status?: number | undefined;
            readonly providerCode?: string | undefined;
            readonly requestId?: string | undefined;
          };
    };

export type PermissionDecisionCommand = {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
};

export type PermissionDecisionCommandResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly error: {
        readonly code: "permission_request_not_pending" | "invalid_permission_decision";
        readonly message: string;
      };
    };

export type ContextUsageTotals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheMissInputTokens: number;
  readonly unknownCalls: number;
};

export type ActiveContextUsage =
  | {
      readonly source: "provider_reported" | "estimated";
      readonly tokens: number;
      readonly throughSequence: number;
    }
  | {
      readonly source: "unknown";
      readonly throughSequence: number;
    };

export type RuntimeEvent =
  | { readonly type: "user_message"; readonly text: string }
  | { readonly type: "model_message_started" }
  | {
      readonly type: "model_reasoning_started";
      readonly id: string;
      readonly artifactType: "provider_reasoning";
    }
  | { readonly type: "model_reasoning_updated"; readonly id: string; readonly text: string }
  | {
      readonly type: "model_reasoning_settled";
      readonly id: string;
      readonly status: "completed" | "interrupted" | "failed";
    }
  | { readonly type: "model_message_delta"; readonly text: string }
  | { readonly type: "model_message_completed"; readonly text: string }
  | {
      readonly type: "model_usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly reasoningTokens?: number | undefined;
      readonly cachedInputTokens?: number | undefined;
      readonly cacheMissInputTokens?: number | undefined;
    }
  | {
      readonly type: "context_compaction_started";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly trigger: "automatic_threshold" | "provider_overflow";
    }
  | {
      readonly type: "context_compaction_committed";
      readonly attemptId: string;
      readonly checkpointId: string;
      readonly windowNumber: number;
      readonly sourceThrough: number;
      readonly retainedFrom: number;
    }
  | {
      readonly type: "context_compaction_failed";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly reason:
        | "replacement_too_large"
        | "context_window_unrecoverable"
        | "summary_invalid"
        | "model_request_failed"
        | "input_unrecoverable";
    }
  | {
      readonly type: "context_compaction_interrupted";
      readonly attemptId: string;
      readonly attemptNumber: number;
      readonly windowNumber: number;
      readonly reason: "caller_cancelled" | "process_restart";
      readonly usage: ContextCallUsage | { readonly status: "unknown" };
    }
  | {
      readonly type: "context_usage";
      readonly ordinary: ContextUsageTotals;
      readonly compaction: ContextUsageTotals;
      readonly active: ActiveContextUsage;
    }
  | {
      readonly type: "repository_instructions_activated";
      readonly revision: number;
      readonly effectiveDigest: `sha256:${string}`;
      readonly reason: "path_scope_activation";
    }
  | { readonly type: "tool_requested"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_permission_requested";
      readonly requestId: string;
      readonly callId: string;
      readonly name: string;
      readonly effect: ToolEffect;
      readonly scope: "call";
      readonly subject: PermissionSubject;
      readonly changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource> | undefined;
    }
  | {
      readonly type: "tool_permission_decided";
      readonly callId: string;
      readonly name: string;
      readonly decision: "allow" | "deny";
      readonly requestId?: string | undefined;
      readonly effect?: ToolEffect | undefined;
      readonly scope?: "call" | undefined;
      readonly subject?: PermissionSubject | undefined;
      readonly changePreviewRef?: ArtifactReference<ChangePreviewArtifactSource> | undefined;
    }
  | { readonly type: "tool_started"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool_completed";
      readonly callId: string;
      readonly name: string;
      readonly output: Extract<ToolResult, { readonly status: "completed" }>["output"];
    }
  | {
      readonly type: "tool_failed";
      readonly callId: string;
      readonly name: string;
      readonly error: Extract<ToolResult, { readonly status: "failed" }>["error"];
    }
  | {
      readonly type: "mcp_catalog_state_changed";
      readonly generationId: string;
      readonly serverId: string;
      readonly catalogDigest: `sha256:${string}`;
      readonly status: "stale";
      readonly reason: "list_changed";
    }
  | { readonly type: "session_interrupted"; readonly reason: "cancelled" }
  | { readonly type: "session_settled"; readonly result: RunResult };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type RuntimeEventNotification = {
  readonly notificationId: string;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly throughSequence: number;
  readonly event: RuntimeEvent;
};

export type RuntimeEventNotificationListener = (notification: RuntimeEventNotification) => void;
