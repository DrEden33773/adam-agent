import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, opendir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  EXTENSION_ID_MAX_LENGTH,
  EXTENSION_PACKAGE_VERSION_MAX_LENGTH,
  EXTENSION_RECORD_MAX_BYTES,
  EXTENSION_RECORD_NAMESPACE_MAX_BYTES,
  type ExtensionJsonValue,
  type ExtensionRecord,
  type ExtensionRecordList,
} from "@adam-agent/extension-api";
import { valid } from "semver";
import { z } from "zod";

type ExtensionRecordNamespace = {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly projectId: string;
};

export interface ExtensionRecordStore {
  create(record: ExtensionRecord): Promise<void>;
  get(namespace: ExtensionRecordNamespace, key: string): Promise<ExtensionRecord | undefined>;
  list(
    namespace: ExtensionRecordNamespace,
    input: { readonly cursor?: string; readonly limit: number; readonly prefix: string },
  ): Promise<ExtensionRecordList>;
}

export class ExtensionRecordStoreError extends Error {
  readonly code:
    | "record_already_exists"
    | "record_namespace_limit_exceeded"
    | "record_store_invalid";

  constructor(code: ExtensionRecordStoreError["code"]) {
    super(
      code === "record_already_exists"
        ? "The extension record already exists."
        : code === "record_namespace_limit_exceeded"
          ? "The extension record namespace exceeds its byte limit."
          : "The extension record store is invalid.",
    );
    this.name = "ExtensionRecordStoreError";
    this.code = code;
  }
}

const contractSchema = z.strictObject({
  id: z.string().min(1).max(256),
  version: z.number().int().positive(),
});
const provenanceSchema = z.strictObject({
  contributionId: z.string().min(1).max(256),
  extensionId: z.string().min(1).max(EXTENSION_ID_MAX_LENGTH),
  extensionVersion: z
    .string()
    .min(1)
    .max(EXTENSION_PACKAGE_VERSION_MAX_LENGTH)
    .refine((version) => valid(version) !== null),
  operationId: z.uuid(),
  projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
const storedRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  byteCount: z.number().int().nonnegative().max(EXTENSION_RECORD_MAX_BYTES),
  contract: contractSchema,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  key: z.string().min(1).max(512).refine(isCanonicalRecordKey),
  provenance: provenanceSchema,
  value: z.json(),
});
type StoredRecord = ExtensionRecord & { readonly schemaVersion: 1 };

const recordQueues = new Map<string, Promise<void>>();
const maxStoredRecordBytes = EXTENSION_RECORD_MAX_BYTES + 8 * 1024;

export function createExtensionRecordStore(stateRoot?: string): ExtensionRecordStore {
  const recordsRoot = join(resolve(stateRoot ?? defaultStateRoot()), "extension-records");
  return {
    create(record) {
      const namespace = namespaceFromRecord(record);
      const directory = namespaceDirectory(recordsRoot, namespace);
      return enqueueRecordOperation(directory, async () => {
        await ensureOwnerOnlyDirectory(directory);
        const existing = await readRecord(recordPath(directory, record.key), true);
        if (existing !== undefined) {
          throw new ExtensionRecordStoreError("record_already_exists");
        }
        const scan = await scanNamespace(directory, namespace);
        if (scan.byteCount + record.byteCount > EXTENSION_RECORD_NAMESPACE_MAX_BYTES) {
          throw new ExtensionRecordStoreError("record_namespace_limit_exceeded");
        }
        const stored = validateStoredRecord({ schemaVersion: 1, ...record });
        const serialized = JSON.stringify(stored);
        const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
        const targetPath = recordPath(directory, record.key);
        const temporary = await open(
          temporaryPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          await temporary.writeFile(serialized, "utf8");
          await temporary.chmod(0o400);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        try {
          await link(temporaryPath, targetPath);
          await syncDirectory(directory);
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") {
            throw new ExtensionRecordStoreError("record_already_exists");
          }
          throw error;
        } finally {
          await unlink(temporaryPath).catch((error: unknown) => {
            if (!isNodeError(error) || error.code !== "ENOENT") {
              throw error;
            }
          });
        }
      });
    },
    get(namespace, key) {
      const directory = namespaceDirectory(recordsRoot, namespace);
      return enqueueRecordOperation(directory, async () => {
        const record = await readRecord(recordPath(directory, key), true);
        if (record !== undefined) {
          assertRecordScope(record, namespace, key);
        }
        return record;
      });
    },
    list(namespace, input) {
      const directory = namespaceDirectory(recordsRoot, namespace);
      return enqueueRecordOperation(directory, async () => {
        const matching = (
          await scanNamespace(directory, namespace, {
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit,
            prefix: input.prefix,
          })
        ).records;
        const page = matching.slice(0, input.limit);
        const records = page.map(toSummary);
        const nextCursor = page.at(-1)?.key;
        return matching.length > page.length && nextCursor !== undefined
          ? { nextCursor, records }
          : { records };
      });
    },
  };
}

