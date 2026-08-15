import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function createExtensionLifecycleStore(stateRoot?: string): ExtensionLifecycleStore {
  const directory = join(stateRoot ?? defaultStateRoot(), "extensions");
  let appendQueue = Promise.resolve();

  return {
    async read(identity) {
      await appendQueue;
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
        const stats = await file.stat();
        if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
          throw new TypeError("The extension lifecycle log must be an ordinary file.");
        }
        const buffer = Buffer.alloc(maxLifecycleLogBytes + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, null);
          if (bytesRead === 0) {
            break;
          }
          offset += bytesRead;
        }
        if (offset > maxLifecycleLogBytes) {
          throw new TypeError("The extension lifecycle log exceeds its read limit.");
        }
        const content = buffer.subarray(0, offset).toString("utf8");
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
      } finally {
        await file.close();
      }
    },
    write(identity, enabled) {
      const operation = appendQueue.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
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
            constants.O_WRONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
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
      appendQueue = operation.catch(() => {});
      return operation;
    },
  };
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
