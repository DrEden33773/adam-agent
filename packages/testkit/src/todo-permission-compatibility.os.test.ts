import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import {
  createSessionLifecycleForTests as createSessionLifecycle,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

async function fixture(legacy: boolean) {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-permission-compat-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver((request) => {
    const latest = request.messages.at(-1);
    return latest?.role === "user"
      ? [
          { type: "tool_call_start", id: "record-todo", name: "create_todo" },
          { type: "tool_call_delta", id: "record-todo", json: '{"title":"Record verified work"}' },
          { type: "tool_call_end", id: "record-todo" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Todo feedback received." },
          { type: "finish", reason: "stop" },
        ];
  });
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["write"] }),
  };
  let lifecycle = createSessionLifecycle(options);
  const created = await lifecycle.create({ targetIdentity });
  await lifecycle.close();
  const logPath = join(
    stateRoot,
    "projects",
    created.projectId.replace(/^sha256:/u, ""),
    "sessions",
    `${created.sessionId}.jsonl`,
  );
  if (legacy) {
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    const genesis = JSON.parse(lines[0] as string) as {
      record: { todoPermissionPolicyVersion?: string };
    };
    delete genesis.record.todoPermissionPolicyVersion;
    lines[0] = JSON.stringify(genesis);
    await writeFile(logPath, `${lines.join("\n")}\n`);
  }
  lifecycle = createSessionLifecycle(options);
  return {
    root,
    workspaceRoot,
    stateRoot,
    logPath,
    created,
    get lifecycle() {
      return lifecycle;
    },
    async reopen() {
      await lifecycle.close();
      lifecycle = createSessionLifecycle(options);
      return lifecycle;
    },
    async records() {
      return (
        await openJsonlSessionStore<SessionRecord>({
          workspaceRoot,
          stateRoot,
          sessionId: created.sessionId,
        })
      ).read();
    },
    async close() {
      await chmod(logPath, 0o600);
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("legacy JSONL retains its old bytes and permission behavior until an explicit durable upgrade; branches inherit the selected prefix", async () => {
  const f = await fixture(true);
  try {
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.legacy-v1",
    });
    const permissions: RuntimeEvent[] = [];
    const stop = f.lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        permissions.push(event);
        f.lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
      }
    });
    await expect(
      f.lifecycle.continue({
        sessionId: f.created.sessionId,
        input: { text: "Record legacy work" },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    stop();
    expect(permissions).toMatchObject([
      {
        type: "tool_permission_requested",
        name: "create_todo",
        subject: { type: "workspace_path", path: "." },
      },
    ]);
    await f.reopen();
    const before = await f.lifecycle.inspect({ sessionId: f.created.sessionId });
    expect(before).toMatchObject({ todoPermissionPolicy: "todo-permission.legacy-v1" });
    const oldBytes = await readFile(f.logPath);
    const upgraded = await f.lifecycle.upgradeTodoPermissionPolicy({
      sessionId: f.created.sessionId,
    });
    expect(upgraded).toMatchObject({ todoPermissionPolicy: "todo-permission.session-v1" });
    const upgradedBytes = await readFile(f.logPath);
    expect(upgradedBytes.subarray(0, oldBytes.length)).toEqual(oldBytes);
    const appended = upgradedBytes
      .subarray(oldBytes.length)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(appended).toMatchObject([
      {
        record: {
          type: "session_todo_permission_policy_changed",
          recordVersion: 1,
          policyVersion: "todo-permission.session-v1",
        },
      },
    ]);
    const beforeBranch = await f.lifecycle.branch({
      parentSessionId: f.created.sessionId,
      atSequence: before.lastSequence,
    });
    const afterBranch = await f.lifecycle.branch({
      parentSessionId: f.created.sessionId,
      atSequence: upgraded.lastSequence,
    });
    await f.reopen();
    expect(await f.lifecycle.inspect({ sessionId: beforeBranch.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.legacy-v1",
    });
    expect(await f.lifecycle.inspect({ sessionId: afterBranch.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.session-v1",
    });
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.session-v1",
    });
  } finally {
    await f.close();
  }
});

