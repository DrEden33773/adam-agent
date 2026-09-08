import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  createPresentationSession,
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
  "Todo projection cold-rebuilds exact completing-turn visibility (batch=%s)",
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
        completedCount: batch ? 2 : 1,
        items: [
          { title: "Read contract", status: "completed" },
          { title: "Run checks", activeForm: "Running checks" },
        ],
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
