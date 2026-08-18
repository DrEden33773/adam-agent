import type { ContextEvidenceV1 } from "./durable-context.js";
import type { ModelMessage } from "./index.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { PromptContextRecordV1 } from "./prompt-assembly.js";
import type { PermissionPolicyInput, ToolCall, ToolResult } from "./tool-runtime.js";

export const sessionDurableContext = Symbol("adam-agent.session-durable-context");
export const sessionDurableOutputLimits = Symbol("adam-agent.session-durable-output-limits");

export type AgentSessionDurableOutputLimits = {
  readonly maximumInlineFieldBytes?: number;
  readonly maximumReferencedArtifactBytes?: number;
  readonly maximumResponseContentBytes?: number;
};

export type AgentSessionDurableContext = {
  readonly hasInheritedMessages?: boolean | undefined;
  readonly inheritedEvidence?: ContextEvidenceV1 | undefined;
  readonly initialMessages?: readonly ModelMessage[];
  readonly nextSequence: number;
  readonly projectId?: string;
  readonly promptContext?: PromptContextRecordV1 | undefined;
  readonly referencedModelResponseArtifactBytes?: number;
  readonly repositoryWorkspaceRoot?: string;
  readonly sessionId?: string;
  readonly targetIdentity: ModelTargetIdentity;
  readonly resume?: {
    readonly runId: string;
    readonly messages: readonly ModelMessage[];
    readonly nextTurn: number;
    readonly nextAttempt: number;
    readonly reportedTokens: number;
    readonly compactionUsageUnknown: boolean;
    readonly toolResults: readonly {
      readonly call: ToolCall;
      readonly result: ToolResult;
    }[];
    readonly pendingToolCalls: readonly {
      readonly call: ToolCall;
      readonly requested: boolean;
      readonly started: boolean;
      readonly repositoryDisposition?: "mutation_retry_required" | "read_continue" | "unavailable";
      readonly repositoryActivation?: {
        readonly revision: number;
        readonly effectiveDigest: `sha256:${string}`;
        readonly publishEvent: boolean;
      };
      readonly reusablePermission?: PermissionPolicyInput | undefined;
    }[];
  };
};
