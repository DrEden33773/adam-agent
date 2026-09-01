import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createModelTargets,
  createMutationToolRegistry,
  createPermissionPolicy,
  createReadToolRegistry,
  type LocalInputResourceSelectionV1,
  type ModelDriver,
  type ModelMessage,
  type ModelTargetIdentity,
  type ModelTargets,
  type ModelToolDefinition,
  type RuntimeEvent,
  resolveThinkingPolicy,
  type ThinkingPolicySelectionV1,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  createPlanToolProfileV1,
  createUnavailablePlanShellEnvironmentV1,
  inputResourceIngestBarrier,
  openJsonlSessionStore,
  type ProjectLifecycleOwner,
  planApprovalIntentBarrier,
  preparedDirectDeepSeekV2ContextProfile,
  type SessionRecord,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionCloseDrainBarrier,
  sessionLogicalRunStartedBarrier,
  sessionProjectLifecycleOwner,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import { exercisePlanShellRecoveryFixture } from "./plan-shell-recovery.test-support.js";
import {
  sessionLifecycleAnswerOnlyDeepSeekStream as answerOnlyDeepSeekStream,
  sessionLifecycleBasePrompt as basePrompt,
  createSessionLifecycleForTests as createSessionLifecycle,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const testContextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

function modelTargetsWithDriver(driver: ModelDriver): ModelTargets {
  return {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: {
              status: "available" as const,
              credentialSource: "deterministic test adapter",
            },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
}

function completedTodoItemId(messages: readonly ModelMessage[], name: string): string | undefined {
  const message = messages.findLast(
    (candidate) => candidate.role === "tool" && candidate.name === name,
  );
  const output =
    message?.role === "tool" && message.result.status === "completed"
      ? message.result.output
      : undefined;
  const item =
    typeof output === "object" && output !== null ? Reflect.get(output, "item") : undefined;
  const id = typeof item === "object" && item !== null ? Reflect.get(item, "id") : undefined;
  if (typeof id !== "string") {
    return undefined;
  }
  return id;
}

const visionResponsesIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash-vision-exp.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash-vision-exp",
  route: "direct",
  profileVersion: 2,
  certification: "certified",
};

test("SessionLifecycle folds Todo state across a deterministic restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-restart-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  let firstCall = 0;
  const firstDriver = new FakeModelDriver(() => {
    firstCall += 1;
    return firstCall === 1
      ? [
          { type: "tool_call_start", id: "create-restart-todo", name: "create_todo" },
          {
            type: "tool_call_delta",
            id: "create-restart-todo",
            json: '{"title":"Survive restart","details":"Exact durable details"}',
          },
          { type: "tool_call_end", id: "create-restart-todo" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Created before restart." },
          { type: "finish", reason: "stop" },
        ];
  });
  const firstLifecycle = harness.createLifecycle({
    modelTargets: modelTargetsWithDriver(firstDriver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await firstLifecycle.create({ targetIdentity });
    await firstLifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create one durable Todo." },
    });
    const records = await (await harness.sessions.open(created.sessionId))?.read();
    const createdRecord = records?.find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_created",
    );
    if (createdRecord?.schemaVersion !== 3 || createdRecord.record.type !== "todo_created") {
      throw new Error("Expected one durable Todo creation record.");
    }
    const todoId = createdRecord.record.item.id;
    await firstLifecycle.close();

    let resumedCall = 0;
    const resumedDriver = new FakeModelDriver((request) => {
      resumedCall += 1;
      const summary = request.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.content.startsWith("Adam runtime Todo summary v1"),
      );
      expect(summary?.content).toContain(
        '"storeRevision":1,"counts":{"pending":1,"inProgress":0,"completed":0}',
      );
      if (resumedCall === 1) {
        return [
          { type: "tool_call_start", id: "get-restarted-todo", name: "get_todo" },
          {
            type: "tool_call_delta",
            id: "get-restarted-todo",
            json: JSON.stringify({ id: todoId }),
          },
          { type: "tool_call_end", id: "get-restarted-todo" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "get_todo",
        result: {
          status: "completed",
          output: {
            storeRevision: 1,
            item: {
              id: todoId,
              status: "pending",
              title: "Survive restart",
              details: "Exact durable details",
            },
          },
        },
      });
      return [
        { type: "text_delta", text: "Read after restart." },
        { type: "finish", reason: "stop" },
      ];
    });
    const resumedLifecycle = harness.createLifecycle({
      modelTargets: modelTargetsWithDriver(resumedDriver),
      permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
      stateRoot,
      tools: createCodingToolRegistry({ workspaceRoot }),
      workspaceRoot,
    });
    await expect(
      resumedLifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Read the durable Todo after restart." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Read after restart." },
    });
    await resumedLifecycle.close();
  } finally {
    await firstLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a self-consistent forged Todo dependency cycle", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-cycle-tamper-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let firstId: string | undefined;
  let secondId: string | undefined;
  let call = 0;
  const driver = new FakeModelDriver((request) => {
    call += 1;
    const latestTodoId = completedTodoItemId(request.messages, "create_todo");
    if (call === 1) {
      return [
        { type: "tool_call_start", id: "create-cycle-anchor", name: "create_todo" },
        {
          type: "tool_call_delta",
          id: "create-cycle-anchor",
          json: '{"title":"Cycle anchor"}',
        },
        { type: "tool_call_end", id: "create-cycle-anchor" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (call === 2) {
      if (latestTodoId === undefined) {
        throw new Error("Expected the first created Todo ID.");
      }
      firstId = latestTodoId;
      return [
        { type: "tool_call_start", id: "create-cycle-dependent", name: "create_todo" },
        {
          type: "tool_call_delta",
          id: "create-cycle-dependent",
          json: JSON.stringify({ title: "Cycle dependent", dependencyIds: [firstId] }),
        },
        { type: "tool_call_end", id: "create-cycle-dependent" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (call === 3) {
      if (latestTodoId === undefined) {
        throw new Error("Expected the second created Todo ID.");
      }
      secondId = latestTodoId;
      return [
        { type: "tool_call_start", id: "update-cycle-forge", name: "update_todo" },
        {
          type: "tool_call_delta",
          id: "update-cycle-forge",
          json: JSON.stringify({
            id: firstId,
            expectedItemRevision: 1,
            expectedStoreRevision: 2,
            title: "Cycle anchor updated",
          }),
        },
        { type: "tool_call_end", id: "update-cycle-forge" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "The valid acyclic update completed." },
      { type: "finish", reason: "stop" },
    ];
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Create two Todos and update the first without a cycle." },
        limits: { maxTurns: 3 },
      }),
    ).resolves.toMatchObject({
      result: { status: "failed", error: { code: "turn_limit_exceeded" } },
    });
    const store = await harness.sessions.open(created.sessionId);
    const records = await store?.read();
    const response = records?.find(
      (entry) =>
        entry.schemaVersion === 3 &&
        entry.record.type === "model_response_completed" &&
        entry.record.response.toolCalls.some((toolCall) => toolCall.id === "update-cycle-forge"),
    );
    const terminal = records?.find(
      (entry) =>
        entry.schemaVersion === 3 &&
        entry.record.type === "runtime_event" &&
        entry.record.event.type === "tool_completed" &&
        entry.record.event.callId === "update-cycle-forge",
    );
    const updated = records?.find(
      (entry) =>
        entry.schemaVersion === 3 &&
        entry.record.type === "todo_updated" &&
        entry.record.callId === "update-cycle-forge",
    );
    if (
      response?.schemaVersion !== 3 ||
      response.record.type !== "model_response_completed" ||
      terminal?.schemaVersion !== 3 ||
      terminal.record.type !== "runtime_event" ||
      terminal.record.event.type !== "tool_completed" ||
      updated?.schemaVersion !== 3 ||
      updated.record.type !== "todo_updated" ||
      firstId === undefined ||
      secondId === undefined
    ) {
      throw new Error("Expected one complete Todo update history.");
    }
    const updateCall = response.record.response.toolCalls.find(
      (toolCall) => toolCall.id === "update-cycle-forge",
    );
    if (updateCall === undefined) {
      throw new Error("Expected the Todo update model call.");
    }
    const forgedArguments = JSON.stringify({
      id: firstId,
      expectedItemRevision: 1,
      expectedStoreRevision: 2,
      title: "Cycle anchor updated",
      dependencyIds: [secondId],
    });
    Object.assign(updateCall, { argumentsJson: forgedArguments });
    const updateIntent = response.record.response.toolIntents.find(
      (intent) => intent.callId === "update-cycle-forge",
    );
    if (updateIntent === undefined) {
      throw new Error("Expected the Todo update intent.");
    }
    Object.assign(updateIntent, {
      argumentsDigest: `sha256:${createHash("sha256").update(forgedArguments).digest("hex")}`,
    });
    Object.assign(updated.record.item, { dependencyIds: [secondId] });
    const terminalOutput = terminal.record.event.output as {
      readonly item?: { readonly dependencyIds?: readonly string[] };
    };
    if (terminalOutput.item === undefined) {
      throw new Error("Expected the Todo update terminal output.");
    }
    Object.assign(terminalOutput.item, { dependencyIds: [secondId] });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle Plan may read Todo but cannot mutate or materialize it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-todo-policy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let todoId: string | undefined;
  let call = 0;
  const requests: ModelMessage[][] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push([...request.messages]);
    call += 1;
    if (call === 1) {
      return [
        { type: "tool_call_start", id: "create-before-plan", name: "create_todo" },
        {
          type: "tool_call_delta",
          id: "create-before-plan",
          json: '{"title":"Readable during Plan"}',
        },
        { type: "tool_call_end", id: "create-before-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (call === 2) {
      todoId = completedTodoItemId(request.messages, "create_todo");
      if (todoId === undefined) {
        throw new Error("Expected the created Todo output.");
      }
      return [
        { type: "text_delta", text: "Todo created before Plan." },
        { type: "finish", reason: "stop" },
      ];
    }
    if (call === 3) {
      expect(request.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["get_todo", "list_todos", "submit_plan"]),
      );
      expect(request.tools.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["create_todo", "update_todo"]),
      );
      return [
        { type: "tool_call_start", id: "get-during-plan", name: "get_todo" },
        {
          type: "tool_call_delta",
          id: "get-during-plan",
          json: JSON.stringify({ id: todoId }),
        },
        { type: "tool_call_end", id: "get-during-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (call === 4) {
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "get_todo",
        result: { status: "completed", output: { item: { id: todoId } } },
      });
      return [
        { type: "tool_call_start", id: "create-during-plan", name: "create_todo" },
        {
          type: "tool_call_delta",
          id: "create-during-plan",
          json: '{"title":"Must not materialize"}',
        },
        { type: "tool_call_end", id: "create-during-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "create_todo",
      result: { status: "failed", error: { code: "permission_denied" } },
    });
    return [
      { type: "text_delta", text: "Plan read without Todo mutation." },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create one Todo before planning." },
    });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const planned = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect Todo without mutating it." },
    });
    expect(planned.result).toEqual({
      status: "completed",
      answer: "Plan read without Todo mutation.",
    });
    expect(planned.snapshot.todo).toEqual({
      policyVersion: "todo-policy.v1",
      storeRevision: 1,
      counts: { pending: 1, inProgress: 0, completed: 0 },
      blockedCount: 0,
    });
    expect(requests).toHaveLength(5);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle exposes submit_plan only while exploring and makes it terminal for the run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Runtime plan\n\n1. Inspect.\n2. Implement.\n";
  const title = "Runtime plan";
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    expect(request.tools.map((tool) => tool.name)).toContain("submit_plan");
    return [
      { type: "tool_call_start", id: "submit-exact-plan", name: "submit_plan" },
      {
        type: "tool_call_delta",
        id: "submit-exact-plan",
        json: JSON.stringify({ title, markdown }),
      },
      { type: "tool_call_end", id: "submit-exact-plan" },
      { type: "finish", reason: "tool_calls" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Produce the exact implementation plan." },
    });

    expect(requestCount).toBe(1);
    expect(continued).toMatchObject({
      result: { status: "completed", answer: "" },
      snapshot: {
        plan: {
          state: "ready",
          revision: 2,
          submission: {
            title,
            contentDigest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
          },
        },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle accepts submit_plan at the exact UTF-8 title and Markdown byte boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-boundary-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = `${"界".repeat(21_845)}a`;
  const title = `${"界".repeat(170)}ab`;
  expect(Buffer.byteLength(markdown, "utf8")).toBe(64 * 1024);
  expect(Buffer.byteLength(title, "utf8")).toBe(512);
  const driver = new FakeModelDriver(() => [
    { type: "tool_call_start", id: "submit-boundary-plan", name: "submit_plan" },
    {
      type: "tool_call_delta",
      id: "submit-boundary-plan",
      json: JSON.stringify({ title, markdown }),
    },
    { type: "tool_call_end", id: "submit-boundary-plan" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Publish the exact boundary plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected the boundary Plan artifact to be ready.");
    }
    expect(submitted.snapshot.plan.submission.title).toBe(title);
    expect(submitted.snapshot.plan.submission.artifact.byteCount).toBe(64 * 1024);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { label: "empty Markdown", argumentsJson: JSON.stringify({ markdown: "" }) },
  {
    label: "Markdown above 64 KiB",
    argumentsJson: JSON.stringify({ markdown: `${"界".repeat(21_845)}aa` }),
  },
  {
    label: "a title above 512 bytes",
    argumentsJson: JSON.stringify({ markdown: "# Valid\n", title: "界".repeat(171) }),
  },
  {
    label: "an unknown argument",
    argumentsJson: JSON.stringify({ markdown: "# Valid\n", extra: true }),
  },
  { label: "malformed JSON", argumentsJson: '{"markdown":' },
])(
  "SessionLifecycle rejects submit_plan with $label before artifact publication",
  async ({ argumentsJson }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-invalid-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const driver = new FakeModelDriver(() => [
      { type: "tool_call_start", id: "submit-invalid-plan", name: "submit_plan" },
      { type: "tool_call_delta", id: "submit-invalid-plan", json: argumentsJson },
      { type: "tool_call_end", id: "submit-invalid-plan" },
      { type: "finish", reason: "tool_calls" },
    ]);
    const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
      modelTargets: modelTargetsWithDriver(driver),
      stateRoot,
      workspaceRoot,
    });

    try {
      const created = await lifecycle.create({ targetIdentity });
      await lifecycle.enterPlan({ sessionId: created.sessionId });
      const rejected = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Attempt an invalid Plan submission." },
      });
      expect(rejected.result).toMatchObject({
        status: "failed",
        error: { code: "model_protocol_invalid" },
      });
      expect(rejected.snapshot.plan).toMatchObject({ state: "exploring", revision: 1 });
      expect(rejected.snapshot.plan).not.toHaveProperty("submission");
      await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle leaves Plan exploring when the model emits only an ordinary final answer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-ordinary-final-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const answer = "# This prose is not a submitted Plan\n\nIt must remain ordinary assistant text.";
  const driver = new FakeModelDriver((request) => {
    expect(request.tools.map((tool) => tool.name)).toContain("submit_plan");
    return [
      { type: "text_delta", text: answer },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Answer without calling submit_plan." },
    });
    expect(continued.result).toEqual({ status: "completed", answer });
    expect(continued.snapshot.plan).toMatchObject({ state: "exploring", revision: 1 });
    expect(continued.snapshot.plan).not.toHaveProperty("submission");
    await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["first", "last"] as const)(
  "SessionLifecycle rejects a mixed submit_plan batch with submit_plan %s before any tool effect",
  async (position) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-mixed-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "must not be read\n", "utf8");
    const submitEvents = [
      { type: "tool_call_start" as const, id: "mixed-submit", name: "submit_plan" },
      {
        type: "tool_call_delta" as const,
        id: "mixed-submit",
        json: '{"markdown":"# Must not publish\\n"}',
      },
      { type: "tool_call_end" as const, id: "mixed-submit" },
    ];
    const readEvents = [
      { type: "tool_call_start" as const, id: "mixed-read", name: "read_file" },
      { type: "tool_call_delta" as const, id: "mixed-read", json: '{"path":"README.md"}' },
      { type: "tool_call_end" as const, id: "mixed-read" },
    ];
    const driver = new FakeModelDriver(() => [
      ...(position === "first" ? submitEvents : readEvents),
      ...(position === "first" ? readEvents : submitEvents),
      { type: "finish", reason: "tool_calls" },
    ]);
    const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
      modelTargets: modelTargetsWithDriver(driver),
      stateRoot,
      tools: createCodingToolRegistry({ workspaceRoot }),
      workspaceRoot,
    });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));

    try {
      const created = await lifecycle.create({ targetIdentity });
      await lifecycle.enterPlan({ sessionId: created.sessionId });
      const rejected = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Attempt one invalid mixed submission batch." },
      });

      expect(rejected.result).toMatchObject({
        status: "failed",
        error: { code: "model_protocol_invalid" },
      });
      expect(rejected.snapshot.plan).toMatchObject({ state: "exploring", revision: 1 });
      expect(events.filter((event) => event.type === "tool_requested")).toEqual([]);
      await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
      await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        plan: { state: "exploring", revision: 1 },
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(["failed terminal", "mismatched completed output", "mismatched artifact byte count"])(
  "SessionLifecycle rejects a forged plan_submitted record after a $caseName",
  async (caseName) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-forged-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const driver = new FakeModelDriver(() => [
      { type: "tool_call_start", id: "forged-submit", name: "submit_plan" },
      {
        type: "tool_call_delta",
        id: "forged-submit",
        json: '{"markdown":"# Exact durable plan\\n"}',
      },
      { type: "tool_call_end", id: "forged-submit" },
      { type: "finish", reason: "tool_calls" },
    ]);
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets: modelTargetsWithDriver(driver),
      stateRoot,
      workspaceRoot,
    });

    try {
      const created = await lifecycle.create({ targetIdentity });
      await lifecycle.enterPlan({ sessionId: created.sessionId });
      await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Submit one exact durable Plan." },
      });
      const store = await harness.sessions.open(created.sessionId);
      const records = await store?.read();
      const terminal = records?.find(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "runtime_event" &&
          entry.record.event.type === "tool_completed" &&
          entry.record.event.callId === "forged-submit",
      );
      const submitted = records?.find(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_submitted",
      );
      if (
        terminal?.schemaVersion !== 3 ||
        terminal.record.type !== "runtime_event" ||
        terminal.record.event.type !== "tool_completed" ||
        submitted?.schemaVersion !== 3 ||
        submitted.record.type !== "plan_submitted"
      ) {
        throw new Error("Expected the exact submit terminal and Plan record.");
      }
      if (caseName === "failed terminal") {
        Object.assign(terminal.record, {
          event: {
            type: "tool_failed",
            callId: "forged-submit",
            name: "submit_plan",
            error: { code: "invalid_tool_input", message: "forged failure" },
          },
        });
      } else if (caseName === "mismatched completed output") {
        Object.assign(terminal.record.event, {
          output: {
            status: "ready",
            planId: "123e4567-e89b-42d3-a456-426614176099",
            revision: submitted.record.revision,
            contentDigest: submitted.record.contentDigest,
          },
        });
      } else {
        Object.assign(submitted.record.artifact, {
          byteCount: submitted.record.artifact.byteCount + 1,
        });
      }

      await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
        code: "session_invalid",
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

