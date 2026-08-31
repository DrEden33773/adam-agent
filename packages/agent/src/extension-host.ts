import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXTENSION_API_VERSION,
  EXTENSION_ARTIFACT_CAPABILITY_ID,
  EXTENSION_BIOME_CAPABILITY_ID,
  EXTENSION_ID_MAX_LENGTH,
  EXTENSION_OPERATION_DEADLINE_MAX_MS,
  EXTENSION_PACKAGE_NAME_MAX_LENGTH,
  EXTENSION_PACKAGE_VERSION_MAX_LENGTH,
  EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT,
  type ExtensionActivationCapability,
  type ExtensionActivationContext,
  type ExtensionActivationDiagnostic,
  type ExtensionContractReference,
  type ExtensionDeactivationContext,
  type ExtensionJsonValue,
  type ExtensionOperationContribution,
  type ExtensionOperationRegistration,
  type ExtensionPackageManifest,
  parseExtensionPackageManifest,
} from "@adam-agent/extension-api";
import { minVersion, satisfies, subset, valid, validRange } from "semver";
import type { ArtifactStore } from "./artifact-store.js";
import type { BiomeExecutionAdapter } from "./biome-execution.js";
import {
  createExtensionLifecycleStore,
  type ExtensionLifecycleTruth,
} from "./extension-lifecycle-store.js";
import { createExtensionRecordStore } from "./extension-record-store.js";
import {
  createGitProjectChangeCaptureAdapter,
  GitProjectChangeCaptureError,
} from "./git-project-change-capture.js";
import {
  createOperationHost,
  type OperationHost,
  type OperationHostControl,
  type OperationOriginAuthority,
  type OperationReference,
  type RegisteredOperation,
} from "./operation-host.js";
import type { OperationOrigin, OperationStore } from "./operation-store.js";
import {
  createProjectChangeMaterializer,
  type ProjectChangeMaterializer,
  ProjectChangeMaterializerError,
} from "./project-change-materializer.js";
import {
  createProjectLifecycleOwner,
  type ProjectLifecycleOwner,
  ProjectLifecycleOwnerError,
} from "./project-lifecycle-owner.js";
import type { PermissionPolicy } from "./tool-runtime.js";

export type ExtensionCapabilityAvailability = {
  readonly id: string;
  readonly version: string;
};

export type ExtensionCapabilityGrant = {
  readonly id: string;
  readonly version: string;
};

export type ConfiguredExtension = {
  readonly configuration?: ExtensionJsonValue;
  readonly enabled: boolean;
  readonly extensionId: string;
  readonly grants: readonly ExtensionCapabilityGrant[];
  readonly packageName: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
};

export type ExtensionHostOptions = {
  readonly artifactStore?: ArtifactStore;
  readonly biomeExecution?: BiomeExecutionAdapter;
  readonly capabilities: readonly ExtensionCapabilityAvailability[];
  readonly extensions: readonly ConfiguredExtension[];
  readonly operationDeadlineMs?: number;
  readonly operationDisableGraceMs?: number;
  readonly operationOriginAuthority?: OperationOriginAuthority;
  readonly operationStore?: OperationStore;
  readonly permissions?: PermissionPolicy;
  readonly projectChangeMaterializer?: ProjectChangeMaterializer;
  readonly projectLifecycleOwner?: ProjectLifecycleOwner;
  readonly projectRoot?: string;
  readonly reservedCommandNames?: readonly string[];
  readonly stateRoot?: string;
};

export type ExtensionContributionSummary = ExtensionOperationContribution & {
  readonly extensionId: string;
};

export type ExtensionDiagnostic =
  | { readonly code: "activation_failed" }
  | { readonly code: "activation_timed_out" }
  | { readonly code: "configuration_invalid" }
  | { readonly code: "deactivation_failed" }
  | { readonly code: "extension_state_unavailable" }
  | {
      readonly code: "extension_api_incompatible";
      readonly hostVersion: string;
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "capability_grant_invalid";
    }
  | {
      readonly actual: string;
      readonly code: "package_identity_mismatch";
      readonly expected: string;
      readonly field: "extensionId" | "name" | "version";
    }
  | { readonly code: "manifest_invalid" }
  | { readonly code: "package_unavailable" }
  | { readonly code: "runtime_entry_invalid" }
  | {
      readonly availableVersion: string;
      readonly capabilityId: string;
      readonly code: "required_capability_incompatible";
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "required_capability_unavailable";
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "required_capability_ungranted";
      readonly requestedVersion: string;
    }
  | {
      readonly actual: ExtensionContractReference;
      readonly code: "contribution_contract_mismatch";
      readonly contract: "input" | "output" | "progress";
      readonly contributionId: string;
      readonly expected: ExtensionContractReference;
    }
  | {
      readonly code: "command_collision";
      readonly commandId: string;
      readonly commandName: string;
    }
  | {
      readonly code: "contribution_codec_invalid";
      readonly contract: "input" | "output" | "progress";
      readonly contributionId: string;
    }
  | {
      readonly code: "contribution_handler_invalid";
      readonly contributionId: string;
    }
  | {
      readonly code: "contribution_input_source_mismatch";
      readonly contributionId: string;
    }
  | { readonly code: "contribution_registration_invalid" }
  | {
      readonly code: "contribution_collision";
      readonly contributionId: string;
    }
  | {
      readonly code: "declared_contribution_missing";
      readonly contributionId: string;
    }
  | {
      readonly code: "undeclared_contribution";
      readonly contributionId: string;
    }
  | {
      readonly availableVersion: string;
      readonly capabilityId: string;
      readonly code: "optional_capability_incompatible";
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "optional_capability_unavailable";
      readonly requestedVersion: string;
    }
  | {
      readonly capabilityId: string;
      readonly code: "optional_capability_ungranted";
      readonly requestedVersion: string;
    };

