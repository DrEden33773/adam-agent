/**
 * Removes complete CSI, OSC, and APC terminal sequences while preserving visible text.
 * Adapted from @earendil-works/pi-tui 0.84.2 utils (MIT); see THIRD_PARTY_NOTICES.md.
 */
export function stripTerminalSequences(input: string): string {
  if (!input.includes("\u001b")) {
    return input;
  }
  let output = "";
  let index = 0;
  while (index < input.length) {
    const sequenceLength = terminalSequenceLength(input, index);
    if (sequenceLength > 0) {
      index += sequenceLength;
    } else {
      output += input[index] ?? "";
      index += 1;
    }
  }
  return output;
}

export function isUnsafePresentationControl(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function terminalSequenceLength(input: string, index: number): number {
  if (input[index] !== "\u001b") {
    return 0;
  }
  const introducer = input[index + 1];
  if (introducer === "[") {
    let cursor = index + 2;
    while (cursor < input.length && !/[mGKHJ]/u.test(input[cursor] ?? "")) {
      cursor += 1;
    }
    return cursor < input.length ? cursor + 1 - index : 0;
  }
  if (introducer !== "]" && introducer !== "_") {
    return 0;
  }
  let cursor = index + 2;
  while (cursor < input.length) {
    if (input[cursor] === "\u0007") {
      return cursor + 1 - index;
    }
    if (input[cursor] === "\u001b" && input[cursor + 1] === "\\") {
      return cursor + 2 - index;
    }
    cursor += 1;
  }
  return 0;
}

export type ProjectDisplay = {
  readonly id: string;
  readonly label: string;
  readonly workspaceTrust: {
    readonly status: "trusted" | "untrusted" | "unavailable";
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
  };
};

export type ThinkingCapabilityDisplay = {
  readonly capabilityId: string;
  readonly capabilityVersion: 1;
  readonly capabilityDigest: `sha256:${string}`;
  readonly defaultLevelId: string;
  readonly levels: readonly {
    readonly id: string;
    readonly label: string;
    readonly effectiveLevelId: string;
  }[];
};

export type ThinkingPolicySelectionDisplay = {
  readonly requestedLevelId: string;
  readonly capability: {
    readonly id: string;
    readonly version: 1;
    readonly digest: `sha256:${string}`;
  };
};

export type TargetDisplay = {
  readonly targetId: string;
  readonly label: string;
  readonly provider: string;
  readonly displayName: string;
  readonly summary: string;
  readonly capabilities: readonly ("reasoning" | "tool-use")[];
  readonly modalities: readonly ("text" | "image")[];
  readonly recommended: boolean;
  readonly route: "direct" | "vercel-ai-gateway";
  readonly certification: "Certified" | "Experimental";
  readonly upstreamLifecycle?: "Experimental" | "Stable";
  readonly connection?: {
    readonly configured: "Configured" | "Not configured";
    readonly reachability: "Not tested" | "Testing" | "Reachable" | "Unreachable";
    readonly checkedAt: string | null;
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
  };
  readonly readiness: {
    readonly status: "available" | "missing";
    readonly credentialSource: string;
  };
  readonly thinking: ThinkingCapabilityDisplay | null;
  readonly context?: {
    readonly official: ContextProfileDisplay;
    readonly effective: ContextProfileDisplay | null;
    readonly source: {
      readonly contextWindowTokens: "default" | "user";
      readonly maximumOutputTokens: "default" | "user";
      readonly compactAtTokens: "default" | "user";
    };
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
  };
};

export type ContextProfileDisplay = {
  readonly version: number;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly compactAtTokens: number;
  readonly postCompactTargetTokens: number;
  readonly retainedTargetTokens: number;
  readonly estimatorVersion: number;
  readonly ordinaryOutputReserveTokens?: number | undefined;
  readonly compactionSummaryMaximumOutputTokens?: number | undefined;
};

export type UserModelPolicyDisplay = {
  readonly contextWindowTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly automaticCompactionWindowTokens: number | null;
};

export type TargetCatalogDisplay = {
  readonly items: readonly TargetDisplay[];
  readonly defaultTargetId: string | null;
  readonly diagnostic: { readonly code: string; readonly message: string } | null;
  readonly configuration?: {
    readonly modelPolicy: UserModelPolicyDisplay;
    readonly webSearch?: {
      readonly status: "Configured" | "Invalid" | "Unconfigured" | "Unsafe";
      readonly endpoint: string | null;
      readonly syntheticDnsRange: string | null;
      readonly diagnostic: { readonly code: string; readonly message: string } | null;
    };
  };
};

export type SessionSummary = {
  readonly id: string;
  readonly label: string;
  readonly targetId: string;
  readonly status: "idle" | "interrupted" | "settled";
  readonly naming: SessionNaming;
};

export type SessionNaming = {
  readonly manualName: string | null;
  readonly generatedTitle: string | null;
  readonly fallbackTitle: string | null;
  readonly displayLabel: string;
  readonly generation:
    | { readonly status: "not_started" }
    | { readonly status: "in_progress"; readonly generationId: string }
    | {
        readonly status: "completed";
        readonly generationId: string;
        readonly usage:
          | { readonly status: "unknown" }
          | {
              readonly status: "known";
              readonly inputTokens: number;
              readonly outputTokens: number;
            };
      }
    | {
        readonly status: "failed";
        readonly generationId: string;
        readonly reason: "model_request_failed" | "invalid_title" | "process_restart";
      }
    | {
        readonly status: "skipped_manual";
      };
};

export type SessionSummaryPage = {
  readonly items: readonly SessionSummary[];
  readonly nextCursor: string | null;
  readonly diagnostics?: SessionHistoryDiagnosticsDisplay;
  readonly loading?: boolean;
  readonly health?: {
    readonly status: "not_started" | "running" | "complete" | "failed";
    readonly checked: number;
    readonly total: number | null;
  };
  readonly error?: { readonly code: string; readonly message: string };
};

export type SessionHistoryDiagnosticDisplay = {
  readonly sessionId: string;
  readonly stage: "read" | "validate";
  readonly code: "invalid_history" | "invalid_log" | "log_too_large";
  readonly retained: true;
  readonly message: string;
};

export type SessionHistoryDiagnosticsDisplay = {
  readonly items: readonly SessionHistoryDiagnosticDisplay[];
  readonly totalCount: number;
  readonly truncated: boolean;
};

export type AssistantMessageDisplay = {
  readonly type: "assistant_message";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: BranchSourceBoundary | null;
  readonly text: string | null;
  readonly artifact: ArtifactReference | null;
};

export type ReasoningBlockDisplay = {
  readonly type: "reasoning_block";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: BranchSourceBoundary | null;
  readonly artifactType: "provider_reasoning";
  readonly disclosure: "owner_only";
  readonly provider: string;
  readonly status: "active" | "completed" | "interrupted" | "failed";
  readonly text: string | null;
  readonly artifact: ArtifactReference | null;
};

export type ArtifactReference = {
  readonly id: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly source:
    | "model_response"
    | "tool_output"
    | "change_preview"
    | "operation"
    | "plan"
    | "agent_export";
};

export type ArtifactChunk = {
  readonly mediaType: string;
  readonly offset: number;
  readonly byteCount: number;
  readonly totalByteCount: number;
  readonly eof: boolean;
  readonly nextRange: ArtifactRange | null;
  readonly text: string;
};

export type ArtifactRange = {
  readonly offset: number;
  readonly maximumBytes: number;
};

export const presentationArtifactPageMaximumBytes = 16 * 1024;

export type UserMessageDisplay = {
  readonly type: "user_message";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: null;
  readonly text: string;
};

export type CompactionMarkerDisplay = {
  readonly type: "compaction_marker";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: BranchSourceBoundary | null;
  readonly windowNumber: number;
  readonly sourceThrough: number;
  readonly retainedFrom: number;
};

export type SessionNoticeDisplay = {
  readonly type: "session_notice";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: BranchSourceBoundary | null;
} & (
  | { readonly status: "interrupted"; readonly reason: "cancelled" | "process_restart" }
  | { readonly status: "incomplete"; readonly reason: "output_limit" }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
);

export type ToolTextPreviewLine = {
  readonly number: number;
  readonly text: string;
};

export type ToolStreamPreview = {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
};

export type ToolDiffPreviewLine = {
  readonly kind: "meta" | "context" | "addition" | "deletion";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly text: string;
};

export type ToolPreviewDisplay =
  | {
      readonly kind: "read_text";
      readonly language: string | null;
      readonly lines: readonly ToolTextPreviewLine[];
      readonly omittedBytes: number;
      readonly sourceTruncated: boolean;
    }
  | {
      readonly kind: "write_text";
      readonly language: string | null;
      readonly lines: readonly ToolTextPreviewLine[];
      readonly omittedBytes: number;
    }
  | {
      readonly kind: "diff";
      readonly language: string | null;
      readonly lines: readonly ToolDiffPreviewLine[];
      readonly omittedBytes: number;
    }
  | {
      readonly kind: "shell_output";
      readonly termination:
        | { readonly type: "exited"; readonly exitCode: number }
        | { readonly type: "timed_out" }
        | { readonly type: "interrupted" }
        | { readonly type: "signalled"; readonly signal: string };
      readonly stdout: ToolStreamPreview;
      readonly stderr: ToolStreamPreview;
    };

export type ToolCallDisplay = {
  readonly managedAdmissions?: readonly ManagedAdmissionDisplay[];
  readonly type: "tool_call";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: null;
  readonly callId: string;
  readonly qualifiedName: string;
  readonly kind: "read" | "shell" | "mutation" | "mcp" | "web" | "unknown";
  readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative" | null;
  readonly label: string;
  readonly subject: {
    readonly type: "path" | "command" | "generic";
    readonly value: string;
  } | null;
  readonly source: {
    readonly provenance: "provider_model_response";
    readonly sessionId: string;
    readonly responseSequence: number;
    readonly argumentsDigest: string;
    readonly definitionDigest: string | null;
    readonly replay: "safe" | "never";
  } | null;
  readonly durationMs: number | null;
  readonly status:
    | "requested"
    | "permission_required"
    | "running"
    | "completed"
    | "failed"
    | "denied";
  readonly outcome:
    | { readonly status: "completed" }
    | {
        readonly status: "failed";
        readonly code: string;
        readonly message: string;
      }
    | {
        readonly status: "indeterminate";
        readonly code: "tool_effect_indeterminate";
        readonly reason: string | null;
        readonly message: string;
      }
    | {
        readonly status: "denied";
        readonly code: "permission_denied";
        readonly message: string;
      }
    | null;
  readonly resultSummary: string | null;
  readonly artifacts: readonly ArtifactReference[];
  readonly changePreviewRef: ArtifactReference | null;
  readonly preview: ToolPreviewDisplay | null;
};

export type OperationLinkDisplay = {
  readonly type: "operation_link";
  readonly id: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: BranchSourceBoundary;
};

export type PlanSubmissionDisplay = {
  readonly planId: string;
  readonly revision: number;
  readonly contentDigest: `sha256:${string}`;
  readonly title?: string;
  readonly artifact: {
    readonly id: string;
    readonly mediaType: string;
    readonly byteCount: number;
    readonly source: {
      readonly type: "plan";
      readonly schemaVersion: 1;
      readonly projectId: string;
      readonly sessionId: string;
      readonly cycleId: string;
      readonly planId: string;
      readonly revision: number;
      readonly provenance: "model_submit_plan";
    };
  };
  readonly policyVersion:
    | "plan-policy.read-v1"
    | "plan-policy.hybrid-v1"
    | "plan-policy.hybrid-delegation-v1"
    | "plan-policy.hybrid-todo-v1"
    | "plan-policy.hybrid-delegation-todo-v1";
  readonly toolProfileDigest: `sha256:${string}`;
};

export type PlanApprovalDisplay = {
  readonly sessionId: string;
  readonly commandId: string;
  readonly kickoffRunId: string;
  readonly cycleId: string;
  readonly revision: number;
  readonly planId: string;
  readonly contentDigest: `sha256:${string}`;
  readonly policyVersion:
    | "plan-policy.read-v1"
    | "plan-policy.hybrid-v1"
    | "plan-policy.hybrid-delegation-v1"
    | "plan-policy.hybrid-todo-v1"
    | "plan-policy.hybrid-delegation-todo-v1";
  readonly toolProfileDigest: `sha256:${string}`;
};

export type PlanSubmissionHistoryDisplay = {
  readonly type: "plan_submission";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: null;
  readonly cycleId: string;
  readonly status: "ready" | "revision_requested" | "cancelled" | "approved";
  readonly submission: PlanSubmissionDisplay;
  readonly approval: PlanApprovalDisplay | null;
};

export type TranscriptItem =
  | UserMessageDisplay
  | AssistantMessageDisplay
  | ReasoningBlockDisplay
  | CompactionMarkerDisplay
  | SessionNoticeDisplay
  | ToolCallDisplay
  | PlanSubmissionHistoryDisplay
  | OperationLinkDisplay;

export type BranchSourceBoundary = {
  readonly sessionId: string;
  readonly sequence: number;
};

export type TranscriptPage = {
  readonly items: readonly TranscriptItem[];
  readonly olderCursor: string | null;
};

export type SessionContextDisplay = {
  readonly profile: {
    readonly contextWindowTokens: number;
    readonly maximumOutputTokens: number;
    readonly compactAtTokens: number;
    readonly postCompactTargetTokens: number;
    readonly retainedTargetTokens: number;
    readonly estimatorVersion: number;
  };
  readonly ordinaryUsage: ContextUsageDisplay;
  readonly compactionUsage: ContextUsageDisplay;
  readonly active:
    | { readonly source: "provider_reported" | "estimated"; readonly tokens: number }
    | { readonly source: "unknown" };
};

export type ContextUsageDisplay = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheMissInputTokens: number;
  readonly unknownCalls: number;
};