function thinkingSelection(
  capability: {
    readonly capabilityId: string;
    readonly capabilityVersion: 1;
    readonly capabilityDigest: `sha256:${string}`;
  },
  requestedLevelId: string,
): ThinkingPolicySelectionV1 {
  return {
    requestedLevelId,
    capability: {
      id: capability.capabilityId,
      version: capability.capabilityVersion,
      digest: capability.capabilityDigest,
    },
  };
}
const codingToolDefinitions = createCodingToolRegistry({
  workspaceRoot: "/tmp/adam-agent-session-lifecycle-tool-definitions",
}).definitions();

test("SessionLifecycle enters Plan with an unavailable shell snapshot and fails before spawn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-shell-unavailable-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "unavailable-shell", name: "run_shell" },
        {
          type: "tool_call_delta",
          id: "unavailable-shell",
          json: JSON.stringify({ command: "uname -s" }),
        },
        { type: "tool_call_end", id: "unavailable-shell" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "unavailable-shell",
      result: { status: "failed", error: { code: "shell_start_failed" } },
    });
    return [
      { type: "text_delta", text: "The unavailable shell failed closed before spawn." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested") {
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: created.sessionId });
    expect(entered.plan?.shellEnvironment?.shell).toEqual({
      status: "unavailable",
      lookupPath: "/bin/sh",
    });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Inspect the operating system." },
      }),
    ).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The unavailable shell failed closed before spawn.",
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_permission_requested",
        name: "run_shell",
        subject: expect.objectContaining({
          type: "plan_command",
          assessment: expect.objectContaining({ reasons: ["environment_untrusted"] }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        name: "run_shell",
        error: expect.objectContaining({ code: "shell_start_failed" }),
      }),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "a mismatched durable assessment",
    command: "unknown --diagnose",
    decision: "allow",
    assessmentMatches: false,
    omitPermissionRequest: false,
    started: false,
    outcome: "reask",
  },
  {
    label: "a forged direct allow",
    command: "unknown --diagnose",
    decision: "allow",
    assessmentMatches: true,
    omitPermissionRequest: true,
    started: false,
    outcome: "invalid",
  },
  {
    label: "a started shell effect",
    command: "unknown --diagnose",
    decision: "allow",
    assessmentMatches: true,
    omitPermissionRequest: false,
    started: true,
    outcome: "indeterminate",
  },
  {
    label: "an exact ambiguous deny before result",
    command: "unknown --diagnose",
    decision: "deny",
    assessmentMatches: true,
    omitPermissionRequest: false,
    started: false,
    outcome: "denied",
  },
  {
    label: "an exact hard deny before result",
    command: "touch forbidden.txt",
    decision: "deny",
    assessmentMatches: true,
    omitPermissionRequest: true,
    started: false,
    outcome: "denied",
  },
])(
  "SessionLifecycle hybrid Plan semantic recovery folds $label",
  async ({ command, decision, assessmentMatches, omitPermissionRequest, started, outcome }) => {
    const recovered = await exercisePlanShellRecoveryFixture({
      shellEnvironmentFactory: createUnavailablePlanShellEnvironmentV1,
      command,
      decision: decision as "allow" | "deny",
      assessmentMatches,
      omitPermissionRequest,
      started,
    });

    if (outcome === "invalid") {
      expect(recovered).toMatchObject({
        resume: { status: "rejected", code: "session_invalid" },
        providerCalls: 0,
        publicEvents: [],
      });
      return;
    }
    if (outcome === "indeterminate") {
      expect(recovered).toMatchObject({
        resume: {
          status: "ready",
          snapshotStatus: "settled",
          runResult: { status: "failed", error: { code: "tool_effect_indeterminate" } },
        },
        providerCalls: 0,
        publicEvents: [],
      });
      return;
    }
    expect(recovered).toMatchObject({
      resume: { status: "ready", snapshotStatus: "interrupted" },
      continuationResult: {
        status: "completed",
        answer: "Recovered the exact Plan shell boundary.",
      },
      observedToolResult: { status: "failed", error: { code: "permission_denied" } },
      providerCalls: 1,
      secondResume: {
        snapshotStatus: "settled",
        runResult: {
          status: "completed",
          answer: "Recovered the exact Plan shell boundary.",
        },
      },
    });
    expect(
      recovered.publicEvents.filter((event) => event.type === "tool_permission_requested"),
    ).toHaveLength(outcome === "reask" ? 1 : 0);
    expect(recovered.publicEvents.filter((event) => event.type === "tool_started")).toHaveLength(0);
    if (outcome === "denied") {
      expect(
        recovered.publicEvents.filter((event) => event.type === "tool_permission_decided"),
      ).toHaveLength(0);
    }
  },
);

