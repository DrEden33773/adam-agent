import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  createPresentationSession,
  type ModelDriver,
  type ModelEvent,
} from "@adam-agent/agent";
import {
  presentationRuntimeRefreshBarrier,
  presentationSessionRecordReader,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
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

test("A refresh already publishing when Main fails cannot restore completed Todos", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-refresh-failure-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const refreshHeld = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  const failProvider = Promise.withResolvers<void>();
  const completedDurable = Promise.withResolvers<void>();
  const failureVisible = Promise.withResolvers<void>();
  const refreshPublished = Promise.withResolvers<void>();
  let refreshReleased = false;
  let step = 0;
  let refreshBlocked = false;
  const driver: ModelDriver = {
    async *stream(request) {
      if (++step === 1) {
        yield* call("create", "create_todo", { title: "Verify contract" });
        yield { type: "finish", reason: "tool_calls" };
      } else if (step === 2) {
        const result = request.messages.find((message) => message.role === "tool");
        if (result?.role !== "tool" || result.result.status !== "completed")
          throw new Error("Missing Todo creation feedback");
        yield* call("complete", "update_todo", {
          id: (result.result.output as { item: { id: string } }).item.id,
          expectedStoreRevision: 1,
          expectedItemRevision: 1,
          status: "completed",
        });
        yield { type: "finish", reason: "tool_calls" };
      } else {
        completedDurable.resolve();
        await failProvider.promise;
        throw new Error("External provider failed after Todo completion");
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
  let unsubscribe = () => {};
  try {
    const created = await lifecycle.create({ targetIdentity });
    presentation = await createPresentationSession({
      [presentationSessionRecordReader]: async (sessionId) =>
        (await (await harness.sessions.open(sessionId))?.read()) ?? [],
      [presentationRuntimeRefreshBarrier]: {
        async beforeRead() {
          await completedDurable.promise;
        },
        async beforePublish() {
          if (step !== 3 || refreshBlocked) return;
          refreshBlocked = true;
          refreshHeld.resolve();
          await releaseRefresh.promise;
        },
      },
      projectLabel: "Todo refresh fixture",
      lifecycle,
      modelTargets,
      sessionId: created.sessionId,
      workspaceRoot,
    });
    const current = presentation;
    unsubscribe = current.subscribe(() => {
      const state = current.getState();
      if (
        state.executionFailure !== undefined &&
        state.authoritative.active?.parentRun?.phase === "interrupted" &&
        state.authoritative.active.todo?.overlay?.completedCount === 0
      )
        failureVisible.resolve();
      if (refreshReleased) refreshPublished.resolve();
    });
    expect(
      await current.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Verify",
        skills: [],
        thinkingSelection: null,
      }),
    ).toMatchObject({ status: "admitted" });
    await withManagedFailureGuard(refreshHeld.promise, "completed Todo refresh before publish");
    failProvider.resolve();
    await withManagedFailureGuard(failureVisible.promise, "failed Main hides completed Todo");
    expect(current.getState().authoritative.active?.todo?.overlay?.completedCount).toBe(0);
    refreshReleased = true;
    releaseRefresh.resolve();
    await withManagedFailureGuard(refreshPublished.promise, "held runtime refresh publishes");
    expect(current.getState().authoritative.active?.todo).toMatchObject({
      counts: { completed: 1 },
      overlay: { completedCount: 0, items: [] },
    });
  } finally {
    completedDurable.resolve();
    failProvider.resolve();
    releaseRefresh.resolve();
    unsubscribe();
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