export type TodoPermissionPolicyDisplay =
  | "todo-permission.legacy-v1"
  | "todo-permission.session-v1";

export type ActiveSessionDisplay = {
  readonly todoPermissionPolicy?: TodoPermissionPolicyDisplay;
  readonly parentRun?: {
    readonly phase: "ready" | "running" | "interrupted" | "recovering" | "cancelling";
    readonly editor: "ready" | "blocked";
  };
  readonly recovery?: { readonly runId: string; readonly canResume: boolean };
  readonly session: SessionSummary;
  readonly transcript: TranscriptPage;
  readonly linkedOperations: readonly OperationDisplay[];
  readonly linkedOperationsTruncated: boolean;
  readonly context: SessionContextDisplay | null;
  readonly pendingInteractions: readonly PendingInteraction[];
  readonly repositoryInstructions: RepositoryInstructionsDisplay | null;
  readonly skills: SkillCatalogDisplay | null;
  readonly projectPaths: ProjectPathCatalogDisplay;
  readonly mcp: McpDisplay | null;
  readonly todo?: {
    readonly policyVersion: "todo-policy.v1";
    readonly storeRevision: number;
    readonly counts: {
      readonly pending: number;
      readonly inProgress: number;
      readonly completed: number;
    };
    readonly blockedCount: number;
    readonly overlay?: TodoOverlayDisplay;
  };
  readonly plan?: {
    readonly state: "exploring" | "ready" | "approved_not_started";
    readonly cycleId: string;
    readonly revision: number;
    readonly policyVersion:
      | "plan-policy.read-v1"
      | "plan-policy.hybrid-v1"
      | "plan-policy.hybrid-delegation-v1"
      | "plan-policy.hybrid-todo-v1"
      | "plan-policy.hybrid-delegation-todo-v1";
    readonly shellPolicyVersion?: "plan-shell-policy.v1";
    readonly eligibleToolProfile: {
      readonly version: 1;
      readonly source: { readonly version: 1; readonly digest: `sha256:${string}` };
      readonly definitions: readonly {
        readonly name: string;
        readonly definitionDigest: `sha256:${string}`;
        readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative";
        readonly source: "builtin" | "mcp";
      }[];
      readonly digest: `sha256:${string}`;
    };
    readonly submission?: PlanSubmissionDisplay;
    readonly approval?: PlanApprovalDisplay;
  };
};

/** Bounded layout candidates; counts describe the complete visible set before clipping. */
export type TodoOverlayDisplay = {
  readonly turnId: string | null;
  readonly completedCount: number;
  readonly items: readonly (TodoPageResource["items"][number] & {
    readonly activeForm?: string;
    readonly dependencies: readonly string[];
    readonly dependencyLabels: readonly string[];
    readonly label: string;
  })[];
};

export type OperationCursor = {
  readonly operationId: string;
  readonly sequence: number;
};

type OperationDisplayBase = {
  readonly artifacts: readonly OperationArtifactDisplay[];
  readonly managedReview?: {
    readonly reviewRunId: string;
    readonly progress?:
      | {
          readonly reviewRunId: string;
          readonly phase: "waiting_for_capacity" | "settling" | "terminal";
        }
      | {
          readonly reviewRunId: string;
          readonly phase: "running";
          readonly startedAt: string;
          readonly totalDeadlineAt: string;
          readonly totalMilliseconds: number;
        };
    readonly failure?: { readonly code: string; readonly message: string };
  };
  readonly operationId: string;
  readonly origin: {
    readonly invocation: {
      readonly id: "review";
      readonly kind: "presentation_command";
      readonly version: 1;
    };
    readonly sessionId: string;
    readonly sourceSequence: number;
  };
  readonly provenance: {
    readonly contributionId: string;
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly presentation: "descriptor" | "generic";
    readonly title: string;
  };
  readonly progress: OperationProgressDisplay | null;
};

