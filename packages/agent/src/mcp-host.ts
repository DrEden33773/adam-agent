import { isUtf8 } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  type JSONRPCMessage,
  type JsonSchemaType,
  type JsonSchemaValidator,
  ProtocolError,
  ReadBuffer,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { valid as validSemver } from "semver";
import { z } from "zod";
import type { ArtifactStore } from "./artifact-store.js";
import {
  canonicalMcpJson,
  digestCanonicalMcpJson,
  type McpSha256Digest,
} from "./mcp-canonical-identity.js";
import { inspectMcpConfigurationDocument } from "./mcp-configuration-document.js";
import {
  createMcpToolProfileV1,
  isMcpToolProfileV1Valid,
  type McpSettledServerIdentity,
  type McpToolProfileSnapshot,
  type McpToolProfileV1,
  mcpToolProfileSnapshot,
} from "./mcp-profile-contracts.js";
import type { JsonValue, ToolEffect, ToolRegistry, ToolResult } from "./tool-runtime.js";

export {
  isMcpToolProfileV1Valid,
  type McpToolProfileSnapshot,
  type McpToolProfileV1,
  mcpToolProfileSnapshot,
} from "./mcp-profile-contracts.js";

type Sha256Digest = McpSha256Digest;
type McpJsonRecord = Readonly<Record<string, unknown>> & {
  readonly $anchor?: unknown;
  readonly $dynamicAnchor?: unknown;
  readonly $dynamicRef?: unknown;
  readonly $id?: unknown;
  readonly $recursiveRef?: unknown;
  readonly $ref?: unknown;
  readonly $schema?: unknown;
  readonly allOf?: unknown;
  readonly args?: unknown;
  readonly bin?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly integrity?: unknown;
  readonly link?: unknown;
  readonly mcpServers?: unknown;
  readonly name?: unknown;
  readonly packages?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly resolved?: unknown;
  readonly type?: unknown;
  readonly version?: unknown;
};
type McpActivationErrorCode =
  | "mcp_bootstrap_failed"
  | "mcp_catalog_invalid"
  | "mcp_catalog_too_large"
  | "mcp_initialize_failed"
  | "mcp_shutdown_unconfirmed"
  | "mcp_start_failed"
  | "mcp_startup_timeout";

export type McpEffectiveBoundsV1 = {
  readonly version: 1;
  readonly packageBootstrapMilliseconds: 120_000;
  readonly initializeAndDiscoveryMilliseconds: 30_000;
  readonly toolRequestMilliseconds: 120_000;
  readonly idleMilliseconds: 600_000;
  readonly shutdownMilliseconds: 5_000;
  readonly maximumFrameBytes: 67_108_864;
  readonly maximumStderrTailBytes: 16_384;
  readonly maximumCatalogTools: 256;
  readonly maximumCatalogPages: 64;
  readonly maximumCatalogDefinitionBytes: 4_194_304;
  readonly maximumToolDefinitionBytes: 16_384;
  readonly maximumCatalogCursorBytes: 16_384;
  readonly maximumBootstrapLockBytes: 8_388_608;
  readonly maximumBootstrapManifestBytes: 1_048_576;
  readonly maximumBootstrapDependencies: 4_096;
  readonly maximumExecutableBytes: 268_435_456;
};

export const mcpEffectiveBoundsV1: McpEffectiveBoundsV1 = Object.freeze({
  version: 1,
  packageBootstrapMilliseconds: 120_000,
  initializeAndDiscoveryMilliseconds: 30_000,
  toolRequestMilliseconds: 120_000,
  idleMilliseconds: 600_000,
  shutdownMilliseconds: 5_000,
  maximumFrameBytes: 67_108_864,
  maximumStderrTailBytes: 16_384,
  maximumCatalogTools: 256,
  maximumCatalogPages: 64,
  maximumCatalogDefinitionBytes: 4_194_304,
  maximumToolDefinitionBytes: 16_384,
  maximumCatalogCursorBytes: 16_384,
  maximumBootstrapLockBytes: 8_388_608,
  maximumBootstrapManifestBytes: 1_048_576,
  maximumBootstrapDependencies: 4_096,
  maximumExecutableBytes: 268_435_456,
});

/** Tests only. Production package bootstrap always uses the public npm registry. */
export const mcpPackageRegistryUrl = Symbol("adam-agent.mcp-package-registry-url");

/** Tests only. Production package bootstrap always uses Adam's pinned npm CLI. */
export const mcpPackageManagerCliPath = Symbol("adam-agent.mcp-package-manager-cli-path");

/** Tests only. Production MCP idle scheduling uses the Node timer queue. */
export const mcpIdleScheduler = Symbol("adam-agent.mcp-idle-scheduler");

/** Tests only. Production MCP requests use the Node timer queue. */
export const mcpRequestScheduler = Symbol("adam-agent.mcp-request-scheduler");

/** Tests only. Production package bootstrap uses the Node timer queue. */
export const mcpBootstrapScheduler = Symbol("adam-agent.mcp-bootstrap-scheduler");

/** Tests only. Production initialize and discovery use the Node timer queue. */
export const mcpDiscoveryScheduler = Symbol("adam-agent.mcp-discovery-scheduler");

/** Tests only. Production process closure uses the transport's causal proof. */
export const mcpCloseConfirmation = Symbol("adam-agent.mcp-close-confirmation");

/** Tests only. Production dispatch performs no asynchronous work at this boundary. */
export const mcpBeforeToolDispatchBarrier = Symbol("adam-agent.mcp-before-tool-dispatch-barrier");

/** Tests only. Production MCP connections always use Adam's stdio transport. */
export const mcpTransportFactory = Symbol("adam-agent.mcp-transport-factory");

export type McpIdleScheduler = {
  schedule(delayMilliseconds: number, task: () => Promise<void>): { readonly cancel: () => void };
};

export type McpRequestScheduler = McpIdleScheduler;
export type McpBootstrapScheduler = McpIdleScheduler;
export type McpDiscoveryScheduler = McpIdleScheduler;
export type McpCloseConfirmation = {
  confirm(input: { readonly serverId: string }): Promise<void>;
};
export type McpBeforeToolDispatchBarrier = {
  beforeDispatch(): Promise<void>;
};

export type McpClientTransport = Transport & {
  readonly failureKind: "protocol_error" | undefined;
  readonly isUsable: boolean;
  readonly launchIdentityDigest: Sha256Digest;
  readonly spawnConfirmed: boolean;
};

export type McpTransportFactory = {
  create(input: {
    readonly generationSignal: AbortSignal;
    readonly launch: McpTransportLaunch;
    readonly onUnexpectedClose: () => void;
    readonly server: McpServerPreview;
  }): McpClientTransport;
};

export type McpConfigurationSource = {
  readonly path: ".mcp.json";
  readonly digest: Sha256Digest;
};

export type McpServerPreview = {
  readonly serverId: string;
  readonly status: "approval_required" | "approved" | "ready" | "unsupported";
  readonly transport: "stdio";
  readonly command:
    | {
        readonly kind: "executable";
        readonly path: string;
        readonly identity: {
          readonly version: 1;
          readonly contentDigest: Sha256Digest;
          readonly size: number;
          readonly mode: number;
        };
      }
    | {
        readonly kind: "npm_package";
        readonly packageName: string;
        readonly version: string;
        readonly binPolicy: "npm-default-v1";
      };
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly requestedEnvironmentNames: readonly string[];
  readonly startupEffects: readonly ["execute"] | readonly ["execute", "network"];
  readonly limits: McpEffectiveBoundsV1;
  readonly definitionDigest: Sha256Digest;
};

export type McpToolDraft = {
  readonly serverId: string;
  readonly originalName: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly rawSchemaDigest: Sha256Digest;
  readonly modelProjectionDigest: Sha256Digest;
  readonly definitionDigest: Sha256Digest;
};

export type McpActivationSnapshot = {
  readonly attempt: number;
  readonly generationId: string;
  readonly status: "activating" | "ready" | "failed" | "cancelled";
};

export type McpLiveSessionSnapshot = {
  readonly activation: {
    readonly attempt: number;
    readonly generationId: string;
    readonly status: "ready";
  };
  readonly readyServerIds: ReadonlySet<string>;
  readonly catalog: {
    readonly status: "ready" | "stale";
    readonly digest: Sha256Digest;
    readonly tools: readonly McpToolDraft[];
  };
  readonly settledServers: readonly McpSettledServerIdentity[];
  readonly profile?: McpToolProfileSnapshot;
};

export type McpSessionSnapshot =
  | {
      readonly schemaVersion: 1;
      readonly status: "workspace_confirmation_required";
      readonly workspaceConfirmed: false;
      readonly source: McpConfigurationSource;
      readonly servers: readonly [];
      readonly diagnostics: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly status:
        | "server_approval_required"
        | "activation_required"
        | "activation_failed"
        | "mcp_shutdown_unconfirmed"
        | "catalog_stale"
        | "tool_selection_required"
        | "profile_committed"
        | "profile_reactivation_required";
      readonly workspaceConfirmed: true;
      readonly source: McpConfigurationSource;
      readonly servers: readonly McpServerPreview[];
      readonly activation?: McpActivationSnapshot;
      readonly catalog?: McpLiveSessionSnapshot["catalog"];
      readonly profile?: McpToolProfileSnapshot;
      readonly diagnostics: readonly {
        readonly code:
          | "mcp_catalog_invalid"
          | "mcp_catalog_too_large"
          | "mcp_environment_unsupported"
          | "mcp_bootstrap_failed"
          | "mcp_initialize_failed"
          | "mcp_package_pin_required"
          | "mcp_shutdown_unconfirmed"
          | "mcp_start_failed"
          | "mcp_startup_timeout"
          | "mcp_transport_unsupported";
        readonly serverId?: string;
      }[];
    };

export async function inspectMcpConfiguration(
  workspaceRoot: string,
  confirmedSourceDigest?: Sha256Digest,
  approvedServers: ReadonlyMap<string, Sha256Digest> = new Map(),
  live?: McpLiveSessionSnapshot,
  activationFailure?: {
    readonly code: McpActivationErrorCode;
    readonly serverId?: string;
  },
  committedProfile?: McpToolProfileV1,
  persistedCatalogState?: "ready" | "stale" | "shutdown_unconfirmed",
  persistedActivation?: McpActivationSnapshot,
): Promise<McpSessionSnapshot | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedMcpConfiguration(join(workspaceRoot, ".mcp.json"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (error instanceof McpConfigurationError) {
      throw error;
    }
    throw new McpConfigurationError({ cause: error });
  }

  let document: ReturnType<typeof inspectMcpConfigurationDocument>;
  try {
    document = inspectMcpConfigurationDocument(bytes);
  } catch (error) {
    throw new McpConfigurationError({ cause: error });
  }
  if (document === undefined) {
    throw new McpConfigurationError();
  }

  const source = {
    path: ".mcp.json",
    digest: document.sourceDigest,
  } as const;
  if (confirmedSourceDigest === undefined) {
    return {
      schemaVersion: 1,
      status: "workspace_confirmation_required",
      workspaceConfirmed: false,
      source,
      servers: [],
      diagnostics: [],
    };
  }
  if (confirmedSourceDigest !== source.digest) {
    throw new McpConfigurationError();
  }

  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  let inspections: readonly McpServerConfigurationInspection[];
  try {
    inspections = await Promise.all(
      document.servers.map(({ serverId, configuration }) =>
        inspectMcpServerConfiguration({
          canonicalWorkspaceRoot,
          serverId,
          value: configuration,
        }),
      ),
    );
  } catch (error) {
    throw error instanceof McpConfigurationError
      ? error
      : new McpConfigurationError({ cause: error });
  }
  const servers = inspections.flatMap((inspection) =>
    inspection.server === undefined ? [] : [inspection.server],
  );
  const compatibilityDiagnostics = inspections.flatMap((inspection) =>
    inspection.diagnostic === undefined ? [] : [inspection.diagnostic],
  );
  const resolvedServers = servers.map((server) => ({
    ...server,
    status:
      server.status === "unsupported"
        ? ("unsupported" as const)
        : live?.readyServerIds.has(server.serverId) === true
          ? ("ready" as const)
          : approvedServers.get(server.serverId) === server.definitionDigest
            ? ("approved" as const)
            : ("approval_required" as const),
  }));
  return {
    schemaVersion: 1,
    status:
      persistedCatalogState === "shutdown_unconfirmed"
        ? "mcp_shutdown_unconfirmed"
        : live?.catalog.status === "stale" || persistedCatalogState === "stale"
          ? "catalog_stale"
          : committedProfile !== undefined
            ? live?.profile?.digest === committedProfile.digest
              ? "profile_committed"
              : "profile_reactivation_required"
            : live === undefined
              ? activationFailure !== undefined
                ? activationFailure.code === "mcp_shutdown_unconfirmed"
                  ? "mcp_shutdown_unconfirmed"
                  : "activation_failed"
                : resolvedServers.length > 0 &&
                    compatibilityDiagnostics.length === 0 &&
                    resolvedServers.every((server) => server.status === "approved")
                  ? "activation_required"
                  : "server_approval_required"
              : "tool_selection_required",
    workspaceConfirmed: true,
    source,
    servers: resolvedServers,
    ...(live === undefined
      ? persistedActivation === undefined
        ? {}
        : { activation: persistedActivation }
      : { activation: live.activation, catalog: live.catalog }),
    ...(committedProfile === undefined
      ? {}
      : { profile: mcpToolProfileSnapshot(committedProfile) }),
    diagnostics: [
      ...compatibilityDiagnostics,
      ...resolvedServers.flatMap((server) =>
        server.status === "unsupported"
          ? [{ code: "mcp_environment_unsupported" as const, serverId: server.serverId }]
          : [],
      ),
      ...(activationFailure === undefined ? [] : [activationFailure]),
      ...(persistedCatalogState === "shutdown_unconfirmed"
        ? [{ code: "mcp_shutdown_unconfirmed" as const }]
        : []),
    ],
  };
}

