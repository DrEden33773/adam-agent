import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionPolicy, createPresentationSession } from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity,
} from "./session-lifecycle.test-support.js";

test("an actual JSONL result-write failure is visible beside the last durable interrupted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-execution-failure-view-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "needle.ts"), "needle\n");
  let modelCalls = 0;
  const driver = new FakeModelDriver(() => {
    modelCalls += 1;
    return [
      { type: "tool_call_start", id: "fault-search", name: "search_repository" },
      { type: "tool_call_delta", id: "fault-search", json: '{"kind":"path","query":"needle"}' },
      { type: "tool_call_end", id: "fault-search" },
      { type: "finish", reason: "tool_calls" },
    ];
  });
  const modelTargets = modelTargetsWithDriver(driver);
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let logPath: string | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    const relativeLog = (await readdir(stateRoot, { recursive: true })).find((path) =>
      path.endsWith(`${created.sessionId}.jsonl`),
    );
    if (relativeLog === undefined) throw new Error("Expected the real session log.");
    logPath = join(stateRoot, relativeLog);
    const before = await (
      await openJsonlSessionStore<SessionRecord>({
        workspaceRoot,
        stateRoot,
        sessionId: created.sessionId,
      })
    ).read();
    const unsubscribeFault = lifecycle.subscribe((event) => {
      if (event.type === "tool_started" && event.callId === "fault-search")
        chmodSync(logPath as string, 0o400);
    });
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot,
      sessionId: created.sessionId,
      projectLabel: "workspace",
    });
    const interrupted = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const state = presentation?.getState();
      if (
        state?.authoritative.active?.parentRun?.phase === "interrupted" &&
        state.transient === null
      )
        interrupted.resolve();
    });
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Search the repository.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await withManagedFailureGuard(
      interrupted.promise,
      "The failed execution did not project its durable interruption.",
    );
    unsubscribe();
    unsubscribeFault();
    const records = await (
      await openJsonlSessionStore<SessionRecord>({
        workspaceRoot,
        stateRoot,
        sessionId: created.sessionId,
      })
    ).read();
    expect(records.slice(0, before.length)).toEqual(before);
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 3,
      record: { type: "runtime_event", event: { type: "tool_started", callId: "fault-search" } },
    });
    expect(modelCalls).toBe(1);
    expect(presentation.getState()).toMatchObject({
      authoritative: {
        active: {
          parentRun: { phase: "interrupted", editor: "blocked" },
          recovery: { canResume: true },
        },
        continuity: { sessionThroughSequence: records.length },
      },
      executionFailure: {
        category: "storage_io_failed",
        stage: "open",
        phase: "tool_result",
        writeOutcome: "not_written",
        sessionId: created.sessionId,
        runId: expect.any(String),
        callId: "fault-search",
        attemptedSequence: records.length + 1,
        message: "Session storage unavailable. The record was not written.",
      },
    });
  } finally {
    if (logPath !== undefined) await chmod(logPath, 0o600);
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