export type OperationProgressDisplay = {
  readonly summary: string;
};

export type OperationArtifactDisplay = {
  readonly contract: { readonly id: string; readonly version: number };
  readonly reference: ArtifactReference;
  readonly role: "artifact" | "evidence" | "report";
};

export type OperationDisplay =
  | (OperationDisplayBase & {
      readonly status: "running";
      readonly actions: readonly ["cancel"];
      readonly settlement: null;
    })
  | (OperationDisplayBase & {
      readonly status: "cancel_requested";
      readonly actions: readonly [];
      readonly settlement: null;
    })
  | (OperationDisplayBase & {
      readonly status: "completed";
      readonly actions: readonly [];
      readonly settlement: { readonly summary: string | null };
    })
  | (OperationDisplayBase & {
      readonly status: "failed";
      readonly actions: readonly [];
      readonly settlement: { readonly code: string; readonly message: string };
    })
  | (OperationDisplayBase & {
      readonly status: "cancelled";
      readonly actions: readonly [];
      readonly settlement: { readonly reason: "caller" | "extension_disabled" };
    })
  | (OperationDisplayBase & {
      readonly status: "inspection_required";
      readonly actions: readonly [];
      readonly settlement: { readonly message: string };
    })
  | (OperationDisplayBase & {
      readonly status: "recovery_required";
      readonly actions: readonly [] | readonly ["recover"];
      readonly settlement: {
        readonly code: "operation_recovery_required";
        readonly message: string;
      };
    });

export type McpDisplay = {
  readonly schemaVersion: 1;
  readonly status:
    | "workspace_confirmation_required"
    | "server_approval_required"
    | "activation_required"
    | "activation_failed"
    | "mcp_shutdown_unconfirmed"
    | "catalog_stale"
    | "tool_selection_required"
    | "profile_committed"
    | "profile_reactivation_required";
  readonly workspaceConfirmed: boolean;
  readonly source: { readonly path: ".mcp.json"; readonly digest: `sha256:${string}` };
  readonly servers: readonly {
    readonly serverId: string;
    readonly status: "approval_required" | "approved" | "ready" | "unsupported";
    readonly transport: "stdio";
    readonly command:
      | { readonly kind: "executable"; readonly path: string }
      | { readonly kind: "npm_package"; readonly packageName: string; readonly version: string };
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly requestedEnvironmentNames: readonly string[];
    readonly startupEffects: readonly ("execute" | "network")[];
    readonly definitionDigest: `sha256:${string}`;
  }[];
  readonly activation: {
    readonly attempt: number;
    readonly generationId: string;
    readonly status: "activating" | "ready" | "failed" | "cancelled";
  } | null;
  readonly catalog: {
    readonly status: "ready" | "stale";
    readonly digest: `sha256:${string}`;
    readonly tools: readonly {
      readonly serverId: string;
      readonly originalName: string;
      readonly qualifiedName: string;
      readonly description: string;
      readonly rawSchemaDigest: `sha256:${string}`;
      readonly modelProjectionDigest: `sha256:${string}`;
      readonly definitionDigest: `sha256:${string}`;
    }[];
  } | null;
  readonly profile: {
    readonly version: 1;
    readonly digest: `sha256:${string}`;
    readonly projectorVersion: 1;
    readonly tools: readonly {
      readonly serverId: string;
      readonly originalName: string;
      readonly qualifiedName: string;
      readonly definitionDigest: `sha256:${string}`;
      readonly rawSchemaDigest: `sha256:${string}`;
      readonly modelProjectionDigest: `sha256:${string}`;
      readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative";
    }[];
  } | null;
  readonly diagnostics: readonly { readonly code: string; readonly serverId?: string }[];
};

export type ProjectPathCatalogDisplay = {
  readonly items: readonly string[];
  readonly omittedCount: number;
  readonly diagnostic: {
    readonly code: "project_path_catalog_truncated" | "project_path_catalog_unavailable";
  } | null;
  readonly loading?: boolean;
};

export type SkillCatalogDisplay = {
  readonly revision: number;
  readonly items: readonly {
    readonly qualifiedId: string;
    readonly name: string;
    readonly description: string;
    readonly source:
      | { readonly type: "project"; readonly scope: string }
      | { readonly type: "user" }
      | {
          readonly type: "extension";
          readonly extensionId: string;
          readonly packageName: string;
          readonly packageVersion: string;
        };
    readonly active: boolean;
  }[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly source: "project" | "user" | "extension";
    readonly scope?: string;
    readonly extensionId?: string;
    readonly packageName?: string;
    readonly packageVersion?: string;
    readonly packagePath: string;
    readonly field?: string;
    readonly bound?: {
      readonly maximum: number;
      readonly unit: "bytes" | "estimated_tokens" | "fields";
    };
  }[];
  readonly overflow: {
    readonly omittedCount: number;
    readonly shortenedCount: number;
  };
  readonly reloadAvailable: boolean;
};

export type SkillMentionResolution =
  | {
      readonly status: "resolved";
      readonly text: string;
      readonly qualifiedIds: readonly string[];
    }
  | {
      readonly status: "ambiguous";
      readonly text: string;
      readonly name: string;
      readonly candidateQualifiedIds: readonly string[];
    };

export function resolveSkillMentions(input: {
  readonly text: string;
  readonly explicitQualifiedIds: readonly string[];
  readonly catalog: SkillCatalogDisplay | null;
}): SkillMentionResolution {
  const resolved = [...new Set(input.explicitQualifiedIds)];
  if (input.catalog === null) {
    return { status: "resolved", text: input.text, qualifiedIds: resolved };
  }
  const candidatesByName = Map.groupBy(input.catalog.items, (item) => item.name);
  for (const match of input.text.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/gu)) {
    const name = match[1];
    const offset = match.index;
    const preceding = offset === 0 ? undefined : input.text[offset - 1];
    const following = input.text[offset + match[0].length];
    if (
      name === undefined ||
      (preceding !== undefined && /[A-Za-z0-9_$\\]/u.test(preceding)) ||
      (following !== undefined && /[A-Za-z0-9_-]/u.test(following))
    ) {
      continue;
    }
    const candidates = candidatesByName.get(name) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const explicitlySelected = candidates.filter((candidate) =>
      resolved.includes(candidate.qualifiedId),
    );
    const selected =
      candidates.length === 1
        ? candidates[0]
        : explicitlySelected.length === 1
          ? explicitlySelected[0]
          : undefined;
    if (selected === undefined) {
      return {
        status: "ambiguous",
        text: input.text,
        name,
        candidateQualifiedIds: candidates.map((candidate) => candidate.qualifiedId),
      };
    }
    if (!resolved.includes(selected.qualifiedId)) {
      resolved.push(selected.qualifiedId);
    }
  }
  return { status: "resolved", text: input.text, qualifiedIds: resolved };
}

export type RepositoryInstructionsDisplay = {
  readonly revision: number;
  readonly activeScopes: readonly string[];
  readonly sources: readonly {
    readonly scope: string;
    readonly path: string;
    readonly selectedName: "AGENTS.md" | "AGENTS.override.md";
    readonly loadReason: "explicit_reload" | "path_scope_activation" | "root_eager";
  }[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly scope?: string;
    readonly path?: string;
    readonly candidate?: string;
  }[];
  readonly effectiveDigest: string;
  readonly reloadAvailable: boolean;
};

export type PendingInteraction = {
  readonly delegation?: ManagedDelegationEnvelope;
  readonly delegationCanChangeMode?: boolean;
  readonly delegationMessages?: readonly ManagedDelegationMessage[];
  readonly type: "permission";
  readonly requestId: string;
  readonly callId: string;
  readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative";
  readonly subject: { readonly type: "path" | "command" | "generic"; readonly value: string };
  readonly warning?: string;
  readonly canAllow: boolean;
  readonly changePreviewRef: ArtifactReference | null;
};

export type PresentationFault = {
  readonly code: "authoritative_state_unavailable";
  readonly message: string;
};

export type NewSessionDraftDisplay = {
  readonly targetId: string;
  readonly mode: "default" | "plan";
  readonly skills: SkillCatalogDisplay;
  readonly projectPaths: ProjectPathCatalogDisplay;
};

export type DraftPoint =
  | { readonly edge: "start" | "end" }
  | { readonly elementId: string; readonly edge: "before" | "after" }
  | { readonly elementId: string; readonly offset: number };

