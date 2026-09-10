import type {
  SessionCatalogAuthorityRequest,
  SessionCatalogAuthorityResult,
} from "./session-catalog-protocol.js";
import type { SessionTrashCandidate } from "./session-lifecycle.js";
import type { SessionLifecycleError } from "./session-lifecycle-error.js";
import type { SessionTrashManifest } from "./session-trash.js";

export type SessionHistoryInspectionRequest =
  | { readonly type: "idle"; readonly sessionId: string }
  | { readonly type: "trash"; readonly sessionId: string }
  | { readonly type: "restore"; readonly manifest: SessionTrashManifest };

export type SessionHistoryInspectionResult =
  | { readonly type: "idle" | "restore" }
  | { readonly type: "trash"; readonly candidate: SessionTrashCandidate };

export type SessionHistoryInspectionWorkerData = {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly request: SessionHistoryInspectionRequest;
};

export type SessionHistoryInspectionWorkerRequest =
  | { readonly type: "start" }
  | {
      readonly type: "authority_result";
      readonly id: number;
      readonly result: SessionCatalogAuthorityResult;
    };

export type SessionHistoryInspectionWorkerEvent =
  | { readonly type: "result"; readonly result: SessionHistoryInspectionResult }
  | {
      readonly type: "authority";
      readonly id: number;
      readonly request: SessionCatalogAuthorityRequest;
    }
  | {
      readonly type: "error";
      readonly error:
        | {
            readonly type: "trash";
            readonly code: "conflict" | "unavailable";
            readonly message: string;
          }
        | { readonly type: "lifecycle"; readonly code: SessionLifecycleError["code"] }
        | { readonly type: "unavailable" };
    };