export type ExtensionStateSnapshot =
  | {
      readonly diagnostics: readonly ExtensionDiagnostic[];
      readonly extensionId: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly status: "disabled";
    }
  | {
      readonly diagnostics: readonly ExtensionDiagnostic[];
      readonly extensionId: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly status: "rejected";
    }
  | {
      readonly diagnostics: readonly ExtensionDiagnostic[];
      readonly extensionId: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly status: "active";
    }
  | {
      readonly diagnostics: readonly ExtensionDiagnostic[];
      readonly extensionId: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly status: "disabled_with_pending_operations";
    };

export type ExtensionHostSnapshot = {
  readonly extensions: readonly ExtensionStateSnapshot[];
};

export interface ExtensionHost {
  readonly operations: OperationHost;
  disableExtension(extensionId: string): Promise<ExtensionStateSnapshot>;
  enableExtension(extensionId: string): Promise<ExtensionStateSnapshot>;
  listContributions(): readonly ExtensionContributionSummary[];
  loadConfiguredExtensions(): Promise<ExtensionHostSnapshot>;
  startProjectChanges(options: ExtensionProjectChangesStartOptions): Promise<OperationReference>;
}

export type ExtensionProjectChangesStartOptions = {
  readonly command: {
    readonly id: string;
    readonly version: number;
  };
  readonly deadlineMs?: number;
  readonly idempotencyKey: string;
  readonly origin: OperationOrigin;
};

export class ExtensionProjectChangesError extends Error {
  readonly code:
    | "capture_inconsistent"
    | "cleanup_failed"
    | "content_invalid_utf8"
    | "git_command_failed"
    | "limit_exceeded"
    | "mode_invalid"
    | "no_changes"
    | "path_invalid"
    | "repository_state_unsupported"
    | "repository_unavailable";

  constructor(code: ExtensionProjectChangesError["code"], options: { readonly cause: unknown }) {
    super("The project changes could not be captured for this operation.", options);
    this.name = "ExtensionProjectChangesError";
    this.code = code;
  }
}

export type InternalExtensionSkillSource = {
  readonly extensionId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly lifecycleRevision: number;
  readonly lifecycleDigest: `sha256:${string}`;
};

type InternalExtensionSkillAuthority = {
  readonly lifecycleCommandQueues: Map<string, Promise<void>>;
  readonly sources: ReadonlyMap<string, InternalExtensionSkillSource>;
};

const extensionSkillAuthorities = new WeakMap<ExtensionHost, InternalExtensionSkillAuthority>();

export async function loadInternalExtensionSkillSources(
  host: ExtensionHost,
): Promise<readonly InternalExtensionSkillSource[]> {
  await host.loadConfiguredExtensions();
  const authority = extensionSkillAuthorities.get(host);
  if (authority === undefined) {
    throw new TypeError("The Extension Host does not expose Adam's internal Skill authority.");
  }
  return [...authority.sources.values()].sort((left, right) =>
    Buffer.from(left.extensionId).compare(Buffer.from(right.extensionId)),
  );
}

export function isInternalExtensionSkillSourceCurrent(
  host: ExtensionHost,
  source: Pick<
    InternalExtensionSkillSource,
    "extensionId" | "packageName" | "packageVersion" | "lifecycleRevision" | "lifecycleDigest"
  >,
): boolean {
  const current = extensionSkillAuthorities.get(host)?.sources.get(source.extensionId);
  return (
    current !== undefined &&
    current.packageName === source.packageName &&
    current.packageVersion === source.packageVersion &&
    current.lifecycleRevision === source.lifecycleRevision &&
    current.lifecycleDigest === source.lifecycleDigest
  );
}

export async function withInternalExtensionSkillSourcesCurrent<T>(
  host: ExtensionHost,
  sources: readonly Pick<
    InternalExtensionSkillSource,
    "extensionId" | "packageName" | "packageVersion" | "lifecycleRevision" | "lifecycleDigest"
  >[],
  operation: () => Promise<T>,
): Promise<{ readonly status: "current"; readonly value: T } | { readonly status: "stale" }> {
  const authority = extensionSkillAuthorities.get(host);
  if (authority === undefined) {
    throw new TypeError("The Extension Host does not expose Adam's internal Skill authority.");
  }
  const extensionIds = [...new Set(sources.map((source) => source.extensionId))].sort(
    (left, right) => Buffer.from(left).compare(Buffer.from(right)),
  );
  const acquire = async (
    index: number,
  ): Promise<{ readonly status: "current"; readonly value: T } | { readonly status: "stale" }> => {
    const extensionId = extensionIds[index];
    if (extensionId !== undefined) {
      return enqueueLifecycleCommand(authority.lifecycleCommandQueues, extensionId, () =>
        acquire(index + 1),
      );
    }
    if (!sources.every((source) => isInternalExtensionSkillSourceCurrent(host, source))) {
      return { status: "stale" };
    }
    return { status: "current", value: await operation() };
  };
  return acquire(0);
}

export class ExtensionHostError extends Error {
  readonly code:
    | "extension_configuration_invalid"
    | "extension_state_persistence_failed"
    | "project_changes_unavailable"
    | "project_in_use"
    | "project_owner_unavailable";

  constructor(code: ExtensionHostError["code"], options?: { readonly cause: unknown }) {
    super(
      code === "extension_configuration_invalid"
        ? "The extension Host configuration is invalid."
        : code === "extension_state_persistence_failed"
          ? "The extension lifecycle state could not be persisted."
          : code === "project_changes_unavailable"
            ? "No active extension command can admit project changes."
            : code === "project_in_use"
              ? "Another process owns lifecycle mutations for this canonical project."
              : "The OS-backed project lifecycle owner is unavailable.",
      options,
    );
    this.name = "ExtensionHostError";
    this.code = code;
  }
}

