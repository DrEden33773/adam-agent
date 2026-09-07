import { createInMemoryOperationStore } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import { createManagedReviewHarness } from "./managed-review-test-support.js";

test.each(["target_unavailable", "policy_denied"] as const)(
  "origin resolution preserves typed %s without dispatch",
  async (originStatus) => {
    const harness = await createManagedReviewHarness({ originStatus });
    try {
      const started = await harness.start();
      const events = await withManagedFailureGuard(
        harness.events(started.operationId),
        "Missing origin refusal",
      );
      expect(events.at(-1)?.event).toMatchObject({
        type: "operation_completed",
        output: { terminal: { status: "failed", error: { code: originStatus } } },
      });
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  },
);

test.each([
  [10_000, "completed"],
  [128_001, "policy_denied"],
] as const)(
  "review can tighten but cannot enlarge the origin token ceiling to %s",
  async (maximumCumulativeTokens, outcome) => {
    const harness = await createManagedReviewHarness({
      execute: `return { terminal: await capability.review({ ...request, limits: { maximumCumulativeTokens: ${maximumCumulativeTokens} } }) };`,
    });
    try {
      const started = await harness.start();
      const events = await withManagedFailureGuard(
        harness.events(started.operationId),
        "Missing token ceiling result",
      );
      expect(events.at(-1)?.event).toMatchObject({
        type: "operation_completed",
        output: {
          terminal:
            outcome === "completed"
              ? {
                  status: "completed",
                  receipt: {
                    target: { targetId: "fixture.review" },
                    usage: { inputTokens: 10, outputTokens: 5 },
                  },
                }
              : { status: "failed", error: { code: outcome } },
        },
      });
      expect(harness.requests).toHaveLength(outcome === "completed" ? 1 : 0);
    } finally {
      await harness.close();
    }
  },
);

test("cold Operation recovery retains the exact invocation and requires inspection without replay", async () => {
  const harness = await createManagedReviewHarness();
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Missing source review",
    );
    const coldStore = createInMemoryOperationStore();
    for (const event of events) {
      await coldStore.append(event);
      if (event.event.type === "operation_managed_review_invoked") break;
    }
    const cold = harness.coldHost(coldStore);
    await cold.loadConfiguredExtensions();
    expect(await cold.operations.query(started.operationId)).toMatchObject({
      status: "recovery_required",
    });
    expect(await cold.operations.recover(started.operationId)).toMatchObject({
      status: "inspection_required",
      message: expect.stringContaining("review"),
    });
    expect(await cold.operations.recover(started.operationId)).toMatchObject({
      status: "inspection_required",
    });
    const joined = await cold.operations.startLinked({
      contributionId: "fixture.purpose-review",
      idempotencyKey: "first-review",
      input: {},
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: "00000000-0000-4000-8000-000000000001",
        sourceSequence: 3,
      },
    });
    expect(joined).toEqual(started);
    expect(harness.requests).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("same-digest calls join one durably identified review invocation", async () => {
  const harness = await createManagedReviewHarness({
    execute: `
    const [first, joined] = await Promise.all([capability.review(request), capability.review(request)]);
    const repeated = await capability.review(request);
    return { first, joined, repeated };
  `,
  });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Missing joined review",
    );
    const terminal = events.at(-1)?.event;
    expect(terminal?.type).toBe("operation_completed");
    if (
      terminal?.type !== "operation_completed" ||
      typeof terminal.output !== "object" ||
      terminal.output === null ||
      Array.isArray(terminal.output)
    )
      throw new Error("Missing joined results");
    expect(Reflect.get(terminal.output, "joined")).toEqual(Reflect.get(terminal.output, "first"));
    expect(Reflect.get(terminal.output, "repeated")).toEqual(Reflect.get(terminal.output, "first"));
    expect(harness.requests).toHaveLength(1);
    const invocations = events.filter(
      (record) => record.event.type === "operation_managed_review_invoked",
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.event).toMatchObject({
      reviewRunId: expect.any(String),
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(
      events.findIndex((record) => record.event.type === "operation_managed_review_invoked"),
    ).toBeLessThan(
      events.findIndex((record) => record.event.type === "operation_managed_wait_started"),
    );
    expect(
      events
        .filter((record) => record.event.type === "operation_managed_review_progress")
        .map((record) => Reflect.get(record.event, "progress").phase),
    ).toEqual(["waiting_for_capacity", "running", "settling", "terminal"]);
  } finally {
    await harness.close();
  }
});

test("mutating a returned result cannot change the cached authoritative review receipt", async () => {
  const harness = await createManagedReviewHarness({
    execute: `
    const first = await capability.review(request);
    first.result.verdict = "tampered";
    first.receipt.reviewRunId = "00000000-0000-4000-8000-000000000999";
    return { terminal: await capability.review(request) };
  `,
  });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Cached review did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: { terminal: { result: { verdict: "verified" } } },
    });
    expect(harness.requests).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("a conflicting second review request fails the Operation even when the extension catches it", async () => {
  const harness = await createManagedReviewHarness({
    execute: `
    await capability.review(request);
    try { await capability.review({ ...request, instruction: "A different review." }); } catch {}
    return { claimedSuccess: true };
  `,
  });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Missing conflict terminal",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_failed",
      error: { code: "operation_capability_conflict" },
    });
    expect(harness.requests).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
