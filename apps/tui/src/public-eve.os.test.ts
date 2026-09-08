import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileArtifactStore } from "@adam-agent/agent";
import { expect, test, vi } from "vitest";
import {
  awaitEveReceipt,
  createPublicEveFixture,
  EveReviewClock,
  emptyEveCandidates,
  observeEve,
  type PublicEveFixture,
} from "./public-eve.test-support.js";

async function withClockedEve(
  totalMilliseconds: number | undefined,
  run: (h: PublicEveFixture, clock: EveReviewClock) => Promise<void>,
) {
  const clock = new EveReviewClock();
  const date = vi.spyOn(Date, "now").mockImplementation(clock.now);
  try {
    const h = await createPublicEveFixture({
      clock,
      ...(totalMilliseconds === undefined ? {} : { totalMilliseconds }),
    });
    try {
      await run(h, clock);
    } finally {
      await h.close();
    }
  } finally {
    date.mockRestore();
  }
}

test("exact public Eve reviews large Git evidence once, materializes large output and shows independent review truth", async () => {
  const h = await createPublicEveFixture({ largeEvidence: true });
  try {
    const terminal = await h.startTui();
    const phases: string[] = [];
    const unsubscribe = h.presentation.subscribe(() => {
      const phase =
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.managedReview?.progress
          ?.phase;
      if (phase !== undefined && phases.at(-1) !== phase) phases.push(phase);
    });
    terminal.input("/review\r");
    const provider = await h.review();
    await terminal.waitForScreen("Review · Running");
    expect(provider.request.tools ?? []).toEqual([]);
    const messages = JSON.stringify(provider.request.messages);
    expect(messages.match(/Eve Reviewer's single model-review stage/gu)).toHaveLength(1);
    expect(messages.match(/bounded-evidence/gu)?.length).toBeGreaterThanOrEqual(2_000);
    const operation = h.presentation.getState().authoritative.active?.linkedOperations[0];
    if (operation === undefined) throw new Error("Missing real Eve operation");
    const events = await h.operationStore.read(operation.operationId);
    const invoked = events.find(
      (record) => record.event.type === "operation_managed_review_invoked",
    );
    if (invoked?.event.type !== "operation_managed_review_invoked")
      throw new Error("Missing durable review request");
    expect(invoked.event.request.evidence).toHaveLength(1);
    expect(Buffer.byteLength(invoked.event.request.instruction)).toBeLessThan(1_024);
    expect(invoked.event.request.instruction).not.toContain("bounded-evidence");
    const artifactStore = await createFileArtifactStore({ root: join(h.stateRoot, "artifacts") });
    const evidence = invoked.event.request.evidence[0];
    if (evidence?.type !== "artifact") throw new Error("Expected exact published evidence");
    const evidenceText = new TextDecoder().decode(await artifactStore.read(evidence.artifact.id));
    expect(Buffer.byteLength(evidenceText)).toBeGreaterThan(16_384);
    expect(messages.split(JSON.stringify(evidenceText).slice(1, -1))).toHaveLength(2);
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      ruleId: `fixture.rule-${index}`,
      severity: "low",
      title: `Changed value ${index}`,
      explanation: "Bounded finding explanation. ".repeat(220),
      location: { side: "new", path: "value.ts", line: 1 },
      fixGuidance: "Verify the intended value.",
      suggestedTests: "Check the changed export.",
      confidence: 0.5,
    }));
    const output = JSON.stringify({
      kind: "eve-reviewer.model-review-candidates",
      schemaVersion: 1,
      payload: { candidates },
    });
    expect(Buffer.byteLength(output)).toBeGreaterThan(16_384);
    provider.finish(output);
    await terminal.waitForScreen("Review · Terminal");
    await observeEve(
      h.presentation,
      () =>
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.status === "completed",
      "Missing completed public Eve report",
    );
    unsubscribe();
    expect(phases).toEqual(["waiting_for_capacity", "running", "settling", "terminal"]);
    const completed = h.presentation.getState().authoritative.active?.linkedOperations[0];
    expect(completed?.managedReview?.failure).toBeUndefined();
    const controlRecords = await h.controlStore.read();
    const outcome = controlRecords.find((record) => record.event.type === "outcome");
    expect(outcome?.event).toMatchObject({
      type: "outcome",
      status: "completed",
      artifact: {
        byteCount: Buffer.byteLength(output),
        id: `sha256:${createHash("sha256").update(output).digest("hex")}`,
      },
    });
    expect(h.reviews).toHaveLength(1);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toEqual([]);
    const report = completed?.artifacts.find((artifact) => artifact.role === "report")?.reference;
    if (report === undefined || report === null)
      throw new Error("Missing public Eve report artifact");
    const artifacts = createFileArtifactStore({ root: join(h.stateRoot, "artifacts") });
    const bytes = await (await artifacts).read(report.id);
    expect(new TextDecoder().decode(bytes)).toContain("fixture.rule-3");
    await h.restart();
    expect(h.presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      status: "completed",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "report", reference: report }),
      ]),
    });
    expect(h.reviews).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test.each([1_800_000, 120_000])(
  "real public Eve retains an incomplete report when the %i ms execution ceiling expires",
  async (totalMilliseconds) => {
    await withClockedEve(
      totalMilliseconds === 1_800_000 ? undefined : totalMilliseconds,
      async (h, clock) => {
        const terminal = await h.startTui();
        expect(await h.startReview()).toMatchObject({ status: "admitted" });
        const provider = await h.review();
        await terminal.waitForScreen("Review · Running");
        const review =
          h.presentation.getState().authoritative.active?.linkedOperations[0]?.managedReview;
        expect(review?.progress).toMatchObject({ phase: "running", totalMilliseconds });
        provider.text("Partial review observations continue.");
        clock.advance(totalMilliseconds);
        await awaitEveReceipt(provider.aborted, "Missing provider abort receipt");
        await observeEve(
          h.presentation,
          () =>
            h.presentation.getState().authoritative.active?.linkedOperations[0]?.status ===
            "completed",
          "Missing incomplete Eve report after deadline",
        );
        const operation = h.presentation.getState().authoritative.active?.linkedOperations[0];
        expect(operation?.managedReview).toMatchObject({
          progress: { phase: "terminal" },
          failure: { code: "review_deadline_exceeded" },
        });
        await terminal.waitForScreen("review_deadline_exceeded");
        const report = operation?.artifacts.find(
          (artifact) => artifact.role === "report",
        )?.reference;
        if (report === undefined) throw new Error("Missing retained incomplete report");
        const store = await createFileArtifactStore({ root: join(h.stateRoot, "artifacts") });
        const text = new TextDecoder().decode(await store.read(report.id));
        expect(text).toContain("review_deadline_exceeded");
        expect(text).toContain("review incomplete");
        expect(h.reviews).toHaveLength(1);
        await h.restart();
        expect(
          h.presentation.getState().authoritative.active?.linkedOperations[0]?.managedReview
            ?.failure?.code,
        ).toBe("review_deadline_exceeded");
        expect(h.reviews).toHaveLength(1);
      },
    );
  },
);

