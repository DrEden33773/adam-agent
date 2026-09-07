import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createPermissionPolicy,
  createPresentationSession,
  type RuntimeEvent,
  type SessionRecord,
} from "@adam-agent/agent";
import {
  presentationSessionRecordReader,
  sessionRecordCommittedBarrier,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity,
} from "./session-lifecycle.test-support.js";

for (const seam of ["runtime", "notifications"] as const) {
  test.each(["sync", "async"] as const)(
    `public ${seam}/%s observer failure cannot stop other observers or tool feedback`,
    async (mode) => {
      const store = createInMemorySessionStore();
      let modelCalls = 0;
      const model = new FakeModelDriver((request) => {
        modelCalls += 1;
        if (request.messages.at(-1)?.role === "user")
          return [
            { type: "tool_call_start", id: "observer-search", name: "search_repository" },
            {
              type: "tool_call_delta",
              id: "observer-search",
              json: '{"kind":"path","query":"needle","cursor":"invalid"}',
            },
            { type: "tool_call_end", id: "observer-search" },
            { type: "finish", reason: "tool_calls" },
          ];
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          result: { status: "failed", error: { code: "search_cursor_invalid" } },
        });
        return [
          { type: "text_delta", text: "Observers did not stop this run." },
          { type: "finish", reason: "stop" },
        ];
      });
      const session = new AgentSession({
        model,
        store,
        tools: createCodingToolRegistry({ workspaceRoot: process.cwd() }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        maximumOutputTokens: 4096,
      });
      const observed: RuntimeEvent[] = [];
      const fail = (event: RuntimeEvent) => {
        if (event.type !== "user_message") return;
        if (mode === "async") return Promise.reject(new Error("private observer canary"));
        throw new Error("private observer canary");
      };
      if (seam === "runtime") {
        session.subscribe(fail);
        session.subscribe((event) => {
          observed.push(event);
        });
      } else {
        session.subscribeNotifications((notification) => fail(notification.event));
        session.subscribeNotifications((notification) => {
          observed.push(notification.event);
        });
      }
      await expect(session.run({ text: "Handle one real search failure." })).resolves.toEqual({
        status: "completed",
        answer: "Observers did not stop this run.",
      });
      expect(modelCalls).toBe(2);
      expect(observed[0]).toEqual({
        type: "user_message",
        text: "Handle one real search failure.",
      });
      expect(observed).toContainEqual(
        expect.objectContaining({
          type: "tool_failed",
          error: expect.objectContaining({ code: "search_cursor_invalid" }),
        }),
      );
      expect(observed.at(-1)).toMatchObject({
        type: "session_settled",
        result: { status: "completed" },
      });
      expect((await store.read()).at(-1)).toMatchObject({
        record: {
          type: "runtime_event",
          event: { type: "session_settled", result: { status: "completed" } },
        },
      });
    },
  );
}

test("Lifecycle and Presentation fan-out preserve admission and settlement after sync and async observers fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-observer-lifecycle-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets = modelTargetsWithDriver(
    new FakeModelDriver([
      { type: "text_delta", text: "The authorized model answered." },
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
    const seen: string[] = [];
    lifecycle.subscribe(() => {
      throw new Error("runtime observer");
    });
    lifecycle.subscribe(async () => {
      throw new Error("async runtime observer");
    });
    lifecycle.subscribe((event) => {
      seen.push(event.type);
    });
    lifecycle.subscribeSessionEvents(() => {
      throw new Error("notification observer");
    });
    lifecycle.subscribeSessionEvents(async () => {
      throw new Error("async notification observer");
    });
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
    presentation.subscribe(() => {
      throw new Error("display observer");
    });
    presentation.subscribe(async () => {
      throw new Error("async display observer");
    });
    const settled = Promise.withResolvers<void>();
    presentation.subscribe(() => {
      const state = presentation?.getState();
      if (
        state?.authoritative.active?.transcript.items.some(
          (item) =>
            item.type === "assistant_message" && item.text === "The authorized model answered.",
        ) &&
        state.transient === null
      )
        settled.resolve();
    });
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Answer despite failed observers.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await withManagedFailureGuard(
      settled.promise,
      "Other observers did not receive the completed execution.",
    );
    expect(seen[0]).toBe("user_message");
    expect(seen.at(-1)).toBe("session_settled");
    expect(presentation.getState().authoritative.active?.parentRun).toEqual({
      phase: "ready",
      editor: "ready",
    });
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a required committed-record barrier still stops execution after its durable fact", async () => {
  const store = createInMemorySessionStore();
  let modelCalls = 0;
  const dependencies = {
    store,
    maximumOutputTokens: 4096,
    model: new FakeModelDriver(() => {
      modelCalls += 1;
      return [{ type: "finish", reason: "stop" }];
    }),
    [sessionRecordCommittedBarrier]: async (_record: SessionRecord) => {
      throw new Error("private barrier canary");
    },
  };
  const result = await new AgentSession(dependencies).run({
    text: "Do not cross the required barrier.",
  });
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "session_execution_failed" },
    executionFailure: {
      category: "execution_failed",
      stage: "barrier",
      phase: "user_input",
      writeOutcome: "committed",
      attemptedSequence: 1,
    },
  });
  expect(JSON.stringify(result)).not.toContain("private barrier canary");
  expect(modelCalls).toBe(0);
  expect(await store.read()).toEqual([
    expect.objectContaining({
      sequence: 1,
      record: expect.objectContaining({
        type: "runtime_event",
        event: { type: "user_message", text: "Do not cross the required barrier." },
      }),
    }),
  ]);
});
