import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createPermissionPolicy,
  createPresentationSession,
  type SessionRecord,
  type SessionStore,
  SessionStoreError,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  presentationSessionRecordReader,
  type SessionStoreDirectory,
  sessionLogicalRunStartedBarrier,
  sessionToolProfileNames,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity,
} from "./session-lifecycle.test-support.js";

const sensitiveDetail = "PRIVATE_STORAGE_ARGUMENT_CANARY";

function searchDriver(onCall?: () => void, callId = "fault-call") {
  return new FakeModelDriver((request) => {
    if (request.purpose === "title")
      return [
        { type: "text_delta", text: "Execution failure fixture" },
        { type: "finish", reason: "stop" },
      ];
    onCall?.();
    if (request.messages.at(-1)?.role === "user")
      return [
        { type: "tool_call_start", id: callId, name: "search_repository" },
        {
          type: "tool_call_delta",
          id: callId,
          json: JSON.stringify({ kind: "path", query: sensitiveDetail, cursor: "invalid" }),
        },
        { type: "tool_call_end", id: callId },
        { type: "finish", reason: "tool_calls" },
      ];
    return [
      { type: "text_delta", text: "Search feedback delivered." },
      { type: "finish", reason: "stop" },
    ];
  });
}

function isToolResult(record: SessionRecord) {
  return (
    record.schemaVersion === 3 &&
    record.record.type === "runtime_event" &&
    (record.record.event.type === "tool_failed" || record.record.event.type === "tool_completed")
  );
}

test.each([
  "encoding",
  "opaque",
  "generic_store_error",
  "malformed_metadata",
  "throwing_metadata",
  "committed_then_rejected",
] as const)(
  "%s storage failure exposes only bounded facts and never retries a terminal",
  async (mode) => {
    const backing = createInMemorySessionStore();
    const attempts: SessionRecord[] = [];
    const store: SessionStore = {
      async append(record) {
        attempts.push(record);
        if (!isToolResult(record)) return backing.append(record);
        if (mode === "encoding") {
          if (
            record.schemaVersion !== 3 ||
            record.record.type !== "runtime_event" ||
            record.record.event.type !== "tool_failed"
          )
            throw new Error("Expected the real search failure.");
          return backing.append({
            ...record,
            record: {
              ...record.record,
              event: {
                ...record.record.event,
                error: { code: "unknown_error", message: sensitiveDetail },
              },
            },
          } as unknown as SessionRecord);
        }
        if (mode === "committed_then_rejected") await backing.append(record);
        if (mode === "generic_store_error") throw new SessionStoreError();
        if (mode === "malformed_metadata")
          throw new SessionStoreError("session_log_invalid", {
            category: "storage_io_failed",
            stage: "open",
            writeOutcome: "not_written",
            reason: "permission_denied",
            rawArguments: sensitiveDetail,
          } as never);
        if (mode === "throwing_metadata") {
          const failure = new SessionStoreError();
          Object.defineProperty(failure, "appendFailure", {
            get() {
              throw new Error(sensitiveDetail);
            },
          });
          throw failure;
        }
        throw new Error(sensitiveDetail);
      },
      async appendBatch(records) {
        for (const record of records) await this.append(record);
      },
      read: () => backing.read(),
    };
    let modelCalls = 0;
    const result = await new AgentSession({
      store,
      model: searchDriver(() => {
        modelCalls += 1;
      }),
      tools: createCodingToolRegistry({ workspaceRoot: process.cwd() }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      maximumOutputTokens: 4096,
    }).run({ text: "Search once." });
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "session_persistence_failed" },
      executionFailure: {
        category: mode === "encoding" ? "encoding_rejected" : "append_outcome_uncertain",
        stage: mode === "encoding" ? "admission" : "adapter",
        writeOutcome: mode === "encoding" ? "not_written" : "uncertain",
        phase: "tool_result",
        sessionId: null,
        callId: "fault-call",
        attemptedSequence: 7,
      },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
    expect(result).not.toHaveProperty("executionFailure.rawArguments");
    expect(modelCalls).toBe(1);
    expect(attempts.filter(isToolResult)).toHaveLength(1);
    expect(
      attempts.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "session_settled",
      ),
    ).toBe(false);
    expect((await backing.read()).at(-1)).toMatchObject({
      record: {
        type: "runtime_event",
        event: { type: mode === "committed_then_rejected" ? "tool_failed" : "tool_started" },
      },
    });
    const codec = createInMemorySessionStore();
    await expect(
      codec.append({
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "runtime_event",
          runId: "123e4567-e89b-42d3-a456-426614174000",
          event: { type: "session_settled", result },
        },
      } as unknown as SessionRecord),
    ).rejects.toMatchObject({ code: "session_log_invalid" });
  },
);