type McpServerConfigurationInspection = {
  readonly server?: McpServerPreview;
  readonly diagnostic?: {
    readonly code: "mcp_package_pin_required" | "mcp_transport_unsupported";
    readonly serverId: string;
  };
};

const unsupportedMcpServerConfigurationFields = new Set([
  "url",
  "headers",
  "oauth",
  "socket",
  "resources",
  "prompts",
  "lifecycle",
  "credentials",
]);

async function inspectMcpServerConfiguration(input: {
  readonly canonicalWorkspaceRoot: string;
  readonly serverId: string;
  readonly value: unknown;
}): Promise<McpServerConfigurationInspection> {
  if (!isRecord(input.value)) {
    throw new McpConfigurationError();
  }
  const type = input.value.type;
  if (
    (typeof type === "string" && type !== "stdio") ||
    Object.keys(input.value).some((key) => unsupportedMcpServerConfigurationFields.has(key))
  ) {
    return {
      diagnostic: { code: "mcp_transport_unsupported", serverId: input.serverId },
    };
  }
  return createExecutableServerPreview(input);
}

async function readBoundedMcpConfiguration(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > 64 * 1024) {
      throw new McpConfigurationError();
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export class McpConfigurationError extends Error {
  readonly code = "mcp_config_invalid" as const;

  constructor(options?: { readonly cause?: unknown }) {
    super(
      "The project MCP configuration is invalid.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "McpConfigurationError";
  }
}

export class McpHostError extends Error {
  readonly code: McpActivationErrorCode;
  readonly closedServers: readonly {
    readonly serverId: string;
    readonly definitionDigest: Sha256Digest;
  }[];
  readonly serverId: string | undefined;

  constructor(
    code: McpActivationErrorCode,
    options?: {
      readonly serverId?: string;
      readonly cause?: unknown;
      readonly closedServers?: readonly {
        readonly serverId: string;
        readonly definitionDigest: Sha256Digest;
      }[];
    },
  ) {
    super(
      mcpHostErrorMessage(code),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "McpHostError";
    this.code = code;
    this.closedServers = options?.closedServers ?? [];
    this.serverId = options?.serverId;
  }
}

function mcpHostErrorMessage(code: McpActivationErrorCode): string {
  switch (code) {
    case "mcp_bootstrap_failed":
      return "The exact MCP package bootstrap failed.";
    case "mcp_catalog_invalid":
      return "The MCP tool catalog is invalid.";
    case "mcp_catalog_too_large":
      return "The MCP tool catalog exceeded its bounded limits.";
    case "mcp_initialize_failed":
      return "The MCP server initialization failed.";
    case "mcp_shutdown_unconfirmed":
      return "The MCP server shutdown could not be causally confirmed.";
    case "mcp_start_failed":
      return "The MCP server could not be started.";
    case "mcp_startup_timeout":
      return "The MCP server startup deadline elapsed.";
  }
}

export type McpRuntimeHost = {
  activate(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly attempt: number;
    readonly servers: readonly McpServerPreview[];
  }): Promise<McpLiveSessionSnapshot>;
  commitActivation(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly catalogDigest: Sha256Digest;
  }): void;
  commitToolProfile(sessionId: string, profile: McpToolProfileV1): void;
  commitCatalogStale(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: Sha256Digest;
  }): void;
  close(): Promise<{
    readonly status: "closed" | "mcp_shutdown_unconfirmed";
    readonly closedSessions: readonly {
      readonly sessionId: string;
      readonly generationId: string;
      readonly attempt: number;
      readonly servers: McpLiveSessionSnapshot["settledServers"];
    }[];
    readonly unconfirmedSessions: readonly {
      readonly sessionId: string;
      readonly generationId: string;
      readonly attempt: number;
      readonly catalogDigest?: Sha256Digest;
      readonly servers: McpLiveSessionSnapshot["settledServers"];
    }[];
  }>;
  closeSession(input: { readonly sessionId: string; readonly generationId: string }): Promise<{
    readonly status: "closed" | "mcp_shutdown_unconfirmed";
    readonly attempt: number;
    readonly servers: McpLiveSessionSnapshot["settledServers"];
  }>;
  closePreparedActivation(input: {
    readonly sessionId: string;
    readonly generationId: string;
  }): Promise<{
    readonly status: "closed" | "mcp_shutdown_unconfirmed";
    readonly attempt: number;
    readonly servers: McpLiveSessionSnapshot["settledServers"];
  }>;
  closeIdleSession(input: { readonly sessionId: string; readonly generationId: string }): Promise<{
    readonly status: "closed" | "mcp_shutdown_unconfirmed";
    readonly attempt: number;
    readonly catalogDigest: Sha256Digest;
    readonly servers: McpLiveSessionSnapshot["settledServers"];
  }>;
  wasGenerationCancelled(generationId: string): boolean;
  prepareToolProfile(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly selections: readonly {
      readonly qualifiedName: string;
      readonly definitionDigest: Sha256Digest;
      readonly effect: ToolEffect;
    }[];
  }): McpToolProfileV1;
  prepareToolProfileRevalidation(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly profile: McpToolProfileV1;
  }): Promise<{
    readonly revalidationId: string;
    readonly generationId: string;
    readonly catalogDigest: Sha256Digest;
    readonly serverIds: readonly string[];
  }>;
  commitToolProfileRevalidation(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly revalidationId: string;
    readonly profileDigest: Sha256Digest;
  }): void;
  reactivateToolProfile(input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly attempt: number;
    readonly servers: readonly McpServerPreview[];
    readonly profile: McpToolProfileV1;
  }): Promise<McpLiveSessionSnapshot>;
  snapshot(sessionId: string): McpLiveSessionSnapshot | undefined;
  toolRegistry(
    sessionId: string,
    profile: McpToolProfileV1,
    artifactStore: ArtifactStore,
  ): ToolRegistry;
};

