import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPresentationSession,
  type SessionRecord,
  type SessionStore,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
  presentationSessionRecordReader,
  type SessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity,
} from "./session-lifecycle.test-support.js";

test.each(["plan_approval_intent", "logical_run_started"] as const)(
  "failed Plan %s retains its diagnostic and committed authority when refresh is unavailable",
  async (failedType) => {
    const root = await mkdtemp(join(tmpdir(), "adam-plan-kickoff-failure-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const backing = createInMemorySessionStoreDirectory<SessionRecord>();
    let failKickoff = false;
    let readsUnavailable = false;
    let failedRecord: SessionRecord | undefined;
    let committedBeforeFailure: readonly SessionRecord[] | undefined;
    const wrap = (store: SessionStore): SessionStore => ({
      async append(record) {
        if (failKickoff && record.schemaVersion === 3 && record.record.type === failedType) {
          failedRecord = record;
          committedBeforeFailure = await store.read();
          readsUnavailable = true;
          throw new Error("PRIVATE_PLAN_STORAGE_CANARY");
        }
        await store.append(record);
      },
      async appendBatch(records) {
        for (const record of records) await this.append(record);
      },
      async read() {
        if (readsUnavailable) throw new Error("PRIVATE_PLAN_READ_CANARY");
        return store.read();
      },
    });
    const directory: SessionStoreDirectory = {
      create: async (id) => wrap(await backing.create(id)),
      open: async (id) => {
        const store = await backing.open(id);
        return store === undefined ? undefined : wrap(store);
      },
      listSessionIds: () => backing.listSessionIds(),
      listSessionEntries: () => backing.listSessionEntries(),
    };
    let modelCalls = 0;
    const modelTargets = modelTargetsWithDriver(
      new FakeModelDriver(() => {
        modelCalls += 1;
        return [
          { type: "tool_call_start", id: "plan-submission", name: "submit_plan" },
          {
            type: "tool_call_delta",
            id: "plan-submission",
            json: JSON.stringify({
              markdown: "# Exact approved plan\n\nImplement the requested change.\n",
            }),
          },
          { type: "tool_call_end", id: "plan-submission" },
          { type: "finish", reason: "tool_calls" },
        ];
      }),
    );
    const harness = createInMemorySessionLifecycleHarness(directory);
    const lifecycle = harness.createLifecycle({ workspaceRoot, stateRoot, modelTargets });
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    try {
      const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
      await lifecycle.enterPlan({ sessionId: created.sessionId });
      const submitted = await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Submit the exact plan." },
      });
      const ready = submitted.snapshot.plan;
      if (ready?.state !== "ready") throw new Error("Expected the actual submitted Plan artifact.");
      presentation = await createPresentationSession({
        lifecycle,
        modelTargets,
        workspaceRoot,
        stateRoot,
        sessionId: created.sessionId,
        projectLabel: "workspace",
        [presentationSessionRecordReader]: async (id) =>
          (await (await directory.open(id))?.read()) ?? [],
      });
      const commandId = "123e4567-e89b-42d3-a456-426614176020";
      failKickoff = true;
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
      ).resolves.toMatchObject({ status: "rejected" });
      if (
        failedRecord?.schemaVersion !== 3 ||
        (failedRecord.record.type !== "logical_run_started" &&
          failedRecord.record.type !== "plan_approval_intent")
      )
        throw new Error("Expected an actual approval or kickoff append attempt.");
      const runId =
        failedRecord.record.type === "logical_run_started"
          ? failedRecord.record.runId
          : failedRecord.record.kickoffRunId;
      const state = presentation.getState();
      expect(state).toMatchObject({
        executionFailure: {
          category: "append_outcome_uncertain",
          phase: failedType === "logical_run_started" ? "user_input" : "session_metadata",
          sessionId: created.sessionId,
          runId,
          attemptedSequence: failedRecord.sequence,
        },
        authoritative: {
          continuity: { status: "degraded" },
          active: { parentRun: { phase: "interrupted", editor: "blocked" } },
        },
      });
      expect(state.authoritative.active?.recovery).toBeUndefined();
      expect(JSON.stringify(state.executionFailure)).not.toContain("PRIVATE_PLAN_");
      const records = await (await backing.open(created.sessionId))?.read();
      expect(records).toEqual(committedBeforeFailure);
      const approvals = records?.filter(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_approval_intent",
      );
      expect(approvals).toHaveLength(failedType === "logical_run_started" ? 1 : 0);
      if (failedType === "logical_run_started")
        expect(approvals?.[0]).toMatchObject({
          record: {
            commandId,
            kickoffRunId: runId,
            planId: ready.submission.planId,
            contentDigest: ready.submission.contentDigest,
          },
        });
      expect(modelCalls).toBe(1);
      readsUnavailable = false;
      const refreshed = await lifecycle.inspect({ sessionId: created.sessionId });
      expect(refreshed).toMatchObject({
        plan: {
          state: failedType === "logical_run_started" ? "approved_not_started" : "ready",
          cycleId: ready.cycleId,
          revision: ready.revision,
          submission: ready.submission,
        },
      });
    } finally {
      readsUnavailable = false;
      await presentation?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
