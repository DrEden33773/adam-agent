import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createPresentationSession,
  createSessionLifecycle as createRawSessionLifecycle,
  type ModelTargetIdentity,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  openJsonlSessionStore,
  planApprovalIntentBarrier,
  type SessionRecord,
  sessionLogicalRunStartedBarrier,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";

const targetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

function createSessionLifecycle(
  options: Parameters<typeof createRawSessionLifecycle>[0],
): ReturnType<typeof createRawSessionLifecycle> {
  return createRawSessionLifecycle({
    ...options,
    workspaceTrust:
      options.workspaceTrust ?? createTrustedWorkspaceTrustForTesting(options.workspaceRoot),
  });
}

test("PresentationSession publishes admission only after the durable logical-input record", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-durable-input-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver(() => {
    throw new Error("The model must not start past the injected durability boundary.");
  });
  const modelTargets: ModelTargets = {
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
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        throw new Error("Injected interruption after durable logical input.");
      },
    },
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Keep the durable logical input",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });

    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("The durable admission boundary must publish its resumable session.");
    }
    const store = await openJsonlSessionStore<SessionRecord>({
      sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(await store.read()).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ type: "session_genesis" }) }),
      expect.objectContaining({
        record: expect.objectContaining({
          type: "logical_run_started",
          userMessage: "Keep the durable logical input",
        }),
      }),
    ]);
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({
      items: [{ sessionId }],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession reads the exact ready Plan artifact through its public bounded seam", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-artifact-read-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Exact review artifact\n\n1. Inspect.\n2. Implement.\n";
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? [
          { type: "tool_call_start" as const, id: "submit-review-artifact", name: "submit_plan" },
          {
            type: "tool_call_delta" as const,
            id: "submit-review-artifact",
            json: JSON.stringify({ title: "Exact review artifact", markdown }),
          },
          { type: "tool_call_end" as const, id: "submit-review-artifact" },
          { type: "finish" as const, reason: "tool_calls" as const },
        ]
      : [
          { type: "text_delta" as const, text: "Implementation completed." },
          { type: "finish" as const, reason: "stop" as const },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available" as const, credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  let lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the exact review artifact." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected one ready Plan artifact.");
    }
    const artifact = submitted.snapshot.plan.submission.artifact;
    const artifactStat = await stat(
      join(stateRoot, "artifacts", artifact.id.slice("sha256:".length)),
    );
    expect(artifactStat.mode & 0o777).toBe(0o400);
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: {
          id: artifact.id,
          mediaType: artifact.mediaType,
          byteCount: artifact.byteCount,
          source: "plan",
        },
        range: null,
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      resource: {
        text: markdown,
        byteCount: Buffer.byteLength(markdown, "utf8"),
        totalByteCount: Buffer.byteLength(markdown, "utf8"),
        eof: true,
      },
    });

    const commandId = "123e4567-e89b-42d3-a456-426614176060";
    await expect(
      presentation.dispatch({
        type: "approve_plan",
        commandId,
        sessionId: created.sessionId,
        cycleId: submitted.snapshot.plan.cycleId,
        revision: submitted.snapshot.plan.revision,
        planId: submitted.snapshot.plan.submission.planId,
        contentDigest: submitted.snapshot.plan.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted", commandId });
    const settled = presentation.getState().authoritative.active;
    expect(settled?.plan).toBeUndefined();
    expect(settled?.transcript.items).toContainEqual(
      expect.objectContaining({
        type: "plan_submission",
        status: "approved",
        submission: expect.objectContaining({
          planId: submitted.snapshot.plan.submission.planId,
          contentDigest: submitted.snapshot.plan.submission.contentDigest,
          artifact,
        }),
        approval: expect.objectContaining({ commandId }),
      }),
    );
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: {
          id: artifact.id,
          mediaType: artifact.mediaType,
          byteCount: artifact.byteCount,
          source: "plan",
        },
        range: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: { text: markdown, eof: true } });
    await presentation.close();
    presentation = undefined;
    await lifecycle.close();
    lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.transcript.items).toContainEqual(
      expect.objectContaining({
        type: "plan_submission",
        status: "approved",
        approval: expect.objectContaining({ commandId }),
      }),
    );
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: {
          id: artifact.id,
          mediaType: artifact.mediaType,
          byteCount: artifact.byteCount,
          source: "plan",
        },
        range: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: { text: markdown, eof: true } });
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession recovers one durable Plan approval intent after a JSONL restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-approval-restart-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const markdown = "# Durable approved Plan\n\n1. Implement it.\n2. Verify it.\n";
  let providerCalls = 0;
  const driver = new FakeModelDriver(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? [
          { type: "tool_call_start" as const, id: "submit-durable-plan", name: "submit_plan" },
          {
            type: "tool_call_delta" as const,
            id: "submit-durable-plan",
            json: JSON.stringify({ markdown }),
          },
          { type: "tool_call_end" as const, id: "submit-durable-plan" },
          { type: "finish" as const, reason: "tool_calls" as const },
        ]
      : [
          { type: "text_delta" as const, text: "Durable approved Plan implemented." },
          { type: "finish" as const, reason: "stop" as const },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available" as const, credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  let lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [planApprovalIntentBarrier]: {
      afterDurableRecord() {
        throw new Error("injected crash after durable Plan approval intent");
      },
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.enterPlan({ sessionId: created.sessionId });
    const submitted = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Submit the durable Plan." },
    });
    if (submitted.snapshot.plan?.state !== "ready") {
      throw new Error("Expected one ready Plan artifact.");
    }
    const ready = submitted.snapshot.plan;
    const commandId = "123e4567-e89b-42d3-a456-426614176063";
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await expect(
      presentation.dispatch({
        type: "approve_plan",
        commandId,
        sessionId: created.sessionId,
        cycleId: ready.cycleId,
        revision: ready.revision,
        planId: ready.submission.planId,
        contentDigest: ready.submission.contentDigest,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });
    expect(providerCalls).toBe(1);
    await presentation.close();
    presentation = undefined;
    await lifecycle.close();

    lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const recovered = await lifecycle.inspect({ sessionId: created.sessionId });
    if (recovered.schemaVersion !== 3 || recovered.plan?.state !== "approved_not_started") {
      throw new Error("Expected one durable unstarted Plan approval after restart.");
    }
    expect(recovered.plan.approval.commandId).toBe(commandId);
    presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
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
    const settled = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(settled).not.toHaveProperty("plan");
    const records = await (
      await openJsonlSessionStore<SessionRecord>({
        sessionId: created.sessionId,
        stateRoot,
        workspaceRoot,
      })
    ).read();
    expect(
      records.filter(
        (record) => record.schemaVersion === 3 && record.record.type === "plan_approval_intent",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "logical_run_started" &&
          record.record.planKickoff?.commandId === commandId,
      ),
    ).toHaveLength(1);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["missing", "corrupt"] as const)(
  "PresentationSession rejects approval of a $failure exact Plan artifact without consuming ready state",
  async (failure) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-plan-artifact-fail-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const markdown = "# Must remain reviewable\n";
    let providerCall = 0;
    const driver = new FakeModelDriver(() => {
      providerCall += 1;
      return providerCall === 1
        ? [
            { type: "tool_call_start", id: "submit-failing-artifact", name: "submit_plan" },
            {
              type: "tool_call_delta",
              id: "submit-failing-artifact",
              json: JSON.stringify({ markdown }),
            },
            { type: "tool_call_end", id: "submit-failing-artifact" },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "must not implement" },
            { type: "finish", reason: "stop" },
          ];
    });
    const modelTargets: ModelTargets = {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available" as const, credentialSource: "test" },
              contextProfile,
            },
          ],
        };
      },
    };
    let lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

    try {
      const created = await lifecycle.create({ targetIdentity });
      await lifecycle.enterPlan({ sessionId: created.sessionId });
      const submitted = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Submit one exact Plan." },
      });
      if (submitted.snapshot.plan?.state !== "ready") {
        throw new Error("Expected one ready Plan artifact.");
      }
      const ready = submitted.snapshot.plan;
      const artifactPath = join(
        stateRoot,
        "artifacts",
        ready.submission.contentDigest.slice("sha256:".length),
      );
      if (failure === "missing") {
        await rm(artifactPath);
      } else {
        await chmod(artifactPath, 0o600);
        await writeFile(artifactPath, "corrupt\n", "utf8");
      }
      const presentation = await createPresentationSession({
        lifecycle,
        projectLabel: "workspace",
        sessionId: created.sessionId,
        stateRoot,
        workspaceRoot,
      });

      await expect(
        presentation.dispatch({
          type: "approve_plan",
          commandId:
            failure === "missing"
              ? "123e4567-e89b-42d3-a456-426614176061"
              : "123e4567-e89b-42d3-a456-426614176062",
          sessionId: created.sessionId,
          cycleId: ready.cycleId,
          revision: ready.revision,
          planId: ready.submission.planId,
          contentDigest: ready.submission.contentDigest,
        }),
      ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });
      await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        plan: { state: "ready", submission: ready.submission },
      });
      const records = await (
        await openJsonlSessionStore<SessionRecord>({
          sessionId: created.sessionId,
          stateRoot,
          workspaceRoot,
        })
      ).read();
      expect(
        records.some(
          (record) => record.schemaVersion === 3 && record.record.type === "plan_approval_intent",
        ),
      ).toBe(false);
      await presentation.close();
      await lifecycle.close();
      lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
      await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
        plan: { state: "ready", submission: ready.submission },
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);