export type AtMentionAtom = { readonly type: "mention"; readonly literal: string } & (
  | { readonly kind: "literal" }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "role"; readonly qualifiedRoleId: string; readonly definitionDigest: string }
  | {
      readonly kind: "agent";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly handle: string;
    }
  | { readonly kind: "main" }
);

export type DraftMentionElement = AtMentionAtom & { readonly elementId: string };

export function leadingMentionRecipients(
  elements: readonly ({ readonly type: string; readonly text?: string } | DraftMentionElement)[],
): readonly DraftMentionElement[] {
  const recipients: DraftMentionElement[] = [];
  for (const element of elements) {
    if (element.type === "text" && "text" in element && element.text?.trim().length === 0) continue;
    if (
      element.type !== "mention" ||
      !("kind" in element) ||
      !["role", "agent", "main"].includes(element.kind)
    )
      break;
    recipients.push(element);
  }
  return recipients;
}

export type DraftTextDocumentPart =
  | DraftMentionElement
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource"; readonly elementId: string }
  | { readonly type: "pasted_text"; readonly elementId: string }
  | {
      readonly type: "skill";
      readonly elementId: string;
      readonly name: string;
      readonly qualifiedId: string;
    }
  | { readonly type: "path"; readonly elementId: string; readonly path: string };

export type TurnComposerDisplay = {
  readonly attachmentAvailable: boolean;
  readonly canUndo: boolean;
  readonly draftRevision: number;
  readonly elements: readonly (
    | DraftMentionElement
    | { readonly elementId: string; readonly type: "text"; readonly text: string }
    | {
        readonly elementId: string;
        readonly type: "resource";
        readonly kind: "file" | "image";
        readonly ordinal: number;
        readonly resourceId: string;
      }
    | {
        readonly elementId: string;
        readonly type: "pasted_text";
        readonly ordinal: number;
        readonly pastedTextId: string;
      }
    | {
        readonly type: "skill";
        readonly elementId: string;
        readonly name: string;
        readonly qualifiedId: string;
        readonly available: boolean;
      }
    | { readonly type: "path"; readonly elementId: string; readonly path: string }
  )[];
  readonly renderedText: string;
  readonly unavailableReason: string | null;
  readonly sealed: boolean;
  readonly revisionIntent: {
    readonly sessionId: string;
    readonly cycleId: string;
    readonly revision: number;
    readonly planId: string;
    readonly contentDigest: `sha256:${string}`;
  } | null;
  readonly resources: readonly {
    readonly id: string;
    readonly elementId: string;
    readonly displayName: string;
    readonly state: "queued" | "copying" | "ready" | "failed" | "cancelled" | "removed";
    readonly byteCount: number | null;
    readonly kind: "file" | "image";
    readonly mediaHint: "binary" | "image" | "text" | null;
    readonly ordinal: number;
    readonly origin: "pasted_image" | "selected_file";
    readonly support: "image" | "unsupported_binary" | "utf8_text" | null;
    readonly diagnostic: string | null;
    readonly token: string;
  }[];
  readonly pastedTexts: readonly {
    readonly id: string;
    readonly elementId: string;
    readonly ordinal: number;
    readonly token: string;
    readonly state: "copying" | "ready" | "failed" | "removed";
    readonly byteCount: number;
    readonly lineCount: number;
    readonly scalarCount: number;
    readonly origin: "pasted_text";
    readonly preview: string;
    readonly diagnostic: string | null;
  }[];
};

export type AuthoritativePresentationSnapshot = {
  readonly managedControl?: ManagedWorkspaceSnapshot;
  readonly managedTransition?: ManagedSessionTransition;
  readonly schemaVersion: 1;
  readonly continuity:
    | {
        readonly status: "current";
        readonly sessionThroughSequence: number;
        readonly operationThrough: readonly OperationCursor[];
      }
    | { readonly status: "repairing"; readonly reason: "open" | "gap" | "reconnect" }
    | { readonly status: "degraded"; readonly fault: PresentationFault };
  readonly project: ProjectDisplay;
  readonly targets: TargetCatalogDisplay;
  readonly sessions: SessionSummaryPage;
  readonly active: ActiveSessionDisplay | null;
  readonly managedAgents: {
    readonly counts: {
      readonly active: number;
      readonly terminal: number;
      readonly attention: number;
    };
    readonly agents: readonly {
      readonly readOnly?: true;
      readonly agentId: string;
      readonly attemptId: string;
      readonly profile:
        | "scout.v1"
        | "scout.v2"
        | "scout.v3"
        | "research.v1"
        | "research.v2"
        | "research.v3";
      readonly mode: "foreground" | "background";
      readonly targetIdentity: {
        readonly targetId: string;
        readonly vendor: string;
        readonly modelId: string;
        readonly route: string;
        readonly profileVersion: number;
        readonly certification: "certified" | "experimental";
        readonly upstreamId?: string;
      };
      readonly thinkingPolicy?: {
        readonly schemaVersion: 1;
        readonly requestedLevelId: string;
        readonly effectiveLevelId: string;
        readonly capability: {
          readonly id: string;
          readonly version: number;
          readonly digest: `sha256:${string}`;
        };
        readonly mapping: {
          readonly requestPath: string;
          readonly thinkingType: string;
          readonly reasoningEffort?: string;
        };
        readonly reasoningArtifact: "provider_reasoning";
      };
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
        readonly current: boolean;
        readonly throughSequence: number;
      }[];
      readonly result?:
        | { readonly text: string }
        | {
            readonly artifact: {
              readonly id: string;
              readonly mediaType: string;
              readonly byteCount: number;
            };
          };
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
      readonly reports?: readonly {
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
      readonly taskBudget?: {
        readonly policy: NonNullable<ManagedDelegationEnvelope["taskBudget"]>;
        readonly usage: NonNullable<ManagedWorkspaceSnapshot["budget"]>;
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
        readonly maximumInactivityMilliseconds: 300000;
      };
    }[];
  };
};

export type ToolArgumentsDisplay = {
  readonly callId: string;
  readonly name: string;
  readonly status: "generating_arguments" | "awaiting_model_completion" | "processing_response";
};

export type PresentationTransientState = {
  readonly argumentCalls?: readonly ToolArgumentsDisplay[];
  readonly toolArguments?: ToolArgumentsDisplay;
  readonly activity: "working" | "replying" | "using_tool" | null;
  readonly assistant: {
    readonly streamId: string;
    readonly afterSequence: number;
    readonly text: string;
  } | null;
  readonly reasoning: {
    readonly id: string;
    readonly afterSequence: number;
    readonly artifactType: "provider_reasoning";
    readonly disclosure: "owner_only";
    readonly provider: string;
    readonly status: "active" | "completed" | "interrupted" | "failed";
    readonly text: string;
  } | null;
};

export type AgentUiSettings = {
  readonly widgetMode: "background" | "all" | "off";
  readonly fleetEnabled: boolean;
  readonly showModel: boolean;
  readonly viewerMode: "raw" | "assistant" | "full";
  readonly mentions: "direct" | "off";
};
export const defaultAgentUiSettings: AgentUiSettings = Object.freeze({
  widgetMode: "background",
  fleetEnabled: true,
  showModel: false,
  viewerMode: "assistant",
  mentions: "direct",
});
export function nextAgentViewerMode(
  mode: AgentUiSettings["viewerMode"],
): AgentUiSettings["viewerMode"] {
  return mode === "raw" ? "assistant" : mode === "assistant" ? "full" : "raw";
}
export function isAgentUiSettings(value: unknown): value is AgentUiSettings {
  if (typeof value !== "object" || value === null) return false;
  return (
    "widgetMode" in value &&
    typeof value.widgetMode === "string" &&
    ["background", "all", "off"].includes(value.widgetMode) &&
    "fleetEnabled" in value &&
    typeof value.fleetEnabled === "boolean" &&
    "showModel" in value &&
    typeof value.showModel === "boolean" &&
    "viewerMode" in value &&
    typeof value.viewerMode === "string" &&
    ["raw", "assistant", "full"].includes(value.viewerMode) &&
    "mentions" in value &&
    typeof value.mentions === "string" &&
    ["direct", "off"].includes(value.mentions)
  );
}

