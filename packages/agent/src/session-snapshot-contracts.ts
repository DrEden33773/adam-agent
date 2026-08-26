import type { ContextUsageTotals, RunResult } from "./agent-session-contracts.js";
import type { ContextProfile } from "./context-profile.js";
import type { McpSessionSnapshot } from "./mcp-host.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { PromptContextSnapshot } from "./prompt-assembly.js";
import type { SessionGenesisRecord } from "./session-store.js";
import type { SkillContextSnapshot } from "./skills.js";

export type CurrentSessionSnapshot = {
  readonly schemaVersion: 3;
  readonly sessionId: string;
  readonly projectId: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly status: "idle" | "interrupted" | "settled";
  readonly lastSequence: number;
  readonly mcp?: McpSessionSnapshot;
  readonly promptContext?: PromptContextSnapshot;
  readonly skillContext?: SkillContextSnapshot;
  readonly context?: SessionContextSnapshot;
  readonly degradation?: {
    readonly code: "model_response_artifact_corrupt" | "model_response_artifact_missing";
    readonly artifactId: string;
    readonly field: "reasoning" | "text";
    readonly responseSequence: number;
  };
  readonly lineage?: SessionGenesisRecord["record"]["lineage"];
  readonly run?: {
    readonly runId: string;
    readonly status: "interrupted" | "settled";
    readonly result?: RunResult;
    readonly lastAttempt?: {
      readonly turn: number;
      readonly attempt: number;
      readonly status: "started" | "interrupted" | "completed";
    };
    readonly lastCompletedResponse?: {
      readonly turn: number;
      readonly attempt: number;
      readonly finishReason: "length" | "stop" | "tool_calls";
    };
  };
};

export type SessionContextSnapshot = {
  readonly profile: ContextProfile;
  readonly checkpoint?: {
    readonly checkpointId: string;
    readonly sequence: number;
    readonly windowNumber: number;
    readonly status: "committed";
    readonly sourceThrough: number;
    readonly retainedFrom: number;
  };
  readonly lastAttempt: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly windowNumber: number;
    readonly status: "started" | "committed" | "failed" | "interrupted";
    readonly reason?: string;
    readonly usage:
      | { readonly status: "unknown" }
      | {
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly reasoningTokens?: number;
          readonly cachedInputTokens?: number;
          readonly cacheMissInputTokens?: number;
        };
  };
  readonly ordinaryUsage: ContextUsageTotals;
  readonly compactionUsage: ContextUsageTotals;
  readonly active:
    | { readonly source: "provider_reported"; readonly tokens: number }
    | { readonly source: "estimated"; readonly tokens: number }
    | { readonly source: "unknown" };
};

export type SessionContextUsageSnapshot = Pick<
  SessionContextSnapshot,
  "active" | "compactionUsage" | "ordinaryUsage"
>;

export type LegacySessionSnapshot = {
  readonly schemaVersion: 1 | 2;
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: "legacy";
  readonly lastSequence: number;
};

export type SessionSnapshot = CurrentSessionSnapshot | LegacySessionSnapshot;

export type SessionResumeResult =
  | { readonly status: "ready"; readonly snapshot: CurrentSessionSnapshot }
  | {
      readonly status: "rejected";
      readonly snapshot: SessionSnapshot;
      readonly error: {
        readonly code:
          | "model_target_incompatible"
          | "model_target_unavailable"
          | "prompt_profile_incompatible"
          | "non_resumable_legacy_session"
          | "session_replay_unavailable";
        readonly message: string;
      };
    };
