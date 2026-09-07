import { createHash } from "node:crypto";
import { extensionManagedReviewTerminalCodec } from "@adam-agent/extension-api";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import { createManagedReviewHarness } from "./managed-review-test-support.js";

test("large immutable evidence stays separate from the short instruction and a one-MiB decoded result has an exact immutable receipt", async () => {
  const evidence = `EVIDENCE-BEGIN\n${"a".repeat(128 * 1024)}\nEVIDENCE-END`;
  const result = { verdict: "verified", detail: "x".repeat(1_048_576 - 34) };
  const serialized = JSON.stringify(result);
  const harness = await createManagedReviewHarness({
    evidenceText: evidence,
    model: {
      async *stream() {
        yield { type: "text_delta", text: `\n${serialized}\n` };
        yield { type: "usage", inputTokens: 30_000, outputTokens: 100 };
        yield { type: "finish", reason: "stop" };
      },
    },
  });
  try {
    expect(Buffer.byteLength(serialized)).toBe(1_048_576);
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Large review did not settle",
    );
    const outer = events.at(-1)?.event;
    expect(outer?.type).toBe("operation_completed");
    if (
      outer?.type !== "operation_completed" ||
      typeof outer.output !== "object" ||
      outer.output === null
    )
      throw new Error("Missing large review result");
    const decoded = extensionManagedReviewTerminalCodec.decode(
      Reflect.get(outer.output, "terminal"),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.status !== "completed")
      throw new Error("Missing codec-valid success");
    expect(decoded.value.result).toEqual(result);
    expect(decoded.value.receipt.output).toMatchObject({
      byteCount: 1_048_576,
      digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    });
    const stored = await harness.artifactStore.read(decoded.value.receipt.output.digest);
    expect(stored !== undefined && Buffer.from(stored).equals(Buffer.from(serialized))).toBe(true);
    expect(JSON.stringify(harness.requests[0]?.messages)).toContain("EVIDENCE-BEGIN");
    expect(JSON.stringify(harness.requests[0]?.messages)).toContain("EVIDENCE-END");
    expect(harness.requests[0]?.tools).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("a codec-valid result above one MiB is output_invalid with its partial output retained", async () => {
  const harness = await createManagedReviewHarness({
    model: {
      async *stream() {
        yield {
          type: "text_delta",
          text: JSON.stringify({ verdict: "verified", detail: "x".repeat(1_048_576) }),
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
  });
  try {
    const started = await harness.start();
    const events = await withManagedFailureGuard(
      harness.events(started.operationId),
      "Oversized result did not settle",
    );
    expect(events.at(-1)?.event).toMatchObject({
      type: "operation_completed",
      output: {
        terminal: {
          status: "failed",
          error: { code: "output_invalid" },
          partial: { output: { byteCount: 1_048_610 } },
        },
      },
    });
  } finally {
    await harness.close();
  }
});

test.each([
  "request.evidence[0].artifact.byteCount += 1;",
  "request.evidence[0].artifact.id = 'sha256:' + '0'.repeat(64);",
  "request.evidence[0].artifact.provenance.operationId = '00000000-0000-4000-8000-000000000999';",
])(
  "immutable evidence mismatch is invalid_request before reviewer dispatch: %s",
  async (mutation) => {
    const harness = await createManagedReviewHarness({
      execute: `request.evidence = [{ type: "artifact", artifact: { ...artifact, provenance: { ...artifact.provenance } } }]; ${mutation} return { terminal: await capability.review(request) };`,
    });
    try {
      const started = await harness.start();
      const events = await withManagedFailureGuard(
        harness.events(started.operationId),
        "Evidence refusal did not settle",
      );
      expect(events.at(-1)?.event).toMatchObject({
        type: "operation_completed",
        output: { terminal: { status: "failed", error: { code: "invalid_request" } } },
      });
      expect(harness.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  },
);
