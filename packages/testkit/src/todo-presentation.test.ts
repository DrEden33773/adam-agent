import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  createPresentationSession,
  ModelDriverError,
  type ModelEvent,
} from "@adam-agent/agent";
import { presentationSessionRecordReader } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

function call(id: string, name: string, input: unknown): ModelEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, json: JSON.stringify(input) },
    { type: "tool_call_end", id },
  ];
}

test.each([false, true])(
  "Todo projection retains unfinished work but hides settled completions on cold reads and branches (batch=%s)",
  async (batch) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-projection-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let step = 0;
    const driver = new FakeModelDriver((request) => {
      if (step++ === 0)
        return [
          ...call("create-a", "create_todo", { title: "Read contract" }),
          ...call("create-b", "create_todo", { title: "Run checks", activeForm: "Running checks" }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (step === 2) {
        const ids = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => {
            if (message.role !== "tool" || message.result.status !== "completed")
              throw new Error("Missing created Todo feedback");
            return (message.result.output as { item: { id: string } }).item.id;
          });
        return [
          ...(batch
            ? call("complete", "update_todos", {
                expectedStoreRevision: 2,
                updates: ids.map((id) => ({ id, expectedItemRevision: 1, status: "completed" })),
              })
            : call("complete", "update_todo", {
                id: ids[0],
                expectedStoreRevision: 2,
                expectedItemRevision: 1,
                status: "completed",
              })),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "Tasks recorded." },
        { type: "finish", reason: "stop" },
      ];
    });
    const harness = createInMemorySessionLifecycleHarness();
    const modelTargets = modelTargetsWithDriver(driver);
    const options = {
      workspaceRoot,
      modelTargets,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    };
    let lifecycle = harness.createLifecycle(options);
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    try {
      const created = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({ sessionId: created.sessionId, input: { text: "Complete tasks" } });
      presentation = await createPresentationSession({
        [presentationSessionRecordReader]: async (sessionId) =>
          (await (await harness.sessions.open(sessionId))?.read()) ?? [],
        projectLabel: "Todo fixture",
        lifecycle,
        modelTargets,
        sessionId: created.sessionId,
        workspaceRoot,
      });
      const displayed = presentation.getState().authoritative.active?.todo;
      expect(displayed?.overlay).toMatchObject({
        completedCount: 0,
        items: batch ? [] : [{ title: "Run checks", activeForm: "Running checks" }],
      });
      const snapshot = await lifecycle.inspect({ sessionId: created.sessionId });
      const branch = await lifecycle.branch({
        parentSessionId: created.sessionId,
        atSequence: snapshot.lastSequence,
      });
      await presentation.close();
      await lifecycle.close();
      lifecycle = harness.createLifecycle(options);
      presentation = await createPresentationSession({
        [presentationSessionRecordReader]: async (sessionId) =>
          (await (await harness.sessions.open(sessionId))?.read()) ?? [],
        projectLabel: "Todo fixture",
        lifecycle,
        modelTargets,
        sessionId: created.sessionId,
        workspaceRoot,
      });
      expect(presentation.getState().authoritative.active?.todo).toEqual(displayed);
      await lifecycle.continue({ sessionId: created.sessionId, input: { text: "Next Main turn" } });
      await presentation.close();
      presentation = await createPresentationSession({
        [presentationSessionRecordReader]: async (sessionId) =>
          (await (await harness.sessions.open(sessionId))?.read()) ?? [],
        projectLabel: "Todo fixture",
        lifecycle,
        modelTargets,
        sessionId: created.sessionId,
        workspaceRoot,
      });
      expect(presentation.getState().authoritative.active?.todo?.overlay).toMatchObject({
        completedCount: 0,
        items: batch ? [] : [{ title: "Run checks" }],
      });
      expect(presentation.getState().authoritative.active?.todo?.counts.completed).toBe(
        batch ? 2 : 1,
      );
      await presentation.close();
      presentation = await createPresentationSession({
        [presentationSessionRecordReader]: async (sessionId) =>
          (await (await harness.sessions.open(sessionId))?.read()) ?? [],
        projectLabel: "Todo fixture",
        lifecycle,
        modelTargets,
        sessionId: branch.sessionId,
        workspaceRoot,
      });
      expect(presentation.getState().authoritative.active?.todo?.overlay).toMatchObject({
        completedCount: 0,
        items: batch ? [] : [{ title: "Run checks" }],
      });
    } finally {
      await presentation?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["completed", "cancelled", "failed", "provider_failed", "reopened", "created"] as const)(
  "Todo completion follows the live %s path and hides at the terminal boundary",
  async (terminal) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-terminal-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const changed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let todoId = "";
    let step = 0;
    const driver: import("@adam-agent/agent").ModelDriver = {
      async *stream(request) {
        if (step++ === 0) {
          yield* call("create", "create_todo", { title: "Verify contract" });
          yield { type: "finish", reason: "tool_calls" };
        } else if (step === 2) {
          const result = request.messages.find((message) => message.role === "tool");
          if (result?.role !== "tool" || result.result.status !== "completed")
            throw new Error("Missing Todo");
          const id = (result.result.output as { item: { id: string } }).item.id;
          todoId = id;
          yield* call("complete", "update_todo", {
            id,
            expectedStoreRevision: 1,
            expectedItemRevision: 1,
            status: "completed",
          });
          yield { type: "finish", reason: "tool_calls" };
        } else {
          reached.resolve();
          await release.promise;
          if (terminal === "reopened" || terminal === "created") {
            if (step === 3) {
              yield* terminal === "created"
                ? call("create-more", "create_todo", { title: "New work" })
                : call("reopen", "update_todo", {
                    id: todoId,
                    expectedStoreRevision: 2,
                    expectedItemRevision: 2,
                    status: "pending",
                  });
              yield { type: "finish", reason: "tool_calls" };
              return;
            }
            changed.resolve();
            await finish.promise;
          }
          if (terminal === "provider_failed")
            throw new ModelDriverError("transport", "Provider disconnected.", { cause: undefined });
          if (terminal === "failed")
            throw new Error("External provider failed after Todo completion");
          if (terminal === "cancelled") throw request.signal.reason;
          yield { type: "text_delta", text: "Run finished." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const harness = createInMemorySessionLifecycleHarness();
    const modelTargets = modelTargetsWithDriver(driver);
    const lifecycle = harness.createLifecycle({
      workspaceRoot,
      modelTargets,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    });
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    let running: ReturnType<NonNullable<typeof presentation>["dispatch"]> | undefined;
    try {
      const created = await lifecycle.create({ targetIdentity });
      const open = () =>
        createPresentationSession({
          [presentationSessionRecordReader]: async (sessionId) =>
            (await (await harness.sessions.open(sessionId))?.read()) ?? [],
          projectLabel: "Todo fixture",
          lifecycle,
          modelTargets,
          sessionId: created.sessionId,
          workspaceRoot,
        });
      presentation = await open();
      const completedVisible = waitForTodoState(
        presentation,
        () => presentation?.getState().authoritative.active?.todo?.overlay?.completedCount === 1,
      );
      running = presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Verify",
        skills: [],
        thinkingSelection: null,
      });
      await reached.promise;
      await completedVisible;
      expect(presentation.getState().authoritative.active?.todo?.overlay).toMatchObject({
        completedCount: 1,
        items: [{ title: "Verify contract", status: "completed" }],
      });
      const terminalVisible = waitForTodoState(
        presentation,
        () =>
          presentation?.getState().authoritative.active?.parentRun?.phase !== "running" &&
          presentation?.getState().authoritative.active?.todo?.overlay?.completedCount === 0,
      );
      const newWorkVisible =
        terminal === "reopened" || terminal === "created"
          ? waitForTodoState(
              presentation,
              () => presentation?.getState().authoritative.active?.todo?.counts.pending === 1,
            )
          : undefined;
      if (terminal === "cancelled")
        await presentation.dispatch({ type: "cancel_run", sessionId: created.sessionId });
      release.resolve();
      if (terminal === "reopened" || terminal === "created") {
        await changed.promise;
        await newWorkVisible;
        const todo = presentation.getState().authoritative.active?.todo;
        if (todo === undefined) throw new Error("Missing live Todo state");
        expect(todo.counts.pending).toBe(1);
        expect(todo.overlay).toMatchObject({ completedCount: terminal === "created" ? 1 : 0 });
        expect(todo.overlay?.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              title: terminal === "created" ? "New work" : "Verify contract",
              status: "pending",
            }),
          ]),
        );
        finish.resolve();
      }
      await running;
      await terminalVisible;
      expect(presentation.getState().authoritative.active?.todo?.overlay?.completedCount).toBe(0);
      await presentation.close();
      presentation = await open();
      expect(presentation.getState().authoritative.active?.todo?.overlay).toMatchObject({
        completedCount: 0,
        items:
          terminal === "created"
            ? [{ title: "New work" }]
            : terminal === "reopened"
              ? [{ title: "Verify contract" }]
              : [],
      });
      expect(
        await presentation.dispatch({
          type: "list_todos",
          sessionId: created.sessionId,
          expectedStoreRevision: terminal === "created" || terminal === "reopened" ? 3 : 2,
          filter: { status: null, titleContains: null },
          limit: 20,
          cursor: null,
        }),
      ).toMatchObject({
        status: "admitted",
        todo: {
          type: "todo_page",
          items: [
            { title: "Verify contract", status: terminal === "reopened" ? "pending" : "completed" },
            ...(terminal === "created" ? [{ title: "New work", status: "pending" }] : []),
          ],
        },
      });
    } finally {
      release.resolve();
      finish.resolve();
      await running;
      await presentation?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function waitForTodoState(
  presentation: Awaited<ReturnType<typeof createPresentationSession>>,
  predicate: () => boolean,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Missing expected Todo presentation state"));
    }, 5000);
    const unsubscribe = presentation.subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}