export function createMcpRuntimeHost(options: {
  readonly bootstrapScheduler: McpBootstrapScheduler;
  readonly discoveryScheduler: McpDiscoveryScheduler;
  readonly onCatalogStale: (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: Sha256Digest;
    readonly reason: "list_changed" | "server_closed";
    readonly attempt?: number;
    readonly closedServers?: readonly {
      readonly serverId: string;
      readonly definitionDigest: Sha256Digest;
    }[];
  }) => void;
  readonly packageRegistryUrl: string;
  readonly packageManagerCliPath: string | undefined;
  readonly requestScheduler: McpRequestScheduler;
  readonly closeConfirmation: McpCloseConfirmation;
  readonly beforeToolDispatch?: McpBeforeToolDispatchBarrier;
  readonly transportFactory?: McpTransportFactory;
}): McpRuntimeHost {
  const generations = new Map<string, McpGeneration>();
  const packageCaches = new Map<string, McpPackageCache>();
  const cancelledGenerations = new Set<string>();
  let accepting = true;
  let closePromise:
    | Promise<{
        readonly status: "closed" | "mcp_shutdown_unconfirmed";
        readonly closedSessions: readonly {
          readonly sessionId: string;
          readonly generationId: string;
          readonly attempt: number;
          readonly servers: McpLiveSessionSnapshot["settledServers"];
        }[];
        readonly unconfirmedSessions: readonly {
          readonly sessionId: string;
          readonly generationId: string;
          readonly attempt: number;
          readonly catalogDigest?: Sha256Digest;
          readonly servers: McpLiveSessionSnapshot["settledServers"];
        }[];
      }>
    | undefined;
  const activate = async (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly attempt: number;
    readonly servers: readonly McpServerPreview[];
  }): Promise<McpLiveSessionSnapshot> => {
    if (!accepting || generations.has(input.sessionId)) {
      throw new Error("MCP runtime host cannot start this activation.");
    }
    const generation: McpGeneration = {
      sessionId: input.sessionId,
      generationId: input.generationId,
      attempt: input.attempt,
      abortController: new AbortController(),
      cancelled: false,
      closing: false,
      primaryFailure: undefined,
      slots: input.servers.map((server) =>
        createMcpServerSlot(
          server,
          (signal) =>
            resolveMcpServerLaunch(
              server,
              mcpPackageCache(packageCaches, input.sessionId),
              options.packageRegistryUrl,
              options.packageManagerCliPath,
              options.bootstrapScheduler,
              signal,
            ),
          options.closeConfirmation,
          options.transportFactory ?? stdioMcpTransportFactory,
        ),
      ),
    };
    for (const slot of generation.slots) {
      slot.onToolsChanged = () => {
        slot.catalogStale = true;
        if (generation.prepared?.catalog.status === "ready") {
          generation.prepared = {
            ...generation.prepared,
            catalog: { ...generation.prepared.catalog, status: "stale" },
          };
        }
        if (generation.live !== undefined) {
          options.onCatalogStale({
            sessionId: generation.sessionId,
            generationId: generation.generationId,
            serverId: slot.server.serverId,
            catalogDigest: generation.live.catalog.digest,
            reason: "list_changed",
          });
        }
      };
      slot.onUnexpectedClose = () => {
        if (
          slot.unexpectedCloseHandled === true ||
          generation.cancelled ||
          generation.closing ||
          generation.live === undefined
        ) {
          return;
        }
        slot.unexpectedCloseHandled = true;
        generation.closing = true;
        generation.abortController.abort(new Error("An MCP server exited unexpectedly."));
        for (const ownedSlot of generation.slots) {
          ownedSlot.catalogStale = true;
        }
        void Promise.allSettled(generation.slots.map(closeMcpServerSlot)).then((outcomes) => {
          const closedServers = generation.slots.flatMap((ownedSlot, index) =>
            outcomes[index]?.status === "fulfilled"
              ? [
                  {
                    serverId: ownedSlot.server.serverId,
                    definitionDigest: ownedSlot.server.definitionDigest,
                  },
                ]
              : [],
          );
          const catalogDigest = generation.live?.catalog.digest;
          if (catalogDigest !== undefined) {
            options.onCatalogStale({
              sessionId: generation.sessionId,
              generationId: generation.generationId,
              serverId: slot.server.serverId,
              catalogDigest,
              reason: "server_closed",
              attempt: generation.attempt,
              closedServers,
            });
          }
        });
      };
    }
    generations.set(input.sessionId, generation);
    const activation = startMcpGeneration(generation, () => accepting, options.discoveryScheduler);
    generation.activation = activation;
    try {
      return await activation;
    } catch (error) {
      const causallyClosed =
        error instanceof McpHostError && error.closedServers.length === generation.slots.length;
      if (accepting && causallyClosed && generations.get(input.sessionId) === generation) {
        generations.delete(input.sessionId);
      }
      throw error;
    }
  };
  return {
    activate,
    commitActivation(input) {
      const generation = generations.get(input.sessionId);
      if (
        !accepting ||
        generation?.prepared === undefined ||
        generation.live !== undefined ||
        generation.closing ||
        generation.cancelled ||
        generation.generationId !== input.generationId ||
        generation.prepared.activation.generationId !== input.generationId ||
        generation.prepared.catalog.digest !== input.catalogDigest
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      generation.live = generation.prepared;
      delete generation.prepared;
      for (const slot of generation.slots) {
        if (slot.catalogStale) {
          options.onCatalogStale({
            sessionId: generation.sessionId,
            generationId: generation.generationId,
            serverId: slot.server.serverId,
            catalogDigest: generation.live.catalog.digest,
            reason: "list_changed",
          });
        }
      }
    },
    commitToolProfile(sessionId, profile) {
      const generation = generations.get(sessionId);
      if (
        !accepting ||
        generation?.live === undefined ||
        generation.cancelled ||
        generation.live.profile !== undefined ||
        generation.live.activation.generationId !== profile.generationId
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      generation.live = { ...generation.live, profile: mcpToolProfileSnapshot(profile) };
    },
    commitCatalogStale(input) {
      const generation = generations.get(input.sessionId);
      const slot = generation?.slots.find(
        (candidate) => candidate.server.serverId === input.serverId,
      );
      if (
        generation?.live === undefined ||
        generation.live.activation.generationId !== input.generationId ||
        generation.live.catalog.digest !== input.catalogDigest ||
        slot?.catalogStale !== true
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      if (generation.live.catalog.status === "ready") {
        generation.live = {
          ...generation.live,
          catalog: { ...generation.live.catalog, status: "stale" },
        };
      }
    },
    async close() {
      if (closePromise !== undefined) {
        return closePromise;
      }
      accepting = false;
      const owned = [...generations.values()];
      for (const generation of owned) {
        generation.cancelled = true;
        generation.closing = true;
        cancelledGenerations.add(generation.generationId);
        generation.abortController.abort(new Error("MCP runtime host is closing."));
      }
      closePromise = (async () => {
        const generationOutcomes = await Promise.all(
          owned.map(async (generation) => {
            const settledServers =
              generation.live?.settledServers ?? generation.prepared?.settledServers ?? [];
            const closeOutcomes = await Promise.allSettled(
              generation.slots.map(closeMcpServerSlot),
            );
            await generation.activation?.catch(() => undefined);
            const confirmed = closeOutcomes.every((outcome) => outcome.status === "fulfilled");
            return {
              confirmed,
              ...(confirmed && settledServers.length > 0
                ? {
                    closedSession: {
                      sessionId: generation.sessionId,
                      generationId: generation.generationId,
                      attempt: generation.attempt,
                      servers: settledServers,
                    },
                  }
                : {}),
            };
          }),
        );
        for (const [index, generation] of owned.entries()) {
          if (
            generationOutcomes[index]?.confirmed === true &&
            generations.get(generation.sessionId) === generation
          ) {
            generations.delete(generation.sessionId);
          }
        }
        const cacheOutcomes = await Promise.allSettled(
          [...packageCaches.values()].map(removeMcpPackageCache),
        );
        const status =
          generationOutcomes.every((outcome) => outcome.confirmed) &&
          cacheOutcomes.every((outcome) => outcome.status === "fulfilled")
            ? ("closed" as const)
            : ("mcp_shutdown_unconfirmed" as const);
        return {
          status,
          closedSessions: generationOutcomes.flatMap((outcome) =>
            outcome.closedSession === undefined ? [] : [outcome.closedSession],
          ),
          unconfirmedSessions: generationOutcomes.flatMap((outcome, index) => {
            const generation = owned[index];
            if (outcome.confirmed || generation === undefined) {
              return [];
            }
            const catalogDigest =
              generation.live?.catalog.digest ?? generation.prepared?.catalog.digest;
            return [
              {
                sessionId: generation.sessionId,
                generationId: generation.generationId,
                attempt: generation.attempt,
                ...(catalogDigest === undefined ? {} : { catalogDigest }),
                servers:
                  generation.live?.settledServers ?? generation.prepared?.settledServers ?? [],
              },
            ];
          }),
        };
      })();
      return closePromise;
    },
    async closeSession(input) {
      const generation = generations.get(input.sessionId);
      if (
        generation === undefined ||
        generation.generationId !== input.generationId ||
        generation.live?.profile !== undefined
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      generation.cancelled = true;
      cancelledGenerations.add(generation.generationId);
      generation.abortController.abort(new Error("MCP configuration was cancelled."));
      const outcomes = await Promise.allSettled(generation.slots.map(closeMcpServerSlot));
      await generation.activation?.catch(() => undefined);
      const cache = packageCaches.get(input.sessionId);
      const cacheOutcome =
        cache === undefined
          ? ({ status: "fulfilled" } as const)
          : await removeMcpPackageCache(cache).then(
              () => ({ status: "fulfilled" as const }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            );
      const status =
        outcomes.every((outcome) => outcome.status === "fulfilled") &&
        cacheOutcome.status === "fulfilled"
          ? ("closed" as const)
          : ("mcp_shutdown_unconfirmed" as const);
      if (status === "closed" && generations.get(input.sessionId) === generation) {
        generations.delete(input.sessionId);
        packageCaches.delete(input.sessionId);
      }
      return {
        status,
        attempt: generation.attempt,
        servers: generation.live?.settledServers ?? generation.prepared?.settledServers ?? [],
      };
    },
    async closePreparedActivation(input) {
      const generation = generations.get(input.sessionId);
      if (
        generation?.prepared === undefined ||
        generation.live !== undefined ||
        generation.generationId !== input.generationId
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const settledServers = generation.prepared.settledServers;
      generation.closing = true;
      generation.abortController.abort(
        new Error("The prepared MCP activation could not be published."),
      );
      const outcomes = await Promise.allSettled(generation.slots.map(closeMcpServerSlot));
      const servers = settledServers.filter(
        (server) =>
          outcomes[generation.slots.findIndex((slot) => slot.server.serverId === server.serverId)]
            ?.status === "fulfilled",
      );
      const status = outcomes.every((outcome) => outcome.status === "fulfilled")
        ? ("closed" as const)
        : ("mcp_shutdown_unconfirmed" as const);
      if (status === "closed" && generations.get(input.sessionId) === generation) {
        generations.delete(input.sessionId);
      }
      return { status, attempt: generation.attempt, servers };
    },
    async closeIdleSession(input) {
      const generation = generations.get(input.sessionId);
      if (
        generation === undefined ||
        generation.generationId !== input.generationId ||
        generation.live?.profile === undefined ||
        generation.closing
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const servers = generation.live.settledServers;
      const catalogDigest = generation.live.catalog.digest;
      generation.closing = true;
      generation.abortController.abort(new Error("The MCP generation reached its idle limit."));
      const outcomes = await Promise.allSettled(generation.slots.map(closeMcpServerSlot));
      const status = outcomes.every((outcome) => outcome.status === "fulfilled")
        ? ("closed" as const)
        : ("mcp_shutdown_unconfirmed" as const);
      if (status === "closed" && generations.get(input.sessionId) === generation) {
        generations.delete(input.sessionId);
      }
      return { status, attempt: generation.attempt, catalogDigest, servers };
    },
    wasGenerationCancelled(generationId) {
      return cancelledGenerations.has(generationId);
    },
    async prepareToolProfileRevalidation(input) {
      const generation = generations.get(input.sessionId);
      if (
        !accepting ||
        generation?.live === undefined ||
        generation.cancelled ||
        generation.closing ||
        generation.generationId !== input.generationId ||
        generation.live.catalog.status !== "stale" ||
        generation.live.profile?.digest !== input.profile.digest
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const staleSlots = generation.slots.filter((slot) => slot.catalogStale);
      if (
        staleSlots.length === 0 ||
        generation.slots.some((slot) => slot.connection === undefined)
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const deadline = new AbortController();
      const scheduledDeadline = options.discoveryScheduler.schedule(
        mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
        async () => {
          deadline.abort(new Error("The MCP discovery deadline elapsed."));
        },
      );
      let connections: {
        readonly slot: McpServerSlot;
        readonly catalogRevision: number;
        readonly connection: McpConnection;
      }[];
      try {
        const discoverySignal = AbortSignal.any([
          generation.abortController.signal,
          deadline.signal,
        ]);
        connections = await Promise.all(
          generation.slots.map(async (slot) => {
            const connection = slot.connection as McpConnection;
            const catalogRevision = slot.catalogRevision;
            const tools = await discoverMcpTools(slot.client, slot.server, discoverySignal);
            return {
              slot,
              catalogRevision,
              connection: { ...connection, tools },
            };
          }),
        );
      } finally {
        scheduledDeadline.cancel();
      }
      if (
        generation.closing ||
        generation.abortController.signal.aborted ||
        connections.some(({ slot, catalogRevision }) => slot.catalogRevision !== catalogRevision) ||
        !mcpProfileMatchesConnections(
          input.profile,
          generation.live.settledServers,
          connections.map(({ connection }) => connection),
        )
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const revalidationId = randomUUID();
      generation.pendingRevalidation = {
        revalidationId,
        profileDigest: input.profile.digest,
        connections,
      };
      return {
        revalidationId,
        generationId: generation.generationId,
        catalogDigest: generation.live.catalog.digest,
        serverIds: staleSlots.map((slot) => slot.server.serverId).sort(),
      };
    },
    commitToolProfileRevalidation(input) {
      const generation = generations.get(input.sessionId);
      const pending = generation?.pendingRevalidation;
      if (
        !accepting ||
        generation?.live === undefined ||
        generation.cancelled ||
        generation.closing ||
        generation.generationId !== input.generationId ||
        generation.live.catalog.status !== "stale" ||
        generation.live.profile?.digest !== input.profileDigest ||
        pending?.revalidationId !== input.revalidationId ||
        pending.profileDigest !== input.profileDigest ||
        pending.connections.some(
          ({ slot, catalogRevision }) => slot.catalogRevision !== catalogRevision,
        )
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      for (const { slot, connection } of pending.connections) {
        slot.connection = connection;
        slot.catalogStale = false;
      }
      generation.live = {
        ...generation.live,
        catalog: { ...generation.live.catalog, status: "ready" },
      };
      delete generation.pendingRevalidation;
    },
    prepareToolProfile(input) {
      const generation = generations.get(input.sessionId);
      if (
        !accepting ||
        generation?.live === undefined ||
        generation.cancelled ||
        generation.closing ||
        generation.live.catalog.status !== "ready" ||
        generation.slots.some((slot) => slot.catalogStale || slot.transport?.isUsable !== true) ||
        generation.live.activation.generationId !== input.generationId ||
        generation.live.profile !== undefined ||
        input.selections.length < 1 ||
        input.selections.length > 20 ||
        new Set(input.selections.map((selection) => selection.qualifiedName)).size !==
          input.selections.length
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const available = generation.slots.flatMap((slot) => slot.connection?.tools ?? []);
      const selected = input.selections.map((selection) => {
        const discovered = available.find(
          (candidate) =>
            candidate.draft.qualifiedName === selection.qualifiedName &&
            candidate.draft.definitionDigest === selection.definitionDigest,
        );
        if (discovered === undefined) {
          throw new McpHostError("mcp_catalog_invalid");
        }
        return { discovered, effect: selection.effect };
      });
      const profileTools = selected.map(({ discovered, effect }) => ({
        serverId: discovered.draft.serverId,
        serverDefinitionDigest: discovered.serverDefinitionDigest,
        originalName: discovered.draft.originalName,
        qualifiedName: discovered.draft.qualifiedName,
        definitionDigest: discovered.draft.definitionDigest,
        modelDescription: mcpModelDescription(
          discovered.draft.serverId,
          effect,
          discovered.serverDescription,
          discovered.compatibilityHint,
        ),
        rawSchema: discovered.rawSchema,
        modelProjection: discovered.modelProjection,
        effect,
        replay: "never" as const,
        cancellation: "abort_signal" as const,
        outputPolicy: {
          version: 1 as const,
          maximumInlineBytes: 65_536 as const,
          maximumRawBytes: 8_388_608 as const,
          supportedContent: ["text", "structured_json"] as const,
        },
      }));
      const profile = createMcpToolProfileV1({
        generationId: input.generationId,
        servers: generation.live.settledServers,
        tools: profileTools,
      });
      if (profile === undefined) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      return profile;
    },
    async reactivateToolProfile(input) {
      const live = await activate(input);
      const generation = generations.get(input.sessionId);
      if (generation === undefined || !mcpProfileMatchesGeneration(input.profile, generation)) {
        let closeOutcomes: readonly PromiseSettledResult<void>[] = [];
        if (generation !== undefined) {
          generation.abortController.abort(
            new Error("The MCP profile changed during reactivation."),
          );
          closeOutcomes = await Promise.allSettled(generation.slots.map(closeMcpServerSlot));
          if (
            closeOutcomes.every((outcome) => outcome.status === "fulfilled") &&
            generations.get(input.sessionId) === generation
          ) {
            generations.delete(input.sessionId);
          }
        }
        const closedServers =
          generation?.slots.flatMap((slot, index) =>
            closeOutcomes[index]?.status === "fulfilled"
              ? [{ serverId: slot.server.serverId, definitionDigest: slot.server.definitionDigest }]
              : [],
          ) ?? [];
        throw new McpHostError(
          generation === undefined || closedServers.length === generation.slots.length
            ? "mcp_catalog_invalid"
            : "mcp_shutdown_unconfirmed",
          { closedServers },
        );
      }
      generation.prepared = { ...live, profile: mcpToolProfileSnapshot(input.profile) };
      return generation.prepared;
    },
    snapshot(sessionId) {
      const generation = generations.get(sessionId);
      return !accepting || generation?.cancelled === true || generation?.closing === true
        ? undefined
        : generation?.live;
    },
    toolRegistry(sessionId, profile, artifactStore) {
      const generation = generations.get(sessionId);
      if (
        !accepting ||
        generation?.live === undefined ||
        generation.cancelled ||
        generation.closing ||
        generation.live.profile?.digest !== profile.digest
      ) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      const live = generation.live;
      const adapters = profile.tools.map((profileTool) => {
        const connection = generation.slots.find(
          (slot) => slot.server.serverId === profileTool.serverId,
        )?.connection;
        const discovered = connection?.tools.find(
          (candidate) =>
            candidate.draft.qualifiedName === profileTool.qualifiedName &&
            candidate.draft.definitionDigest === profileTool.definitionDigest &&
            candidate.rawSchema.digest === profileTool.rawSchema.digest &&
            candidate.modelProjection.digest === profileTool.modelProjection.digest,
        );
        if (connection === undefined || discovered === undefined) {
          throw new McpHostError("mcp_catalog_invalid");
        }
        return createMcpToolAdapter({
          connection,
          discovered,
          profileTool,
          artifactStore,
          requestScheduler: options.requestScheduler,
          ...(options.beforeToolDispatch === undefined
            ? {}
            : { beforeToolDispatch: options.beforeToolDispatch }),
          generationId: live.activation.generationId,
          catalogDigest: live.catalog.digest,
        });
      });
      const byName = new Map(adapters.map((adapter) => [adapter.definition.name, adapter]));
      if (byName.size !== adapters.length) {
        throw new McpHostError("mcp_catalog_invalid");
      }
      return {
        definitions: () => adapters.map((adapter) => adapter.definition),
        resolve: (name) => byName.get(name),
      };
    },
  };
}

function mcpProfileMatchesGeneration(
  profile: McpToolProfileV1,
  generation: McpGeneration,
): boolean {
  const snapshot = generation.prepared ?? generation.live;
  if (snapshot === undefined || generation.slots.some((slot) => slot.connection === undefined)) {
    return false;
  }
  return mcpProfileMatchesConnections(
    profile,
    snapshot.settledServers,
    generation.slots.map((slot) => slot.connection as McpConnection),
  );
}

function mcpProfileMatchesConnections(
  profile: McpToolProfileV1,
  settledServers: McpLiveSessionSnapshot["settledServers"],
  connections: readonly McpConnection[],
): boolean {
  if (
    !isMcpToolProfileV1Valid(profile) ||
    JSON.stringify(settledServers) !== JSON.stringify(profile.servers)
  ) {
    return false;
  }
  const discoveredTools = connections.flatMap((connection) => connection.tools);
  return profile.tools.every((profileTool) => {
    const discovered = discoveredTools.find(
      (candidate) =>
        candidate.draft.serverId === profileTool.serverId &&
        candidate.draft.qualifiedName === profileTool.qualifiedName,
    );
    return (
      discovered !== undefined &&
      discovered.serverDefinitionDigest === profileTool.serverDefinitionDigest &&
      discovered.draft.originalName === profileTool.originalName &&
      discovered.draft.definitionDigest === profileTool.definitionDigest &&
      mcpModelDescription(
        discovered.draft.serverId,
        profileTool.effect,
        discovered.serverDescription,
        discovered.compatibilityHint,
      ) === profileTool.modelDescription &&
      JSON.stringify(discovered.rawSchema) === JSON.stringify(profileTool.rawSchema) &&
      JSON.stringify(discovered.modelProjection) === JSON.stringify(profileTool.modelProjection)
    );
  });
}

type McpGeneration = {
  readonly sessionId: string;
  readonly generationId: string;
  readonly attempt: number;
  readonly abortController: AbortController;
  readonly slots: readonly McpServerSlot[];
  cancelled: boolean;
  closing: boolean;
  primaryFailure: McpHostError | undefined;
  activation?: Promise<McpLiveSessionSnapshot>;
  prepared?: McpLiveSessionSnapshot;
  live?: McpLiveSessionSnapshot;
  pendingRevalidation?: {
    readonly revalidationId: string;
    readonly profileDigest: Sha256Digest;
    readonly connections: readonly {
      readonly slot: McpServerSlot;
      readonly connection: McpConnection;
      readonly catalogRevision: number;
    }[];
  };
};

type McpServerSlot = {
  readonly server: McpServerPreview;
  readonly resolveLaunch: (signal: AbortSignal) => Promise<ResolvedStdioLaunch>;
  readonly client: Client;
  readonly closeConfirmation: McpCloseConfirmation;
  readonly transportFactory: McpTransportFactory;
  transport?: McpClientTransport;
  closePromise?: Promise<void>;
  catalogStale: boolean;
  catalogRevision: number;
  connection?: McpConnection;
  onToolsChanged?: () => void;
  onUnexpectedClose?: () => void;
  unexpectedCloseHandled?: boolean;
};

function createMcpServerSlot(
  server: McpServerPreview,
  resolveLaunch: (signal: AbortSignal) => Promise<ResolvedStdioLaunch>,
  closeConfirmation: McpCloseConfirmation,
  transportFactory: McpTransportFactory,
): McpServerSlot {
  const client = new Client(
    { name: "adam-agent", version: "0.0.0" },
    {
      capabilities: {},
      enforceStrictCapabilities: true,
      inputRequired: { autoFulfill: false },
      listMaxPages: 64,
      supportedProtocolVersions: [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
        "2024-10-07",
      ],
    },
  );
  const slot: McpServerSlot = {
    server,
    resolveLaunch,
    client,
    closeConfirmation,
    transportFactory,
    catalogStale: false,
    catalogRevision: 0,
  };
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    slot.catalogStale = true;
    slot.catalogRevision += 1;
    slot.onToolsChanged?.();
  });
  return slot;
}

async function startMcpGeneration(
  generation: McpGeneration,
  isHostOpen: () => boolean,
  discoveryScheduler: McpDiscoveryScheduler,
): Promise<McpLiveSessionSnapshot> {
  const outcomes = await Promise.allSettled(
    generation.slots.map(async (slot) => {
      try {
        const connection = await activateServer(
          slot,
          generation.abortController.signal,
          discoveryScheduler,
        );
        slot.connection = connection;
        return connection;
      } catch (error) {
        const failure =
          error instanceof McpHostError
            ? error
            : new McpHostError("mcp_start_failed", {
                serverId: slot.server.serverId,
                cause: error,
              });
        if (!generation.abortController.signal.aborted) {
          generation.primaryFailure = failure;
          generation.abortController.abort(failure);
        }
        throw failure;
      }
    }),
  );
  const firstFailure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (firstFailure !== undefined || generation.abortController.signal.aborted || !isHostOpen()) {
    const closeOutcomes = await Promise.allSettled(generation.slots.map(closeMcpServerSlot));
    const cause = generation.primaryFailure ?? firstFailure?.reason;
    const failure =
      cause instanceof McpHostError ? cause : new McpHostError("mcp_start_failed", { cause });
    const closedServers = generation.slots.flatMap((slot, index) =>
      closeOutcomes[index]?.status === "fulfilled"
        ? [{ serverId: slot.server.serverId, definitionDigest: slot.server.definitionDigest }]
        : [],
    );
    throw new McpHostError(
      closedServers.length === generation.slots.length ? failure.code : "mcp_shutdown_unconfirmed",
      {
        ...(failure.serverId === undefined ? {} : { serverId: failure.serverId }),
        cause: failure,
        closedServers,
      },
    );
  }
  const connections = outcomes.map(
    (outcome) => (outcome as PromiseFulfilledResult<McpConnection>).value,
  );
  const tools = connections
    .flatMap((connection) => connection.tools.map((tool) => tool.draft))
    .sort((left, right) =>
      left.serverId === right.serverId
        ? compareCodeUnits(left.originalName, right.originalName)
        : compareCodeUnits(left.serverId, right.serverId),
    );
  const live: McpLiveSessionSnapshot = {
    activation: {
      attempt: generation.attempt,
      generationId: generation.generationId,
      status: "ready",
    },
    readyServerIds: new Set(connections.map((connection) => connection.serverId)),
    catalog: { status: "ready", digest: digestCanonicalMcpJson({ version: 1, tools }), tools },
    settledServers: connections.map((connection) => connection.settlement),
  };
  generation.prepared = live;
  return live;
}

function closeMcpServerSlot(slot: McpServerSlot): Promise<void> {
  slot.closePromise ??= Promise.allSettled([
    slot.client.close(),
    ...(slot.transport === undefined ? [] : [slot.transport.close()]),
  ]).then((outcomes) => {
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
    return slot.closeConfirmation.confirm({ serverId: slot.server.serverId });
  });
  return slot.closePromise;
}

type McpPackageCache = {
  root?: Promise<string>;
  readonly entries: Map<string, Promise<ResolvedMcpPackage>>;
};

type ResolvedMcpPackage = {
  readonly binPath: string;
  readonly identityDigest: Sha256Digest;
};

const npmCliPath = fileURLToPath(new URL("../node_modules/npm/bin/npm-cli.js", import.meta.url));

function mcpPackageCache(caches: Map<string, McpPackageCache>, sessionId: string): McpPackageCache {
  let cache = caches.get(sessionId);
  if (cache === undefined) {
    cache = { entries: new Map() };
    caches.set(sessionId, cache);
  }
  return cache;
}

async function removeMcpPackageCache(cache: McpPackageCache): Promise<void> {
  const root = await cache.root?.catch(() => undefined);
  cache.entries.clear();
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
}

async function resolveMcpServerLaunch(
  server: McpServerPreview,
  cache: McpPackageCache,
  registryUrl: string,
  packageManagerCliPath: string | undefined,
  bootstrapScheduler: McpBootstrapScheduler,
  signal: AbortSignal,
): Promise<ResolvedStdioLaunch> {
  if (server.command.kind === "executable") {
    const identity = await inspectMcpExecutableIdentity(server.command.path);
    if (canonicalMcpJson(identity) !== canonicalMcpJson(server.command.identity)) {
      throw new TypeError("The approved MCP executable identity changed before launch.");
    }
    return {
      path: server.command.path,
      arguments: server.arguments,
      cwd: server.cwd,
      identityDigest: digestCanonicalMcpJson({ version: 1, path: server.command.path, identity }),
    };
  }
  const cacheKey = `${server.command.packageName}@${server.command.version}`;
  let resolved = cache.entries.get(cacheKey);
  if (resolved === undefined) {
    resolved = bootstrapExactMcpPackage(
      server.command,
      cache,
      registryUrl,
      packageManagerCliPath,
      bootstrapScheduler,
      signal,
    );
    cache.entries.set(cacheKey, resolved);
    void resolved.catch(() => {
      if (cache.entries.get(cacheKey) === resolved) {
        cache.entries.delete(cacheKey);
      }
    });
  }
  const installed = await resolved;
  return {
    path: installed.binPath,
    arguments: server.arguments,
    cwd: server.cwd,
    identityDigest: installed.identityDigest,
  };
}

async function bootstrapExactMcpPackage(
  command: Extract<McpServerPreview["command"], { readonly kind: "npm_package" }>,
  cache: McpPackageCache,
  registryUrl: string,
  packageManagerCliPath: string | undefined,
  bootstrapScheduler: McpBootstrapScheduler,
  signal: AbortSignal,
): Promise<ResolvedMcpPackage> {
  cache.root ??= createMcpPackageCacheRoot();
  const root = await cache.root;
  const packagesRoot = join(root, "packages");
  const key = createHash("sha256")
    .update(`${command.packageName}@${command.version}`)
    .digest("hex");
  const target = join(packagesRoot, key);
  const staging = join(packagesRoot, `.${key}.staging`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const deadline = new AbortController();
  const scheduledDeadline = bootstrapScheduler.schedule(
    mcpEffectiveBoundsV1.packageBootstrapMilliseconds,
    async () => {
      deadline.abort(new Error("The MCP package bootstrap deadline elapsed."));
    },
  );
  const effectiveSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    effectiveSignal.throwIfAborted();
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify({ private: true, dependencies: { [command.packageName]: command.version } }),
      { mode: 0o600 },
    );
    await runNpmInstall({
      cacheRoot: root,
      packageManagerCliPath: packageManagerCliPath ?? npmCliPath,
      packageSpec: `${command.packageName}@${command.version}`,
      registryUrl,
      signal: effectiveSignal,
      staging,
    });
    effectiveSignal.throwIfAborted();
    const packageRelativePath = join("node_modules", ...command.packageName.split("/"));
    const stagingPackageRoot = join(staging, packageRelativePath);
    const manifest = parseJsonRecord(
      await readBoundedUtf8File(
        join(stagingPackageRoot, "package.json"),
        mcpEffectiveBoundsV1.maximumBootstrapManifestBytes,
        effectiveSignal,
      ),
    );
    if (manifest.name !== command.packageName || manifest.version !== command.version) {
      throw new Error("The installed MCP package identity did not match its approval.");
    }
    const lock = parseJsonRecord(
      await readBoundedUtf8File(
        join(staging, "package-lock.json"),
        mcpEffectiveBoundsV1.maximumBootstrapLockBytes,
        effectiveSignal,
      ),
    );
    const lockPackages = lock.packages;
    if (!isRecord(lockPackages)) {
      throw new Error("The MCP package lock was unavailable.");
    }
    if (Object.keys(lockPackages).length > mcpEffectiveBoundsV1.maximumBootstrapDependencies + 1) {
      throw new Error("The MCP package dependency tree exceeded its bounded limit.");
    }
    const registryOrigin = new URL(registryUrl).origin;
    const dependencyTree: {
      readonly path: string;
      readonly name: string;
      readonly version: string;
      readonly integrity: string;
    }[] = [];
    for (const [lockPath, lockValue] of Object.entries(lockPackages).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      effectiveSignal.throwIfAborted();
      if (lockPath.length === 0) {
        continue;
      }
      if (
        !lockPath.startsWith("node_modules/") ||
        isAbsolute(lockPath) ||
        lockPath.split("/").includes("..") ||
        !isRecord(lockValue) ||
        lockValue.link === true ||
        typeof lockValue.version !== "string" ||
        typeof lockValue.integrity !== "string" ||
        !lockValue.integrity.startsWith("sha512-") ||
        typeof lockValue.resolved !== "string"
      ) {
        throw new Error("The MCP package dependency lock was invalid.");
      }
      const resolvedUrl = new URL(lockValue.resolved);
      if (
        resolvedUrl.origin !== registryOrigin ||
        resolvedUrl.username.length > 0 ||
        resolvedUrl.password.length > 0
      ) {
        throw new Error("The MCP package dependency escaped its approved registry.");
      }
      const installedRoot = await realpath(resolve(staging, lockPath));
      if (!isPathInside(staging, installedRoot) || !(await stat(installedRoot)).isDirectory()) {
        throw new Error("The MCP package dependency escaped its install root.");
      }
      const installedManifest = parseJsonRecord(
        await readBoundedUtf8File(
          join(installedRoot, "package.json"),
          mcpEffectiveBoundsV1.maximumBootstrapManifestBytes,
          effectiveSignal,
        ),
      );
      if (
        typeof installedManifest.name !== "string" ||
        installedManifest.version !== lockValue.version
      ) {
        throw new Error("The MCP package dependency identity was invalid.");
      }
      dependencyTree.push({
        path: lockPath,
        name: installedManifest.name,
        version: lockValue.version,
        integrity: lockValue.integrity,
      });
    }
    const lockedPackage = lockPackages[packageRelativePath];
    if (
      !isRecord(lockedPackage) ||
      lockedPackage.version !== command.version ||
      typeof lockedPackage.integrity !== "string" ||
      typeof lockedPackage.resolved !== "string" ||
      new URL(lockedPackage.resolved).origin !== registryOrigin
    ) {
      throw new Error("The MCP package lock identity was invalid.");
    }
    const binRelativePath = resolveNpmDefaultBin(command.packageName, manifest.bin);
    const stagingBin = await realpath(resolve(stagingPackageRoot, binRelativePath));
    if (!isPathInside(stagingPackageRoot, stagingBin) || !(await stat(stagingBin)).isFile()) {
      throw new Error("The MCP package bin escaped its package root.");
    }
    await access(stagingBin, constants.X_OK);
    const binDigest = await hashBoundedFile(
      stagingBin,
      mcpEffectiveBoundsV1.maximumExecutableBytes,
      effectiveSignal,
    );
    const identityDigest = digestCanonicalMcpJson({
      version: 1,
      packageName: command.packageName,
      packageVersion: command.version,
      integrity: lockedPackage.integrity,
      dependencyTreeDigest: digestCanonicalMcpJson({ version: 1, packages: dependencyTree }),
      binPolicy: command.binPolicy,
      binRelativePath,
      binDigest,
      npmVersion: "11.6.2",
      lifecycleScripts: "disabled",
    });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const packageRoot = join(target, packageRelativePath);
    const binPath = await realpath(resolve(packageRoot, binRelativePath));
    if (!isPathInside(packageRoot, binPath)) {
      throw new Error("The published MCP package bin escaped its package root.");
    }
    effectiveSignal.throwIfAborted();
    return { binPath, identityDigest };
  } finally {
    scheduledDeadline.cancel();
    await rm(staging, { recursive: true, force: true });
  }
}

async function createMcpPackageCacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adam-agent-mcp-packages-"));
  try {
    await Promise.all([
      mkdir(join(root, "cache"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, "home"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, "packages"), { recursive: true, mode: 0o700 }),
      writeFile(join(root, "user.npmrc"), "", { mode: 0o600 }),
      writeFile(join(root, "global.npmrc"), "", { mode: 0o600 }),
    ]);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runNpmInstall(input: {
  readonly cacheRoot: string;
  readonly packageManagerCliPath: string;
  readonly packageSpec: string;
  readonly registryUrl: string;
  readonly signal: AbortSignal;
  readonly staging: string;
}): Promise<void> {
  const effectiveSignal = input.signal;
  if (effectiveSignal.aborted) {
    throw new Error("The MCP package bootstrap was cancelled.");
  }
  const child = spawn(
    process.execPath,
    [
      input.packageManagerCliPath,
      "install",
      input.packageSpec,
      "--ignore-scripts=true",
      "--audit=false",
      "--fund=false",
      "--update-notifier=false",
      "--workspaces=false",
      "--package-lock=true",
      "--save-exact=true",
      `--registry=${input.registryUrl}`,
      `--cache=${join(input.cacheRoot, "cache")}`,
      `--userconfig=${join(input.cacheRoot, "user.npmrc")}`,
      `--globalconfig=${join(input.cacheRoot, "global.npmrc")}`,
    ],
    {
      cwd: input.staging,
      detached: true,
      env: {
        HOME: join(input.cacheRoot, "home"),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        TERM: "dumb",
        TMPDIR: input.cacheRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  let stderrTail = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    const combined = Buffer.concat([stderrTail, chunk]);
    stderrTail = combined.subarray(
      Math.max(0, combined.byteLength - mcpEffectiveBoundsV1.maximumStderrTailBytes),
    );
  });
  const childClosed = new Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, closeSignal) => resolveClose({ code, signal: closeSignal }));
  });
  const childSettled = childClosed.then(
    () => undefined,
    () => undefined,
  );
  let termination: Promise<void> | undefined;
  const terminate = () => {
    const processGroupId = child.pid;
    if (processGroupId === undefined || termination !== undefined) {
      return;
    }
    signalProcessGroup(processGroupId, "SIGTERM");
    termination = closeMcpProcessGroupCausally(processGroupId, childSettled);
  };
  effectiveSignal.addEventListener("abort", terminate, { once: true });
  try {
    const outcome = await childClosed;
    if (effectiveSignal.aborted || outcome.code !== 0 || outcome.signal !== null) {
      terminate();
      await termination;
      throw new Error("The MCP package bootstrap failed.");
    }
    if (child.pid !== undefined && processGroupExists(child.pid)) {
      terminate();
      await termination;
      throw new Error("The MCP package bootstrap left a live process group.");
    }
  } finally {
    effectiveSignal.removeEventListener("abort", terminate);
    await termination;
    stderrTail = Buffer.alloc(0);
  }
}

function resolveNpmDefaultBin(packageName: string, bin: unknown): string {
  if (typeof bin === "string" && bin.length > 0) {
    return bin;
  }
  if (!isStringRecord(bin)) {
    throw new Error("The MCP package did not expose one deterministic bin.");
  }
  const entries = Object.entries(bin);
  const defaultName = packageName.slice(packageName.lastIndexOf("/") + 1);
  const selected =
    entries.length === 1 ? entries[0] : entries.find(([name]) => name === defaultName);
  if (selected === undefined || selected[1].length === 0) {
    throw new Error("The MCP package bin was ambiguous.");
  }
  return selected[1];
}

function parseJsonRecord(source: string): McpJsonRecord {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value)) {
    throw new Error("The MCP package metadata was invalid.");
  }
  return value;
}

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

type McpConnection = {
  readonly serverId: string;
  readonly client: Client;
  readonly isCatalogStale: () => boolean;
  readonly transportFailure: () => "protocol_error" | undefined;
  readonly tools: readonly McpDiscoveredTool[];
  readonly settlement: McpLiveSessionSnapshot["settledServers"][number];
};

type McpDiscoveredTool = {
  readonly draft: McpToolDraft;
  readonly protocolTool: Tool;
  readonly serverDescription: string;
  readonly serverDefinitionDigest: Sha256Digest;
  readonly rawSchema: McpToolProfileV1["tools"][number]["rawSchema"];
  readonly modelProjection: McpToolProfileV1["tools"][number]["modelProjection"];
  readonly validateInput: JsonSchemaValidator<unknown>;
  readonly validateOutput?: JsonSchemaValidator<unknown>;
  readonly compatibilityHint?: string;
};

function createMcpToolAdapter(input: {
  readonly artifactStore: ArtifactStore;
  readonly connection: McpConnection;
  readonly discovered: McpDiscoveredTool;
  readonly profileTool: McpToolProfileV1["tools"][number];
  readonly requestScheduler: McpRequestScheduler;
  readonly beforeToolDispatch?: McpBeforeToolDispatchBarrier;
  readonly generationId: string;
  readonly catalogDigest: Sha256Digest;
}) {
  const { artifactStore, catalogDigest, connection, discovered, generationId, profileTool } = input;
  const definition = {
    name: profileTool.qualifiedName,
    description: profileTool.modelDescription,
    inputSchema: profileTool.modelProjection.schema,
  };
  return {
    definition,
    definitionDigest: profileTool.definitionDigest,
    outputSchema: z.json(),
    effect: profileTool.effect,
    replay: profileTool.replay,
    cancellation: profileTool.cancellation,
    maximumResult: { maximumBytes: profileTool.outputPolicy.maximumInlineBytes },
    prepare(argumentsJson: string) {
      if (connection.isCatalogStale()) {
        return staleMcpCatalogToolResult({
          generationId,
          serverId: profileTool.serverId,
          catalogDigest,
        });
      }
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(argumentsJson) as unknown;
      } catch {
        return invalidMcpToolInput();
      }
      const validation = discovered.validateInput(argumentsValue);
      if (!validation.valid || !isRecord(argumentsValue)) {
        return invalidMcpToolInput();
      }
      const argumentsDigest = digestCanonicalMcpJson(argumentsValue);
      return {
        status: "ready" as const,
        permissionSubject: {
          type: "mcp_tool" as const,
          serverId: profileTool.serverId,
          originalName: profileTool.originalName,
          qualifiedName: profileTool.qualifiedName,
          serverDefinitionDigest: profileTool.serverDefinitionDigest,
          definitionDigest: profileTool.definitionDigest,
          argumentsDigest,
        },
        validateBeforeDispatch() {
          return connection.isCatalogStale()
            ? staleMcpCatalogToolResult({
                generationId,
                serverId: profileTool.serverId,
                catalogDigest,
              })
            : undefined;
        },
        async execute(context: {
          readonly signal: AbortSignal;
          readonly callId: string;
          readonly toolName: string;
        }): Promise<ToolResult> {
          await input.beforeToolDispatch?.beforeDispatch();
          if (connection.isCatalogStale()) {
            return staleMcpCatalogToolResult({
              generationId,
              serverId: profileTool.serverId,
              catalogDigest,
            });
          }
          return executeMcpTool({
            argumentsValue,
            artifactStore,
            callId: context.callId,
            client: connection.client,
            definitionDigest: profileTool.definitionDigest,
            originalName: profileTool.originalName,
            requestScheduler: input.requestScheduler,
            serverId: profileTool.serverId,
            signal: context.signal,
            transportFailure: connection.transportFailure,
            toolName: context.toolName,
            ...(discovered.validateOutput === undefined
              ? {}
              : { validateOutput: discovered.validateOutput }),
          });
        },
      };
    },
  };
}

function staleMcpCatalogToolResult(input: {
  readonly generationId: string;
  readonly serverId: string;
  readonly catalogDigest: Sha256Digest;
}): Extract<ToolResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    error: {
      code: "mcp_catalog_stale",
      message: "The committed MCP tool catalog is stale and must be revalidated.",
      generationId: input.generationId,
      serverId: input.serverId,
      catalogDigest: input.catalogDigest,
    },
  };
}

function invalidMcpToolInput(): Extract<ToolResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    error: {
      code: "invalid_tool_input",
      message: "The MCP tool arguments do not match the approved input schema.",
    },
  };
}

