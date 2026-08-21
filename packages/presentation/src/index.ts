export type ProjectDisplay = {
  readonly id: string;
  readonly label: string;
};

export type TargetDisplay = {
  readonly targetId: string;
  readonly label: string;
  readonly route: "direct" | "vercel-ai-gateway";
  readonly certification: "Certified" | "Experimental";
  readonly readiness: {
    readonly status: "available" | "missing";
    readonly credentialSource: string;
  };
};

export type TargetCatalogDisplay = {
  readonly items: readonly TargetDisplay[];
  readonly defaultTargetId: string | null;
  readonly diagnostic: { readonly code: string; readonly message: string } | null;
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
  readonly text: string;
};

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
};

export type TranscriptItem =
  | UserMessageDisplay
  | AssistantMessageDisplay
  | CompactionMarkerDisplay
  | SessionNoticeDisplay
  | ToolCallDisplay;

export type BranchSourceBoundary = {
  readonly sessionId: string;
  readonly sequence: number;
};

export type TranscriptPage = {
  readonly items: readonly TranscriptItem[];
  readonly olderCursor: string | null;
};

export type ActiveSessionDisplay = {
  readonly session: SessionSummary;
  readonly transcript: TranscriptPage;
  readonly pendingInteractions: readonly PendingInteraction[];
  readonly repositoryInstructions: RepositoryInstructionsDisplay | null;
  readonly skills: SkillCatalogDisplay | null;
  readonly projectPaths: ProjectPathCatalogDisplay;
  readonly mcp: McpDisplay | null;
};

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
    readonly packagePath: string;
  }[];
  readonly overflow: {
    readonly omittedCount: number;
    readonly shortenedCount: number;
  };
  readonly reloadAvailable: boolean;
};

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

export type AuthoritativePresentationSnapshot = {
  readonly schemaVersion: 1;
  readonly continuity:
    | {
        readonly status: "current";
        readonly sessionThroughSequence: number;
        readonly operationThrough: readonly [];
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
};

export type PresentationDisplayState = {
  readonly revision: number;
  readonly authoritative: AuthoritativePresentationSnapshot;
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
      readonly type: "set_default_target";
      readonly targetId: string;
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
      readonly range: null;
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
      readonly type: "cancel_mcp_configuration";
      readonly sessionId: string;
      readonly generationId: string;
    }
  | {
      readonly type: "submit_prompt";
      readonly sessionId: string;
      readonly text: string;
      readonly skills: readonly string[];
    }
  | {
      readonly type: "cancel_run";
      readonly sessionId: string;
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
      transient: null,
    };
  }

  return {
    revision: state.revision + 1,
    authoritative: state.authoritative,
    transient: {
      activity: "replying",
      assistant: {
        streamId: update.streamId,
        afterSequence: update.afterSequence,
        text: update.text,
      },
    },
  };
}
