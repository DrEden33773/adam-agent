import { join } from "node:path";

import {
  createBiomeExecutionAdapter,
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  createPresentationSession,
  createSessionLifecycle,
  ExtensionConfigurationError,
  type ExtensionContributionSummary,
  loadExtensionConfiguration,
  type ModelTargets,
  type PermissionPolicy,
  type PresentationPreferences,
  type SessionSnapshot,
  type WorkspaceTrustController,
} from "@adam-agent/agent";
import type { PresentationSession } from "@adam-agent/presentation";
import { requireConfirmedLifecycleClose } from "./lifecycle-close.js";

export type ProductionProjectRuntimeOptions = {
  readonly environment: NodeJS.ProcessEnv;
  readonly extensionPermissions: PermissionPolicy;
  readonly modelTargets: ModelTargets;
  readonly permissions: PermissionPolicy;
  readonly preferences: PresentationPreferences;
  readonly projectLabel: string;
  readonly reservedCommandNames: readonly string[];
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceTrust: WorkspaceTrustController;
};

export type ProductionProjectRuntime = {
  readonly contributions: readonly ExtensionContributionSummary[];
  readonly extensionAvailability: {
    readonly configurationUnavailable: boolean;
    readonly rejectedCount: number;
  };
  close(): Promise<void>;
  createPresentation(
    input: { readonly openProject: true } | { readonly sessionId: string },
  ): Promise<PresentationSession>;
  inspectSession(sessionId: string): Promise<SessionSnapshot>;
};

export async function createProductionProjectRuntime(
  options: ProductionProjectRuntimeOptions,
): Promise<ProductionProjectRuntime> {
  let configurationUnavailable = false;
  const extensions = await loadExtensionConfiguration(options.environment, {
    allowMissing: true,
  }).catch((error: unknown) => {
    if (
      error instanceof ExtensionConfigurationError &&
      error.code === "extension_configuration_unavailable"
    ) {
      configurationUnavailable = true;
      return [];
    }
    throw error;
  });
  const artifactStore = await createFileArtifactStore({
    root: join(options.stateRoot, "artifacts"),
  });
  const operationStore = await createJsonlOperationStore({
    stateRoot: options.stateRoot,
    workspaceRoot: options.workspaceRoot,
  });
  let lifecycle: ReturnType<typeof createSessionLifecycle> | undefined;
  const host = createExtensionHost({
    artifactStore,
    biomeExecution: createBiomeExecutionAdapter(),
    capabilities: [
      { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
    ],
    extensions,
    operationOriginAuthority: {
      async validateBoundary({ origin, projectId }) {
        if (lifecycle === undefined) {
          return false;
        }
        const snapshot = await lifecycle.inspect({ sessionId: origin.sessionId });
        return (
          snapshot.schemaVersion === 3 &&
          snapshot.projectId === projectId &&
          origin.sourceSequence <= snapshot.lastSequence
        );
      },
    },
    operationStore,
    permissions: options.extensionPermissions,
    projectRoot: options.workspaceRoot,
    reservedCommandNames: options.reservedCommandNames,
    stateRoot: options.stateRoot,
  });
  const extensionSnapshot = await host.loadConfiguredExtensions();
  lifecycle = createSessionLifecycle({
    extensionHost: host,
    managedAgentTools: "managed-agent-tools.a1.v1",
    modelTargets: options.modelTargets,
    permissions: options.permissions,
    preferences: options.preferences,
    stateRoot: options.stateRoot,
    workspaceRoot: options.workspaceRoot,
    workspaceTrust: options.workspaceTrust,
  });
  let presentationPromise: Promise<PresentationSession> | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    contributions: host.listContributions(),
    extensionAvailability: {
      configurationUnavailable,
      rejectedCount: extensionSnapshot.extensions.filter(
        (extension) => extension.status === "rejected",
      ).length,
    },
    close() {
      closePromise ??= closeProjectRuntime(presentationPromise, lifecycle);
      return closePromise;
    },
    createPresentation(input) {
      if (closePromise !== undefined) {
        return Promise.reject(new Error("The production project runtime is closing or closed."));
      }
      if (presentationPromise !== undefined) {
        return Promise.reject(
          new Error("The production project runtime already owns its Presentation."),
        );
      }
      presentationPromise = createPresentationSession({
        lifecycle,
        modelTargets: options.modelTargets,
        operations: host.operations,
        preferences: options.preferences,
        projectChanges: host,
        projectLabel: options.projectLabel,
        stateRoot: options.stateRoot,
        workspaceRoot: options.workspaceRoot,
        ...input,
      });
      return presentationPromise;
    },
    inspectSession(sessionId) {
      return lifecycle.inspect({ sessionId });
    },
  };
}

async function closeProjectRuntime(
  presentationPromise: Promise<PresentationSession> | undefined,
  lifecycle: ReturnType<typeof createSessionLifecycle>,
): Promise<void> {
  let presentationFailure: unknown;
  let presentation: PresentationSession | undefined;
  try {
    presentation = await presentationPromise;
  } catch (error) {
    presentationFailure = error;
  }
  if (presentation !== undefined) {
    try {
      await presentation.close();
    } catch (error) {
      presentationFailure = error;
    }
  }
  requireConfirmedLifecycleClose(await lifecycle.close());
  if (presentationFailure !== undefined) {
    throw presentationFailure;
  }
}