async function executeMcpTool(input: {
  readonly argumentsValue: Readonly<Record<string, unknown>>;
  readonly artifactStore: ArtifactStore;
  readonly callId: string;
  readonly client: Client;
  readonly definitionDigest: string;
  readonly originalName: string;
  readonly requestScheduler: McpRequestScheduler;
  readonly serverId: string;
  readonly signal: AbortSignal;
  readonly transportFailure: () => "protocol_error" | undefined;
  readonly toolName: string;
  readonly validateOutput?: JsonSchemaValidator<unknown>;
}): Promise<ToolResult> {
  const deadline = new AbortController();
  const scheduledDeadline = input.requestScheduler.schedule(
    mcpEffectiveBoundsV1.toolRequestMilliseconds,
    async () => {
      deadline.abort(new Error("The MCP tool request deadline elapsed."));
    },
  );
  try {
    const result = await input.client.callTool(
      { name: input.originalName, arguments: input.argumentsValue },
      {
        signal: AbortSignal.any([input.signal, deadline.signal]),
        timeout: mcpEffectiveBoundsV1.toolRequestMilliseconds,
        maxTotalTimeout: mcpEffectiveBoundsV1.toolRequestMilliseconds,
      },
    );
    scheduledDeadline.cancel();
    if (input.validateOutput !== undefined) {
      const validation =
        result.structuredContent === undefined
          ? { valid: false as const }
          : input.validateOutput(result.structuredContent);
      if (!validation.valid) {
        return {
          status: "failed",
          error: {
            code: "mcp_output_invalid",
            message: "The MCP tool result did not match the discovered output schema.",
          },
        };
      }
    }
    const content: { readonly type: "text"; readonly text: string }[] = [];
    for (const block of result.content) {
      if (block.type !== "text") {
        return {
          status: "failed",
          error: {
            code: "mcp_output_unsupported",
            message: "The MCP tool returned a content type that Adam does not support.",
          },
        };
      }
      content.push({ type: "text", text: block.text });
    }
    if (result.structuredContent !== undefined && !isJsonValue(result.structuredContent)) {
      return {
        status: "failed",
        error: {
          code: "mcp_output_invalid",
          message: "The MCP tool result did not contain valid structured JSON.",
        },
      };
    }
    const output: JsonValue = {
      version: 1,
      content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      isError: result.isError === true,
    };
    const outputBytes = Buffer.from(canonicalMcpJson(output), "utf8");
    if (outputBytes.byteLength > 8 * 1024 * 1024) {
      return {
        status: "failed",
        error: {
          code: "mcp_result_too_large",
          message: "The complete MCP tool result exceeded the 8 MiB raw output limit.",
        },
      };
    }
    if (outputBytes.byteLength <= 65_536) {
      return { status: "completed", output };
    }
    try {
      const artifact = await input.artifactStore.write({
        bytes: outputBytes,
        mediaType: "application/json",
        source: {
          type: "mcp_tool_result",
          schemaVersion: 1,
          callId: input.callId,
          toolName: input.toolName,
          serverId: input.serverId,
          originalName: input.originalName,
          definitionDigest: input.definitionDigest,
        },
      });
      let remainingPreviewBytes = 4_096;
      const previewContent = content.slice(0, 64).map((block) => {
        const text = block.text;
        const totalBytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
        const preview = typeof text === "string" ? truncateUtf8(text, remainingPreviewBytes) : "";
        remainingPreviewBytes -= Buffer.byteLength(preview, "utf8");
        return {
          type: "text",
          text: preview,
          ...(Buffer.byteLength(preview, "utf8") < totalBytes
            ? { truncated: true, totalBytes }
            : {}),
        };
      });
      return {
        status: "completed",
        output: {
          version: 1,
          content: previewContent,
          ...(content.length <= previewContent.length
            ? {}
            : { omittedContentBlocks: content.length - previewContent.length }),
          isError: result.isError === true,
          artifact,
        },
      };
    } catch {
      return {
        status: "failed",
        error: {
          code: "artifact_store_failed",
          message: "The complete MCP tool result could not be stored safely.",
        },
      };
    }
  } catch (error) {
    scheduledDeadline.cancel();
    if (input.signal.aborted) {
      return indeterminateMcpToolResult(
        "mcp_caller_cancelled",
        "The MCP tool call was cancelled after it was dispatched.",
      );
    }
    if (deadline.signal.aborted) {
      return indeterminateMcpToolResult(
        "mcp_request_timeout",
        "The MCP tool request timed out after it was dispatched.",
      );
    }
    if (input.transportFailure() === "protocol_error") {
      return indeterminateMcpToolResult(
        "mcp_protocol_error",
        "The MCP protocol failed before a complete tool response was confirmed.",
      );
    }
    if (ProtocolError.isInstance(error)) {
      return {
        status: "failed",
        error: {
          code: "mcp_protocol_error",
          message: "The MCP server returned a complete protocol error response.",
        },
      };
    }
    if (SdkError.isInstance(error) && error.code === SdkErrorCode.InvalidResult) {
      return {
        status: "failed",
        error: {
          code: "mcp_output_invalid",
          message: "The MCP tool result did not match the discovered output schema.",
        },
      };
    }
    if (SdkError.isInstance(error) && error.code === SdkErrorCode.ConnectionClosed) {
      return indeterminateMcpToolResult(
        "mcp_connection_closed",
        "The MCP connection closed before the tool returned a complete response.",
      );
    }
    if (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout) {
      return indeterminateMcpToolResult(
        "mcp_request_timeout",
        "The MCP tool request timed out after it was dispatched.",
      );
    }
    return indeterminateMcpToolResult(
      "mcp_protocol_error",
      "The MCP tool call failed without a confirmed complete response.",
    );
  }
}

