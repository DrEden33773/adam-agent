import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  type ArtifactStore,
  createBiomeExecutionAdapter,
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  createPresentationSession,
  createProductionManagedControlComposition,
  createSessionLifecycle,
  createSessionManagedReviewRuntime,
  createWebSearchConfiguration,
  ExtensionConfigurationError,
  type ExtensionContributionSummary,
  type ExtensionHostOptions,
  loadExtensionConfiguration,
  type ModelTargets,
  type OperationStore,
  type PermissionPolicy,
  type PresentationPreferences,
  type SessionSnapshot,
  type WorkspaceTrustController,
} from "@adam-agent/agent";
import type { PresentationSession } from "@adam-agent/presentation";
import { requireConfirmedLifecycleClose } from "./lifecycle-close.js";

/** External storage and barrier overrides for conformance; execution always uses Control. */
export const projectRuntimeManagedControl = Symbol("project-runtime-managed-control-testing");

/** External-clock seam for exact consumer deadline conformance; never selected by the CLI. */
export const projectRuntimeReviewTiming = Symbol("project-runtime-review-timing-testing");

export type ProductionProjectRuntimeOptions = {
  readonly onPhaseDiagnostic?: Parameters<typeof createSessionLifecycle>[0]["onPhaseDiagnostic"];
  readonly [projectRuntimeReviewTiming]?: Pick<
    ExtensionHostOptions,
    "operationNow" | "operationDeadlineScheduler"
  > & {
    readonly review: Pick<
      NonNullable<ExtensionHostOptions["managedReview"]>,
      "policy" | "deadlineScheduler"
    >;
  };
  readonly [projectRuntimeManagedControl]?: NonNullable<
    Parameters<typeof createSessionLifecycle>[0]["managedControl"]
  >;
  readonly environment: NodeJS.ProcessEnv;
  readonly extensionPermissions: PermissionPolicy;
  readonly modelTargets: ModelTargets;
  readonly permissions: PermissionPolicy;
  readonly preferences: PresentationPreferences;
  readonly projectLabel: string;
  readonly reservedCommandNames: readonly string[];
  readonly resumeSessionId?: string;
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
  let artifactStorePromise: Promise<ArtifactStore> | undefined;
  const resolveArtifactStore = () => {
    artifactStorePromise ??= createFileArtifactStore({
      root: join(options.stateRoot, "artifacts"),
    });
    return artifactStorePromise;
  };
  const artifactStore: ArtifactStore = {
    async write(input) {
      return (await resolveArtifactStore()).write(input);
    },
    async read(id, readOptions) {
      return (await resolveArtifactStore()).read(id, readOptions);
    },
  };
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const operationProjectId = `sha256:${createHash("sha256")
    .update(canonicalWorkspaceRoot)
    .digest("hex")}`;
  let operationStorePromise: Promise<OperationStore> | undefined;
  const resolveOperationStore = () => {
    operationStorePromise ??= createJsonlOperationStore({
      stateRoot: options.stateRoot,
      workspaceRoot: options.workspaceRoot,
    });
    return operationStorePromise;
  };
  const operationStore: OperationStore = {
    projectId: operationProjectId,
    async append(record) {
      return (await resolveOperationStore()).append(record);
    },
    async findByIdempotency(scope) {
      return (await resolveOperationStore()).findByIdempotency(scope);
    },
    async listLinkedStarts(listOptions) {
      return (await resolveOperationStore()).listLinkedStarts(listOptions);
    },
    async read(operationId) {
      return (await resolveOperationStore()).read(operationId);
    },
  };
  const managedControl =
    options[projectRuntimeManagedControl] ??
    (await createProductionManagedControlComposition({
      workspaceRoot: options.workspaceRoot,
      stateRoot: options.stateRoot,
    }));
  let lifecycle: ReturnType<typeof createSessionLifecycle> | undefined;
  const host = createExtensionHost({
    ...(options[projectRuntimeReviewTiming]?.operationNow === undefined
      ? {}
      : { operationNow: options[projectRuntimeReviewTiming].operationNow }),
    ...(options[projectRuntimeReviewTiming]?.operationDeadlineScheduler === undefined
      ? {}
      : {
          operationDeadlineScheduler:
            options[projectRuntimeReviewTiming].operationDeadlineScheduler,
        }),
    artifactStore,
    biomeExecution: createBiomeExecutionAdapter(),
    capabilities: [
      { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
      { id: "adam.artifact.publish@1", version: "1.0.0" },
      { id: "adam.storage.records@1", version: "1.0.0" },
      { id: "adam.managed-review@1", version: "1.0.0" },
    ],
    extensions,
    managedReview: {
      ...createSessionManagedReviewRuntime(() => lifecycle),
      ...options[projectRuntimeReviewTiming]?.review,
    },
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
  lifecycle = createSessionLifecycle({
    ...(options.onPhaseDiagnostic === undefined
      ? {}
      : { onPhaseDiagnostic: options.onPhaseDiagnostic }),
    extensionHost: host,
    managedControl,
    modelTargets: options.modelTargets,
    permissions: options.permissions,
    preferences: options.preferences,
    stateRoot: options.stateRoot,
    webSearchConfiguration: createWebSearchConfiguration({ environment: options.environment }),
    workspaceRoot: options.workspaceRoot,
    workspaceTrust: options.workspaceTrust,
  });
  let extensionSnapshot: Awaited<ReturnType<typeof host.loadConfiguredExtensions>>;
  try {
    if (options.resumeSessionId !== undefined) {
      await lifecycle.inspect({ sessionId: options.resumeSessionId });
    }
    await resolveArtifactStore();
    await resolveOperationStore();
    extensionSnapshot = await host.loadConfiguredExtensions();
  } catch (error) {
    await closeProjectRuntime(undefined, lifecycle);
    throw error;
  }
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
        backgroundStartup: true,
        lifecycle,
        modelTargets: options.modelTargets,
        operations: host.operations,
        preferences: options.preferences,
        projectChanges: host,
        projectLabel: options.projectLabel,
        stateRoot: options.stateRoot,
        webSearchEnvironment: options.environment,
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