export type AgentRoleTypeDisplay = {
  readonly qualifiedId: string;
  readonly name: string;
  readonly description: string;
  readonly definitionDigest: string;
  readonly base: "explore" | "research";
  readonly tools: readonly string[];
  readonly web: boolean;
  readonly source?:
    | { readonly kind: "builtin" | "project" | "user"; readonly path?: string | undefined }
    | undefined;
  readonly instructions?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly skills?: boolean | string[] | undefined;
  readonly contextMode?: "task" | "current_request" | undefined;
  readonly limits?:
    | { readonly maxTokens?: number | undefined; readonly maxTurns?: number | undefined }
    | undefined;
};
export type AgentRoleDefinitionInput = {
  name: string;
  description: string;
  base: "explore" | "research";
  tools?: string[];
  skills?: boolean | string[];
  web?: boolean;
  context_mode?: "task" | "current_request";
  model?: string;
  thinking?: string;
  limits?: { maxTokens?: number | undefined; maxTurns?: number | undefined };
  overrides?: string;
};
export type AgentRoleMutation =
  | {
      readonly action: "create";
      readonly source: "project" | "user";
      readonly fields: AgentRoleDefinitionInput;
      readonly instructions: string;
      readonly original?: { readonly qualifiedId: string; readonly definitionDigest: string };
    }
  | {
      readonly action: "toggle";
      readonly qualifiedId: string;
      readonly definitionDigest: string;
      readonly enabled: boolean;
    };
export type AgentTypesDisplay = {
  readonly sources: readonly {
    readonly kind: "project" | "user";
    readonly path: string;
    readonly writable: boolean;
  }[];
  readonly definitions: readonly (AgentRoleTypeDisplay & {
    readonly enabled: boolean;
    readonly available: boolean;
  })[];
  readonly diagnostics: readonly { readonly source: string; readonly message: string }[];
  readonly targets: readonly {
    readonly targetId: string;
    readonly label: string;
    readonly thinkingLevels?: readonly { readonly id: string; readonly label: string }[];
  }[];
};

/** Current execution diagnostics; never a replacement for durable session state. */
export type SessionExecutionFailure = {
  readonly category:
    | "encoding_rejected"
    | "storage_io_failed"
    | "append_outcome_uncertain"
    | "execution_failed";
  readonly stage:
    | "admission"
    | "open"
    | "permissions"
    | "write"
    | "sync"
    | "close"
    | "adapter"
    | "artifact"
    | "execution"
    | "barrier";
  readonly phase:
    | "user_input"
    | "model_response"
    | "tool_execution"
    | "tool_result"
    | "run_settlement"
    | "session_metadata"
    | "execution";
  readonly writeOutcome: "not_written" | "committed" | "uncertain" | null;
  readonly reason:
    | "invalid_record"
    | "size_limit"
    | "sequence_mismatch"
    | "permission_denied"
    | "storage_full"
    | "read_only"
    | "unavailable"
    | "io_error"
    | "unknown";
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly callId: string | null;
  readonly attemptedSequence: number | null;
  readonly message: string;
};

export type PresentationDisplayState = {
  readonly executionFailure?: SessionExecutionFailure;
  readonly agentTypes?: AgentTypesDisplay;
  readonly agentRoles?: readonly {
    readonly qualifiedId: string;
    readonly name: string;
    readonly description: string;
    readonly definitionDigest: string;
  }[];
  readonly agentUiSettings?: AgentUiSettings;
  readonly managedAttention?: readonly ManagedAttentionItem[];
  readonly managedDrafts?: readonly Pick<
    ManagedComposerDraft,
    "parentSessionId" | "threadId" | "expectedTurnId"
  >[];
  readonly revision: number;
  readonly authoritative: AuthoritativePresentationSnapshot;
  readonly draft: NewSessionDraftDisplay | null;
  readonly composer: TurnComposerDisplay;
  readonly transient: PresentationTransientState | null;
  readonly managedAgentActivity?: readonly {
    readonly agentId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly activity: "thinking" | "replying" | "using_tool";
    readonly assistant?: {
      readonly itemId: string;
      readonly text: string;
      readonly totalByteCount?: number;
      readonly omittedBytes?: number;
    };
    readonly reasoning?: {
      readonly itemId: string;
      readonly status: "active" | "completed" | "interrupted" | "failed";
      readonly hasContent: boolean;
    };
    readonly argumentCalls?: readonly ToolArgumentsDisplay[];
    readonly tool?: {
      readonly callId: string;
      readonly name: string;
      readonly status: ToolArgumentsDisplay["status"] | "requested" | "running";
    };
  }[];
};

export type PresentationUpdate =
  | {
      readonly type: "assistant_delta";
      readonly streamId: string;
      readonly afterSequence: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning_snapshot";
      readonly afterSequence: number;
      readonly reasoning: NonNullable<PresentationTransientState["reasoning"]>;
    }
  | {
      readonly type: "authoritative_snapshot";
      readonly snapshot: AuthoritativePresentationSnapshot;
    };

export type CommandReceipt =
  | {
      readonly status: "admitted";
      readonly commandId: string;
      readonly resource: ArtifactChunk | null;
      readonly draftText?: string;
      readonly draftCleanupFailed?: true;
      readonly roleTarget?: {
        readonly qualifiedId: string;
        readonly definitionDigest: string;
        readonly source: string;
        readonly message: string;
        readonly targets: readonly { readonly targetId: string; readonly label: string }[];
      };
      readonly delegation?: {
        readonly messages: readonly ManagedDelegationMessage[];
        readonly envelope: ManagedDelegationEnvelope;
        readonly description: string;
      };
      readonly agentInput?: {
        readonly input: Omit<ManagedComposerDraft, "mode">;
        readonly actions: readonly ManagedComposerDraft["mode"][];
        readonly envelope?: ManagedDelegationEnvelope;
      };
      readonly todo?: TodoPageResource | TodoEntityResource;
      readonly managedAgentTranscript?: ManagedAgentTranscriptPageResource;
      readonly managedDraft?: ManagedComposerDraft | null;
      readonly managedDraftCleared?: boolean;
      readonly agentExport?: ManagedAgentExport;
      readonly control?: ManagedControlReceipt;
      readonly managedAgentControl?: {
        readonly action: "message" | "reply" | "cancel" | "follow_up" | "recovery";
        readonly agentId: string;
        readonly attemptId: string;
        readonly revision: number;
        readonly messageId?: `sha256:${string}`;
        readonly delivery?: "enqueued" | "delivered";
        readonly record?: {
          readonly id: string;
          readonly revision: number;
          readonly digest: `sha256:${string}`;
        };
      };
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "not_available"
        | "transition_required"
        | "stale_interaction"
        | "conflict"
        | "invalid_command"
        | "authority_rejected"
        | "stale_revision"
        | "capacity_exhausted"
        | "storage_quota_exceeded"
        | "budget_exhausted"
        | "plan_policy_paused"
        | "attempt_limit"
        | "authority_busy"
        | "action_unavailable"
        | "recovery_required"
        | "runtime_unavailable"
        | "persistence_failed"
        | "presentation_closed";
      readonly message: string;
    }
  | {
      readonly status: "rejected";
      readonly code: "thinking_policy_unsupported";
      readonly message: string;
      readonly supportedLevelIds: readonly string[];
    };

export type TodoPageResource = {
  readonly type: "todo_page";
  readonly policyVersion: "todo-policy.v1";
  readonly storeRevision: number;
  readonly items: readonly {
    readonly id: string;
    readonly createdOrdinal: number;
    readonly itemRevision: number;
    readonly status: "pending" | "in_progress" | "completed";
    readonly title: string;
    readonly activeForm?: string;
    readonly dependencyCount: number;
    readonly blocked: boolean;
  }[];
  readonly nextCursor: string | null;
};

export type TodoEntityResource = {
  readonly type: "todo_entity";
  readonly policyVersion: "todo-policy.v1";
  readonly storeRevision: number;
  readonly item: {
    readonly id: string;
    readonly createdOrdinal: number;
    readonly itemRevision: number;
    readonly status: "pending" | "in_progress" | "completed";
    readonly title: string;
    readonly activeForm?: string;
    readonly details?: string;
    readonly dependencyIds: readonly string[];
  };
};

export type ManagedAgentTranscriptPageResource = {
  readonly turnId?: string;
  readonly cursor?: string;
  readonly type: "managed_agent_transcript_page";
  readonly agentId: string;
  readonly attemptId: string;
  readonly childSessionId: string;
  readonly throughSequence: number;
  readonly items: readonly TranscriptItem[];
  readonly olderCursor: string | null;
};

