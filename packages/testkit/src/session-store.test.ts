import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemorySessionStore,
  createJsonlSessionStore,
  type SessionEventRecord,
  SessionStoreError,
} from "@adam-agent/agent";
import {
  type ContextProfile,
  createInMemorySessionStoreDirectory,
  createJsonlSessionStoreDirectory,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
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

test("SessionStoreDirectory adapters create open and list isolated session stores", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-directory-contract-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const secondSessionId = "10000000-0000-4000-8000-000000000002";
  const directories = [
    ["in-memory", createInMemorySessionStoreDirectory<SessionEventRecord>()],
    [
      "JSONL",
      createJsonlSessionStoreDirectory<SessionEventRecord>({
        stateRoot: join(testRoot, "state"),
        workspaceRoot,
      }),
    ],
  ] as const;
  const record: SessionEventRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "user_message", text: "Directory contract" },
  };

  try {
    for (const [name, directory] of directories) {
      expect(await directory.listSessionEntries(), name).toEqual([]);
      expect(await directory.listSessionIds(), name).toEqual([]);
      expect(await directory.open(sessionId), name).toBeUndefined();
      const created = await directory.create(sessionId);
      await created.append(record);
      const second = await directory.create(secondSessionId);
      expect(await second.read(), name).toEqual([]);

      await expect(directory.create(sessionId), name).rejects.toMatchObject({
        code: "session_log_exists",
      });
      expect(await directory.listSessionIds(), name).toEqual([sessionId, secondSessionId]);
      expect(await directory.listSessionEntries(), name).toEqual([
        { sessionId, modifiedAtMilliseconds: expect.any(Number) },
        { sessionId: secondSessionId, modifiedAtMilliseconds: expect.any(Number) },
      ]);
      await expect(
        directory.open(sessionId).then((store) => store?.read()),
        name,
      ).resolves.toEqual([record]);
      await expect(
        directory.open(secondSessionId).then((store) => store?.read()),
        name,
      ).resolves.toBeUndefined();
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
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

test("SessionStore adapters preserve additive v3 compaction records", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-context-store-contract-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const contextProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 800,
    maximumOutputTokens: 100,
    compactAtTokens: 500,
    postCompactTargetTokens: 400,
    retainedTargetTokens: 100,
    estimatorVersion: 1,
  };
  const targetIdentity = {
    targetId: "fake.local",
    vendor: "adam",
    modelId: "fake",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const sessionId = "10000000-0000-4000-8000-000000000010";
  const attemptId = "10000000-0000-4000-8000-000000000011";
  const checkpointId = "10000000-0000-4000-8000-000000000012";
  const records: readonly SessionRecord[] = [
    {
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        sessionId,
        projectId: `sha256:${"a".repeat(64)}`,
        targetIdentity,
      },
    },
    {
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Persist a context checkpoint.",
      },
    },
    {
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "context_compaction_started",
        recordVersion: 1,
        runId,
        attemptId,
        attemptNumber: 1,
        windowNumber: 1,
        trigger: "automatic_threshold",
        sourceThrough: 2,
        targetIdentity,
        contextProfile,
        projectionVersion: 1,
        sourceDigest: `sha256:${"b".repeat(64)}`,
        projectedContent: {
          version: 1,
          explicitUserImages: {
            count: 1,
            byteCount: 68,
            pixelCount: 1,
            maximumWidth: 1,
            maximumHeight: 1,
          },
        },
      },
    },
    {
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "context_compaction_committed",
        recordVersion: 1,
        runId,
        attemptId,
        attemptNumber: 1,
        checkpointId,
        windowNumber: 1,
        trigger: "automatic_threshold",
        sourceThrough: 2,
        retainedFrom: 3,
        targetIdentity,
        contextProfile,
        projectionVersion: 1,
        sourceDigest: `sha256:${"b".repeat(64)}`,
        replacementDigest: `sha256:${"c".repeat(64)}`,
        summary: {
          schemaVersion: 1,
          objective: "Persist the checkpoint.",
          constraints: [],
          progress: [],
          unresolvedQuestions: [],
          failures: [],
          remainingVerification: [],
          nextSafeAction: "Read it back.",
        },
        evidence: {
          schemaVersion: 1,
          modifiedFiles: [],
          permissions: [],
          toolResults: [],
          failures: [],
        },
        usage: { inputTokens: 20, outputTokens: 5 },
      },
    },
  ];
  const stores = [
    ["in-memory", createInMemorySessionStore<SessionRecord>()],
    [
      "JSONL",
      await createJsonlSessionStore<SessionRecord>({
        stateRoot: join(testRoot, "state"),
        workspaceRoot,
        sessionId,
      }),
    ],
  ] as const;

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

