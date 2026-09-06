import { extensionManagedReviewTerminalCodec } from "@adam-agent/extension-api";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import { createManagedReviewHarness, streamingReviewModel } from "./managed-review-test-support.js";

const parentSessionId = "00000000-0000-4000-8000-000000000001";

test("reviewers expose only aggregate lane truth to ordinary Fleet inspection and never enter Main's completion inbox", async () => {
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ model: provider.model });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    expect(await harness.control().inspect({ parentSessionId })).toMatchObject({
      threads: [],
      completions: [],
      reviewers: { running: 1, queued: 0 },
    });
    expect(
      await harness.control().dispatch({ type: "list_agents", parentSessionId }),
    ).toMatchObject({ status: "listed", threads: [] });
    await provider.text('{"verdict":"verified"}');
    provider.finish();
    await withManagedFailureGuard(harness.events(started.operationId), "Reviewer did not settle");
    expect(await harness.control().inspect({ parentSessionId })).toMatchObject({
      threads: [],
      completions: [],
      reviewers: { running: 0, queued: 0 },
    });
  } finally {
    await harness.close();
  }
});

test("review history does not consume ordinary Agent handles or impose the legacy sixteen-attempt ceiling", async () => {
  const harness = await createManagedReviewHarness();
  try {
    for (let index = 0; index < 17; index += 1) {
      const started = await harness.start(`history-${index}`);
      expect(
        (
          await withManagedFailureGuard(
            harness.events(started.operationId),
            "Review history did not settle",
          )
        ).at(-1)?.event,
      ).toMatchObject({
        type: "operation_completed",
        output: { terminal: { status: "completed" } },
      });
    }
    expect(await harness.control().inspect({ parentSessionId })).toMatchObject({
      threads: [],
      completions: [],
    });
    const receipt = await harness.control().dispatch({
      type: "spawn_agents",
      parentSessionId,
      entries: [
        {
          role: "builtin:explore",
          description: "Ordinary exploration",
          task: "Inspect the local project.",
        },
      ],
    });
    expect(receipt).toMatchObject({ status: "admitted", admissions: [{ handle: "@explore-1" }] });
  } finally {
    await harness.close();
  }
});

test("resolved review policy identity is stable across distinct requests and Operations", async () => {
  const harness = await createManagedReviewHarness();
  try {
    const receipts = [];
    for (const id of ["first-policy", "second-policy"]) {
      const started = await harness.start(id);
      const outer = (
        await withManagedFailureGuard(
          harness.events(started.operationId),
          "Policy receipt did not settle",
        )
      ).at(-1)?.event;
      if (
        outer?.type !== "operation_completed" ||
        typeof outer.output !== "object" ||
        outer.output === null
      )
        throw new Error("Missing public review result");
      const decoded = extensionManagedReviewTerminalCodec.decode(
        Reflect.get(outer.output, "terminal"),
      );
      if (!decoded.ok || decoded.value.status !== "completed")
        throw new Error("Missing public review receipt");
      receipts.push(decoded.value.receipt);
    }
    expect(receipts[0]?.reviewRunId).not.toBe(receipts[1]?.reviewRunId);
    expect(receipts[0]?.policyDigest).toBe(receipts[1]?.policyDigest);
  } finally {
    await harness.close();
  }
});

test("ordinary Agent controls cannot cancel, redirect, wait for, or continue a review even with an internal identity", async () => {
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ model: provider.model });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    const admission = (await harness.controlStore().read()).find(
      (record) => record.event.type === "admitted",
    );
    if (admission === undefined) throw new Error("Missing canonical reviewer identity");
    const target = {
      parentSessionId,
      threadId: admission.threadId,
      expectedTurnId: admission.turnId,
    };
    for (const command of [
      { type: "cancel_turn" as const, ...target },
      {
        type: "post_agent" as const,
        ...target,
        inputId: "00000000-0000-4000-8000-000000000123",
        mode: "cooperative" as const,
        text: "Change the review.",
      },
      { type: "wait_agents" as const, parentSessionId, targets: [target], mode: "all" as const },
      { type: "next_turn" as const, ...target, task: "Start another review." },
    ])
      expect(await harness.control().dispatch(command)).toMatchObject({
        status: "rejected",
        code: "action_unavailable",
      });
    await harness.host.operations.cancel(started.operationId);
    expect(
      (
        await withManagedFailureGuard(
          harness.events(started.operationId),
          "Operation cancellation did not settle",
        )
      ).at(-1)?.event.type,
    ).toBe("operation_cancelled");
  } finally {
    await harness.close();
  }
});
