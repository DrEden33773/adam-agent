import { join } from "node:path";

import {
  type ArtifactStore,
  createCodingToolRegistry,
  createFileArtifactStore,
  createPresentationPreferences,
  createProductionManagedControlComposition,
  createSessionLifecycle,
  createWebSearchConfiguration,
  createWorkspaceTrust,
  type ModelTargets,
  type PermissionPolicy,
} from "@adam-agent/agent";

/** Both CLI presentations use the same production composition. */
export async function createCliLifecycle(options: {
  workspaceRoot: string;
  stateRoot: string;
  configurationEnvironment: NodeJS.ProcessEnv;
  modelTargets: ModelTargets;
  permissions: PermissionPolicy;
  managed: boolean;
}) {
  let artifacts: Promise<ArtifactStore> | undefined;
  const resolveArtifacts = () => {
    artifacts ??= createFileArtifactStore({ root: join(options.stateRoot, "artifacts") });
    return artifacts;
  };
  const artifactStore: ArtifactStore = {
    async write(input) {
      return (await resolveArtifacts()).write(input);
    },
    async read(id) {
      return (await resolveArtifacts()).read(id);
    },
  };
  return createSessionLifecycle({
    ...(options.managed
      ? {
          managedControl: await createProductionManagedControlComposition({
            workspaceRoot: options.workspaceRoot,
            stateRoot: options.stateRoot,
          }),
        }
      : {}),
    modelTargets: options.modelTargets,
    preferences: createPresentationPreferences({ environment: options.configurationEnvironment }),
    workspaceTrust: createWorkspaceTrust({
      environment: options.configurationEnvironment,
      workspaceRoot: options.workspaceRoot,
    }),
    stateRoot: options.stateRoot,
    webSearchConfiguration: createWebSearchConfiguration({
      environment: options.configurationEnvironment,
    }),
    workspaceRoot: options.workspaceRoot,
    tools: createCodingToolRegistry({
      workspaceRoot: options.workspaceRoot,
      stateRoot: options.stateRoot,
      artifactStore,
    }),
    permissions: options.permissions,
  });
}
