import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

const maxLifecycleLogBytes = 1024 * 1024;
const lifecycleRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  extensionId: z.string().min(1).max(256),
  packageName: z.string().min(1).max(256),
  packageVersion: z.string().min(1).max(128),
  enabled: z.boolean(),
});

type ExtensionIdentity = {
  readonly extensionId: string;
  readonly packageName: string;
  readonly packageVersion: string;
};

export type ExtensionLifecycleStore = {
  read(identity: ExtensionIdentity): Promise<boolean | undefined>;
  write(identity: ExtensionIdentity, enabled: boolean): Promise<void>;
};

const lifecycleOperationQueues = new Map<string, Promise<void>>();

export function createExtensionLifecycleStore(stateRoot?: string): ExtensionLifecycleStore {
  const directory = join(resolve(stateRoot ?? defaultStateRoot()), "extensions");

  return {
    read(identity) {
      return enqueueLifecycleOperation(directory, async () => {
        const path = lifecycleLogPath(directory, identity);
        let file: FileHandle;
        try {
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
        try {
          return await readLifecycleTruth(file, identity, false);
        } finally {
          await file.close();
        }
      });
    },
    write(identity, enabled) {
      return enqueueLifecycleOperation(directory, async () => {
        await ensureLifecycleDirectory(directory);
        const serialized = JSON.stringify({
          schemaVersion: 1,
          extensionId: identity.extensionId,
          packageName: identity.packageName,
          packageVersion: identity.packageVersion,
          enabled,
        });
        const storedBytes = Buffer.byteLength(`${serialized}\n`, "utf8");
        const path = lifecycleLogPath(directory, identity);
        const file = await open(
          path,
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_RDWR |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          await readLifecycleTruth(file, identity, true);
          const stats = await file.stat();
          if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
            throw new TypeError("The extension lifecycle log must be an ordinary file.");
          }
          if (stats.size + storedBytes > maxLifecycleLogBytes) {
            throw new TypeError("The extension lifecycle log exceeds its write limit.");
          }
          await file.chmod(0o600);
          await file.writeFile(`${serialized}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      });
    },
  };
}

function enqueueLifecycleOperation<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = lifecycleOperationQueues.get(directory) ?? Promise.resolve();
  const operation = previous.then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  lifecycleOperationQueues.set(directory, settled);
  void settled.then(() => {
    if (lifecycleOperationQueues.get(directory) === settled) {
      lifecycleOperationQueues.delete(directory);
    }
  });
  return operation;
}

async function ensureLifecycleDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw new TypeError("The extension lifecycle root must be an ordinary directory.");
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function readLifecycleTruth(
  file: FileHandle,
  identity: ExtensionIdentity,
  allowEmpty: boolean,
): Promise<boolean | undefined> {
  const stats = await file.stat();
  if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
    throw new TypeError("The extension lifecycle log must be an ordinary file.");
  }
  const buffer = Buffer.alloc(maxLifecycleLogBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxLifecycleLogBytes) {
    throw new TypeError("The extension lifecycle log exceeds its read limit.");
  }
  const content = buffer.subarray(0, offset).toString("utf8");
  if (allowEmpty && content.length === 0) {
    return undefined;
  }
  if (content.length === 0 || !content.endsWith("\n")) {
    throw new TypeError("The extension lifecycle log is invalid.");
  }
  const records = content
    .slice(0, -1)
    .split("\n")
    .map((line) => lifecycleRecordSchema.parse(JSON.parse(line)));
  if (
    records.some(
      (record) =>
        record.extensionId !== identity.extensionId ||
        record.packageName !== identity.packageName ||
        record.packageVersion !== identity.packageVersion,
    )
  ) {
    throw new TypeError("The extension lifecycle log identity is invalid.");
  }
  return records.at(-1)?.enabled;
}

function lifecycleLogPath(directory: string, identity: ExtensionIdentity): string {
  const digest = createHash("sha256")
    .update(`${identity.extensionId}\0${identity.packageName}\0${identity.packageVersion}`)
    .digest("hex");
  return join(directory, `${digest}.jsonl`);
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