function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function enqueueRecordOperation<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = recordQueues.get(directory) ?? Promise.resolve();
  const operation = previous.then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  recordQueues.set(directory, settled);
  void settled.then(() => {
    if (recordQueues.get(directory) === settled) {
      recordQueues.delete(directory);
    }
  });
  return operation;
}

async function scanNamespace(
  directory: string,
  namespace: ExtensionRecordNamespace,
  list?: { readonly cursor?: string; readonly limit: number; readonly prefix: string },
): Promise<{ readonly byteCount: number; readonly records: readonly StoredRecord[] }> {
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { byteCount: 0, records: [] };
    }
    throw error;
  }
  const records: StoredRecord[] = [];
  let byteCount = 0;
  for await (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    const record = await readRecord(join(directory, entry.name), false);
    if (record === undefined) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    assertRecordScope(record, namespace, record.key);
    if (recordPath(directory, record.key) !== join(directory, entry.name)) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    byteCount += record.byteCount;
    if (byteCount > EXTENSION_RECORD_NAMESPACE_MAX_BYTES) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    if (
      list !== undefined &&
      record.key.startsWith(list.prefix) &&
      (list.cursor === undefined || record.key > list.cursor)
    ) {
      const stored = { schemaVersion: 1 as const, ...record };
      const insertion = records.findIndex(
        (candidate) => compareCanonicalKeys(stored.key, candidate.key) < 0,
      );
      records.splice(insertion < 0 ? records.length : insertion, 0, stored);
      if (records.length > list.limit + 1) {
        records.pop();
      }
    }
  }
  return { byteCount, records };
}

async function readRecord(
  path: string,
  allowMissing: boolean,
): Promise<ExtensionRecord | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (
      allowMissing &&
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size > maxStoredRecordBytes) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    const bytes = Buffer.alloc(stats.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > stats.size) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    const stored = validateStoredRecord(JSON.parse(bytes.subarray(0, offset).toString("utf8")));
    return toRecord(stored);
  } catch (error) {
    if (error instanceof ExtensionRecordStoreError) {
      throw error;
    }
    throw new ExtensionRecordStoreError("record_store_invalid");
  } finally {
    await file.close();
  }
}

function validateStoredRecord(value: unknown): StoredRecord {
  const result = storedRecordSchema.safeParse(value);
  if (!result.success) {
    throw new ExtensionRecordStoreError("record_store_invalid");
  }
  const serializedValue = JSON.stringify(canonicalizeJson(result.data.value));
  const byteCount = Buffer.byteLength(serializedValue, "utf8");
  const digest = `sha256:${createHash("sha256").update(serializedValue).digest("hex")}`;
  if (result.data.byteCount !== byteCount || result.data.digest !== digest) {
    throw new ExtensionRecordStoreError("record_store_invalid");
  }
  return {
    schemaVersion: 1,
    byteCount: result.data.byteCount,
    contract: result.data.contract,
    digest: result.data.digest,
    key: result.data.key,
    provenance: result.data.provenance,
    value: result.data.value as ExtensionJsonValue,
  };
}

function toRecord(record: StoredRecord): ExtensionRecord {
  return {
    ...toSummary(record),
    value: record.value,
  };
}

function toSummary(record: StoredRecord) {
  return {
    byteCount: record.byteCount,
    contract: record.contract,
    digest: record.digest,
    key: record.key,
    provenance: record.provenance,
  };
}

function namespaceFromRecord(record: ExtensionRecord): ExtensionRecordNamespace {
  return {
    extensionId: record.provenance.extensionId,
    extensionVersion: record.provenance.extensionVersion,
    projectId: record.provenance.projectId,
  };
}

function assertRecordScope(
  record: ExtensionRecord,
  namespace: ExtensionRecordNamespace,
  key: string,
): void {
  if (
    record.key !== key ||
    record.provenance.projectId !== namespace.projectId ||
    record.provenance.extensionId !== namespace.extensionId ||
    record.provenance.extensionVersion !== namespace.extensionVersion
  ) {
    throw new ExtensionRecordStoreError("record_store_invalid");
  }
}

function namespaceDirectory(root: string, namespace: ExtensionRecordNamespace): string {
  const projectDigest = namespace.projectId.replace(/^sha256:/u, "");
  const extensionDigest = createHash("sha256")
    .update(`${namespace.extensionId}\0${namespace.extensionVersion}`)
    .digest("hex");
  return join(root, projectDigest, extensionDigest);
}

function recordPath(directory: string, key: string): string {
  return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function ensureOwnerOnlyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new ExtensionRecordStoreError("record_store_invalid");
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function isCanonicalRecordKey(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment))
  );
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