test("SessionLifecycle cold recovery preserves a historical read-v1 Plan profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-read-v1-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const registry = createCodingToolRegistry({ workspaceRoot });
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      expect(request.tools.map((tool) => tool.name)).toEqual([
        "read_file",
        "search_repository",
        "activate_skill",
        "read_skill_resource",
        "read_input_resource",
        "get_todo",
        "list_todos",
        "submit_plan",
      ]);
      return [
        { type: "tool_call_start", id: "historical-shell", name: "run_shell" },
        { type: "tool_call_delta", id: "historical-shell", json: '{"command":"uname -s"}' },
        { type: "tool_call_end", id: "historical-shell" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "historical-shell",
      result: { status: "failed", error: { code: "permission_denied" } },
    });
    return [
      { type: "text_delta", text: "The historical Plan remained read-only." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const warm = harness.createLifecycle({ modelTargets, stateRoot, tools: registry, workspaceRoot });
  let cold: ReturnType<typeof harness.createLifecycle> | undefined;

  try {
    const created = await warm.create({ targetIdentity });
    const source = created.promptContext?.toolProfile;
    const store = await harness.sessions.open(created.sessionId);
    if (source === undefined || store === undefined) {
      throw new Error("Expected the created session authority.");
    }
    const eligibleToolProfile = createPlanToolProfileV1({
      source: { version: source.version, digest: source.digest },
      definitions: source.definitions.flatMap((definition) => {
        const adapter = registry.resolve(definition.name);
        return adapter?.effect === "read"
          ? [
              {
                name: definition.name,
                definitionDigest: adapter.definitionDigest as `sha256:${string}`,
                effect: adapter.effect,
                source: "builtin" as const,
              },
            ]
          : [];
      }),
    });
    await store.append({
      schemaVersion: 3,
      sequence: created.lastSequence + 1,
      record: {
        type: "plan_cycle_entered",
        recordVersion: 1,
        cycleId: "123e4567-e89b-42d3-a456-426614176100",
        revision: 1,
        policyVersion: "plan-policy.read-v1",
        eligibleToolProfile,
      },
    });
    await warm.close();
    cold = harness.createLifecycle({ modelTargets, stateRoot, tools: registry, workspaceRoot });

    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { plan: { policyVersion: "plan-policy.read-v1" } },
    });
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Try a shell command in the historical Plan." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The historical Plan remained read-only." },
      snapshot: { plan: { policyVersion: "plan-policy.read-v1" } },
    });
  } finally {
    await warm.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle Plan exposes only its exact eligible profile and denies a forged write call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-write-deny-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      expect(request.tools.map((tool) => tool.name)).toEqual([
        "read_file",
        "search_repository",
        "run_shell",
        "activate_skill",
        "read_skill_resource",
        "read_input_resource",
        "get_todo",
        "list_todos",
        "submit_plan",
      ]);
      return [
        { type: "tool_call_start", id: "plan-write", name: "write_file" },
        {
          type: "tool_call_delta",
          id: "plan-write",
          json: '{"path":"forbidden.txt","content":"must not exist"}',
        },
        { type: "tool_call_end", id: "plan-write" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      name: "write_file",
      result: { status: "failed", error: { code: "permission_denied" } },
    });
    return [
      { type: "text_delta", text: "The mutation was denied by Plan." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({
      allowedEffects: ["read", "write", "execute", "network", "delegate", "administrative"],
    }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Inspect the change without modifying the repository." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The mutation was denied by Plan." },
      snapshot: {
        plan: {
          state: "exploring",
          policyVersion: "plan-policy.hybrid-v1",
          shellPolicyVersion: "plan-shell-policy.v1",
        },
      },
    });
    await expect(readFile(join(workspaceRoot, "forbidden.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle Plan fails closed for an unknown MCP tool outside the exact profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-unknown-mcp-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      return [
        { type: "tool_call_start", id: "unknown-mcp", name: "mcp__ghost__inspect" },
        { type: "tool_call_delta", id: "unknown-mcp", json: "{}" },
        { type: "tool_call_end", id: "unknown-mcp" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "unknown-mcp",
      name: "mcp__ghost__inspect",
      result: {
        status: "failed",
        error: {
          code: "unknown_tool",
          message: "Plan denies tools outside its exact eligible Tool Profile.",
        },
      },
    });
    return [
      { type: "text_delta", text: "The unknown MCP tool was denied." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Try an unregistered MCP inspection." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The unknown MCP tool was denied." },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects Plan entry while an ordinary run owns the session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-running-entry-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const providerStarted = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const driver: ModelDriver = {
    async *stream() {
      providerStarted.resolve();
      await releaseProvider.promise;
      yield { type: "text_delta", text: "The ordinary run completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const running = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Complete one ordinary run." },
    });
    await providerStarted.promise;

    await expect(lifecycle.enterPlan({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.not.toHaveProperty(
      "plan",
    );

    releaseProvider.resolve();
    const completed = await running;
    expect(completed).toMatchObject({
      result: { status: "completed", answer: "The ordinary run completed." },
    });
    expect(completed.snapshot).not.toHaveProperty("plan");
  } finally {
    releaseProvider.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects Plan entry from interrupted history without appending", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-interrupted-entry-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "First answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "First prompt" },
    });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const interruptedRunId = "123e4567-e89b-42d3-a456-426614174011";
    const interruptedRecords: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId: interruptedRunId,
          userMessage: "Interrupted prompt",
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId: interruptedRunId,
          event: { type: "user_message", text: "Interrupted prompt" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId: interruptedRunId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, [
            { role: "user", content: "First prompt" },
            { role: "assistant", content: "First answer.", toolCalls: [] },
            { role: "user", content: "Interrupted prompt" },
          ]),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId: interruptedRunId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId: interruptedRunId,
          event: { type: "session_interrupted", reason: "cancelled" },
        },
      },
    ];
    for (const [index, record] of interruptedRecords.entries()) {
      await store.append({
        ...record,
        sequence: completed.snapshot.lastSequence + index + 1,
      } as SessionRecord);
    }
    const beforeEntry = await store.read();
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "interrupted",
    });

    await expect(lifecycle.enterPlan({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(store.read()).resolves.toEqual(beforeEntry);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle never exposes Plan entry as a model tool", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-model-entry-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    if (requestCount === 1) {
      expect(request.tools.some((tool) => tool.name === "enter_plan")).toBe(false);
      return [
        { type: "tool_call_start", id: "model-enter-plan", name: "enter_plan" },
        { type: "tool_call_delta", id: "model-enter-plan", json: "{}" },
        { type: "tool_call_end", id: "model-enter-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "model-enter-plan",
      name: "enter_plan",
      result: {
        status: "failed",
        error: { code: "unknown_tool", message: "Unknown tool: enter_plan" },
      },
    });
    return [
      { type: "text_delta", text: "Only an external user command can enter Plan." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Try to enter Plan yourself." },
      limits: { maxTurns: 2 },
    });

    expect(continued).toMatchObject({
      result: { status: "completed", answer: "Only an external user command can enter Plan." },
    });
    expect(continued.snapshot).not.toHaveProperty("plan");
    expect(requestCount).toBe(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported durable Plan policy before model use", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-policy-history-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  let resolveCalls = 0;

  try {
    const created = await initial.create({ targetIdentity });
    await initial.enterPlan({ sessionId: created.sessionId });
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const durableHistory = await readFile(sessionPath, "utf8");
    expect(durableHistory.match(/plan-policy\.hybrid-v1/gu)).toHaveLength(1);
    await writeFile(
      sessionPath,
      durableHistory.replace("plan-policy.hybrid-v1", "plan-policy.future-v99"),
      "utf8",
    );
    const modelTargets: ModelTargets = {
      async resolve() {
        resolveCalls += 1;
        throw new Error("An unsupported durable Plan policy must fail before model resolution.");
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile: testContextProfile,
            },
          ],
        };
      },
    };
    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Do not silently upgrade this Plan cycle." },
      }),
    ).rejects.toMatchObject({ code: "session_log_invalid" });
    expect(resolveCalls).toBe(0);
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a self-consistent forged Plan profile before model resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-profile-tamper-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  let resolveCalls = 0;

  try {
    const created = await initial.create({ targetIdentity });
    await initial.enterPlan({ sessionId: created.sessionId });
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const records = (await readFile(sessionPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionRecord);
    const entered = records.find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_cycle_entered",
    );
    if (entered?.schemaVersion !== 3 || entered.record.type !== "plan_cycle_entered") {
      throw new Error("Expected the durable Plan entry.");
    }
    const forgedWithoutDigest = {
      version: 1 as const,
      source: entered.record.eligibleToolProfile.source,
      definitions: entered.record.eligibleToolProfile.definitions.slice(1),
    };
    Object.assign(entered.record, {
      eligibleToolProfile: {
        ...forgedWithoutDigest,
        digest: `sha256:${createHash("sha256")
          .update(canonicalFixtureJson(forgedWithoutDigest))
          .digest("hex")}`,
      },
    });
    await writeFile(
      sessionPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const modelTargets: ModelTargets = {
      async resolve() {
        resolveCalls += 1;
        return {
          identity: targetIdentity,
          driver: new FakeModelDriver([
            { type: "text_delta", text: "must not run" },
            { type: "finish", reason: "stop" },
          ]),
          contextProfile: testContextProfile,
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile: testContextProfile,
            },
          ],
        };
      },
    };
    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Do not accept a forged eligible profile." },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    expect(resolveCalls).toBe(0);
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves the exact Plan cycle identity through context compaction", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-compaction-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Plan compaction\n", "utf8");
  const compactProfile: ContextProfile = {
    version: 1,
    contextWindowTokens: 10_000,
    maximumOutputTokens: 1_000,
    compactAtTokens: 5_000,
    postCompactTargetTokens: 3_000,
    retainedTargetTokens: 200,
    estimatorVersion: 1,
  };
  let ordinaryCalls = 0;
  let compactionCalls = 0;
  const driver = new FakeModelDriver((request) => {
    if (request.tools.length === 0) {
      compactionCalls += 1;
      return [
        {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Preserve the exact active Plan cycle.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Complete the read-only inspection."],
            nextSafeAction: "Read the requested file.",
          }),
        },
        { type: "usage", inputTokens: 120, outputTokens: 30 },
        { type: "finish", reason: "stop" },
      ];
    }
    ordinaryCalls += 1;
    return ordinaryCalls === 1
      ? [
          { type: "tool_call_start", id: "plan-read", name: "read_file" },
          { type: "tool_call_delta", id: "plan-read", json: '{"path":"README.md"}' },
          { type: "tool_call_end", id: "plan-read" },
          { type: "usage", inputTokens: 7_000, outputTokens: 10 },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "The read-only inspection survived compaction." },
          { type: "usage", inputTokens: 80, outputTokens: 12 },
          { type: "finish", reason: "stop" },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: compactProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: compactProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: created.sessionId });
    const plan = entered.plan;
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect README without changing the repository." },
    });
    expect(continued.result).toEqual({
      status: "completed",
      answer: "The read-only inspection survived compaction.",
    });
    expect(continued.snapshot).toMatchObject({ plan });
    expect(compactionCalls).toBe(1);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      plan,
      context: { checkpoint: { status: "committed" } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle prefix branch inherits the exact selected exploring Plan state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: parent.sessionId });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: entered.lastSequence,
    });

    expect(child).toMatchObject({
      lineage: {
        parentSessionId: parent.sessionId,
        parentEventPosition: entered.lastSequence,
      },
      plan: entered.plan,
    });
    await expect(lifecycle.inspect({ sessionId: child.sessionId })).resolves.toMatchObject({
      plan: entered.plan,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle prefix branch inherits Todo identity and then diverges locally", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let todoId: string | undefined;
  const driver = new FakeModelDriver((request) => {
    const latestUser = request.messages.findLast((message) => message.role === "user");
    if (latestUser?.role !== "user" || typeof latestUser.content !== "string") {
      throw new Error("Expected one exact Todo branch prompt.");
    }
    const latestTool = request.messages.at(-1);
    if (latestUser.content === "Create the parent Todo.") {
      return latestTool?.role === "user"
        ? [
            { type: "tool_call_start", id: "create-parent-todo", name: "create_todo" },
            {
              type: "tool_call_delta",
              id: "create-parent-todo",
              json: '{"title":"Shared branch identity"}',
            },
            { type: "tool_call_end", id: "create-parent-todo" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "Parent Todo created." },
            { type: "finish", reason: "stop" },
          ];
    }
    if (latestUser.content === "Complete only the child Todo.") {
      return latestTool?.role === "user"
        ? [
            { type: "tool_call_start", id: "update-child-todo", name: "update_todo" },
            {
              type: "tool_call_delta",
              id: "update-child-todo",
              json: JSON.stringify({
                id: todoId,
                expectedItemRevision: 1,
                expectedStoreRevision: 1,
                status: "completed",
              }),
            },
            { type: "tool_call_end", id: "update-child-todo" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "Child Todo completed." },
            { type: "finish", reason: "stop" },
          ];
    }
    expect(latestTool).toMatchObject({
      role: "user",
      content: "Read the unchanged parent Todo.",
    });
    const summary = request.messages.find(
      (message) =>
        message.role === "assistant" && message.content.startsWith("Adam runtime Todo summary v1"),
    );
    expect(summary?.content).toContain(
      '"storeRevision":1,"counts":{"pending":1,"inProgress":0,"completed":0}',
    );
    return [
      { type: "text_delta", text: "Parent remained pending." },
      { type: "finish", reason: "stop" },
    ];
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create the parent Todo." },
    });
    const parentRecords = await (await harness.sessions.open(parent.sessionId))?.read();
    const createdRecord = parentRecords?.find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_created",
    );
    if (createdRecord?.schemaVersion !== 3 || createdRecord.record.type !== "todo_created") {
      throw new Error("Expected one parent Todo record.");
    }
    todoId = createdRecord.record.item.id;
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: parentRun.snapshot.lastSequence,
    });
    await expect(
      lifecycle.continue({
        sessionId: child.sessionId,
        input: { text: "Complete only the child Todo." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Child Todo completed." } });
    await expect(
      lifecycle.continue({
        sessionId: parent.sessionId,
        input: { text: "Read the unchanged parent Todo." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Parent remained pending." },
    });
    const childRecords = await (await harness.sessions.open(child.sessionId))?.read();
    expect(
      childRecords?.find(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_store_inherited",
      ),
    ).toMatchObject({
      record: {
        policyVersion: "todo-policy.v1",
        storeRevision: 1,
        items: [{ id: todoId, status: "pending", itemRevision: 1 }],
      },
    });
    expect(
      childRecords?.find(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_updated",
      ),
    ).toMatchObject({ record: { item: { id: todoId, status: "completed", itemRevision: 2 } } });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a valid-looking inherited Todo store that diverges from its source prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-branch-tamper-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver((request) =>
    request.messages.at(-1)?.role === "user"
      ? [
          { type: "tool_call_start", id: "create-tamper-todo", name: "create_todo" },
          {
            type: "tool_call_delta",
            id: "create-tamper-todo",
            json: '{"title":"Source-bound Todo"}',
          },
          { type: "tool_call_end", id: "create-tamper-todo" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Todo ready for branching." },
          { type: "finish", reason: "stop" },
        ],
  );
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create one source-bound Todo." },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: parentRun.snapshot.lastSequence,
    });
    const childStore = await harness.sessions.open(child.sessionId);
    const inherited = (await childStore?.read())?.find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_store_inherited",
    );
    if (inherited?.schemaVersion !== 3 || inherited.record.type !== "todo_store_inherited") {
      throw new Error("Expected the inherited Todo store.");
    }
    Object.assign(inherited.record.items[0] as object, { title: "Forged but schema-valid Todo" });

    await expect(lifecycle.inspect({ sessionId: child.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches a Todo store larger than one record through bounded inheritance chunks", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-branch-chunks-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const details = "x".repeat(8 * 1024);
  const driver = new FakeModelDriver((request) => {
    const latestUser = request.messages.findLast((message) => message.role === "user");
    const latest = request.messages.at(-1);
    if (latestUser?.role !== "user" || typeof latestUser.content !== "string") {
      throw new Error("Expected one exact Todo chunking prompt.");
    }
    if (latest?.role === "user") {
      const batchOffset = latestUser.content === "Create Todo batch one." ? 0 : 64;
      return [
        ...Array.from({ length: 64 }, (_, index) => {
          const ordinal = batchOffset + index;
          const callId = `create-chunked-todo-${ordinal}`;
          return [
            { type: "tool_call_start" as const, id: callId, name: "create_todo" },
            {
              type: "tool_call_delta" as const,
              id: callId,
              json: JSON.stringify({ title: `Chunked Todo ${ordinal}`, details }),
            },
            { type: "tool_call_end" as const, id: callId },
          ];
        }).flat(),
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Todo batch created." },
      { type: "finish", reason: "stop" },
    ];
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create Todo batch one." },
    });
    const completed = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create Todo batch two." },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: completed.snapshot.lastSequence,
    });
    const childRecords = await (await harness.sessions.open(child.sessionId))?.read();
    const inherited = childRecords?.filter(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_store_inherited",
    );

    expect(inherited?.length).toBeGreaterThan(1);
    expect(
      inherited?.every((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8") <= 1024 * 1024),
    ).toBe(true);
    await expect(lifecycle.inspect({ sessionId: child.sessionId })).resolves.toMatchObject({
      todo: {
        storeRevision: 128,
        counts: { pending: 128, inProgress: 0, completed: 0 },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle binds Todo reads to the exact folded store revision", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-todo-read-revision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let todoId: string | undefined;
  const driver = new FakeModelDriver((request) => {
    const latestUser = request.messages.findLast((message) => message.role === "user");
    const latestTool = request.messages.at(-1);
    if (latestUser?.role !== "user" || typeof latestUser.content !== "string") {
      throw new Error("Expected one exact Todo revision prompt.");
    }
    if (latestTool?.role === "user" && latestUser.content === "Create the revision Todo.") {
      return [
        { type: "tool_call_start", id: "create-revision-todo", name: "create_todo" },
        {
          type: "tool_call_delta",
          id: "create-revision-todo",
          json: '{"title":"Revision-bound Todo"}',
        },
        { type: "tool_call_end", id: "create-revision-todo" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (latestTool?.role === "user" && latestUser.content === "Update the revision Todo.") {
      return [
        { type: "tool_call_start", id: "update-revision-todo", name: "update_todo" },
        {
          type: "tool_call_delta",
          id: "update-revision-todo",
          json: JSON.stringify({
            id: todoId,
            expectedItemRevision: 1,
            expectedStoreRevision: 1,
            title: "Newer revision",
          }),
        },
        { type: "tool_call_end", id: "update-revision-todo" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Todo mutation settled." },
      { type: "finish", reason: "stop" },
    ];
  });
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  let stalePrefix: readonly SessionRecord[] | undefined;
  let serveStalePrefixOnce = false;
  const wrapStore = (
    store: Awaited<ReturnType<SessionStoreDirectory<SessionRecord>["create"]>>,
  ) => ({
    append: (record: SessionRecord) => store.append(record),
    appendBatch: (records: readonly SessionRecord[]) => store.appendBatch(records),
    async read() {
      if (serveStalePrefixOnce && stalePrefix !== undefined) {
        serveStalePrefixOnce = false;
        return stalePrefix;
      }
      return store.read();
    },
  });
  const directory: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      return wrapStore(await backing.create(sessionId));
    },
    listSessionEntries: () => backing.listSessionEntries(),
    listSessionIds: () => backing.listSessionIds(),
    async open(sessionId) {
      const store = await backing.open(sessionId);
      return store === undefined ? undefined : wrapStore(store);
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: false,
    [sessionStoreDirectory]: directory,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create the revision Todo." },
    });
    stalePrefix = await (await backing.open(created.sessionId))?.read();
    const createdTodo = stalePrefix?.find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "todo_created",
    );
    if (createdTodo?.schemaVersion !== 3 || createdTodo.record.type !== "todo_created") {
      throw new Error("Expected the created revision Todo.");
    }
    todoId = createdTodo.record.item.id;
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Update the revision Todo." },
    });
    serveStalePrefixOnce = true;

    await expect(
      lifecycle.getTodo({
        sessionId: created.sessionId,
        expectedStoreRevision: 1,
        id: todoId,
      }),
    ).resolves.toEqual({ status: "stale" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle prefix branch keeps an approved parent artifact ready without transferring approval", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-approved-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? [
          { type: "tool_call_start", id: "submit-branch-plan", name: "submit_plan" },
          {
            type: "tool_call_delta",
            id: "submit-branch-plan",
            json: '{"markdown":"# Branch-ready plan\\n"}',
          },
          { type: "tool_call_end", id: "submit-branch-plan" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Implemented the inherited exact Plan." },
          { type: "finish", reason: "stop" },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [planApprovalIntentBarrier]: {
      afterDurableRecord() {
        throw new Error("stop before parent kickoff");
      },
    },
  });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: parent.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Submit the plan for branch inheritance." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    await expect(
      lifecycle.continue({
        sessionId: parent.sessionId,
        planApproval: {
          commandId: "123e4567-e89b-42d3-a456-426614176030",
          cycleId: ready.cycleId,
          revision: ready.revision,
          planId: ready.submission.planId,
          contentDigest: ready.submission.contentDigest,
        },
      }),
    ).rejects.toThrow("stop before parent kickoff");
    const approved = await lifecycle.inspect({ sessionId: parent.sessionId });
    if (approved.schemaVersion !== 3 || approved.plan?.state !== "approved_not_started") {
      throw new Error("Expected the unstarted parent approval.");
    }

    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: approved.lastSequence,
    });

    const { approval: _parentApproval, ...approvedWithoutApproval } = approved.plan;
    expect(child.plan).toEqual({
      ...approvedWithoutApproval,
      state: "ready",
    });
    expect(child.plan).not.toHaveProperty("approval");
    if (child.plan?.state !== "ready") {
      throw new Error("Expected the inherited child Plan to remain ready.");
    }
    await lifecycle.close();
    lifecycle = harness.createLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      [sessionLogicalRunStartedBarrier]: {
        afterDurableRecord() {
          throw new Error("stop after inherited child kickoff became durable");
        },
      },
    });
    await expect(
      lifecycle.continue({
        sessionId: child.sessionId,
        planApproval: {
          commandId: "123e4567-e89b-42d3-a456-426614176033",
          cycleId: child.plan.cycleId,
          revision: child.plan.revision,
          planId: child.plan.submission.planId,
          contentDigest: child.plan.submission.contentDigest,
        },
      }),
    ).rejects.toThrow("stop after inherited child kickoff became durable");
    await lifecycle.close();
    lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(lifecycle.continue({ sessionId: child.sessionId })).resolves.toMatchObject({
      result: { status: "completed", answer: "Implemented the inherited exact Plan." },
    });
    expect(providerCalls).toBe(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle recovers a started Plan kickoff in the same reserved run without duplicate consumption", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-started-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Recover this kickoff\n";
  let providerCalls = 0;
  let recoveredApprovedPlan: Parameters<ModelDriver["stream"]>[0]["approvedPlan"];
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "tool_call_start", id: "submit-recovery-plan", name: "submit_plan" },
        {
          type: "tool_call_delta",
          id: "submit-recovery-plan",
          json: JSON.stringify({ markdown }),
        },
        { type: "tool_call_end", id: "submit-recovery-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    recoveredApprovedPlan = request.approvedPlan;
    return [
      { type: "text_delta", text: "Recovered the reserved implementation run." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [planApprovalIntentBarrier]: {
      afterDurableRecord() {
        throw new Error("stop before initial kickoff");
      },
    },
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the recoverable plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        planApproval: {
          commandId: "123e4567-e89b-42d3-a456-426614176031",
          cycleId: ready.cycleId,
          revision: ready.revision,
          planId: ready.submission.planId,
          contentDigest: ready.submission.contentDigest,
        },
      }),
    ).rejects.toThrow("stop before initial kickoff");
    const approved = await lifecycle.inspect({ sessionId: created.sessionId });
    if (approved.schemaVersion !== 3 || approved.plan?.state !== "approved_not_started") {
      throw new Error("Expected the durable approval intent.");
    }
    const approval = approved.plan.approval;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the durable Session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: approved.lastSequence + 1,
      record: {
        type: "logical_run_started",
        runId: approval.kickoffRunId,
        userMessage: "Implement the approved plan.",
        planKickoff: approval,
      },
    });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "interrupted",
    });
    await lifecycle.close();
    lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(lifecycle.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "Recovered the reserved implementation run.",
      },
    });

    expect(recoveredApprovedPlan).toEqual({
      version: 1,
      ...approval,
      markdown,
    });
    const records = await store.read();
    expect(
      records.filter(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "logical_run_started" &&
          entry.record.runId === approval.kickoffRunId,
      ),
    ).toHaveLength(1);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle stops approved Plan projection immediately after the kickoff run settles", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-projection-lifetime-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# One-run projection\n\nImplement this exact plan once.\n";
  let requestOrdinal = 0;
  let kickoffProjection: Parameters<ModelDriver["stream"]>[0]["approvedPlan"];
  let followupProjection: Parameters<ModelDriver["stream"]>[0]["approvedPlan"];
  const driver = new FakeModelDriver((request) => {
    requestOrdinal += 1;
    if (requestOrdinal === 1) {
      return [
        { type: "tool_call_start", id: "submit-one-run-plan", name: "submit_plan" },
        {
          type: "tool_call_delta",
          id: "submit-one-run-plan",
          json: JSON.stringify({ markdown }),
        },
        { type: "tool_call_end", id: "submit-one-run-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (requestOrdinal === 2) {
      kickoffProjection = request.approvedPlan;
      return [
        { type: "text_delta", text: "Implemented the approved Plan." },
        { type: "finish", reason: "stop" },
      ];
    }
    followupProjection = request.approvedPlan;
    return [
      { type: "text_delta", text: "Answered the ordinary follow-up." },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: modelTargetsWithDriver(driver),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the one-run plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected the one-run Plan artifact to be ready.");
    }
    const ready = submitted.snapshot.plan;
    const kickoff = await lifecycle.continue({
      sessionId: created.sessionId,
      planApproval: {
        commandId: "123e4567-e89b-42d3-a456-426614176032",
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      },
    });
    expect(kickoff).toMatchObject({
      result: { status: "completed", answer: "Implemented the approved Plan." },
    });
    expect(kickoff.snapshot).not.toHaveProperty("plan");
    expect(kickoffProjection).toMatchObject({
      version: 1,
      sessionId: created.sessionId,
      planId: ready.submission.planId,
      contentDigest: ready.submission.contentDigest,
      markdown,
    });

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Answer after the implementation run settled." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Answered the ordinary follow-up." },
    });
    expect(followupProjection).toBeUndefined();
    expect(requestOrdinal).toBe(3);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a branch whose inherited Plan identity diverges from its source prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-branch-tamper-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    const entered = await lifecycle.enterPlan({ sessionId: parent.sessionId });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: entered.lastSequence,
    });
    const childStore = await harness.sessions.open(child.sessionId);
    if (childStore === undefined) {
      throw new Error("Expected the child session store.");
    }
    const inherited = (await childStore.read()).find(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_cycle_inherited",
    );
    if (inherited?.schemaVersion !== 3 || inherited.record.type !== "plan_cycle_inherited") {
      throw new Error("Expected the inherited Plan record.");
    }
    Object.assign(inherited.record, { cycleId: "123e4567-e89b-42d3-a456-426614174099" });

    await expect(lifecycle.inspect({ sessionId: child.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects forged Plan inheritance from an inactive source prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-branch-inactive-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });

  try {
    const inactiveParent = await lifecycle.create({ targetIdentity });
    const donor = await lifecycle.create({ targetIdentity });
    const donorPlan = (await lifecycle.enterPlan({ sessionId: donor.sessionId })).plan;
    if (donorPlan === undefined) {
      throw new Error("Expected the donor Plan cycle.");
    }
    const child = await lifecycle.branch({
      parentSessionId: inactiveParent.sessionId,
      atSequence: inactiveParent.lastSequence,
    });
    const childStore = await harness.sessions.open(child.sessionId);
    if (childStore === undefined) {
      throw new Error("Expected the child session store.");
    }
    await childStore.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "plan_cycle_inherited",
        recordVersion: 1,
        cycleId: donorPlan.cycleId,
        revision: donorPlan.revision,
        policyVersion: donorPlan.policyVersion,
        ...(donorPlan.shellPolicyVersion === undefined
          ? {}
          : { shellPolicyVersion: donorPlan.shellPolicyVersion }),
        ...(donorPlan.shellEnvironment === undefined
          ? {}
          : { shellEnvironment: donorPlan.shellEnvironment }),
        ...(donorPlan.gitPolicyVersion === undefined
          ? {}
          : { gitPolicyVersion: donorPlan.gitPolicyVersion }),
        ...(donorPlan.gitPolicyDigest === undefined
          ? {}
          : { gitPolicyDigest: donorPlan.gitPolicyDigest }),
        eligibleToolProfile: donorPlan.eligibleToolProfile,
        source: {
          sessionId: inactiveParent.sessionId,
          throughSequence: inactiveParent.lastSequence,
        },
      },
    });

    await expect(lifecycle.inspect({ sessionId: child.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

function promptProjectionFor(
  snapshot: {
    readonly promptContext?: {
      readonly assemblyIdentityDigest: `sha256:${string}`;
      readonly profileVersion: 1 | 2 | 3;
    };
    readonly todo?: {
      readonly policyVersion: "todo-policy.v1";
      readonly storeRevision: number;
      readonly counts: {
        readonly pending: number;
        readonly inProgress: number;
        readonly completed: number;
      };
      readonly blockedCount: number;
    };
  },
  transcript: string | readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[],
): {
  readonly version: 1;
  readonly assemblyIdentityDigest: `sha256:${string}`;
  readonly requestProjectionDigest: `sha256:${string}`;
} {
  const assemblyIdentityDigest = snapshot.promptContext?.assemblyIdentityDigest;
  if (assemblyIdentityDigest === undefined) {
    throw new Error("The fixture requires a v1 prompt context.");
  }
  return {
    version: 1 as const,
    assemblyIdentityDigest,
    requestProjectionDigest: `sha256:${createHash("sha256")
      .update(
        canonicalFixtureJson({
          version: 1,
          messages: [
            { role: "system", content: basePrompt },
            ...(snapshot.promptContext !== undefined && snapshot.promptContext.profileVersion !== 1
              ? [{ role: "developer" as const, content: skillUsagePrompt }]
              : []),
            ...(snapshot.todo === undefined
              ? []
              : [
                  {
                    role: "assistant" as const,
                    content: `Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n${JSON.stringify(
                      {
                        ...snapshot.todo,
                        guidance:
                          "Use list_todos for bounded discovery and get_todo for one exact item.",
                      },
                    )}`,
                    toolCalls: [],
                  },
                ]),
            ...(typeof transcript === "string"
              ? [{ role: "user" as const, content: transcript }]
              : transcript),
          ],
          tools:
            tools ??
            (snapshot.promptContext !== undefined && snapshot.promptContext.profileVersion !== 1
              ? codingToolDefinitions
              : []),
        }),
      )
      .digest("hex")}`,
  };
}

test("session metadata observers cannot overturn a durable naming mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-metadata-observer-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });
  const releaseObserver = Promise.withResolvers<void>();
  const unsubscribeFailure = lifecycle.subscribeMetadata(() => {
    throw new Error("observer failed");
  });
  const unsubscribePending = lifecycle.subscribeMetadata(() => releaseObserver.promise);
  let failureGuard: ReturnType<typeof setTimeout> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    const naming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable name",
    });
    await expect(
      Promise.race([
        naming,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("A metadata observer blocked durable naming.")),
            1_000,
          );
        }),
      ]),
    ).resolves.toMatchObject({ status: "updated" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence: 2,
    });
  } finally {
    if (failureGuard !== undefined) {
      clearTimeout(failureGuard);
    }
    releaseObserver.resolve();
    unsubscribeFailure();
    unsubscribePending();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close causally joins an admitted naming mutation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-naming-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const naming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable close name",
    });
    const closing = lifecycle.close();

    await expect(naming).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close drains an admitted ProjectExecutionDomain acquisition", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-owner-drain-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const acquisitionStarted = Promise.withResolvers<void>();
  const releaseAcquisition = Promise.withResolvers<void>();
  let holdAcquisition = false;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      if (holdAcquisition) {
        acquisitionStarted.resolve();
        await releaseAcquisition.promise;
      }
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const drainedCounts: number[] = [];
  const lifecycle = createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    [sessionCloseDrainBarrier]: {
      beforeWait({ activeCount }) {
        drainedCounts.push(activeCount);
        releaseAcquisition.resolve();
      },
    },
    [sessionProjectLifecycleOwner]: owner,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    holdAcquisition = true;
    const naming = lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Durable domain acquisition",
    });
    await acquisitionStarted.promise;
    const closing = lifecycle.close();

    await expect(naming).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
    expect(drainedCounts).toEqual([1]);
  } finally {
    releaseAcquisition.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close joins title admission before returning", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-title-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const heldOwnerOperation = Promise.withResolvers<void>();
  const releaseOwnerOperation = Promise.withResolvers<void>();
  const titleRequestStarted = Promise.withResolvers<void>();
  const releaseTitleRequest = Promise.withResolvers<void>();
  const titleDrainStarted = Promise.withResolvers<void>();
  const closeDurabilityStarted = Promise.withResolvers<void>();
  let holdNextOwnerOperation = false;
  let observeCloseDurability = false;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      const hold = holdNextOwnerOperation;
      holdNextOwnerOperation = false;
      if (observeCloseDurability && !hold) {
        closeDurabilityStarted.resolve();
      }
      if (hold) {
        heldOwnerOperation.resolve();
        await releaseOwnerOperation.promise;
      }
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const closeOrder: string[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        closeOrder.push("title-started");
        titleRequestStarted.resolve();
        await releaseTitleRequest.promise;
        yield { type: "text_delta", text: "Joined generated title" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionCloseDrainBarrier]: {
      beforeWait({ kind }) {
        if (kind === "owner") {
          releaseOwnerOperation.resolve();
        } else if (kind === "title_settlement") {
          titleDrainStarted.resolve();
        }
      },
    },
    [sessionProjectLifecycleOwner]: owner,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create title history" },
    });
    holdNextOwnerOperation = true;
    const regeneration = lifecycle.regenerateSessionTitle({ sessionId: created.sessionId });
    await heldOwnerOperation.promise;
    observeCloseDurability = true;
    const closing = lifecycle.close().then((result) => {
      closeOrder.push("closed");
      return result;
    });
    const firstClosePath = Promise.race([
      titleDrainStarted.promise.then(() => "title-drain" as const),
      closeDurabilityStarted.promise.then(() => "close-durability" as const),
    ]).then((path) => {
      releaseTitleRequest.resolve();
      return path;
    });

    await titleRequestStarted.promise;
    await expect(firstClosePath).resolves.toBe("title-drain");
    await expect(regeneration).resolves.toMatchObject({ status: "updated" });
    await expect(closing).resolves.toEqual({ status: "closed" });
    expect(closeOrder).toEqual(["title-started", "closed"]);
  } finally {
    releaseOwnerOperation.resolve();
    releaseTitleRequest.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

function canonicalFixtureJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalFixtureJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixtureJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Fixture canonical JSON requires a JSON value.");
}

