export type ProjectDisplay = {
  readonly id: string;
  readonly label: string;
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
  readonly sessions: SessionSummaryPage;
  readonly active: ActiveSessionDisplay | null;
};

export type PresentationTransientState = {
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
  | { readonly status: "admitted"; readonly commandId: string; readonly resource: null }
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
      readonly type: "load_older_transcript";
      readonly before: string;
    }
  | {
      readonly type: "load_more_sessions";
      readonly after: string;
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
      assistant: {
        streamId: update.streamId,
        afterSequence: update.afterSequence,
        text: update.text,
      },
    },
  };
}
