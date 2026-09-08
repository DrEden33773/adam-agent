import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionPolicy,
  createPresentationSession,
  type ModelDriver,
  type SessionRuntimeNotification,
} from "@adam-agent/agent";
import {
  presentationRuntimeRefreshBarrier,
  presentationSessionRecordReader,
  sessionRuntimeNotificationTransform,
} from "@adam-agent/agent/internal-testing";

type PresentationDisplayState = ReturnType<
  Awaited<ReturnType<typeof createPresentationSession>>["getState"]
>;

import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test.each(["assistant", "reasoning"] as const)(
  "Presentation retains a live %s update behind its durable cursor and admits the next prompt",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "adam-presentation-read-ahead-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    let deliveredBehindCursor = false;
    const model: ModelDriver = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          if (kind === "reasoning") {
            yield {
              type: "reasoning_start",
              id: "provider-reasoning-0",
              artifactType: "provider_reasoning",
            };
            yield { type: "reasoning_delta", id: "provider-reasoning-0", text: "Live reasoning." };
          } else yield { type: "text_delta", text: "Live answer." };
          await finish.promise;
          if (kind === "reasoning") {
            yield { type: "reasoning_end", id: "provider-reasoning-0" };
            yield { type: "text_delta", text: "Live answer." };
          }
        } else yield { type: "text_delta", text: "Next prompt accepted." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const harness = createInMemorySessionLifecycleHarness();
    const modelTargets = modelTargetsWithDriver(model);
    const lifecycle = harness.createLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      [sessionRuntimeNotificationTransform]: {
        project(notification) {
          if (
            !deliveredBehindCursor &&
            notification.event.type ===
              (kind === "assistant" ? "model_message_delta" : "model_reasoning_updated")
          ) {
            deliveredBehindCursor = true;
            return [{ ...notification, throughSequence: notification.throughSequence - 1 }];
          }
          return [notification];
        },
      },
    });
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      [presentationSessionRecordReader]: async (id) =>
        (await (await harness.sessions.open(id))?.read()) ?? [],
    });
    const live = Promise.withResolvers<PresentationDisplayState>();
    const settled = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const state = presentation.getState();
      if (
        deliveredBehindCursor &&
        (kind === "assistant"
          ? state.transient?.assistant?.text === "Live answer."
          : state.transient?.reasoning?.text === "Live reasoning.")
      )
        live.resolve(state);
      if (state.authoritative.active?.session.status === "settled" && state.transient === null)
        settled.resolve();
    });
    try {
      expect(
        await presentation.dispatch({
          type: "submit_prompt",
          sessionId: created.sessionId,
          text: "Keep live output visible.",
          skills: [],
          thinkingSelection: null,
        }),
      ).toMatchObject({ status: "admitted" });
      const observed = await withManagedFailureGuard(
        live.promise,
        "live update after durable read-ahead",
      );
      expect(observed.authoritative.continuity).toMatchObject({ status: "current" });
      expect(
        kind === "assistant"
          ? observed.transient?.assistant?.text
          : observed.transient?.reasoning?.text,
      ).toBe(kind === "assistant" ? "Live answer." : "Live reasoning.");
      finish.resolve();
      await withManagedFailureGuard(settled.promise, "settled current Presentation");
      expect(
        await presentation.dispatch({
          type: "submit_prompt",
          sessionId: created.sessionId,
          text: "Continue after read-ahead.",
          skills: [],
          thinkingSelection: null,
        }),
      ).toMatchObject({ status: "admitted" });
    } finally {
      finish.resolve();
      unsubscribe();
      await presentation.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Presentation ignores completed-run tool and assistant notifications after a settled snapshot and admits the next Main prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-presentation-settled-read-ahead-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "Retained first-run evidence.\n");
  const finishNext = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      const user = request.messages.findLast((message) => message.role === "user");
      if (user?.role === "user" && user.content === "Next Main prompt.") {
        yield { type: "text_delta", text: "Next Main accepted." };
        await finishNext.promise;
      } else if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text_delta", text: "Completed first-run answer." };
      } else {
        yield { type: "tool_call_start", id: "completed-read", name: "read_file" };
        yield { type: "tool_call_delta", id: "completed-read", json: '{"path":"evidence.txt"}' };
        yield { type: "tool_call_end", id: "completed-read" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets = modelTargetsWithDriver(model);
  const delayed: SessionRuntimeNotification[] = [];
  const readerEntered = Promise.withResolvers<void>();
  const releaseReader = Promise.withResolvers<void>();
  let firstRunId: string | undefined;
  let deliveredSettledFirst = false;
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionRuntimeNotificationTransform]: {
      project(notification) {
        firstRunId ??= notification.runId;
        if (notification.runId === firstRunId) {
          delayed.push(notification);
          if (notification.event.type === "session_settled") deliveredSettledFirst = true;
        }
        return [notification];
      },
    },
  });
  const created = await lifecycle.create({ targetIdentity });
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    workspaceRoot,
    stateRoot,
    projectLabel: "workspace",
    sessionId: created.sessionId,
    [presentationSessionRecordReader]: async (id) =>
      (await (await harness.sessions.open(id))?.read()) ?? [],
    [presentationRuntimeRefreshBarrier]: {
      async beforeRead(notification) {
        if (notification.runId === firstRunId && notification.event.type === "user_message") {
          readerEntered.resolve();
          await releaseReader.promise;
        }
      },
    },
  });
  const settled = Promise.withResolvers<void>();
  const nextLive = Promise.withResolvers<void>();
  let settledSeen = false;
  const resurrected: string[] = [];
  const unsubscribe = presentation.subscribe(() => {
    const state = presentation.getState();
    if (
      deliveredSettledFirst &&
      state.authoritative.active?.session.status === "settled" &&
      state.transient === null
    ) {
      settledSeen = true;
      settled.resolve();
    }
    if (!settledSeen) return;
    if (state.transient?.toolArguments?.callId === "completed-read")
      resurrected.push("tool arguments");
    if (state.transient?.activity === "using_tool") resurrected.push("tool activity");
    if (state.transient?.assistant?.text === "Completed first-run answer.")
      resurrected.push("assistant answer");
    if (state.transient?.assistant?.text === "Next Main accepted.") nextLive.resolve();
  });
  try {
    expect(
      await presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Complete the first run.",
        skills: [],
        thinkingSelection: null,
      }),
    ).toMatchObject({ status: "admitted" });
    await withManagedFailureGuard(
      readerEntered.promise,
      "first runtime reader before durable read-ahead",
    );
    await withManagedFailureGuard(settled.promise, "read-ahead settled snapshot");
    releaseReader.resolve();
    expect(delayed.map((notification) => notification.event.type)).toEqual(
      expect.arrayContaining([
        "model_tool_arguments_started",
        "tool_requested",
        "tool_started",
        "model_message_delta",
      ]),
    );
    expect(
      await presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Next Main prompt.",
        skills: [],
        thinkingSelection: null,
      }),
    ).toMatchObject({ status: "admitted" });
    await withManagedFailureGuard(
      nextLive.promise,
      "live next Main after the completed-run notification queue",
    );
    expect(resurrected).toEqual([]);
    expect(presentation.getState().authoritative.continuity).toMatchObject({ status: "current" });
  } finally {
    releaseReader.resolve();
    finishNext.resolve();
    unsubscribe();
    await presentation.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
