import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCodingToolRegistry,
  type createSessionLifecycle as createRawSessionLifecycle,
  type ModelDriver,
  type ModelTargets,
  type ToolRegistry,
} from "@adam-agent/agent";
import {
  planApprovalIntentBarrier,
  presentationSessionRecordReader,
  sessionLogicalRunStartedBarrier,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";

import {
  contextProfile,
  createPresentationSession,
  createSessionLifecycle,
  readInMemoryPresentationRecords,
  settledModelTargets,
  targetIdentity,
} from "./presentation-session.test-support.js";

function planSubmittingModelTargets(input: {
  readonly markdown: string;
  readonly title?: string;
  readonly laterAnswer?: string;
  readonly onRequest?: (
    requestCount: number,
    request: Parameters<ModelDriver["stream"]>[0],
  ) => void;
}): ModelTargets {
  let requestCount = 0;
  const driver = new FakeModelDriver((request) => {
    requestCount += 1;
    input.onRequest?.(requestCount, request);
    if (requestCount === 1) {
      expect(request.tools.map((tool) => tool.name)).toContain("submit_plan");
      return [
        { type: "tool_call_start", id: "submit-plan", name: "submit_plan" },
        {
          type: "tool_call_delta",
          id: "submit-plan",
          json: JSON.stringify({
            ...(input.title === undefined ? {} : { title: input.title }),
            markdown: input.markdown,
          }),
        },
        { type: "tool_call_end", id: "submit-plan" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: input.laterAnswer ?? "Revising the exact plan." },
      { type: "finish", reason: "stop" },
    ];
  });
  return {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
}

test("PresentationSession durably enters a hybrid Plan cycle and rehydrates its exact identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-enter-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    const entered = presentation.getState().authoritative.active?.plan;
    expect(entered).toMatchObject({
      state: "exploring",
      cycleId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      revision: 1,
      policyVersion: "plan-policy.hybrid-v1",
      shellPolicyVersion: "plan-shell-policy.v1",
    });

    await presentation.close();
    presentation = undefined;
    await lifecycle.close();
    lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.plan).toEqual(entered);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects the exact immutable plan identity from SessionLifecycle", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-submit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Exact plan\n\n1. Inspect `src/`.\n2. Implement the approved change.\n";
  const title = "Exact implementation plan";
  const markdownBytes = Buffer.from(markdown, "utf8");
  const contentDigest = `sha256:${createHash("sha256").update(markdownBytes).digest("hex")}`;
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({ markdown, title }),
    stateRoot,
    workspaceRoot,
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId });
    const exploring = presentation.getState().authoritative.active?.plan;
    if (exploring === undefined) {
      throw new Error("Expected an exploring Plan cycle.");
    }

    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the exact completed plan." },
    });
    const ready = submitted.snapshot.plan;
    if (ready?.state !== "ready") {
      throw new Error("Expected the submitted plan to be ready.");
    }
    expect(ready).toEqual({
      ...exploring,
      state: "ready",
      revision: 2,
      submission: {
        planId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        revision: 2,
        contentDigest,
        title,
        artifact: {
          id: contentDigest,
          mediaType: "text/markdown; charset=utf-8",
          byteCount: markdownBytes.byteLength,
          source: {
            type: "plan",
            schemaVersion: 1,
            projectId: created.projectId,
            sessionId: created.sessionId,
            cycleId: exploring.cycleId,
            planId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            revision: 2,
            provenance: "model_submit_plan",
          },
        },
        policyVersion: exploring.policyVersion,
        toolProfileDigest: exploring.eligibleToolProfile.digest,
      },
    });
    expect(ready.submission.artifact.source.planId).toBe(ready.submission.planId);
    await presentation.close();
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    expect(presentation.getState().authoritative.active?.plan).toEqual(ready);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession creates Plan revision intent without changing durable ready state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-revise-intent-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({ markdown: "# Revise me\n" }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const exploring = await lifecycle.enterPlan({ sessionId: created.sessionId });
    if (exploring.plan?.state !== "exploring") {
      throw new Error("Expected an exploring Plan cycle.");
    }
    const submittedResult = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the first exact plan." },
    });
    const submitted = submittedResult.snapshot;
    if (submitted.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const before = await lifecycle.inspect({ sessionId: created.sessionId });

    await expect(
      presentation.dispatch({
        type: "revise_plan",
        sessionId: created.sessionId,
        cycleId: submitted.plan.cycleId,
        revision: submitted.plan.revision,
        planId: submitted.plan.submission.planId,
        contentDigest: submitted.plan.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted" });

    expect(presentation.getState().composer.revisionIntent).toEqual({
      sessionId: created.sessionId,
      cycleId: submitted.plan.cycleId,
      revision: submitted.plan.revision,
      planId: submitted.plan.submission.planId,
      contentDigest: submitted.plan.submission.contentDigest,
    });
    await expect(
      presentation.dispatch({
        type: "replace_draft_text",
        baseRevision: presentation.getState().composer.draftRevision,
        document: [{ type: "text", text: "Keep the first step and add rollback verification." }],
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().composer.renderedText).toBe(
      "Keep the first step and add rollback verification.",
    );
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toEqual(before);
    await expect(
      presentation.dispatch({
        type: "cancel_plan",
        sessionId: created.sessionId,
        cycleId: submitted.plan.cycleId,
        revision: submitted.plan.revision,
        planId: submitted.plan.submission.planId,
        contentDigest: submitted.plan.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().composer.revisionIntent).toBeNull();
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession submits revision feedback as one ordinary turn that stales ready state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-revise-submit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({
      markdown: "# First revision\n",
      laterAnswer: "I will revise the plan.",
    }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const exploring = await lifecycle.enterPlan({ sessionId: created.sessionId });
    if (exploring.plan?.state !== "exploring") {
      throw new Error("Expected an exploring Plan cycle.");
    }
    const submittedResult = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the first exact plan." },
    });
    const submitted = submittedResult.snapshot;
    if (submitted.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({
      type: "revise_plan",
      sessionId: created.sessionId,
      cycleId: submitted.plan.cycleId,
      revision: submitted.plan.revision,
      planId: submitted.plan.submission.planId,
      contentDigest: submitted.plan.submission.contentDigest,
    });

    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Keep the first step, but add a rollback check.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });

    const revised = await lifecycle.inspect({ sessionId: created.sessionId });
    if (revised.schemaVersion !== 3) {
      throw new Error("Expected the current Session schema.");
    }
    expect(revised).toMatchObject({
      plan: {
        state: "exploring",
        cycleId: submitted.plan.cycleId,
        revision: submitted.plan.revision + 1,
        policyVersion: submitted.plan.policyVersion,
        eligibleToolProfile: submitted.plan.eligibleToolProfile,
      },
    });
    expect(revised.plan).not.toHaveProperty("submission");
    expect(presentation.getState().composer.revisionIntent).toBeNull();
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession durably records exact Plan approval intent before implementation starts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-approval-intent-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerCalls = 0;
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({
      markdown: "# Approved implementation\n",
      onRequest: (count) => {
        providerCalls = count;
      },
    }),
    stateRoot,
    workspaceRoot,
    [planApprovalIntentBarrier]: {
      afterDurableRecord() {
        throw new Error("injected crash before implementation kickoff");
      },
    },
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the exact completed plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    await expect(
      presentation.dispatch({
        type: "approve_plan",
        commandId: "123e4567-e89b-42d3-a456-426614176020",
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });

    expect(providerCalls).toBe(1);
    const recovered = await lifecycle.inspect({ sessionId: created.sessionId });
    if (recovered.schemaVersion !== 3) {
      throw new Error("Expected the current Session schema.");
    }
    const recoveredPlan = recovered.plan;
    if (recoveredPlan?.state !== "approved_not_started") {
      throw new Error("Expected the durable unstarted Plan approval.");
    }
    expect(recoveredPlan).toMatchObject({
      state: "approved_not_started",
      cycleId: ready.cycleId,
      revision: ready.revision,
      submission: ready.submission,
      approval: {
        commandId: "123e4567-e89b-42d3-a456-426614176020",
        kickoffRunId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
        policyVersion: ready.policyVersion,
        toolProfileDigest: ready.eligibleToolProfile.digest,
      },
    });
    const records = await readInMemoryPresentationRecords(harness.sessions)(created.sessionId);
    const approvalIndex = records.findIndex(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_approval_intent",
    );
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(
      records
        .slice(approvalIndex + 1)
        .some(
          (entry) =>
            entry.schemaVersion === 3 &&
            entry.record.type === "logical_run_started" &&
            entry.record.runId === recoveredPlan.approval.kickoffRunId,
        ),
    ).toBe(false);
    await expect(
      presentation.dispatch({
        type: "approve_plan",
        commandId: "123e4567-e89b-42d3-a456-426614176020",
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      commandId: "123e4567-e89b-42d3-a456-426614176020",
    });
    expect(providerCalls).toBeGreaterThanOrEqual(2);
    const completedRecords = await readInMemoryPresentationRecords(harness.sessions)(
      created.sessionId,
    );
    expect(
      completedRecords.filter(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_approval_intent",
      ),
    ).toHaveLength(1);
    expect(
      completedRecords.filter(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "logical_run_started" &&
          entry.record.planKickoff?.commandId === "123e4567-e89b-42d3-a456-426614176020",
      ),
    ).toHaveLength(1);
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession owns an approved Plan kickoff as the active cancellable run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-active-kickoff-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const kickoffStarted = Promise.withResolvers<void>();
  const releaseKickoff = Promise.withResolvers<void>();
  let logicalRunCount = 0;
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({
      markdown: "# Active implementation\n",
      laterAnswer: "Implemented the active approved plan.",
    }),
    stateRoot,
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        logicalRunCount += 1;
        if (logicalRunCount === 2) {
          kickoffStarted.resolve();
          await releaseKickoff.promise;
        }
      },
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let approving: Promise<unknown> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the active implementation plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    approving = presentation.dispatch({
      type: "approve_plan",
      commandId: "123e4567-e89b-42d3-a456-426614176029",
      sessionId: created.sessionId,
      cycleId: ready.cycleId,
      revision: ready.revision,
      planId: ready.submission.planId,
      contentDigest: ready.submission.contentDigest,
    });
    await kickoffStarted.promise;

    expect(presentation.getState().transient).toMatchObject({ activity: "working" });
    const duplicateApproval = presentation.dispatch({
      type: "approve_plan",
      commandId: "123e4567-e89b-42d3-a456-426614176029",
      sessionId: created.sessionId,
      cycleId: ready.cycleId,
      revision: ready.revision,
      planId: ready.submission.planId,
      contentDigest: ready.submission.contentDigest,
    });
    const concurrentPrompt = presentation.dispatch({
      type: "submit_prompt",
      sessionId: created.sessionId,
      text: "This must not race the approved kickoff.",
      skills: [],
      thinkingSelection: null,
    });
    releaseKickoff.resolve();

    await expect(concurrentPrompt).resolves.toMatchObject({ status: "rejected", code: "conflict" });
    await expect(approving).resolves.toMatchObject({ status: "admitted" });
    await expect(duplicateApproval).resolves.toMatchObject({
      status: "admitted",
      commandId: "123e4567-e89b-42d3-a456-426614176029",
    });
    expect(presentation.getState().transient).toBeNull();
    await presentation.close();
    presentation = undefined;
  } finally {
    releaseKickoff.resolve();
    await approving?.catch(() => undefined);
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession explicitly continues one recovered Plan approval with its reserved kickoff projection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-kickoff-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Exact approved plan\n\n1. Make the bounded change.\n2. Verify it.\n";
  let kickoffRequest: Parameters<ModelDriver["stream"]>[0] | undefined;
  const modelTargets = planSubmittingModelTargets({
    markdown,
    laterAnswer: "Implemented the exact approved plan.",
    onRequest: (count, request) => {
      if (count === 2) {
        kickoffRequest = request;
      }
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  let lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [planApprovalIntentBarrier]: {
      afterDurableRecord() {
        throw new Error("injected crash before implementation kickoff");
      },
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the exact completed plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    const commandId = "123e4567-e89b-42d3-a456-426614176021";
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({
      type: "approve_plan",
      commandId,
      sessionId: created.sessionId,
      cycleId: ready.cycleId,
      revision: ready.revision,
      planId: ready.submission.planId,
      contentDigest: ready.submission.contentDigest,
    });
    const approved = await lifecycle.inspect({ sessionId: created.sessionId });
    if (approved.schemaVersion !== 3 || approved.plan?.state !== "approved_not_started") {
      throw new Error("Expected a recoverable unstarted approval.");
    }
    const approval = approved.plan.approval;

    await presentation.close();
    presentation = undefined;
    await lifecycle.close();
    lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    expect(presentation.getState().authoritative.active?.plan).toMatchObject({
      state: "approved_not_started",
      approval,
    });

    await expect(
      presentation.dispatch({
        type: "continue_plan",
        commandId,
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted", commandId });

    expect(kickoffRequest?.approvedPlan).toEqual({
      version: 1,
      sessionId: created.sessionId,
      commandId,
      kickoffRunId: approval.kickoffRunId,
      cycleId: ready.cycleId,
      revision: ready.revision,
      planId: ready.submission.planId,
      contentDigest: ready.submission.contentDigest,
      title: undefined,
      markdown,
      policyVersion: ready.policyVersion,
      toolProfileDigest: ready.eligibleToolProfile.digest,
    });
    const settled = await lifecycle.inspect({ sessionId: created.sessionId });
    if (settled.schemaVersion !== 3) {
      throw new Error("Expected the current Session schema.");
    }
    expect(settled.plan).toBeUndefined();
    const records = await readInMemoryPresentationRecords(harness.sessions)(created.sessionId);
    expect(
      records.filter(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_approval_intent",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "logical_run_started" &&
          entry.record.runId === approval.kickoffRunId,
      ),
    ).toHaveLength(1);
    expect(records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "provider_attempt_started",
          runId: approval.kickoffRunId,
          promptProjection: expect.objectContaining({
            approvedPlanProjectionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
        }),
      }),
    );
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects stale approval and cancels only the exact current ready Plan artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: planSubmittingModelTargets({ markdown: "# Cancel this plan\n" }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the cancellable plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected a ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    const beforeStaleApproval = await lifecycle.inspect({ sessionId: created.sessionId });
    await expect(
      presentation.dispatch({
        type: "exit_plan",
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toEqual(
      beforeStaleApproval,
    );
    await expect(
      presentation.dispatch({
        type: "approve_plan",
        commandId: "123e4567-e89b-42d3-a456-426614176026",
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "stale_interaction" });
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toEqual(
      beforeStaleApproval,
    );

    await expect(
      presentation.dispatch({
        type: "cancel_plan",
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted" });

    const cancelled = await lifecycle.inspect({ sessionId: created.sessionId });
    if (cancelled.schemaVersion !== 3) {
      throw new Error("Expected the current Session schema.");
    }
    expect(cancelled.plan).toBeUndefined();
    const records = await readInMemoryPresentationRecords(harness.sessions)(created.sessionId);
    expect(records.at(-1)).toMatchObject({
      record: {
        type: "plan_cycle_exited",
        cycleId: ready.cycleId,
        revision: ready.revision + 1,
        reason: "user_cancelled",
      },
    });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession freezes the exact eligible hybrid Tool Profile for a Plan cycle", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    const profile = presentation.getState().authoritative.active?.plan?.eligibleToolProfile;
    expect(profile).toMatchObject({
      version: 1,
      source: {
        version: created.promptContext?.toolProfile.version,
        digest: created.promptContext?.toolProfile.digest,
      },
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(profile?.definitions).toEqual(
      [
        "read_file",
        "search_repository",
        "run_shell",
        "activate_skill",
        "read_skill_resource",
        "read_input_resource",
        "get_todo",
        "list_todos",
      ].map((name) => ({
        name,
        definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        effect: name === "run_shell" ? "execute" : "read",
        source: "builtin",
      })),
    );
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession enters Plan through the exact composed session Tool Registry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-composed-tools-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = settledModelTargets("Composed session settled.");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycleOptions: Parameters<typeof createRawSessionLifecycle>[0] = {
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    stateRoot,
    webHttp: {
      async fetch() {
        throw new Error("Plan profile construction must not perform Web I/O.");
      },
    },
    webSearchConfiguration: {
      async load() {
        return { status: "unconfigured", provider: null, diagnostic: null };
      },
    },
    workspaceRoot,
  };
  let lifecycle = harness.createLifecycle(lifecycleOptions);

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Complete one ordinary production-composed turn." },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    try {
      await expect(
        presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
      ).resolves.toMatchObject({ status: "admitted" });
      expect(
        presentation
          .getState()
          .authoritative.active?.plan?.eligibleToolProfile.definitions.map(
            (definition) => definition.name,
          ),
      ).toEqual([
        "read_file",
        "search_repository",
        "run_shell",
        "activate_skill",
        "read_skill_resource",
        "read_input_resource",
        "get_todo",
        "list_todos",
        "web_open",
        "web_find",
        "list_agents",
        "wait_agents",
      ]);
    } finally {
      await presentation.close();
    }

    await lifecycle.close();
    lifecycle = harness.createLifecycle(lifecycleOptions);
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({ plan: { state: "exploring", revision: 1 } });
    if (inspected.schemaVersion !== 3 || inspected.plan === undefined) {
      throw new Error("Expected the cold composed Plan cycle.");
    }
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: inspected.lastSequence,
    });
    expect(child).toMatchObject({
      plan: {
        state: "exploring",
        cycleId: inspected.plan.cycleId,
        revision: inspected.plan.revision,
        eligibleToolProfile: inspected.plan.eligibleToolProfile,
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession exits one Plan cycle and enters a distinct later cycle", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-repeat-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId });
    const first = presentation.getState().authoritative.active?.plan;
    if (first === undefined) {
      throw new Error("Expected the first Plan cycle.");
    }

    await expect(
      presentation.dispatch({
        type: "exit_plan",
        sessionId: created.sessionId,
        cycleId: first.cycleId,
        revision: first.revision,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.active?.plan).toBeUndefined();

    await expect(
      presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    const second = presentation.getState().authoritative.active?.plan;
    expect(second).toMatchObject({
      state: "exploring",
      revision: 1,
      policyVersion: "plan-policy.hybrid-v1",
      shellPolicyVersion: "plan-shell-policy.v1",
      eligibleToolProfile: first.eligibleToolProfile,
    });
    expect(second?.cycleId).not.toBe(first.cycleId);
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession gives new-session guidance when a historical profile cannot enter Plan", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-historical-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const currentTools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const historicalTools: ToolRegistry = {
    definitions: () =>
      currentTools.definitions().filter((definition) => definition.name !== "search_repository"),
    resolve(name) {
      return name === "search_repository" ? undefined : currentTools.resolve(name);
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const historicalLifecycle = harness.createLifecycle({
    stateRoot,
    tools: historicalTools,
    workspaceRoot,
  });
  const created = await historicalLifecycle.create({ targetIdentity });
  await historicalLifecycle.close();
  const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await expect(
      presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId }),
    ).resolves.toEqual({
      status: "rejected",
      code: "not_available",
      message:
        "Plan is unavailable in this historical Tool Profile. Start a new session to use Plan.",
    });
    expect(presentation.getState().authoritative.active?.plan).toBeUndefined();
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession does not upgrade a historical profile with Todo", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-todo-historical-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const currentTools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const todoNames = new Set(["create_todo", "get_todo", "list_todos", "update_todo"]);
  const historicalTools: ToolRegistry = {
    definitions: () =>
      currentTools.definitions().filter((definition) => !todoNames.has(definition.name)),
    resolve(name) {
      return todoNames.has(name) ? undefined : currentTools.resolve(name);
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const historicalLifecycle = harness.createLifecycle({
    stateRoot,
    tools: historicalTools,
    workspaceRoot,
  });
  const created = await historicalLifecycle.create({ targetIdentity });
  await historicalLifecycle.close();
  const lifecycle = harness.createLifecycle({ stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.todo).toBeUndefined();
    await expect(
      presentation.dispatch({
        type: "list_todos",
        sessionId: created.sessionId,
        expectedStoreRevision: 0,
        filter: { status: null, titleContains: null },
        limit: 20,
        cursor: null,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "not_available",
      message:
        "Todo is unavailable in this historical Tool Profile. Start a new session to use Todo.",
    });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects a stale Plan-cycle command without changing durable state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-stale-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await presentation.dispatch({ type: "enter_plan", sessionId: created.sessionId });
    const current = presentation.getState().authoritative.active?.plan;
    if (current === undefined) {
      throw new Error("Expected an active Plan cycle.");
    }

    await expect(
      presentation.dispatch({
        type: "exit_plan",
        sessionId: created.sessionId,
        cycleId: current.cycleId,
        revision: current.revision + 1,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "stale_interaction",
      message: "The selected Plan cycle is no longer current.",
    });
    expect(presentation.getState().authoritative.active?.plan).toEqual(current);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      lastSequence: current.revision + 1,
      plan: current,
    });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
