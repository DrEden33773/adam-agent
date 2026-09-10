import type { PlanEligibleToolProfileV1 } from "./plan-mode.js";
import type {
  SessionCatalogAuthorityRequest,
  SessionCatalogAuthorityResult,
} from "./session-catalog-protocol.js";
import type { ReadOnlySessionMcpInputs, SessionPlanAuthorityInput } from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { SessionStoreError } from "./session-store.js";

/** Workers request inspection authority, never tools or an execution lifecycle. */
export type SessionInspectionAuthority = {
  readonly resolvePlanProfile: (
    input: SessionPlanAuthorityInput,
  ) => Promise<PlanEligibleToolProfileV1>;
  readonly inspectMcpInputs: (sessionId: string) => Promise<ReadOnlySessionMcpInputs>;
};

export async function resolveSessionInspectionAuthority(
  authority: SessionInspectionAuthority,
  request: SessionCatalogAuthorityRequest,
): Promise<SessionCatalogAuthorityResult> {
  try {
    const value =
      request.type === "plan"
        ? await authority.resolvePlanProfile(request.input)
        : await authority.inspectMcpInputs(request.sessionId);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof SessionLifecycleError
          ? error.code
          : error instanceof SessionStoreError &&
              (error.code === "session_log_invalid" || error.code === "session_log_too_large")
            ? error.code
            : null,
    };
  }
}

export function createWorkerSessionInspectionAuthority(
  post: (message: {
    readonly type: "authority";
    readonly id: number;
    readonly request: SessionCatalogAuthorityRequest;
  }) => void,
): SessionInspectionAuthority & {
  receive(id: number, result: SessionCatalogAuthorityResult): void;
} {
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<SessionCatalogAuthorityResult>>
  >();
  let nextId = 0;
  const request = async (query: SessionCatalogAuthorityRequest) => {
    const id = ++nextId;
    const reply = Promise.withResolvers<SessionCatalogAuthorityResult>();
    pending.set(id, reply);
    post({ type: "authority", id, request: query });
    const result = await reply.promise;
    if (result.ok) return result.value;
    if (result.code === "session_log_invalid" || result.code === "session_log_too_large")
      throw new SessionStoreError(result.code);
    if (result.code !== null) throw new SessionLifecycleError(result.code);
    throw new Error("The current session inspection authority is unavailable.");
  };
  return {
    resolvePlanProfile: async (input) =>
      (await request({ type: "plan", input })) as PlanEligibleToolProfileV1,
    inspectMcpInputs: async (sessionId) =>
      (await request({ type: "mcp", sessionId })) as ReadOnlySessionMcpInputs,
    receive(id, result) {
      const reply = pending.get(id);
      pending.delete(id);
      reply?.resolve(result);
    },
  };
}
