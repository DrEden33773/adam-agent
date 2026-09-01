import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ManagedAgentRecord,
  type ManagedAgentStore,
  ManagedAgentStoreError,
  validateManagedAgentRecord,
} from "./managed-agent.js";

const maximumManagedAgentLogBytes = 32 * 1024 * 1024;
const managedAgentAppendQueues = new Map<string, Promise<void>>();

export function createInMemoryManagedAgentStore(): ManagedAgentStore {
  const records: ManagedAgentRecord[] = [];
  return {
    async append(record) {
      const validated = validateManagedAgentRecord(record, records);
      const storedBytes = records.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1,
        0,
      );
      if (storedBytes + validated.byteLength > maximumManagedAgentLogBytes) {
        throw new ManagedAgentStoreError("managed_agent_log_too_large");
      }
      records.push(validated.record);
    },
    async read() {
      return [...records];
    },
  };
}

export async function createJsonlManagedAgentStore(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<ManagedAgentStore> {
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const stateRoot = options.stateRoot ?? defaultManagedAgentStateRoot();
  const projectsDirectory = join(stateRoot, "projects");
  const projectDirectory = join(projectsDirectory, projectKey);
  const managedAgentsDirectory = join(projectDirectory, "managed-agents");
  for (const directory of [projectsDirectory, projectDirectory, managedAgentsDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const logPath = join(managedAgentsDirectory, "events-v1.jsonl");
  await ensureManagedAgentLogFile(logPath);
  await readManagedAgentLog(logPath);
  return {
    append(record) {
      return enqueueManagedAgentAppend(logPath, async () => {
        const records = await readManagedAgentLog(logPath);
        const validated = validateManagedAgentRecord(record, records);
        const storedBytes = records.reduce(
          (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1,
          0,
        );
        if (storedBytes + validated.byteLength > maximumManagedAgentLogBytes) {
          throw new ManagedAgentStoreError("managed_agent_log_too_large");
        }
        const file = await open(
          logPath,
          constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          const stats = await file.stat();
          if (!stats.isFile()) {
            throw new ManagedAgentStoreError("managed_agent_log_invalid");
          }
          await file.chmod(0o600);
          await file.writeFile(`${validated.serialized}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      });
    },
    async read() {
      await (managedAgentAppendQueues.get(logPath) ?? Promise.resolve());
      return readManagedAgentLog(logPath);
    },
  };
}

async function ensureManagedAgentLogFile(path: string): Promise<void> {
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
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readManagedAgentLog(path: string): Promise<readonly ManagedAgentRecord[]> {
  const contents = await readFile(path, "utf8");
  if (contents.length === 0) {
    return [];
  }
  if (!contents.endsWith("\n")) {
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
  }
  const records: ManagedAgentRecord[] = [];
  for (const line of contents.slice(0, -1).split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
    records.push(validateManagedAgentRecord(parsed, records).record);
  }
  return records;
}

function enqueueManagedAgentAppend(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = managedAgentAppendQueues.get(path) ?? Promise.resolve();
  const queued = previous.then(operation, operation);
  const settled = queued.then(
    () => undefined,
    () => undefined,
  );
  managedAgentAppendQueues.set(path, settled);
  void settled.then(() => {
    if (managedAgentAppendQueues.get(path) === settled) {
      managedAgentAppendQueues.delete(path);
    }
  });
  return queued;
}

function defaultManagedAgentStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}
