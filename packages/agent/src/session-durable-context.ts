import type { ModelMessage } from "./agent-session-contracts.js";
import type { ContextEvidenceV1 } from "./durable-context.js";
import type { InputResourceOccurrenceV1 } from "./input-resources.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type {
  ApprovedPlanProjectionV1,
  PlanApprovalIntentV1,
  PlanCycleSnapshot,
  PlanRevisionIntentV1,
} from "./plan-mode.js";
import type { PromptContextRecord } from "./prompt-assembly.js";
import type {
  ExtensionSkillSourceV1,
  SkillContextRecordV1,
  SkillResourceManifestV1,
} from "./skills.js";
import type { ThinkingPolicySnapshotV1 } from "./thinking-policy.js";
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
  readonly inputResources?: readonly InputResourceOccurrenceV1[] | undefined;
  readonly inputResourceLineageBytes?: number;
  readonly inputResourceRunBytes?: number;
  readonly initialMessages?: readonly ModelMessage[];
  readonly nextSequence: number;
  readonly plan?: PlanCycleSnapshot;
  readonly approvedPlan?: ApprovedPlanProjectionV1;
  readonly planKickoff?: PlanApprovalIntentV1;
  readonly planRevision?: PlanRevisionIntentV1;
  readonly newRunId?: string;
  readonly projectId?: string;
  readonly promptContext?: PromptContextRecord | undefined;
  readonly skillContext?: SkillContextRecordV1 | undefined;
  readonly activeSkillContents?: ReadonlyMap<string, string> | undefined;
  readonly extensionSkillSources?: readonly ExtensionSkillSourceV1[] | undefined;
  readonly preparedExplicitSkillManifests?: ReadonlyMap<string, SkillResourceManifestV1>;
  readonly preparedExplicitSkillPolicies?: ReadonlyMap<string, "allow">;
  readonly withCurrentExtensionSkillSources?:
    | (<T>(
        sources: readonly ExtensionSkillSourceV1[],
        operation: () => Promise<T>,
      ) => Promise<
        { readonly status: "current"; readonly value: T } | { readonly status: "stale" }
      >)
    | undefined;
  readonly referencedModelResponseArtifactBytes?: number;
  readonly repositoryWorkspaceRoot?: string;
  readonly authorizeProjectContextLoad?: (() => Promise<boolean>) | undefined;
  readonly skillResourceLineageBytes?: number;
  readonly skillResourceRunBytes?: number;
  readonly sessionId?: string;
  readonly afterLogicalRunStarted?:
    | ((input: {
        readonly sessionId: string;
        readonly runId: string;
        readonly sequence: number;
      }) => Promise<void>)
    | undefined;
  readonly targetIdentity: ModelTargetIdentity;
  readonly thinkingPolicy?: ThinkingPolicySnapshotV1 | undefined;
  readonly resume?: {
    readonly runId: string;
    readonly pendingExplicitSkills?: readonly {
      readonly selection: string;
      readonly requestId: string;
    }[];
    readonly explicitSkillPermissions?: readonly {
      readonly requestId: string;
      readonly decision: "allow" | "deny";
    }[];
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
      readonly replayResult?: ToolResult | undefined;
    }[];
  };
};
