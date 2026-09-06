import { createExtensionHost, type ModelDriver, ModelDriverError } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createManagedReviewHarness,
  ReviewClock,
  streamingReviewModel,
} from "./managed-review-test-support.js";

test("the thirty-minute total review deadline expires despite continuing causal progress", async () => {
  const clock = new ReviewClock();
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ clock, model: provider.model });
  try {
    const started = await harness.start();
    const terminal = harness.events(started.operationId);
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    for (let minute = 1; minute < 30; minute += 1) {
      clock.advance(60_000);
      await provider.text(`progress-${minute};`);
    }
    clock.advance(60_000);
    const events = await withManagedFailureGuard(terminal, "Total review deadline did not settle");
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: {
        terminal: {
          status: "failed",
          error: { code: "review_deadline_exceeded" },
          partial: { summary: expect.stringContaining("progress-29;") },
        },
      },
    });
    expect(harness.requests).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("queued time is deducted before actual slot start and only the remaining ordinary allowance resumes", async () => {
  const clock = new ReviewClock();
  const firstProvider = streamingReviewModel();
  const secondProvider = streamingReviewModel();
  let calls = 0;
  const harness = await createManagedReviewHarness({
    clock,
    model: {
      async *stream(request) {
        yield* (calls++ === 0 ? firstProvider : secondProvider).model.stream(request);
      },
    },
  });
  const observer = new AbortController();
  try {
    const first = await harness.start("first");
    await withManagedFailureGuard(firstProvider.started, "First reviewer did not start");
    const queued = (async () => {
      for await (const frame of harness.control().observe({
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        signal: observer.signal,
      }))
        if (frame.snapshot.reviewers?.queued === 1) return;
      throw new Error("Missing second queued reviewer");
    })();
    const second = await harness.start("second");
    await withManagedFailureGuard(queued, "Second review was not queued");
    clock.advance(30_000);
    await firstProvider.text('{"verdict":"verified"}');
    firstProvider.finish();
    await withManagedFailureGuard(secondProvider.started, "Reserved lane did not drain");
    expect(await harness.host.operations.query(second.operationId)).toMatchObject({
      managedReview: {
        progress: {
          phase: "running",
          startedAt: "2026-09-07T00:00:30.000Z",
          totalDeadlineAt: "2026-09-07T00:30:30.000Z",
        },
      },
    });
    clock.advance(60_000);
    await secondProvider.text('{"verdict":"verified"}');
    secondProvider.finish();
    const events = await withManagedFailureGuard(
      harness.events(second.operationId),
      "Second reviewer did not settle",
    );
    expect(
      events.find((record) => record.event.type === "operation_managed_wait_started")?.event,
    ).toMatchObject({ remainingDeadlineMilliseconds: 30_000 });
    expect(
      events.find((record) => record.event.type === "operation_managed_wait_settled")?.event,
    ).toMatchObject({
      remainingDeadlineMilliseconds: 30_000,
      deadlineAt: "2026-09-07T00:02:00.000Z",
    });
    expect(events.at(-1)?.event.type).toBe("operation_completed");
    await withManagedFailureGuard(
      harness.events(first.operationId),
      "First reviewer did not settle",
    );
  } finally {
    observer.abort();
    await harness.close();
  }
});

test("inactivity is a distinct stalled result and does not become total-deadline expiry", async () => {
  const clock = new ReviewClock();
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ clock, model: provider.model });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    clock.advance(300_000);
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Inactivity did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: { terminal: { status: "failed", error: { code: "stalled" } } },
    });
  } finally {
    await harness.close();
  }
});

test.each(["model_failed", "output_invalid", "budget_exhausted"] as const)(
  "execution preserves the distinct %s result with settled evidence",
  async (code) => {
    const model: ModelDriver = {
      async *stream() {
        yield { type: "text_delta", text: "partial invalid review output" };
        if (code === "model_failed")
          throw new ModelDriverError("transport", "Fixture provider disconnected.", {
            cause: undefined,
          });
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const harness = await createManagedReviewHarness({
      model,
      ...(code === "budget_exhausted"
        ? {
            execute:
              "return { terminal: await capability.review({ ...request, limits: { maximumCumulativeTokens: 1000 } }) };",
          }
        : {}),
    });
    try {
      const started = await harness.start();
      const events = await withManagedFailureGuard(
        harness.events(started.operationId),
        "Missing execution failure",
      );
      expect(events.at(-1)?.event).toMatchObject({
        type: "operation_completed",
        output: {
          terminal: {
            status: "failed",
            error: { code },
            partial: { traceDigest: expect.stringMatching(/^sha256:/u) },
          },
        },
      });
      expect(harness.requests).toHaveLength(code === "budget_exhausted" ? 0 : 1);
    } finally {
      await harness.close();
    }
  },
);

test("Operation cancellation remains independent of review failure classes", async () => {
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ model: provider.model });
  try {
    const started = await harness.start();
    await withManagedFailureGuard(provider.started, "Reviewer did not start");
    await harness.host.operations.cancel(started.operationId);
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Cancellation did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({ type: "operation_cancelled", reason: "caller" });
    expect(
      events.filter((record) => record.event.type === "operation_managed_review_failed"),
    ).toEqual([]);
    expect(await harness.host.operations.query(started.operationId)).toMatchObject({
      managedReview: { progress: { phase: "terminal" } },
    });
  } finally {
    await harness.close();
  }
});

