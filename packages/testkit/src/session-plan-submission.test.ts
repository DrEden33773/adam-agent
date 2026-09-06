import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodingToolRegistry, type ModelTargets, type RuntimeEvent } from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  type SessionRecord,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionDurableOutputLimits,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  createSessionLifecycleForTests as createSessionLifecycle,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
  sessionLifecycleContextProfile as testContextProfile,
} from "./session-lifecycle.test-support.js";

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

test("SessionLifecycle preserves a non-empty submit_plan preamble across current and cold inspection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-preamble-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Reviewed plan\n\n1. Preserve the preamble.\n2. Submit the artifact.\n";
  const title = "Reviewed plan";
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "The exact Plan is ready for external review." },
    { type: "tool_call_start", id: "submit-plan-with-preamble", name: "submit_plan" },
    {
      type: "tool_call_delta",
      id: "submit-plan-with-preamble",
      json: JSON.stringify({ title, markdown }),
    },
    { type: "tool_call_end", id: "submit-plan-with-preamble" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets = modelTargetsWithDriver(driver);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycleOptions = {
    modelTargets,
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
  };
  let lifecycle = harness.createLifecycle(lifecycleOptions);

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Publish the exact implementation plan." },
    });

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
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      plan: { state: "ready", revision: 2, submission: { title } },
    });

    await lifecycle.close();
    lifecycle = harness.createLifecycle(lifecycleOptions);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      plan: { state: "ready", revision: 2, submission: { title } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle preserves an artifact-backed submit_plan preamble across current and cold inspection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-artifact-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown =
    "# Artifact-backed plan\n\n1. Retain the assistant preamble.\n2. Review the Plan.\n";
  const title = "Artifact-backed plan";
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "This preamble must be stored outside the inline response field." },
    { type: "tool_call_start", id: "submit-artifact-plan", name: "submit_plan" },
    {
      type: "tool_call_delta",
      id: "submit-artifact-plan",
      json: JSON.stringify({ title, markdown }),
    },
    { type: "tool_call_end", id: "submit-artifact-plan" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets = modelTargetsWithDriver(driver);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycleOptions = {
    modelTargets,
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    [sessionDurableOutputLimits]: {
      maximumInlineFieldBytes: 4,
      maximumReferencedArtifactBytes: 1_024,
      maximumResponseContentBytes: 2_048,
    },
  };
  let lifecycle = harness.createLifecycle(lifecycleOptions);

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Publish an artifact-backed Plan response." },
    });

    expect(continued).toMatchObject({
      result: { status: "completed", answer: "" },
      snapshot: { plan: { state: "ready", revision: 2, submission: { title } } },
    });
    const store = await harness.sessions.open(created.sessionId);
    const durableTypes =
      (await store?.read())?.flatMap((record) =>
        record.schemaVersion === 3 ? [record.record.type] : [],
      ) ?? [];
    expect(durableTypes).toContain("model_response_published");
    expect(durableTypes).toContain("run_settled");
    expect(durableTypes).not.toContain("session_settled");
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      plan: { state: "ready", revision: 2, submission: { title } },
    });

    await lifecycle.close();
    lifecycle = harness.createLifecycle(lifecycleOptions);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      plan: { state: "ready", revision: 2, submission: { title } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a terminal submit_plan history whose Plan record is missing", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-plan-submit-missing-record-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "The Plan record must remain authoritative." },
    { type: "tool_call_start", id: "submit-plan-without-record", name: "submit_plan" },
    {
      type: "tool_call_delta",
      id: "submit-plan-without-record",
      json: '{"markdown":"# Missing durable Plan record\\n"}',
    },
    { type: "tool_call_end", id: "submit-plan-without-record" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const wrapStore = (
    store: Awaited<ReturnType<SessionStoreDirectory<SessionRecord>["create"]>>,
  ) => {
    let droppedSequence: number | undefined;
    return {
      async append(record: SessionRecord) {
        await store.append(
          droppedSequence === undefined || record.sequence < droppedSequence
            ? record
            : { ...record, sequence: record.sequence - 1 },
        );
      },
      async appendBatch(records: readonly SessionRecord[]) {
        const filtered = records.flatMap((record) => {
          if (record.schemaVersion === 3 && record.record.type === "plan_submitted") {
            droppedSequence = record.sequence;
            return [];
          }
          return [record];
        });
        await store.appendBatch(filtered);
      },
      read: () => store.read(),
    };
  };
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
    stateRoot,
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: false,
    [sessionStoreDirectory]: directory,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Publish a Plan whose canonical record is dropped." },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
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

test.each([
  "failed terminal",
  "mismatched completed output",
  "mismatched artifact byte count",
  "mismatched content digest",
  "non-empty session settlement",
])(
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
      const settlement = records?.find(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "runtime_event" &&
          entry.record.event.type === "session_settled",
      );
      if (
        terminal?.schemaVersion !== 3 ||
        terminal.record.type !== "runtime_event" ||
        terminal.record.event.type !== "tool_completed" ||
        submitted?.schemaVersion !== 3 ||
        submitted.record.type !== "plan_submitted" ||
        settlement?.schemaVersion !== 3 ||
        settlement.record.type !== "runtime_event" ||
        settlement.record.event.type !== "session_settled"
      ) {
        throw new Error("Expected the exact submit terminal, Plan record, and settlement.");
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
      } else if (caseName === "mismatched artifact byte count") {
        Object.assign(submitted.record.artifact, {
          byteCount: submitted.record.artifact.byteCount + 1,
        });
      } else if (caseName === "mismatched content digest") {
        Object.assign(submitted.record, { contentDigest: `sha256:${"0".repeat(64)}` });
      } else {
        Object.assign(settlement.record.event, {
          result: { status: "completed", answer: "forged Plan answer" },
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
