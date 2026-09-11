import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type ModelDriver,
  type RuntimePhaseDiagnostic,
} from "@adam-agent/agent";
import { expect, test } from "vitest";
import { createProductionProjectRuntime } from "./project-runtime.js";

const identity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;
const contextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8_000,
  estimatorVersion: 1,
} as const;

test("production phase diagnostics distinguish durable delegation from queued child dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-phase-diagnostics-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "Evidence fixture");
  const environment = { XDG_CONFIG_HOME: join(root, "config") };
  const workspaceTrust = createWorkspaceTrust({ workspaceRoot, environment });
  const trust = await workspaceTrust.load();
  if (trust.projectId === null) throw new Error("Missing project identity");
  await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
  const diagnostics: RuntimePhaseDiagnostic[] = [];
  const release = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const running = Promise.withResolvers<void>();
  const allDispatched = Promise.withResolvers<void>();
  const allFollowups = Promise.withResolvers<void>();
  let followupCalls = 0;
  let childCalls = 0;
  let mainCalls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        yield { type: "text_delta", text: "Diagnostic fixture" };
      } else if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        if (++mainCalls === 1) {
          yield { type: "tool_call_start", id: "spawn-diagnostic", name: "spawn_agents" };
          yield {
            type: "tool_call_delta",
            id: "spawn-diagnostic",
            json: JSON.stringify({
              entries: Array.from({ length: 9 }, (_, index) => ({
                role: "builtin:explore",
                task: `PRIVATE TASK ${index}`,
                description: `Child ${index}`,
              })),
            }),
          };
          yield { type: "tool_call_end", id: "spawn-diagnostic" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Main ACK" };
      } else if (
        request.messages.some(
          (message) => message.role === "tool" && message.callId === "child-read",
        )
      ) {
        followupCalls += 1;
        if (followupCalls === 9) allFollowups.resolve();
        yield { type: "text_delta", text: "Child complete" };
      } else {
        childCalls += 1;
        if (childCalls === 8) running.resolve();
        if (childCalls === 9) allDispatched.resolve();
        await (childCalls === 1 ? releaseFirst.promise : release.promise);
        yield { type: "tool_call_start", id: "child-read", name: "read_file" };
        yield { type: "tool_call_delta", id: "child-read", json: '{"path":"evidence.txt"}' };
        yield { type: "tool_call_end", id: "child-read" };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = await createProductionProjectRuntime({
    environment,
    workspaceRoot,
    stateRoot: join(root, "state"),
    workspaceTrust,
    modelTargets: {
      async resolve() {
        return { identity, contextProfile, driver };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity,
              contextProfile,
              readiness: { status: "available", credentialSource: "fixture" },
            },
          ],
        };
      },
    },
    projectLabel: "Diagnostic fixture",
    reservedCommandNames: [],
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    extensionPermissions: createPermissionPolicy({ allowedEffects: [] }),
    preferences: createPresentationPreferences({ environment }),
    onPhaseDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
      throw new Error("An observer cannot affect execution");
    },
  });
  let unsubscribe = () => {};
  try {
    const presentation = await runtime.createPresentation({ openProject: true });
    await presentation.dispatch({ type: "create_session", targetId: identity.targetId });
    const seen = new Set<string>();
    unsubscribe = presentation.subscribe(() => {
      const state = presentation.getState();
      for (const pending of state.authoritative.active?.pendingInteractions ?? []) {
        if (seen.has(pending.requestId)) continue;
        seen.add(pending.requestId);
        void presentation.dispatch({
          type: "decide_permission",
          requestId: pending.requestId,
          decision: "allow",
        });
      }
    });
    expect(
      await presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Inspect nine tasks",
        skills: [],
        thinkingSelection: null,
      }),
    ).toMatchObject({ status: "admitted" });
    await guard(running.promise, "eight actual child dispatches");
    const admitted = diagnostics.filter((d) => d.stage === "delegation_admitted");
    const dispatched = diagnostics.filter((d) => d.stage === "first_child_dispatch");
    expect(admitted).toHaveLength(9);
    expect(dispatched).toHaveLength(8);
    for (const event of dispatched) {
      if (event.stage !== "first_child_dispatch") throw new Error("Wrong phase");
      const admission = admitted.find(
        (d) => d.stage === "delegation_admitted" && d.childSessionId === event.childSessionId,
      );
      expect(admission).toMatchObject({
        sessionId: event.sessionId,
        runId: event.runId,
        callId: "spawn-diagnostic",
        threadId: event.threadId,
        turnId: event.turnId,
        attemptId: event.attemptId,
      });
      expect(event.atMilliseconds).toBeGreaterThanOrEqual(admission?.atMilliseconds ?? Infinity);
    }
    const requested = diagnostics.find(
      (d) => d.stage === "tool_requested" && d.callId === "spawn-diagnostic",
    );
    expect(requested).toBeDefined();
    expect(requested?.runId).not.toBeNull();
    for (const admission of admitted) {
      expect(admission).toMatchObject({
        sessionId: requested?.sessionId,
        runId: requested?.runId,
        callId: "spawn-diagnostic",
      });
      expect(admission.atMilliseconds).toBeGreaterThanOrEqual(
        requested?.atMilliseconds ?? Infinity,
      );
    }
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE TASK");
    // Free one actual slot before observing queued dispatch; the remaining children still
    // hold theirs. Concurrent settlement of all eight is not this diagnostic boundary.
    releaseFirst.resolve();
    await guard(allDispatched.promise, "queued child dispatch");
    release.resolve();
    await guard(allFollowups.promise, "nine child tool followups");
    const childToolEvents = diagnostics.filter(
      (d) => d.stage === "tool_requested" && d.callId === "child-read",
    );
    expect(childToolEvents).toHaveLength(9);
    expect(new Set(childToolEvents.map((d) => d.sessionId)).size).toBe(9);
    expect(
      childToolEvents.every((d) => d.runId !== null && d.sessionId !== admitted[0]?.sessionId),
    ).toBe(true);
    expect(diagnostics.filter((d) => d.stage === "first_child_dispatch")).toHaveLength(9);
  } finally {
    unsubscribe();
    releaseFirst.resolve();
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function guard<T>(operation: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Missing diagnostic boundary: ${phase}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
