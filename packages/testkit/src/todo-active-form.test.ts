import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  type ModelEvent,
} from "@adam-agent/agent";
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

test("Todo activeForm survives model feedback, cold resume and branch inheritance", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-active-form-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  let step = 0;
  let feedback: unknown;
  const driver = new FakeModelDriver((request) => {
    if (step++ === 0)
      return [
        ...calls("create", "create_todo", {
          title: "Inspect dependencies",
          activeForm: "Inspecting dependencies",
        }),
        { type: "finish", reason: "tool_calls" },
      ];
    feedback = request.messages.find(
      (message) => message.role === "tool" && message.callId === "create",
    );
    return [
      { type: "text_delta", text: "Created." },
      { type: "finish", reason: "stop" },
    ];
  });
  const harness = createInMemorySessionLifecycleHarness();
  const options = {
    workspaceRoot,
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
  };
  const lifecycle = harness.createLifecycle(options);
  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({ sessionId: created.sessionId, input: { text: "Record the task." } }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    expect(feedback).toMatchObject({
      result: {
        status: "completed",
        output: {
          policyVersion: "todo-policy.v1",
          storeRevision: 1,
          item: {
            title: "Inspect dependencies",
            activeForm: "Inspecting dependencies",
            itemRevision: 1,
          },
        },
      },
    });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    const branch = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: inspected.lastSequence,
    });
    await lifecycle.close();
    const cold = harness.createLifecycle(options);
    try {
      for (const sessionId of [created.sessionId, branch.sessionId]) {
        await cold.resume({ sessionId });
        const records = await (await harness.sessions.open(sessionId))?.read();
        const durableItems = records?.flatMap((entry) => {
          if (entry.schemaVersion !== 3) return [];
          if (entry.record.type === "todo_created") return [entry.record.item];
          if (entry.record.type === "todo_store_inherited") return entry.record.items;
          return [];
        });
        expect(durableItems).toMatchObject([
          { title: "Inspect dependencies", activeForm: "Inspecting dependencies", itemRevision: 1 },
        ]);
        const listed = await cold.listTodos({ sessionId, expectedStoreRevision: 1 });
        expect(listed).toMatchObject({
          status: "completed",
          output: { items: [{ activeForm: "Inspecting dependencies" }] },
        });
      }
    } finally {
      await cold.close();
    }
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("historical Todo profiles retain exact definitions and reject activeForm before shared mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-old-profile-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const tools = createCodingToolRegistry({ workspaceRoot });
  const names = ["create_todo", "update_todo", "update_todos"];
  const legacy = names.map((name) => {
    const adapter = tools.resolve(name)?.retainedVersions?.[0];
    if (adapter === undefined) throw new Error("Expected retained Todo adapter");
    return adapter;
  });
  expect(legacy.map((adapter) => adapter.definitionDigest)).toEqual([
    "sha256:433f1d1882c54fb38a9810096b899d24f4b3f99271cce98f60b8fed90dce8723",
    "sha256:6782598668f32b84c7c392646664f5886844d5b0e259f443afe257c408190686",
    "sha256:45cdf3d17d275bfa653512d3c11198efdd274ff183ef6d5ae3c504d00163fc24",
  ]);
  const oldTools = {
    definitions: () =>
      tools
        .definitions()
        .map(
          (definition) =>
            legacy.find((adapter) => adapter.definition.name === definition.name)?.definition ??
            definition,
        ),
    resolve: (name: string) =>
      legacy.find((adapter) => adapter.definition.name === name) ?? tools.resolve(name),
  };
  let step = 0;
  let id = "";
  const feedback: unknown[] = [];
  const driver = new FakeModelDriver((request) => {
    expect(request.tools.filter((definition) => names.includes(definition.name))).toEqual(
      legacy.map((adapter) => adapter.definition),
    );
    if (step++ === 0)
      return [
        ...calls("old-create", "create_todo", { title: "Historical task" }),
        { type: "finish", reason: "tool_calls" },
      ];
    if (step === 2) {
      const result = request.messages.find(
        (message) => message.role === "tool" && message.callId === "old-create",
      );
      if (result?.role !== "tool" || result.result.status !== "completed")
        throw new Error("Expected old create");
      id = (result.result.output as { item: { id: string } }).item.id;
      feedback.push(result);
      return [
        { type: "text_delta", text: "Created." },
        { type: "finish", reason: "stop" },
      ];
    }
    if (step === 3)
      return [
        ...calls("bad-create", "create_todo", { title: "New field", activeForm: "Working" }),
        ...calls("bad-update", "update_todo", {
          id,
          expectedItemRevision: 1,
          expectedStoreRevision: 1,
          activeForm: "Working",
        }),
        ...calls("bad-batch", "update_todos", {
          expectedStoreRevision: 1,
          updates: [{ id, expectedItemRevision: 1, activeForm: null }],
        }),
        ...calls("old-update", "update_todo", {
          id,
          expectedItemRevision: 1,
          expectedStoreRevision: 1,
          status: "in_progress",
        }),
        { type: "finish", reason: "tool_calls" },
      ];
    feedback.push(
      ...request.messages.filter(
        (message) => message.role === "tool" && message.callId !== "old-create",
      ),
    );
    return [
      { type: "text_delta", text: "Historical profile preserved." },
      { type: "finish", reason: "stop" },
    ];
  });
  const harness = createInMemorySessionLifecycleHarness();
  const options = {
    workspaceRoot,
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
  };
  const old = harness.createLifecycle({ ...options, tools: oldTools });
  const cold = harness.createLifecycle({ ...options, tools });
  try {
    const created = await old.create({ targetIdentity });
    await old.continue({ sessionId: created.sessionId, input: { text: "Create a Todo." } });
    await old.close();
    await cold.resume({ sessionId: created.sessionId });
    await cold.continue({
      sessionId: created.sessionId,
      input: { text: "Keep the historical tool profile." },
    });
    expect(feedback).toMatchObject([
      {
        result: {
          status: "completed",
          output: { item: { title: "Historical task", itemRevision: 1 } },
        },
      },
      { callId: "bad-create", result: { status: "failed", error: { code: "invalid_tool_input" } } },
      { callId: "bad-update", result: { status: "failed", error: { code: "invalid_tool_input" } } },
      { callId: "bad-batch", result: { status: "failed", error: { code: "invalid_tool_input" } } },
      {
        callId: "old-update",
        result: {
          status: "completed",
          output: { storeRevision: 2, item: { itemRevision: 2, status: "in_progress" } },
        },
      },
    ]);
    const records = await (await harness.sessions.open(created.sessionId))?.read();
    const items = records?.flatMap((entry) =>
      entry.schemaVersion === 3 &&
      (entry.record.type === "todo_created" || entry.record.type === "todo_updated")
        ? [entry.record.item]
        : [],
    );
    expect(items).toHaveLength(2);
    expect(items?.every((item) => !Object.hasOwn(item, "activeForm"))).toBe(true);
  } finally {
    await old.close();
    await cold.close();
    await rm(root, { recursive: true, force: true });
  }
});
