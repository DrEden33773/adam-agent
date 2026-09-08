import { join } from "node:path";
import { createJsonlManagedAgentControlStore } from "./managed-agent-store.js";
import type { ManagedReviewRuntime } from "./managed-review-runner.js";
import { ModelTargetError } from "./model-targets.js";
import {
  type ManagedControlComposition,
  type SessionLifecycle,
  sessionManagedControl,
} from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { createJsonlSessionStoreDirectory, type SessionRecord } from "./session-store.js";

export type ProductionManagedControlComposition = ManagedControlComposition;

/** Shared durable composition for the ordinary CLI and project runtime. */
export async function createProductionManagedControlComposition(options: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
}): Promise<ProductionManagedControlComposition> {
  return {
    store: await createJsonlManagedAgentControlStore(options),
    childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
      workspaceRoot: options.workspaceRoot,
      stateRoot: join(options.stateRoot, "managed-agent-sessions"),
    }),
  };
}

/** Resolve review execution through the same lifecycle-owned Control as built-in agents. */
export function createSessionManagedReviewRuntime(
  getLifecycle: () => SessionLifecycle | undefined,
): ManagedReviewRuntime {
  return {
    async resolveOrigin({ origin, signal }) {
      const lifecycle = getLifecycle();
      if (lifecycle === undefined) throw new Error("The session lifecycle is unavailable.");
      try {
        const resolved = await lifecycle.resolveManagedSessionOrigin({ origin, signal });
        const control = await lifecycle[sessionManagedControl](origin.sessionId);
        if (control === undefined) return { status: "policy_denied" };
        return {
          status: "ready",
          control,
          model: resolved.childModel,
          targetIdentity: resolved.targetIdentity,
          contextProfile: resolved.childContextProfile,
          ...(resolved.thinkingPolicy === undefined
            ? {}
            : { thinkingPolicy: resolved.thinkingPolicy }),
        };
      } catch (error) {
        if (
          error instanceof ModelTargetError ||
          (error instanceof SessionLifecycleError &&
            error.code === "session_model_target_incompatible")
        )
          return { status: "target_unavailable" };
        throw error;
      }
    },
  };
}
