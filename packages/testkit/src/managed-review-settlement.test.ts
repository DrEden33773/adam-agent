import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createManagedReviewHarness,
  ReviewClock,
  streamingReviewModel,
} from "./managed-review-test-support.js";

test("both review and outer Operation remain settling until cleanup and durable cancellation wins over an available model result", async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harness = await createManagedReviewHarness({
    settlementBarrier: async () => {
      reached.resolve();
      await release.promise;
    },
  });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(reached.promise, "Cleanup barrier was not reached");
    expect(await harness.host.operations.query(started.operationId)).toMatchObject({
      status: "running",
      managedReview: { progress: { phase: "settling" } },
    });
    await harness.host.operations.cancel(started.operationId);
    expect(await harness.host.operations.query(started.operationId)).toMatchObject({
      status: "cancel_requested",
      managedReview: { progress: { phase: "settling" } },
    });
    release.resolve();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Cancelled review did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({ type: "operation_cancelled", reason: "caller" });
  } finally {
    release.resolve();
    await harness.close();
  }
});

test("an extension cannot bypass managed settlement by returning without awaiting its review", async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harness = await createManagedReviewHarness({
    execute: "void capability.review(request).catch(() => {}); return { finished: true };",
    settlementBarrier: async () => {
      reached.resolve();
      await release.promise;
    },
  });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(reached.promise, "Unawaited review did not reach cleanup");
    expect(await harness.host.operations.query(started.operationId)).toMatchObject({
      status: "running",
      managedReview: { progress: { phase: "settling" } },
    });
    release.resolve();
    expect(
      (
        await withManagedFailureGuard(
          harness.events(started.operationId),
          "Unawaited review did not settle",
        )
      ).at(-1)?.event.type,
    ).toBe("operation_completed");
  } finally {
    release.resolve();
    await harness.close();
  }
});

test("a failed extension handler cancels its unawaited review before starting a provider", async () => {
  const harness = await createManagedReviewHarness({
    execute:
      "void capability.review(request).catch(() => {}); throw new Error('Fixture handler failed');",
  });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Failed handler did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_failed",
      error: { code: "extension_execution_failed" },
    });
    expect(harness.requests).toEqual([]);
  } finally {
    await harness.close();
  }
});

test.each([
  "try { await capability.review(request); } catch {} return { claimedSuccess: true };",
  "void capability.review(request).catch(() => {}); return { claimedSuccess: true };",
])(
  "an extension cannot turn an unknown capability failure into Operation success: %s",
  async (execute) => {
    const harness = await createManagedReviewHarness({
      managedDecoder: "() => { throw new Error('PRIVATE_CODEC_DETAIL'); }",
      execute,
    });
    try {
      const started = await harness.start();
      const events = await withManagedFailureGuard(
        harness.events(started.operationId),
        "Unknown capability failure did not settle",
      );
      expect(events.at(-1)?.event).toMatchObject({
        type: "operation_failed",
        error: {
          code: "operation_capability_execution_failed",
          message: "The managed review capability failed.",
        },
      });
    } finally {
      await harness.close();
    }
  },
);

test("expired review cleanup remains explicit inspection with partial evidence and holds its reservation", async () => {
  const clock = new ReviewClock();
  const provider = streamingReviewModel();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harness = await createManagedReviewHarness({
    clock,
    model: provider.model,
    reviewPolicy: { version: 1, totalMilliseconds: 120_000 },
    settlementBarrier: async () => {
      reached.resolve();
      await release.promise;
    },
  });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    await provider.text("retained incomplete evidence");
    clock.advance(120_000);
    await withManagedFailureGuard(reached.promise, "Expired review did not reach cleanup");
    clock.advance(10_000);
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Cleanup expiry did not become inspection",
    );
    expect(events.at(-1)?.event.type).toBe("operation_inspection_required");
    expect(await harness.host.operations.query(started.operationId)).toMatchObject({
      status: "inspection_required",
      managedReview: {
        progress: { phase: "settling" },
        failure: {
          error: { code: "recovery_required" },
          partial: { summary: "retained incomplete evidence" },
        },
      },
    });
    expect(
      (await harness.control().inspect({ parentSessionId: "00000000-0000-4000-8000-000000000001" }))
        .storage?.reservedTerminalBytes,
    ).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await harness.close();
  }
});
