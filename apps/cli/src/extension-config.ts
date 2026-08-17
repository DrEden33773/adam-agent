import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ConfiguredExtension, JsonValue } from "@adam-agent/agent";

const maxConfigurationBytes = 1024 * 1024;
const maxExtensions = 32;

export class CliExtensionConfigurationError extends Error {
  readonly code:
    | "extension_configuration_invalid"
    | "extension_configuration_unavailable"
    | "extension_configuration_unsafe";

  constructor(code: CliExtensionConfigurationError["code"], options?: { cause?: unknown }) {
    super(
      code === "extension_configuration_unavailable"
        ? "The Owner extension configuration is unavailable."
        : code === "extension_configuration_unsafe"
          ? "The Owner extension configuration is not an owner-only ordinary file."
          : "The Owner extension configuration is invalid.",
      options,
    );
    this.name = "CliExtensionConfigurationError";
    this.code = code;
  }
}

export async function loadCliExtensionConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<readonly ConfiguredExtension[]> {
  const { XDG_CONFIG_HOME: xdgConfigHome } = environment;
  const configRoot =
    xdgConfigHome === undefined || xdgConfigHome.length === 0
      ? join(homedir(), ".config")
      : xdgConfigHome;
  const directoryPath = join(configRoot, "adam-agent");
  await assertOwnerOnlyDirectory(directoryPath);
  const path = join(directoryPath, "extensions.json");
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new CliExtensionConfigurationError(
      isNodeError(error) && error.code === "ENOENT"
        ? "extension_configuration_unavailable"
        : "extension_configuration_unsafe",
      {
        cause: error,
      },
    );
  }
  try {
    const stats = await file.stat();
    if (
      !stats.isFile() ||
      !Number.isSafeInteger(stats.size) ||
      stats.size <= 0 ||
      stats.size > maxConfigurationBytes ||
      stats.uid !== currentEffectiveUserId() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new CliExtensionConfigurationError("extension_configuration_unsafe");
    }
    const text = await file.readFile("utf8");
    return await parseConfiguration(text);
  } finally {
    await file.close();
  }
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  let directory: FileHandle;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new CliExtensionConfigurationError(
      isNodeError(error) && error.code === "ENOENT"
        ? "extension_configuration_unavailable"
        : "extension_configuration_unsafe",
      { cause: error },
    );
  }
  try {
    const stats = await directory.stat();
    if (
      !stats.isDirectory() ||
      stats.uid !== currentEffectiveUserId() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw new CliExtensionConfigurationError("extension_configuration_unsafe");
    }
  } finally {
    await directory.close();
  }
}

async function parseConfiguration(text: string): Promise<readonly ConfiguredExtension[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid", { cause: error });
  }
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, ["extensions", "schemaVersion"])) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const { extensions: configuredExtensions, schemaVersion } = parsed;
  if (
    schemaVersion !== 1 ||
    !Array.isArray(configuredExtensions) ||
    configuredExtensions.length === 0 ||
    configuredExtensions.length > maxExtensions
  ) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const extensions = await Promise.all(configuredExtensions.map(parseExtension));
  if (new Set(extensions.map((extension) => extension.extensionId)).size !== extensions.length) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  return Object.freeze(extensions);
}

async function parseExtension(value: unknown): Promise<ConfiguredExtension> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "configuration",
      "enabled",
      "extensionId",
      "grants",
      "packageName",
      "packageRoot",
      "packageVersion",
    ])
  ) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const {
    configuration: rawConfiguration,
    enabled,
    extensionId,
    grants: configuredGrants,
    packageName,
    packageRoot,
    packageVersion,
  } = value;
  if (
    typeof enabled !== "boolean" ||
    !isBoundedString(extensionId, 256) ||
    !isBoundedString(packageName, 256) ||
    !isBoundedString(packageVersion, 128) ||
    typeof packageRoot !== "string" ||
    !isAbsolute(packageRoot) ||
    !Array.isArray(configuredGrants) ||
    configuredGrants.length > 64
  ) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const canonicalPackageRoot = await realpath(packageRoot).catch((error: unknown) => {
    throw new CliExtensionConfigurationError("extension_configuration_unavailable", {
      cause: error,
    });
  });
  if (canonicalPackageRoot !== resolve(packageRoot)) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const grants = configuredGrants.map((grant) => {
    if (!isPlainRecord(grant) || !hasOnlyKeys(grant, ["id", "version"])) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    const { id, version } = grant;
    if (!isBoundedString(id, 256) || !isBoundedString(version, 128)) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    return Object.freeze({ id, version });
  });
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) {
    throw new CliExtensionConfigurationError("extension_configuration_invalid");
  }
  const configuration = normalizeJson(rawConfiguration ?? null);
  return Object.freeze({
    configuration,
    enabled,
    extensionId,
    grants: Object.freeze(grants),
    packageName,
    packageRoot: canonicalPackageRoot,
    packageVersion,
  });
}

function normalizeJson(value: unknown): JsonValue {
  let containers = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): JsonValue => {
    if (depth > 64) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    seen.add(candidate);
    containers += 1;
    if (containers > 10_000) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1));
    }
    if (!isPlainRecord(candidate)) {
      throw new CliExtensionConfigurationError("extension_configuration_invalid");
    }
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, visit(candidate[key], depth + 1)]),
    );
  };
  return visit(value, 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function currentEffectiveUserId(): number {
  const getEffectiveUserId = process.geteuid;
  if (getEffectiveUserId === undefined) {
    throw new CliExtensionConfigurationError("extension_configuration_unsafe");
  }
  return getEffectiveUserId();
}
