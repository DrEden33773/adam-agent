import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

type UserConfigurationStorage = {
  read(): Promise<UserConfigurationRead>;
  write(text: string): Promise<void>;
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
    createUserConfigurationFileStorage({ configurationPath, directoryPath }),
  );
}

/** Tests only through the internal-testing entry; production uses the owner-only file Adapter. */
export function createPresentationPreferencesWithStorageForTesting(
  storage: UserConfigurationStorage,
): PresentationPreferences {
  return createPresentationPreferencesFromStorage(storage);
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

function createUserConfigurationFileStorage(options: {
  readonly configurationPath: string;
  readonly directoryPath: string;
}): UserConfigurationStorage {
  return {
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
            stats.size > maximumConfigurationBytes ||
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
      const temporaryPath = join(directoryPath, `.config-${randomUUID()}.tmp`);
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