function indeterminateMcpToolResult(
  reason:
    | "mcp_request_timeout"
    | "mcp_caller_cancelled"
    | "mcp_connection_closed"
    | "mcp_protocol_error",
  message: string,
): ToolResult {
  return {
    status: "failed",
    error: {
      code: "tool_effect_indeterminate",
      reason,
      message,
    },
  };
}

async function activateServer(
  slot: McpServerSlot,
  generationSignal: AbortSignal,
  discoveryScheduler: McpDiscoveryScheduler,
): Promise<McpConnection> {
  const { client, server } = slot;
  let scheduledDeadline: { readonly cancel: () => void } | undefined;
  let deadline: AbortController | undefined;
  let phase: "bootstrap" | "initialize" | "catalog" = "bootstrap";
  let transport: McpClientTransport | undefined;
  try {
    const launch = await slot.resolveLaunch(generationSignal);
    generationSignal.throwIfAborted();
    const activationDeadline = new AbortController();
    deadline = activationDeadline;
    scheduledDeadline = discoveryScheduler.schedule(
      mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
      async () => {
        activationDeadline.abort(new Error("The MCP initialize and discovery deadline elapsed."));
      },
    );
    const discoverySignal = AbortSignal.any([generationSignal, activationDeadline.signal]);
    const activeTransport = slot.transportFactory.create({
      generationSignal,
      launch,
      onUnexpectedClose: () => slot.onUnexpectedClose?.(),
      server,
    });
    transport = activeTransport;
    slot.transport = activeTransport;
    phase = "initialize";
    await client.connect(activeTransport, {
      signal: discoverySignal,
      timeout: mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
      maxTotalTimeout: mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
    });
    phase = "catalog";
    const tools = await discoverMcpTools(client, server, discoverySignal);
    const serverVersion = client.getServerVersion();
    const capabilities = client.getServerCapabilities() ?? {};
    const protocolVersion = client.getNegotiatedProtocolVersion() ?? "unknown";
    const serverName = serverVersion?.name ?? "unknown";
    const negotiatedServerVersion = serverVersion?.version ?? "unknown";
    if (
      protocolVersion.length < 1 ||
      protocolVersion.length > 64 ||
      serverName.length < 1 ||
      serverName.length > 256 ||
      negotiatedServerVersion.length < 1 ||
      negotiatedServerVersion.length > 128
    ) {
      throw new McpHostError("mcp_initialize_failed", { serverId: server.serverId });
    }
    return {
      serverId: server.serverId,
      client,
      isCatalogStale: () => slot.catalogStale,
      transportFailure: () => activeTransport.failureKind,
      tools,
      settlement: {
        serverId: server.serverId,
        definitionDigest: server.definitionDigest,
        protocolVersion,
        serverName,
        serverVersion: negotiatedServerVersion,
        capabilityDigest: digestCanonicalMcpJson(capabilities),
        launchIdentityDigest: activeTransport.launchIdentityDigest,
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof McpHostError) {
      throw error;
    }
    const code: McpActivationErrorCode =
      deadline?.signal.aborted === true
        ? "mcp_startup_timeout"
        : phase === "bootstrap"
          ? server.command.kind === "npm_package"
            ? "mcp_bootstrap_failed"
            : "mcp_start_failed"
          : phase === "initialize"
            ? transport?.spawnConfirmed === true
              ? "mcp_initialize_failed"
              : "mcp_start_failed"
            : "mcp_catalog_invalid";
    throw new McpHostError(code, { serverId: server.serverId, cause: error });
  } finally {
    scheduledDeadline?.cancel();
  }
}

async function discoverMcpTools(
  client: Client,
  server: McpServerPreview,
  signal: AbortSignal,
): Promise<readonly McpDiscoveredTool[]> {
  const catalog = await listAllTools(client, server.serverId, signal);
  const validatorProvider = new AjvJsonSchemaValidator();
  return catalog.tools.flatMap((tool): McpDiscoveredTool[] => {
    const inputSchema = tool.inputSchema as McpJsonRecord;
    try {
      assertMcpSchemaAdmissible(inputSchema);
      if (tool.outputSchema !== undefined) {
        assertMcpSchemaAdmissible(tool.outputSchema as McpJsonRecord);
      }
      const validateInput = validatorProvider.getValidator<unknown>(
        structuredClone(tool.inputSchema) as JsonSchemaType,
      );
      const validateOutput =
        tool.outputSchema === undefined
          ? undefined
          : validatorProvider.getValidator<unknown>(
              structuredClone(tool.outputSchema) as JsonSchemaType,
            );
      const rawSchema = {
        dialect: schemaDialect(inputSchema),
        provenance: "tools/list" as const,
        value: inputSchema,
        digest: digestCanonicalMcpJson(inputSchema),
      };
      const projected = projectMcpInputSchemaV1(inputSchema);
      assertMcpSchemaAdmissible(projected.schema);
      const modelProjection = {
        version: 1 as const,
        schema: projected.schema,
        digest: digestCanonicalMcpJson({ version: 1, schema: projected.schema }),
      };
      const qualifiedName = qualifiedToolName(server, tool.name);
      const serverDescription = normalizeMcpServerDescription(tool.description ?? "");
      const description = mcpModelDescription(
        server.serverId,
        undefined,
        serverDescription,
        projected.compatibilityHint,
      );
      const definitionDigest = digestCanonicalMcpJson({
        version: 1,
        serverId: server.serverId,
        serverDefinitionDigest: server.definitionDigest,
        originalName: tool.name,
        qualifiedName,
        description: serverDescription,
        rawSchemaDigest: rawSchema.digest,
        modelProjectionDigest: modelProjection.digest,
        outputSchemaDigest:
          tool.outputSchema === undefined ? null : digestCanonicalMcpJson(tool.outputSchema),
      });
      return [
        {
          draft: {
            serverId: server.serverId,
            originalName: tool.name,
            qualifiedName,
            description,
            inputSchema: modelProjection.schema,
            rawSchemaDigest: rawSchema.digest,
            modelProjectionDigest: modelProjection.digest,
            definitionDigest,
          },
          protocolTool: tool,
          serverDefinitionDigest: server.definitionDigest,
          serverDescription,
          rawSchema,
          modelProjection,
          validateInput,
          ...(validateOutput === undefined ? {} : { validateOutput }),
          ...(projected.compatibilityHint === undefined
            ? {}
            : { compatibilityHint: projected.compatibilityHint }),
        },
      ];
    } catch {
      return [];
    }
  });
}

const mcpSchemaLimits = {
  maximumBranches: 64,
  maximumBranchesPerCombinator: 16,
  maximumDefinitions: 64,
  maximumDepth: 32,
  maximumNodes: 1_024,
  maximumProperties: 256,
  maximumReferenceBytes: 512,
  maximumReferenceDepth: 16,
  maximumReferences: 128,
  maximumReferenceSegments: 32,
} as const;

function assertMcpSchemaAdmissible(root: McpJsonRecord): void {
  let branchCount = 0;
  let definitionCount = 0;
  let nodeCount = 0;
  let propertyCount = 0;
  let referenceCount = 0;
  const activeObjects = new Set<McpJsonRecord>();

  schemaDialect(root);

  const visit = (value: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > mcpSchemaLimits.maximumNodes || depth > mcpSchemaLimits.maximumDepth) {
      throw new TypeError("MCP schema traversal limit exceeded.");
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (activeObjects.has(value)) {
      throw new TypeError("MCP schema reference cycle detected.");
    }
    activeObjects.add(value);
    try {
      const properties = value.properties;
      if (isRecord(properties)) {
        propertyCount += Object.keys(properties).length;
        if (propertyCount > mcpSchemaLimits.maximumProperties) {
          throw new TypeError("MCP schema property limit exceeded.");
        }
      }
      for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
        const branches = value[keyword];
        if (Array.isArray(branches)) {
          branchCount += branches.length;
          if (
            branches.length > mcpSchemaLimits.maximumBranchesPerCombinator ||
            branchCount > mcpSchemaLimits.maximumBranches
          ) {
            throw new TypeError("MCP schema branch limit exceeded.");
          }
        }
      }
      for (const keyword of ["$defs", "definitions"] as const) {
        const definitions = value[keyword];
        if (isRecord(definitions)) {
          definitionCount += Object.keys(definitions).length;
          if (definitionCount > mcpSchemaLimits.maximumDefinitions) {
            throw new TypeError("MCP schema definition limit exceeded.");
          }
        }
      }
      if (
        value.$dynamicRef !== undefined ||
        value.$recursiveRef !== undefined ||
        value.$id !== undefined ||
        value.$anchor !== undefined ||
        value.$dynamicAnchor !== undefined
      ) {
        throw new TypeError("MCP schema dynamic or alternate reference scopes are unsupported.");
      }
      const reference = value.$ref;
      if (reference !== undefined) {
        referenceCount += 1;
        if (
          typeof reference !== "string" ||
          Buffer.byteLength(reference, "utf8") > mcpSchemaLimits.maximumReferenceBytes ||
          reference.slice(2).split("/").length > mcpSchemaLimits.maximumReferenceSegments ||
          referenceCount > mcpSchemaLimits.maximumReferences ||
          (!reference.startsWith("#/$defs/") && !reference.startsWith("#/definitions/"))
        ) {
          throw new TypeError("MCP schema reference is not a supported bounded local reference.");
        }
        resolveLocalSchemaReference(root, reference);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "$ref") {
          visit(child, depth + 1);
        }
      }
    } finally {
      activeObjects.delete(value);
    }
  };

  visit(root, 0);
  validateMcpReferenceGraph(root, root, 0, new Set([root]));
}