test("real Eve accepts four queued reviews, rejects the fifth, drains FIFO and expires ordinary waiting time", async () => {
  await withClockedEve(undefined, async (h, clock) => {
    const terminal = await h.startTui();
    terminal.resize(120, 80);
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    const first = await h.review();
    for (let value = 3; value <= 6; value++) {
      await writeFile(join(h.workspaceRoot, "value.ts"), `export const value = ${value};\n`);
      expect(await h.startReview()).toMatchObject({ status: "admitted" });
      await observeEve(
        h.presentation,
        () =>
          h.presentation.getState().authoritative.managedControl?.reviewers?.queued === value - 2,
        "Missing exact admitted reviewer queue count",
      );
      if (value === 3) await terminal.waitForScreen("Review · Waiting for capacity");
    }
    const admitted = (await h.controlStore.read()).filter(
      (record) => record.event.type === "admitted" && record.event.frozen?.review !== undefined,
    );
    expect(admitted).toHaveLength(5);
    await writeFile(join(h.workspaceRoot, "value.ts"), "export const value = 7;\n");
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    await observeEve(
      h.presentation,
      () =>
        h.presentation
          .getState()
          .authoritative.active?.linkedOperations.some(
            (operation) =>
              operation.managedReview?.failure?.code === "capacity_expired" &&
              operation.status === "completed",
          ) === true,
      "Missing reviewer queue overflow report",
    );
    expect(
      (await h.controlStore.read()).filter(
        (record) => record.event.type === "admitted" && record.event.frozen?.review !== undefined,
      ),
    ).toEqual(admitted);
    expect(h.reviews).toHaveLength(1);
    first.finish(emptyEveCandidates);
    const second = await h.review(1);
    expect(JSON.stringify(second.request.messages)).toContain("export const value = 3");
    second.finish(emptyEveCandidates);
    const third = await h.review(2);
    expect(JSON.stringify(third.request.messages)).toContain("export const value = 4");
    await observeEve(
      h.presentation,
      () =>
        h.presentation
          .getState()
          .authoritative.active?.linkedOperations.filter(
            (operation) => operation.status === "completed",
          ).length === 3,
      "Missing settled reviews before queue expiry",
    );
    clock.advance(60_000);
    await observeEve(
      h.presentation,
      () =>
        h.presentation
          .getState()
          .authoritative.active?.linkedOperations.filter(
            (operation) =>
              operation.managedReview?.failure?.code === "capacity_expired" &&
              operation.status === "failed",
          ).length === 2,
      "Missing separate capacity and outer-deadline failures",
    );
    const expired = h.presentation
      .getState()
      .authoritative.active?.linkedOperations.find(
        (operation) =>
          operation.managedReview?.failure?.code === "capacity_expired" &&
          operation.status === "failed",
      );
    expect(expired).toMatchObject({
      status: "failed",
      settlement: { code: "operation_deadline_exceeded" },
    });
    const evidence = expired?.artifacts.find(
      (artifact) => artifact.contract.id === "eve-reviewer.model-review-evidence",
    );
    if (evidence === undefined) throw new Error("Missing retained queue-expiry evidence");
    expect(
      await h.presentation.dispatch({
        type: "read_artifact",
        artifact: evidence.reference,
        range: { offset: 0, maximumBytes: 16 * 1024 },
      }),
    ).toMatchObject({
      status: "admitted",
      resource: { text: expect.stringContaining("export const value = ") },
    });
    expect(h.reviews).toHaveLength(3);
    third.finish(emptyEveCandidates);
    await observeEve(
      h.presentation,
      () =>
        h.presentation
          .getState()
          .authoritative.active?.linkedOperations.every(
            (operation) => operation.status === "completed" || operation.status === "failed",
          ) === true,
      "Missing final review completion",
    );
    expect(h.reviews).toHaveLength(3);
  });
});