test("actual review slot acquisition revalidates an origin that became unavailable while queued", async () => {
  const firstProvider = streamingReviewModel();
  let calls = 0;
  const configuration: { originStatus?: "target_unavailable"; model: ModelDriver } = {
    model: {
      async *stream(request) {
        if (calls++ === 0) {
          yield* firstProvider.model.stream(request);
          return;
        }
        yield { type: "text_delta", text: '{"verdict":"verified"}' };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
  };
  const harness = await createManagedReviewHarness(configuration);
  const observer = new AbortController();
  try {
    const first = await harness.start("occupying-target");
    await withManagedFailureGuard(firstProvider.started, "First target did not start");
    const queued = (async () => {
      for await (const frame of harness.control().observe({
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        signal: observer.signal,
      }))
        if (frame.snapshot.reviewers?.queued === 1) return;
      throw new Error("Missing queued target");
    })();
    const second = await harness.start("queued-target");
    await withManagedFailureGuard(queued, "Second target was not queued");
    configuration.originStatus = "target_unavailable";
    await firstProvider.text('{"verdict":"verified"}');
    firstProvider.finish();
    const events = await withManagedFailureGuard(
      harness.events(second.operationId),
      "Target revalidation did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: { terminal: { status: "failed", error: { code: "target_unavailable" } } },
    });
    expect(harness.requests).toHaveLength(1);
    await withManagedFailureGuard(harness.events(first.operationId), "First review did not settle");
  } finally {
    observer.abort();
    await harness.close();
  }
});

test("versioned Owner policy may shorten the total review deadline", async () => {
  const clock = new ReviewClock();
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({
    clock,
    model: provider.model,
    reviewPolicy: { version: 1, totalMilliseconds: 120_000 },
  });
  try {
    const started = await harness.start();
    const terminal = harness.events(started.operationId);
    await withManagedFailureGuard(provider.started, "Shortened reviewer did not start");
    clock.advance(120_000);
    const events = await withManagedFailureGuard(terminal, "Shortened deadline did not settle");
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: { terminal: { status: "failed", error: { code: "review_deadline_exceeded" } } },
    });
    expect(
      events.find((record) => record.event.type === "operation_managed_review_invoked")?.event,
    ).toMatchObject({ totalMilliseconds: 120_000 });
  } finally {
    await harness.close();
  }
});

test.each([0, 1_800_001, Number.NaN])(
  "Owner policy cannot configure a review total of %s",
  (totalMilliseconds) => {
    expect(() =>
      createExtensionHost({
        extensions: [],
        capabilities: [],
        managedReview: {
          policy: { version: 1, totalMilliseconds },
          resolveOrigin: async () => ({ status: "target_unavailable" }),
        },
      }),
    ).toThrow();
  },
);

test("a durably queued reviewer consumes ordinary Operation time and expires without a provider call", async () => {
  const clock = new ReviewClock();
  const provider = streamingReviewModel();
  const harness = await createManagedReviewHarness({ clock, model: provider.model });
  const observer = new AbortController();
  try {
    const first = await harness.start("occupy-reserved-lane");
    await withManagedFailureGuard(provider.started, "Reserved reviewer did not start");
    const queued = (async () => {
      for await (const frame of harness.control().observe({
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        signal: observer.signal,
      })) {
        if (frame.snapshot.reviewers?.queued === 1) return;
      }
      throw new Error("Missing queued reviewer");
    })();
    const second = await harness.start("queued-review");
    await withManagedFailureGuard(queued, "Queued review admission was not observable");
    const terminal = harness.events(second.operationId);
    clock.advance(60_000);
    const events = await withManagedFailureGuard(terminal, "Capacity expiry did not settle");
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_failed",
      error: { code: "operation_deadline_exceeded" },
    });
    expect(await harness.host.operations.query(second.operationId)).toMatchObject({
      managedReview: {
        progress: { phase: "terminal" },
        failure: { error: { code: "capacity_expired" } },
      },
    });
    expect(harness.requests).toHaveLength(1);
    await harness.host.operations.cancel(first.operationId);
    await withManagedFailureGuard(
      harness.events(first.operationId),
      "Occupying reviewer did not cancel",
    );
  } finally {
    observer.abort();
    await harness.close();
  }
});
