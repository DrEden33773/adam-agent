import * as api from "@adam-agent/extension-api";
import { expect, test } from "vitest";

const request = {
  instruction: "Review this evidence.",
  outputContract: { id: "fixture.verdict", version: 1 },
  evidence: [
    {
      type: "artifact",
      artifact: {
        id: `sha256:${"a".repeat(64)}`,
        byteCount: 20,
        mediaType: "text/plain",
        contract: { id: "fixture.evidence", version: 1 },
        provenance: {
          contributionId: "fixture.review",
          extensionId: "fixture.extension",
          extensionVersion: "1.0.0",
          operationId: "00000000-0000-4000-8000-000000000001",
          projectId: `sha256:${"b".repeat(64)}`,
        },
      },
    },
  ],
};

test("managed-review exports exact bounds and rejects extension deadline enlargement", () => {
  expect({
    count: api.EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_COUNT,
    evidence: api.EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_BYTES,
    instruction: api.EXTENSION_MANAGED_REVIEW_MAX_INSTRUCTION_BYTES,
    output: api.EXTENSION_MANAGED_REVIEW_MAX_OUTPUT_BYTES,
    defaultTime: api.EXTENSION_MANAGED_REVIEW_TOTAL_DEFAULT_MS,
    maxTime: api.EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS,
  }).toEqual({
    count: 8,
    evidence: 12_582_912,
    instruction: 16_384,
    output: 1_048_576,
    defaultTime: 1_800_000,
    maxTime: 1_800_000,
  });
  expect(api.extensionManagedReviewRequestCodec.decode(request).ok).toBe(true);
  for (const invalid of [
    { ...request, deadlineMilliseconds: 1_800_001 },
    { ...request, limits: { maximumCumulativeTokens: 1000, deadlineMilliseconds: 1 } },
    { ...request, limits: { maximumCumulativeTokens: 0 } },
    { ...request, instruction: `${"😀".repeat(4096)}a` },
    { ...request, instruction: "\ud800" },
    { ...request, evidence: [] },
    { ...request, evidence: Array.from({ length: 9 }, () => request.evidence[0]) },
    {
      ...request,
      evidence: [0, 1].map(() => ({
        ...request.evidence[0],
        artifact: { ...request.evidence[0]?.artifact, byteCount: 6_291_457 },
      })),
    },
  ])
    expect(api.extensionManagedReviewRequestCodec.decode(invalid).ok).toBe(false);
  expect(
    api.extensionManagedReviewRequestCodec.decode({ ...request, instruction: "😀".repeat(4096) })
      .ok,
  ).toBe(true);
});

test.each([
  "invalid_request",
  "policy_denied",
  "target_unavailable",
  "capacity_expired",
  "model_failed",
  "stalled",
  "budget_exhausted",
  "output_invalid",
  "review_deadline_exceeded",
  "recovery_required",
])("the public terminal codec distinguishes %s", (code) => {
  expect(
    api.extensionManagedReviewTerminalCodec.decode({
      status: "failed",
      error: { code, message: "Review incomplete." },
    }).ok,
  ).toBe(true);
});

test("managed-review codecs fail closed on unknown failure classes and malformed or cyclic JSON", () => {
  expect(
    api.extensionManagedReviewTerminalCodec.decode({
      status: "failed",
      error: { code: "cancelled", message: "Not a review failure." },
    }).ok,
  ).toBe(false);
  const cyclic: { instruction: unknown } = { instruction: null };
  cyclic.instruction = cyclic;
  expect(api.extensionManagedReviewTerminalCodec.decode(cyclic).ok).toBe(false);
  expect(api.extensionManagedReviewRequestCodec.decode({ ...request, limits: undefined }).ok).toBe(
    false,
  );
});

test("public progress carries Host-owned phase and a bounded immutable execution deadline", () => {
  const reviewRunId = "00000000-0000-4000-8000-000000000001";
  for (const phase of ["waiting_for_capacity", "settling", "terminal"])
    expect(api.extensionManagedReviewProgressCodec.decode({ reviewRunId, phase }).ok).toBe(true);
  const running = {
    reviewRunId,
    phase: "running",
    startedAt: "2026-09-07T00:00:00.000Z",
    totalDeadlineAt: "2026-09-07T00:30:00.000Z",
    totalMilliseconds: 1_800_000,
  };
  expect(api.extensionManagedReviewProgressCodec.decode(running).ok).toBe(true);
  expect(
    api.extensionManagedReviewProgressCodec.decode({ ...running, totalMilliseconds: 1_800_001 }).ok,
  ).toBe(false);
  expect(
    api.extensionManagedReviewProgressCodec.decode({
      ...running,
      totalDeadlineAt: "2026-09-07T00:31:00.000Z",
    }).ok,
  ).toBe(false);
  expect(
    api.extensionManagedReviewProgressCodec.decode({
      reviewRunId,
      phase: "waiting_for_capacity",
      position: 1,
    }).ok,
  ).toBe(false);
});