test("public Eve cancellation keeps the outer Operation nonterminal until reviewer cleanup settles", async () => {
  const cleanup = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await createPublicEveFixture({
    settlementBarrier: async () => {
      cleanup.resolve();
      await release.promise;
    },
  });
  try {
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    const provider = await h.review();
    const operationId =
      h.presentation.getState().authoritative.active?.linkedOperations[0]?.operationId;
    if (operationId === undefined) throw new Error("Missing real Eve operation");
    const cancellation = h.presentation.dispatch({ type: "cancel_operation", operationId });
    void cancellation.catch(() => undefined);
    await awaitEveReceipt(provider.aborted, "Missing provider abort receipt");
    await awaitEveReceipt(cleanup.promise, "Reviewer did not reach cleanup");
    expect(h.presentation.getState().authoritative.active?.linkedOperations[0]?.status).toBe(
      "cancel_requested",
    );
    expect((await h.operationStore.read(operationId)).at(-1)?.event.type).not.toBe(
      "operation_cancelled",
    );
    release.resolve();
    await awaitEveReceipt(cancellation, "Operation cancellation did not settle");
    await observeEve(
      h.presentation,
      () =>
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.status === "cancelled",
      "Missing cancelled Eve operation",
    );
    expect(
      h.presentation
        .getState()
        .authoritative.active?.linkedOperations[0]?.artifacts.some(
          (artifact) => artifact.role === "report",
        ),
    ).toBe(false);
    expect((await h.controlStore.read()).some((record) => record.event.type === "settled")).toBe(
      true,
    );
    await h.restart();
    expect(h.presentation.getState().authoritative.active?.linkedOperations[0]?.status).toBe(
      "cancelled",
    );
    expect(h.reviews).toHaveLength(1);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("real public Eve preserves inactivity as stalled rather than total expiry", async () => {
  const clock = new EveReviewClock();
  const h = await createPublicEveFixture({ controlClock: clock });
  try {
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    const provider = await h.review();
    await observeEve(
      h.presentation,
      () =>
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.managedReview?.progress
          ?.phase === "running",
      "Missing running reviewer",
    );
    clock.advance(300_000);
    await observeEve(
      h.presentation,
      () =>
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.status === "completed",
      "Missing public Eve stalled outcome",
    );
    await awaitEveReceipt(provider.aborted, "Missing provider abort receipt");
    const operation = h.presentation.getState().authoritative.active?.linkedOperations[0];
    expect(operation?.managedReview?.failure?.code).toBe("stalled");
    const report = operation?.artifacts.find((artifact) => artifact.role === "report")?.reference;
    if (report === undefined) throw new Error("Missing retained inactivity report");
    expect(
      await h.presentation.dispatch({
        type: "read_artifact",
        artifact: report,
        range: { offset: 0, maximumBytes: 16_384 },
      }),
    ).toMatchObject({
      status: "admitted",
      resource: { text: expect.stringContaining("Model review stalled without progress") },
    });
    expect(h.reviews).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("the real Eve reviewer reserved lane coexists with eight background providers and excess queued work", async () => {
  const h = await createPublicEveFixture();
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "public-review-concurrent-children",
        command: {
          type: "spawn_agents",
          parentSessionId: h.sessionId,
          entries: Array.from({ length: 9 }, (_, index) => ({
            role: "builtin:explore",
            task: `Concurrent child evidence ${index}`,
            description: `Evidence ${index}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.child(7);
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    const provider = await h.review();
    await observeEve(
      h.presentation,
      () => h.presentation.getState().authoritative.managedControl?.reviewers?.running === 1,
      "Missing reviewer lane aggregate",
    );
    const control = h.presentation.getState().authoritative.managedControl;
    expect(control?.threads).toHaveLength(9);
    expect(control?.threads.filter((thread) => thread.turn.phase === "queued")).toHaveLength(1);
    expect(h.children).toHaveLength(8);
    provider.finish(emptyEveCandidates);
    await observeEve(
      h.presentation,
      () =>
        h.presentation.getState().authoritative.active?.linkedOperations[0]?.status === "completed",
      "Missing independent review completion",
    );
    expect(h.children).toHaveLength(8);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(9);
    expect(h.presentation.getState().authoritative.managedControl?.completions).toEqual([]);
    h.children[0]?.finish(
      '{"summary":"Evidence verified","status":"completed","evidence":[],"unfinished":[]}',
    );
    await h.child(8);
    expect(h.children).toHaveLength(9);
    expect(h.reviews).toHaveLength(1);
  } finally {
    await h.close();
  }
});