test("an unexpected external tool exception retains call identity without exposing its raw error", async () => {
  const outputSchema = createCodingToolRegistry({ workspaceRoot: process.cwd() }).resolve(
    "read_file",
  )?.outputSchema;
  if (outputSchema === undefined) throw new Error("Expected a registered read-result schema.");
  const adapter: NonNullable<ReturnType<ToolRegistry["resolve"]>> = {
    definition: {
      name: "external_reader",
      description: "An external read adapter.",
      inputSchema: { type: "object", properties: {} },
    },
    definitionDigest: `sha256:${"a".repeat(64)}`,
    outputSchema,
    effect: "read",
    replay: "safe",
    cancellation: "unsupported",
    maximumResult: { maximumBytes: 1024 },
    prepare() {
      return {
        status: "ready",
        permissionSubject: { type: "workspace_path", path: "." },
        async execute() {
          throw new Error(sensitiveDetail);
        },
      };
    },
  };
  const store = createInMemorySessionStore();
  let modelCalls = 0;
  const dependencies = {
    [sessionToolProfileNames]: ["external_reader"],
    store,
    tools: {
      definitions: () => [adapter.definition],
      resolve: (name: string) => (name === "external_reader" ? adapter : undefined),
    },
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    maximumOutputTokens: 4096,
    model: new FakeModelDriver(() => {
      modelCalls += 1;
      if (modelCalls > 1)
        return [
          { type: "text_delta", text: "Unexpected feedback." },
          { type: "finish", reason: "stop" },
        ];
      return [
        { type: "tool_call_start", id: "external-failure", name: "external_reader" },
        { type: "tool_call_delta", id: "external-failure", json: "{}" },
        { type: "tool_call_end", id: "external-failure" },
        { type: "finish", reason: "tool_calls" },
      ];
    }),
  };
  const session = new AgentSession(dependencies);
  const result = await session.run({ text: "Read from the external adapter." });
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "session_execution_failed" },
    executionFailure: {
      category: "execution_failed",
      stage: "execution",
      phase: "tool_execution",
      callId: "external-failure",
      message: "Execution stopped unexpectedly.",
    },
  });
  expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
  expect(modelCalls).toBe(1);
  expect((await store.read()).at(-1)).toMatchObject({
    record: { type: "runtime_event", event: { type: "tool_started", callId: "external-failure" } },
  });
});