test("a legacy pending permission prevents upgrade and retains its exact durable request identity", async () => {
  const f = await fixture(true);
  let running: ReturnType<typeof f.lifecycle.continue> | undefined;
  const abort = new AbortController();
  try {
    const requested =
      Promise.withResolvers<Extract<RuntimeEvent, { type: "tool_permission_requested" }>>();
    f.lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") requested.resolve(event);
    });
    running = f.lifecycle.continue({
      sessionId: f.created.sessionId,
      input: { text: "Record pending work" },
      signal: abort.signal,
    });
    const first = await Promise.race([
      requested.promise,
      running.then(() => {
        throw new Error("Legacy run did not request permission");
      }),
    ]);
    const pendingBytes = await readFile(f.logPath);
    await expect(
      f.lifecycle.upgradeTodoPermissionPolicy({ sessionId: f.created.sessionId }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    expect(await readFile(f.logPath)).toEqual(pendingBytes);
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.legacy-v1",
    });
    f.lifecycle.decidePermission({ requestId: first.requestId, decision: "allow" });
    await expect(running).resolves.toMatchObject({ result: { status: "completed" } });
    const records = await f.records();
    const decisions = records.flatMap((entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "tool_permission_decided"
        ? [entry.record.event]
        : [],
    );
    expect(decisions).toEqual([
      expect.objectContaining({ requestId: first.requestId, decision: "allow" }),
    ]);
    await expect(
      f.lifecycle.upgradeTodoPermissionPolicy({ sessionId: f.created.sessionId }),
    ).resolves.toMatchObject({ todoPermissionPolicy: "todo-permission.session-v1" });
    expect((await readFile(f.logPath)).subarray(0, pendingBytes.length)).toEqual(pendingBytes);
  } finally {
    abort.abort();
    await running;
    await f.close();
  }
});

test.each(["unknown-genesis", "invalid-genesis", "unknown-upgrade", "downgrade"] as const)(
  "cold JSONL rejects %s Todo permission policy without rewriting history",
  async (corruption) => {
    const f = await fixture(true);
    try {
      if (corruption.endsWith("upgrade") || corruption === "downgrade")
        await f.lifecycle.upgradeTodoPermissionPolicy({ sessionId: f.created.sessionId });
      await f.lifecycle.close();
      const lines = (await readFile(f.logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              record: {
                type: string;
                todoPermissionPolicyVersion?: unknown;
                policyVersion?: unknown;
              };
            },
        );
      if (corruption.endsWith("genesis")) {
        const genesis = lines[0];
        if (genesis === undefined) throw new Error("Missing genesis");
        genesis.record.todoPermissionPolicyVersion =
          corruption === "unknown-genesis" ? "todo-permission.future-v9" : 1;
      } else {
        const changed = lines.find(
          (line) => line.record.type === "session_todo_permission_policy_changed",
        );
        if (changed === undefined) throw new Error("Missing upgrade record");
        changed.record.policyVersion =
          corruption === "downgrade" ? "todo-permission.legacy-v1" : "todo-permission.future-v9";
      }
      const corruptBytes = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
      await writeFile(f.logPath, corruptBytes);
      await f.reopen();
      await expect(f.lifecycle.inspect({ sessionId: f.created.sessionId })).rejects.toMatchObject({
        code: "session_log_invalid",
      });
      expect(await readFile(f.logPath, "utf8")).toBe(corruptBytes);
    } finally {
      await f.close();
    }
  },
);

test("an unwritable legacy log does not report a successful Todo permission upgrade", async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(f.logPath);
    await chmod(f.logPath, 0o400);
    await expect(
      f.lifecycle.upgradeTodoPermissionPolicy({ sessionId: f.created.sessionId }),
    ).rejects.toThrow();
    expect(await readFile(f.logPath)).toEqual(before);
    await chmod(f.logPath, 0o600);
    await f.reopen();
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.legacy-v1",
    });
  } finally {
    await f.close();
  }
});