function createAdam7BoundaryPng(): Buffer {
  const width = 4_096;
  const height = 4_096;
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  const rawByteLength = passes.reduce((total, [xStart, yStart, xStep, yStep]) => {
    const passWidth = Math.ceil(Math.max(0, width - xStart) / xStep);
    const passHeight = Math.ceil(Math.max(0, height - yStart) / yStep);
    return total + passHeight * (passWidth * 8 + 1);
  }, 0);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([16, 6, 0, 0, 1], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk("IHDR", header),
    createPngChunk("IDAT", deflateSync(Buffer.alloc(rawByteLength))),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createPngChunk(type: "IDAT" | "IEND" | "IHDR", data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngFixtureCrc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function pngFixtureCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function snapshotWithLastPromptProjection<Snapshot extends { readonly promptContext?: object }>(
  snapshot: Snapshot,
  digest: `sha256:${string}`,
) {
  if (snapshot.promptContext === undefined) {
    throw new Error("The fixture requires a v1 prompt context.");
  }
  return {
    ...snapshot,
    promptContext: { ...snapshot.promptContext, lastRequestProjectionDigest: digest },
  };
}

const introductionRequestDigest =
  "sha256:b6f1ebe78958c5213644321f4f936ba3f77800202a3c094c3fe4e96b065ca496" as const;
const permissionRequestDigest =
  "sha256:c82b39aa784fec5a2d91bfc5f2471cde20a55ff8f618747023c3efc21ee16f8f" as const;

test("SessionLifecycle rejects a deterministic competing owner and proceeds after release", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-memory-owner-"));
  const workspaceRoot = join(testRoot, "workspace");
  const workspaceAlias = join(testRoot, "workspace-alias");
  await mkdir(workspaceRoot);
  await symlink(workspaceRoot, workspaceAlias, "dir");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ workspaceRoot });
  const aliasLifecycle = harness.createLifecycle({ workspaceRoot: workspaceAlias });
  const competingOwner = await harness.acquireOwner();

  try {
    await expect(aliasLifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "project_in_use",
    });
    await competingOwner.release();

    await expect(aliasLifecycle.create({ targetIdentity })).resolves.toMatchObject({
      status: "idle",
      targetIdentity,
    });
  } finally {
    await competingOwner.release();
    await aliasLifecycle.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle creates durable new-schema genesis for an exact project and target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-create-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  const harness = createInMemorySessionLifecycleHarness();
  const first = harness.createLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await first.create({ targetIdentity });
    await expect(first.close()).resolves.toEqual({ status: "closed" });
    const coldLifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    cold = coldLifecycle;
    const inspected = await coldLifecycle.inspect({ sessionId: created.sessionId });

    const expected = {
      schemaVersion: 3,
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      targetIdentity,
      status: "idle",
      lastSequence: 1,
      promptContext: created.promptContext,
      skillContext: created.skillContext,
      todo: created.todo,
    };
    expect({ created, inspected }).toEqual({ created: expected, inspected: expected });
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await first.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle snapshots one thinking policy and reuses it across tool continuations", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-policy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam\n", "utf8");
  const policyTargetIdentity: ModelTargetIdentity = {
    ...targetIdentity,
    profileVersion: 3,
  };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const requestPolicies: unknown[] = [];
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestPolicies.push(request.thinkingPolicy);
    requestCount += 1;
    return requestCount === 1
      ? [
          { type: "tool_call_start", id: "read-project", name: "read_file" },
          { type: "tool_call_delta", id: "read-project", json: '{"path":"README.md"}' },
          { type: "tool_call_end", id: "read-project" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "The project is Adam." },
          { type: "finish", reason: "stop" },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity: policyTargetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the project name." },
      thinkingSelection: thinkingSelection(thinkingCapability, "max"),
    });

    expect(continued.result).toEqual({ status: "completed", answer: "The project is Adam." });
    expect(requestPolicies).toHaveLength(2);
    expect(requestPolicies[0]).toEqual(requestPolicies[1]);
    expect(requestPolicies[0]).toMatchObject({
      schemaVersion: 1,
      requestedLevelId: "max",
      effectiveLevelId: "max",
      capability: {
        id: thinkingCapability.capabilityId,
        version: 1,
        digest: thinkingCapability.capabilityDigest,
      },
      mapping: {
        requestPath: "provider_options.deepseek",
        thinkingType: "enabled",
        reasoningEffort: "max",
      },
    });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the admitted session store.");
    }
    expect(await store.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "logical_run_started",
            thinkingPolicy: requestPolicies[0],
          }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported thinking level before draft persistence or provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-rejection-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: policyTargetIdentity,
        input: { text: "Do not downgrade this request." },
        thinkingSelection: thinkingSelection(thinkingCapability, "medium"),
      }),
    ).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a thinking capability minted for another exact target before admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-target-mismatch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const mismatchedCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === "deepseek-v4-pro.direct" &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (mismatchedCapability === undefined) {
    throw new Error("Expected the alternate Direct DeepSeek thinking capability.");
  }
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability: mismatchedCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability: mismatchedCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: policyTargetIdentity,
        input: { text: "Reject the wrong exact-target capability." },
        thinkingSelection: thinkingSelection(mismatchedCapability, "low"),
      }),
    ).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold recovery reuses the durable thinking snapshot without remapping it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const durablePolicy = resolveThinkingPolicy(thinkingCapability, "low");
  const requestPolicies: unknown[] = [];
  const driver = new FakeModelDriver((request) => {
    requestPolicies.push(request.thinkingPolicy);
    return [
      { type: "text_delta", text: "Recovered with the original policy." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const warm = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let cold: typeof warm | undefined;

  try {
    const created = await warm.create({ targetIdentity: policyTargetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const runId = "123e4567-e89b-42d3-a456-426614174091";
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Recover this exact policy",
        thinkingPolicy: durablePolicy,
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Recover this exact policy" },
      },
    });
    await warm.close();
    cold = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted" },
    });
    await expect(cold.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
      result: { status: "completed", answer: "Recovered with the original policy." },
    });
    expect(requestPolicies).toEqual([durablePolicy]);
  } finally {
    await warm.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a stale durable thinking profile before recovery dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-thinking-stale-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  const durablePolicy = resolveThinkingPolicy(thinkingCapability, "low");
  const staleCapability = {
    ...thinkingCapability,
    capabilityDigest: `sha256:${"0".repeat(64)}` as const,
  };
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability: staleCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability: staleCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity: policyTargetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const runId = "123e4567-e89b-42d3-a456-426614174092";
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Reject a stale profile",
        thinkingPolicy: durablePolicy,
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Reject a stale profile" },
      },
    });

    await expect(lifecycle.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted" },
    });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_thinking_policy_unsupported",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(providerCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unavailable draft Skill before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-skill-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "available-sibling");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: available-sibling\ndescription: Proves rejected admission leaves discovered Skills staged.\n---\nDo not persist this sibling before admission.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill resolution fails.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Use a missing Skill", skills: ["skill:v1:user:missing"] },
      }),
    ).rejects.toMatchObject({ code: "session_skill_unavailable" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects denied draft Skill policy before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-policy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-policy");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-policy\ndescription: Exercises draft admission policy.\n---\nUse only after read permission is admitted.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill policy denies admission.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: {
          text: "Use the policy Skill",
          skills: ["skill:v1:project:.:draft-policy"],
        },
      }),
    ).rejects.toMatchObject({ code: "session_skill_policy_rejected" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects asked draft Skill policy before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-ask-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-ask");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-ask\ndescription: Requires confirmation before admission.\n---\nDo not admit this draft before confirmation.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not run when draft Skill policy needs confirmation.");
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Use the asked Skill", skills: ["skill:v1:project:.:draft-ask"] },
      }),
    ).rejects.toMatchObject({ code: "session_skill_confirmation_required" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancels after target resolution before persisting draft resources", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-cancel");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-cancel\ndescription: Must remain staged when admission is cancelled.\n---\nNever persist this cancelled draft.\n",
    "utf8",
  );
  const harness = createInMemorySessionLifecycleHarness();
  const controller = new AbortController();
  const modelTargets: ModelTargets = {
    async resolve() {
      controller.abort();
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver(() => {
          throw new Error("The model must not run after draft admission cancellation.");
        }),
        contextProfile: testContextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: {
          text: "Cancel after resolving the target",
          skills: ["skill:v1:project:.:draft-cancel"],
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
    await expect(stat(join(stateRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle freezes draft Skill resources before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-resource");
  const resourcePath = join(skillDirectory, "references", "guide.txt");
  await mkdir(join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-resource\ndescription: Freezes resources before admission.\n---\nRead references/guide.txt.\n",
    "utf8",
  );
  await writeFile(resourcePath, "before admission\n", "utf8");
  const originalSize = (await stat(resourcePath, { bigint: true })).size.toString();
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => [
    { type: "text_delta", text: "Draft resource admitted." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  let policyDecision: "allow" | "deny" = "allow";
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: {
      decide() {
        return policyDecision;
      },
    },
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        await writeFile(resourcePath, "changed after durable logical input\n", "utf8");
        policyDecision = "deny";
      },
    },
  });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: {
        text: "Use the frozen resource Skill",
        skills: ["skill:v1:project:.:draft-resource"],
      },
    });
    const manifestEntry = admitted.snapshot.skillContext?.active[0]?.manifest.entries.find(
      (entry) => entry.path === "references/guide.txt",
    );

    expect(admitted.result).toMatchObject({ status: "completed" });
    expect(manifestEntry?.identity.size).toBe(originalSize);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits one selected input resource before its descriptor reaches the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "Aurora notes.txt");
  const content = "Aurora Compass is ready.\n";
  const bytes = Buffer.from(content, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const artifactId = digest;
  const runId = "10000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  const descriptor = {
    occurrenceId,
    displayName: "Aurora notes.txt",
    artifact: {
      id: artifactId,
      mediaType: "text/plain; charset=utf-8",
      byteCount: bytes.byteLength,
    },
    digest,
    mediaHint: "text" as const,
    provenance: "user_local_file" as const,
    support: "utf8_text" as const,
    mode: "link" as const,
  };
  const descriptorProjection = `Linked input resources (descriptor-only; use read_input_resource to read supported immutable content):\n${JSON.stringify([descriptor])}`;
  const pageDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, bytes);
  const harness = createInMemorySessionLifecycleHarness();
  let durableCommitSettled = false;
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    expect(durableCommitSettled).toBe(true);
    if (providerCalls === 1) {
      expect(request.messages.at(-1)).toEqual({
        role: "user",
        content: `Read the linked note.\n\n${descriptorProjection}`,
      });
      expect(request.tools.map((tool) => tool.name)).toContain("read_input_resource");
      return [
        { type: "tool_call_start", id: "resource-call-1", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "resource-call-1",
          json: JSON.stringify({ occurrenceId, maxByteCount: 64 }),
        },
        { type: "tool_call_end", id: "resource-call-1" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "resource-call-1",
      name: "read_input_resource",
      result: {
        status: "completed",
        output: {
          occurrenceId,
          displayName: "Aurora notes.txt",
          offset: 0,
          byteCount: bytes.byteLength,
          totalByteCount: bytes.byteLength,
          eof: true,
          nextCursor: null,
          digest,
          pageDigest,
          content,
        },
      },
    });
    return [
      { type: "text_delta", text: "The linked note says Aurora Compass is ready." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord(started) {
        const store = await harness.sessions.open(started.sessionId);
        if (store === undefined) {
          throw new Error("Expected the admitted input-resource session store.");
        }
        expect(await store.read()).toEqual(
          expect.arrayContaining([
            {
              schemaVersion: 3,
              sequence: started.sequence,
              record: {
                type: "logical_run_started",
                recordVersion: 1,
                runId,
                userMessage: "Read the linked note.",
                naming: {
                  profileVersion: 1,
                  fallbackTitle: "Read the linked note.",
                },
                inputResources: [descriptor],
              },
            },
          ]),
        );
        await expect(
          readFile(join(stateRoot, "artifacts", artifactId.slice("sha256:".length))),
        ).resolves.toEqual(bytes);
        durableCommitSettled = true;
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Read the linked note." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The linked note says Aurora Compass is ready.",
      },
    });
    expect(providerCalls).toBe(2);
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(await store?.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: {
            type: "input_resource_read_committed",
            recordVersion: 1,
            runId,
            callId: "resource-call-1",
            occurrenceId,
            displayName: "Aurora notes.txt",
            offset: 0,
            byteCount: bytes.byteLength,
            totalByteCount: bytes.byteLength,
            eof: true,
            nextCursor: null,
            digest,
            pageDigest,
            content,
          },
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle follows a stable byte cursor across strict UTF-8 input-resource pages", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-pages-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "multibyte.txt");
  const content = "A界BC好D";
  const runId = "10000000-0000-4000-8000-000000000012";
  const occurrenceId = `${runId}:input:1`;
  const cursor = `input-resource:v1:${Buffer.from(JSON.stringify([occurrenceId, 5]), "utf8").toString("base64url")}`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "tool_call_start", id: "page-1", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "page-1",
          json: JSON.stringify({ occurrenceId, maxByteCount: 5 }),
        },
        { type: "tool_call_end", id: "page-1" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (providerCalls === 2) {
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        callId: "page-1",
        result: {
          status: "completed",
          output: {
            occurrenceId,
            offset: 0,
            byteCount: 5,
            totalByteCount: 10,
            eof: false,
            nextCursor: cursor,
            content: "A界B",
          },
        },
      });
      return [
        { type: "tool_call_start", id: "page-2", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "page-2",
          json: JSON.stringify({ occurrenceId, cursor, maxByteCount: 5 }),
        },
        { type: "tool_call_end", id: "page-2" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "page-2",
      result: {
        status: "completed",
        output: {
          occurrenceId,
          offset: 5,
          byteCount: 5,
          totalByteCount: 10,
          eof: true,
          nextCursor: null,
          content: "C好D",
        },
      },
    });
    return [
      { type: "text_delta", text: "Both pages were stable." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Read both byte pages." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Both pages were stable." },
    });
    expect(providerCalls).toBe(3);
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(
      (await store?.read())?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toMatchObject([
      { record: { callId: "page-1", offset: 0, byteCount: 5, nextCursor: cursor } },
      { record: { callId: "page-2", offset: 5, byteCount: 5, nextCursor: null } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact one MiB materialized-output budget per run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-quota-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "quota.txt");
  const content = "q".repeat(64 * 1024);
  const runId = "10000000-0000-4000-8000-000000000013";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        ...Array.from({ length: 17 }, (_, index) => {
          const callId = `quota-${index + 1}`;
          return [
            { type: "tool_call_start" as const, id: callId, name: "read_input_resource" },
            {
              type: "tool_call_delta" as const,
              id: callId,
              json: JSON.stringify({ occurrenceId, maxByteCount: 64 * 1024 }),
            },
            { type: "tool_call_end" as const, id: callId },
          ];
        }).flat(),
        { type: "finish" as const, reason: "tool_calls" as const },
      ];
    }
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(17);
    expect(toolMessages.at(-1)).toEqual({
      role: "tool",
      callId: "quota-17",
      name: "read_input_resource",
      result: {
        status: "failed",
        error: {
          code: "input_resource_quota_exceeded",
          message:
            "The input-resource materialization quota for this run or session lineage would be exceeded.",
        },
      },
    });
    return [
      { type: "text_delta", text: "The seventeenth page was rejected." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Exercise the exact materialized-output budget." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The seventeenth page was rejected." },
    });
    const store = await harness.sessions.open(
      (await harness.sessions.listSessionIds())[0] as string,
    );
    expect(
      (await store?.read())?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toHaveLength(16);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact eight MiB materialized-output budget per lineage", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "adam-agent-session-input-resource-lineage-quota-"),
  );
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "lineage-quota.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "q".repeat(64 * 1024), "utf8");
  let activeOccurrenceId = "";
  let activeReadCount = 0;
  let expectQuotaFailure = false;
  let activeBatchIssued = false;
  let ordinaryProviderCalls = 0;
  let compactionProviderCalls = 0;
  let toolCallOrdinal = 0;
  const driver = new FakeModelDriver((request) => {
    if (request.tools.length === 0) {
      compactionProviderCalls += 1;
      return [
        {
          type: "text_delta",
          text: JSON.stringify({
            schemaVersion: 1,
            objective: "Preserve the linked input-resource lineage quota.",
            constraints: [],
            progress: [],
            unresolvedQuestions: [],
            failures: [],
            remainingVerification: ["Continue exact quota accounting."],
            nextSafeAction: "Continue the next bounded run.",
          }),
        },
        { type: "usage", inputTokens: 700_000, outputTokens: 32 },
        { type: "finish", reason: "stop" },
      ];
    }
    ordinaryProviderCalls += 1;
    if (!activeBatchIssued) {
      activeBatchIssued = true;
      return [
        ...Array.from({ length: activeReadCount }, () => {
          toolCallOrdinal += 1;
          const callId = `lineage-quota-${toolCallOrdinal}`;
          return [
            { type: "tool_call_start" as const, id: callId, name: "read_input_resource" },
            {
              type: "tool_call_delta" as const,
              id: callId,
              json: JSON.stringify({
                occurrenceId: activeOccurrenceId,
                maxByteCount: 64 * 1024,
              }),
            },
            { type: "tool_call_end" as const, id: callId },
          ];
        }).flat(),
        { type: "finish" as const, reason: "tool_calls" as const },
      ];
    }
    return [
      {
        type: "text_delta",
        text: expectQuotaFailure
          ? "The lineage quota rejected another page."
          : "The run materialized one MiB.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    for (let index = 1; index <= 8; index += 1) {
      const runId = `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
      activeOccurrenceId = `${runId}:input:1`;
      activeReadCount = 16;
      expectQuotaFailure = false;
      activeBatchIssued = false;
      await expect(
        lifecycle.continue({
          sessionId: created.sessionId,
          input: { text: `Materialize lineage MiB ${index}.` },
          resourceSelections: [{ type: "local_file", path: selectedPath }],
          runId,
        }),
      ).resolves.toMatchObject({ result: { status: "completed" } });
    }
    const overflowRunId = "20000000-0000-4000-8000-000000000009";
    activeOccurrenceId = `${overflowRunId}:input:1`;
    activeReadCount = 1;
    expectQuotaFailure = true;
    activeBatchIssued = false;
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject another lineage materialization page." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId: overflowRunId,
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The lineage quota rejected another page." },
    });
    const store = await openJsonlSessionStore({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const records = await store.read();
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toHaveLength(128);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "runtime_event",
            event: expect.objectContaining({
              type: "tool_failed",
              error: expect.objectContaining({ code: "input_resource_quota_exceeded" }),
            }),
          }),
        }),
      ]),
    );
    expect(ordinaryProviderCalls).toBe(18);
    expect(compactionProviderCalls).toBeGreaterThan(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves duplicate selections as ordered occurrences over one artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-duplicate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "shared.txt");
  const content = "same immutable bytes\n";
  const digest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  const runId = "20000000-0000-4000-8000-000000000011";
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let projectedOccurrences: readonly {
    readonly occurrenceId: string;
    readonly artifact: { readonly id: string };
  }[] = [];
  const driver = new FakeModelDriver((request) => {
    const user = request.messages.at(-1);
    if (user?.role !== "user") {
      throw new Error("Expected the duplicate resource descriptor request.");
    }
    if (typeof user.content !== "string") {
      throw new Error("Expected descriptor-only text for duplicate resources.");
    }
    projectedOccurrences = JSON.parse(user.content.split("\n").at(-1) ?? "[]") as readonly {
      readonly occurrenceId: string;
      readonly artifact: { readonly id: string };
    }[];
    return [
      { type: "text_delta", text: "Both occurrences are visible." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity,
      input: { text: "Keep both links." },
      resourceSelections: [
        { type: "local_file", path: selectedPath },
        { type: "local_file", path: selectedPath },
      ],
      runId,
    });
    expect(projectedOccurrences).toHaveLength(2);
    expect(projectedOccurrences.map((entry) => entry.occurrenceId)).toEqual([
      `${runId}:input:1`,
      `${runId}:input:2`,
    ]);
    expect(projectedOccurrences.map((entry) => entry.artifact.id)).toEqual([digest, digest]);
    const store = await harness.sessions.open(admitted.snapshot.sessionId);
    const logicalRun = (await store?.read())?.find(
      (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
    );
    const durableOccurrences =
      logicalRun?.schemaVersion === 3 && logicalRun.record.type === "logical_run_started"
        ? logicalRun.record.inputResources
        : undefined;
    expect(durableOccurrences).toHaveLength(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a ninth input-resource occurrence before provider dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-count-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "bounded.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "bounded\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject the ninth link." },
        resourceSelections: Array.from({ length: 9 }, () => ({
          type: "local_file" as const,
          path: selectedPath,
        })),
      }),
    ).rejects.toMatchObject({ code: "input_resource_count_exceeded" });
    expect(providerCalls).toBe(0);
    const sessionIds = await harness.sessions.listSessionIds();
    expect(sessionIds).toHaveLength(1);
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a sixty-fifth lineage input-resource occurrence before logical commit", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "adam-agent-session-input-resource-lineage-count-"),
  );
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "lineage-resource.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "lineage\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [
      { type: "text_delta", text: "Accepted bounded lineage resources." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const selections = Array.from(
      { length: 8 },
      (): LocalInputResourceSelectionV1 => ({ type: "local_file", path: selectedPath }),
    );
    let lastSequence = created.lastSequence;
    for (let index = 0; index < 8; index += 1) {
      const continued = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: `Commit lineage resource batch ${index + 1}.` },
        resourceSelections: selections,
      });
      lastSequence = continued.snapshot.lastSequence;
    }

    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Reject lineage occurrence 65." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_count_exceeded" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence,
    });
    expect(providerCalls).toBe(8);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle leaves only a safe orphan when input-resource logical commit fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-orphan-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "orphan.txt");
  const content = "Published before the failed reference.\n";
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, content, "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const wrapStore = (
    store: Awaited<ReturnType<SessionStoreDirectory<SessionRecord>["create"]>>,
  ) => ({
    async append(record: SessionRecord) {
      if (record.schemaVersion === 3 && record.record.type === "logical_run_started") {
        throw new Error("logical commit failed");
      }
      await store.append(record);
    },
    appendBatch: (records: readonly SessionRecord[]) => store.appendBatch(records),
    read: () => store.read(),
  });
  const failingDirectory: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      return wrapStore(await backing.create(sessionId));
    },
    listSessionEntries: () => backing.listSessionEntries(),
    listSessionIds: () => backing.listSessionIds(),
    async open(sessionId) {
      const store = await backing.open(sessionId);
      return store === undefined ? undefined : wrapStore(store);
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: false,
    [sessionStoreDirectory]: failingDirectory,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Fail this logical reference." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: { code: "session_persistence_failed" },
      },
    });
    expect(providerCalls).toBe(0);
    await expect(readFile(join(stateRoot, "artifacts", digest))).resolves.toEqual(
      Buffer.from(content, "utf8"),
    );
    const sessionIds = await backing.listSessionIds();
    const store = await backing.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancellation settles input-resource ingest without a durable reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "cancel.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "cancel before resource bytes are published\n", "utf8");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterOpened() {
        entered.resolve();
        await release.promise;
      },
    },
  });

  try {
    const admission = lifecycle.admit({
      targetIdentity,
      input: { text: "Cancel this resource ingest." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    await expect(admission).rejects.toMatchObject({ name: "AbortError" });
    expect(providerCalls).toBe(0);
    await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
    const sessionIds = await harness.sessions.listSessionIds();
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    release.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a source truncated after its accepted descriptor is opened", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-short-read-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "changing.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "accepted size then truncated\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [inputResourceIngestBarrier]: {
      async afterOpened() {
        await truncate(selectedPath, 0);
      },
    },
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Do not admit a changing resource." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).rejects.toMatchObject({ code: "input_resource_io_failed" });
    expect(providerCalls).toBe(0);
    await expect(readdir(join(stateRoot, "artifacts"))).resolves.toEqual([]);
    const sessionIds = await harness.sessions.listSessionIds();
    const store = await harness.sessions.open(sessionIds[0] as string);
    expect(await store?.read()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started" }),
        }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle prefix branch exposes only input-resource occurrences inside its boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const firstPath = join(testRoot, "first.txt");
  const laterPath = join(testRoot, "later.txt");
  const firstRunId = "40000000-0000-4000-8000-000000000011";
  const laterRunId = "40000000-0000-4000-8000-000000000012";
  const firstOccurrenceId = `${firstRunId}:input:1`;
  const laterOccurrenceId = `${laterRunId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(firstPath, "first prefix bytes\n", "utf8");
  await writeFile(laterPath, "later parent bytes\n", "utf8");
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls <= 2) {
      return [
        { type: "text_delta", text: `Parent turn ${providerCalls}.` },
        { type: "finish", reason: "stop" },
      ];
    }
    if (providerCalls === 3) {
      const userDescriptors = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      expect(userDescriptors).toContain(firstOccurrenceId);
      expect(userDescriptors).not.toContain(laterOccurrenceId);
      return [
        { type: "tool_call_start", id: "prefix-visible", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "prefix-visible",
          json: JSON.stringify({ occurrenceId: firstOccurrenceId }),
        },
        { type: "tool_call_end", id: "prefix-visible" },
        { type: "tool_call_start", id: "prefix-hidden", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "prefix-hidden",
          json: JSON.stringify({ occurrenceId: laterOccurrenceId }),
        },
        { type: "tool_call_end", id: "prefix-hidden" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const results = request.messages.filter((message) => message.role === "tool");
    expect(results).toEqual([
      expect.objectContaining({
        callId: "prefix-visible",
        result: expect.objectContaining({
          status: "completed",
          output: expect.objectContaining({ content: "first prefix bytes\n" }),
        }),
      }),
      expect.objectContaining({
        callId: "prefix-hidden",
        result: {
          status: "failed",
          error: {
            code: "input_resource_not_visible",
            message:
              "The requested input-resource occurrence is not visible in this session history.",
          },
        },
      }),
    ]);
    return [
      { type: "text_delta", text: "Only the prefix resource is available." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const first = await lifecycle.admit({
      targetIdentity,
      input: { text: "Link the prefix resource." },
      resourceSelections: [{ type: "local_file", path: firstPath }],
      runId: firstRunId,
    });
    await lifecycle.continue({
      sessionId: first.snapshot.sessionId,
      input: { text: "Link the later resource." },
      resourceSelections: [{ type: "local_file", path: laterPath }],
      runId: laterRunId,
    });
    const branch = await lifecycle.branch({
      parentSessionId: first.snapshot.sessionId,
      atSequence: first.snapshot.lastSequence,
    });
    await expect(
      lifecycle.continue({
        sessionId: branch.sessionId,
        input: { text: "Read only the prefix resource." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Only the prefix resource is available." },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle re-materializes one lazy Vision Responses image after a pre-commit restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-vision-responses-pre-commit-restart-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "pre-commit.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const runId = "80000000-0000-4000-8000-000000000001";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      expect(
        request.messages.flatMap((message) =>
          message.role === "user" && typeof message.content !== "string"
            ? message.content.filter((part) => part.type === "file")
            : [],
        ),
      ).toEqual([]);
      return [
        { type: "tool_call_start", id: "pre-commit-image", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "pre-commit-image",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "pre-commit-image" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      callId: "pre-commit-image",
      name: "read_input_resource",
      result: {
        status: "completed",
        output: {
          schemaVersion: 1,
          type: "image",
          occurrenceId,
          displayName: "pre-commit.png",
          artifactId,
          byteCount: pngBytes.byteLength,
          digest: artifactId,
          mediaType: "image/png",
          width: 1,
          height: 1,
        },
      },
      content: [
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The immutable image survived pre-commit restart." },
      { type: "finish", reason: "stop" },
    ];
  });
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const crash = createAppendCrashDirectory(
    backing,
    (record) =>
      record.schemaVersion === 3 && record.record.type === "input_resource_image_read_committed",
  );
  const lifecycleOptions = {
    modelTargets: createVisionResponsesTargets(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
    [sessionStoreDirectory]: crash.directory,
  };
  const warm = createSessionLifecycle(lifecycleOptions);
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await warm.create({ targetIdentity: visionResponsesIdentity });
    await expect(
      warm.continue({
        sessionId: created.sessionId,
        input: { text: "Read this image through its resource tool." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "failed", error: { code: "session_persistence_failed" } },
    });
    expect(crash.didTrip()).toBe(true);
    crash.disable();
    await warm.close();
    await rm(selectedPath);

    cold = createSessionLifecycle(lifecycleOptions);
    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted", run: { runId, status: "interrupted" } },
    });
    await expect(cold.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The immutable image survived pre-commit restart.",
      },
      snapshot: { status: "settled", run: { runId, status: "settled" } },
    });
    const store = await backing.open(created.sessionId);
    const records = (await store?.read()) ?? [];
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "input_resource_image_read_committed",
      ),
    ).toHaveLength(1);
    expect(providerCalls).toBe(2);
  } finally {
    crash.disable();
    await cold?.close();
    await warm.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle replays one committed Vision Responses image without duplicating its effect", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "adam-agent-vision-responses-post-commit-restart-"),
  );
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "post-commit.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const runId = "80000000-0000-4000-8000-000000000002";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return [
        { type: "tool_call_start", id: "post-commit-image", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "post-commit-image",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "post-commit-image" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const imageTool = request.messages.find(
      (message) => message.role === "tool" && message.callId === "post-commit-image",
    );
    expect(imageTool).toMatchObject({
      role: "tool",
      callId: "post-commit-image",
      result: {
        status: "completed",
        output: { type: "image", occurrenceId, artifactId },
      },
      content: [
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      {
        type: "text_delta",
        text:
          providerCalls === 2
            ? "The committed image effect replayed once."
            : "The child retained the inherited image.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const crash = createAppendCrashDirectory(
    backing,
    (record) =>
      record.schemaVersion === 3 &&
      record.record.type === "runtime_event" &&
      record.record.event.type === "tool_completed" &&
      record.record.event.callId === "post-commit-image",
  );
  const lifecycleOptions = {
    modelTargets: createVisionResponsesTargets(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
    [sessionStoreDirectory]: crash.directory,
  };
  const warm = createSessionLifecycle(lifecycleOptions);
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await warm.create({ targetIdentity: visionResponsesIdentity });
    await expect(
      warm.continue({
        sessionId: created.sessionId,
        input: { text: "Read and retain this image." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: { status: "failed", error: { code: "session_persistence_failed" } },
    });
    expect(crash.didTrip()).toBe(true);
    crash.disable();
    await warm.close();
    await rm(selectedPath);

    cold = createSessionLifecycle(lifecycleOptions);
    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: { status: "interrupted", run: { runId, status: "interrupted" } },
    });
    const continued = await cold.continue({ sessionId: created.sessionId });
    expect(continued).toMatchObject({
      result: { status: "completed", answer: "The committed image effect replayed once." },
      snapshot: { status: "settled", run: { runId, status: "settled" } },
    });
    const parentStore = await backing.open(created.sessionId);
    expect(
      ((await parentStore?.read()) ?? []).filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "input_resource_image_read_committed",
      ),
    ).toHaveLength(1);

    const child = await cold.branch({
      parentSessionId: created.sessionId,
      atSequence: continued.snapshot.lastSequence,
    });
    await expect(
      cold.continue({ sessionId: child.sessionId, input: { text: "Use the inherited image." } }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The child retained the inherited image." },
    });
    const childStore = await backing.open(child.sessionId);
    expect(
      ((await childStore?.read()) ?? []).filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "input_resource_image_read_committed",
      ),
    ).toHaveLength(0);
    expect(providerCalls).toBe(3);
  } finally {
    crash.disable();
    await cold?.close();
    await warm.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects one validated PNG only for the exact Vision Chat profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-png-"));
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "one-pixel.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);

  const visionDriver = new FakeModelDriver((request) => {
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe the exact image." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The image contains one exact pixel." },
      { type: "finish", reason: "stop" },
    ];
  });
  const visionTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver: visionDriver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1 as const,
          explicitUserImages: "supported" as const,
          imageToolResults: "unsupported" as const,
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const visionHarness = createInMemorySessionLifecycleHarness();
  const visionLifecycle = visionHarness.createLifecycle({
    modelTargets: visionTargets,
    stateRoot: join(testRoot, "vision-state"),
    workspaceRoot,
  });
  let flashDriverCalls = 0;
  const flashDriver = new FakeModelDriver(() => {
    flashDriverCalls += 1;
    return [
      { type: "text_delta", text: "This target must not receive an image." },
      { type: "finish", reason: "stop" },
    ];
  });
  const flashTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: flashDriver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const flashLifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets: flashTargets,
    stateRoot: join(testRoot, "flash-state"),
    workspaceRoot,
  });

  try {
    const admitted = await visionLifecycle.admit({
      targetIdentity: visionIdentity,
      input: { text: "Describe the exact image." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
    });
    expect(admitted).toMatchObject({
      result: { status: "completed", answer: "The image contains one exact pixel." },
    });
    const visionStore = await visionHarness.sessions.open(admitted.snapshot.sessionId);
    if (visionStore === undefined) {
      throw new Error("Expected the Vision Chat session store.");
    }
    expect(
      (await visionStore.read()).find(
        (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
      ),
    ).toMatchObject({
      record: {
        projectedContent: {
          version: 1,
          explicitUserImages: {
            count: 1,
            byteCount: pngBytes.byteLength,
            pixelCount: 1,
            maximumWidth: 1,
            maximumHeight: 1,
          },
        },
      },
    });
    await expect(
      flashLifecycle.admit({
        targetIdentity,
        input: { text: "Describe the exact image." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_unsupported",
          message: "The selected target does not support explicit user images.",
        },
      },
    });
    expect(flashDriverCalls).toBe(0);
  } finally {
    await Promise.all([visionLifecycle.close(), flashLifecycle.close()]);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects one validated JPEG through the exact Vision Chat profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-jpeg-"));
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "one-pixel.jpg");
  const jpegBytes = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APnSvww/1TP/2Q==",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(jpegBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, jpegBytes);
  const driver = new FakeModelDriver((request) => {
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe the JPEG." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/jpeg",
          bytes: new Uint8Array(jpegBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "The JPEG contains one exact pixel." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Describe the JPEG." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The JPEG contains one exact pixel." },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle trusts validated image bytes over names and rejects images that fail complete decoding", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-magic-"));
  const workspaceRoot = join(testRoot, "workspace");
  const misleadingPath = join(testRoot, "actually-png.jpg");
  const truncatedPath = join(testRoot, "truncated.png");
  const corruptImageDataPath = join(testRoot, "corrupt-image-data.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(misleadingPath, pngBytes);
  await writeFile(truncatedPath, pngBytes.subarray(0, 12));
  await writeFile(
    corruptImageDataPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVSH2mNk+A8AAQUBAT0jcMwAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  let driverCalls = 0;
  const driver = new FakeModelDriver((request) => {
    driverCalls += 1;
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Use byte truth." },
        {
          type: "file",
          artifactId: digest,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    return [
      { type: "text_delta", text: "Byte truth wins." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Use byte truth." },
        resourceSelections: [{ type: "local_file", path: misleadingPath }],
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Byte truth wins." } });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject truncated magic." },
        resourceSelections: [{ type: "local_file", path: truncatedPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image is corrupt or has an unsupported image format.",
        },
      },
    });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject corrupt decoded pixels." },
        resourceSelections: [{ type: "local_file", path: corruptImageDataPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_invalid",
          message: "The selected image is corrupt or has an unsupported image format.",
        },
      },
    });
    expect(driverCalls).toBe(1);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle admits a compressed 16-bit RGBA Adam7 PNG at the exact image boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-adam7-boundary-"));
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "boundary.png");
  const pngBytes = createAdam7BoundaryPng();
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, pngBytes);
  let driverCalls = 0;
  const driver = new FakeModelDriver(() => {
    driverCalls += 1;
    return [
      { type: "text_delta", text: "The boundary image was admitted." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Inspect the exact boundary image." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "The boundary image was admitted." },
    });
    expect(driverCalls).toBe(1);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the exact v1 image count and dimension budgets before the driver", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-bounds-"));
  const workspaceRoot = join(testRoot, "workspace");
  const oversizedDimensionPath = join(testRoot, "too-wide.png");
  const firstPath = join(testRoot, "first.png");
  const secondPath = join(testRoot, "second.png");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const tooWidePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAEAEAAAABCAQAAAAb6sjJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(oversizedDimensionPath, tooWidePng);
  await writeFile(firstPath, onePixelPng);
  await writeFile(secondPath, onePixelPng);
  let driverCalls = 0;
  const driver = new FakeModelDriver(() => {
    driverCalls += 1;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot: join(testRoot, "state"),
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject oversized dimensions." },
        resourceSelections: [{ type: "local_file", path: oversizedDimensionPath }],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "The selected image dimensions exceed the v1 limit.",
        },
      },
    });
    await expect(
      lifecycle.admit({
        targetIdentity: visionIdentity,
        input: { text: "Reject a second explicit image." },
        resourceSelections: [
          { type: "local_file", path: firstPath },
          { type: "local_file", path: secondPath },
        ],
      }),
    ).resolves.toMatchObject({
      result: {
        status: "failed",
        error: {
          code: "input_resource_limit_exceeded",
          message: "At most one explicit user image is supported per run.",
        },
      },
    });
    expect(driverCalls).toBe(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves a Vision Chat image through reasoning and a tool continuation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-vision-chat-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "tool-image.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const artifactId = `sha256:${createHash("sha256").update(pngBytes).digest("hex")}` as const;
  const visionIdentity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash-vision-exp.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash-vision-exp",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  };
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam\n", "utf8");
  await writeFile(selectedPath, pngBytes);
  const productionSnapshot = await createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  }).snapshot({ includeHistoricalProfiles: true, signal: new AbortController().signal });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === visionIdentity.targetId &&
      target.identity.profileVersion === visionIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Vision Chat thinking capability.");
  }
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    expect(request.messages.find((message) => message.role === "user")).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Use the image and inspect the project." },
        {
          type: "file",
          artifactId,
          mediaType: "image/png",
          bytes: new Uint8Array(pngBytes),
        },
      ],
    });
    expect(request.thinkingPolicy).toMatchObject({
      requestedLevelId: "high",
      mapping: {
        requestPath: "provider_options.deepseek",
        thinkingType: "enabled",
        reasoningEffort: "high",
      },
    });
    if (requestCount === 1) {
      return [
        {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        },
        {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "I should inspect the project before answering.",
        },
        { type: "reasoning_end", id: "provider-reasoning-0" },
        { type: "tool_call_start", id: "vision-read", name: "read_file" },
        { type: "tool_call_delta", id: "vision-read", json: '{"path":"README.md"}' },
        { type: "tool_call_end", id: "vision-read" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "vision-read",
      name: "read_file",
      result: { status: "completed" },
    });
    return [
      { type: "text_delta", text: "The image and Adam project are both available." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: visionIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "supported",
          imageToolResults: "unsupported",
        },
        thinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const admitted = await lifecycle.admit({
      targetIdentity: visionIdentity,
      input: { text: "Use the image and inspect the project." },
      resourceSelections: [{ type: "local_file", path: selectedPath }],
      thinkingSelection: thinkingSelection(thinkingCapability, "high"),
    });
    expect(admitted.result).toEqual({
      status: "completed",
      answer: "The image and Adam project are both available.",
    });
    const store = await harness.sessions.open(admitted.snapshot.sessionId);
    const responses = (await store?.read())?.filter(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    );
    expect(responses?.[0]).toMatchObject({
      record: {
        response: {
          reasoning: "I should inspect the project before answering.",
          toolCalls: [{ id: "vision-read", name: "read_file" }],
        },
      },
    });
    expect(requestCount).toBe(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle links binary bytes but returns typed unsupported materialization", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-input-resource-binary-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const selectedPath = join(testRoot, "binary.dat");
  const runId = "50000000-0000-4000-8000-000000000011";
  const occurrenceId = `${runId}:input:1`;
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  let providerCalls = 0;
  const driver = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      const user = request.messages.at(-1);
      expect(user?.role === "user" ? user.content : "").toContain('"support":"unsupported_binary"');
      return [
        { type: "tool_call_start", id: "binary-resource", name: "read_input_resource" },
        {
          type: "tool_call_delta",
          id: "binary-resource",
          json: JSON.stringify({ occurrenceId }),
        },
        { type: "tool_call_end", id: "binary-resource" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    expect(request.messages.at(-1)).toEqual({
      role: "tool",
      callId: "binary-resource",
      name: "read_input_resource",
      result: {
        status: "failed",
        error: {
          code: "input_resource_unsupported",
          message: "The requested input resource is not supported as strict UTF-8 text.",
        },
      },
    });
    return [
      { type: "text_delta", text: "The linked resource is unsupported binary." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Inspect the binary link." },
        resourceSelections: [{ type: "local_file", path: selectedPath }],
        runId,
      }),
    ).resolves.toMatchObject({
      result: {
        status: "completed",
        answer: "The linked resource is unsupported binary.",
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects invalid draft run limits before allocating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-draft-limits-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver([]),
        contextProfile: testContextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot });

  try {
    await expect(
      lifecycle.admit({
        targetIdentity,
        input: { text: "Reject invalid limits before genesis" },
        limits: { maxTurns: 0 },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(harness.sessions.listSessionIds()).resolves.toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle paginates prompt-admitted sessions while hiding genesis-only history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-memory-catalog-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver(() => [
    { type: "text_delta", text: "Cataloged answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({ modelTargets, workspaceRoot });

  try {
    const genesisOnly = await lifecycle.create({ targetIdentity });
    const admitted = [
      await lifecycle.create({ targetIdentity }),
      await lifecycle.create({ targetIdentity }),
    ];
    for (const [index, session] of admitted.entries()) {
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: `Catalog prompt ${index + 1}` },
      });
    }
    const firstPage = await lifecycle.listProjectSessions({ limit: 1 });
    if (firstPage.nextCursor === null) {
      throw new Error("The first in-memory catalog page requires a continuation cursor.");
    }
    const secondPage = await lifecycle.listProjectSessions({
      cursor: firstPage.nextCursor,
      limit: 1,
    });

    expect([...firstPage.items, ...secondPage.items].map((item) => item.sessionId)).toEqual(
      admitted.map((item) => item.sessionId).reverse(),
    );
    expect([...firstPage.items, ...secondPage.items]).not.toContainEqual(
      expect.objectContaining({ sessionId: genesisOnly.sessionId }),
    );
    expect({ first: firstPage.nextCursor, second: secondPage.nextCursor }).toEqual({
      first: expect.any(String),
      second: null,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle creates a prompt-v3 genesis with an empty bounded Skill snapshot and twelve tools", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-skills-genesis-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const tools = createCodingToolRegistry({ stateRoot, workspaceRoot });
    const lifecycle = harness.createLifecycle({ stateRoot, tools, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });

    const expectedSkills = {
      profileVersion: 1,
      catalog: {
        revision: 1,
        totalCount: 0,
        includedCount: 0,
        omittedCount: 0,
        shortenedCount: 0,
        budgetTokens: 10_000,
        projectedTokens: 0,
      },
      active: [],
    };
    for (const snapshot of [created, inspected]) {
      expect(snapshot).toMatchObject({
        promptContext: {
          profileVersion: 3,
          assemblyVersion: 3,
          toolProfile: {
            definitions: [
              { name: "read_file" },
              { name: "search_repository" },
              { name: "write_file" },
              { name: "edit_file" },
              { name: "run_shell" },
              { name: "activate_skill" },
              { name: "read_skill_resource" },
              { name: "read_input_resource" },
              { name: "create_todo" },
              { name: "get_todo" },
              { name: "list_todos" },
              { name: "update_todo" },
            ],
          },
        },
        skillContext: expectedSkills,
      });
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle restores an uncompacted v1 session after the current target advances", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-historical-v1-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
    targetIdentity,
  });
  const v2Identity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
  const observedBudgets: Array<number | undefined> = [];
  let v2DriverCalls = 0;
  const v1Driver = new FakeModelDriver((request) => {
    observedBudgets.push(request.maximumOutputTokens);
    return [
      { type: "text_delta", text: "Historical v1 restored." },
      { type: "finish", reason: "stop" },
    ];
  });
  const upgradedTargets: ModelTargets = {
    async resolve(input) {
      const exactIdentity = (
        input as typeof input & { readonly targetIdentity?: ModelTargetIdentity }
      ).targetIdentity;
      if (exactIdentity?.profileVersion === 1) {
        return { identity: targetIdentity, driver: v1Driver, contextProfile: testContextProfile };
      }
      v2DriverCalls += 1;
      return {
        identity: v2Identity,
        driver: new FakeModelDriver([]),
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
      };
    },
    async snapshot(input) {
      const includeHistoricalProfiles = (
        input as typeof input & { readonly includeHistoricalProfiles?: boolean }
      ).includeHistoricalProfiles;
      const current = {
        identity: v2Identity,
        readiness: { status: "available" as const, credentialSource: "test" },
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
      };
      const historical = {
        identity: targetIdentity,
        readiness: { status: "available" as const, credentialSource: "test" },
        contextProfile: testContextProfile,
      };
      return { targets: includeHistoricalProfiles ? [current, historical] : [current] };
    },
  };

  try {
    const continued = await harness
      .createLifecycle({
        modelTargets: upgradedTargets,
        stateRoot,
        workspaceRoot,
      })
      .continue({
        sessionId: created.sessionId,
        input: { text: "Continue with the historical profile." },
      });

    expect({ result: continued.result, observedBudgets, v2DriverCalls }).toEqual({
      result: { status: "completed", answer: "Historical v1 restored." },
      observedBudgets: [32_768],
      v2DriverCalls: 0,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported historical profile before model resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-unsupported-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const unsupportedIdentity: ModelTargetIdentity = {
    ...targetIdentity,
    profileVersion: 99,
  };
  const unsupportedProfile: ContextProfile = {
    ...testContextProfile,
    version: 99,
  };
  let resolveCalls = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      resolveCalls += 1;
      return {
        identity: unsupportedIdentity,
        driver: new FakeModelDriver([]),
        contextProfile: unsupportedProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: unsupportedIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile: unsupportedProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
      targetIdentity: unsupportedIdentity,
    });
    await expect(
      harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot }).resume({
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "model_target_incompatible" },
    });
    await expect(
      harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot }).continue({
        sessionId: created.sessionId,
        input: { text: "This request must not reach the model." },
      }),
    ).rejects.toMatchObject({ code: "session_model_target_incompatible" });
    expect(resolveCalls).toBe(0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects restored v3 records that violate session causality", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-causality-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "provider_attempt_started",
        runId: "123e4567-e89b-42d3-a456-426614174099",
        turn: 1,
        attempt: 1,
        targetIdentity,
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["failed", "interrupted"] as const)(
  "SessionLifecycle rejects a %s reasoning block followed by an answer-only completed response",
  async (status) => {
    const testRoot = await mkdtemp(
      join(tmpdir(), `adam-agent-session-invalid-reasoning-${status}-`),
    );
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const harness = createInMemorySessionLifecycleHarness();
      const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
      const created = await lifecycle.create({ targetIdentity });
      const runId = "123e4567-e89b-42d3-a456-426614174097";
      const store = await harness.sessions.open(created.sessionId);
      if (store === undefined) {
        throw new Error("Expected the created session store.");
      }
      const records: readonly Omit<
        Extract<SessionRecord, { readonly schemaVersion: 3 }>,
        "sequence"
      >[] = [
        {
          schemaVersion: 3,
          record: { type: "logical_run_started", runId, userMessage: "Reject split outcome" },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "user_message", text: "Reject split outcome" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "provider_attempt_started",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            promptProjection: promptProjectionFor(created, "Reject split outcome"),
          },
        },
        {
          schemaVersion: 3,
          record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: {
              type: "model_reasoning_started",
              id: "1:1:provider-reasoning-0",
              artifactType: "provider_reasoning",
            },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_reasoning_settled", id: "1:1:provider-reasoning-0", status },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "model_response_completed",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            response: {
              text: "Impossible answer.",
              toolCalls: [],
              toolIntents: [],
              finishReason: "stop",
            },
          },
        },
      ];
      for (const [index, record] of records.entries()) {
        await store.append({ ...record, sequence: index + 2 } as SessionRecord);
      }

      await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
        code: "session_invalid",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle rejects a fabricated completed settlement without a provider response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-settlement-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174098";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Fabricate success" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Fabricate success" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "runtime_event",
        runId,
        event: {
          type: "session_settled",
          result: { status: "completed", answer: "Invented answer" },
        },
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps legacy history inspectable but rejects model resume without guessing", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-legacy-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const sessionId = "legacy-session";
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const store = await harness.sessions.create(sessionId);
  await store.append({
    schemaVersion: 1,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    sequence: 1,
    event: { type: "user_message", text: "Legacy request" },
  });
  await store.append({
    schemaVersion: 2,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    sequence: 2,
    event: {
      type: "session_settled",
      result: { status: "completed", answer: "Legacy answer" },
    },
  });

  try {
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const inspected = await lifecycle.inspect({ sessionId });
    const resumed = await lifecycle.resume({ sessionId });

    const legacySnapshot = {
      schemaVersion: 2,
      sessionId,
      projectId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      status: "legacy",
      lastSequence: 2,
    };
    expect({ inspected, resumed }).toEqual({
      inspected: legacySnapshot,
      resumed: {
        status: "rejected",
        snapshot: legacySnapshot,
        error: {
          code: "non_resumable_legacy_session",
          message: "Legacy session history can be inspected but cannot be resumed safely.",
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle hydrate-only resume validates the exact target without model or durable effects", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerWasCalled = false;
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const created = await harness.createLifecycle({ stateRoot, workspaceRoot }).create({
      targetIdentity,
    });
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        providerWasCalled = true;
        throw new Error("hydrate-only resume must not call the provider");
      },
    });
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const before = await lifecycle.inspect({ sessionId: created.sessionId });

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const after = await lifecycle.inspect({ sessionId: created.sessionId });

    expect({ resumed, providerWasCalled, historyUnchanged: after }).toEqual({
      resumed: { status: "ready", snapshot: before },
      providerWasCalled: false,
      historyUnchanged: before,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches a complete boundary by reference without changing parent history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const parentBefore = await lifecycle.inspect({ sessionId: parent.sessionId });

    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: 1,
    });
    const parentAfter = await lifecycle.inspect({ sessionId: parent.sessionId });
    const inspectedChild = await lifecycle.inspect({ sessionId: child.sessionId });

    expect({ parentAfter, child, inspectedChild }).toEqual({
      parentAfter: parentBefore,
      child: {
        schemaVersion: 3,
        sessionId: expect.not.stringMatching(parent.sessionId),
        projectId: parent.projectId,
        targetIdentity,
        status: "idle",
        lastSequence: 1,
        promptContext: parent.promptContext,
        skillContext: parent.skillContext,
        todo: parent.todo,
        lineage: {
          parentSessionId: parent.sessionId,
          parentEventPosition: 1,
          prefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      },
      inspectedChild: child,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle continues a branch from its referenced parent context", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const requests: ModelMessage[][] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push([...request.messages]);
    const latest = request.messages.at(-1);
    const answer =
      latest?.role === "user" && latest.content === "Parent prompt"
        ? "Parent answer"
        : "Child answer";
    return [
      { type: "text_delta", text: answer },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Parent prompt" },
    });
    const branchBoundary = parentRun.snapshot.lastSequence;
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: branchBoundary,
    });

    const childRun = await lifecycle.continue({
      sessionId: child.sessionId,
      input: { text: "Child prompt" },
    });

    expect({
      result: childRun.result,
      childRequest: requests[1],
      childLineage: child.lineage,
    }).toEqual({
      result: { status: "completed", answer: "Child answer" },
      childRequest: [
        { role: "system", content: basePrompt },
        { role: "developer", content: skillUsagePrompt },
        {
          role: "assistant",
          content:
            'Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n{"policyVersion":"todo-policy.v1","storeRevision":0,"counts":{"pending":0,"inProgress":0,"completed":0},"blockedCount":0,"guidance":"Use list_todos for bounded discovery and get_todo for one exact item."}',
          toolCalls: [],
        },
        { role: "user", content: "Parent prompt" },
        { role: "assistant", content: "Parent answer", toolCalls: [] },
        { role: "user", content: "Child prompt" },
      ],
      childLineage: expect.objectContaining({ parentEventPosition: branchBoundary }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle retains inherited branch context across a cold continuation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-cold-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const requests: ModelMessage[][] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push([...request.messages]);
    const answer = requests.length === 1 ? "Parent answer" : "Recovered child answer";
    return [
      { type: "text_delta", text: answer },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const rootRun = await lifecycle.continue({
      sessionId: root.sessionId,
      input: { text: "Parent prompt" },
    });
    const child = await lifecycle.branch({
      parentSessionId: root.sessionId,
      atSequence: rootRun.snapshot.lastSequence,
    });
    const runId = "123e4567-e89b-42d3-a456-426614174097";
    const store = await harness.sessions.open(child.sessionId);
    if (store === undefined) {
      throw new Error("Expected the child session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Child prompt" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Child prompt" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(child, [
            { role: "user", content: "Parent prompt" },
            { role: "assistant", content: "Parent answer", toolCalls: [] },
            { role: "user", content: "Child prompt" },
          ]),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const continued = await lifecycle.continue({ sessionId: child.sessionId });

    expect({ result: continued.result, childRequest: requests[1] }).toEqual({
      result: { status: "completed", answer: "Recovered child answer" },
      childRequest: [
        { role: "system", content: basePrompt },
        { role: "developer", content: skillUsagePrompt },
        {
          role: "assistant",
          content:
            'Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n{"policyVersion":"todo-policy.v1","storeRevision":0,"counts":{"pending":0,"inProgress":0,"completed":0},"blockedCount":0,"guidance":"Use list_todos for bounded discovery and get_todo for one exact item."}',
          toolCalls: [],
        },
        { role: "user", content: "Parent prompt" },
        { role: "assistant", content: "Parent answer", toolCalls: [] },
        { role: "user", content: "Child prompt" },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches to an explicit compatible exact target only when it is ready", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-retarget-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });
  const currentTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  const harness = createInMemorySessionLifecycleHarness();

  try {
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity: currentTargetIdentity });
    const parentRun = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Establish compatible DeepSeek history" },
    });

    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: parentRun.snapshot.lastSequence,
      targetId: "deepseek-v4-pro.direct",
    });

    expect(child).toEqual({
      schemaVersion: 3,
      sessionId: expect.any(String),
      projectId: parent.projectId,
      targetIdentity: {
        ...currentTargetIdentity,
        targetId: "deepseek-v4-pro.direct",
        modelId: "deepseek-v4-pro",
      },
      status: "idle",
      lastSequence: 1,
      promptContext: parent.promptContext,
      skillContext: parent.skillContext,
      todo: parent.todo,
      lineage: {
        parentSessionId: parent.sessionId,
        parentEventPosition: parentRun.snapshot.lastSequence,
        prefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an incompatible retarget hidden behind an empty branch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-nested-retarget-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const incompatibleTarget: ModelTargetIdentity = {
    ...targetIdentity,
    targetId: "other-model.direct",
    vendor: "other-vendor",
    modelId: "other-model",
  };
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Root answer" },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
          {
            identity: incompatibleTarget,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const rootRun = await lifecycle.continue({
      sessionId: root.sessionId,
      input: { text: "Establish root history" },
    });
    const child = await lifecycle.branch({
      parentSessionId: root.sessionId,
      atSequence: rootRun.snapshot.lastSequence,
    });

    await expect(
      lifecycle.branch({
        parentSessionId: child.sessionId,
        atSequence: 1,
        targetId: incompatibleTarget.targetId,
      }),
    ).rejects.toMatchObject({ code: "session_model_target_incompatible" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle normalizes an active provider attempt before branching its complete tail", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-interrupted-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174050";
    const store = await harness.sessions.open(parent.sessionId);
    if (store === undefined) {
      throw new Error("Expected the parent session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Interrupted branch" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Interrupted branch" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(parent, "Interrupted branch"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });

    const child = await lifecycle.branch({ parentSessionId: parent.sessionId, atSequence: 5 });
    const parentAfter = await lifecycle.inspect({ sessionId: parent.sessionId });

    expect({ child, parentAfter }).toEqual({
      child: expect.objectContaining({
        lineage: expect.objectContaining({
          parentSessionId: parent.sessionId,
          parentEventPosition: 6,
        }),
      }),
      parentAfter: expect.objectContaining({
        status: "interrupted",
        lastSequence: 6,
        run: expect.objectContaining({
          lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
        }),
      }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle recursively rejects a branch chain whose immutable ancestor prefix changed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-branch-lineage-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const root = await lifecycle.create({ targetIdentity });
    const child = await lifecycle.branch({ parentSessionId: root.sessionId, atSequence: 1 });
    const grandchild = await lifecycle.branch({
      parentSessionId: child.sessionId,
      atSequence: 1,
    });
    const rootPath = join(
      stateRoot,
      "projects",
      root.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${root.sessionId}.jsonl`,
    );
    const rootRecord = JSON.parse((await readFile(rootPath, "utf8")).trim()) as SessionRecord;
    if (rootRecord.schemaVersion !== 3 || rootRecord.record.type !== "session_genesis") {
      throw new Error("Expected a v3 root genesis.");
    }
    await writeFile(
      rootPath,
      `${JSON.stringify({
        ...rootRecord,
        record: {
          ...rootRecord.record,
          targetIdentity: { ...rootRecord.record.targetIdentity, modelId: "tampered-model" },
        },
      })}\n`,
      "utf8",
    );

    await expect(lifecycle.inspect({ sessionId: grandchild.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle branches completed failed and cancelled runs without reopening them", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-terminal-branch-"));
  const stateRoot = join(testRoot, "state");
  const failedWorkspace = join(testRoot, "failed-workspace");
  const cancelledWorkspace = join(testRoot, "cancelled-workspace");
  await mkdir(failedWorkspace);
  await mkdir(cancelledWorkspace);

  try {
    const failingTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        throw new Error("provider offline");
      },
    });
    const failedHarness = createInMemorySessionLifecycleHarness();
    const failedLifecycle = failedHarness.createLifecycle({
      modelTargets: failingTargets,
      stateRoot,
      workspaceRoot: failedWorkspace,
    });
    const failedParent = await failedLifecycle.create({ targetIdentity });
    const failedRun = await failedLifecycle.continue({
      sessionId: failedParent.sessionId,
      input: { text: "Fail after the attempt starts" },
    });
    const failedChild = await failedLifecycle.branch({
      parentSessionId: failedParent.sessionId,
      atSequence: failedRun.snapshot.lastSequence,
    });

    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const cancellingDriver: ModelDriver = {
      async *stream(request) {
        markProviderStarted?.();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
          } else {
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
      },
    };
    const cancellingTargets: ModelTargets = {
      async resolve() {
        return {
          identity: targetIdentity,
          driver: cancellingDriver,
          contextProfile: testContextProfile,
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile: testContextProfile,
            },
          ],
        };
      },
    };
    const cancelledHarness = createInMemorySessionLifecycleHarness();
    const cancelledLifecycle = cancelledHarness.createLifecycle({
      modelTargets: cancellingTargets,
      stateRoot,
      workspaceRoot: cancelledWorkspace,
    });
    const cancelledParent = await cancelledLifecycle.create({ targetIdentity });
    const controller = new AbortController();
    const cancellingRun = cancelledLifecycle.continue({
      sessionId: cancelledParent.sessionId,
      input: { text: "Cancel after the attempt starts" },
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort();
    const cancelledRun = await cancellingRun;
    const cancelledChild = await cancelledLifecycle.branch({
      parentSessionId: cancelledParent.sessionId,
      atSequence: cancelledRun.snapshot.lastSequence,
    });

    expect({ failedRun, failedChild, cancelledRun, cancelledChild }).toEqual({
      failedRun: expect.objectContaining({
        result: expect.objectContaining({ status: "failed" }),
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      failedChild: expect.objectContaining({
        status: "idle",
        lineage: expect.objectContaining({ parentSessionId: failedParent.sessionId }),
      }),
      cancelledRun: expect.objectContaining({
        result: expect.objectContaining({ status: "cancelled" }),
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      cancelledChild: expect.objectContaining({
        status: "idle",
        lineage: expect.objectContaining({ parentSessionId: cancelledParent.sessionId }),
      }),
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a session copied across canonical project roots", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-cross-project-"));
  const stateRoot = join(testRoot, "state");
  const sourceWorkspace = join(testRoot, "source-workspace");
  const otherWorkspace = join(testRoot, "other-workspace");
  await mkdir(sourceWorkspace);
  await mkdir(otherWorkspace);

  try {
    const source = await createSessionLifecycle({
      stateRoot,
      workspaceRoot: sourceWorkspace,
    }).create({ targetIdentity });
    const sourcePath = join(
      stateRoot,
      "projects",
      source.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${source.sessionId}.jsonl`,
    );
    const otherGenesis = await createSessionLifecycle({
      stateRoot,
      workspaceRoot: otherWorkspace,
    }).create({ targetIdentity });
    const copiedPath = join(
      stateRoot,
      "projects",
      otherGenesis.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${source.sessionId}.jsonl`,
    );
    await writeFile(copiedPath, await readFile(sourcePath, "utf8"), "utf8");

    await expect(
      createSessionLifecycle({ stateRoot, workspaceRoot: otherWorkspace }).inspect({
        sessionId: source.sessionId,
      }),
    ).rejects.toMatchObject({ code: "session_project_mismatch" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle durably completes a canonical provider response while keeping deltas live-only", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-response-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Introduce yourself" },
      limits: { maxTurns: 2, maxTokens: 100 },
    });
    const inspected = await harness.createLifecycle({ stateRoot, workspaceRoot }).inspect({
      sessionId: created.sessionId,
    });

    expect({ continued, inspected, events }).toEqual({
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: inspected,
      },
      inspected: {
        ...snapshotWithLastPromptProjection(created, introductionRequestDigest),
        status: "settled",
        lastSequence: 9,
        run: {
          runId: expect.any(String),
          status: "settled",
          result: { status: "completed", answer: "Hello, Adam." },
          lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          lastCompletedResponse: {
            turn: 1,
            attempt: 1,
            finishReason: "stop",
          },
        },
      },
      events: [
        { type: "user_message", text: "Introduce yourself" },
        { type: "model_message_started" },
        { type: "model_message_delta", text: "Hello, Adam." },
        {
          type: "model_usage",
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
        {
          type: "context_usage",
          ordinary: {
            inputTokens: 7,
            outputTokens: 3,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheMissInputTokens: 0,
            unknownCalls: 0,
          },
          compaction: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheMissInputTokens: 0,
            unknownCalls: 0,
          },
          active: { source: "provider_reported", tokens: 7, throughSequence: 6 },
        },
        { type: "model_message_completed", text: "Hello, Adam." },
        {
          type: "session_settled",
          result: { status: "completed", answer: "Hello, Adam." },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects provider context usage through a cold child lineage", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-lineage-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Lineage answer." },
    { type: "usage", inputTokens: 23_456, outputTokens: 101 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const parent = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Record context before branching" },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: completed.snapshot.lastSequence,
    });
    await lifecycle.close();

    const cold = harness.createLifecycle({ stateRoot, workspaceRoot });
    await expect(cold.inspectContextUsage({ sessionId: child.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 23_456,
        outputTokens: 101,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "provider_reported", tokens: 23_456 },
    });
    await cold.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle counts an ordinary provider attempt without usage as unknown", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-unknown-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Usage unavailable." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return no usage event" },
    });

    await expect(lifecycle.inspectContextUsage({ sessionId: created.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 1,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "unknown" },
    });
    await lifecycle.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle does not retain provider usage after a later interrupted attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-context-stale-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "First answer." },
    { type: "usage", inputTokens: 12_345, outputTokens: 99 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return provider usage" },
    });
    const runId = "123e4567-e89b-42d3-a456-426614174098";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Interrupt later" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Interrupt later" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, [
            { role: "user", content: "Return provider usage" },
            { role: "assistant", content: "First answer.", toolCalls: [] },
            { role: "user", content: "Interrupt later" },
          ]),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "session_interrupted", reason: "cancelled" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({
        ...record,
        sequence: completed.snapshot.lastSequence + index + 1,
      } as SessionRecord);
    }

    await lifecycle.resume({ sessionId: created.sessionId });

    await expect(lifecycle.inspectContextUsage({ sessionId: created.sessionId })).resolves.toEqual({
      ordinaryUsage: {
        inputTokens: 12_345,
        outputTokens: 99,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 1,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "unknown" },
    });
    await lifecycle.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle continues a run that crashed before its first provider attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-pre-attempt-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174097";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Recover before sampling" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Recover before sampling" },
      },
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const records = await store.read();

    expect({
      hydrated,
      continued,
      userMessages: records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ),
    }).toEqual({
      hydrated: {
        status: "ready",
        snapshot: {
          ...created,
          status: "interrupted",
          lastSequence: 3,
          run: { runId, status: "interrupted" },
        },
      },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          }),
        }),
      },
      userMessages: [
        expect.objectContaining({
          record: expect.objectContaining({
            event: { type: "user_message", text: "Recover before sampling" },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle restores the canonical user event after a pre-event crash", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-pre-user-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174095";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Restore my event" },
    });

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const records = await store.read();

    expect({
      resumed,
      continued,
      userMessages: records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ),
    }).toEqual({
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted", lastSequence: 3 }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
      }),
      userMessages: [
        expect.objectContaining({
          record: expect.objectContaining({
            event: { type: "user_message", text: "Restore my event" },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle terminalizes a durable cancellation instead of reopening its run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-cancel-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174096";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Cancel durably" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Cancel durably" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Cancel durably"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "session_interrupted", reason: "cancelled" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    const durableRecords = await store.read();
    const contextUsage = await lifecycle.inspectContextUsage({ sessionId: created.sessionId });

    expect({
      contextUsage,
      resumed,
      modelRequests,
      terminalRecords: durableRecords.slice(-2),
    }).toEqual({
      contextUsage: {
        ordinaryUsage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 1,
        },
        compactionUsage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
          unknownCalls: 0,
        },
        active: { source: "unknown" },
      },
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Cancel durably").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 8,
          run: {
            runId,
            status: "settled",
            result: {
              status: "cancelled",
              error: { code: "session_cancelled", message: "The session was cancelled." },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      modelRequests: 0,
      terminalRecords: [
        expect.objectContaining({
          record: expect.objectContaining({ type: "provider_attempt_interrupted" }),
        }),
        expect.objectContaining({
          record: expect.objectContaining({
            event: {
              type: "session_settled",
              result: {
                status: "cancelled",
                error: { code: "session_cancelled", message: "The session was cancelled." },
              },
            },
          }),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle completes a durable run-terminal intent instead of starting another attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-terminal-intent-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174094";
    const terminalResult = {
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Finish terminalization" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Finish terminalization" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Finish terminalization"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_interrupted",
          runId,
          turn: 1,
          attempt: 1,
          reason: "run_terminal",
          result: terminalResult,
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(lifecycle.continue({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });

    expect({ resumed, modelRequests }).toEqual({
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Finish terminalization").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 7,
          run: {
            runId,
            status: "settled",
            result: terminalResult,
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      modelRequests: 0,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle artifactizes replay-critical reasoning instead of truncating it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-replay-overflow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const oversizedReasoning = "r".repeat(512 * 1024 + 1);
  const driver = new FakeModelDriver([
    {
      type: "reasoning_start",
      id: "provider-reasoning-0",
      artifactType: "provider_reasoning",
    },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: oversizedReasoning },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Think too much" },
    });
    const completedResponses = await harness.sessions
      .open(created.sessionId)
      .then(async (store) =>
        store === undefined
          ? []
          : (await store.read()).filter(
              (record) =>
                record.schemaVersion === 3 && record.record.type === "model_response_completed",
            ),
      );

    expect(continued).toMatchObject({
      result: { status: "completed", answer: "" },
      snapshot: {
        status: "settled",
        run: { result: { status: "completed", answer: "" } },
      },
    });
    expect(completedResponses).toHaveLength(1);
    const completedResponse = completedResponses[0];
    if (
      completedResponse?.schemaVersion !== 3 ||
      completedResponse.record.type !== "model_response_completed" ||
      completedResponse.record.response.recordVersion !== 2 ||
      completedResponse.record.response.reasoning?.storage !== "artifact"
    ) {
      throw new Error("Expected artifact-backed replay-critical reasoning.");
    }
    expect(completedResponse.record.response.reasoning.reference.byteCount).toBe(
      Buffer.byteLength(oversizedReasoning, "utf8"),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies an oversized complete response batch as replay overflow", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-replay-batch-overflow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const argumentsJson = JSON.stringify({ value: "x".repeat(350 * 1024) });
  const driver = new FakeModelDriver([
    ...["one", "two", "three"].flatMap((id) => [
      { type: "tool_call_start" as const, id, name: "unknown_tool" },
      { type: "tool_call_delta" as const, id, json: argumentsJson },
      { type: "tool_call_end" as const, id },
    ]),
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Return a large atomic response batch" },
    });

    expect(continued.result).toEqual({
      status: "failed",
      error: {
        code: "replay_envelope_too_large",
        message: "The complete model response exceeds the durable replay envelope limit.",
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits a complete tool response before permission resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-tool-intent-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let requestCount = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      requestCount += 1;
      return new Response(
        requestCount === 1 ? reasoningToolDeepSeekStream : answerOnlyDeepSeekStream,
        {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        },
      );
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      tools,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    });
    const created = await lifecycle.create({ targetIdentity });
    let resolvePermission:
      | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
      | undefined;
    const permissionRequested = new Promise<
      Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
    >((resolve) => {
      resolvePermission = resolve;
    });
    lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        resolvePermission?.(event);
      }
    });

    const pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the project name" },
      limits: { maxTurns: 2 },
    });
    const firstOutcome = await Promise.race([
      permissionRequested.then((event) => ({ type: "permission" as const, event })),
      pendingContinue.then((continued) => ({ type: "settled" as const, continued })),
    ]);
    if (firstOutcome.type === "settled") {
      throw new Error(
        `The run settled before requesting permission: ${JSON.stringify(firstOutcome.continued.result)}`,
      );
    }
    const permission = firstOutcome.event;
    const beforeDecision = await lifecycle.inspect({ sessionId: created.sessionId });
    const durableRecords = await harness.sessions
      .open(created.sessionId)
      .then((store) => store?.read() ?? []);
    const completedResponse = durableRecords.find(
      (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
    );
    const decision = lifecycle.decidePermission({
      requestId: permission.requestId,
      decision: "deny",
    });
    const continued = await pendingContinue;

    expect({ beforeDecision, completedResponse, decision, continued, requestCount }).toEqual({
      beforeDecision: {
        ...snapshotWithLastPromptProjection(created, permissionRequestDigest),
        status: "interrupted",
        lastSequence: 12,
        run: {
          runId: expect.any(String),
          status: "interrupted",
          lastAttempt: { turn: 1, attempt: 1, status: "completed" },
          lastCompletedResponse: {
            turn: 1,
            attempt: 1,
            finishReason: "tool_calls",
          },
        },
      },
      completedResponse: expect.objectContaining({
        schemaVersion: 3,
        record: expect.objectContaining({
          response: expect.objectContaining({
            toolIntents: [
              {
                callId: "read-project",
                name: "read_file",
                argumentsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                effect: "read",
                definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                replay: "safe",
              },
            ],
          }),
        }),
      }),
      decision: { status: "accepted" },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({ status: "settled" }),
      },
      requestCount: 2,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

const reasoningToolDeepSeekStream = `data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"I need ","tool_calls":[{"index":0,"id":"read-project","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"the README.","tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":9,"total_tokens":22}}

data: [DONE]

`;

test("SessionLifecycle cold continuation interrupts the old attempt and reuses its run and budgets", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-cold-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () =>
      new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174100";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "logical_run_started",
        runId,
        userMessage: "Introduce yourself",
        limits: { maxTurns: 2, maxTokens: 100 },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Introduce yourself" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(created, "Introduce yourself"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Replace the original request" },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    const continued = await lifecycle.continue({ sessionId: created.sessionId });

    expect({ hydrated, continued, events }).toEqual({
      hydrated: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Introduce yourself").requestProjectionDigest,
          ),
          status: "interrupted",
          lastSequence: 6,
          run: {
            runId,
            status: "interrupted",
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          },
        },
      },
      continued: {
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: {
          ...snapshotWithLastPromptProjection(created, introductionRequestDigest),
          status: "settled",
          lastSequence: 12,
          run: {
            runId,
            status: "settled",
            result: { status: "completed", answer: "Hello, Adam." },
            lastAttempt: { turn: 1, attempt: 2, status: "completed" },
            lastCompletedResponse: {
              turn: 1,
              attempt: 2,
              finishReason: "stop",
            },
          },
        },
      },
      events: [
        { type: "model_message_started" },
        { type: "model_message_delta", text: "Hello, Adam." },
        {
          type: "model_usage",
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
        {
          type: "context_usage",
          ordinary: {
            inputTokens: 7,
            outputTokens: 3,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheMissInputTokens: 0,
            unknownCalls: 0,
          },
          compaction: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheMissInputTokens: 0,
            unknownCalls: 0,
          },
          active: { source: "provider_reported", tokens: 7, throughSequence: 9 },
        },
        { type: "model_message_completed", text: "Hello, Adam." },
        {
          type: "session_settled",
          result: { status: "completed", answer: "Hello, Adam." },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle retains reported token usage from an interrupted provider attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-token-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelWasCalled = false;
  const driver = new FakeModelDriver(() => {
    modelWasCalled = true;
    return [{ type: "finish", reason: "stop" }];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: testContextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: testContextProfile,
          },
        ],
      };
    },
  };

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174101";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Use the remaining budget",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Use the remaining budget" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Use the remaining budget"),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const continued = await lifecycle.continue({ sessionId: created.sessionId });

    expect({ result: continued.result, modelWasCalled }).toEqual({
      result: {
        status: "failed",
        error: {
          code: "token_limit_exceeded",
          message: "The run reached its provider-reported token limit.",
        },
      },
      modelWasCalled: false,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles an exhausted durable tool response before replaying its effect", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-tool-budget-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Budget\n", "utf8");
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174102";
    const call = {
      id: "read-after-budget",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Do not read after budget",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Do not read after budget" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            "Do not read after budget",
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: `sha256:${"0".repeat(64)}`,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 7, outputTokens: 3 },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const durableRecords = await store.read();

    expect({
      resumed,
      modelRequests,
      toolEvents: durableRecords.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type.startsWith("tool_"),
      ),
    }).toEqual({
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            result: {
              status: "failed",
              error: {
                code: "token_limit_exceeded",
                message: "The run reached its provider-reported token limit.",
              },
            },
          }),
        }),
      }),
      modelRequests: 0,
      toolEvents: [],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles a durable stop response with aggregate usage after restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-stop-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174150";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Recover answer",
          limits: { maxTokens: 10 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Recover answer" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Recover answer"),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "Recovered answer.",
            toolCalls: [],
            toolIntents: [],
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 2 },
          },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });

    expect({ modelRequests, resumed }).toEqual({
      modelRequests: 0,
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Recover answer").requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 10,
          run: {
            runId,
            status: "settled",
            result: {
              status: "failed",
              error: {
                code: "token_limit_exceeded",
                message: "The run reached its provider-reported token limit.",
              },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
            lastCompletedResponse: { turn: 1, attempt: 1, finishReason: "stop" },
          },
        },
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold continuation replays a completed safe read as context without executing it again", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-safe-read-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Adam Agent\n", "utf8");
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      tools,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174200";
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: {
          type: "logical_run_started",
          runId,
          userMessage: "Read the project name",
          limits: { maxTurns: 3, maxTokens: 100 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read the project name" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            "Read the project name",
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_usage", inputTokens: 13, outputTokens: 9, totalTokens: 22 },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            reasoning: "I need the README.",
            toolCalls: [
              { id: "read-project", name: "read_file", argumentsJson: '{"path":"README.md"}' },
            ],
            toolIntents: [
              {
                callId: "read-project",
                name: "read_file",
                argumentsDigest: `sha256:${createHash("sha256")
                  .update('{"path":"README.md"}')
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 13, outputTokens: 9 },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: "read-project", name: "read_file" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: "read-project",
            name: "read_file",
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: "read-project", name: "read_file" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_completed",
            callId: "read-project",
            name: "read_file",
            output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 2,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(
            created,
            [
              { role: "user", content: "Read the project name" },
              {
                role: "assistant",
                content: "",
                reasoning: "I need the README.",
                toolCalls: [
                  {
                    id: "read-project",
                    name: "read_file",
                    argumentsJson: '{"path":"README.md"}',
                  },
                ],
              },
              {
                role: "tool",
                callId: "read-project",
                name: "read_file",
                result: {
                  status: "completed",
                  output: { path: "README.md", content: "# Adam Agent\n", truncated: false },
                },
              },
            ],
            tools.definitions(),
          ),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const request = requests[0] as { readonly messages?: readonly unknown[] };

    expect({ hydrated, continued, request, toolEvents: events.filter(isToolEvent) }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          lastSequence: 15,
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          lastSequence: 21,
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 2, status: "completed" },
          }),
        }),
      }),
      request: expect.objectContaining({
        messages: [
          { role: "system", content: basePrompt },
          { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
          { role: "user", content: "Read the project name" },
          expect.objectContaining({
            role: "assistant",
            reasoning_content: "I need the README.",
          }),
          expect.objectContaining({ role: "tool", tool_call_id: "read-project" }),
        ],
      }),
      toolEvents: [],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle settles a started unsafe tool effect as indeterminate without replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-unsafe-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let modelRequests = 0;
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async () => {
      modelRequests += 1;
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createMutationToolRegistry({ stateRoot, workspaceRoot });
    const writeTool = tools.resolve("write_file");
    if (writeTool === undefined) {
      throw new Error("Expected the write_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174300";
    const call = {
      id: "write-unsafe",
      name: "write_file",
      argumentsJson: '{"path":"unsafe.txt","content":"x"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Write unsafe.txt" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Write unsafe.txt" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Write unsafe.txt", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "write",
                definitionDigest: writeTool.definitionDigest,
                replay: "never",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: call.id,
            name: call.name,
            decision: "allow",
            effect: "write",
            scope: "call",
            subject: { type: "file", path: "unsafe.txt" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: call.id, name: call.name },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const resumed = await lifecycle.resume({ sessionId: created.sessionId });
    const unsafeFileExists = await import("node:fs/promises").then(async ({ access }) =>
      access(join(workspaceRoot, "unsafe.txt")).then(
        () => true,
        () => false,
      ),
    );

    expect({ modelRequests, resumed, unsafeFileExists }).toEqual({
      modelRequests: 0,
      resumed: {
        status: "ready",
        snapshot: {
          ...snapshotWithLastPromptProjection(
            created,
            promptProjectionFor(created, "Write unsafe.txt", tools.definitions())
              .requestProjectionDigest,
          ),
          status: "settled",
          lastSequence: 12,
          run: {
            runId,
            status: "settled",
            result: {
              status: "failed",
              error: {
                code: "tool_effect_indeterminate",
                reason: "process_restart",
                message:
                  "The write_file effect started before restart and cannot be replayed safely.",
              },
            },
            lastAttempt: { turn: 1, attempt: 1, status: "completed" },
            lastCompletedResponse: { turn: 1, attempt: 1, finishReason: "tool_calls" },
          },
        },
      },
      unsafeFileExists: false,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle explicitly replays one exact safe read after revalidating its durable allow", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-safe-replay-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Safe replay\n", "utf8");
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174400";
    const call = {
      id: "read-after-restart",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Read the project" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read the project" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Read the project", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            reasoning: "I need the file.",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: call.id,
            name: call.name,
            decision: "allow",
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: call.id, name: call.name },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const persisted = await store.read();
    const publicToolEvents = persisted.flatMap((record) =>
      record.schemaVersion === 3 &&
      record.record.type === "runtime_event" &&
      record.record.event.type.startsWith("tool_")
        ? [record.record.event]
        : [],
    );

    expect({ hydrated, continued, requests, publicToolEvents }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted", lastSequence: 10 }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            runId,
            lastAttempt: { turn: 2, attempt: 1, status: "completed" },
          }),
        }),
      }),
      requests: [
        expect.objectContaining({
          messages: [
            { role: "system", content: basePrompt },
            { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
            { role: "user", content: "Read the project" },
            expect.objectContaining({
              role: "assistant",
              reasoning_content: "I need the file.",
            }),
            expect.objectContaining({ role: "tool", tool_call_id: call.id }),
          ],
        }),
      ],
      publicToolEvents: [
        { type: "tool_requested", callId: call.id, name: call.name },
        {
          type: "tool_permission_decided",
          callId: call.id,
          name: call.name,
          decision: "allow",
          effect: "read",
          scope: "call",
          subject: { type: "file", path: "README.md" },
        },
        { type: "tool_started", callId: call.id, name: call.name },
        {
          type: "tool_completed",
          callId: call.id,
          name: call.name,
          output: { path: "README.md", content: "# Safe replay\n", truncated: false },
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle asks again after restart instead of restoring a pending permission as approval", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-pending-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Pending\n", "utf8");
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });

  try {
    const tools = createReadToolRegistry({ workspaceRoot });
    const readTool = tools.resolve("read_file");
    if (readTool === undefined) {
      throw new Error("Expected the read_file tool.");
    }
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
      stateRoot,
      tools,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174500";
    const call = {
      id: "read-pending",
      name: "read_file",
      argumentsJson: '{"path":"README.md"}',
    } as const;
    const requestId = `${runId}:${call.id}`;
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    const records: readonly Omit<
      Extract<SessionRecord, { readonly schemaVersion: 3 }>,
      "sequence"
    >[] = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Read pending" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Read pending" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: promptProjectionFor(created, "Read pending", tools.definitions()),
        },
      },
      {
        schemaVersion: 3,
        record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest: `sha256:${createHash("sha256")
                  .update(call.argumentsJson)
                  .digest("hex")}`,
                effect: "read",
                definitionDigest: readTool.definitionDigest,
                replay: "safe",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_requested",
            requestId,
            callId: call.id,
            name: call.name,
            effect: "read",
            scope: "call",
            subject: { type: "file", path: "README.md" },
          },
        },
      },
    ];
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }
    let resolvePermission:
      | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
      | undefined;
    const askedAgain = new Promise<
      Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
    >((resolve) => {
      resolvePermission = resolve;
    });
    lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested") {
        resolvePermission?.(event);
      }
    });

    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continuing = lifecycle.continue({ sessionId: created.sessionId });
    const repeatedPermission = await askedAgain;
    const decision = lifecycle.decidePermission({
      requestId: repeatedPermission.requestId,
      decision: "deny",
    });
    const continued = await continuing;

    expect({ hydrated, repeatedPermission, decision, continued, requests }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({ status: "interrupted" }),
      }),
      repeatedPermission: {
        type: "tool_permission_requested",
        requestId,
        callId: call.id,
        name: call.name,
        effect: "read",
        scope: "call",
        subject: { type: "file", path: "README.md" },
      },
      decision: { status: "accepted" },
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
      }),
      requests: [
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "tool", tool_call_id: call.id }),
          ]),
        }),
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "mismatched tool definition before start",
    currentTool: true,
    storedDefinitionMatches: false,
    started: false,
  },
])(
  "SessionLifecycle settles safe work with an $label as indeterminate",
  async ({ currentTool, storedDefinitionMatches, started }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-tool-matrix-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "# Matrix\n", "utf8");
    let modelRequests = 0;
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () => {
        modelRequests += 1;
        return new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });

    try {
      const tools = createReadToolRegistry({ workspaceRoot });
      const readTool = tools.resolve("read_file");
      if (readTool === undefined) {
        throw new Error("Expected the read_file tool.");
      }
      const harness = createInMemorySessionLifecycleHarness();
      const lifecycle = harness.createLifecycle({
        modelTargets,
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        stateRoot,
        ...(currentTool ? { tools } : {}),
        workspaceRoot,
      });
      const created = await lifecycle.create({ targetIdentity });
      const runId = "123e4567-e89b-42d3-a456-426614174510";
      const call = {
        id: "read-matrix",
        name: "read_file",
        argumentsJson: '{"path":"README.md"}',
      } as const;
      const store = await harness.sessions.open(created.sessionId);
      if (store === undefined) {
        throw new Error("Expected the created session store.");
      }
      const records: readonly Omit<
        Extract<SessionRecord, { readonly schemaVersion: 3 }>,
        "sequence"
      >[] = [
        {
          schemaVersion: 3,
          record: { type: "logical_run_started", runId, userMessage: "Read with matrix" },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "user_message", text: "Read with matrix" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "provider_attempt_started",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            promptProjection: promptProjectionFor(
              created,
              "Read with matrix",
              currentTool ? tools.definitions() : [],
            ),
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_started" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "model_response_completed",
            runId,
            turn: 1,
            attempt: 1,
            targetIdentity,
            response: {
              text: "",
              toolCalls: [call],
              toolIntents: [
                {
                  callId: call.id,
                  name: call.name,
                  argumentsDigest: `sha256:${createHash("sha256")
                    .update(call.argumentsJson)
                    .digest("hex")}`,
                  effect: "read",
                  definitionDigest: storedDefinitionMatches
                    ? readTool.definitionDigest
                    : `sha256:${"0".repeat(64)}`,
                  replay: "safe",
                },
              ],
              finishReason: "tool_calls",
            },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "model_message_completed", text: "" },
          },
        },
        {
          schemaVersion: 3,
          record: {
            type: "runtime_event",
            runId,
            event: { type: "tool_requested", callId: call.id, name: call.name },
          },
        },
        ...(started
          ? ([
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: {
                    type: "tool_permission_decided",
                    callId: call.id,
                    name: call.name,
                    decision: "allow",
                    effect: "read",
                    scope: "call",
                    subject: { type: "file", path: "README.md" },
                  },
                },
              },
              {
                schemaVersion: 3,
                record: {
                  type: "runtime_event",
                  runId,
                  event: { type: "tool_started", callId: call.id, name: call.name },
                },
              },
            ] satisfies readonly Omit<
              Extract<SessionRecord, { readonly schemaVersion: 3 }>,
              "sequence"
            >[])
          : []),
      ];
      for (const [index, record] of records.entries()) {
        await store.append({ ...record, sequence: index + 2 } as SessionRecord);
      }

      const resumed = await lifecycle.resume({ sessionId: created.sessionId });

      expect({ modelRequests, resumed }).toEqual({
        modelRequests: 0,
        resumed: expect.objectContaining({
          status: "ready",
          snapshot: expect.objectContaining({
            status: "settled",
            run: expect.objectContaining({
              result: {
                status: "failed",
                error: {
                  code: "tool_effect_indeterminate",
                  reason: "process_restart",
                  message: started
                    ? "The read_file effect started before restart and cannot be replayed safely."
                    : "The durable read_file request no longer matches the current tool definition and requires inspection.",
                },
              },
            }),
          }),
        }),
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle rejects an incomplete canonical tool response from untrusted history", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-incomplete-response-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const runId = "123e4567-e89b-42d3-a456-426614174511";
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Incomplete response" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Incomplete response" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: promptProjectionFor(created, "Incomplete response"),
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const incompleteRecord = {
      schemaVersion: 3,
      sequence: 6,
      record: {
        type: "model_response_completed",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        response: {
          text: "",
          toolCalls: [
            { id: "incomplete-read", name: "read_file", argumentsJson: '{"path":"README.md"}' },
          ],
          toolIntents: [],
          finishReason: "tool_calls",
        },
      },
    };
    await writeFile(
      sessionPath,
      `${await readFile(sessionPath, "utf8")}${JSON.stringify(incompleteRecord)}\n`,
      "utf8",
    );

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a title terminal record without its matching durable start", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-invalid-title-history-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  try {
    const harness = createInMemorySessionLifecycleHarness();
    const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const store = await harness.sessions.open(created.sessionId);
    if (store === undefined) {
      throw new Error("Expected the created session store.");
    }
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: {
        type: "session_title_generation_completed",
        recordVersion: 1,
        generationId: "123e4567-e89b-42d3-a456-426614174512",
        title: "Fabricated title",
        usage: { status: "unknown" },
      },
    });

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

function createVisionResponsesTargets(driver: ModelDriver): ModelTargets {
  return {
    async resolve() {
      return {
        identity: visionResponsesIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        modalityProfile: {
          profileVersion: 1,
          explicitUserImages: "unsupported",
          imageToolResults: "supported",
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: visionResponsesIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
          },
        ],
      };
    },
  };
}

