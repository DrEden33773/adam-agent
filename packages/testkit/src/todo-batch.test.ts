import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingToolRegistry, type ModelEvent, type RuntimeEvent } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

function calls(id: string, name: string, input: unknown): ModelEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, json: JSON.stringify(input) },
    { type: "tool_call_end", id },
  ];
}

test.each(["allow", "deny", "cancel"] as const)(
  "one exact permission controls an entire Todo batch: %s",
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-permission-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let requestNumber = 0;
    const driver = new FakeModelDriver((request) => {
      requestNumber++;
      if (requestNumber === 1)
        return [
          ...[0, 1, 2, 3].flatMap((index) =>
            calls(`create-${index}`, "create_todo", { title: `Task ${index}` }),
          ),
          { type: "finish", reason: "tool_calls" },
        ];
      if (requestNumber === 2) {
        const updates = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => {
            if (message.role !== "tool" || message.result.status !== "completed")
              throw new Error("Expected created Todo");
            const output = message.result.output as { item: { id: string } };
            return { id: output.item.id, expectedItemRevision: 1, status: "completed" };
          });
        return [
          ...calls("all", "update_todos", { expectedStoreRevision: 4, updates }),
          ...calls("duplicate", "update_todos", {
            expectedStoreRevision: 4,
            updates: [updates[0], updates[0]],
          }),
          ...(decision === "allow"
            ? calls("stale", "update_todos", { expectedStoreRevision: 4, updates })
            : []),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (decision === "allow")
        expect(
          request.messages.find((message) => message.role === "tool" && message.callId === "all"),
        ).toMatchObject({
          result: {
            status: "completed",
            output: {
              batchVersion: 1,
              storeRevision: 5,
              items: [
                { status: "completed" },
                { status: "completed" },
                { status: "completed" },
                { status: "completed" },
              ],
            },
          },
        });
      const failed = request.messages.filter(
        (message) => message.role === "tool" && message.result.status === "failed",
      );
      expect(failed).toMatchObject(
        decision === "allow"
          ? [
              { callId: "duplicate", result: { error: { code: "invalid_tool_input" } } },
              { callId: "stale", result: { error: { code: "todo_revision_stale" } } },
            ]
          : [
              { callId: "all", result: { error: { code: "permission_denied" } } },
              { callId: "duplicate", result: { error: { code: "invalid_tool_input" } } },
            ],
      );
      return [
        { type: "text_delta", text: "Batch permission settled." },
        { type: "finish", reason: "stop" },
      ];
    });
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      workspaceRoot,
      modelTargets: modelTargetsWithDriver(driver),
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: { decide: (input) => (input.name === "create_todo" ? "allow" : "ask") },
    });
    const events: RuntimeEvent[] = [];
    const permission =
      Promise.withResolvers<Extract<RuntimeEvent, { type: "tool_permission_requested" }>>();
    lifecycle.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_permission_requested") permission.resolve(event);
    });
    const controller = new AbortController();
    let pending: ReturnType<typeof lifecycle.continue> | undefined;
    try {
      const created = await lifecycle.create({ targetIdentity });
      pending = lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Update all four Todos atomically." },
        signal: controller.signal,
      });
      const outcome = await Promise.race([
        permission.promise.then((event) => ({ event })),
        pending.then((result) => ({ result })),
      ]);
      if (!("event" in outcome)) throw new Error("Batch settled before permission");
      const event = outcome.event;
      expect(event).toMatchObject({
        name: "update_todos",
        callId: "all",
        effect: "write",
        scope: "call",
      });
      await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        todo: { storeRevision: 4, counts: { pending: 4, completed: 0 } },
      });
      if (decision === "cancel") controller.abort();
      else
        expect(lifecycle.decidePermission({ requestId: event.requestId, decision })).toEqual({
          status: "accepted",
        });
      await expect(pending).resolves.toMatchObject({
        result: { status: decision === "cancel" ? "cancelled" : "completed" },
      });
      expect(
        lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" }),
      ).toMatchObject({ status: "rejected" });
      expect(events.filter((event) => event.type === "tool_permission_requested")).toHaveLength(1);
      await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        todo: {
          storeRevision: decision === "allow" ? 5 : 4,
          counts: {
            pending: decision === "allow" ? 0 : 4,
            completed: decision === "allow" ? 4 : 0,
          },
        },
      });
      const records = await (await harness.sessions.open(created.sessionId))?.read();
      expect(
        records?.filter(
          (entry) =>
            entry.schemaVersion === 3 &&
            entry.record.type === "runtime_event" &&
            entry.record.event.type === "tool_completed" &&
            entry.record.event.name === "update_todos",
        ),
      ).toHaveLength(decision === "allow" ? 1 : 0);
    } finally {
      controller.abort();
      await pending?.catch(() => undefined);
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