function validateMcpReferenceGraph(
  root: McpJsonRecord,
  value: unknown,
  referenceDepth: number,
  activeTargets: Set<McpJsonRecord>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateMcpReferenceGraph(root, item, referenceDepth, activeTargets);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const reference = value.$ref;
  if (typeof reference === "string") {
    if (referenceDepth >= mcpSchemaLimits.maximumReferenceDepth) {
      throw new TypeError("MCP schema reference depth limit exceeded.");
    }
    const target = resolveLocalSchemaReference(root, reference);
    if (!isRecord(target) || activeTargets.has(target)) {
      throw new TypeError("MCP schema reference cycle detected.");
    }
    activeTargets.add(target);
    try {
      validateMcpReferenceGraph(root, target, referenceDepth + 1, activeTargets);
    } finally {
      activeTargets.delete(target);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref") {
      validateMcpReferenceGraph(root, child, referenceDepth, activeTargets);
    }
  }
}

function resolveLocalSchemaReference(root: McpJsonRecord, reference: string): unknown {
  let current: unknown = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new TypeError("MCP schema local reference does not resolve.");
    }
    current = current[segment];
  }
  return current;
}

function projectMcpInputSchemaV1(schema: McpJsonRecord): {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly compatibilityHint?: string;
} {
  const allOf = schema.allOf;
  const rootChoice = (["anyOf", "oneOf"] as const).find(
    (keyword) => Array.isArray(schema[keyword]) && schema[keyword].length > 0,
  );
  if (Array.isArray(allOf) && allOf.length > 0 && rootChoice !== undefined) {
    throw new TypeError("MCP root schema cannot combine allOf with anyOf or oneOf.");
  }
  if (rootChoice !== undefined) {
    return projectMcpRootChoice(schema, rootChoice);
  }
  if (!Array.isArray(allOf) || allOf.length === 0) {
    return { schema };
  }
  const rootProperties = isRecord(schema.properties) ? schema.properties : {};
  const properties: Record<string, unknown> = { ...rootProperties };
  const required: string[] = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const seenRequired = new Set(required);
  for (const unresolvedBranch of allOf) {
    const branch = resolveMcpProjectionBranch(schema, unresolvedBranch);
    if (!isRecord(branch) || (branch.type !== undefined && branch.type !== "object")) {
      throw new TypeError("MCP root allOf branches must be object schemas.");
    }
    const branchProperties = branch.properties;
    if (branchProperties !== undefined && !isRecord(branchProperties)) {
      throw new TypeError("MCP root allOf properties must be an object.");
    }
    for (const [name, value] of Object.entries(branchProperties ?? {})) {
      properties[name] ??= value;
    }
    const branchRequired = branch.required;
    if (
      branchRequired !== undefined &&
      (!Array.isArray(branchRequired) || branchRequired.some((entry) => typeof entry !== "string"))
    ) {
      throw new TypeError("MCP root allOf required keys must be strings.");
    }
    for (const name of (branchRequired ?? []) as readonly string[]) {
      if (!seenRequired.has(name)) {
        seenRequired.add(name);
        required.push(name);
      }
    }
  }
  const { allOf: _allOf, properties: _properties, required: _required, ...rest } = schema;
  return {
    schema: {
      ...rest,
      type: "object",
      ...(Object.keys(properties).length === 0 ? {} : { properties }),
      ...(required.length === 0 ? {} : { required }),
    },
  };
}