export type PresentationCommand =
  | { readonly type: "upgrade_todo_permission_policy"; readonly sessionId: string }
  | {
      readonly type: "direct_agent_input";
      readonly draftRevision: number;
      readonly confirmedInput?: ManagedComposerDraft;
      readonly confirmedEnvelope?: ManagedDelegationEnvelope;
    }
  | { readonly type: "refresh_agent_types"; readonly sessionId: string }
  | {
      readonly type: "mutate_agent_types";
      readonly sessionId: string;
      readonly confirmed: true;
      readonly mutation: AgentRoleMutation;
    }
  | {
      readonly type: "configure_role_target";
      readonly qualifiedId: string;
      readonly definitionDigest: string;
      readonly model: string | null;
      readonly draftRevision: number;
      readonly confirmed: true;
    }
  | {
      readonly type: "direct_delegation";
      readonly description?: string;
      readonly limits?: ManagedDelegationLimits;
      readonly skills?: readonly string[];
      readonly context?: ManagedDelegationContext;
      readonly draftRevision: number;
      readonly thinkingSelection?: ThinkingPolicySelectionDisplay | null;
      readonly confirmedEnvelope?: ManagedDelegationEnvelope;
    }
  | {
      readonly type: "export_agent";
      readonly confirmed: true;
      readonly sessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly completion: ManagedControlLink;
      readonly fields: readonly AgentExportField[];
    }
  | {
      readonly type: "read_agent_input";
      readonly sessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly inputId: string;
      readonly range: ArtifactRange;
    }
  | {
      readonly type: "read_agent_content";
      readonly kind: "reasoning" | "tool";
      readonly sessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly itemId: string;
      readonly range: ArtifactRange;
    }
  | {
      readonly type: "read_agent_artifact";
      readonly sessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly artifact: ArtifactReference;
      readonly range: ArtifactRange;
    }
  | { readonly type: "set_agent_ui_settings"; readonly settings: AgentUiSettings | null }
  | { readonly type: "read_agent_draft"; readonly sessionId: string; readonly threadId: string }
  | {
      readonly type: "save_agent_draft" | "clear_agent_draft";
      readonly draft: ManagedComposerDraft;
    }
  | {
      readonly type: "read_agent_conversation";
      readonly sessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly cursor: string | null;
    }
  | {
      readonly type: "resolve_managed_transition";
      readonly transitionId: string;
      readonly decision: "stay" | "wait" | "suspend";
    }
  | {
      readonly type: "managed_control";
      readonly commandId: string;
      readonly command: ManagedControlCommand;
    }
  | { readonly type: "refresh_managed_agents"; readonly sessionId: string }
  | {
      readonly type: "read_managed_agent_transcript";
      readonly sessionId: string;
      readonly agentId: string;
      readonly attemptId: string;
      readonly expectedRevision: number;
      readonly expectedThroughSequence: number;
      readonly cursor: string | null;
    }
  | {
      readonly type: "read_managed_agent_artifact";
      readonly sessionId: string;
      readonly agentId: string;
      readonly attemptId: string;
      readonly expectedRevision: number;
      readonly expectedThroughSequence: number;
      readonly artifact: ArtifactReference;
      readonly range: ArtifactRange;
    }
  | {
      readonly type: "cancel_managed_agent";
      readonly sessionId: string;
      readonly agentId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "send_managed_agent_message";
      readonly sessionId: string;
      readonly agentId: string;
      readonly expectedRevision: number;
      readonly message: string;
      readonly attentionId?: string;
    }
  | {
      readonly type: "follow_up_managed_agent";
      readonly sessionId: string;
      readonly agentId: string;
      readonly expectedRevision: number;
      readonly task: string;
      readonly additionalBudgetTokens?: number;
    }
  | {
      readonly type: "recover_managed_agent";
      readonly sessionId: string;
      readonly agentId: string;
      readonly expectedRevision: number;
      readonly task: string;
      readonly additionalBudgetTokens?: number;
    }
  | {
      readonly type: "select_session";
      readonly sessionId: string;
    }
  | {
      readonly type: "create_session";
      readonly targetId: string;
    }
  | {
      readonly type: "set_draft_mode";
      readonly mode: "default" | "plan";
    }
  | {
      readonly type: "enter_plan";
      readonly sessionId: string;
    }
  | {
      readonly type: "list_todos";
      readonly sessionId: string;
      readonly expectedStoreRevision: number;
      readonly filter: {
        readonly status: "pending" | "in_progress" | "completed" | null;
        readonly titleContains: string | null;
      };
      readonly limit: number;
      readonly cursor: string | null;
    }
  | {
      readonly type: "get_todo";
      readonly sessionId: string;
      readonly expectedStoreRevision: number;
      readonly id: string;
    }
  | {
      readonly type: "revise_plan";
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    }
  | {
      readonly type: "approve_plan";
      readonly commandId: string;
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    }
  | {
      readonly type: "continue_plan";
      readonly commandId: string;
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    }
  | {
      readonly type: "cancel_plan";
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
      readonly planId: string;
      readonly contentDigest: `sha256:${string}`;
    }
  | {
      readonly type: "exit_plan";
      readonly sessionId: string;
      readonly cycleId: string;
      readonly revision: number;
    }
  | {
      readonly type: "set_default_target";
      readonly targetId: string | null;
    }
  | {
      readonly type: "set_model_policy";
      readonly field:
        | "contextWindowTokens"
        | "maximumOutputTokens"
        | "automaticCompactionWindowTokens";
      readonly value: number | null;
    }
  | { readonly type: "test_and_set_web_search"; readonly endpoint: string }
  | { readonly type: "cancel_web_search_test" }
  | { readonly type: "clear_web_search" }
  | { readonly type: "set_web_synthetic_dns_range"; readonly range: string | null }
  | {
      readonly type: "test_target_connection" | "cancel_target_connection_test";
      readonly targetId: string;
    }
  | {
      readonly type: "set_workspace_trust";
      readonly projectId: string;
      readonly trusted: boolean;
    }
  | {
      readonly type: "load_older_transcript";
      readonly before: string;
    }
  | {
      readonly type: "load_more_sessions";
      readonly after: string;
    }
  | {
      readonly type: "read_artifact";
      readonly artifact: ArtifactReference;
      readonly range: ArtifactRange | null;
    }
  | {
      readonly type: "set_session_manual_name";
      readonly sessionId: string;
      readonly name: string;
    }
  | {
      readonly type: "clear_session_manual_name";
      readonly sessionId: string;
    }
  | {
      readonly type: "regenerate_session_title";
      readonly sessionId: string;
    }
  | {
      readonly type: "reload_repository_instructions";
      readonly sessionId: string;
    }
  | {
      readonly type: "reload_skills";
      readonly sessionId: string;
    }
  | {
      readonly type: "confirm_mcp_workspace";
      readonly sessionId: string;
      readonly sourceDigest: `sha256:${string}`;
    }
  | {
      readonly type: "approve_mcp_server";
      readonly sessionId: string;
      readonly serverId: string;
      readonly definitionDigest: `sha256:${string}`;
    }
  | {
      readonly type: "activate_mcp_servers";
      readonly sessionId: string;
      readonly servers: readonly {
        readonly serverId: string;
        readonly definitionDigest: `sha256:${string}`;
      }[];
    }
  | {
      readonly type: "commit_mcp_tool_profile";
      readonly sessionId: string;
      readonly generationId: string;
      readonly selections: readonly {
        readonly qualifiedName: string;
        readonly definitionDigest: `sha256:${string}`;
        readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative";
      }[];
    }
  | {
      readonly type: "retry_mcp_activation";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "revalidate_mcp_catalog";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "submit_prompt";
      readonly sessionId: string;
      readonly text: string;
      readonly skills: readonly string[];
      readonly thinkingSelection: ThinkingPolicySelectionDisplay | null;
    }
  | {
      readonly type: "submit_draft_prompt";
      readonly text: string;
      readonly skills: readonly string[];
      readonly thinkingSelection: ThinkingPolicySelectionDisplay | null;
    }
  | {
      readonly type: "stage_input_resource";
      readonly path: string;
      readonly mutation?: {
        readonly at: DraftPoint;
        readonly baseRevision: number;
      };
    }
  | {
      readonly type: "stage_pasted_text";
      readonly text: string;
      readonly mutation?: {
        readonly at: DraftPoint;
        readonly baseRevision: number;
      };
    }
  | {
      readonly type: "replace_draft_text";
      readonly baseRevision: number;
      readonly document: readonly DraftTextDocumentPart[];
    }
  | {
      readonly type: "remove_draft_element";
      readonly baseRevision: number;
      readonly elementId: string;
    }
  | {
      readonly type: "resolve_draft_recipient";
      readonly baseRevision: number;
      readonly elementId: string;
      readonly action: "keep" | "literal" | "retarget";
      readonly replacement?: AtMentionAtom;
    }
  | {
      readonly type: "undo_draft";
      readonly baseRevision: number;
    }
  | {
      readonly type: "clear_draft";
      readonly baseRevision: number;
    }
  | { readonly type: "read_expanded_draft" }
  | {
      readonly type: "update_draft_text";
      readonly text: string;
    }
  | {
      readonly type: "remove_input_resource" | "cancel_input_resource";
      readonly resourceId: string;
    }
  | {
      readonly type: "cancel_run";
      readonly sessionId: string | null;
    }
  | {
      readonly type: "resume_interrupted_session" | "cancel_interrupted_session";
      readonly sessionId: string;
      readonly runId: string;
    }
  | {
      readonly type: "start_project_changes";
      readonly sessionId: string;
      readonly command: {
        readonly id: string;
        readonly version: number;
      };
    }
  | {
      readonly type: "cancel_operation";
      readonly operationId: string;
    }
  | {
      readonly type: "recover_operation";
      readonly operationId: string;
    }
  | {
      readonly type: "decide_permission";
      readonly requestId: string;
      readonly decision: "allow" | "deny";
      readonly delegation?: ManagedDelegationEnvelope;
      readonly delegationSelection?: ManagedDelegationSelection;
    }
  | {
      readonly type: "preview_permission_delegation";
      readonly requestId: string;
      readonly limits: ManagedDelegationLimits;
      readonly selection?: ManagedDelegationSelection;
    }
  | ({
      readonly type: "branch_session";
      readonly parentSessionId: string;
      readonly targetId: string | null;
    } & (
      | { readonly atSequence: number; readonly sourceBoundary?: never }
      | { readonly atSequence?: never; readonly sourceBoundary: BranchSourceBoundary }
    ));