test("SessionStore adapters append one validated record batch all-or-none before one durable read", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-atomic-batch-",
    "session-atomic-batch",
  );
  const first: SessionEventRecord = {
    schemaVersion: 2,
    runId,
    sequence: 1,
    event: { type: "user_message", text: "first" },
  };
  const second: SessionEventRecord = {
    schemaVersion: 2,
    runId,
    sequence: 2,
    event: { type: "model_message_started" },
  };
  const wrongSequence: SessionEventRecord = { ...second, sequence: 3 };

  try {
    for (const [name, store] of stores) {
      await expect(store.appendBatch([first, wrongSequence]), name).rejects.toBeInstanceOf(
        SessionStoreError,
      );
      expect(await store.read(), name).toEqual([]);
      await store.appendBatch([first, second]);
      expect(await store.read(), name).toEqual([first, second]);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore adapters do not widen the historical v2 tool-error schema", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-v2-input-resource-error-",
    "session-v2-input-resource-error",
  );
  const invalidRecord = {
    schemaVersion: 2,
    runId,
    sequence: 1,
    event: {
      type: "tool_failed",
      callId: "historical-call",
      name: "read_input_resource",
      error: {
        code: "input_resource_not_visible",
        message: "This error did not exist in the historical v2 contract.",
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

test.each(["invalid UTF-8", "torn final line"] as const)(
  "JSONL SessionStore rejects %s with the bounded line reader",
  async (damage) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-bounded-line-reader-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const store = await createJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: "session-bounded-line-reader",
    });

    try {
      const storedPaths = await readdir(stateRoot, { recursive: true });
      const sessionRelativePath = storedPaths.find((path) => path.endsWith(".jsonl"));
      if (sessionRelativePath === undefined) {
        throw new Error("The JSONL session file was not created.");
      }
      const validLine = JSON.stringify({
        schemaVersion: 2,
        runId,
        sequence: 1,
        event: { type: "user_message", text: "valid" },
      });
      await writeFile(
        join(stateRoot, sessionRelativePath),
        damage === "torn final line"
          ? Buffer.from(validLine, "utf8")
          : Buffer.concat([Buffer.from(validLine.slice(0, -2), "utf8"), Buffer.from([0xff, 0x0a])]),
      );

      await expect(store.read()).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("JSONL SessionStore persists and reopens a canonical log above 8 MiB", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-expanded-session-store-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const options = { stateRoot, workspaceRoot, sessionId: "session-expanded" } as const;
  const store = await createJsonlSessionStore<SessionEventRecord>(options);
  const text = "j".repeat(450 * 1024);

  try {
    for (let index = 1; index <= 20; index += 1) {
      await store.append({
        schemaVersion: 2,
        runId,
        sequence: index,
        event: { type: "user_message", text },
      });
    }
    expect(await store.read()).toHaveLength(20);
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
    await writeFile(join(stateRoot, sessionRelativePath), "x".repeat(32 * 1024 * 1024 + 1), "utf8");

    await expect(store.read()).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "session_log_too_large",
      message: "The session log exceeds its read limit.",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("JSONL SessionStore rejects a restored overlong line below the physical log limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-overlong-session-record-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = await createJsonlSessionStore({
    stateRoot,
    workspaceRoot,
    sessionId: "session-overlong-record",
  });

  try {
    const storedPaths = await readdir(stateRoot, { recursive: true });
    const sessionRelativePath = storedPaths.find((path) => path.endsWith(".jsonl"));
    if (sessionRelativePath === undefined) {
      throw new Error("The JSONL session file was not created.");
    }
    await writeFile(
      join(stateRoot, sessionRelativePath),
      `${"x".repeat(1024 * 1024 + 1)}\n`,
      "utf8",
    );

    await expect(store.read()).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "session_log_too_large",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("separate parent and child JSONL files each receive their own physical log budget", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-independent-session-bounds-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const stores = await Promise.all(
    ["parent-session", "child-session"].map((sessionId) =>
      createJsonlSessionStore<SessionEventRecord>({ stateRoot, workspaceRoot, sessionId }),
    ),
  );
  const text = "x".repeat(920 * 1024);

  try {
    for (const store of stores) {
      for (let sequence = 1; sequence <= 18; sequence += 1) {
        await store.append({
          schemaVersion: 1,
          runId,
          sequence,
          event: { type: "model_message_completed", text },
        });
      }
    }

    const restored = await Promise.all(stores.map((store) => store.read()));
    expect(restored.map((records) => records.length)).toEqual([18, 18]);
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

test("SessionStore measures the inline response threshold in UTF-8 bytes", async () => {
  const { testRoot, stores } = await createContractStores<SessionRecord>(
    "adam-agent-session-inline-response-bound-",
    "session-inline-response-bound",
  );
  const oversizedInlineResponse = {
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "model_response_completed",
      runId,
      turn: 1,
      attempt: 1,
      targetIdentity: {
        targetId: "fake.local",
        vendor: "adam",
        modelId: "fake-local",
        route: "direct",
        profileVersion: 1,
        certification: "certified",
      },
      response: {
        recordVersion: 2,
        text: { storage: "inline", text: "界".repeat(90 * 1024) },
        toolCalls: [],
        toolIntents: [],
        finishReason: "stop",
      },
    },
  } as const;
  expect(oversizedInlineResponse.record.response.text.text.length).toBeLessThan(256 * 1024);
  expect(
    Buffer.byteLength(oversizedInlineResponse.record.response.text.text, "utf8"),
  ).toBeGreaterThan(256 * 1024);

  try {
    for (const [name, store] of stores) {
      await expect(
        store.append(oversizedInlineResponse as SessionRecord),
        name,
      ).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_invalid",
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionStore measures the 1 MiB record ceiling before the terminating LF", async () => {
  const { testRoot, stores } = await createContractStores(
    "adam-agent-session-exact-record-bound-",
    "session-exact-record-bound",
  );
  const emptyRecord: SessionEventRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "model_message_completed", text: "" },
  };
  const exactTextBytes = 1024 * 1024 - Buffer.byteLength(JSON.stringify(emptyRecord), "utf8");
  const exactText = "x".repeat(exactTextBytes);
  const exactRecord: SessionEventRecord = {
    ...emptyRecord,
    event: { type: "model_message_completed", text: exactText },
  };
  const oversizedRecord: SessionEventRecord = {
    ...exactRecord,
    sequence: 2,
    event: { type: "model_message_completed", text: `${exactText}x` },
  };
  expect(Buffer.byteLength(JSON.stringify(exactRecord), "utf8")).toBe(1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(oversizedRecord), "utf8")).toBe(1024 * 1024 + 1);

  try {
    for (const [name, store] of stores) {
      await expect(store.append(exactRecord), name).resolves.toBeUndefined();
      await expect(store.append(oversizedRecord), name).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_too_large",
      });
      expect(await store.read(), name).toEqual([exactRecord]);
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
      for (let sequence = 1; sequence <= 35; sequence += 1) {
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
          sequence: 36,
          event: { type: "model_message_completed", text: boundedText },
        }),
        name,
      ).rejects.toMatchObject({
        name: "SessionStoreError",
        code: "session_log_too_large",
      });
      expect(await store.read(), name).toHaveLength(35);
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

async function createContractStores<RecordType extends SessionRecord = SessionEventRecord>(
  prefix: string,
  sessionId: string,
) {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  return {
    testRoot,
    stores: [
      ["in-memory", createInMemorySessionStore<RecordType>()],
      [
        "JSONL",
        await createJsonlSessionStore<RecordType>({
          stateRoot: join(testRoot, "state"),
          workspaceRoot,
          sessionId,
        }),
      ],
    ] as const,
  };
}
