import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const maximumConfigurationBytes = 4 * 1024;

export type PresentationPreferencesDiagnostic = {
  readonly code: "target_configuration_invalid" | "target_configuration_unsafe";
  readonly message: string;
};

export type PresentationPreferencesSnapshot = {
  readonly defaultTargetId: string | null;
  readonly diagnostic: PresentationPreferencesDiagnostic | null;
};

export type PresentationPreferences = {
  load(): Promise<PresentationPreferencesSnapshot>;
  setDefaultTarget(targetId: string): Promise<void>;
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

  return {
    async load() {
      const directory = await openOwnerDirectory(directoryPath).catch(() => undefined);
      if (directory === undefined) {
        return unsafeSnapshot();
      }
      if (directory === null) {
        return emptySnapshot();
      }
      try {
        const file = await openOwnerFile(configurationPath).catch(() => undefined);
        if (file === undefined) {
          return unsafeSnapshot();
        }
        if (file === null) {
          return emptySnapshot();
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
            return unsafeSnapshot();
          }
          const text = await file.readFile("utf8");
          return parseConfiguration(text);
        } finally {
          await file.close();
        }
      } finally {
        await directory.close();
      }
    },
    async setDefaultTarget(targetId) {
      if (targetId.length === 0 || targetId.length > 256) {
        throw new TypeError("The exact default target ID is invalid.");
      }
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      const directory = await openOwnerDirectory(directoryPath);
      if (directory === null) {
        throw new TypeError("The target preference directory is unavailable.");
      }
      const temporaryPath = join(directoryPath, `.config-${randomUUID()}.tmp`);
      let temporary: FileHandle | undefined;
      try {
        const existing = await openOwnerFile(configurationPath).catch(() => undefined);
        if (existing === undefined) {
          throw new TypeError("The target preference file is unsafe.");
        }
        if (existing !== null) {
          try {
            const stats = await existing.stat();
            if (
              !stats.isFile() ||
              stats.uid !== currentEffectiveUserId() ||
              (stats.mode & 0o077) !== 0
            ) {
              throw new TypeError("The target preference file is unsafe.");
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
        await temporary.writeFile(
          `${JSON.stringify({ schemaVersion: 1, defaultTargetId: targetId })}\n`,
        );
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

function parseConfiguration(text: string): PresentationPreferencesSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidSnapshot();
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).length !== 2) {
    return invalidSnapshot();
  }
  const { defaultTargetId, schemaVersion } = parsed;
  if (
    schemaVersion !== 1 ||
    typeof defaultTargetId !== "string" ||
    defaultTargetId.length === 0 ||
    defaultTargetId.length > 256
  ) {
    return invalidSnapshot();
  }
  return {
    defaultTargetId,
    diagnostic: null,
  };
}

function emptySnapshot(): PresentationPreferencesSnapshot {
  return { defaultTargetId: null, diagnostic: null };
}

function invalidSnapshot(): PresentationPreferencesSnapshot {
  return {
    defaultTargetId: null,
    diagnostic: {
      code: "target_configuration_invalid",
      message: "The saved default target configuration is invalid.",
    },
  };
}

function unsafeSnapshot(): PresentationPreferencesSnapshot {
  return {
    defaultTargetId: null,
    diagnostic: {
      code: "target_configuration_unsafe",
      message: "The saved default target configuration is not an owner-only ordinary file.",
    },
  };
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
