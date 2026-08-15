import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemoryOperationStore,
  createJsonlOperationStore,
  type OperationEventRecord,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

const operationId = "123e4567-e89b-42d3-a456-426614174000";
const canonicalInputDigest =
  "sha256:2a55e3c07660886834b043483337c2143e50ea57313aa7e16b746cca55422ade";

test("OperationStore adapters append and read a versioned start record", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-store-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const record: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 1,
    recordedAt: "2026-08-15T08:00:00.000Z",
    event: {
      type: "operation_started",
      contributionId: "fixture.review",
      deadlineAt: "2026-08-15T08:01:00.000Z",
      extensionId: "fixture.extension",
      extensionVersion: "1.0.0",
      idempotencyKey: "review-request-1",
      input: { revision: "abc123" },
      inputDigest: canonicalInputDigest,
      projectId: projectIdForWorkspace(workspaceRoot),
    },
  };

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      await store.append(record);
      expect(await store.read(operationId), name).toEqual([record]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters preserve progress after its durable start", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-progress-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const records: readonly OperationEventRecord[] = [
    {
      schemaVersion: 1,
      operationId,
      sequence: 1,
      recordedAt: "2026-08-15T08:00:00.000Z",
      event: {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: "2026-08-15T08:01:00.000Z",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        idempotencyKey: "review-request-1",
        input: { revision: "abc123" },
        inputDigest: canonicalInputDigest,
        projectId: projectIdForWorkspace(workspaceRoot),
      },
    },
    {
      schemaVersion: 1,
      operationId,
      sequence: 2,
      recordedAt: "2026-08-15T08:00:01.000Z",
      event: {
        type: "operation_progress",
        value: { completed: 2, phase: "analyze", total: 4 },
      },
    },
  ];

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      for (const record of records) {
        await store.append(record);
      }
      expect(await store.read(operationId), name).toEqual(records);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters accept one terminal fact and reject later facts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-terminal-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const records: readonly OperationEventRecord[] = [
    {
      schemaVersion: 1,
      operationId,
      sequence: 1,
      recordedAt: "2026-08-15T08:00:00.000Z",
      event: {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: "2026-08-15T08:01:00.000Z",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        idempotencyKey: "review-request-1",
        input: { revision: "abc123" },
        inputDigest: canonicalInputDigest,
        projectId: projectIdForWorkspace(workspaceRoot),
      },
    },
    {
      schemaVersion: 1,
      operationId,
      sequence: 2,
      recordedAt: "2026-08-15T08:00:01.000Z",
      event: { type: "operation_cancel_requested", reason: "caller" },
    },
    {
      schemaVersion: 1,
      operationId,
      sequence: 3,
      recordedAt: "2026-08-15T08:00:02.000Z",
      event: { type: "operation_cancelled", reason: "caller" },
    },
  ];
  const lateRecord: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 4,
    recordedAt: "2026-08-15T08:00:03.000Z",
    event: { type: "operation_completed", output: { accepted: true } },
  };

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      for (const record of records) {
        await store.append(record);
      }
      await expect(store.append(lateRecord), name).rejects.toMatchObject({
        code: "operation_log_invalid",
        name: "OperationStoreError",
      });
      expect(await store.read(operationId), name).toEqual(records);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters require a matching durable request before cancellation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-cancel-order-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const started: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 1,
    recordedAt: "2026-08-15T08:00:00.000Z",
    event: {
      type: "operation_started",
      contributionId: "fixture.review",
      deadlineAt: "2026-08-15T08:01:00.000Z",
      extensionId: "fixture.extension",
      extensionVersion: "1.0.0",
      idempotencyKey: "cancel-order-request",
      input: { revision: "abc123" },
      inputDigest: canonicalInputDigest,
      projectId: projectIdForWorkspace(workspaceRoot),
    },
  };
  const cancelledWithoutRequest: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 2,
    recordedAt: "2026-08-15T08:00:01.000Z",
    event: { type: "operation_cancelled", reason: "caller" },
  };

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      await store.append(started);
      await expect(store.append(cancelledWithoutRequest), name).rejects.toMatchObject({
        code: "operation_log_invalid",
        name: "OperationStoreError",
      });
      expect(await store.read(operationId), name).toEqual([started]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters preserve a typed failed terminal fact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-failed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const records: readonly OperationEventRecord[] = [
    {
      schemaVersion: 1,
      operationId,
      sequence: 1,
      recordedAt: "2026-08-15T08:00:00.000Z",
      event: {
        type: "operation_started",
        contributionId: "fixture.review",
        deadlineAt: "2026-08-15T08:01:00.000Z",
        extensionId: "fixture.extension",
        extensionVersion: "1.0.0",
        idempotencyKey: "review-request-1",
        input: { revision: "abc123" },
        inputDigest: canonicalInputDigest,
        projectId: projectIdForWorkspace(workspaceRoot),
      },
    },
    {
      schemaVersion: 1,
      operationId,
      sequence: 2,
      recordedAt: "2026-08-15T08:01:00.000Z",
      event: {
        type: "operation_failed",
        artifacts: [
          {
            byteCount: 13,
            contract: { id: "fixture.review-result", version: 1 },
            id: "sha256:533caf6e8ff7bb7489e0b64fdff813b635dfb5abc30b387b79e13000ebd268c5",
            mediaType: "application/json",
            provenance: {
              contributionId: "fixture.review",
              extensionId: "fixture.extension",
              extensionVersion: "1.0.0",
              operationId,
              projectId: projectIdForWorkspace(workspaceRoot),
            },
          },
        ],
        error: {
          code: "operation_deadline_exceeded",
          message: "The operation exceeded its deadline.",
        },
      },
    },
  ];

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      for (const record of records) {
        await store.append(record);
      }
      expect(await store.read(operationId), name).toEqual(records);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters reject an oversized start payload before changing history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-input-limit-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const oversized: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 1,
    recordedAt: "2026-08-15T08:00:00.000Z",
    event: {
      type: "operation_started",
      contributionId: "fixture.review",
      deadlineAt: "2026-08-15T08:01:00.000Z",
      extensionId: "fixture.extension",
      extensionVersion: "1.0.0",
      idempotencyKey: "oversized-request",
      input: "x".repeat(12_000_000),
      inputDigest: canonicalInputDigest,
      projectId: projectIdForWorkspace(workspaceRoot),
    },
  };

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      await expect(store.append(oversized), name).rejects.toMatchObject({
        code: "operation_log_too_large",
        name: "OperationStoreError",
      });
      expect(await store.read(operationId), name).toEqual([]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("OperationStore adapters reject non-canonical v1 start metadata", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-metadata-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const validRecord: OperationEventRecord = {
    schemaVersion: 1,
    operationId,
    sequence: 1,
    recordedAt: "2026-08-15T08:00:00.000Z",
    event: {
      type: "operation_started",
      contributionId: "fixture.review",
      deadlineAt: "2026-08-15T08:01:00.000Z",
      extensionId: "fixture.extension",
      extensionVersion: "1.0.0",
      idempotencyKey: "metadata-request",
      input: { revision: "abc123" },
      inputDigest: canonicalInputDigest,
      projectId: projectIdForWorkspace(workspaceRoot),
    },
  };
  const invalidRecords = [
    { ...validRecord, recordedAt: "2026-99-15T08:00:00.000Z" },
    {
      ...validRecord,
      event: { ...validRecord.event, extensionVersion: "not-semver" },
    },
    {
      ...validRecord,
      event: { ...validRecord.event, inputDigest: `sha256:${"a".repeat(64)}` },
    },
    {
      ...validRecord,
      event: { ...validRecord.event, deadlineAt: "2026-08-15T08:10:00.000Z" },
    },
  ] as unknown as readonly OperationEventRecord[];

  try {
    await mkdir(workspaceRoot);
    const stores = [
      ["in-memory", createInMemoryOperationStore()],
      ["JSONL", await createJsonlOperationStore({ stateRoot, workspaceRoot })],
    ] as const;

    for (const [name, store] of stores) {
      for (const record of invalidRecords) {
        await expect(store.append(record), name).rejects.toMatchObject({
          code: "operation_log_invalid",
          name: "OperationStoreError",
        });
      }
      expect(await store.read(operationId), name).toEqual([]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL OperationStore fails closed on torn and discontinuous logs", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-torn-log-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");

  try {
    await mkdir(workspaceRoot);
    const store = await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const logPath = await operationLogPath(stateRoot, workspaceRoot);
    await writeFile(logPath, '{"schemaVersion":1', "utf8");
    await expect(store.read(operationId)).rejects.toMatchObject({
      code: "operation_log_invalid",
      name: "OperationStoreError",
    });
    await writeFile(
      logPath,
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        sequence: 2,
        recordedAt: "2026-08-15T08:00:00.000Z",
        event: {
          type: "operation_progress",
          value: { phase: "orphan" },
        },
      })}\n`,
      "utf8",
    );
    await expect(store.read(operationId)).rejects.toMatchObject({
      code: "operation_log_invalid",
      name: "OperationStoreError",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL OperationStore restores owner-only project state permissions", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-mode-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");

  try {
    await mkdir(workspaceRoot);
    await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const logPath = await operationLogPath(stateRoot, workspaceRoot);
    const operationsDirectory = join(logPath, "..");
    await chmod(operationsDirectory, 0o777);
    await chmod(logPath, 0o666);

    await createJsonlOperationStore({ stateRoot, workspaceRoot });

    expect((await stat(operationsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL OperationStore rejects a symlinked operation log without touching its target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-operation-symlink-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const outsidePath = join(testRoot, "outside.jsonl");

  try {
    await mkdir(workspaceRoot);
    await createJsonlOperationStore({ stateRoot, workspaceRoot });
    const logPath = await operationLogPath(stateRoot, workspaceRoot);
    await rm(logPath);
    await writeFile(outsidePath, "", "utf8");
    await symlink(outsidePath, logPath);

    await expect(createJsonlOperationStore({ stateRoot, workspaceRoot })).rejects.toBeInstanceOf(
      Error,
    );
    expect(await readFile(outsidePath, "utf8")).toBe("");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function operationLogPath(stateRoot: string, workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  const projectId = createHash("sha256").update(canonicalRoot).digest("hex");
  return join(stateRoot, "projects", projectId, "operations", "events-v1.jsonl");
}

function projectIdForWorkspace(workspaceRoot: string): string {
  return `sha256:${createHash("sha256").update(workspaceRoot).digest("hex")}`;
}
