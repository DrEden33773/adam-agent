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
  readonly configuration?: { readonly modelPolicy: UserModelPolicyDisplay };
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
  readonly source: "model_response" | "tool_output" | "change_preview" | "operation";
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
  readonly type: "tool_call";
  readonly id: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly branchBoundary: null;
  readonly callId: string;
  readonly qualifiedName: string;
  readonly kind: "read" | "shell" | "mutation" | "mcp" | "unknown";
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

export type TranscriptItem =
  | UserMessageDisplay
  | AssistantMessageDisplay
  | ReasoningBlockDisplay
  | CompactionMarkerDisplay
  | SessionNoticeDisplay
  | ToolCallDisplay
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

export type ActiveSessionDisplay = {
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
  readonly plan?: {
    readonly state: "exploring";
    readonly cycleId: string;
    readonly revision: number;
    readonly policyVersion: "plan-policy.read-v1";
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
  };
};

export type OperationCursor = {
  readonly operationId: string;
  readonly sequence: number;
};

type OperationDisplayBase = {
  readonly artifacts: readonly OperationArtifactDisplay[];
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
  readonly diagnostic: { readonly code: "project_path_catalog_truncated" } | null;
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
  readonly type: "permission";
  readonly requestId: string;
  readonly callId: string;
  readonly effect: "read" | "write" | "execute" | "network" | "delegate" | "administrative";
  readonly subject: { readonly type: "path" | "command" | "generic"; readonly value: string };
  readonly canAllow: boolean;
  readonly changePreviewRef: ArtifactReference | null;
};

export type PresentationFault = {
  readonly code: "authoritative_state_unavailable";
  readonly message: string;
};

export type NewSessionDraftDisplay = {
  readonly targetId: string;
  readonly skills: SkillCatalogDisplay;
  readonly projectPaths: ProjectPathCatalogDisplay;
};

export type TurnComposerDisplay = {
  readonly attachmentAvailable: boolean;
  readonly unavailableReason: string | null;
  readonly sealed: boolean;
  readonly resources: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly state: "queued" | "copying" | "ready" | "failed" | "cancelled" | "removed";
    readonly byteCount: number | null;
    readonly support: "image" | "unsupported_binary" | "utf8_text" | null;
    readonly diagnostic: string | null;
  }[];
};

export type AuthoritativePresentationSnapshot = {
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
};

export type PresentationTransientState = {
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

export type PresentationDisplayState = {
  readonly revision: number;
  readonly authoritative: AuthoritativePresentationSnapshot;
  readonly draft: NewSessionDraftDisplay | null;
  readonly composer: TurnComposerDisplay;
  readonly transient: PresentationTransientState | null;
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
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "not_available"
        | "stale_interaction"
        | "conflict"
        | "invalid_command"
        | "authority_rejected"
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

export type PresentationCommand =
  | {
      readonly type: "select_session";
      readonly sessionId: string;
    }
  | {
      readonly type: "create_session";
      readonly targetId: string;
    }
  | {
      readonly type: "enter_plan";
      readonly sessionId: string;
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
    }
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
      revision: state.revision + 1,
      authoritative: state.authoritative,
      draft: state.draft,
      composer: state.composer,
      transient: {
        activity: state.transient?.activity ?? "working",
        assistant: state.transient?.assistant ?? null,
        reasoning: update.reasoning,
      },
    };
  }

  return {
    revision: state.revision + 1,
    authoritative: state.authoritative,
    draft: state.draft,
    composer: state.composer,
    transient: {
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
