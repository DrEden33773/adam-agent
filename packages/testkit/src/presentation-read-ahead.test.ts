import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionPolicy,
  createPresentationSession,
  type ModelDriver,
  ModelDriverError,
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

test.each([false, true])(
  "Presentation consumes the matching transient at durable handoff and retains equal text from distinct responses (read ahead: %s)",
  async (readAhead) => {
    const root = await mkdtemp(join(tmpdir(), "adam-presentation-handoff-"));
    const releaseSecond = Promise.withResolvers<void>();
    const firstDurable = Promise.withResolvers<PresentationDisplayState>();
    const settled = Promise.withResolvers<PresentationDisplayState>();
    const secondEntered = Promise.withResolvers<void>();
    const queueDrained = Promise.withResolvers<void>();
    const duplicates: number[] = [];
    let secondReleased = false;
    let calls = 0;
    const model: ModelDriver = {
      async *stream() {
        if (++calls === 1) {
          yield { type: "text_delta", text: "Identical legitimate answer." };
          yield { type: "tool_call_start", id: "read", name: "read_file" };
          yield { type: "tool_call_delta", id: "read", json: '{"path":"evidence.txt"}' };
          yield { type: "tool_call_end", id: "read" };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          secondEntered.resolve();
          await releaseSecond.promise;
          yield { type: "text_delta", text: "Identical legitimate answer." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    await writeFile(join(root, "evidence.txt"), "Evidence.");
    const harness = createInMemorySessionLifecycleHarness();
    const modelTargets = modelTargetsWithDriver(model);
    const lifecycle = harness.createLifecycle({
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      projectLabel: "handoff",
      sessionId: created.sessionId,
      [presentationRuntimeRefreshBarrier]: {
        async beforeRead(notification) {
          if (readAhead && notification.event.type === "user_message") await secondEntered.promise;
          if (notification.event.type === "model_message_completed") queueDrained.resolve();
        },
      },
      [presentationSessionRecordReader]: async (id) =>
        (await (await harness.sessions.open(id))?.read()) ?? [],
    });
    const unsubscribe = presentation.subscribe(() => {
      const state = presentation.getState();
      if (
        !secondReleased &&
        state.transient?.assistant?.text === "Identical legitimate answer." &&
        state.authoritative.active?.transcript.items.some(
          (item) => item.type === "assistant_message",
        )
      )
        duplicates.push(state.revision);
      if (
        state.authoritative.active?.transcript.items.some(
          (item) => item.type === "assistant_message",
        )
      )
        firstDurable.resolve(state);
      if (state.authoritative.active?.session.status === "settled" && state.transient === null)
        settled.resolve(state);
    });
    try {
      expect(
        await presentation.dispatch({
          type: "submit_prompt",
          sessionId: created.sessionId,
          text: "Inspect evidence.",
          skills: [],
          thinkingSelection: null,
        }),
      ).toMatchObject({ status: "admitted" });
      const handoff = await withManagedFailureGuard(
        firstDurable.promise,
        "first durable assistant response",
      );
      expect(handoff.transient?.assistant ?? null).toBeNull();
      await withManagedFailureGuard(
        queueDrained.promise,
        "queued model completion after earlier deltas",
      );
      expect(duplicates).toEqual([]);
      secondReleased = true;
      releaseSecond.resolve();
      const final = await withManagedFailureGuard(
        settled.promise,
        "two distinct equal responses settled",
      );
      const answers = final.authoritative.active?.transcript.items.filter(
        (item) => item.type === "assistant_message",
      );
      expect(answers?.map((item) => item.text)).toEqual([
        "Identical legitimate answer.",
        "Identical legitimate answer.",
      ]);
      expect(new Set(answers?.map((item) => item.id)).size).toBe(2);
      expect(final.transient).toBeNull();
    } finally {
      releaseSecond.resolve();
      unsubscribe();
      await presentation.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["cancel", "failure"] as const)(
  "Presentation does not revive delayed output after %s",
  async (ending) => {
    const root = await mkdtemp(join(tmpdir(), "adam-presentation-terminal-"));
    const finish = Promise.withResolvers<void>();
    const live = Promise.withResolvers<void>();
    const nextLive = Promise.withResolvers<void>();
    let calls = 0;
    const settled = Promise.withResolvers<void>();
    let user: SessionRuntimeNotification | undefined;
    let delta: SessionRuntimeNotification | undefined;
    let replayed = false;
    let terminalSeen = false;
    const revived: number[] = [];
    const model: ModelDriver = {
      async *stream(request) {
        if (++calls > 1) {
          yield { type: "text_delta", text: "Next turn works." };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "text_delta", text: "Do not revive this output." };
        await Promise.race([
          finish.promise,
          new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        if (ending === "failure")
          throw new ModelDriverError("invalid_request", "Fixture provider failure.", {
            cause: undefined,
          });
        yield { type: "finish", reason: "stop" };
      },
    };
    const harness = createInMemorySessionLifecycleHarness();
    const modelTargets = modelTargetsWithDriver(model);
    const lifecycle = harness.createLifecycle({
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      modelTargets,
      [sessionRuntimeNotificationTransform]: {
        project(notification) {
          if (notification.event.type === "user_message") user = notification;
          if (notification.event.type === "model_message_delta") delta = notification;
          if (
            !replayed &&
            (notification.event.type === "session_interrupted" ||
              notification.event.type === "session_settled") &&
            delta !== undefined &&
            user !== undefined
          ) {
            replayed = true;
            return [
              notification,
              { ...delta, notificationId: `${delta.notificationId}:late` },
              { ...user, notificationId: `${user.notificationId}:late` },
            ];
          }
          return [notification];
        },
      },
    });
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      projectLabel: "terminal",
      sessionId: created.sessionId,
      [presentationSessionRecordReader]: async (id) =>
        (await (await harness.sessions.open(id))?.read()) ?? [],
    });
    const unsubscribe = presentation.subscribe(() => {
      const state = presentation.getState();
      if (state.transient?.assistant?.text === "Next turn works.") nextLive.resolve();
      if (state.transient?.assistant?.text === "Do not revive this output.") {
        live.resolve();
        if (terminalSeen) revived.push(state.revision);
      }
      if (
        replayed &&
        state.transient === null &&
        (state.authoritative.active?.session.status === "settled" ||
          state.authoritative.active?.session.status === "interrupted")
      ) {
        terminalSeen = true;
        settled.resolve();
      }
    });
    try {
      expect(
        await presentation.dispatch({
          type: "submit_prompt",
          sessionId: created.sessionId,
          text: "Start bounded output.",
          skills: [],
          thinkingSelection: null,
        }),
      ).toMatchObject({ status: "admitted" });
      await withManagedFailureGuard(live.promise, "live output before terminal event");
      if (ending === "cancel")
        expect(
          await presentation.dispatch({ type: "cancel_run", sessionId: created.sessionId }),
        ).toMatchObject({ status: "admitted" });
      else finish.resolve();
      await withManagedFailureGuard(settled.promise, "terminal presentation state");
      expect(
        await presentation.dispatch({
          type: "submit_prompt",
          sessionId: created.sessionId,
          text: "Continue after terminal.",
          skills: [],
          thinkingSelection: null,
        }),
      ).toMatchObject({ status: "admitted" });
      await withManagedFailureGuard(nextLive.promise, "next live turn after late notifications");
      expect(replayed).toBe(true);
      expect(revived).toEqual([]);
      expect(presentation.getState().transient?.assistant?.text).not.toBe(
        "Do not revive this output.",
      );
    } finally {
      finish.resolve();
      unsubscribe();
      await presentation.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