function projectMcpRootChoice(
  schema: McpJsonRecord,
  keyword: "anyOf" | "oneOf",
): { readonly schema: Readonly<Record<string, unknown>>; readonly compatibilityHint: string } {
  const branches = schema[keyword];
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new TypeError("MCP root choice requires branches.");
  }
  const properties: Record<string, unknown> = isRecord(schema.properties)
    ? { ...schema.properties }
    : {};
  const rootPropertyNames = new Set(Object.keys(properties));
  const rootRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const branchRequirements: string[][] = [];
  const branchPropertySets: Readonly<Record<string, unknown>>[] = [];
  for (const unresolvedBranch of branches) {
    const branch = resolveMcpProjectionBranch(schema, unresolvedBranch);
    if (!isRecord(branch) || (branch.type !== undefined && branch.type !== "object")) {
      throw new TypeError("MCP root choice branches must be object schemas.");
    }
    const branchProperties = branch.properties;
    if (branchProperties !== undefined && !isRecord(branchProperties)) {
      throw new TypeError("MCP root choice properties must be an object.");
    }
    branchPropertySets.push(branchProperties ?? {});
    const branchRequired = branch.required;
    if (
      branchRequired !== undefined &&
      (!Array.isArray(branchRequired) || branchRequired.some((entry) => typeof entry !== "string"))
    ) {
      throw new TypeError("MCP root choice required keys must be strings.");
    }
    branchRequirements.push([...(branchRequired ?? [])] as string[]);
  }
  for (const branchProperties of branchPropertySets) {
    for (const [name, value] of Object.entries(branchProperties)) {
      if (rootPropertyNames.has(name) || Object.hasOwn(properties, name)) {
        continue;
      }
      const candidates = branchPropertySets.map((candidate) => candidate[name]);
      properties[name] = candidates.every(
        (candidate) =>
          candidate !== undefined && canonicalMcpJson(candidate) === canonicalMcpJson(value),
      )
        ? value
        : {};
    }
  }
  const requiredIntersection =
    branchRequirements[0]?.filter((name) =>
      branchRequirements.slice(1).every((required) => required.includes(name)),
    ) ?? [];
  const required = [...new Set([...rootRequired, ...requiredIntersection])];
  const { [keyword]: _choice, properties: _properties, required: _required, ...rest } = schema;
  const compatibilityHint = truncateUtf8(
    `Compatibility hint: ${keyword} branches require ${branchRequirements
      .map((names) => `[${names.join(", ")}]`)
      .join(" or ")}.`,
    1_024,
  );
  return {
    schema: {
      ...rest,
      type: "object",
      ...(Object.keys(properties).length === 0 ? {} : { properties }),
      ...(required.length === 0 ? {} : { required }),
    },
    compatibilityHint,
  };
}

function resolveMcpProjectionBranch(root: McpJsonRecord, branch: unknown): McpJsonRecord {
  let current = branch;
  const seen = new Set<McpJsonRecord>();
  for (let depth = 0; depth <= mcpSchemaLimits.maximumReferenceDepth; depth += 1) {
    if (!isRecord(current)) {
      throw new TypeError("MCP root combinator branches must be object schemas.");
    }
    const reference = current.$ref;
    if (reference === undefined) {
      return current;
    }
    if (typeof reference !== "string" || Object.keys(current).some((key) => key !== "$ref")) {
      throw new TypeError("MCP projected references cannot have sibling keywords.");
    }
    if (depth === mcpSchemaLimits.maximumReferenceDepth || seen.has(current)) {
      throw new TypeError("MCP projected reference depth or cycle limit exceeded.");
    }
    seen.add(current);
    current = resolveLocalSchemaReference(root, reference);
  }
  throw new TypeError("MCP projected reference depth limit exceeded.");
}

