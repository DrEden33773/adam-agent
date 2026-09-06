import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  type ManagedAgentRecord,
  type ManagedAgentStore,
  ManagedAgentStoreError,
  validateManagedAgentRecord,
} from "./managed-agent.js";
import {
  type ManagedControlRecord,
  type ManagedControlStore,
  validateManagedControlBatches,
  validateManagedControlRecord,
} from "./managed-agent-folds.js";

export function createInMemoryManagedAgentControlStore(): ManagedControlStore {
  const partitions = new Map<string, ManagedControlRecord[]>();
  const scoped = (parentSessionId?: string): ManagedControlStore => ({
    forParent(id) {
      assertParentScope(parentSessionId, id);
      return scoped(id);
    },
    async preflight() {},
    async readLegacy() {
      return [];
    },
    async read() {
      for (const [parent, records] of partitions)
        if (parentSessionId === undefined || parent === parentSessionId)
          validateManagedControlBatches(records);
      return structuredClone(
        parentSessionId === undefined
          ? [...partitions.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .flatMap(([, records]) => records)
          : (partitions.get(parentSessionId) ?? []),
      );
    },
    async append(record) {
      if (typeof record !== "object" || record === null)
        throw new ManagedAgentStoreError("managed_agent_log_invalid");
      assertParentScope(parentSessionId, record.parentSessionId);
      const records = partitions.get(record.parentSessionId) ?? [];
      records.push(validateManagedControlRecord(record, records));
      partitions.set(record.parentSessionId, records);
    },
    async appendNext(input) {
      if (typeof input !== "object" || input === null)
        throw new ManagedAgentStoreError("managed_agent_log_invalid");
      assertParentScope(parentSessionId, input.parentSessionId);
      const records = partitions.get(input.parentSessionId) ?? [];
      const record = validateManagedControlRecord(
        { ...input, sequence: records.length + 1 },
        records,
      );
      records.push(record);
      partitions.set(input.parentSessionId, records);
      return structuredClone(record);
    },
    async appendBatchNext(inputs) {
      const first = inputs[0];
      if (first === undefined || inputs.length > 128)
        throw new ManagedAgentStoreError("managed_agent_log_invalid");
      const records = [...(partitions.get(first.parentSessionId) ?? [])];
      const added: ManagedControlRecord[] = [];
      for (const input of inputs) {
        assertParentScope(parentSessionId ?? first.parentSessionId, input.parentSessionId);
        const record = validateManagedControlRecord(
          { ...input, sequence: records.length + 1 },
          records,
        );
        records.push(record);
        added.push(record);
      }
      validateManagedControlBatches(records);
      partitions.set(first.parentSessionId, records);
      return structuredClone(added);
    },
  });
  return scoped();
}

function assertParentScope(bound: string | undefined, requested: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requested) ||
    (bound !== undefined && bound !== requested)
  )
    throw new ManagedAgentStoreError("managed_agent_log_invalid");
}

