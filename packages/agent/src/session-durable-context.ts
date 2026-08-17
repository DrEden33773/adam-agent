import type { ModelMessage } from "./index.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { PermissionPolicyInput, ToolCall, ToolResult } from "./tool-runtime.js";

export const sessionDurableContext = Symbol("adam-agent.session-durable-context");

export type AgentSessionDurableContext = {
  readonly initialMessages?: readonly ModelMessage[];
  readonly nextSequence: number;
  readonly targetIdentity: ModelTargetIdentity;
  readonly resume?: {
    readonly runId: string;
    readonly messages: readonly ModelMessage[];
    readonly nextTurn: number;
    readonly nextAttempt: number;
    readonly reportedTokens: number;
    readonly toolResults: readonly {
      readonly call: ToolCall;
      readonly result: ToolResult;
    }[];
    readonly pendingToolCalls: readonly {
      readonly call: ToolCall;
      readonly requested: boolean;
      readonly started: boolean;
      readonly reusablePermission?: PermissionPolicyInput | undefined;
    }[];
  };
};