async function listAllTools(
  client: Client,
  serverId: string,
  signal: AbortSignal,
): Promise<{ readonly tools: readonly Tool[] }> {
  const tools: Tool[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let aggregateDefinitionBytes = 0;
  let cursor: string | undefined;
  for (
    let pageNumber = 1;
    pageNumber <= mcpEffectiveBoundsV1.maximumCatalogPages;
    pageNumber += 1
  ) {
    const page = await client.request(
      {
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      },
      {
        signal,
        timeout: mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
        maxTotalTimeout: mcpEffectiveBoundsV1.initializeAndDiscoveryMilliseconds,
      },
    );
    for (const tool of page.tools) {
      const definitionBytes = Buffer.byteLength(canonicalMcpJson(tool), "utf8");
      aggregateDefinitionBytes += definitionBytes;
      if (seenNames.has(tool.name)) {
        throw new McpHostError("mcp_catalog_invalid", { serverId });
      }
      if (
        tools.length >= mcpEffectiveBoundsV1.maximumCatalogTools ||
        definitionBytes > mcpEffectiveBoundsV1.maximumToolDefinitionBytes ||
        aggregateDefinitionBytes > mcpEffectiveBoundsV1.maximumCatalogDefinitionBytes
      ) {
        throw new McpHostError("mcp_catalog_too_large", { serverId });
      }
      seenNames.add(tool.name);
      tools.push(tool);
    }
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      return { tools };
    }
    if (Buffer.byteLength(nextCursor, "utf8") > mcpEffectiveBoundsV1.maximumCatalogCursorBytes) {
      throw new McpHostError("mcp_catalog_too_large", { serverId });
    }
    if (seenCursors.has(nextCursor)) {
      throw new McpHostError("mcp_catalog_invalid", { serverId });
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new McpHostError("mcp_catalog_too_large", { serverId });
}

function qualifiedToolName(server: McpServerPreview, originalName: string): string {
  const suffix = createHash("sha256")
    .update(server.definitionDigest)
    .update("\0")
    .update(originalName)
    .digest("hex")
    .slice(0, 12);
  return `mcp__${toolSlug(server.serverId, 16)}__${toolSlug(originalName, 20)}__${suffix}`;
}

function normalizeMcpServerDescription(description: string): string {
  return truncateUtf8(
    description
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    4 * 1024,
  );
}

function mcpModelDescription(
  serverId: string,
  effect: ToolEffect | undefined,
  serverDescription: string,
  compatibilityHint?: string,
): string {
  const prefix = `External MCP tool from approved server ${JSON.stringify(serverId)}. ${
    effect === undefined ? "Effect is not yet assigned." : `Adam effect: ${effect}.`
  }`;
  return truncateUtf8(
    `${prefix}${compatibilityHint === undefined ? "" : ` ${compatibilityHint}`}${
      serverDescription.length === 0 ? "" : ` ${serverDescription}`
    }`,
    2 * 1024,
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function toolSlug(value: string, maximumBytes: number): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return (slug.length === 0 ? "tool" : slug).slice(0, maximumBytes);
}

export type McpTransportLaunch = {
  readonly path: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly identityDigest: Sha256Digest;
};

type ResolvedStdioLaunch = McpTransportLaunch;

class AdamStdioTransport implements McpClientTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #launch: ResolvedStdioLaunch;
  readonly #generationSignal: AbortSignal;
  readonly #onUnexpectedClose: () => void;
  readonly #readBuffer = new ReadBuffer({
    maxBufferSize: mcpEffectiveBoundsV1.maximumFrameBytes,
  });
  #child?: ChildProcessWithoutNullStreams;
  #childClosed?: Promise<void>;
  #closeEmitted = false;
  #closePromise?: Promise<void>;
  #fatalError?: Error;
  #failureKind?: "protocol_error";
  #frameBytes = 0;
  #frameChunks: Buffer[] = [];
  #startPromise?: Promise<void>;
  #state: "new" | "starting" | "started" | "closing" | "closed" = "new";
  #spawnConfirmed = false;
  #temporaryRoot?: string;

  constructor(
    launch: ResolvedStdioLaunch,
    generationSignal: AbortSignal,
    onUnexpectedClose: () => void,
  ) {
    this.#launch = launch;
    this.#generationSignal = generationSignal;
    this.#onUnexpectedClose = onUnexpectedClose;
  }

  get launchIdentityDigest(): Sha256Digest {
    return this.#launch.identityDigest;
  }

  get failureKind(): "protocol_error" | undefined {
    return this.#failureKind;
  }

  get spawnConfirmed(): boolean {
    return this.#spawnConfirmed;
  }

  get isUsable(): boolean {
    return this.#state === "started" && this.#fatalError === undefined;
  }

  start(): Promise<void> {
    if (this.#state !== "new") {
      throw new Error("MCP stdio transport is already started.");
    }
    this.#state = "starting";
    this.#startPromise = this.#startOnce();
    return this.#startPromise;
  }

  async #startOnce(): Promise<void> {
    this.#generationSignal.throwIfAborted();
    this.#temporaryRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-"));
    if (this.#state !== "starting") {
      throw new Error("MCP stdio transport closed before process start.");
    }
    this.#generationSignal.throwIfAborted();
    const child = spawn(this.#launch.path, this.#launch.arguments, {
      cwd: this.#launch.cwd,
      detached: true,
      env: {
        HOME: this.#temporaryRoot,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: `${dirname(process.execPath)}:${dirname(
          this.#launch.path,
        )}:/usr/local/bin:/usr/bin:/bin`,
        TERM: "dumb",
        TMPDIR: this.#temporaryRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#childClosed = new Promise<void>((resolve) => {
      child.once("close", () => {
        const unexpected = this.#state !== "closing" && this.#state !== "closed";
        if (
          this.#frameBytes > 0 &&
          this.#fatalError === undefined &&
          this.#state !== "closing" &&
          this.#state !== "closed"
        ) {
          this.#fatal(new Error("MCP stdio closed with an incomplete frame."), "protocol_error");
        }
        this.#readBuffer.clear();
        this.#frameBytes = 0;
        this.#frameChunks = [];
        resolve();
        this.#emitClose();
        if (unexpected) {
          this.#onUnexpectedClose();
        }
      });
    });
    child.on("error", (error) => this.#fatal(error));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.#acceptStdoutChunk(chunk);
      } catch (error) {
        this.#fatal(asError(error), "protocol_error");
      }
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (!Number.isSafeInteger(stderrBytes)) {
        stderrBytes = Number.MAX_SAFE_INTEGER;
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        this.#spawnConfirmed = true;
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    if (this.#state === "starting") {
      this.#state = "started";
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (this.#state !== "started" || child === undefined || child.stdin.destroyed) {
      throw new Error("MCP stdio transport is not connected.");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          this.#fatal(error);
          reject(error);
        }
      });
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    this.#state = "closing";
    this.#closePromise = this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    const deadline = Date.now() + mcpEffectiveBoundsV1.shutdownMilliseconds;
    try {
      await this.#startPromise?.catch(() => undefined);
      const child = this.#child;
      const childClosed = this.#childClosed;
      if (child !== undefined && childClosed !== undefined) {
        child.stdin.end();
        const processGroupId = child.pid;
        if (processGroupId !== undefined) {
          signalProcessGroup(processGroupId, "SIGTERM");
        }
        const termBudget = Math.min(1_000, remainingMilliseconds(deadline));
        if (termBudget > 0) {
          await closesBeforeGuard(childClosed, termBudget);
        }
        if (processGroupId !== undefined && processGroupExists(processGroupId)) {
          signalProcessGroup(processGroupId, "SIGKILL");
        }
        const killBudget = remainingMilliseconds(deadline);
        if (!(await closesBeforeGuard(childClosed, killBudget))) {
          throw new Error("MCP stdio process shutdown was not confirmed.");
        }
        if (
          processGroupId !== undefined &&
          !(await processGroupExitsBeforeGuard(processGroupId, deadline))
        ) {
          throw new Error("MCP stdio process-group shutdown was not confirmed.");
        }
      }
    } finally {
      if (this.#temporaryRoot !== undefined) {
        await rm(this.#temporaryRoot, { recursive: true, force: true });
      }
      this.#state = "closed";
      this.#emitClose();
    }
  }

  #fatal(error: Error, failureKind?: "protocol_error"): void {
    if (this.#fatalError !== undefined || this.#state === "closing" || this.#state === "closed") {
      return;
    }
    this.#fatalError = error;
    if (failureKind !== undefined) {
      this.#failureKind = failureKind;
    }
    this.#readBuffer.clear();
    this.#frameBytes = 0;
    this.#frameChunks = [];
    this.#child?.stdout.pause();
    this.onerror?.(error);
    void this.close().catch(() => undefined);
  }

  #acceptStdoutChunk(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline + 1;
      const segment = chunk.subarray(offset, end);
      if (this.#frameBytes + segment.byteLength > mcpEffectiveBoundsV1.maximumFrameBytes) {
        throw new Error("MCP stdio frame exceeded the 64 MiB transport limit.");
      }
      this.#frameChunks.push(segment);
      this.#frameBytes += segment.byteLength;
      if (newline < 0) {
        return;
      }

      const frame =
        this.#frameChunks.length === 1
          ? (this.#frameChunks[0] as Buffer)
          : Buffer.concat(this.#frameChunks, this.#frameBytes);
      let lineEnd = frame.byteLength - 1;
      if (lineEnd > 0 && frame[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      const lineBytes = frame.subarray(0, lineEnd);
      if (!isUtf8(lineBytes)) {
        throw new Error("MCP stdio frame was not valid UTF-8.");
      }
      JSON.parse(lineBytes.toString("utf8"));
      this.#readBuffer.append(frame);
      const message = this.#readBuffer.readMessage();
      if (message === null) {
        throw new Error("MCP stdio parser did not produce one complete frame.");
      }
      this.#readBuffer.clear();
      this.#frameBytes = 0;
      this.#frameChunks = [];
      this.onmessage?.(message);
      offset = end;
    }
  }

  #emitClose(): void {
    if (this.#closeEmitted) {
      return;
    }
    this.#closeEmitted = true;
    this.onclose?.();
  }
}

const stdioMcpTransportFactory: McpTransportFactory = {
  create(input) {
    return new AdamStdioTransport(input.launch, input.generationSignal, input.onUnexpectedClose);
  },
};

async function closesBeforeGuard(closed: Promise<void>, milliseconds: number): Promise<boolean> {
  if (milliseconds <= 0) {
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function closeMcpProcessGroupCausally(
  processGroupId: number,
  childSettled: Promise<void>,
): Promise<void> {
  const deadline = Date.now() + mcpEffectiveBoundsV1.shutdownMilliseconds;
  const termDeadline = Math.min(deadline, Date.now() + 1_000);
  if (!(await processGroupExitsBeforeGuard(processGroupId, termDeadline))) {
    signalProcessGroup(processGroupId, "SIGKILL");
  }
  if (!(await closesBeforeGuard(childSettled, remainingMilliseconds(deadline)))) {
    throw new Error("MCP process shutdown was not confirmed before the deadline.");
  }
  if (!(await processGroupExitsBeforeGuard(processGroupId, deadline))) {
    throw new Error("MCP process-group shutdown was not confirmed before the deadline.");
  }
}

async function processGroupExitsBeforeGuard(
  processGroupId: number,
  deadline: number,
): Promise<boolean> {
  while (processGroupExists(processGroupId)) {
    const remaining = remainingMilliseconds(deadline);
    if (remaining <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(10, remaining));
    });
  }
  return true;
}

async function createExecutableServerPreview(input: {
  readonly canonicalWorkspaceRoot: string;
  readonly serverId: string;
  readonly value: unknown;
}): Promise<McpServerConfigurationInspection> {
  if (!isRecord(input.value)) {
    throw new TypeError("MCP server configuration must be an object.");
  }
  const type = input.value.type;
  const command = input.value.command;
  const args = input.value.args ?? [];
  const configuredCwd = input.value.cwd ?? ".";
  const env = input.value.env ?? {};
  if (
    (type !== undefined && type !== "stdio") ||
    typeof command !== "string" ||
    command.length === 0 ||
    (!isAbsolute(command) && (command.includes("/") || command === "." || command === "..")) ||
    typeof configuredCwd !== "string" ||
    configuredCwd.length === 0 ||
    isAbsolute(configuredCwd) ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string") ||
    !isStringRecord(env)
  ) {
    throw new TypeError("MCP server configuration is not a supported stdio entry.");
  }
  const requestedEnvironmentNames = Object.keys(env).sort();
  const resolvedCommand = await resolveMcpExecutable(command);
  const resolvedCwd = await realpath(resolve(input.canonicalWorkspaceRoot, configuredCwd));
  const relativeCwd = relative(input.canonicalWorkspaceRoot, resolvedCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
    throw new TypeError("MCP server cwd must remain inside the canonical project.");
  }
  if (["npx", "npx-cli.js"].includes(basename(resolvedCommand))) {
    const packageCommand = parseExactNpxCommand(args as readonly string[]);
    if (packageCommand === undefined) {
      return {
        diagnostic: { code: "mcp_package_pin_required", serverId: input.serverId },
      };
    }
    const definition = {
      canonicalizerVersion: 1,
      serverId: input.serverId,
      transport: "stdio",
      command: {
        kind: "npm_package",
        packageName: packageCommand.packageName,
        version: packageCommand.version,
        binPolicy: "npm-default-v1",
      },
      arguments: packageCommand.serverArguments,
      cwd: resolvedCwd,
      requestedEnvironmentNames,
      startupEffects: ["execute", "network"],
      limits: mcpEffectiveBoundsV1,
      bootstrap: {
        contractVersion: 1,
        timeoutMs: mcpEffectiveBoundsV1.packageBootstrapMilliseconds,
        lifecycleScripts: "disabled",
      },
    } as const;
    return {
      server: {
        serverId: input.serverId,
        status: requestedEnvironmentNames.length === 0 ? "approval_required" : "unsupported",
        transport: "stdio",
        command: definition.command,
        arguments: [...packageCommand.serverArguments],
        cwd: resolvedCwd,
        requestedEnvironmentNames,
        startupEffects: ["execute", "network"],
        limits: mcpEffectiveBoundsV1,
        definitionDigest: digestCanonicalMcpJson(definition),
      },
    };
  }
  if (
    new Set([
      "bunx",
      "npm",
      "npm-cli.js",
      "pnpm",
      "pnpm.cjs",
      "pnpx",
      "uvx",
      "yarn",
      "yarn.js",
    ]).has(basename(resolvedCommand))
  ) {
    return {
      diagnostic: { code: "mcp_package_pin_required", serverId: input.serverId },
    };
  }
  const definition = {
    canonicalizerVersion: 1,
    serverId: input.serverId,
    transport: "stdio",
    command: {
      kind: "executable",
      path: resolvedCommand,
      identity: await inspectMcpExecutableIdentity(resolvedCommand),
    },
    arguments: args,
    cwd: resolvedCwd,
    requestedEnvironmentNames,
    startupEffects: ["execute"],
    limits: mcpEffectiveBoundsV1,
  } as const;
  return {
    server: {
      serverId: input.serverId,
      status: requestedEnvironmentNames.length === 0 ? "approval_required" : "unsupported",
      transport: "stdio",
      command: definition.command,
      arguments: args as string[],
      cwd: resolvedCwd,
      requestedEnvironmentNames,
      startupEffects: ["execute"],
      limits: mcpEffectiveBoundsV1,
      definitionDigest: digestCanonicalMcpJson(definition),
    },
  };
}

function parseExactNpxCommand(args: readonly string[]):
  | {
      readonly packageName: string;
      readonly version: string;
      readonly serverArguments: readonly string[];
    }
  | undefined {
  if (args[0] !== "-y" || args[1] === undefined) {
    return undefined;
  }
  const packageSpec = args[1];
  const separator = packageSpec.lastIndexOf("@");
  const packageName = packageSpec.slice(0, separator);
  const version = packageSpec.slice(separator + 1);
  if (
    separator <= 0 ||
    packageName.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(packageName) ||
    validSemver(version) !== version
  ) {
    return undefined;
  }
  return { packageName, version, serverArguments: args.slice(2) };
}

async function resolveMcpExecutable(command: string): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : [...new Set([dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])].map(
        (directory) => join(directory, command),
      );
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (
        isNodeError(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new TypeError("MCP command is not available on the controlled executable path.");
}

async function readBoundedUtf8File(
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new TypeError("The MCP bootstrap file exceeded its bounded limit.");
    }
    const buffer = Buffer.alloc(Math.min(maximumBytes + 1, before.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    signal.throwIfAborted();
    if (bytesRead > maximumBytes || !isUtf8(buffer.subarray(0, bytesRead))) {
      throw new TypeError("The MCP bootstrap file was not bounded UTF-8.");
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new TypeError("The MCP bootstrap file changed while it was inspected.");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function hashBoundedFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Sha256Digest> {
  signal.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw new TypeError("The MCP executable exceeded its bounded identity limit.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > maximumBytes) {
        throw new TypeError("The MCP executable exceeded its bounded identity limit.");
      }
    }
    const after = await handle.stat({ bigint: true });
    if (!sameMcpExecutableStat(before, after)) {
      throw new TypeError("The MCP executable changed while it was inspected.");
    }
    return `sha256:${digest.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function inspectMcpExecutableIdentity(
  path: string,
): Promise<Extract<McpServerPreview["command"], { readonly kind: "executable" }>["identity"]> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(mcpEffectiveBoundsV1.maximumExecutableBytes)) {
      throw new TypeError("MCP command must resolve to a bounded regular executable file.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!sameMcpExecutableStat(before, after) || !sameMcpExecutableStat(after, current)) {
      throw new TypeError("The MCP executable changed while its identity was inspected.");
    }
    await access(path, constants.X_OK);
    return {
      version: 1,
      contentDigest: `sha256:${digest.digest("hex")}`,
      size: Number(after.size),
      mode: Number(after.mode & 0o7777n),
    };
  } finally {
    await handle.close();
  }
}

function sameMcpExecutableStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      return false;
    }
    nodes += 1;
    if (nodes > 4_096 || current.depth > 64) {
      return false;
    }
    const candidate = current.value;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(candidate)) {
      return false;
    }
    for (const item of Object.values(candidate)) {
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function schemaDialect(
  schema: McpJsonRecord,
): McpToolProfileV1["tools"][number]["rawSchema"]["dialect"] {
  const declared = schema.$schema;
  if (declared === undefined) {
    return "unstamped";
  }
  if (typeof declared !== "string") {
    throw new TypeError("MCP schema dialect declaration must be a string.");
  }
  const normalized = declared.replace(/#$/u, "");
  if (
    normalized === "https://json-schema.org/draft/2020-12/schema" ||
    normalized === "http://json-schema.org/draft/2020-12/schema"
  ) {
    return "2020-12";
  }
  if (
    normalized === "https://json-schema.org/draft/2019-09/schema" ||
    normalized === "http://json-schema.org/draft/2019-09/schema"
  ) {
    return "2019-09";
  }
  if (
    normalized === "http://json-schema.org/draft-07/schema" ||
    normalized === "https://json-schema.org/draft-07/schema"
  ) {
    return "draft-07";
  }
  if (
    normalized === "http://json-schema.org/draft-06/schema" ||
    normalized === "https://json-schema.org/draft-06/schema"
  ) {
    return "draft-06";
  }
  throw new TypeError("MCP schema dialect is unsupported.");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("MCP transport failed.");
}

function isRecord(value: unknown): value is McpJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
