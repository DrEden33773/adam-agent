import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  createUserModelPolicyResolver,
  type UserModelPolicyField,
  type UserModelPolicyResolver,
  type UserModelPolicySnapshot,
} from "./user-model-policy.js";

export type {
  UserModelPolicyField,
  UserModelPolicyResolver,
  UserModelPolicySnapshot,
} from "./user-model-policy.js";

const maximumConfigurationBytes = 8 * 1024;
const maximumWorkspaceTrustBytes = 128 * 1024;
const maximumTrustedProjectIds = 1_024;

export type PresentationPreferencesDiagnostic = {
  readonly code: "target_configuration_invalid" | "target_configuration_unsafe";
  readonly message: string;
};

export type PresentationPreferencesSnapshot = {
  readonly defaultTargetId: string | null;
  readonly modelPolicy: UserModelPolicySnapshot;
  readonly diagnostic: PresentationPreferencesDiagnostic | null;
};

export type PresentationPreferences = {
  load(): Promise<PresentationPreferencesSnapshot>;
  setDefaultTarget(targetId: string | null): Promise<void>;
  setModelPolicy(input: {
    readonly field: UserModelPolicyField;
    readonly value: number | null;
  }): Promise<void>;
} & UserModelPolicyResolver;

type LoadedPresentationPreferences = PresentationPreferencesSnapshot;

type UserConfigurationRead =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "unsafe" };

export type UserConfigurationStorage = {
  read(): Promise<UserConfigurationRead>;
  write(text: string): Promise<void>;
};

type OwnerConfigurationStorage = UserConfigurationStorage & {
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
};

export type WorkspaceTrustMcpLease = {
  release(): Promise<void>;
};

export class WorkspaceTrustMcpLeaseError extends Error {
  readonly code = "project_in_use";

  constructor() {
    super("Another Adam MCP runtime owns this canonical project.");
    this.name = "WorkspaceTrustMcpLeaseError";
  }
}

export type WorkspaceTrustDiagnostic = {
  readonly code:
    | "workspace_trust_invalid"
    | "workspace_trust_unsafe"
    | "workspace_trust_unavailable";
  readonly message: string;
};

export type WorkspaceTrustSnapshot = {
  readonly projectId: `sha256:${string}` | null;
  readonly projectLabel: string;
  readonly status: "trusted" | "untrusted" | "unavailable";
  readonly diagnostic: WorkspaceTrustDiagnostic | null;
};

export type WorkspaceTrustController = {
  acquireMcpLease(): Promise<WorkspaceTrustMcpLease>;
  load(): Promise<WorkspaceTrustSnapshot>;
  setTrusted(input: {
    readonly projectId: string;
    readonly trusted: boolean;
  }): Promise<WorkspaceTrustSnapshot>;
};

export function createPresentationPreferences(options: {
  readonly environment: NodeJS.ProcessEnv;
}): PresentationPreferences {
  const { XDG_CONFIG_HOME: configuredRoot } = options.environment;
  const root =
    configuredRoot === undefined || configuredRoot.length === 0
      ? join(homedir(), ".config")
      : configuredRoot;
  const directoryPath = join(root, "adam-agent");
  const configurationPath = join(directoryPath, "config.json");
  return createPresentationPreferencesFromStorage(
    createOwnerConfigurationFileStorage({
      configurationPath,
      directoryPath,
      maximumBytes: maximumConfigurationBytes,
      temporaryPrefix: ".config",
    }),
  );
}

export function createWorkspaceTrust(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
}): WorkspaceTrustController {
  const { XDG_CONFIG_HOME: configuredRoot } = options.environment;
  const root =
    configuredRoot === undefined || configuredRoot.length === 0
      ? join(homedir(), ".config")
      : configuredRoot;
  const directoryPath = join(root, "adam-agent");
  return createWorkspaceTrustFromStorage({
    workspaceRoot: options.workspaceRoot,
    storage: createOwnerConfigurationFileStorage({
      configurationPath: join(directoryPath, "workspace-trust.json"),
      directoryPath,
      maximumBytes: maximumWorkspaceTrustBytes,
      mutationLockName: ".workspace-trust.lock",
      temporaryPrefix: ".workspace-trust",
    }),
    async acquireMcpLock() {
      const identity = await resolveCanonicalWorkspaceIdentity(options.workspaceRoot);
      return acquireOwnerConfigurationLock(
        directoryPath,
        `.workspace-mcp-${identity.projectId.slice("sha256:".length)}.lock`,
        true,
      );
    },
  });
}