export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  const extensionIds = options.extensions.map((extension) => extension.extensionId);
  const capabilityIds = options.capabilities.map((capability) => capability.id);
  const reservedCommandNameValues = options.reservedCommandNames ?? [];
  const reservedCommandNames = new Set(reservedCommandNameValues);
  if (
    new Set(extensionIds).size !== extensionIds.length ||
    new Set(capabilityIds).size !== capabilityIds.length ||
    reservedCommandNames.size !== reservedCommandNameValues.length ||
    reservedCommandNameValues.some(
      (name) => !/^[a-z]+(?:-[a-z]+)*$/u.test(name) || name.length > 64,
    ) ||
    options.extensions.some(
      (extension) =>
        extension.extensionId.length === 0 ||
        extension.extensionId.length > EXTENSION_ID_MAX_LENGTH ||
        extension.packageName.length === 0 ||
        extension.packageName.length > EXTENSION_PACKAGE_NAME_MAX_LENGTH ||
        extension.packageVersion.length === 0 ||
        extension.packageVersion.length > EXTENSION_PACKAGE_VERSION_MAX_LENGTH ||
        valid(extension.packageVersion) === null,
    ) ||
    options.capabilities.some((capability) => valid(capability.version) === null) ||
    (options.capabilities.some(
      (capability) => capability.id === EXTENSION_ARTIFACT_CAPABILITY_ID,
    ) &&
      options.artifactStore === undefined) ||
    (options.capabilities.some((capability) => capability.id === EXTENSION_BIOME_CAPABILITY_ID) &&
      (options.biomeExecution === undefined || options.permissions === undefined)) ||
    (options.operationDeadlineMs !== undefined &&
      (!Number.isSafeInteger(options.operationDeadlineMs) ||
        options.operationDeadlineMs <= 0 ||
        options.operationDeadlineMs > EXTENSION_OPERATION_DEADLINE_MAX_MS)) ||
    (options.operationDisableGraceMs !== undefined &&
      (!Number.isSafeInteger(options.operationDisableGraceMs) ||
        options.operationDisableGraceMs <= 0 ||
        options.operationDisableGraceMs > 30_000))
  ) {
    throw new ExtensionHostError("extension_configuration_invalid");
  }
  const publishedContributions: ExtensionContributionSummary[] = [];
  const registeredOperations = new Map<string, RegisteredOperation>();
  const activeExtensions = new Map<
    string,
    {
      readonly deactivate?:
        | ((context: ExtensionDeactivationContext) => Promise<void> | void)
        | undefined;
    }
  >();
  const loadedSnapshots = new Map<string, ExtensionStateSnapshot>();
  const lifecycleStore = createExtensionLifecycleStore(options.stateRoot);
  const recordStore = createExtensionRecordStore(options.stateRoot);
  const projectChangeMaterializer =
    options.projectChangeMaterializer ??
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter());
  const lifecycleCommandQueues = new Map<string, Promise<void>>();
  const extensionSkillSources = new Map<string, InternalExtensionSkillSource>();
  const projectLifecycleOwner: ProjectLifecycleOwner =
    options.projectLifecycleOwner ??
    (options.operationStore?.projectId === undefined
      ? {
          acquire: async () => ({ release: async () => {} }),
          run: (operation) => operation(),
        }
      : createProjectLifecycleOwner({
          workspaceRoot: options.projectRoot ?? process.cwd(),
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        }));
  const operationHost: OperationHostControl = createOperationHost({
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    ...(options.operationDeadlineMs === undefined
      ? {}
      : { defaultDeadlineMs: options.operationDeadlineMs }),
    ...(options.biomeExecution === undefined ? {} : { biomeExecution: options.biomeExecution }),
    projectRoot: options.projectRoot ?? process.cwd(),
    lifecycleOwner: projectLifecycleOwner,
    ...(options.operationOriginAuthority === undefined
      ? {}
      : { originAuthority: options.operationOriginAuthority }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    recordStore,
    resolveOperation: (contributionId) => registeredOperations.get(contributionId),
    ...(options.operationStore === undefined ? {} : { store: options.operationStore }),
  });
  let loadInFlight: Promise<ExtensionHostSnapshot> | undefined;
  const host: ExtensionHost = {
    operations: operationHost,
    disableExtension(extensionId) {
      return enqueueLifecycleCommand(lifecycleCommandQueues, extensionId, async () => {
        const configured = options.extensions.find(
          (candidate) => candidate.extensionId === extensionId,
        );
        if (configured === undefined) {
          throw new TypeError("The configured extension does not exist.");
        }
        try {
          await lifecycleStore.write(configured, false);
        } catch (error) {
          throw new ExtensionHostError("extension_state_persistence_failed", { cause: error });
        }
        extensionSkillSources.delete(extensionId);
        for (let index = publishedContributions.length - 1; index >= 0; index -= 1) {
          if (publishedContributions[index]?.extensionId === extensionId) {
            registeredOperations.delete(publishedContributions[index]?.id ?? "");
            publishedContributions.splice(index, 1);
          }
        }
        const activeExtension = activeExtensions.get(extensionId);
        const settled = await operationHost.disableExtensionOperations(
          extensionId,
          options.operationDisableGraceMs ?? 1_000,
        );
        if (!settled) {
          const snapshot: ExtensionStateSnapshot = {
            diagnostics: [],
            extensionId: configured.extensionId,
            packageName: configured.packageName,
            packageVersion: configured.packageVersion,
            status: "disabled_with_pending_operations",
          };
          loadedSnapshots.set(extensionId, snapshot);
          return snapshot;
        }
        activeExtensions.delete(extensionId);
        const snapshot = disabledSnapshot(
          configured,
          await deactivateRuntime(configured, activeExtension?.deactivate),
        );
        loadedSnapshots.set(extensionId, snapshot);
        return snapshot;
      });
    },
    enableExtension(extensionId) {
      return enqueueLifecycleCommand(lifecycleCommandQueues, extensionId, async () => {
        const configured = options.extensions.find(
          (candidate) => candidate.extensionId === extensionId,
        );
        if (configured === undefined || !configured.enabled) {
          throw new TypeError("The configured extension cannot be enabled.");
        }
        const loadedSnapshot = loadedSnapshots.get(extensionId);
        if (loadedSnapshot?.status === "disabled_with_pending_operations") {
          throw new TypeError("The extension still has pending operations.");
        }
        try {
          await lifecycleStore.write(configured, true);
        } catch (error) {
          throw new ExtensionHostError("extension_state_persistence_failed", { cause: error });
        }
        if (loadedSnapshot?.status === "active") {
          return loadedSnapshot;
        }
        loadedSnapshots.delete(extensionId);
        const snapshot = await this.loadConfiguredExtensions();
        const extension = snapshot.extensions.find(
          (candidate) => candidate.extensionId === extensionId,
        );
        if (extension === undefined) {
          throw new TypeError("The configured extension disappeared during activation.");
        }
        return extension;
      });
    },
    listContributions() {
      return publishedContributions.map(cloneContributionSummary);
    },
    async startProjectChanges(startOptions) {
      const findContribution = () =>
        publishedContributions.find(
          (candidate) =>
            candidate.command?.id === startOptions.command.id &&
            candidate.command.version === startOptions.command.version &&
            candidate.inputSource?.id === "project_changes" &&
            candidate.inputSource.version === 1,
        );
      let contribution = findContribution();
      if (contribution === undefined) {
        await this.loadConfiguredExtensions();
        contribution = findContribution();
      }
      if (contribution === undefined) {
        throw new ExtensionHostError("project_changes_unavailable");
      }
      try {
        return await operationHost.startLinkedMaterialized({
          contributionId: contribution.id,
          ...(startOptions.deadlineMs === undefined ? {} : { deadlineMs: startOptions.deadlineMs }),
          idempotencyKey: startOptions.idempotencyKey,
          async materialize() {
            return projectChangeMaterializer.materialize({
              canonicalProjectRoot: await realpath(options.projectRoot ?? process.cwd()),
            });
          },
          origin: startOptions.origin,
        });
      } catch (error) {
        if (
          error instanceof GitProjectChangeCaptureError ||
          error instanceof ProjectChangeMaterializerError
        ) {
          throw new ExtensionProjectChangesError(error.code, { cause: error });
        }
        throw error;
      }
    },
    loadConfiguredExtensions() {
      if (loadInFlight !== undefined) {
        return loadInFlight;
      }
      const existing = options.extensions.map(({ extensionId }) =>
        loadedSnapshots.get(extensionId),
      );
      if (
        existing.every((snapshot): snapshot is ExtensionStateSnapshot => snapshot !== undefined)
      ) {
        return Promise.resolve({ extensions: existing });
      }
      const operation = projectLifecycleOwner
        .run(async () => {
          const availableCapabilities = new Map(
            options.capabilities.map((capability) => [capability.id, capability]),
          );
          const extensions: ExtensionStateSnapshot[] = [];
          for (const configured of options.extensions) {
            const loadedSnapshot = loadedSnapshots.get(configured.extensionId);
            if (loadedSnapshot !== undefined) {
              extensions.push(loadedSnapshot);
              continue;
            }
            if (!configured.enabled) {
              extensions.push(disabledSnapshot(configured));
              continue;
            }
            let lifecycleTruth: ExtensionLifecycleTruth;
            try {
              lifecycleTruth = await lifecycleStore.readState(configured);
            } catch {
              extensions.push({
                diagnostics: [{ code: "extension_state_unavailable" }],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            if (lifecycleTruth.enabled === false) {
              extensions.push(disabledSnapshot(configured));
              continue;
            }
            let packageRoot: string;
            try {
              packageRoot = await realpath(configured.packageRoot);
            } catch {
              extensions.push({
                diagnostics: [{ code: "package_unavailable" }],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            let manifest: ExtensionPackageManifest;
            try {
              const packageJson: unknown = JSON.parse(await readPackageManifest(packageRoot));
              manifest = parseExtensionPackageManifest(packageJson);
            } catch {
              extensions.push({
                diagnostics: [{ code: "manifest_invalid" }],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const identityMismatch = findIdentityMismatch(configured, manifest);
            if (identityMismatch !== undefined) {
              extensions.push({
                diagnostics: [identityMismatch],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const inputSourceMismatch = manifest.adamAgent.contributions.find(
              (contribution) =>
                contribution.inputSource?.id === "project_changes" &&
                (contribution.input.id !== EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT.id ||
                  contribution.input.version !==
                    EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT.version),
            );
            if (inputSourceMismatch !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    code: "contribution_input_source_mismatch",
                    contributionId: inputSourceMismatch.id,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const reservedCommandCollision = manifest.adamAgent.contributions.find(
              (contribution) =>
                contribution.command !== undefined &&
                reservedCommandNames.has(contribution.command.name),
            );
            if (reservedCommandCollision?.command !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    code: "command_collision",
                    commandId: reservedCommandCollision.command.id,
                    commandName: reservedCommandCollision.command.name,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const activeCommandCollision = manifest.adamAgent.contributions.find(
              (contribution) =>
                contribution.command !== undefined &&
                publishedContributions.some(
                  (published) =>
                    published.command?.id === contribution.command?.id ||
                    published.command?.name === contribution.command?.name,
                ),
            );
            if (activeCommandCollision?.command !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    code: "command_collision",
                    commandId: activeCommandCollision.command.id,
                    commandName: activeCommandCollision.command.name,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            if (!satisfies(EXTENSION_API_VERSION, manifest.adamAgent.apiVersion)) {
              extensions.push({
                diagnostics: [
                  {
                    code: "extension_api_incompatible",
                    hostVersion: EXTENSION_API_VERSION,
                    requestedVersion: manifest.adamAgent.apiVersion,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const invalidGrant = configured.grants.find(
              (grant) =>
                !isSingleMajorGrantRange(grant.version) ||
                ![
                  ...manifest.adamAgent.capabilities.required,
                  ...manifest.adamAgent.capabilities.optional,
                ].some((capability) => capability.id === grant.id),
            );
            if (invalidGrant !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    capabilityId: invalidGrant.id,
                    code: "capability_grant_invalid",
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const missing = manifest.adamAgent.capabilities.required.find(
              (capability) => !availableCapabilities.has(capability.id),
            );
            if (missing !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    capabilityId: missing.id,
                    code: "required_capability_unavailable",
                    requestedVersion: missing.version,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const incompatible = manifest.adamAgent.capabilities.required.find((capability) => {
              const available = availableCapabilities.get(capability.id);
              return available !== undefined && !satisfies(available.version, capability.version);
            });
            if (incompatible !== undefined) {
              const available = availableCapabilities.get(incompatible.id);
              if (available === undefined) {
                throw new Error("The required capability disappeared during negotiation.");
              }
              extensions.push({
                diagnostics: [
                  {
                    availableVersion: available.version,
                    capabilityId: incompatible.id,
                    code: "required_capability_incompatible",
                    requestedVersion: incompatible.version,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const ungranted = manifest.adamAgent.capabilities.required.find((capability) => {
              const available = availableCapabilities.get(capability.id);
              return !configured.grants.some(
                (grant) =>
                  grant.id === capability.id &&
                  available !== undefined &&
                  satisfies(available.version, grant.version),
              );
            });
            if (ungranted !== undefined) {
              extensions.push({
                diagnostics: [
                  {
                    capabilityId: ungranted.id,
                    code: "required_capability_ungranted",
                    requestedVersion: ungranted.version,
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const optionalDiagnostics: ExtensionActivationDiagnostic[] =
              manifest.adamAgent.capabilities.optional
                .filter((capability) => !availableCapabilities.has(capability.id))
                .map((capability) => ({
                  capabilityId: capability.id,
                  code: "optional_capability_unavailable",
                  requestedVersion: capability.version,
                }));
            for (const capability of manifest.adamAgent.capabilities.optional) {
              const available = availableCapabilities.get(capability.id);
              if (available !== undefined && !satisfies(available.version, capability.version)) {
                optionalDiagnostics.push({
                  availableVersion: available.version,
                  capabilityId: capability.id,
                  code: "optional_capability_incompatible",
                  requestedVersion: capability.version,
                });
              }
              if (
                available !== undefined &&
                satisfies(available.version, capability.version) &&
                !configured.grants.some(
                  (grant) =>
                    grant.id === capability.id && satisfies(available.version, grant.version),
                )
              ) {
                optionalDiagnostics.push({
                  capabilityId: capability.id,
                  code: "optional_capability_ungranted",
                  requestedVersion: capability.version,
                });
              }
            }
            let configuration: ExtensionJsonValue;
            try {
              configuration = prepareConfiguration(configured.configuration ?? null);
            } catch {
              extensions.push({
                diagnostics: [{ code: "configuration_invalid" }],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const registrations: unknown[] = [];
            const activationContext: ExtensionActivationContext = Object.freeze({
              compatibility: deepFreeze({
                api: {
                  hostVersion: EXTENSION_API_VERSION,
                  requestedVersion: manifest.adamAgent.apiVersion,
                },
                capabilities: {
                  optional: negotiateCapabilities(
                    manifest.adamAgent.capabilities.optional,
                    availableCapabilities,
                    configured.grants,
                  ),
                  required: negotiateCapabilities(
                    manifest.adamAgent.capabilities.required,
                    availableCapabilities,
                    configured.grants,
                  ),
                },
              }),
              configuration,
              diagnostics: deepFreeze(optionalDiagnostics.map((diagnostic) => ({ ...diagnostic }))),
              extension: Object.freeze({
                id: configured.extensionId,
                packageName: configured.packageName,
                version: configured.packageVersion,
              }),
              registerOperation(registration: ExtensionOperationRegistration) {
                registrations.push(registration);
              },
            });
            let deactivate:
              | ((context: ExtensionDeactivationContext) => Promise<void> | void)
              | undefined;
            let entryPath: string;
            try {
              entryPath = await resolveConfinedEntry(packageRoot, manifest.adamAgent.runtime.entry);
              await assertEsmRuntimeEntry(packageRoot, entryPath);
            } catch {
              extensions.push({
                diagnostics: [{ code: "runtime_entry_invalid" }],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            try {
              const runtime: unknown = await import(pathToFileURL(entryPath).href);
              if (!isExtensionRuntime(runtime)) {
                throw new TypeError("The extension runtime must export an activate function.");
              }
              deactivate = runtime.deactivate;
              await activateWithDeadline(runtime.activate, activationContext);
            } catch (error) {
              extensions.push({
                diagnostics: [
                  {
                    code:
                      error instanceof ExtensionActivationTimeoutError
                        ? "activation_timed_out"
                        : "activation_failed",
                  },
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const disabledDuringActivation = loadedSnapshots.get(configured.extensionId);
            if (disabledDuringActivation?.status === "disabled") {
              const snapshot = disabledSnapshot(
                configured,
                await deactivateRuntime(configured, deactivate),
              );
              loadedSnapshots.set(configured.extensionId, snapshot);
              extensions.push(snapshot);
              continue;
            }
            const registrationMatch = matchOperationRegistrations(
              configured.extensionId,
              manifest.adamAgent.contributions,
              registrations,
            );
            if (!registrationMatch.ok) {
              const deactivationDiagnostics = await deactivateRuntime(configured, deactivate);
              extensions.push({
                diagnostics: [registrationMatch.diagnostic, ...deactivationDiagnostics],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            const existingContribution = registrationMatch.contributions.find((candidate) =>
              publishedContributions.some((published) => published.id === candidate.id),
            );
            if (existingContribution !== undefined) {
              const deactivationDiagnostics = await deactivateRuntime(configured, deactivate);
              extensions.push({
                diagnostics: [
                  {
                    code: "contribution_collision",
                    contributionId: existingContribution.id,
                  },
                  ...deactivationDiagnostics,
                ],
                extensionId: configured.extensionId,
                packageName: configured.packageName,
                packageVersion: configured.packageVersion,
                status: "rejected",
              });
              continue;
            }
            publishedContributions.push(...registrationMatch.contributions);
            const capabilityIds = [
              ...activationContext.compatibility.capabilities.required,
              ...activationContext.compatibility.capabilities.optional,
            ]
              .filter(
                (capability) => capability.granted && capability.availableVersion !== undefined,
              )
              .map((capability) => capability.id);
            for (const registration of registrationMatch.registrations) {
              const declaration = registrationMatch.contributions.find(
                (candidate) => candidate.id === registration.id,
              );
              if (declaration === undefined) {
                throw new TypeError("The operation declaration is unavailable.");
              }
              registeredOperations.set(registration.id, {
                capabilityIds,
                contribution: declaration,
                contributionId: registration.id,
                definitionDigest: digestOperationDefinition({
                  capabilityIds,
                  capabilityVersions: capabilityIds.map((id) => ({
                    id,
                    version: availableCapabilities.get(id)?.version ?? "unavailable",
                  })),
                  configuration,
                  contribution: declaration,
                  extensionId: configured.extensionId,
                  extensionVersion: configured.packageVersion,
                  grants: configured.grants,
                  packageName: configured.packageName,
                  packageRoot,
                }),
                diagnostics: optionalDiagnostics,
                extensionId: configured.extensionId,
                extensionVersion: configured.packageVersion,
                registration,
              });
            }
            activeExtensions.set(configured.extensionId, { deactivate });
            await operationHost.enableExtensionOperations(configured.extensionId);
            extensionSkillSources.set(configured.extensionId, {
              extensionId: configured.extensionId,
              packageName: configured.packageName,
              packageVersion: configured.packageVersion,
              packageRoot,
              lifecycleRevision: lifecycleTruth.revision,
              lifecycleDigest: lifecycleTruth.digest,
            });
            extensions.push({
              diagnostics: optionalDiagnostics,
              extensionId: configured.extensionId,
              packageName: configured.packageName,
              packageVersion: configured.packageVersion,
              status: "active",
            });
          }
          for (const extension of extensions) {
            loadedSnapshots.set(extension.extensionId, extension);
          }
          return { extensions };
        })
        .catch((error: unknown) => {
          if (error instanceof ProjectLifecycleOwnerError) {
            throw new ExtensionHostError(error.code, { cause: error });
          }
          throw error;
        });
      loadInFlight = operation;
      const clearInFlight = () => {
        if (loadInFlight === operation) {
          loadInFlight = undefined;
        }
      };
      void operation.then(clearInFlight, clearInFlight);
      return operation;
    },
  };
  extensionSkillAuthorities.set(host, {
    lifecycleCommandQueues,
    sources: extensionSkillSources,
  });
  return host;
}

function enqueueLifecycleCommand<T>(
  queues: Map<string, Promise<void>>,
  extensionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(extensionId) ?? Promise.resolve();
  const operation = previous.then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  queues.set(extensionId, settled);
  void settled.then(() => {
    if (queues.get(extensionId) === settled) {
      queues.delete(extensionId);
    }
  });
  return operation;
}

function cloneContributionSummary(
  contribution: ExtensionContributionSummary,
): ExtensionContributionSummary {
  return {
    ...contribution,
    ...(contribution.command === undefined ? {} : { command: { ...contribution.command } }),
    input: { ...contribution.input },
    ...(contribution.inputSource === undefined
      ? {}
      : { inputSource: { ...contribution.inputSource } }),
    output: { ...contribution.output },
    progress: { ...contribution.progress },
    ...(contribution.recovery === undefined ? {} : { recovery: { ...contribution.recovery } }),
    ...(contribution.report === undefined ? {} : { report: { ...contribution.report } }),
  };
}

async function deactivateRuntime(
  configured: ConfiguredExtension,
  deactivate: ((context: ExtensionDeactivationContext) => Promise<void> | void) | undefined,
): Promise<readonly ExtensionDiagnostic[]> {
  try {
    await deactivate?.({
      extension: Object.freeze({
        id: configured.extensionId,
        packageName: configured.packageName,
        version: configured.packageVersion,
      }),
    });
    return [];
  } catch {
    return [{ code: "deactivation_failed" }];
  }
}

const maxPackageManifestBytes = 1024 * 1024;

async function readPackageManifest(packageRoot: string): Promise<string> {
  const path = await resolveConfinedEntry(packageRoot, "package.json");
  return readBoundedOrdinaryTextFile(path, maxPackageManifestBytes, "package manifest");
}

async function readBoundedOrdinaryTextFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
      throw new TypeError(`The extension ${label} must be an ordinary file.`);
    }
    const content = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await file.read(content, offset, content.byteLength - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new TypeError(`The extension ${label} exceeds its read limit.`);
    }
    return content.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

async function assertEsmRuntimeEntry(packageRoot: string, entryPath: string): Promise<void> {
  const extension = extname(entryPath);
  if (extension === ".mjs") {
    return;
  }
  if (extension !== ".js" && extension !== "") {
    throw new TypeError("The extension runtime entry must be an ES module.");
  }
  let directory = dirname(entryPath);
  while (true) {
    try {
      const packageJson: unknown = JSON.parse(
        await readBoundedOrdinaryTextFile(
          resolve(directory, "package.json"),
          maxPackageManifestBytes,
          "package scope manifest",
        ),
      );
      if (
        typeof packageJson !== "object" ||
        packageJson === null ||
        !("type" in packageJson) ||
        packageJson.type !== "module"
      ) {
        throw new TypeError("The extension runtime entry must be in an ES module package scope.");
      }
      return;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (directory === packageRoot) {
      break;
    }
    directory = dirname(directory);
  }
  throw new TypeError("The extension runtime entry must be in an ES module package scope.");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSingleMajorGrantRange(range: string): boolean {
  if (validRange(range) === null || !usesOnlyExplicitSemanticVersions(range)) {
    return false;
  }
  const minimum = minVersion(range);
  const exact = valid(range);
  return (
    minimum !== null &&
    (exact !== null || subset(range, `>=${minimum.major}.0.0-0 <${minimum.major + 1}.0.0`))
  );
}

function usesOnlyExplicitSemanticVersions(range: string): boolean {
  return range
    .replace(/([~^<>=])\s+(?=v?\d)/gu, "$1")
    .split(/\s+|\|\|/u)
    .filter((token) => token.length > 0 && token !== "-")
    .every((token) => {
      const versionCore = token.replace(/^[~^<>=]*v?/u, "").split(/[+-]/u, 1)[0] ?? "";
      return /^\d+\.\d+\.\d+$/u.test(versionCore);
    });
}

function negotiateCapabilities(
  requirements: readonly { readonly id: string; readonly version: string }[],
  availableCapabilities: ReadonlyMap<string, ExtensionCapabilityAvailability>,
  grants: readonly ExtensionCapabilityGrant[],
): readonly ExtensionActivationCapability[] {
  return requirements.map((requirement) => {
    const available = availableCapabilities.get(requirement.id);
    return {
      ...(available === undefined ? {} : { availableVersion: available.version }),
      granted:
        available !== undefined &&
        satisfies(available.version, requirement.version) &&
        grants.some(
          (grant) => grant.id === requirement.id && satisfies(available.version, grant.version),
        ),
      id: requirement.id,
      requestedVersion: requirement.version,
    };
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const maxConfigurationBytes = 64 * 1024;
const maxConfigurationDepth = 32;
const maxConfigurationNodes = 10_000;

function prepareConfiguration(value: unknown): ExtensionJsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maxConfigurationDepth || nodes >= maxConfigurationNodes) {
      throw new TypeError("The extension configuration exceeds its structural limit.");
    }
    nodes += 1;
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate !== "object" || ancestors.has(candidate)) {
      throw new TypeError("The extension configuration must be bounded JSON.");
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (const nested of candidate) {
        visit(nested, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("The extension configuration must be bounded JSON.");
      }
      for (const nested of Object.values(candidate)) {
        visit(nested, depth + 1);
      }
    }
    ancestors.delete(candidate);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxConfigurationBytes) {
    throw new TypeError("The extension configuration exceeds its byte limit.");
  }
  return deepFreeze(JSON.parse(serialized) as ExtensionJsonValue);
}

const activationTimeoutMs = 10_000;

class ExtensionActivationTimeoutError extends Error {}

async function activateWithDeadline(
  activate: (context: ExtensionActivationContext) => Promise<void> | void,
  context: ExtensionActivationContext,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => activate(context)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ExtensionActivationTimeoutError()),
          activationTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function disabledSnapshot(
  configured: ConfiguredExtension,
  diagnostics: readonly ExtensionDiagnostic[] = [],
): ExtensionStateSnapshot {
  return {
    diagnostics,
    extensionId: configured.extensionId,
    packageName: configured.packageName,
    packageVersion: configured.packageVersion,
    status: "disabled",
  };
}

function matchOperationRegistrations(
  extensionId: string,
  declarations: readonly ExtensionOperationContribution[],
  registrations: readonly unknown[],
):
  | {
      readonly ok: true;
      readonly contributions: readonly ExtensionContributionSummary[];
      readonly registrations: readonly ExtensionOperationRegistration[];
    }
  | { readonly ok: false; readonly diagnostic: ExtensionDiagnostic } {
  try {
    return matchOperationRegistrationsUnchecked(extensionId, declarations, registrations);
  } catch {
    return {
      ok: false,
      diagnostic: { code: "contribution_registration_invalid" },
    };
  }
}

function matchOperationRegistrationsUnchecked(
  extensionId: string,
  declarations: readonly ExtensionOperationContribution[],
  registrations: readonly unknown[],
):
  | {
      readonly ok: true;
      readonly contributions: readonly ExtensionContributionSummary[];
      readonly registrations: readonly ExtensionOperationRegistration[];
    }
  | { readonly ok: false; readonly diagnostic: ExtensionDiagnostic } {
  const contributions: ExtensionContributionSummary[] = [];
  if (!registrations.every(isOperationRegistrationCandidate)) {
    return {
      ok: false,
      diagnostic: { code: "contribution_registration_invalid" },
    };
  }
  const duplicateRegistrationId = findDuplicateId(registrations);
  if (duplicateRegistrationId !== undefined) {
    return {
      ok: false,
      diagnostic: {
        code: "contribution_collision",
        contributionId: duplicateRegistrationId,
      },
    };
  }
  const undeclared = registrations.find(
    (registration) => !declarations.some((declaration) => declaration.id === registration.id),
  );
  if (undeclared !== undefined) {
    return {
      ok: false,
      diagnostic: {
        code: "undeclared_contribution",
        contributionId: undeclared.id,
      },
    };
  }
  for (const declaration of declarations) {
    const registration = registrations.find((candidate) => candidate.id === declaration.id);
    if (registration === undefined) {
      return {
        ok: false,
        diagnostic: {
          code: "declared_contribution_missing",
          contributionId: declaration.id,
        },
      };
    }
    if (typeof registration.execute !== "function") {
      return {
        ok: false,
        diagnostic: {
          code: "contribution_handler_invalid",
          contributionId: declaration.id,
        },
      };
    }
    if (
      (declaration.recovery === undefined && registration.reconcile !== undefined) ||
      (declaration.recovery !== undefined && typeof registration.reconcile !== "function")
    ) {
      return {
        ok: false,
        diagnostic: {
          code: "contribution_handler_invalid",
          contributionId: declaration.id,
        },
      };
    }
    const invalidCodec = findInvalidCodec(registration);
    if (invalidCodec !== undefined) {
      return {
        ok: false,
        diagnostic: {
          code: "contribution_codec_invalid",
          contract: invalidCodec,
          contributionId: declaration.id,
        },
      };
    }
    const contractMismatch = findContractMismatch(declaration, registration);
    if (contractMismatch !== undefined) {
      return {
        ok: false,
        diagnostic: {
          code: "contribution_contract_mismatch",
          contributionId: declaration.id,
          ...contractMismatch,
        },
      };
    }
    contributions.push({ extensionId, ...declaration });
  }
  if (declarations.length !== registrations.length) {
    throw new TypeError("Runtime operation registrations must match the static manifest.");
  }
  return {
    ok: true,
    contributions,
    registrations: registrations as readonly ExtensionOperationRegistration[],
  };
}

function findInvalidCodec(
  registration: OperationRegistrationCandidate,
): "input" | "output" | "progress" | undefined {
  return (["input", "output", "progress"] as const).find(
    (contract) =>
      typeof registration[contract].decode !== "function" ||
      typeof registration[contract].encode !== "function",
  );
}

type OperationRegistrationCandidate = {
  readonly execute: unknown;
  readonly id: string;
  readonly input: ExtensionContractCodecCandidate;
  readonly output: ExtensionContractCodecCandidate;
  readonly progress: ExtensionContractCodecCandidate;
  readonly reconcile?: unknown;
};

type ExtensionContractCodecCandidate = ExtensionContractReference & {
  readonly decode?: unknown;
  readonly encode?: unknown;
};

function isOperationRegistrationCandidate(value: unknown): value is OperationRegistrationCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "input" in value &&
    isContractCodecCandidate(value.input) &&
    "output" in value &&
    isContractCodecCandidate(value.output) &&
    "progress" in value &&
    isContractCodecCandidate(value.progress) &&
    "execute" in value
  );
}

function digestOperationDefinition(input: {
  readonly capabilityIds: readonly string[];
  readonly capabilityVersions: readonly { readonly id: string; readonly version: string }[];
  readonly configuration: ExtensionJsonValue;
  readonly contribution: ExtensionContributionSummary;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly grants: readonly ExtensionCapabilityGrant[];
  readonly packageName: string;
  readonly packageRoot: string;
}): string {
  const canonical = canonicalizeDefinitionValue({
    capabilityIds: [...input.capabilityIds].sort(),
    capabilityVersions: [...input.capabilityVersions].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    configuration: input.configuration,
    contribution: {
      kind: input.contribution.kind,
      id: input.contribution.id,
      input: input.contribution.input,
      output: input.contribution.output,
      progress: input.contribution.progress,
      ...(input.contribution.command === undefined ? {} : { command: input.contribution.command }),
      ...(input.contribution.inputSource === undefined
        ? {}
        : { inputSource: input.contribution.inputSource }),
      ...(input.contribution.report === undefined ? {} : { report: input.contribution.report }),
      ...(input.contribution.recovery === undefined
        ? {}
        : { recovery: input.contribution.recovery }),
    },
    extensionId: input.extensionId,
    extensionVersion: input.extensionVersion,
    grants: [...input.grants].sort((left, right) => left.id.localeCompare(right.id)),
    packageName: input.packageName,
    packageRoot: input.packageRoot,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function canonicalizeDefinitionValue(value: ExtensionJsonValue): ExtensionJsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeDefinitionValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: ExtensionJsonValue };
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeDefinitionValue(record[key] as ExtensionJsonValue)]),
    );
  }
  return value;
}

function isContractCodecCandidate(value: unknown): value is ExtensionContractCodecCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "version" in value &&
    Number.isInteger(value.version) &&
    Number(value.version) > 0
  );
}

function findDuplicateId(
  registrations: readonly OperationRegistrationCandidate[],
): string | undefined {
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (seen.has(registration.id)) {
      return registration.id;
    }
    seen.add(registration.id);
  }
  return undefined;
}

function findContractMismatch(
  declaration: ExtensionOperationContribution,
  registration: OperationRegistrationCandidate,
):
  | {
      readonly actual: ExtensionContractReference;
      readonly contract: "input" | "output" | "progress";
      readonly expected: ExtensionContractReference;
    }
  | undefined {
  for (const contract of ["input", "output", "progress"] as const) {
    if (!codecMatches(registration[contract], declaration[contract])) {
      return {
        actual: {
          id: registration[contract].id,
          version: registration[contract].version,
        },
        contract,
        expected: declaration[contract],
      };
    }
  }
  return undefined;
}

function codecMatches(
  codec: { readonly id: string; readonly version: number },
  reference: { readonly id: string; readonly version: number },
): boolean {
  return codec.id === reference.id && codec.version === reference.version;
}

function findIdentityMismatch(
  configured: ConfiguredExtension,
  manifest: { readonly name: string; readonly version: string; readonly adamAgent: { id: string } },
): ExtensionDiagnostic | undefined {
  const identities = [
    { actual: manifest.name, expected: configured.packageName, field: "name" as const },
    { actual: manifest.version, expected: configured.packageVersion, field: "version" as const },
    {
      actual: manifest.adamAgent.id,
      expected: configured.extensionId,
      field: "extensionId" as const,
    },
  ];
  const mismatch = identities.find((identity) => identity.actual !== identity.expected);
  return mismatch === undefined ? undefined : { code: "package_identity_mismatch", ...mismatch };
}

async function resolveConfinedEntry(packageRoot: string, entry: string): Promise<string> {
  const entryPath = await realpath(resolve(packageRoot, entry));
  const relativeEntry = relative(packageRoot, entryPath);
  if (relativeEntry === "" || relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) {
    throw new TypeError("The extension runtime entry must resolve inside its package root.");
  }
  return entryPath;
}

function isExtensionRuntime(value: unknown): value is {
  readonly activate: (context: ExtensionActivationContext) => Promise<void> | void;
  readonly deactivate?:
    | ((context: ExtensionDeactivationContext) => Promise<void> | void)
    | undefined;
} {
  if (typeof value !== "object" || value === null || !("activate" in value)) {
    return false;
  }
  if (typeof value.activate !== "function") {
    return false;
  }
  return (
    !("deactivate" in value) ||
    value.deactivate === undefined ||
    typeof value.deactivate === "function"
  );
}
