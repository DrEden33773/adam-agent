import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  type ModelEvent,
  type ModelMessage,
  type RuntimeEvent,
  SessionStoreError,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
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
function itemId(messages: readonly ModelMessage[]): string {
  const created = messages.find(
    (message) => message.role === "tool" && message.callId === "create",
  );
  if (created?.role !== "tool" || created.result.status !== "completed")
    throw new Error("Todo creation did not complete");
  return (created.result.output as { item: { id: string } }).item.id;
}

test.each([false, true])(
  "new session Todo create, update and atomic batch reach the next request without prompts (Plan=%s)",
  async (plan) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-default-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let step = 0;
    const driver = new FakeModelDriver((request) => {
      step++;
      if (step === 1)
        return [
          ...call("create", "create_todo", {
            title: "Verified work",
            activeForm: "Verifying work",
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (step === 2)
        return [
          ...call("update", "update_todo", {
            id: itemId(request.messages),
            expectedStoreRevision: 1,
            expectedItemRevision: 1,
            status: "in_progress",
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (step === 3)
        return [
          ...call("batch", "update_todos", {
            expectedStoreRevision: 2,
            updates: [
              { id: itemId(request.messages), expectedItemRevision: 2, status: "completed" },
            ],
          }),
          ...call("stale", "update_todos", {
            expectedStoreRevision: 2,
            updates: [{ id: itemId(request.messages), expectedItemRevision: 2, status: "pending" }],
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      expect(
        request.messages.find((message) => message.role === "tool" && message.callId === "batch"),
      ).toMatchObject({
        result: {
          status: "completed",
          output: { storeRevision: 3, items: [{ status: "completed", itemRevision: 3 }] },
        },
      });
      expect(
        request.messages.find((message) => message.role === "tool" && message.callId === "stale"),
      ).toMatchObject({ result: { status: "failed", error: { code: "todo_revision_stale" } } });
      return [
        { type: "text_delta", text: "Work recorded." },
        { type: "finish", reason: "stop" },
      ];
    });
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      workspaceRoot,
      modelTargets: modelTargetsWithDriver(driver),
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["write", "execute"],
      }),
    });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    try {
      const created = await lifecycle.create({ targetIdentity });
      if (plan)
        expect(await lifecycle.enterPlan({ sessionId: created.sessionId })).toMatchObject({
          plan: { policyVersion: "plan-policy.hybrid-todo-v1" },
        });
      const result = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Record work" },
      });
      expect(result.result).toMatchObject({ status: "completed" });
      expect(step).toBe(4);
      expect(events.filter((event) => event.type === "tool_permission_requested")).toEqual([]);
      expect(events.filter((event) => event.type === "tool_permission_decided")).toMatchObject(
        ["create_todo", "update_todo", "update_todos"].map((operation) => ({
          decision: "allow",
          effect: "write",
          subject: { type: "session_todo", sessionId: created.sessionId, operation },
        })),
      );
      expect(await lifecycle.inspect({ sessionId: created.sessionId })).toMatchObject({
        todoPermissionPolicy: "todo-permission.session-v1",
        todo: { storeRevision: 3, counts: { completed: 1, pending: 0 } },
      });
      const records = await (await harness.sessions.open(created.sessionId))?.read();
      expect(
        records?.filter(
          (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_created",
        ),
      ).toHaveLength(1);
      await lifecycle.close();
      const cold = harness.createLifecycle({
        workspaceRoot,
        modelTargets: modelTargetsWithDriver(driver),
        tools: createCodingToolRegistry({ workspaceRoot }),
      });
      try {
        expect(await cold.inspect({ sessionId: created.sessionId })).toMatchObject({
          todo: { storeRevision: 3, counts: { completed: 1 } },
        });
      } finally {
        await cold.close();
      }
    } finally {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["deny", "plan_deny", "lookalike", "file", "execute"] as const)(
  "new Todo permission preserves %s authority",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-authority-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const builtin = createCodingToolRegistry({ workspaceRoot });
    const original = builtin.resolve("create_todo");
    if (original === undefined) throw new Error("Builtin unavailable");
    const lookalike = { ...original };
    const tools: ToolRegistry =
      kind === "lookalike"
        ? {
            definitions: () => builtin.definitions(),
            resolve: (name) => (name === "create_todo" ? lookalike : builtin.resolve(name)),
          }
        : builtin;
    let step = 0;
    const driver = new FakeModelDriver((request) => {
      if (++step === 1)
        return [
          ...call(
            "mutation",
            kind === "file" ? "write_file" : kind === "execute" ? "run_shell" : "create_todo",
            kind === "file"
              ? { path: "note.txt", content: "hello" }
              : kind === "execute"
                ? { command: "pwd" }
                : { title: "Record work" },
          ),
          { type: "finish", reason: "tool_calls" },
        ];
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        result: { status: "failed", error: { code: "permission_denied" } },
      });
      return [
        { type: "text_delta", text: "Denied." },
        { type: "finish", reason: "stop" },
      ];
    });
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      workspaceRoot,
      tools,
      modelTargets: modelTargetsWithDriver(driver),
      permissions: { decide: () => (kind === "deny" || kind === "plan_deny" ? "deny" : "ask") },
    });
    const requests: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        requests.push(event);
        lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
      }
    });
    try {
      const created = await lifecycle.create({ targetIdentity });
      if (kind === "plan_deny") await lifecycle.enterPlan({ sessionId: created.sessionId });
      await lifecycle.continue({ sessionId: created.sessionId, input: { text: "Try mutation" } });
      expect(step).toBe(2);
      expect(requests).toHaveLength(kind === "deny" || kind === "plan_deny" ? 0 : 1);
      expect(await lifecycle.inspect({ sessionId: created.sessionId })).toMatchObject({
        todo: { storeRevision: 0 },
      });
    } finally {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("automatic Todo permission never publishes a batch whose durable append failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-append-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const directory = createInMemorySessionStoreDirectory<SessionRecord>();
  let rejected = false;
  const harness = createInMemorySessionLifecycleHarness({
    ...directory,
    async open(sessionId) {
      const backing = await directory.open(sessionId);
      if (backing === undefined) return undefined;
      return {
        ...backing,
        async append(record) {
          if (
            record.schemaVersion === 3 &&
            record.record.type === "runtime_event" &&
            record.record.event.type === "tool_completed" &&
            record.record.event.name === "update_todos"
          ) {
            rejected = true;
            throw new SessionStoreError("session_log_invalid", {
              category: "storage_io_failed",
              stage: "write",
              writeOutcome: "not_written",
              reason: "storage_full",
            });
          }
          await backing.append(record);
        },
      };
    },
  });
  let step = 0;
  const driver = new FakeModelDriver((request) =>
    ++step === 1
      ? [
          ...call("create", "create_todo", { title: "Retain pending" }),
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          ...call("batch", "update_todos", {
            expectedStoreRevision: 1,
            updates: [
              { id: itemId(request.messages), expectedItemRevision: 1, status: "completed" },
            ],
          }),
          { type: "finish", reason: "tool_calls" },
        ],
  );
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["write"] }),
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));
  try {
    const created = await lifecycle.create({ targetIdentity });
    expect(
      await lifecycle.continue({ sessionId: created.sessionId, input: { text: "Record work" } }),
    ).toMatchObject({
      result: { status: "failed", error: { code: "session_persistence_failed" } },
    });
    expect(rejected).toBe(true);
    expect(step).toBe(2);
    expect(events.filter((event) => event.type === "tool_permission_requested")).toEqual([]);
    expect(
      events.filter((event) => event.type === "tool_completed" && event.name === "update_todos"),
    ).toEqual([]);
    expect(await lifecycle.inspect({ sessionId: created.sessionId })).toMatchObject({
      todo: { storeRevision: 1, counts: { pending: 1, completed: 0 } },
    });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