export interface PresentationSession {
  getState(): PresentationDisplayState;
  subscribe(onChange: () => void): () => void;
  dispatch(command: PresentationCommand): Promise<CommandReceipt>;
  close(): Promise<void>;
}

export function reconcilePresentationUpdate(
  state: PresentationDisplayState,
  update: PresentationUpdate,
): PresentationDisplayState {
  if (update.type === "authoritative_snapshot") {
    return {
      ...(state.authoritative.active?.session.id === update.snapshot.active?.session.id
        ? state
        : {}),
      revision: state.revision + 1,
      authoritative: update.snapshot,
      draft: update.snapshot.active === null ? state.draft : null,
      composer: state.composer,
      transient: null,
    };
  }

  if (
    state.authoritative.continuity.status !== "current" ||
    update.afterSequence !== state.authoritative.continuity.sessionThroughSequence
  ) {
    return {
      ...state,
      revision: state.revision + 1,
      authoritative: {
        ...state.authoritative,
        continuity: { status: "repairing", reason: "gap" },
      },
      draft: state.draft,
      composer: state.composer,
      transient: null,
    };
  }

  if (update.type === "reasoning_snapshot") {
    return {
      ...state,
      revision: state.revision + 1,
      authoritative: state.authoritative,
      draft: state.draft,
      composer: state.composer,
      transient: {
        ...state.transient,
        activity: state.transient?.activity ?? "working",
        assistant: state.transient?.assistant ?? null,
        reasoning: update.reasoning,
      },
    };
  }

  return {
    ...state,
    revision: state.revision + 1,
    authoritative: state.authoritative,
    draft: state.draft,
    composer: state.composer,
    transient: {
      ...state.transient,
      activity: "replying",
      assistant: {
        streamId: update.streamId,
        afterSequence: update.afterSequence,
        text: update.text,
      },
      reasoning: state.transient?.reasoning ?? null,
    },
  };
}

export type ManagedControlIdentity = {
  readonly parentSessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly childSessionId: string;
};

export type ManagedComposerDraft = {
  readonly parentSessionId: string;
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly mode: "cooperative" | "interrupt" | "new_turn" | "reply";
  readonly attentionId?: string;
  readonly inputId?: string;
  readonly text: string;
};

export type ManagedAttentionItem = {
  readonly id: string;
  readonly parentSessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly available: boolean;
  readonly diagnostic?: string;
} & (
  | {
      readonly kind: "permission";
      readonly interaction: Extract<PendingInteraction, { readonly type: "permission" }> | null;
    }
  | { readonly kind: "parent_input"; readonly question: string }
);

export type ManagedControlAction =
  | ManagedComposerDraft["mode"]
  | "cancel"
  | "resume"
  | "recover"
  | "permission"
  | "close";

export type ManagedAdmissionDisplay = {
  readonly threadId: string;
  readonly turnId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly lane: "background" | "reserved";
  readonly status: "started" | "queued";
};

export type ManagedControlLink = {
  readonly sequence: number;
  readonly digest: `sha256:${string}`;
};

export type ManagedControlOutcome = {
  readonly atUnixMilliseconds?: number;
  readonly artifact?: {
    readonly id: `sha256:${string}`;
    readonly byteCount: number;
    readonly mediaType: "text/plain; charset=utf-8";
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly providerCalls: number;
    readonly unknownCalls: number;
  };
  readonly type: "outcome";
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly summary: string;
  readonly transcript: ManagedControlLink;
  readonly error?: { readonly code: string; readonly message: string };
};

export type ManagedControlThread = {
  readonly previousTurns?: readonly ManagedControlThread["turn"][];
  readonly actions?: readonly ManagedControlAction[];
  readonly budget?: NonNullable<ManagedWorkspaceSnapshot["budget"]>;
  readonly inputs?: readonly {
    readonly id: string;
    readonly turnId: string;
    readonly status: "accepted" | "delivered" | "undelivered";
    readonly reason?: string;
  }[];
  readonly parentSessionId: string;
  readonly lifecycle: "open" | "closed";
  readonly displayName: string;
  readonly handle: string;
  readonly alias?: string;
  readonly residency: "live" | "unloaded";
  readonly threadId: string;
  readonly role: string;
  readonly description: string;
  readonly turn: {
    readonly startedAtUnixMilliseconds?: number;
    readonly turnId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly phase: "starting" | "executing" | "settling" | "idle" | "waiting" | "queued";
    readonly lane?: "background" | "reserved";
    readonly admissionSequence?: number;
    readonly hasStarted?: true;
    readonly envelope?: ManagedDelegationEnvelope;
    readonly configuration?: {
      readonly digest: `sha256:${string}`;
      readonly parentBranchId: string;
      readonly targetId: string;
      readonly thinking: string;
      readonly contextWindowTokens?: number;
    };
    readonly waitReason: "none" | "suspended" | "capacity" | "permission" | "parent_input" | "plan";
    readonly attention?: {
      readonly id: string;
      readonly kind: "permission" | "parent_input";
      readonly question?: string;
    };
    readonly ownerPhase: "waiting" | "claimed" | "releasing" | "released";
    readonly lastOutcome: "none" | "completed" | "failed" | "cancelled" | "interrupted";
    readonly label: string;
    readonly recovery: "none" | "required";
    readonly health: "healthy" | "stalled";
    readonly watchdog?: {
      readonly deadlineId: string;
      readonly maximumInactivityMilliseconds: 300_000;
      readonly lastProgressAtUnixMilliseconds: number;
      readonly transcript: ManagedControlLink;
      readonly state: "running" | "stopped" | "stalled";
    };
    readonly diagnostic?: string;
    readonly outcome?: ManagedControlOutcome;
  };
};

export const agentExportFields = [
  "summary",
  "conversation",
  "tools",
  "result",
  "reasoning",
] as const;
export type AgentExportField = (typeof agentExportFields)[number];
export const presentationAgentExportMaximumBytes = 512 * 1024;
export type ManagedAgentExport = {
  readonly parentSessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly completion: ManagedControlLink;
  readonly fields: readonly AgentExportField[];
  readonly artifact: ArtifactReference & {
    readonly source: "agent_export";
    readonly mediaType: "application/json";
  };
};

export type ManagedWorkspaceSnapshot = {
  readonly policy?: ManagedFleetPolicy;
  readonly reviewers?: {
    readonly running: number;
    readonly queued: number;
    readonly waiting: number;
    readonly settling: number;
    readonly recoveryRequired: number;
  };
  readonly exports?: readonly ManagedAgentExport[];
  readonly storage?: {
    readonly status?: "known" | "unavailable";
    readonly ceiling: number;
    readonly usedBytes: number;
    readonly reservedTerminalBytes: number;
    readonly reservedStartupBytes: number;
    readonly availableBytes: number;
  };
  readonly budget?: {
    readonly ceiling: number | null;
    readonly knownUsed: number;
    readonly outstandingReserved: number;
    readonly unknownReserved: number;
    readonly available: number | null;
    readonly overrun: number;
  };
  readonly completions: readonly {
    readonly id: `sha256:${string}`;
    readonly threadId: string;
    readonly turnId: string;
    readonly receipt: ManagedControlLink;
    readonly outcome: ManagedControlOutcome;
    readonly consumption: "pending" | "consumed" | "suppressed";
    readonly userSeen?: true;
  }[];
  readonly status: "ready" | "recovery_required" | "runtime_unavailable";
  readonly diagnostic?: string;
  readonly parentSessionId: string;
  readonly revision: number;
  readonly threads: readonly ManagedControlThread[];
};