/** Tests only through the internal-testing entry; production uses the owner-only file Adapter. */
export function createPresentationPreferencesWithStorageForTesting(
  storage: UserConfigurationStorage,
): PresentationPreferences {
  return createPresentationPreferencesFromStorage(storage);
}

/** Tests only through the internal-testing entry; production uses the owner-only file Adapter. */
export function createWorkspaceTrustWithStorageForTesting(options: {
  readonly workspaceRoot: string;
  readonly storage: UserConfigurationStorage;
}): WorkspaceTrustController {
  return createWorkspaceTrustFromStorage(options);
}

/** Keeps established behavior tests focused on their original contract. */
export function createTrustedWorkspaceTrustForTesting(
  workspaceRoot: string,
): WorkspaceTrustController {
  let text: string | null = null;
  return createWorkspaceTrustFromStorage({
    workspaceRoot,
    storage: {
      async read() {
        if (text === null) {
          const identity = await resolveCanonicalWorkspaceIdentity(workspaceRoot);
          text = serializeWorkspaceTrust([identity.projectId]);
        }
        return { status: "available", text };
      },
      async write(nextText) {
        text = nextText;
      },
    },
  });
}

function createWorkspaceTrustFromStorage(options: {
  readonly workspaceRoot: string;
  readonly storage: OwnerConfigurationStorage;
  readonly acquireMcpLock?: () => Promise<WorkspaceTrustMcpLease>;
}): WorkspaceTrustController {
  let activeMcpLease: WorkspaceTrustMcpLease | undefined;
  let mcpLeaseAcquisition: Promise<WorkspaceTrustMcpLease> | undefined;
  const resolveIdentity = () => resolveCanonicalWorkspaceIdentity(options.workspaceRoot);
  const unavailable = (): WorkspaceTrustSnapshot => ({
    projectId: null,
    projectLabel: basename(options.workspaceRoot) || "project",
    status: "unavailable",
    diagnostic: {
      code: "workspace_trust_unavailable",
      message: "The canonical workspace identity is unavailable.",
    },
  });
  const loadDocument = async (): Promise<
    | { readonly status: "valid"; readonly trustedProjectIds: readonly `sha256:${string}`[] }
    | { readonly status: "missing" }
    | { readonly status: "invalid" }
    | { readonly status: "unsafe" }
  > => {
    const stored = await options.storage.read().catch(() => ({ status: "unsafe" as const }));
    if (stored.status !== "available") {
      return { status: stored.status };
    }
    return parseWorkspaceTrust(stored.text);
  };
  const load = async (): Promise<WorkspaceTrustSnapshot> => {
    const identity = await resolveIdentity().catch(() => undefined);
    if (identity === undefined) {
      return unavailable();
    }
    const document = await loadDocument();
    if (document.status === "missing") {
      return { ...identity, status: "untrusted", diagnostic: null };
    }
    if (document.status === "invalid") {
      return {
        ...identity,
        status: "untrusted",
        diagnostic: {
          code: "workspace_trust_invalid",
          message: "The saved workspace trust configuration is invalid.",
        },
      };
    }
    if (document.status === "unsafe") {
      return {
        ...identity,
        status: "untrusted",
        diagnostic: {
          code: "workspace_trust_unsafe",
          message: "The saved workspace trust configuration is not an owner-only ordinary file.",
        },
      };
    }
    return {
      ...identity,
      status: document.trustedProjectIds.includes(identity.projectId) ? "trusted" : "untrusted",
      diagnostic: null,
    };
  };
  return {
    async acquireMcpLease() {
      if (activeMcpLease !== undefined || mcpLeaseAcquisition !== undefined) {
        throw new TypeError("This workspace trust controller already owns the MCP trust lease.");
      }
      mcpLeaseAcquisition = options.acquireMcpLock?.() ?? Promise.resolve({ async release() {} });
      let owned: WorkspaceTrustMcpLease;
      try {
        owned = await mcpLeaseAcquisition;
        activeMcpLease = owned;
      } finally {
        mcpLeaseAcquisition = undefined;
      }
      let releasePromise: Promise<void> | undefined;
      return {
        release() {
          releasePromise ??= owned.release().then(() => {
            if (activeMcpLease === owned) {
              activeMcpLease = undefined;
            }
          });
          return releasePromise;
        },
      };
    },
    load,
    async setTrusted(input) {
      const mutate = async () => {
        const identity = await resolveIdentity().catch(() => undefined);
        if (identity === undefined || input.projectId !== identity.projectId) {
          throw new TypeError("The workspace trust command targets a stale project identity.");
        }
        const document = await loadDocument();
        if (document.status === "invalid" || document.status === "unsafe") {
          throw new TypeError("The saved workspace trust configuration requires manual repair.");
        }
        const trustedProjectIds = new Set(
          document.status === "valid" ? document.trustedProjectIds : [],
        );
        if (input.trusted) {
          trustedProjectIds.add(identity.projectId);
        } else {
          trustedProjectIds.delete(identity.projectId);
        }
        const sorted = [...trustedProjectIds].sort();
        if (sorted.length > maximumTrustedProjectIds) {
          throw new TypeError("The workspace trust configuration is full.");
        }
        await options.storage.write(serializeWorkspaceTrust(sorted));
        return {
          ...identity,
          status: input.trusted ? ("trusted" as const) : ("untrusted" as const),
          diagnostic: null,
        };
      };
      const mutateDocument = () =>
        options.storage.runExclusive === undefined
          ? mutate()
          : options.storage.runExclusive(mutate);
      if (activeMcpLease !== undefined) {
        throw new WorkspaceTrustMcpLeaseError();
      }
      if (options.acquireMcpLock === undefined) {
        return mutateDocument();
      }
      const temporaryMcpLease = await options.acquireMcpLock();
      try {
        return await mutateDocument();
      } finally {
        await temporaryMcpLease.release();
      }
    },
  };
}