test("default Todo permission does not mask real JSONL persistence failure or create a partial Todo", async () => {
  const f = await fixture(false);
  try {
    const requests: RuntimeEvent[] = [];
    f.lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        requests.push(event);
        f.lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
      }
      if (event.type === "tool_started" && event.callId === "record-todo")
        chmodSync(f.logPath, 0o400);
    });
    await expect(
      f.lifecycle.continue({ sessionId: f.created.sessionId, input: { text: "Record work" } }),
    ).resolves.toMatchObject({
      result: { status: "failed", executionFailure: { category: "storage_io_failed" } },
    });
    expect(requests).toEqual([]);
    const records = await f.records();
    expect(
      records.some((entry) => entry.schemaVersion === 3 && entry.record.type === "todo_created"),
    ).toBe(false);
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todo: { storeRevision: 0, counts: { pending: 0, inProgress: 0, completed: 0 } },
    });
  } finally {
    await f.close();
  }
});

test("explicit upgrade leaves a cold legacy Plan frozen; only a later Plan cycle permits Todo", async () => {
  const f = await fixture(true);
  try {
    const entered = await f.lifecycle.enterPlan({ sessionId: f.created.sessionId });
    expect(entered.plan).toMatchObject({
      policyVersion: "plan-policy.hybrid-v1",
      state: "exploring",
    });
    const oldPlan = entered.plan;
    if (oldPlan === undefined) throw new Error("Expected the legacy Plan cycle");
    await f.reopen();
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.legacy-v1",
      plan: oldPlan,
    });
    const beforeUpgrade = await readFile(f.logPath);
    const upgraded = await f.lifecycle.upgradeTodoPermissionPolicy({
      sessionId: f.created.sessionId,
    });
    expect(upgraded.todoPermissionPolicy).toBe("todo-permission.session-v1");
    expect(upgraded.plan).toEqual(oldPlan);
    expect((await readFile(f.logPath)).subarray(0, beforeUpgrade.length)).toEqual(beforeUpgrade);
    await f.reopen();
    const events: RuntimeEvent[] = [];
    f.lifecycle.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_permission_requested")
        f.lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
    });
    expect(
      await f.lifecycle.continue({
        sessionId: f.created.sessionId,
        input: { text: "Attempt Todo in the unchanged old Plan" },
      }),
    ).toMatchObject({
      result: { status: "completed" },
      snapshot: { plan: oldPlan, todo: { storeRevision: 0 } },
    });
    expect(events.filter((event) => event.type === "tool_failed")).toMatchObject([
      { name: "create_todo", error: { code: "permission_denied" } },
    ]);
    expect(events.filter((event) => event.type === "tool_permission_requested")).toEqual([]);
    await f.lifecycle.exitPlan({
      sessionId: f.created.sessionId,
      cycleId: oldPlan.cycleId,
      revision: oldPlan.revision,
    });
    const successor = await f.lifecycle.enterPlan({ sessionId: f.created.sessionId });
    expect(successor.plan).toMatchObject({
      policyVersion: "plan-policy.hybrid-todo-v1",
      state: "exploring",
    });
    expect(successor.plan?.cycleId).not.toBe(oldPlan.cycleId);
    events.length = 0;
    expect(
      await f.lifecycle.continue({
        sessionId: f.created.sessionId,
        input: { text: "Record Todo in the new Plan" },
      }),
    ).toMatchObject({
      result: { status: "completed" },
      snapshot: { todo: { storeRevision: 1, counts: { pending: 1 } } },
    });
    expect(events.filter((event) => event.type === "tool_permission_requested")).toEqual([]);
    expect(events.filter((event) => event.type === "tool_permission_decided")).toMatchObject([
      {
        name: "create_todo",
        decision: "allow",
        subject: { type: "session_todo", sessionId: f.created.sessionId, operation: "create_todo" },
      },
    ]);
    await f.reopen();
    expect(await f.lifecycle.inspect({ sessionId: f.created.sessionId })).toMatchObject({
      todoPermissionPolicy: "todo-permission.session-v1",
      plan: successor.plan,
      todo: { storeRevision: 1, counts: { pending: 1 } },
    });
  } finally {
    await f.close();
  }
});
