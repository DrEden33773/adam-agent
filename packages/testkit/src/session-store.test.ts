import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemorySessionStore,
  createJsonlSessionStore,
  type SessionEventRecord,
  SessionStoreError,
} from "@adam-agent/agent";
import { expect, expectTypeOf, test } from "vitest";

const runId = "123e4567-e89b-42d3-a456-426614174000";

type InvalidV1PatchRecord = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly event: {
    readonly type: "tool_permission_decided";
    readonly callId: string;
    readonly name: string;
    readonly decision: "allow";
    readonly effect: "write";
    readonly scope: "call";
    readonly subject: {
      readonly type: "patch";
      readonly version: 1;
      readonly operations: readonly [{ readonly kind: "update"; readonly path: string }];
      readonly digest: string;
    };
  };
};

test("SessionEventRecord type pairs each schema version with its event contract", () => {
  expectTypeOf<InvalidV1PatchRecord>().not.toMatchTypeOf<SessionEventRecord>();
});

test("SessionStore adapters append and read versioned records in order", async () => {
  const { testRoot, stores } = await createContractStores("adam-agent-session-store-", "session-1");
  const records: readonly SessionEventRecord[] = [
    {
      schemaVersion: 1,
      runId,
      sequence: 1,
      event: { type: "user_message", text: "Persist me" },
    },
    {
      schemaVersion: 1,
      runId,
      sequence: 2,
      event: {
        type: "session_settled",
        result: { status: "completed", answer: "Persisted." },
      },
    },
  ];

  try {
    for (const [name, store] of stores) {
      for (const record of records) {
        await store.append(record);
      }
      expect(await store.read(), name).toEqual(records);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters read legacy v1 records and current v2 patch records", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-version-compatibility-",
    "session-version-compatibility",
  );
  const records: readonly SessionEventRecord[] = [
    {
      schemaVersion: 1,
      runId,
      sequence: 1,
      event: { type: "user_message", text: "Legacy event" },
    },
    {
      schemaVersion: 2,
      runId,
      sequence: 2,
      event: {
        type: "tool_failed",
        callId: "call-uncertain",
        name: "edit_file",
        error: {
          code: "patch_state_uncertain",
          message: "Recovery inspection is required.",
          affectedPaths: ["src/index.ts"],
          recoveryReference: { id: "123e4567-e89b-42d3-a456-426614174001" },
        },
      },
    },
  ];

  try {
    for (const [name, store] of stores) {
      for (const record of records) {
        await store.append(record);
      }
      expect(await store.read(), name).toEqual(records);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters keep the v1 event contract unchanged", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-v1-contract-",
    "session-v1-contract",
  );
  const invalidLegacyPatchRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: {
      type: "tool_permission_decided",
      callId: "call-patch",
      name: "edit_file",
      decision: "allow",
      effect: "write",
      scope: "call",
      subject: {
        type: "patch",
        version: 1,
        operations: [{ kind: "update", path: "src/index.ts" }],
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  } as unknown as SessionEventRecord;

  try {
    for (const [name, store] of stores) {
      await expect(store.append(invalidLegacyPatchRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "an empty patch operation list",
    subject: {
      type: "patch",
      version: 1,
      operations: [],
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  },
  {
    label: "a non-SHA-256 patch digest",
    subject: {
      type: "patch",
      version: 1,
      operations: [{ kind: "update", path: "src/index.ts" }],
      digest: "not-a-sha256",
    },
  },
  {
    label: "a non-canonical absolute path",
    subject: {
      type: "patch",
      version: 1,
      operations: [{ kind: "delete", path: "/src/index.ts" }],
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  },
  {
    label: "conflicting ancestor and descendant paths",
    subject: {
      type: "patch",
      version: 1,
      operations: [
        { kind: "create", path: "tree" },
        { kind: "create", path: "tree/child.txt" },
      ],
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  },
])("SessionStore adapters reject v2 patch subjects with $label", async ({ label, subject }) => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-v2-invalid-",
    `session-v2-invalid-${label.replaceAll(/[^a-z0-9]+/giu, "-")}`,
  );
  const invalidRecord = {
    schemaVersion: 2,
    runId,
    sequence: 1,
    event: {
      type: "tool_permission_decided",
      callId: "call-patch",
      name: "edit_file",
      decision: "allow",
      effect: "write",
      scope: "call",
      subject,
    },
  } as unknown as SessionEventRecord;

  try {
    for (const [name, store] of stores) {
      await expect(store.append(invalidRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters reject non-canonical v2 uncertain paths", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-v2-uncertain-invalid-",
    "session-v2-uncertain-invalid",
  );
  const invalidRecord = {
    schemaVersion: 2,
    runId,
    sequence: 1,
    event: {
      type: "tool_failed",
      callId: "call-patch",
      name: "edit_file",
      error: {
        code: "patch_state_uncertain",
        message: "Recovery inspection is required.",
        affectedPaths: ["/src/index.ts"],
        recoveryReference: { id: "123e4567-e89b-42d3-a456-426614174001" },
      },
    },
  } as const;

  try {
    for (const [name, store] of stores) {
      await expect(store.append(invalidRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore rejects an existing session ID without modifying its history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-collision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const options = {
    stateRoot,
    workspaceRoot,
    sessionId: "session-collision",
  } as const;
  const store = await createJsonlSessionStore(options);
  const record: SessionEventRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "user_message", text: "Keep this history intact" },
  };

  try {
    await store.append(record);

    await expect(createJsonlSessionStore(options)).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "session_log_exists",
      message: "The session log already exists.",
    });
    expect(await store.read()).toEqual([record]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore rejects a non-canonical persisted event", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-invalid-session-store-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = await createJsonlSessionStore({
    stateRoot,
    workspaceRoot,
    sessionId: "session-invalid",
  });

  try {
    await store.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      event: { type: "user_message", text: "Create the log" },
    });
    const storedPaths = await readdir(stateRoot, { recursive: true });
    const sessionRelativePath = storedPaths.find((path) => path.endsWith(".jsonl"));
    if (sessionRelativePath === undefined) {
      throw new Error("The JSONL session file was not created.");
    }
    await writeFile(
      join(stateRoot, sessionRelativePath),
      `{"schemaVersion":1,"runId":"${runId}","sequence":1,"event":{"type":"model_message_delta","text":"not durable"}}\n`,
      "utf8",
    );

    const readPromise = store.read();

    await expect(readPromise).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "session_log_invalid",
      message: "The session log contains an invalid record.",
    });
    await expect(readPromise).rejects.toBeInstanceOf(SessionStoreError);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore rejects an oversized restored log before parsing records", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-oversized-session-store-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = await createJsonlSessionStore({
    stateRoot,
    workspaceRoot,
    sessionId: "session-oversized",
  });

  try {
    const storedPaths = await readdir(stateRoot, { recursive: true });
    const sessionRelativePath = storedPaths.find((path) => path.endsWith(".jsonl"));
    if (sessionRelativePath === undefined) {
      throw new Error("The JSONL session file was not created.");
    }
    await writeFile(join(stateRoot, sessionRelativePath), "x".repeat(8 * 1024 * 1024 + 1), "utf8");

    await expect(store.read()).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "session_log_too_large",
      message: "The session log exceeds its read limit.",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters reject non-canonical records on append", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-contract-",
    "session-contract",
  );
  const invalidRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "model_message_delta", text: "not canonical" },
  } as unknown as SessionEventRecord;

  try {
    for (const [name, store] of stores) {
      await expect(store.append(invalidRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters require a category for model request failures", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-model-failure-",
    "session-model-failure",
  );
  const invalidRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: {
      type: "session_settled",
      result: {
        status: "failed",
        error: { code: "model_request_failed", message: "Missing category" },
      },
    },
  } as unknown as SessionEventRecord;

  try {
    for (const [name, store] of stores) {
      await expect(store.append(invalidRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters reject an oversized canonical record before modifying history", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-record-bound-",
    "session-record-bound",
  );
  const oversizedRecord: SessionEventRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "model_message_completed", text: "x".repeat(1024 * 1024) },
  };

  try {
    for (const [name, store] of stores) {
      await expect(store.append(oversizedRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_too_large",
      });
      expect(await store.read(), name).toEqual([]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters reject the first append beyond the readable log bound", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-log-bound-",
    "session-log-bound",
  );
  const boundedText = "x".repeat(920 * 1024);

  try {
    for (const [name, store] of stores) {
      for (let sequence = 1; sequence <= 8; sequence += 1) {
        await store.append({
          schemaVersion: 1,
          runId,
          sequence,
          event: { type: "model_message_completed", text: boundedText },
        });
      }
      await expect(
        store.append({
          schemaVersion: 1,
          runId,
          sequence: 9,
          event: { type: "model_message_completed", text: boundedText },
        }),
        name,
      ).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_too_large",
      });
      expect(await store.read(), name).toHaveLength(8);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters reject an out-of-sequence append before modifying history", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-order-contract-",
    "session-order-contract",
  );

  try {
    for (const [name, store] of stores) {
      await expect(
        store.append({
          schemaVersion: 1,
          runId,
          sequence: 2,
          event: { type: "model_message_started" },
        }),
        name,
      ).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
      expect(await store.read(), name).toEqual([]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore restores owner-only session file permissions", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-mode-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = await createJsonlSessionStore({
    stateRoot,
    workspaceRoot,
    sessionId: "session-mode",
  });

  try {
    await store.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      event: { type: "user_message", text: "First record" },
    });
    const storedPaths = await readdir(stateRoot, { recursive: true });
    const sessionRelativePath = storedPaths.find((path) => path.endsWith(".jsonl"));
    if (sessionRelativePath === undefined) {
      throw new Error("The JSONL session file was not created.");
    }
    const sessionPath = join(stateRoot, sessionRelativePath);
    await chmod(sessionPath, 0o644);

    await store.append({
      schemaVersion: 1,
      runId,
      sequence: 2,
      event: { type: "model_message_started" },
    });

    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore restores owner-only session directory permissions", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-directory-mode-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const options = {
    stateRoot,
    workspaceRoot,
    sessionId: "session-directory-mode",
  } as const;

  try {
    await createJsonlSessionStore({ ...options, sessionId: "session-directory-mode-repair" });
    const storedPaths = await readdir(stateRoot, { recursive: true });
    const sessionsRelativePath = storedPaths.find((path) => path.endsWith("sessions"));
    if (sessionsRelativePath === undefined) {
      throw new Error("The JSONL sessions directory was not created.");
    }
    const sessionsPath = join(stateRoot, sessionsRelativePath);
    await chmod(sessionsPath, 0o755);

    await createJsonlSessionStore(options);

    expect((await stat(sessionsPath)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function createContractStores(prefix: string, sessionId: string) {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  return {
    testRoot,
    stores: [
      ["in-memory", createInMemorySessionStore()],
      [
        "JSONL",
        await createJsonlSessionStore({
          stateRoot: join(testRoot, "state"),
          workspaceRoot,
          sessionId,
        }),
      ],
    ] as const,
  };
}