function createPresentationPreferencesFromStorage(
  storage: UserConfigurationStorage,
): PresentationPreferences {
  let lastValidSnapshot = emptySnapshot();

  const readConfiguration = async (): Promise<LoadedPresentationPreferences> => {
    const stored = await storage.read().catch(() => ({ status: "unsafe" as const }));
    if (stored.status === "missing") {
      return emptySnapshot();
    }
    if (stored.status === "unsafe") {
      return unsafeSnapshot();
    }
    return parseConfiguration(stored.text);
  };
  const loadConfiguration = async (): Promise<LoadedPresentationPreferences> => {
    const loaded = await readConfiguration();
    if (loaded.diagnostic === null) {
      lastValidSnapshot = loaded;
      return loaded;
    }
    return {
      defaultTargetId: lastValidSnapshot.defaultTargetId,
      modelPolicy: lastValidSnapshot.modelPolicy,
      diagnostic: loaded.diagnostic,
    };
  };
  const writeConfiguration = async (snapshot: LoadedPresentationPreferences): Promise<void> => {
    if (snapshot.diagnostic !== null) {
      throw new TypeError("A diagnosed user configuration cannot be persisted.");
    }
    await storage.write(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: snapshot.defaultTargetId,
        modelPolicy: snapshot.modelPolicy,
      })}\n`,
    );
    lastValidSnapshot = snapshot;
  };
  const modelPolicy = createUserModelPolicyResolver({
    async load() {
      const loaded = await loadConfiguration();
      if (loaded.diagnostic !== null) {
        throw new TypeError(loaded.diagnostic.message);
      }
      return loaded.modelPolicy;
    },
  });

  return {
    async load() {
      return loadConfiguration();
    },
    async resolveContextProfile(profile) {
      return modelPolicy.resolveContextProfile(profile);
    },
    async setModelPolicy(input) {
      if (!isUserModelPolicyField(input.field) || !isNullablePositiveSafeInteger(input.value)) {
        throw new TypeError("The model policy value is invalid.");
      }
      const loaded = await loadConfiguration();
      if (loaded.diagnostic !== null) {
        throw new TypeError(loaded.diagnostic.message);
      }
      await writeConfiguration({
        defaultTargetId: loaded.defaultTargetId,
        modelPolicy: { ...loaded.modelPolicy, [input.field]: input.value },
        diagnostic: null,
      });
    },
    async setDefaultTarget(targetId) {
      if (!isNullableDefaultTarget(targetId)) {
        throw new TypeError("The exact default target ID is invalid.");
      }
      const loaded = await loadConfiguration();
      if (loaded.diagnostic !== null) {
        throw new TypeError(loaded.diagnostic.message);
      }
      await writeConfiguration({
        defaultTargetId: targetId,
        modelPolicy: loaded.modelPolicy,
        diagnostic: null,
      });
    },
  };
}

function createOwnerConfigurationFileStorage(options: {
  readonly configurationPath: string;
  readonly directoryPath: string;
  readonly maximumBytes: number;
  readonly mutationLockName?: string;
  readonly temporaryPrefix: string;
}): OwnerConfigurationStorage {
  return {
    ...(options.mutationLockName === undefined
      ? {}
      : {
          async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
            const lease = await acquireOwnerConfigurationLock(
              options.directoryPath,
              options.mutationLockName as string,
              false,
            );
            try {
              return await operation();
            } finally {
              await lease.release();
            }
          },
        }),
    async read() {
      const directory = await openOwnerDirectory(options.directoryPath).catch(() => undefined);
      if (directory === undefined) {
        return { status: "unsafe" };
      }
      if (directory === null) {
        return { status: "missing" };
      }
      try {
        const file = await openOwnerFile(options.configurationPath).catch(() => undefined);
        if (file === undefined) {
          return { status: "unsafe" };
        }
        if (file === null) {
          return { status: "missing" };
        }
        try {
          const stats = await file.stat();
          if (
            !stats.isFile() ||
            !Number.isSafeInteger(stats.size) ||
            stats.size <= 0 ||
            stats.size > options.maximumBytes ||
            stats.uid !== currentEffectiveUserId() ||
            (stats.mode & 0o077) !== 0
          ) {
            return { status: "unsafe" };
          }
          return { status: "available", text: await file.readFile("utf8") };
        } finally {
          await file.close();
        }
      } finally {
        await directory.close();
      }
    },
    async write(text) {
      const { configurationPath, directoryPath } = options;
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      const directory = await openOwnerDirectory(directoryPath);
      if (directory === null) {
        throw new TypeError("The user configuration directory is unavailable.");
      }
      const temporaryPath = join(directoryPath, `${options.temporaryPrefix}-${randomUUID()}.tmp`);
      let temporary: FileHandle | undefined;
      try {
        const existing = await openOwnerFile(configurationPath).catch(() => undefined);
        if (existing === undefined) {
          throw new TypeError("The user configuration file is unsafe.");
        }
        if (existing !== null) {
          try {
            const stats = await existing.stat();
            if (
              !stats.isFile() ||
              stats.uid !== currentEffectiveUserId() ||
              (stats.mode & 0o077) !== 0
            ) {
              throw new TypeError("The user configuration file is unsafe.");
            }
          } finally {
            await existing.close();
          }
        }
        temporary = await open(
          temporaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        await temporary.writeFile(text);
        await temporary.sync();
        await temporary.close();
        temporary = undefined;
        await rename(temporaryPath, configurationPath);
        await directory.sync();
      } catch (error) {
        await temporary?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      } finally {
        await directory.close();
      }
    },
  };
}

function parseWorkspaceTrust(
  text: string,
):
  | { readonly status: "valid"; readonly trustedProjectIds: readonly `sha256:${string}`[] }
  | { readonly status: "invalid" } {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > maximumWorkspaceTrustBytes) {
    return { status: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  if (hasDuplicateJsonObjectKey(text) || !isPlainRecord(parsed)) {
    return { status: "invalid" };
  }
  const { schemaVersion, trustedProjectIds } = parsed;
  if (
    schemaVersion !== 1 ||
    Object.keys(parsed).length !== 2 ||
    !Array.isArray(trustedProjectIds) ||
    trustedProjectIds.length > maximumTrustedProjectIds ||
    trustedProjectIds.some(
      (projectId) => typeof projectId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(projectId),
    ) ||
    new Set(trustedProjectIds).size !== trustedProjectIds.length ||
    trustedProjectIds.some(
      (projectId, index) => index > 0 && trustedProjectIds[index - 1] >= projectId,
    )
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    trustedProjectIds: trustedProjectIds as readonly `sha256:${string}`[],
  };
}

function serializeWorkspaceTrust(trustedProjectIds: readonly `sha256:${string}`[]): string {
  return `${JSON.stringify({ schemaVersion: 1, trustedProjectIds })}\n`;
}

export async function resolveCanonicalWorkspaceIdentity(workspaceRoot: string): Promise<{
  readonly projectId: `sha256:${string}`;
  readonly projectLabel: string;
}> {
  const canonicalRoot = await realpath(workspaceRoot);
  return {
    projectId: `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`,
    projectLabel: basename(canonicalRoot) || "project",
  };
}

async function openOwnerDirectory(path: string): Promise<FileHandle | null> {
  let directory: FileHandle;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? null : Promise.reject(error);
  }
  const stats = await directory.stat();
  if (
    !stats.isDirectory() ||
    stats.uid !== currentEffectiveUserId() ||
    (stats.mode & 0o077) !== 0
  ) {
    await directory.close();
    throw new TypeError("The target preference directory is not owner-only.");
  }
  return directory;
}

async function openOwnerFile(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? null : Promise.reject(error);
  }
}

async function acquireOwnerConfigurationLock(
  directoryPath: string,
  lockName: string,
  nonblocking: boolean,
): Promise<WorkspaceTrustMcpLease> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directory = await openOwnerDirectory(directoryPath);
  if (directory === null) {
    throw new TypeError("The owner configuration directory is unavailable.");
  }
  let lease: WorkspaceTrustMcpLease | undefined;
  let acquisitionError: unknown;
  try {
    const lock = await open(
      join(directoryPath, lockName),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    lease = createConfigurationLockLease(lock);
    const stats = await lock.stat();
    if (!stats.isFile() || stats.uid !== currentEffectiveUserId() || (stats.mode & 0o077) !== 0) {
      throw new TypeError("The owner configuration lock is unsafe.");
    }
    const child = spawn("flock", ["--exclusive", ...(nonblocking ? ["--nonblock"] : []), "3"], {
      stdio: ["ignore", "ignore", "pipe", lock.fd],
    });
    await waitForConfigurationLock(child, nonblocking);
  } catch (error) {
    acquisitionError = error;
  }
  let directoryCloseError: unknown;
  try {
    await directory.close();
  } catch (error) {
    directoryCloseError = error;
  }
  if (acquisitionError === undefined && directoryCloseError === undefined && lease !== undefined) {
    return lease;
  }
  let lockCloseError: unknown;
  try {
    await lease?.release();
  } catch (error) {
    lockCloseError = error;
  }
  const errors = [acquisitionError, directoryCloseError, lockCloseError].filter(
    (error) => error !== undefined,
  );
  if (errors.length === 1) {
    throw errors[0];
  }
  throw new AggregateError(errors, "The owner configuration lock could not be acquired safely.");
}

function createConfigurationLockLease(lock: FileHandle): WorkspaceTrustMcpLease {
  let closePromise: Promise<void> | undefined;
  return {
    release() {
      closePromise ??= lock.close();
      return closePromise;
    },
  };
}

async function waitForConfigurationLock(
  child: ReturnType<typeof spawn>,
  nonblocking: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let spawnError: TypeError | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      spawnError = new TypeError("The owner configuration lock is unavailable.");
    });
    child.once("close", (code) => {
      if (spawnError !== undefined) {
        finish(spawnError);
      } else if (code === 0) {
        finish();
      } else if (nonblocking && code === 1 && stderr.length === 0) {
        finish(new WorkspaceTrustMcpLeaseError());
      } else {
        finish(new TypeError("The owner configuration lock is unavailable."));
      }
    });
  });
}

function parseConfiguration(text: string): LoadedPresentationPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidSnapshot();
  }
  if (hasDuplicateJsonObjectKey(text) || !isPlainRecord(parsed)) {
    return invalidSnapshot();
  }
  const { defaultTargetId, modelPolicy, schemaVersion } = parsed;
  if (schemaVersion === 1) {
    if (
      Object.keys(parsed).length !== 2 ||
      typeof defaultTargetId !== "string" ||
      defaultTargetId.length === 0 ||
      defaultTargetId.length > 256
    ) {
      return invalidSnapshot();
    }
    return {
      defaultTargetId,
      diagnostic: null,
      modelPolicy: emptyModelPolicy(),
    };
  }
  if (!isPlainRecord(modelPolicy)) {
    return invalidSnapshot();
  }
  const { automaticCompactionWindowTokens, contextWindowTokens, maximumOutputTokens } = modelPolicy;
  if (
    schemaVersion !== 2 ||
    Object.keys(parsed).length !== 3 ||
    !isNullableDefaultTarget(defaultTargetId) ||
    Object.keys(modelPolicy).length !== 3 ||
    !isNullablePositiveSafeInteger(contextWindowTokens) ||
    !isNullablePositiveSafeInteger(maximumOutputTokens) ||
    !isNullablePositiveSafeInteger(automaticCompactionWindowTokens)
  ) {
    return invalidSnapshot();
  }
  return {
    defaultTargetId,
    diagnostic: null,
    modelPolicy: {
      contextWindowTokens,
      maximumOutputTokens,
      automaticCompactionWindowTokens,
    },
  };
}

function emptySnapshot(): LoadedPresentationPreferences {
  return { defaultTargetId: null, diagnostic: null, modelPolicy: emptyModelPolicy() };
}

function invalidSnapshot(): LoadedPresentationPreferences {
  return {
    defaultTargetId: null,
    diagnostic: {
      code: "target_configuration_invalid",
      message: "The saved default target configuration is invalid.",
    },
    modelPolicy: emptyModelPolicy(),
  };
}

function unsafeSnapshot(): LoadedPresentationPreferences {
  return {
    defaultTargetId: null,
    diagnostic: {
      code: "target_configuration_unsafe",
      message: "The saved default target configuration is not an owner-only ordinary file.",
    },
    modelPolicy: emptyModelPolicy(),
  };
}

function emptyModelPolicy(): UserModelPolicySnapshot {
  return {
    contextWindowTokens: null,
    maximumOutputTokens: null,
    automaticCompactionWindowTokens: null,
  };
}

function isNullableDefaultTarget(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isUserModelPolicyField(value: unknown): value is UserModelPolicyField {
  return (
    value === "contextWindowTokens" ||
    value === "maximumOutputTokens" ||
    value === "automaticCompactionWindowTokens"
  );
}

function hasDuplicateJsonObjectKey(text: string): boolean {
  const containers: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      containers.push(new Set());
      continue;
    }
    if (character === "[") {
      containers.push(null);
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        break;
      }
      index += 1;
    }
    let next = index + 1;
    while (/\s/u.test(text[next] ?? "")) {
      next += 1;
    }
    if (text[next] !== ":") {
      continue;
    }
    const keys = containers.at(-1);
    if (keys === null || keys === undefined) {
      continue;
    }
    const key = JSON.parse(text.slice(start, index + 1)) as string;
    if (keys.has(key)) {
      return true;
    }
    keys.add(key);
  }
  return false;
}

function currentEffectiveUserId(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : (process.getuid?.() ?? -1);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
