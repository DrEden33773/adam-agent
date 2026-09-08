import { expect, test } from "vitest";
import type { OperationSnapshot } from "./operation-host.js";
import { projectLinkedOperation } from "./presentation-operation-projection.js";

const reviewRunId = "00000000-0000-4000-8000-000000000002";
const operation: OperationSnapshot = {
  status: "running",
  operationId: "00000000-0000-4000-8000-000000000001",
  contributionId: "fixture.review",
  extensionId: "fixture.extension",
  extensionVersion: "1.0.0",
  origin: {
    invocation: { id: "review", kind: "presentation_command", version: 1 },
    sessionId: "00000000-0000-4000-8000-000000000003",
    sourceSequence: 3,
  },
  presentation: { kind: "descriptor", report: null, title: "Review project changes" },
  progress: "Deterministic analysis complete",
  startedAt: "2026-09-08T00:00:00.000Z",
  deadlineAt: "2026-09-08T00:01:00.000Z",
  throughSequence: 5,
  budget: {
    inputBytes: 100,
    outputBytesRemaining: 1000,
    progressBytesRemaining: 1000,
    progressRecordsRemaining: 10,
  },
};

test("linked operation presentation retains the Host's independent review phases and frozen deadline", () => {
  for (const progress of [
    { reviewRunId, phase: "waiting_for_capacity" },
    {
      reviewRunId,
      phase: "running",
      startedAt: "2026-09-08T00:00:10.000Z",
      totalDeadlineAt: "2026-09-08T00:30:10.000Z",
      totalMilliseconds: 1_800_000,
    },
    { reviewRunId, phase: "settling" },
    { reviewRunId, phase: "terminal" },
  ] as const) {
    const projected = projectLinkedOperation({
      ...operation,
      managedReview: { reviewRunId, requestDigest: `sha256:${"a".repeat(64)}`, progress },
    });
    expect(projected?.display).toMatchObject({
      status: "running",
      progress: { summary: "Deterministic analysis complete" },
      managedReview: { reviewRunId, progress },
    });
    expect(projected?.display).not.toHaveProperty("managedReview.requestDigest");
  }
});

test("a completed outer operation retains the review failure without copying partial model output into display state", () => {
  const projected = projectLinkedOperation({
    ...operation,
    status: "completed",
    output: { retainedReport: true },
    managedReview: {
      reviewRunId,
      requestDigest: `sha256:${"a".repeat(64)}`,
      progress: { reviewRunId, phase: "terminal" },
      failure: {
        status: "failed",
        reviewRunId,
        error: {
          code: "review_deadline_exceeded",
          message:
            "The review exceeded its total execution deadline. Retained evidence is incomplete.",
        },
        partial: {
          summary: "Retained model output",
          traceDigest: `sha256:${"b".repeat(64)}`,
          usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, turns: 1 },
        },
      },
    },
  });
  expect(projected?.display).toMatchObject({
    status: "completed",
    managedReview: {
      progress: { phase: "terminal" },
      failure: {
        code: "review_deadline_exceeded",
        message:
          "The review exceeded its total execution deadline. Retained evidence is incomplete.",
      },
    },
  });
  expect(projected?.display).not.toHaveProperty("managedReview.failure.partial");
});

test("historical operations without managed review records retain their existing display", () => {
  const projected = projectLinkedOperation(operation);
  expect(projected?.display).toMatchObject({
    status: "running",
    progress: { summary: "Deterministic analysis complete" },
  });
  expect(projected?.display).not.toHaveProperty("managedReview");
});