function createAppendCrashDirectory(
  backing: SessionStoreDirectory<SessionRecord>,
  shouldCrash: (record: SessionRecord) => boolean,
): {
  readonly directory: SessionStoreDirectory<SessionRecord>;
  readonly didTrip: () => boolean;
  readonly disable: () => void;
} {
  let enabled = true;
  let tripped = false;
  let blocking = false;
  const wrapStore = (
    store: Awaited<ReturnType<SessionStoreDirectory<SessionRecord>["create"]>>,
  ) => ({
    async append(record: SessionRecord) {
      if (enabled && (blocking || shouldCrash(record))) {
        blocking = true;
        tripped = true;
        throw new Error("simulated process loss after the selected durable prefix");
      }
      await store.append(record);
    },
    async appendBatch(records: readonly SessionRecord[]) {
      if (enabled && records.some((record) => blocking || shouldCrash(record))) {
        blocking = true;
        tripped = true;
        throw new Error("simulated process loss after the selected durable prefix");
      }
      await store.appendBatch(records);
    },
    read: () => store.read(),
  });
  return {
    directory: {
      async create(sessionId) {
        return wrapStore(await backing.create(sessionId));
      },
      listSessionEntries: () => backing.listSessionEntries(),
      listSessionIds: () => backing.listSessionIds(),
      async open(sessionId) {
        const store = await backing.open(sessionId);
        return store === undefined ? undefined : wrapStore(store);
      },
    },
    didTrip: () => tripped,
    disable() {
      enabled = false;
      blocking = false;
    },
  };
}

function isToolEvent(event: RuntimeEvent): boolean {
  return event.type.startsWith("tool_");
}