test("a failed append followed by unavailable reads keeps the last snapshot and blocks the editor", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-execution-read-fault-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  let fail = false;
  let readsUnavailable = false;
  let beforeFailure: readonly SessionRecord[] | undefined;
  const wrap = (store: SessionStore): SessionStore => ({
    async append(record) {
      if (fail && record.schemaVersion === 3 && record.record.type === "logical_run_started") {
        beforeFailure = await store.read();
        readsUnavailable = true;
        throw new Error(sensitiveDetail);
      }
      await store.append(record);
    },
    async appendBatch(records) {
      for (const record of records) await this.append(record);
    },
    async read() {
      if (readsUnavailable) throw new Error(sensitiveDetail);
      return store.read();
    },
  });
  const directory: SessionStoreDirectory = {
    create: async (id) => wrap(await backing.create(id)),
    open: async (id) => {
      const store = await backing.open(id);
      return store === undefined ? undefined : wrap(store);
    },
    listSessionIds: () => backing.listSessionIds(),
    listSessionEntries: () => backing.listSessionEntries(),
  };
  const harness = createInMemorySessionLifecycleHarness(directory);
  const modelTargets = modelTargetsWithDriver(
    new FakeModelDriver([
      { type: "text_delta", text: "Confirmed first run." },
      { type: "finish", reason: "stop" },
    ]),
  );
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets,
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Complete the first run." },
    });
    const before = await (await backing.open(created.sessionId))?.read();
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot: join(root, "state"),
      sessionId: created.sessionId,
      projectLabel: "workspace",
      [presentationSessionRecordReader]: async (id) =>
        (await (await directory.open(id))?.read()) ?? [],
    });
    expect(presentation.getState().authoritative.active?.parentRun).toEqual({
      phase: "ready",
      editor: "ready",
    });
    fail = true;
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Attempt a second run.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(presentation.getState()).toMatchObject({
      executionFailure: { category: "append_outcome_uncertain", sessionId: created.sessionId },
      authoritative: {
        continuity: { status: "degraded" },
        active: {
          parentRun: { phase: "interrupted", editor: "blocked" },
          transcript: {
            items: expect.arrayContaining([
              expect.objectContaining({ type: "assistant_message", text: "Confirmed first run." }),
            ]),
          },
        },
      },
    });
    expect(await (await backing.open(created.sessionId))?.read()).toEqual(beforeFailure);
    expect(beforeFailure?.slice(0, before?.length)).toEqual(before);
  } finally {
    readsUnavailable = false;
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed explicit cancellation projects its new fault and switching sessions never resurrects it", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-fault-cancel-switch-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  let mode: "encoding" | "opaque" | "healthy" = "encoding";
  const wrap = (store: SessionStore): SessionStore => ({
    async append(record) {
      if (isToolResult(record) && mode === "opaque") throw new Error(sensitiveDetail);
      if (
        isToolResult(record) &&
        mode === "encoding" &&
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "tool_failed"
      )
        return store.append({
          ...record,
          record: {
            ...record.record,
            event: {
              ...record.record.event,
              error: { code: "unknown_error", message: sensitiveDetail },
            },
          },
        } as unknown as SessionRecord);
      await store.append(record);
    },
    async appendBatch(records) {
      for (const record of records) await this.append(record);
    },
    read: () => store.read(),
  });
  const directory: SessionStoreDirectory = {
    create: async (id) => wrap(await backing.create(id)),
    open: async (id) => {
      const store = await backing.open(id);
      return store === undefined ? undefined : wrap(store);
    },
    listSessionIds: () => backing.listSessionIds(),
    listSessionEntries: () => backing.listSessionEntries(),
  };
  const harness = createInMemorySessionLifecycleHarness(directory);
  let modelCalls = 0;
  const modelTargets = modelTargetsWithDriver(
    searchDriver(() => {
      modelCalls += 1;
    }),
  );
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const first = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    const second = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    mode = "healthy";
    await lifecycle.continue({
      sessionId: second.sessionId,
      input: { text: "Make the second Session selectable." },
    });
    modelCalls = 0;
    mode = "encoding";
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot: join(root, "state"),
      sessionId: first.sessionId,
      projectLabel: "workspace",
      [presentationSessionRecordReader]: async (id) =>
        (await (await directory.open(id))?.read()) ?? [],
    });
    const interrupted = Promise.withResolvers<void>();
    presentation.subscribe(() => {
      if (presentation?.getState().authoritative.active?.parentRun?.phase === "interrupted")
        interrupted.resolve();
    });
    await presentation.dispatch({
      type: "submit_prompt",
      sessionId: first.sessionId,
      text: "Search before failure.",
      skills: [],
      thinkingSelection: null,
    });
    await withManagedFailureGuard(
      interrupted.promise,
      "The failed Run was not shown as interrupted.",
    );
    expect(presentation.getState().executionFailure?.category).toBe("encoding_rejected");
    const recovery = presentation.getState().authoritative.active?.recovery;
    if (recovery === undefined) throw new Error("Expected the exact interrupted Run identity.");
    const before = await (await backing.open(first.sessionId))?.read();
    mode = "opaque";
    await expect(
      presentation.dispatch({
        type: "cancel_interrupted_session",
        sessionId: first.sessionId,
        runId: recovery.runId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(presentation.getState()).toMatchObject({
      executionFailure: {
        category: "append_outcome_uncertain",
        phase: "tool_result",
        sessionId: first.sessionId,
        runId: recovery.runId,
        callId: "fault-call",
      },
      authoritative: { active: { parentRun: { phase: "interrupted", editor: "blocked" } } },
    });
    expect(await (await backing.open(first.sessionId))?.read()).toEqual(before);
    await expect(
      presentation.dispatch({ type: "select_session", sessionId: second.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState()).not.toHaveProperty("executionFailure");
    await expect(
      presentation.dispatch({ type: "select_session", sessionId: first.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState()).not.toHaveProperty("executionFailure");
    mode = "healthy";
    await expect(
      presentation.dispatch({
        type: "cancel_interrupted_session",
        sessionId: first.sessionId,
        runId: recovery.runId,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState()).not.toHaveProperty("executionFailure");
    expect(presentation.getState().authoritative.active?.parentRun).toEqual({
      phase: "ready",
      editor: "ready",
    });
    expect((await (await backing.open(first.sessionId))?.read())?.at(-1)).toMatchObject({
      record: {
        type: "runtime_event",
        event: { type: "session_settled", result: { status: "cancelled" } },
      },
    });
    expect(modelCalls).toBe(1);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown required execution failure is visible without inventing a durable terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-unknown-execution-view-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  let modelCalls = 0;
  const modelTargets = modelTargetsWithDriver(
    searchDriver(() => {
      modelCalls += 1;
    }),
  );
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets,
    [sessionLogicalRunStartedBarrier]: {
      afterDurableRecord() {
        throw new Error(sensitiveDetail);
      },
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot: join(root, "state"),
      sessionId: created.sessionId,
      projectLabel: "workspace",
      [presentationSessionRecordReader]: async (id) =>
        (await (await harness.sessions.open(id))?.read()) ?? [],
    });
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Stop at the required gate.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(presentation.getState()).toMatchObject({
      executionFailure: {
        category: "execution_failed",
        sessionId: created.sessionId,
        runId: expect.any(String),
        message: "Execution stopped unexpectedly.",
      },
      authoritative: { active: { parentRun: { phase: "interrupted", editor: "blocked" } } },
    });
    expect(JSON.stringify(presentation.getState().executionFailure)).not.toContain(sensitiveDetail);
    expect((await (await harness.sessions.open(created.sessionId))?.read())?.at(-1)).toMatchObject({
      record: { type: "logical_run_started" },
    });
    expect(modelCalls).toBe(0);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent caller abort preserves the original append failure without cancellation writes", async () => {
  const backing = createInMemorySessionStore();
  const controller = new AbortController();
  const attempted: SessionRecord[] = [];
  const store: SessionStore = {
    async append(record) {
      attempted.push(record);
      if (isToolResult(record)) {
        controller.abort();
        throw new Error(sensitiveDetail);
      }
      await backing.append(record);
    },
    async appendBatch(records) {
      for (const record of records) await this.append(record);
    },
    read: () => backing.read(),
  };
  let calls = 0;
  const session = new AgentSession({
    store,
    model: searchDriver(() => {
      calls += 1;
    }),
    tools: createCodingToolRegistry({ workspaceRoot: process.cwd() }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    maximumOutputTokens: 4096,
  });
  const result = await session.run(
    { text: "Search before the concurrent cancellation." },
    { signal: controller.signal },
  );
  expect(result).toMatchObject({
    status: "failed",
    executionFailure: {
      category: "append_outcome_uncertain",
      phase: "tool_result",
      callId: "fault-call",
      attemptedSequence: 7,
    },
  });
  expect(attempted.filter(isToolResult)).toHaveLength(1);
  expect(
    attempted.some(
      (record) =>
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        ["session_interrupted", "session_settled"].includes(record.record.event.type),
    ),
  ).toBe(false);
  expect((await backing.read()).at(-1)).toMatchObject({
    record: { type: "runtime_event", event: { type: "tool_started" } },
  });
  expect(calls).toBe(1);
});
