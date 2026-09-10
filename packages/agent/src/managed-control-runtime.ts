import { join, resolve } from "node:path";
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

const nativeCompositions = new WeakMap<
  ManagedControlComposition,
  {
    readonly workspaceRoot: string;
    readonly stateRoot: string;
    readonly store: ManagedControlComposition["store"];
    readonly childSessionStores: ManagedControlComposition["childSessionStores"];
  }
>();

/** Only the ordinary unchanged native composition can be reopened by a read-only worker. */
export function isNativeManagedControlComposition(
  composition: ManagedControlComposition,
  options: { readonly workspaceRoot: string; readonly stateRoot: string },
): boolean {
  const native = nativeCompositions.get(composition);
  return (
    native !== undefined &&
    native.store === composition.store &&
    native.childSessionStores === composition.childSessionStores &&
    native.workspaceRoot === resolve(options.workspaceRoot) &&
    native.stateRoot === resolve(options.stateRoot)
  );
}

/** Shared durable composition for the ordinary CLI and project runtime. */
export async function createProductionManagedControlComposition(options: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
}): Promise<ProductionManagedControlComposition> {
  const composition: ManagedControlComposition = {
    store: await createJsonlManagedAgentControlStore(options),
    childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
      workspaceRoot: options.workspaceRoot,
      stateRoot: join(options.stateRoot, "managed-agent-sessions"),
    }),
  };
  nativeCompositions.set(composition, {
    workspaceRoot: resolve(options.workspaceRoot),
    stateRoot: resolve(options.stateRoot),
    store: composition.store,
    childSessionStores: composition.childSessionStores,
  });
  return composition;
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