export type ManagedBackgroundCapacity = number | "unlimited";
export type ManagedFleetPolicy = {
  readonly reserved: { readonly running: 1; readonly queued: number };
  readonly storageBytes: number;
} & (
  | {
      readonly version: 1 | 2;
      readonly background: { readonly running: number; readonly queued: number };
      readonly maximumAttempts: number;
      readonly threadTokens: number | null;
      readonly batchTokens: number | null;
      readonly sessionTokens: number | null;
    }
  | {
      readonly version: 3;
      readonly background: {
        readonly running: ManagedBackgroundCapacity;
        readonly queued: "unlimited";
      };
      readonly maximumAttempts: "unlimited";
      readonly threadTokens: null;
      readonly batchTokens: null;
      readonly sessionTokens: null;
    }
);
export type ManagedDelegationMessage = ManagedControlLink & {
  readonly role: "user" | "assistant";
  readonly text: string;
};
export type ManagedDelegationContext =
  | { readonly mode: "task" }
  | { readonly mode: "current_request" }
  | { readonly mode: "selected_messages"; readonly messages: readonly ManagedControlLink[] };

export type ManagedDelegationSelection = {
  readonly context?: ManagedDelegationContext;
  readonly skills?: readonly string[];
};

export type ManagedDelegationLimits = { readonly budgetTokens?: number | null } & Partial<
  Pick<
    ManagedDelegationEnvelope,
    "mode" | "running" | "queued" | "aggregateTokens" | "threadTokens" | "sessionTokens"
  >
>;

export type ManagedDelegationEnvelope = {
  readonly taskBudget?:
    | { readonly version: 1; readonly mode: "unbudgeted" }
    | {
        readonly version: 1;
        readonly mode: "limited";
        readonly taskId: string;
        readonly grants: { readonly id: string; readonly tokens: number }[];
      }
    | undefined;
  readonly version: 1 | 2 | 3;
  readonly concurrency?:
    | { readonly mode: "owner" }
    | { readonly mode: "limited"; readonly running: number }
    | undefined;
  readonly id: string;
  readonly digest: `sha256:${string}`;
  readonly origin: {
    readonly kind: "main_run" | "direct_request";
    readonly id: string;
    readonly callId?: string | undefined;
  };
  readonly roles: readonly string[];
  readonly mode: "background" | "foreground";
  readonly threads: number;
  readonly running: number;
  readonly queued: number;
  readonly aggregateTokens: number | null;
  readonly threadTokens: number | null;
  readonly sessionTokens: number | null;
  readonly context: "task" | "current_request" | "selected_messages";
  readonly skills: readonly string[];
  readonly policy: ManagedFleetPolicy;
  readonly policyDigest: `sha256:${string}`;
};

export type ManagedControlCommand =
  | {
      readonly type: "suppress_completion";
      readonly confirmed: true;
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly completion: ManagedControlLink;
    }
  | {
      readonly type: "mark_completion_seen";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly completion: ManagedControlLink;
    }
  | {
      readonly type: "suspend_agents";
      readonly parentSessionId: string;
      readonly targets?: readonly { readonly threadId: string; readonly expectedTurnId: string }[];
    }
  | {
      readonly type: "resume_agents";
      readonly parentSessionId: string;
      readonly targets?: readonly { readonly threadId: string; readonly expectedTurnId: string }[];
    }
  | {
      readonly type: "close_thread";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
    }
  | {
      readonly type: "cancel_agents";
      readonly parentSessionId: string;
      readonly targets: readonly { readonly threadId: string; readonly expectedTurnId: string }[];
    }
  | {
      readonly type: "reply_agent";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly attentionId: string;
      readonly inputId: string;
      readonly text: string;
    }
  | {
      readonly type: "post_agent";
      readonly additionalBudgetTokens?: number;
      readonly origin?: ManagedDelegationEnvelope["origin"];
      readonly envelope?: ManagedDelegationEnvelope;
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly inputId: string;
      readonly mode: "cooperative" | "interrupt" | "new_turn";
      readonly text: string;
    }
  | {
      readonly type: "list_agents";
      readonly view?: "threads" | "roles" | "context";
      readonly parentSessionId: string;
      readonly limit?: number;
      readonly cursor?: string;
    }
  | {
      readonly type: "wait_agents";
      readonly parentSessionId: string;
      readonly targets: readonly { readonly threadId: string; readonly expectedTurnId: string }[];
      readonly mode: "any" | "all";
    }
  | {
      readonly type: "decide_permission";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly requestId: string;
      readonly decision: "allow" | "deny";
    }
  | {
      readonly type: "spawn_agents";
      readonly parentSessionId: string;
      readonly mode?: "background" | "foreground";
      readonly envelope?: ManagedDelegationEnvelope;
      readonly origin?: {
        readonly kind: "main_run" | "direct_request";
        readonly id: string;
        readonly callId?: string;
      };
      readonly entries: readonly {
        readonly role: string;
        readonly alias?: string;
        readonly context?: ManagedDelegationContext;
        readonly skills?: readonly string[];
        readonly artifacts?: readonly string[];
        readonly task: string;
        readonly description: string;
      }[];
    }
  | { readonly type: "prepare_main_delivery"; readonly parentSessionId: string }
  | {
      readonly type: "acknowledge_main_delivery";
      readonly parentSessionId: string;
      readonly deliveries: readonly {
        readonly id: `sha256:${string}`;
        readonly digest: `sha256:${string}`;
      }[];
    }
  | {
      readonly type: "cancel_turn";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
    }
  | {
      readonly type: "start_thread";
      readonly parentSessionId: string;
      readonly role: string;
      readonly task: string;
      readonly description: string;
    }
  | {
      readonly type: "next_turn";
      readonly additionalBudgetTokens?: number;
      readonly origin?: ManagedDelegationEnvelope["origin"];
      readonly envelope?: ManagedDelegationEnvelope;
      readonly inputId?: string;
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
      readonly task: string;
    }
  | {
      readonly type: "recover_turn";
      readonly parentSessionId: string;
      readonly threadId: string;
      readonly expectedTurnId: string;
    }
  | { readonly type: "close"; readonly parentSessionId: string; readonly reason?: "exit" };

export type ManagedControlReceipt =
  | {
      readonly status: "context_listed";
      readonly messages: readonly ManagedDelegationMessage[];
      readonly cursor?: string;
      readonly revision: string;
    }
  | {
      readonly status: "roles_listed";
      readonly roles: readonly Omit<AgentRoleTypeDisplay, "instructions">[];
      readonly cursor?: string;
      readonly revision: string;
    }
  | { readonly status: "suspended" }
  | { readonly status: "resumed"; readonly results: readonly ManagedControlReceipt[] }
  | { readonly status: "input_accepted"; readonly inputId: string; readonly turnId: string }
  | {
      readonly status: "listed";
      readonly threads: readonly ManagedControlThread[];
      readonly cursor?: string;
      readonly revision: number;
    }
  | { readonly status: "completed"; readonly results: ManagedWorkspaceSnapshot["completions"] }
  | {
      readonly status: "admitted";
      readonly turns: readonly ManagedControlIdentity[];
      readonly admissions?: readonly ManagedAdmissionDisplay[];
    }
  | {
      readonly status: "delivery";
      readonly messages: readonly { readonly id: `sha256:${string}`; readonly text: string }[];
      readonly deliveries: readonly {
        readonly id: `sha256:${string}`;
        readonly digest: `sha256:${string}`;
      }[];
    }
  | { readonly status: "acknowledged" }
  | { readonly status: "cancelled"; readonly turnId: string }
  | ({ readonly status: "accepted"; readonly inputId?: string } & ManagedControlIdentity)
  | { readonly status: "closed" }
  | { readonly status: "recovered" }
  | {
      readonly status: "rejected";
      readonly code:
        | "stale_revision"
        | "capacity_exhausted"
        | "storage_quota_exceeded"
        | "budget_exhausted"
        | "plan_policy_paused"
        | "attempt_limit"
        | "authority_busy"
        | "action_unavailable"
        | "recovery_required"
        | "persistence_failed"
        | "runtime_unavailable";
      readonly message: string;
    };

export type ManagedSessionTransition = {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly destinationSessionId: string | null;
  readonly runningCount: number;
  readonly queuedCount: number;
  readonly choices: readonly ["stay", "wait", "suspend"];
};
export type ManagedSessionTransitionResult =
  | { readonly status: "ready" | "stayed" }
  | { readonly status: "required"; readonly transition: ManagedSessionTransition }
  | { readonly status: "rejected"; readonly message: string };
