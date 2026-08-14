import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type AgentSessionDependencies,
  createInMemorySessionStore,
  createJsonlSessionStore,
  createMutationToolRegistry,
  createPermissionPolicy,
  createReadToolRegistry,
  type ModelDriver,
  type RuntimeEvent,
  type SessionEventRecord,
  type SessionStore,
} from "@adam-agent/agent";
import { describe, expect, test } from "vitest";

import { FakeModelDriver } from "./index.js";

const cancelledResult = {
  status: "cancelled",
  error: {
    code: "session_cancelled",
    message: "The session was cancelled.",
  },
} as const;

describe("AgentSession", () => {
  test("an answer-only turn emits ordered events and returns its terminal result", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "Adam." },
      { type: "finish", reason: "stop" },
    ]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Introduce yourself" });

    expect(result).toEqual({ status: "completed", answer: "Hello, Adam." });
    expect(events).toEqual([
      { type: "user_message", text: "Introduce yourself" },
      { type: "model_message_started" },
      { type: "model_message_delta", text: "Hello, " },
      { type: "model_message_delta", text: "Adam." },
      { type: "model_message_completed", text: "Hello, Adam." },
      {
        type: "session_settled",
        result: { status: "completed", answer: "Hello, Adam." },
      },
    ]);
  });

  test.each(["in-memory", "JSONL"] as const)(
    "%s store persists canonical events while keeping text deltas live-only",
    async (storeKind) => {
      const storeHarness = await createAgentSessionStore(storeKind);
      const model = new FakeModelDriver([
        { type: "text_delta", text: "Durable answer." },
        { type: "finish", reason: "stop" },
      ]);
      const { store } = storeHarness;
      const session = createTestSession({ model, store });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      try {
        const result = await session.run({ text: "Persist this turn" });

        expect({ result, events, records: await store.read() }).toEqual({
          result: { status: "completed", answer: "Durable answer." },
          events: [
            { type: "user_message", text: "Persist this turn" },
            { type: "model_message_started" },
            { type: "model_message_delta", text: "Durable answer." },
            { type: "model_message_completed", text: "Durable answer." },
            {
              type: "session_settled",
              result: { status: "completed", answer: "Durable answer." },
            },
          ],
          records: [
            {
              schemaVersion: 1,
              runId: expect.any(String),
              sequence: 1,
              event: { type: "user_message", text: "Persist this turn" },
            },
            {
              schemaVersion: 1,
              runId: expect.any(String),
              sequence: 2,
              event: { type: "model_message_started" },
            },
            {
              schemaVersion: 1,
              runId: expect.any(String),
              sequence: 3,
              event: { type: "model_message_completed", text: "Durable answer." },
            },
            {
              schemaVersion: 1,
              runId: expect.any(String),
              sequence: 4,
              event: {
                type: "session_settled",
                result: { status: "completed", answer: "Durable answer." },
              },
            },
          ],
        });
      } finally {
        await storeHarness.cleanup();
      }
    },
  );

  test("fails before publishing or calling the model when the first event cannot persist", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-persistence-failure-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const store = await createJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: "session-failure",
    });
    let modelWasCalled = false;
    const model = new FakeModelDriver(() => {
      modelWasCalled = true;
      return [{ type: "finish", reason: "stop" }];
    });
    const session = createTestSession({ model, store });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await chmod(stateRoot, 0o400);

      const result = await session.run({ text: "Do not start" });

      expect({ result, events, modelWasCalled }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "session_persistence_failed",
            message: "The session event could not be persisted.",
          },
        },
        events: [],
        modelWasCalled: false,
      });
    } finally {
      await chmod(stateRoot, 0o700);
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("abort settles an active model wait once as cancelled", async () => {
    let markModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model: ModelDriver = {
      async *stream(request) {
        markModelStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const store = createInMemorySessionStore();
    const session = createTestSession({ model, store });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const pendingResult = session.run({ text: "Wait for cancellation" });
    await modelStarted;
    session.abort();
    session.abort();
    const result = await pendingResult;

    expect({
      result,
      settledEvents: events.filter((event) => event.type === "session_settled"),
      finalRecord: (await store.read()).at(-1),
    }).toEqual({
      result: cancelledResult,
      settledEvents: [{ type: "session_settled", result: cancelledResult }],
      finalRecord: {
        schemaVersion: 1,
        runId: expect.any(String),
        sequence: 4,
        event: { type: "session_settled", result: cancelledResult },
      },
    });
  });

  test("persists one stable run identity and an interruption before cancelled settlement", async () => {
    let markModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model: ModelDriver = {
      async *stream(request) {
        markModelStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const store = createInMemorySessionStore();
    const session = createTestSession({ model, store });

    const pendingResult = session.run({ text: "Persist the interruption" });
    await modelStarted;
    session.abort();
    await pendingResult;
    const records = await store.read();

    expect(new Set(records.map((record) => record.runId)).size).toBe(1);
    expect(records[0]?.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(records.map((record) => record.event.type)).toEqual([
      "user_message",
      "model_message_started",
      "session_interrupted",
      "session_settled",
    ]);
  });

  test("does not retry a cancellation terminal transition after persistence fails", async () => {
    let markModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model: ModelDriver = {
      async *stream(request) {
        markModelStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const records: SessionEventRecord[] = [];
    const store: SessionStore = {
      async append(record) {
        records.push(record);
        if (record.event.type === "session_interrupted") {
          throw new Error("The durable write completed before the adapter reported failure.");
        }
      },
      async read() {
        return records;
      },
    };
    const session = createTestSession({ model, store });

    const pendingResult = session.run({ text: "Cancel exactly once" });
    await modelStarted;
    session.abort();
    const result = await pendingResult;

    expect({
      result,
      interruptionCount: records.filter((record) => record.event.type === "session_interrupted")
        .length,
    }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "session_persistence_failed",
          message: "The session event could not be persisted.",
        },
      },
      interruptionCount: 1,
    });
  });

  test("a caller AbortSignal converges on the same cancelled terminal state", async () => {
    let markModelStarted: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model: ModelDriver = {
      async *stream(request) {
        markModelStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const session = createTestSession({ model });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const pendingResult = session.run(
      { text: "Cancel from the caller" },
      { signal: controller.signal },
    );
    await modelStarted;
    controller.abort();
    const result = await pendingResult;

    expect({
      result,
      settledEvents: events.filter((event) => event.type === "session_settled"),
    }).toEqual({
      result: cancelledResult,
      settledEvents: [{ type: "session_settled", result: cancelledResult }],
    });
  });

  test("a pre-aborted caller signal never starts the model", async () => {
    let modelCalls = 0;
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return [{ type: "finish", reason: "stop" }];
    });
    const controller = new AbortController();
    controller.abort();
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Already cancelled" }, { signal: controller.signal });

    expect({ result, modelCalls, events }).toEqual({
      result: cancelledResult,
      modelCalls: 0,
      events: [
        { type: "user_message", text: "Already cancelled" },
        { type: "session_interrupted", reason: "cancelled" },
        { type: "session_settled", result: cancelledResult },
      ],
    });
  });

  test("rejects a concurrent run without taking cancellation ownership from the active run", async () => {
    let markModelStarted: (() => void) | undefined;
    let releaseModel: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const model: ModelDriver = {
      async *stream() {
        markModelStarted?.();
        await modelReleased;
        yield { type: "finish", reason: "stop" };
      },
    };
    const store = createInMemorySessionStore();
    const session = createTestSession({ model, store });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const activeRun = session.run({ text: "Keep this run active" });
    await modelStarted;
    const concurrentRun = session.run({ text: "Do not start this run" });
    session.abort();
    releaseModel?.();
    const [concurrentResult, activeResult] = await Promise.all([concurrentRun, activeRun]);

    expect({ concurrentResult, activeResult, events }).toEqual({
      concurrentResult: {
        status: "failed",
        error: {
          code: "run_already_active",
          message: "The session already has an active run.",
        },
      },
      activeResult: cancelledResult,
      events: [
        { type: "user_message", text: "Keep this run active" },
        { type: "model_message_started" },
        { type: "session_interrupted", reason: "cancelled" },
        { type: "session_settled", result: cancelledResult },
      ],
    });
  });

  test("cancellation after one tool completes prevents later tool and model work", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-tool-cancellation-"));
    await writeFile(join(workspaceRoot, "first.txt"), "first\n", "utf8");
    await writeFile(join(workspaceRoot, "second.txt"), "second\n", "utf8");
    let modelCalls = 0;
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return modelCalls === 1
        ? [
            { type: "tool_call_start", id: "call-first", name: "read_file" },
            { type: "tool_call_delta", id: "call-first", json: '{"path":"first.txt"}' },
            { type: "tool_call_end", id: "call-first" },
            { type: "tool_call_start", id: "call-second", name: "read_file" },
            { type: "tool_call_delta", id: "call-second", json: '{"path":"second.txt"}' },
            { type: "tool_call_end", id: "call-second" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "A later model turn started." },
            { type: "finish", reason: "stop" },
          ];
    });
    const session = createTestSession({
      model,
      tools: createReadToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_completed" && event.callId === "call-first") {
        session.abort();
      }
    });

    try {
      const result = await session.run({ text: "Read both files unless cancelled" });

      expect({
        result,
        modelCalls,
        secondToolEvents: events.filter(
          (event) => "callId" in event && event.callId === "call-second",
        ),
      }).toEqual({
        result: cancelledResult,
        modelCalls: 1,
        secondToolEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("cancellation before terminal settlement cannot be overwritten by model success", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "This answer was interrupted." },
      { type: "finish", reason: "stop" },
    ]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "model_message_completed") {
        session.abort();
      }
    });

    const result = await session.run({ text: "Cancel before success settles" });

    expect({ result, finalEvents: events.slice(-2) }).toEqual({
      result: cancelledResult,
      finalEvents: [
        { type: "session_interrupted", reason: "cancelled" },
        { type: "session_settled", result: cancelledResult },
      ],
    });
  });

  test("cancellation stops publishing buffered provider events", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "first" },
      { type: "text_delta", text: "second" },
      { type: "finish", reason: "stop" },
    ]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "model_message_delta") {
        session.abort();
      }
    });

    const result = await session.run({ text: "Stop the buffered stream" });

    expect({
      result,
      deltas: events
        .filter((event) => event.type === "model_message_delta")
        .map((event) => event.text),
    }).toEqual({
      result: cancelledResult,
      deltas: ["first"],
    });
  });

  test("turn limits stop before the next model invocation", async () => {
    let modelCalls = 0;
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return [
        { type: "tool_call_start", id: "call-limited", name: "missing_tool" },
        { type: "tool_call_delta", id: "call-limited", json: "{}" },
        { type: "tool_call_end", id: "call-limited" },
        { type: "finish", reason: "tool_calls" },
      ];
    });
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run(
      { text: "Do not exceed one model turn" },
      { limits: { maxTurns: 1 } },
    );

    expect({ result, modelCalls, finalEvent: events.at(-1) }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "turn_limit_exceeded",
          message: "The run reached its model turn limit.",
        },
      },
      modelCalls: 1,
      finalEvent: {
        type: "session_settled",
        result: {
          status: "failed",
          error: {
            code: "turn_limit_exceeded",
            message: "The run reached its model turn limit.",
          },
        },
      },
    });
  });

  test.each([
    ["NaN turn limit", { maxTurns: Number.NaN }],
    ["infinite token limit", { maxTokens: Number.POSITIVE_INFINITY }],
    ["negative turn limit", { maxTurns: -1 }],
    ["fractional token limit", { maxTokens: 1.5 }],
  ] as const)("rejects a %s before starting a run", async (_name, limits) => {
    let modelCalls = 0;
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return [{ type: "finish", reason: "stop" }];
    });
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Use a valid finite limit" }, { limits });

    expect({ result, modelCalls, events }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "invalid_run_limits",
          message: "Run limits must be positive safe integers.",
        },
      },
      modelCalls: 0,
      events: [],
    });
  });

  test("provider-reported token limits stop before a requested tool", async () => {
    const model = new FakeModelDriver([
      { type: "tool_call_start", id: "call-over-budget", name: "read_file" },
      {
        type: "tool_call_delta",
        id: "call-over-budget",
        json: '{"path":"README.md"}',
      },
      { type: "tool_call_end", id: "call-over-budget" },
      { type: "usage", inputTokens: 6, outputTokens: 5 },
      { type: "finish", reason: "tool_calls" },
    ]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run(
      { text: "Stop before the tool" },
      { limits: { maxTokens: 10 } },
    );

    expect({
      result,
      usageEvents: events.filter((event) => event.type === "model_usage"),
      toolEvents: events.filter((event) => event.type.startsWith("tool_")),
    }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "token_limit_exceeded",
          message: "The run reached its provider-reported token limit.",
        },
      },
      usageEvents: [{ type: "model_usage", inputTokens: 6, outputTokens: 5, totalTokens: 11 }],
      toolEvents: [],
    });
  });

  test("active token limits fail closed when provider usage is missing", async () => {
    let modelCalls = 0;
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return modelCalls === 1
        ? [
            { type: "tool_call_start", id: "call-no-usage", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-no-usage",
              json: '{"path":"README.md"}',
            },
            { type: "tool_call_end", id: "call-no-usage" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "This second turn must not run." },
            { type: "finish", reason: "stop" },
          ];
    });
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run(
      { text: "Require provider usage" },
      { limits: { maxTokens: 100 } },
    );

    expect({
      result,
      modelCalls,
      toolEvents: events.filter((event) => event.type.startsWith("tool_")),
    }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "token_usage_missing",
          message: "The provider did not report token usage for an active token limit.",
        },
      },
      modelCalls: 1,
      toolEvents: [],
    });
  });

  test("rejects invalid provider token usage before it can affect accounting", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "Do not accept this answer." },
      { type: "usage", inputTokens: -1, outputTokens: 2 },
      { type: "finish", reason: "stop" },
    ]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Report trustworthy usage" });

    expect({
      result,
      usageEvents: events.filter((event) => event.type === "model_usage"),
    }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "model_protocol_invalid",
          message: "The model reported invalid token usage.",
        },
      },
      usageEvents: [],
    });
  });

  test("sends the user input to the model driver", async () => {
    const model = new FakeModelDriver((request) => {
      const firstMessage = request.messages[0];
      return [
        {
          type: "text_delta",
          text: firstMessage?.role === "user" ? firstMessage.content : "missing user input",
        },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = createTestSession({ model });

    const result = await session.run({ text: "Explain this repository" });

    expect(result).toEqual({
      status: "completed",
      answer: "Explain this repository",
    });
  });

  test("reports a failed terminal result when the model stream ends without finishing", async () => {
    const model = new FakeModelDriver([{ type: "text_delta", text: "Partial answer" }]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Answer completely" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    });
    expect(events.at(-1)).toEqual({ type: "session_settled", result });
  });

  test("answers from one read_file result without changing the repository", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-read-"));
    const readmePath = join(workspaceRoot, "README.md");
    const originalReadme = "# Orchard\n\nThis repository grows pears.\n";

    try {
      await writeFile(readmePath, originalReadme, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-1", name: "read_file" },
            { type: "tool_call_delta", id: "call-1", json: '{"path":"README.md"}' },
            { type: "tool_call_end", id: "call-1" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedExpectedResult =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-1" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "README.md", content: originalReadme, truncated: false });

        return [
          {
            type: "text_delta",
            text: receivedExpectedResult
              ? "The repository grows pears."
              : "The repository result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "What does this repository grow?" });

      expect(result).toEqual({
        status: "completed",
        answer: "The repository grows pears.",
      });
      expect(await readFile(readmePath, "utf8")).toBe(originalReadme);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("creates a nested UTF-8 file after write policy allows the call", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-"));
    const targetPath = join(workspaceRoot, "src", "new", "module.ts");

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-write", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-write",
              json: '{"path":"src/new/module.ts","content":"export const fruit = \\"pear\\";\\n"}',
            },
            { type: "tool_call_end", id: "call-write" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedWriteResult =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-write" &&
          latestMessage.name === "write_file" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "src/new/module.ts", bytesWritten: 29 });

        return [
          {
            type: "text_delta",
            text: receivedWriteResult
              ? "The module was created."
              : "The write result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Create a nested module" });

      expect({
        result,
        content: await readFile(targetPath, "utf8"),
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: { status: "completed", answer: "The module was created." },
        content: 'export const fruit = "pear";\n',
        toolEvents: [
          { type: "tool_requested", callId: "call-write", name: "write_file" },
          {
            type: "tool_permission_decided",
            callId: "call-write",
            name: "write_file",
            decision: "allow",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "src/new/module.ts" },
          },
          { type: "tool_started", callId: "call-write", name: "write_file" },
          {
            type: "tool_completed",
            callId: "call-write",
            name: "write_file",
            output: { path: "src/new/module.ts", bytesWritten: 29 },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write_file rejects an existing path without changing its content", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-existing-"));
    const targetPath = join(workspaceRoot, "notes.txt");
    const originalContent = "keep this version\n";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-existing", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-existing",
              json: '{"path":"notes.txt","content":"replace it\\n"}',
            },
            { type: "tool_call_end", id: "call-existing" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedCreateOnlyFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "already_exists";
        return [
          {
            type: "text_delta",
            text: receivedCreateOnlyFailure
              ? "The existing file was preserved."
              : "The create-only failure was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Create notes.txt" });

      expect({
        result,
        content: await readFile(targetPath, "utf8"),
        finalToolEvent: events.filter((event) => event.type.startsWith("tool_")).at(-1),
      }).toEqual({
        result: { status: "completed", answer: "The existing file was preserved." },
        content: originalContent,
        finalToolEvent: {
          type: "tool_failed",
          callId: "call-existing",
          name: "write_file",
          error: {
            code: "already_exists",
            message: "The requested file already exists.",
          },
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test.each([
    { label: "NUL-containing", content: "before\0after" },
    { label: "larger-than-one-MiB", content: "x".repeat(1024 * 1024 + 1) },
  ])("write_file rejects $label content before permission or creation", async ({ content }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-invalid-content-"));
    const targetPath = join(workspaceRoot, "nested", "invalid.txt");

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-invalid-content", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-invalid-content",
              json: JSON.stringify({ path: "nested/invalid.txt", content }),
            },
            { type: "tool_call_end", id: "call-invalid-content" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedInputFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "invalid_tool_input";
        return [
          {
            type: "text_delta",
            text: receivedInputFailure
              ? "The invalid write content was rejected."
              : "The invalid write result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
      });
      const toolEvents: RuntimeEvent[] = [];
      session.subscribe((event) => {
        if (event.type.startsWith("tool_")) {
          toolEvents.push(event);
        }
      });

      const result = await session.run({ text: "Write invalid content" });

      expect({
        result,
        exists: await readFile(targetPath).then(
          () => true,
          () => false,
        ),
        toolEvents,
      }).toEqual({
        result: { status: "completed", answer: "The invalid write content was rejected." },
        exists: false,
        toolEvents: [
          { type: "tool_requested", callId: "call-invalid-content", name: "write_file" },
          {
            type: "tool_failed",
            callId: "call-invalid-content",
            name: "write_file",
            error: {
              code: "invalid_tool_input",
              message: "The tool input did not match its schema.",
            },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("an asked write waits for one call-scoped decision before starting", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-ask-"));
    const targetPath = join(workspaceRoot, "approved.txt");
    const store = createInMemorySessionStore();

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-ask", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-ask",
              json: '{"path":"approved.txt","content":"approved\\n"}',
            },
            { type: "tool_call_end", id: "call-ask" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        return [
          { type: "text_delta", text: "The approved file was created." },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        store,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
      });
      let commandResult: ReturnType<AgentSession["decidePermission"]> | undefined;
      let mismatchedResult: ReturnType<AgentSession["decidePermission"]> | undefined;
      let requestId: string | undefined;
      session.subscribe((event) => {
        if (event.type === "tool_permission_requested") {
          requestId = event.requestId;
          mismatchedResult = session.decidePermission({
            requestId: `${event.requestId}:stale`,
            decision: "allow",
          });
          commandResult = session.decidePermission({
            requestId: event.requestId,
            decision: "allow",
          });
        }
      });

      const result = await session.run({ text: "Create approved.txt" });
      const duplicateResult = session.decidePermission({
        requestId: requestId ?? "missing-request",
        decision: "allow",
      });
      const persistedToolEvents = (await store.read())
        .map((record) => record.event)
        .filter((event) => event.type.startsWith("tool_"));
      const permissionRequest = persistedToolEvents.find(
        (event) => event.type === "tool_permission_requested",
      );
      const permissionDecision = persistedToolEvents.find(
        (event) => event.type === "tool_permission_decided",
      );

      expect({
        result,
        content: await readFile(targetPath, "utf8").catch(() => undefined),
        commandResult,
        mismatchedResult,
        duplicateResult,
        persistedToolEvents,
        correlated:
          permissionRequest?.type === "tool_permission_requested" &&
          permissionDecision?.type === "tool_permission_decided" &&
          permissionDecision.requestId === permissionRequest.requestId,
      }).toEqual({
        result: { status: "completed", answer: "The approved file was created." },
        content: "approved\n",
        commandResult: { status: "accepted" },
        mismatchedResult: {
          status: "rejected",
          error: {
            code: "permission_request_not_pending",
            message: "The permission request is not pending.",
          },
        },
        duplicateResult: {
          status: "rejected",
          error: {
            code: "permission_request_not_pending",
            message: "The permission request is not pending.",
          },
        },
        persistedToolEvents: [
          { type: "tool_requested", callId: "call-ask", name: "write_file" },
          {
            type: "tool_permission_requested",
            requestId: expect.any(String),
            callId: "call-ask",
            name: "write_file",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "approved.txt" },
          },
          {
            type: "tool_permission_decided",
            requestId: expect.any(String),
            callId: "call-ask",
            name: "write_file",
            decision: "allow",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "approved.txt" },
          },
          { type: "tool_started", callId: "call-ask", name: "write_file" },
          {
            type: "tool_completed",
            callId: "call-ask",
            name: "write_file",
            output: { path: "approved.txt", bytesWritten: 9 },
          },
        ],
        correlated: true,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("an invalid permission decision is rejected without consuming the request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-invalid-decision-"));
    const targetPath = join(workspaceRoot, "denied.txt");

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-invalid-decision", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-invalid-decision",
              json: '{"path":"denied.txt","content":"not written\\n"}',
            },
            { type: "tool_call_end", id: "call-invalid-decision" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedDenial =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "permission_denied";
        return [
          {
            type: "text_delta",
            text: receivedDenial ? "The write remained denied." : "The denial was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
      });
      let invalidResult: unknown;
      let validResult: unknown;
      session.subscribe((event) => {
        if (event.type === "tool_permission_requested") {
          invalidResult = session.decidePermission({
            requestId: event.requestId,
            decision: "always",
          } as never);
          validResult = session.decidePermission({
            requestId: event.requestId,
            decision: "deny",
          });
        }
      });

      const result = await session.run({ text: "Try an invalid permission response" });

      expect({
        result,
        invalidResult,
        validResult,
        exists: await readFile(targetPath).then(
          () => true,
          () => false,
        ),
      }).toEqual({
        result: { status: "completed", answer: "The write remained denied." },
        invalidResult: {
          status: "rejected",
          error: {
            code: "invalid_permission_decision",
            message: "The permission decision must be allow or deny.",
          },
        },
        validResult: { status: "accepted" },
        exists: false,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("abort clears a pending permission request without starting the mutation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-ask-abort-"));
    const targetPath = join(workspaceRoot, "cancelled.txt");
    let releasePermissionRequest: ((requestId: string) => void) | undefined;
    const permissionRequested = new Promise<string>((resolve) => {
      releasePermissionRequest = resolve;
    });

    try {
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-ask-abort", name: "write_file" },
        {
          type: "tool_call_delta",
          id: "call-ask-abort",
          json: '{"path":"cancelled.txt","content":"not written\\n"}',
        },
        { type: "tool_call_end", id: "call-ask-abort" },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
      });
      const toolEvents: RuntimeEvent[] = [];
      session.subscribe((event) => {
        if (event.type.startsWith("tool_")) {
          toolEvents.push(event);
        }
        if (event.type === "tool_permission_requested") {
          releasePermissionRequest?.(event.requestId);
        }
      });

      const pendingResult = session.run({ text: "Create cancelled.txt" });
      const requestId = await permissionRequested;
      session.abort();
      const result = await pendingResult;
      const lateResult = session.decidePermission({ requestId, decision: "allow" });

      expect({
        result,
        lateResult,
        exists: await readFile(targetPath).then(
          () => true,
          () => false,
        ),
        toolEvents,
      }).toEqual({
        result: cancelledResult,
        lateResult: {
          status: "rejected",
          error: {
            code: "permission_request_not_pending",
            message: "The permission request is not pending.",
          },
        },
        exists: false,
        toolEvents: [
          { type: "tool_requested", callId: "call-ask-abort", name: "write_file" },
          {
            type: "tool_permission_requested",
            requestId,
            callId: "call-ask-abort",
            name: "write_file",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "cancelled.txt" },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("abort during policy evaluation prevents an orphan permission request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-policy-abort-"));
    let session: AgentSession;

    try {
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-policy-abort", name: "write_file" },
        {
          type: "tool_call_delta",
          id: "call-policy-abort",
          json: '{"path":"cancelled.txt","content":"not written\\n"}',
        },
        { type: "tool_call_end", id: "call-policy-abort" },
        { type: "finish", reason: "tool_calls" },
      ]);
      session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: {
          decide() {
            session.abort();
            return "ask";
          },
        },
      });
      const toolEvents: RuntimeEvent[] = [];
      session.subscribe((event) => {
        if (event.type.startsWith("tool_")) {
          toolEvents.push(event);
        }
      });

      const result = await session.run({ text: "Cancel while policy evaluates" });

      expect({ result, toolEvents }).toEqual({
        result: cancelledResult,
        toolEvents: [{ type: "tool_requested", callId: "call-policy-abort", name: "write_file" }],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write_file rejects lexical traversal before requesting permission", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-traversal-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-write-traversal", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-write-traversal",
              json: '{"path":"../outside.txt","content":"escape\\n"}',
            },
            { type: "tool_call_end", id: "call-write-traversal" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The traversal was rejected."
              : "The traversal result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
      });
      const toolEvents: RuntimeEvent[] = [];
      session.subscribe((event) => {
        if (event.type.startsWith("tool_")) {
          toolEvents.push(event);
        }
        if (event.type === "tool_permission_requested") {
          session.decidePermission({ requestId: event.requestId, decision: "deny" });
        }
      });

      const result = await session.run({ text: "Write outside the workspace" });

      expect({ result, toolEvents }).toEqual({
        result: { status: "completed", answer: "The traversal was rejected." },
        toolEvents: [
          {
            type: "tool_requested",
            callId: "call-write-traversal",
            name: "write_file",
          },
          {
            type: "tool_failed",
            callId: "call-write-traversal",
            name: "write_file",
            error: {
              code: "outside_workspace",
              message: "The requested path is outside the workspace root.",
            },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("write_file rejects a target symlink that resolves outside the workspace", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-write-symlink-"));
    const workspaceRoot = join(testRoot, "workspace");
    const outsidePath = join(testRoot, "outside.txt");
    const originalContent = "outside stays unchanged\n";

    try {
      await mkdir(workspaceRoot);
      await writeFile(outsidePath, originalContent, "utf8");
      await symlink(outsidePath, join(workspaceRoot, "linked.txt"));
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-write-symlink", name: "write_file" },
            {
              type: "tool_call_delta",
              id: "call-write-symlink",
              json: '{"path":"linked.txt","content":"do not write\\n"}',
            },
            { type: "tool_call_end", id: "call-write-symlink" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The escaping symlink was rejected."
              : "The symlink result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Write through the symlink" });

      expect({ result, outsideContent: await readFile(outsidePath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The escaping symlink was rejected." },
        outsideContent: originalContent,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects a target symlink outside the workspace before mutation", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-symlink-"));
    const workspaceRoot = join(testRoot, "workspace");
    const outsidePath = join(testRoot, "outside.txt");
    const originalContent = "outside stays unchanged\n";

    try {
      await mkdir(workspaceRoot);
      await writeFile(outsidePath, originalContent, "utf8");
      await symlink(outsidePath, join(workspaceRoot, "linked.txt"));
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-edit-symlink", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-edit-symlink",
              json: JSON.stringify({
                path: "linked.txt",
                edits: [{ oldText: "unchanged", newText: "changed" }],
              }),
            },
            { type: "tool_call_end", id: "call-edit-symlink" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The escaping edit symlink was rejected."
              : "The edit symlink result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Edit through the symlink" });

      expect({ result, outsideContent: await readFile(outsidePath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The escaping edit symlink was rejected." },
        outsideContent: originalContent,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("edit_file applies exact multi-replacements against one original file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-"));
    const targetPath = join(workspaceRoot, "fruit.ts");

    try {
      await writeFile(targetPath, 'const fruit = "apple";\nconst color = "green";\n', "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-edit", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-edit",
              json: '{"path":"fruit.ts","edits":[{"oldText":"apple","newText":"pear"},{"oldText":"green","newText":"gold"}]}',
            },
            { type: "tool_call_end", id: "call-edit" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedEditResult =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-edit" &&
          latestMessage.name === "edit_file" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "fruit.ts", replacements: 2, bytesWritten: 44 });
        return [
          {
            type: "text_delta",
            text: receivedEditResult
              ? "Both edits were applied."
              : "The edit result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Update the fruit module" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "Both edits were applied." },
        content: 'const fruit = "pear";\nconst color = "gold";\n',
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects an ambiguous match without applying any replacement", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-ambiguous-"));
    const targetPath = join(workspaceRoot, "fruit.txt");
    const originalContent = "apple apple\ncolor green\n";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-ambiguous", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-ambiguous",
              json: '{"path":"fruit.txt","edits":[{"oldText":"apple","newText":"pear"},{"oldText":"green","newText":"gold"}]}',
            },
            { type: "tool_call_end", id: "call-ambiguous" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedAmbiguousFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "ambiguous_match";
        return [
          {
            type: "text_delta",
            text: receivedAmbiguousFailure
              ? "The ambiguous edit was rejected."
              : "The ambiguous edit result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Update fruit.txt exactly" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The ambiguous edit was rejected." },
        content: originalContent,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file treats overlapping occurrences of one oldText as ambiguous", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-overlapping-match-"));
    const targetPath = join(workspaceRoot, "letters.txt");
    const originalContent = "aaa";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-overlapping-match", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-overlapping-match",
              json: '{"path":"letters.txt","edits":[{"oldText":"aa","newText":"x"}]}',
            },
            { type: "tool_call_end", id: "call-overlapping-match" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedAmbiguousFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "ambiguous_match";
        return [
          {
            type: "text_delta",
            text: receivedAmbiguousFailure
              ? "The overlapping occurrence was rejected."
              : "The overlapping occurrence result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Replace aa exactly once" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The overlapping occurrence was rejected." },
        content: originalContent,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects overlapping original ranges without changing the file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-overlap-"));
    const targetPath = join(workspaceRoot, "letters.txt");
    const originalContent = "abcdef\n";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-overlap", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-overlap",
              json: '{"path":"letters.txt","edits":[{"oldText":"abc","newText":"X"},{"oldText":"bcd","newText":"Y"}]}',
            },
            { type: "tool_call_end", id: "call-overlap" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedOverlapFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "overlapping_edits";
        return [
          {
            type: "text_delta",
            text: receivedOverlapFailure
              ? "The overlapping edits were rejected."
              : "The overlap result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Apply overlapping edits" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The overlapping edits were rejected." },
        content: originalContent,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file reports a missing exact match without changing the file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-missing-match-"));
    const targetPath = join(workspaceRoot, "fruit.txt");
    const originalContent = "apple\n";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-no-match", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-no-match",
              json: '{"path":"fruit.txt","edits":[{"oldText":"orange","newText":"pear"}]}',
            },
            { type: "tool_call_end", id: "call-no-match" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedNoMatchFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "no_match";
        return [
          {
            type: "text_delta",
            text: receivedNoMatchFailure
              ? "The missing match was reported."
              : "The no-match result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Replace orange with pear" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The missing match was reported." },
        content: originalContent,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file preserves UTF-8 BOM, CRLF style, and the existing file mode", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-format-"));
    const targetPath = join(workspaceRoot, "formatted.txt");

    try {
      await writeFile(targetPath, Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"));
      await chmod(targetPath, 0o744);
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-format", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-format",
              json: '{"path":"formatted.txt","edits":[{"oldText":"one\\r\\ntwo","newText":"one\\nchanged"}]}',
            },
            { type: "tool_call_end", id: "call-format" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedFormatPreservingResult =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "formatted.txt", replacements: 1, bytesWritten: 17 });
        return [
          {
            type: "text_delta",
            text: receivedFormatPreservingResult
              ? "The formatted file was updated."
              : "The formatted edit result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Update the formatted file" });
      const fileStats = await stat(targetPath);

      expect({
        result,
        bytes: [...(await readFile(targetPath))],
        mode: fileStats.mode & 0o777,
      }).toEqual({
        result: { status: "completed", answer: "The formatted file was updated." },
        bytes: [...Buffer.from("\uFEFFone\r\nchanged\r\n", "utf8")],
        mode: 0o744,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file preserves CR-only line endings in replacement text", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-cr-format-"));
    const targetPath = join(workspaceRoot, "classic-mac.txt");
    const originalContent = "one\rtwo\r";

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-cr-format", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-cr-format",
              json: JSON.stringify({
                path: "classic-mac.txt",
                edits: [{ oldText: "one", newText: "first\nsecond" }],
              }),
            },
            { type: "tool_call_end", id: "call-cr-format" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const editCompleted =
          latestMessage?.role === "tool" && latestMessage.result.status === "completed";
        return [
          {
            type: "text_delta",
            text: editCompleted ? "The CR file was updated." : "The CR edit failed.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Update the CR-only file" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The CR file was updated." },
        content: "first\rsecond\rtwo\r",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects a NUL-containing target without changing its bytes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-binary-"));
    const targetPath = join(workspaceRoot, "binary.dat");
    const originalBytes = Buffer.from([0x61, 0x00, 0x62]);

    try {
      await writeFile(targetPath, originalBytes);
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-binary", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-binary",
              json: '{"path":"binary.dat","edits":[{"oldText":"a","newText":"x"}]}',
            },
            { type: "tool_call_end", id: "call-binary" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedBinaryFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "binary_file";
        return [
          {
            type: "text_delta",
            text: receivedBinaryFailure
              ? "The binary target was rejected."
              : "The binary-file result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Edit the binary target" });

      expect({ result, bytes: [...(await readFile(targetPath))] }).toEqual({
        result: { status: "completed", answer: "The binary target was rejected." },
        bytes: [...originalBytes],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects a target larger than one MiB before matching", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-large-"));
    const targetPath = join(workspaceRoot, "large.txt");
    const originalContent = `${"a".repeat(1024 * 1024)}b`;

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-large", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-large",
              json: '{"path":"large.txt","edits":[{"oldText":"b","newText":"c"}]}',
            },
            { type: "tool_call_end", id: "call-large" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedSizeFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "file_too_large";
        return [
          {
            type: "text_delta",
            text: receivedSizeFailure
              ? "The oversized target was rejected."
              : "The file-size result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Edit the oversized target" });

      expect({ result, size: (await stat(targetPath)).size }).toEqual({
        result: { status: "completed", answer: "The oversized target was rejected." },
        size: 1024 * 1024 + 1,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects combined replacement input larger than one MiB", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-input-large-"));
    const targetPath = join(workspaceRoot, "words.txt");
    const originalContent = "left right\n";
    const largeLeft = "a".repeat(600 * 1024);
    const largeRight = "b".repeat(600 * 1024);

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-large-input", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-large-input",
              json: JSON.stringify({
                path: "words.txt",
                edits: [
                  { oldText: "left", newText: largeLeft },
                  { oldText: "right", newText: largeRight },
                ],
              }),
            },
            { type: "tool_call_end", id: "call-large-input" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedInputFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "invalid_tool_input";
        return [
          {
            type: "text_delta",
            text: receivedInputFailure
              ? "The oversized edit input was rejected."
              : "The edit-input result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Apply oversized replacement input" });

      expect({ result, content: await readFile(targetPath, "utf8") }).toEqual({
        result: { status: "completed", answer: "The oversized edit input was rejected." },
        content: originalContent,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file rejects an updated result larger than one MiB before writing", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-output-large-"));
    const targetPath = join(workspaceRoot, "growing.txt");
    const originalContent = `${"a".repeat(800 * 1024)}marker`;
    const largeReplacement = "b".repeat(400 * 1024);

    try {
      await writeFile(targetPath, originalContent, "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-large-output", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-large-output",
              json: JSON.stringify({
                path: "growing.txt",
                edits: [{ oldText: "marker", newText: largeReplacement }],
              }),
            },
            { type: "tool_call_end", id: "call-large-output" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedSizeFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "file_too_large";
        return [
          {
            type: "text_delta",
            text: receivedSizeFailure
              ? "The oversized edit result was rejected."
              : "The edit-result size was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Grow the file beyond its limit" });

      expect({ result, size: (await stat(targetPath)).size }).toEqual({
        result: { status: "completed", answer: "The oversized edit result was rejected." },
        size: Buffer.byteLength(originalContent, "utf8"),
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("edit_file reports a missing target without creating it", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-edit-missing-file-"));
    const targetPath = join(workspaceRoot, "missing.txt");

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-missing-file", name: "edit_file" },
            {
              type: "tool_call_delta",
              id: "call-missing-file",
              json: '{"path":"missing.txt","edits":[{"oldText":"before","newText":"after"}]}',
            },
            { type: "tool_call_end", id: "call-missing-file" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedMissingFileFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "not_found";
        return [
          {
            type: "text_delta",
            text: receivedMissingFileFailure
              ? "The missing file was reported."
              : "The missing-file result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createMutationToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      });

      const result = await session.run({ text: "Edit the missing file" });

      expect({
        result,
        exists: await readFile(targetPath).then(
          () => true,
          () => false,
        ),
      }).toEqual({
        result: { status: "completed", answer: "The missing file was reported." },
        exists: false,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds one typed validation failure back for malformed tool input", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-invalid-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-invalid", name: "read_file" },
            { type: "tool_call_delta", id: "call-invalid", json: '{"path":42}' },
            { type: "tool_call_end", id: "call-invalid" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedValidationFailure =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-invalid" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "invalid_tool_input";

        return [
          {
            type: "text_delta",
            text: receivedValidationFailure
              ? "The read request was invalid."
              : "The validation result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read a file using malformed input" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "completed",
          answer: "The read request was invalid.",
        },
        toolEvents: [
          { type: "tool_requested", callId: "call-invalid", name: "read_file" },
          {
            type: "tool_failed",
            callId: "call-invalid",
            name: "read_file",
            error: {
              code: "invalid_tool_input",
              message: "The tool input did not match its schema.",
            },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails closed with one typed result for an unknown tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-unknown-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-unknown", name: "erase_repository" },
            { type: "tool_call_delta", id: "call-unknown", json: "{}" },
            { type: "tool_call_end", id: "call-unknown" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedUnknownToolFailure =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-unknown" &&
          latestMessage.name === "erase_repository" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "unknown_tool";

        return [
          {
            type: "text_delta",
            text: receivedUnknownToolFailure
              ? "That tool is unavailable."
              : "The unknown-tool result was missing.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Use an unavailable tool" });

      expect(result).toEqual({
        status: "completed",
        answer: "That tool is unavailable.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds one permission denial back without executing the tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-denied-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-denied", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-denied",
              json: '{"path":"missing-file.md"}',
            },
            { type: "tool_call_end", id: "call-denied" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedPermissionDenial =
          latestMessage?.role === "tool" &&
          latestMessage.callId === "call-denied" &&
          latestMessage.name === "read_file" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "permission_denied";

        return [
          {
            type: "text_delta",
            text: receivedPermissionDenial
              ? "Reading was denied by policy."
              : "The permission result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: [] }),
      });

      const result = await session.run({ text: "Read the missing file" });

      expect(result).toEqual({
        status: "completed",
        answer: "Reading was denied by policy.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("feeds each requested tool result once in order and publishes ordered tool events", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-multiple-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "alpha\n", "utf8");
      await writeFile(join(workspaceRoot, "second.txt"), "beta\n", "utf8");
      const model = new FakeModelDriver((request) => {
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return [
            { type: "tool_call_start", id: "call-first", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-first",
              json: '{"path":"first.txt"}',
            },
            { type: "tool_call_end", id: "call-first" },
            { type: "tool_call_start", id: "call-second", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-second",
              json: '{"path":"second.txt"}',
            },
            { type: "tool_call_end", id: "call-second" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedExactlyOnceInOrder =
          toolMessages.length === 2 &&
          toolMessages[0]?.callId === "call-first" &&
          toolMessages[0].result.status === "completed" &&
          toolMessages[1]?.callId === "call-second" &&
          toolMessages[1].result.status === "completed";
        return [
          {
            type: "text_delta",
            text: receivedExactlyOnceInOrder
              ? "The files contain alpha and beta."
              : "The tool feedback was duplicated or reordered.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read both files" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "completed",
          answer: "The files contain alpha and beta.",
        },
        toolEvents: [
          { type: "tool_requested", callId: "call-first", name: "read_file" },
          {
            type: "tool_permission_decided",
            callId: "call-first",
            name: "read_file",
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "first.txt" },
          },
          { type: "tool_started", callId: "call-first", name: "read_file" },
          {
            type: "tool_completed",
            callId: "call-first",
            name: "read_file",
            output: { path: "first.txt", content: "alpha\n", truncated: false },
          },
          { type: "tool_requested", callId: "call-second", name: "read_file" },
          {
            type: "tool_permission_decided",
            callId: "call-second",
            name: "read_file",
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "second.txt" },
          },
          { type: "tool_started", callId: "call-second", name: "read_file" },
          {
            type: "tool_completed",
            callId: "call-second",
            name: "read_file",
            output: { path: "second.txt", content: "beta\n", truncated: false },
          },
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects lexical traversal with one typed result", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-traversal-"));

    try {
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-traversal", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-traversal",
              json: '{"path":"../outside.txt"}',
            },
            { type: "tool_call_end", id: "call-traversal" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The path is outside the workspace."
              : "The confinement result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read outside the workspace" });

      expect(result).toEqual({
        status: "completed",
        answer: "The path is outside the workspace.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a symlink that resolves outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-symlink-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "adam-agent-symlink-outside-"));

    try {
      const outsidePath = join(outsideRoot, "secret.txt");
      await writeFile(outsidePath, "outside secret\n", "utf8");
      await symlink(outsidePath, join(workspaceRoot, "linked-secret.txt"));
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-symlink", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-symlink",
              json: '{"path":"linked-secret.txt"}',
            },
            { type: "tool_call_end", id: "call-symlink" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const receivedConfinementFailure =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "failed" &&
          latestMessage.result.error.code === "outside_workspace";
        return [
          {
            type: "text_delta",
            text: receivedConfinementFailure
              ? "The symlink target is outside the workspace."
              : "The symlink confinement result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read the linked secret" });

      expect(result).toEqual({
        status: "completed",
        answer: "The symlink target is outside the workspace.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("fails truthfully when a tool-call turn has no completed request", async () => {
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        return [
          { type: "tool_call_start", id: "call-incomplete", name: "read_file" },
          {
            type: "tool_call_delta",
            id: "call-incomplete",
            json: '{"path":"README.md"}',
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "This turn should not run." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = createTestSession({ model });

    const result = await session.run({ text: "Read the README" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_protocol_invalid",
        message: "The model finished with an incomplete tool request.",
      },
    });
  });

  test("executes a retried tool call ID once and reuses its result", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-retry-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "one\n", "utf8");
      let round = 0;
      const model = new FakeModelDriver((request) => {
        round += 1;
        if (round <= 2) {
          return [
            { type: "tool_call_start", id: "call-retried", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-retried",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-retried" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const toolMessages = request.messages.filter((message) => message.role === "tool");
        const feedback = toolMessages.filter((message) => message.callId === "call-retried");
        const reusedSameResult =
          feedback.length === 2 &&
          feedback[0]?.result.status === "completed" &&
          feedback[1]?.result.status === "completed" &&
          JSON.stringify(feedback[0].result) === JSON.stringify(feedback[1].result);
        return [
          {
            type: "text_delta",
            text: reusedSameResult
              ? "The retried read was reused."
              : "The retry result was unexpected.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Read the value, including a provider retry" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: { status: "completed", answer: "The retried read was reused." },
        startedEvents: [{ type: "tool_started", callId: "call-retried", name: "read_file" }],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("fails truthfully when stop includes a completed tool request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-stop-with-tool-"));

    try {
      await writeFile(join(workspaceRoot, "README.md"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-stop", name: "read_file" },
        { type: "tool_call_delta", id: "call-stop", json: '{"path":"README.md"}' },
        { type: "tool_call_end", id: "call-stop" },
        { type: "finish", reason: "stop" },
      ]);
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Stop with an unhandled tool request" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model stopped after completing a tool request.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("returns a bounded read_file result with explicit truncation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-bounded-read-"));

    try {
      await writeFile(join(workspaceRoot, "large.txt"), "x".repeat(65_537), "utf8");
      const model = new FakeModelDriver((request) => {
        const latestMessage = request.messages.at(-1);
        if (latestMessage?.role === "user") {
          return [
            { type: "tool_call_start", id: "call-large", name: "read_file" },
            { type: "tool_call_delta", id: "call-large", json: '{"path":"large.txt"}' },
            { type: "tool_call_end", id: "call-large" },
            { type: "finish", reason: "tool_calls" },
          ];
        }

        const boundedOutput =
          latestMessage?.role === "tool" &&
          latestMessage.result.status === "completed" &&
          JSON.stringify(latestMessage.result.output) ===
            JSON.stringify({ path: "large.txt", content: "x".repeat(65_536), truncated: true });
        return [
          {
            type: "text_delta",
            text: boundedOutput
              ? "The read was truncated safely."
              : "The read result was unbounded.",
          },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });

      const result = await session.run({ text: "Read the large file" });

      expect(result).toEqual({
        status: "completed",
        answer: "The read was truncated safely.",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects conflicting tool calls with the same ID before execution", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-conflicting-id-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "first\n", "utf8");
      await writeFile(join(workspaceRoot, "second.txt"), "second\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-conflict", name: "read_file" },
        { type: "tool_call_delta", id: "call-conflict", json: '{"path":"first.txt"}' },
        { type: "tool_call_end", id: "call-conflict" },
        { type: "tool_call_start", id: "call-conflict", name: "read_file" },
        { type: "tool_call_delta", id: "call-conflict", json: '{"path":"second.txt"}' },
        { type: "tool_call_end", id: "call-conflict" },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send conflicting calls" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model reused a tool call ID with different input.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a duplicate tool call ID within one model turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-duplicate-id-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "one\n", "utf8");
      let round = 0;
      const model = new FakeModelDriver(() => {
        round += 1;
        if (round === 1) {
          return [
            { type: "tool_call_start", id: "call-duplicate", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-duplicate",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-duplicate" },
            { type: "tool_call_start", id: "call-duplicate", name: "read_file" },
            {
              type: "tool_call_delta",
              id: "call-duplicate",
              json: '{"path":"value.txt"}',
            },
            { type: "tool_call_end", id: "call-duplicate" },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "This turn should not run." },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send one duplicate ID" });

      expect({
        result,
        startedEvents: events.filter((event) => event.type === "tool_started"),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model repeated a tool call ID within one turn.",
          },
        },
        startedEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects the whole tool turn when one request is incomplete", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-partial-turn-"));

    try {
      await writeFile(join(workspaceRoot, "first.txt"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-complete", name: "read_file" },
        { type: "tool_call_delta", id: "call-complete", json: '{"path":"first.txt"}' },
        { type: "tool_call_end", id: "call-complete" },
        { type: "tool_call_start", id: "call-incomplete", name: "read_file" },
        {
          type: "tool_call_delta",
          id: "call-incomplete",
          json: '{"path":"second.txt"}',
        },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send one complete and one incomplete call" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model finished with an incomplete tool request.",
          },
        },
        toolEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects a duplicate tool-call start before execution", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-duplicate-start-"));

    try {
      await writeFile(join(workspaceRoot, "value.txt"), "must not be read\n", "utf8");
      const model = new FakeModelDriver([
        { type: "tool_call_start", id: "call-start", name: "read_file" },
        { type: "tool_call_delta", id: "call-start", json: '{"path":"value.txt"}' },
        { type: "tool_call_start", id: "call-start", name: "read_file" },
        { type: "tool_call_delta", id: "call-start", json: '{"path":"value.txt"}' },
        { type: "tool_call_end", id: "call-start" },
        { type: "finish", reason: "tool_calls" },
      ]);
      const session = createTestSession({
        model,
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      const events: RuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      const result = await session.run({ text: "Send a duplicate tool-call start" });

      expect({
        result,
        toolEvents: events.filter((event) => event.type.startsWith("tool_")),
      }).toEqual({
        result: {
          status: "failed",
          error: {
            code: "model_protocol_invalid",
            message: "The model started the same tool call more than once.",
          },
        },
        toolEvents: [],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "arguments",
      event: { type: "tool_call_delta", id: "orphan", json: "{}" } as const,
      message: "The model sent arguments for a tool call that was not started.",
    },
    {
      label: "end",
      event: { type: "tool_call_end", id: "orphan" } as const,
      message: "The model ended a tool call that was not started.",
    },
  ])("rejects an orphaned tool-call $label event", async ({ event, message }) => {
    const model = new FakeModelDriver([event, { type: "finish", reason: "tool_calls" }]);
    const session = createTestSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((runtimeEvent) => events.push(runtimeEvent));

    const result = await session.run({ text: "Send a malformed tool-call stream" });

    expect({
      result,
      toolEvents: events.filter((runtimeEvent) => runtimeEvent.type.startsWith("tool_")),
    }).toEqual({
      result: {
        status: "failed",
        error: { code: "model_protocol_invalid", message },
      },
      toolEvents: [],
    });
  });
});

async function createAgentSessionStore(storeKind: "in-memory" | "JSONL") {
  if (storeKind === "in-memory") {
    return {
      store: createInMemorySessionStore(),
      cleanup: async () => {},
    };
  }

  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-adapter-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  return {
    store: await createJsonlSessionStore({
      stateRoot: join(testRoot, "state"),
      workspaceRoot,
      sessionId: "session-adapter-contract",
    }),
    cleanup: () => rm(testRoot, { recursive: true, force: true }),
  };
}

function createTestSession(
  dependencies: Omit<AgentSessionDependencies, "store"> & { readonly store?: SessionStore },
): AgentSession {
  return new AgentSession({
    ...dependencies,
    store: dependencies.store ?? createInMemorySessionStore(),
  });
}
