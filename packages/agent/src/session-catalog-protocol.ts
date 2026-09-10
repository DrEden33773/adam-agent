import type { PlanEligibleToolProfileV1 } from "./plan-mode.js";
import type { ProjectSessionCatalogSnapshot } from "./session-catalog-job.js";
import type { ReadOnlySessionMcpInputs, SessionPlanAuthorityInput } from "./session-lifecycle.js";
import type { SessionLifecycleError } from "./session-lifecycle-error.js";

export type SessionCatalogWorkerData = {
  readonly view?: import("./session-visibility.js").SessionVisibility;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly limit: number;
  readonly generation: string;
};

export type SessionCatalogAuthorityRequest =
  | { readonly type: "plan"; readonly input: SessionPlanAuthorityInput }
  | { readonly type: "mcp"; readonly sessionId: string };

export type SessionCatalogAuthorityResult =
  | {
      readonly ok: true;
      readonly value: PlanEligibleToolProfileV1 | ReadOnlySessionMcpInputs;
    }
  | {
      readonly ok: false;
      readonly code:
        | SessionLifecycleError["code"]
        | "session_log_invalid"
        | "session_log_too_large"
        | null;
    };

export type SessionCatalogWorkerRequest =
  | { readonly type: "start" }
  | { readonly type: "load_more"; readonly id: number; readonly cursor: string }
  | {
      readonly type: "authority_result";
      readonly id: number;
      readonly result: SessionCatalogAuthorityResult;
    };

export type SessionCatalogWorkerEvent =
  | { readonly type: "update"; readonly snapshot: ProjectSessionCatalogSnapshot }
  | {
      readonly type: "authority";
      readonly id: number;
      readonly request: SessionCatalogAuthorityRequest;
    }
  | { readonly type: "page_settled"; readonly id: number; readonly ok: boolean };