/** Parent journals share the project writer, while corruption stays in the attributable parent. */
export async function createJsonlManagedAgentControlStore(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<ManagedControlStore> {
  const workspace = await realpath(options.workspaceRoot);
  const projectKey = createHash("sha256").update(workspace).digest("hex");
  const stateRoot = resolve(options.stateRoot ?? defaultManagedAgentStateRoot());
  const projects = join(stateRoot, "projects");
  const project = join(projects, projectKey);
  const directory = join(project, "managed-agents");
  const legacyPath = join(directory, "events-v1.jsonl");
  const backupPath = join(directory, "events-v1.pre-v3.jsonl");
  const prepared = new Set<string>();
  const assertDirectories = async () => {
    for (const path of [stateRoot, projects, project, directory]) {
      try {
        if ((await realpath(path)) !== path)
          throw new Error("Managed control directory identity changed.");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }
  };
  const readBytes = async (path: string): Promise<string> => {
    await assertDirectories();
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw new Error("Managed control journal is not a regular file.");
      if (stats.size > maximumManagedAgentLogBytes)
        throw new ManagedAgentStoreError("managed_agent_log_too_large");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  };
  const parseLines = (text: string): readonly unknown[] => {
    if (text === "") return [];
    if (!text.endsWith("\n")) throw new ManagedAgentStoreError("managed_agent_log_invalid");
    try {
      return text
        .slice(0, -1)
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new ManagedAgentStoreError("managed_agent_log_invalid");
    }
  };
  const readLegacy = async () => {
    const records: ManagedAgentRecord[] = [];
    for (const value of parseLines(await readBytes(legacyPath)))
      records.push(validateManagedAgentRecord(value, records).record);
    return records;
  };
  const readPartition = async (path: string, parent: string) => {
    const memory = createInMemoryManagedAgentControlStore().forParent(parent);
    for (const value of parseLines(await readBytes(path)))
      await memory.append(value as ManagedControlRecord);
    return memory.read();
  };
  const scoped = (parentSessionId?: string): ManagedControlStore => {
    const path =
      parentSessionId === undefined
        ? undefined
        : join(directory, `events-v3-${parentSessionId}.jsonl`);
    const appendStored = (
      inputs: readonly Omit<ManagedControlRecord, "sequence">[],
      allocate: boolean,
    ): Promise<readonly ManagedControlRecord[]> => {
      if (inputs.length === 0 || inputs.length > 128)
        return Promise.reject(new ManagedAgentStoreError("managed_agent_log_invalid"));
      for (const input of inputs) assertParentScope(parentSessionId, input.parentSessionId);
      if (path === undefined || parentSessionId === undefined || !prepared.has(parentSessionId))
        return Promise.reject(new ManagedAgentStoreError("managed_agent_log_invalid"));
      return enqueueManagedAgentAppend(path, async () => {
        const records = await readPartition(path, parentSessionId);
        const working = [...records];
        const added: ManagedControlRecord[] = [];
        for (const input of inputs) {
          const record = validateManagedControlRecord(
            allocate ? { ...input, sequence: working.length + 1 } : input,
            working,
          );
          working.push(record);
          added.push(record);
        }
        validateManagedControlBatches(records);
        const text = added.map((record) => `${JSON.stringify(record)}\n`).join("");
        const storedBytes = records.reduce(
          (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1,
          0,
        );
        if (storedBytes + Buffer.byteLength(text, "utf8") > maximumManagedAgentLogBytes)
          throw new ManagedAgentStoreError("managed_agent_log_too_large");
        const file = await open(
          path,
          constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await file.stat()).isFile())
            throw new Error("Managed control journal is not a regular file.");
          await file.writeFile(text, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        return added;
      });
    };
    const store: ManagedControlStore = {
      forParent(id) {
        assertParentScope(parentSessionId, id);
        return scoped(id);
      },
      readLegacy,
      async read() {
        if (path !== undefined && parentSessionId !== undefined) {
          await (managedAgentAppendQueues.get(path) ?? Promise.resolve());
          return readPartition(path, parentSessionId);
        }
        await assertDirectories();
        let names: string[];
        try {
          names = await readdir(directory);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        }
        const records: ManagedControlRecord[] = [];
        for (const name of names.filter((name) => name.startsWith("events-v3-")).sort()) {
          const match = /^events-v3-([0-9a-f-]{36})\.jsonl$/u.exec(name);
          if (match?.[1] === undefined)
            throw new Error("Managed control journal identity is unavailable.");
          records.push(...(await scoped(match[1]).read()));
        }
        return records;
      },
      preflight() {
        return enqueueManagedAgentAppend(backupPath, async () => {
          if (prepared.has(parentSessionId ?? "all")) return;
          await readLegacy();
          await store.read();
          const legacyBytes = await readBytes(legacyPath);
          for (const entry of [stateRoot, projects, project, directory]) {
            await mkdir(entry, { recursive: true, mode: 0o700 });
            if ((await realpath(entry)) !== entry)
              throw new Error("Managed control directory identity changed.");
            await chmod(entry, 0o700);
          }
          let backup: Awaited<ReturnType<typeof open>> | undefined;
          try {
            backup = await open(
              backupPath,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            );
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
            if ((await readBytes(backupPath)) !== legacyBytes)
              throw new ManagedAgentStoreError("managed_agent_log_invalid");
          }
          if (backup !== undefined) {
            try {
              await backup.writeFile(legacyBytes, "utf8");
              await backup.sync();
            } finally {
              await backup.close();
            }
          }
          if (path !== undefined) await ensureManagedAgentLogFile(path);
          const directoryFile = await open(
            directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await directoryFile.sync();
          } finally {
            await directoryFile.close();
          }
          prepared.add(parentSessionId ?? "all");
        });
      },
      async append(record) {
        if (parentSessionId === undefined) {
          const target = scoped(record.parentSessionId);
          await target.preflight();
          await target.append(record);
          return;
        }
        await appendStored([record], false);
      },
      async appendBatchNext(records) {
        if (parentSessionId === undefined) {
          const first = records[0];
          if (first === undefined) throw new ManagedAgentStoreError("managed_agent_log_invalid");
          const target = scoped(first.parentSessionId);
          await target.preflight();
          return target.appendBatchNext(records);
        }
        return appendStored(records, true);
      },
      async appendNext(record) {
        if (parentSessionId === undefined) {
          const target = scoped(record.parentSessionId);
          await target.preflight();
          return target.appendNext(record);
        }
        const added = await appendStored([record], true);
        if (added[0] === undefined) throw new ManagedAgentStoreError("managed_agent_log_invalid");
        return added[0];
      },
    };
    return store;
  };
  return scoped();
}

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

function enqueueManagedAgentAppend<T>(path: string, operation: () => Promise<T>): Promise<T> {
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
