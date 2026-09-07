import {
  createPermissionPolicy,
  createPresentationSession,
  type ModelDriver,
  ModelDriverError,
} from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStore,
  createInMemorySessionStoreDirectory,
  createManagedAgentControl,
  createManagedAgentToolRegistry,
  createProjectExecutionDomain,
  managedAgentRecordBarrier,
  managedAgentSettlementBarrier,
  presentationSessionRecordReader,
  type SessionRecord,
  sessionManagedControl,
  sessionRecordCommittedBarrier,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

const parentSessionId = "00000000-0000-4000-8000-000000000001";
const projectId = `sha256:${"d".repeat(64)}` as const;
const targetIdentity = {
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

test("ManagedAgentStore rejects settlement without its exact outcome receipt", async () => {
  const store = createInMemoryManagedAgentControlStore();
  const identity = {
    schemaVersion: 3 as const,
    parentSessionId,
    threadId: "00000000-0000-4000-8000-000000000002",
    turnId: "00000000-0000-4000-8000-000000000003",
    attemptId: "00000000-0000-4000-8000-000000000004",
    childSessionId: "00000000-0000-4000-8000-000000000005",
  };
  await store.append({
    ...identity,
    sequence: 1,
    event: {
      type: "admitted",
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Inspect evidence",
    },
  });
  await expect(
    store.append({
      ...identity,
      sequence: 2,
      event: { type: "settled", outcome: { sequence: 1, digest: `sha256:${"a".repeat(64)}` } },
    }),
  ).rejects.toMatchObject({ code: "managed_agent_log_invalid" });
  expect(await store.read()).toHaveLength(1);
});

test("ManagedAgentControl retains typed failure and bounded partial output with the exact child transcript", async () => {
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: "Partial evidence before provider failure." };
      throw new ModelDriverError("transport", "External fixture disconnected.", {
        cause: undefined,
      });
    },
  };
  const harness = await controlHarness(model);
  const subscription = new AbortController();
  const terminal = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    })) {
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
    }
    throw new Error("Missing failed settlement.");
  })();
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Inspect evidence",
    });
    const thread = await withManagedFailureGuard(terminal, "failed settled receipt");
    expect(thread.turn.outcome).toMatchObject({
      status: "failed",
      summary: "Partial evidence before provider failure.",
      error: { code: "model_request_failed" },
    });
    expect(thread.turn.outcome?.transcript.sequence).toBeGreaterThan(1);
    expect(thread.turn.outcome?.transcript.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  } finally {
    subscription.abort();
    await harness.close();
  }
});

async function controlHarness(model: ModelDriver) {
  const domain = createProjectExecutionDomain({
    lifecycleOwner: {
      async acquire() {
        return { async release() {} };
      },
      async run(operation) {
        return operation();
      },
    },
  });
  const root = await domain.claimRoot({ rootId: "project-runtime" });
  const store = createInMemoryManagedAgentControlStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const options = {
    parentSessionId,
    projectId,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores,
  };
  const control = createManagedAgentControl(options);
  return {
    control,
    options,
    root,
    domain,
    async close() {
      await control.dispatch({ type: "close", parentSessionId });
      await root.release();
      await domain.close();
    },
  };
}

test("ManagedAgentControl refuses admission before writing when its project claim is released", async () => {
  const harness = await controlHarness({
    stream() {
      throw new Error("No provider dispatch is authorized.");
    },
  });
  try {
    await harness.root.release();
    await harness.domain.close();
    expect(
      await harness.control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "Inspect evidence.",
        description: "Inspect evidence",
      }),
    ).toMatchObject({ status: "rejected", code: "runtime_unavailable" });
    expect(await harness.options.store.read()).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("ManagedAgentControl cold outcome recovery settles and completes once without dispatching another provider", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Retained outcome." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const subscription = new AbortController();
  const terminal = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    })) {
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
    }
    throw new Error("Missing outcome.");
  })();
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Inspect evidence",
    });
    const thread = await withManagedFailureGuard(terminal, "original outcome");
    await harness.control.dispatch({ type: "close", parentSessionId });
    const store = createInMemoryManagedAgentControlStore();
    for (const record of await harness.options.store.read()) {
      if (record.event.type === "settled" || record.event.type === "completion") break;
      await store.append(record);
    }
    const cold = createManagedAgentControl({
      ...harness.options,
      store,
      model: {
        stream() {
          throw new Error("Recovery must never replay this provider.");
        },
      },
    });
    expect((await cold.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "settling",
      recovery: "required",
    });
    const command = {
      type: "recover_turn" as const,
      parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
    };
    expect(await cold.dispatch(command)).toMatchObject({ status: "recovered" });
    expect(await cold.dispatch(command)).toMatchObject({ status: "recovered" });
    expect((await store.read()).map((record) => record.event.type)).toEqual([
      "admitted",
      "started",
      "execution_progress",
      "provider_reserved",
      "provider_unknown",
      "outcome",
      "settled",
      "completion",
    ]);
    expect((await cold.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "idle",
      recovery: "none",
    });
    await cold.dispatch({ type: "close", parentSessionId });
  } finally {
    subscription.abort();
    await harness.close();
  }
});

test("ManagedAgentControl refuses continuation through a changed target instead of rebinding the thread", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Frozen target evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const subscription = new AbortController();
  const terminal = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    })) {
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
    }
    throw new Error("Missing frozen thread.");
  })();
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Inspect evidence",
    });
    const thread = await withManagedFailureGuard(terminal, "frozen thread settlement");
    await harness.control.dispatch({ type: "close", parentSessionId });
    const before = await harness.options.store.read();
    const cold = createManagedAgentControl({
      ...harness.options,
      targetIdentity: {
        ...targetIdentity,
        targetId: "deepseek-v4-pro.direct",
        modelId: "deepseek-v4-pro",
      },
    });
    expect(
      await cold.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Continue.",
      }),
    ).toMatchObject({ status: "rejected", code: "action_unavailable" });
    expect(await harness.options.store.read()).toEqual(before);
    await cold.dispatch({ type: "close", parentSessionId });
  } finally {
    subscription.abort();
    await harness.close();
  }
});

test("ManagedAgentControl refuses a historical spawn command without writing either control format", async () => {
  const harness = await controlHarness({
    stream() {
      throw new Error("Legacy control cannot execute.");
    },
  });
  try {
    const command = { type: "spawn_agent", parentSessionId, task: "Legacy request." };
    expect(await harness.control.dispatch(command as never)).toMatchObject({
      status: "rejected",
      code: "action_unavailable",
      message:
        "Historical agent controls are read-only. Start a new current Session to delegate work.",
    });
    expect(await harness.options.store.read()).toEqual([]);
    expect(await harness.options.store.readLegacy()).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("ManagedAgentControl old attempt cleanup preserves cancellation of the immediately admitted next turn", async () => {
  const secondStarted = Promise.withResolvers<void>();
  const secondClosed = Promise.withResolvers<void>();
  let calls = 0;
  const harness = await controlHarness({
    async *stream(request) {
      calls += 1;
      if (calls === 2) {
        secondStarted.resolve();
        try {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          secondClosed.resolve();
        }
        return;
      }
      yield { type: "text_delta", text: "First completed boundary." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const subscription = new AbortController();
  const continuation = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    })) {
      const thread = frame.snapshot.threads[0];
      if (thread?.turn.phase === "idle")
        return harness.control.dispatch({
          type: "next_turn",
          parentSessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
          task: "Next turn.",
        });
    }
    throw new Error("Missing continuation.");
  })();
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "First turn.",
      description: "Inspect evidence",
    });
    expect(await withManagedFailureGuard(continuation, "immediate continuation")).toMatchObject({
      status: "accepted",
    });
    await withManagedFailureGuard(secondStarted.promise, "second provider start");
    await withManagedFailureGuard(
      harness.control.dispatch({ type: "close", parentSessionId }),
      "second turn cancellation settlement",
    );
    await withManagedFailureGuard(secondClosed.promise, "second provider closure");
    expect(
      (await harness.control.inspect({ parentSessionId })).threads[0]?.turn.outcome?.status,
    ).toBe("cancelled");
  } finally {
    subscription.abort();
    await harness.close();
  }
});

test("SessionLifecycle admits and continues a settled v3 child while its automatic title provider is still active", async () => {
  const titleStarted = Promise.withResolvers<void>();
  const titleRelease = Promise.withResolvers<void>();
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        titleStarted.resolve();
        await titleRelease.promise;
      }
      yield {
        type: "text_delta",
        text: request.purpose === "title" ? "Evidence inspection" : "Settled evidence.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    workspaceRoot: process.cwd(),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "external fixture" },
            },
          ],
        };
      },
    },
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionManagedControl]: {
      store: createInMemoryManagedAgentControlStore(),
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  const subscription = new AbortController();
  let title: Promise<unknown> | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect evidence." },
    });
    lifecycle.enableAutomaticTitles();
    title = lifecycle.ensureAutomaticTitle({ sessionId: created.sessionId });
    await withManagedFailureGuard(titleStarted.promise, "automatic title provider start");
    const control = await lifecycle[sessionManagedControl](created.sessionId);
    if (control === undefined) throw new Error("Missing new control composition.");
    const settled = (async () => {
      for await (const frame of control.observe({
        parentSessionId: created.sessionId,
        signal: subscription.signal,
      })) {
        const thread = frame.snapshot.threads[0];
        if (thread?.turn.phase === "idle") return thread;
      }
      throw new Error("Missing settled child.");
    })();
    expect(
      await control.dispatch({
        type: "start_thread",
        parentSessionId: created.sessionId,
        role: "builtin:explore",
        task: "Inspect child evidence.",
        description: "Inspect evidence",
      }),
    ).toMatchObject({ status: "accepted" });
    const thread = await withManagedFailureGuard(settled, "settled child while title is active");
    expect(
      await control.dispatch({
        type: "next_turn",
        parentSessionId: created.sessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Continue child evidence.",
      }),
    ).toMatchObject({ status: "accepted", threadId: thread.threadId });
  } finally {
    titleRelease.resolve();
    subscription.abort();
    await title;
    await lifecycle.close();
  }
});

test("PresentationSession dispatches v3 child controls and observes settlement without refreshing or blocking Main", async () => {
  const driver: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: "Visible child evidence." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            contextProfile,
            readiness: { status: "available" as const, credentialSource: "external fixture" },
          },
        ],
      };
    },
  };
  const lifecycle = harness.createLifecycle({
    workspaceRoot: process.cwd(),
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionManagedControl]: {
      store: createInMemoryManagedAgentControlStore(),
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  const parent = await lifecycle.create({ targetIdentity });
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    workspaceRoot: process.cwd(),
    projectLabel: "Managed control",
    sessionId: parent.sessionId,
    [presentationSessionRecordReader]: async (sessionId) =>
      (await (await harness.sessions.open(sessionId))?.read()) ?? [],
  });
  const settled = Promise.withResolvers<void>();
  const unsubscribe = presentation.subscribe(() => {
    if (presentation.getState().authoritative.managedControl?.threads[0]?.turn.phase === "idle")
      settled.resolve();
  });
  try {
    expect(
      await presentation.dispatch({
        type: "managed_control",
        commandId: "start-child",
        command: {
          type: "start_thread",
          parentSessionId: parent.sessionId,
          role: "builtin:explore",
          task: "Inspect evidence.",
          description: "Visible evidence",
        },
      }),
    ).toMatchObject({ status: "admitted", control: { status: "accepted" } });
    await withManagedFailureGuard(settled.promise, "Presentation settled child frame");
    expect(
      presentation.getState().authoritative.managedControl?.threads[0]?.turn.outcome?.summary,
    ).toBe("Visible child evidence.");
    expect(
      (
        await lifecycle.continue({
          sessionId: parent.sessionId,
          input: { text: "Ordinary Main input." },
        })
      ).result.status,
    ).toBe("completed");
  } finally {
    unsubscribe();
    await presentation.close();
    await lifecycle.close();
  }
});

test("ManagedAgentControl observers register before their initial read and remain independent after one aborts", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Observed evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = harness.control
    .observe({ parentSessionId, signal: firstAbort.signal })
    [Symbol.asyncIterator]();
  const second = harness.control
    .observe({ parentSessionId, signal: secondAbort.signal })
    [Symbol.asyncIterator]();
  try {
    const initialFirst = first.next();
    const initialSecond = second.next();
    const admission = harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Observe.",
      description: "Observed evidence",
    });
    const initial = await initialSecond;
    expect((await initialFirst).value?.type).toBe("snapshot");
    expect(initial.value?.type).toBe("snapshot");
    expect(await admission).toMatchObject({ status: "accepted" });
    firstAbort.abort();
    expect(await first.next()).toMatchObject({ done: true });
    const revisions = [initial.value?.snapshot.revision ?? -1];
    let startupResets = 0;
    await withManagedFailureGuard(
      (async () => {
        while (true) {
          const frame = await second.next();
          if (frame.done) throw new Error("Second subscription ended unexpectedly.");
          if (frame.value.snapshot.revision === revisions.at(-1)) {
            expect(frame.value.type).toBe("reset");
            expect(frame.value.snapshot.threads[0]).toMatchObject({
              residency: "live",
              turn: { phase: "starting", label: "Starting" },
            });
            startupResets += 1;
          } else {
            if (frame.value.type === "reset")
              expect(frame.value.snapshot.threads[0]?.turn.phase).toBe("queued");
            else expect(frame.value.type).toBe("change");
            revisions.push(frame.value.snapshot.revision);
          }
          if (frame.value.snapshot.threads[0]?.turn.phase === "idle") break;
        }
      })(),
      "independent second subscriber settlement",
    );
    expect(startupResets).toBe(1);
    expect(revisions.at(-1)).toBeGreaterThan(revisions[0] ?? -1);
    expect(
      revisions.every(
        (revision, index) => index === 0 || revision === (revisions[index - 1] ?? -1) + 1,
      ),
    ).toBe(true);
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await first.return?.();
    await second.return?.();
    await harness.close();
  }
});

test("ManagedAgentControl resumes a validated pre-provider start only after explicit recovery", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Explicitly resumed evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = createManagedAgentControl({
    ...harness.options,
    [managedAgentRecordBarrier]: async (record) => {
      if (record.event.type === "started") {
        reached.resolve();
        await release.promise;
      }
    },
  });
  const subscription = new AbortController();
  try {
    await original.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Resume this exact task.",
      description: "Resume evidence",
    });
    await withManagedFailureGuard(reached.promise, "pre-provider start barrier");
    const frozen = await harness.options.store.read();
    const admission = frozen[0];
    if (admission === undefined) throw new Error("Missing admission.");
    const childRecords = await (
      await harness.options.childSessionStores.open(admission.childSessionId)
    )?.read();
    if (childRecords === undefined) throw new Error("Missing prepared child.");
    const coldStore = createInMemoryManagedAgentControlStore();
    for (const record of frozen) await coldStore.append(record);
    const childStores = createInMemorySessionStoreDirectory<SessionRecord>();
    const restoredChild = await childStores.create(admission.childSessionId);
    for (const record of childRecords) await restoredChild.append(record);
    release.resolve();
    await original.dispatch({ type: "close", parentSessionId });
    const cold = createManagedAgentControl({
      ...harness.options,
      store: coldStore,
      childSessionStores: childStores,
    });
    expect((await cold.inspect({ parentSessionId })).threads[0]?.turn.recovery).toBe("required");
    expect(await restoredChild.read()).toEqual(childRecords);
    const settled = (async () => {
      for await (const frame of cold.observe({ parentSessionId, signal: subscription.signal })) {
        if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
      }
      throw new Error("Missing resumed turn.");
    })();
    expect(
      await cold.dispatch({
        type: "recover_turn",
        parentSessionId,
        threadId: admission.threadId,
        expectedTurnId: admission.turnId,
      }),
    ).toMatchObject({ status: "accepted", turnId: admission.turnId });
    expect(
      (await withManagedFailureGuard(settled, "resumed pre-provider turn")).turn.outcome?.summary,
    ).toBe("Explicitly resumed evidence.");
    await cold.dispatch({ type: "close", parentSessionId });
  } finally {
    release.resolve();
    subscription.abort();
    await original.dispatch({ type: "close", parentSessionId });
    await harness.close();
  }
});

test("ManagedAgentControl persists causal watchdog identity and retains a stalled partial outcome without per-token control writes", async () => {
  const waiting = Promise.withResolvers<void>();
  const callbacks: (() => void)[] = [];
  const harness = await controlHarness({
    async *stream(request) {
      yield { type: "text_delta", text: "Partial " };
      yield { type: "text_delta", text: "evidence." };
      waiting.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const control = createManagedAgentControl({
    ...harness.options,
    now: () => 1_900_000_000_000,
    inactivityScheduler: {
      schedule(milliseconds, callback) {
        expect(milliseconds).toBe(300_000);
        callbacks.push(callback);
        return { cancel() {} };
      },
    },
  });
  const subscription = new AbortController();
  const terminal = (async () => {
    for await (const frame of control.observe({ parentSessionId, signal: subscription.signal })) {
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
    }
    throw new Error("Missing stalled outcome.");
  })();
  void terminal.catch(() => undefined);
  try {
    await control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Stall evidence",
    });
    await withManagedFailureGuard(waiting.promise, "stream waiting after causal deltas");
    const snapshot = await control.inspect({ parentSessionId });
    expect(snapshot.threads[0]?.turn.watchdog).toMatchObject({
      maximumInactivityMilliseconds: 300_000,
      lastProgressAtUnixMilliseconds: 1_900_000_000_000,
    });
    expect((await harness.options.store.read()).map((record) => record.event.type)).toEqual([
      "admitted",
      "started",
      "execution_progress",
      "provider_reserved",
    ]);
    const expire = callbacks.at(-1);
    if (expire === undefined) throw new Error("Missing executing watchdog.");
    expire();
    expect((await withManagedFailureGuard(terminal, "stalled settlement")).turn).toMatchObject({
      health: "stalled",
      outcome: {
        status: "failed",
        summary: "Partial evidence.",
        error: { code: "managed_agent_stalled" },
      },
    });
  } finally {
    subscription.abort();
    await control.dispatch({ type: "close", parentSessionId });
    await harness.close();
  }
});

test("SessionLifecycle accepts a v3 completion once into canonical Main request history before acknowledging consumption", async () => {
  const driver: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: "Canonical completion evidence." };
      yield { type: "usage", inputTokens: 20, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const controlStore = createInMemoryManagedAgentControlStore();
  const lifecycle = harness.createLifecycle({
    workspaceRoot: process.cwd(),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "external fixture" },
            },
          ],
        };
      },
    },
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    [sessionManagedControl]: {
      store: controlStore,
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  const subscription = new AbortController();
  try {
    const parent = await lifecycle.create({ targetIdentity });
    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("Missing control.");
    const completed = (async () => {
      for await (const frame of control.observe({
        parentSessionId: parent.sessionId,
        signal: subscription.signal,
      })) {
        if (frame.snapshot.threads[0]?.turn.phase === "idle") return;
      }
      throw new Error("Missing child completion.");
    })();
    void completed.catch(() => undefined);
    await control.dispatch({
      type: "start_thread",
      parentSessionId: parent.sessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Completion evidence",
    });
    await withManagedFailureGuard(completed, "completion before Main request");
    expect(
      (
        await lifecycle.continue({
          sessionId: parent.sessionId,
          input: { text: "Use the completed evidence." },
        })
      ).result.status,
    ).toBe("completed");
    expect(
      (
        await lifecycle.continue({
          sessionId: parent.sessionId,
          input: { text: "One further Main request." },
        })
      ).result.status,
    ).toBe("completed");
    const records = await (await harness.sessions.open(parent.sessionId))?.read();
    const deliveries =
      records?.flatMap((record) =>
        record.schemaVersion === 3 && record.record.type === "provider_attempt_started"
          ? (record.record.managedAgentDeliveries ?? [])
          : [],
      ) ?? [];
    expect(deliveries).toHaveLength(1);
    expect(
      (await control.inspect({ parentSessionId: parent.sessionId })).completions[0]?.consumption,
    ).toBe("consumed");
    expect(
      (await controlStore.read()).filter((record) => record.event.type === "consumed"),
    ).toHaveLength(1);
  } finally {
    subscription.abort();
    await lifecycle.close();
  }
});

test("ManagedAgentStore serializes concurrent parent admissions and outcomes in one shared control journal", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const harness = await controlHarness({
    async *stream() {
      if (++calls === 2) started.resolve();
      await release.promise;
      yield { type: "text_delta", text: "Concurrent evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const secondParent = "00000000-0000-4000-8000-000000000099";
  const second = createManagedAgentControl({ ...harness.options, parentSessionId: secondParent });
  const subscription = new AbortController();
  const observeTerminal = async (control: typeof second, parent: string) => {
    for await (const frame of control.observe({
      parentSessionId: parent,
      signal: subscription.signal,
    }))
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return;
    throw new Error("Missing concurrent terminal.");
  };
  const terminals = Promise.all([
    observeTerminal(harness.control, parentSessionId),
    observeTerminal(second, secondParent),
  ]);
  void terminals.catch(() => undefined);
  try {
    const receipts = await Promise.all([
      harness.control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "First parent.",
        description: "First evidence",
      }),
      second.dispatch({
        type: "start_thread",
        parentSessionId: secondParent,
        role: "builtin:explore",
        task: "Second parent.",
        description: "Second evidence",
      }),
    ]);
    expect(receipts.map((receipt) => receipt.status)).toEqual(["accepted", "accepted"]);
    await withManagedFailureGuard(started.promise, "both concurrent providers");
    release.resolve();
    await withManagedFailureGuard(terminals, "both concurrent outcomes");
    const records = await harness.options.store.read();
    expect(records.filter((record) => record.event.type === "outcome")).toHaveLength(2);
  } finally {
    release.resolve();
    subscription.abort();
    await second.dispatch({ type: "close", parentSessionId: secondParent });
    await harness.close();
  }
});

test("ManagedAgentControl keeps a cold thread suspended in later frames after unrelated admission", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Unrelated evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const identity = {
    schemaVersion: 3 as const,
    parentSessionId,
    threadId: "00000000-0000-4000-8000-000000000012",
    turnId: "00000000-0000-4000-8000-000000000013",
    attemptId: "00000000-0000-4000-8000-000000000014",
    childSessionId: "00000000-0000-4000-8000-000000000015",
  };
  await harness.options.store.append({
    ...identity,
    sequence: 1,
    event: {
      type: "admitted",
      role: "builtin:explore",
      task: "Cold task.",
      description: "Cold evidence",
    },
  });
  await harness.options.store.append({ ...identity, sequence: 2, event: { type: "started" } });
  const subscription = new AbortController();
  const frames = harness.control
    .observe({ parentSessionId, signal: subscription.signal })
    [Symbol.asyncIterator]();
  try {
    expect((await frames.next()).value?.snapshot.threads[0]).toMatchObject({
      residency: "unloaded",
      turn: { phase: "waiting", recovery: "required" },
    });
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Unrelated task.",
      description: "Unrelated evidence",
    });
    expect((await frames.next()).value?.snapshot.threads[0]).toMatchObject({
      residency: "unloaded",
      turn: { phase: "waiting", recovery: "required", waitReason: "suspended" },
    });
  } finally {
    subscription.abort();
    await frames.return?.();
    await harness.close();
  }
});

test("ManagedAgentControl refuses consumption from an orphan legacy Main receipt even when completion IDs match", async () => {
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Unconsumed evidence." };
      yield { type: "finish", reason: "stop" };
    },
  });
  const subscription = new AbortController();
  const ready = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    }))
      if (frame.snapshot.completions[0] !== undefined) return frame.snapshot.completions[0];
    throw new Error("Missing pending completion.");
  })();
  void ready.catch(() => undefined);
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Pending evidence",
    });
    const completion = await withManagedFailureGuard(
      ready,
      "pending completion for receipt validation",
    );
    await harness.control.dispatch({ type: "close", parentSessionId });
    const parentStore = createInMemorySessionStore<SessionRecord>();
    const deliveries = [{ id: completion.id, digest: completion.receipt.digest }];
    await parentStore.append({
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "provider_attempt_started",
        runId: "00000000-0000-4000-8000-000000000055",
        turn: 1,
        attempt: 1,
        targetIdentity,
        managedAgentDeliveries: deliveries,
      },
    });
    const cold = createManagedAgentControl({ ...harness.options, parentSessionStore: parentStore });
    expect(
      await cold.dispatch({ type: "acknowledge_main_delivery", parentSessionId, deliveries }),
    ).toMatchObject({ status: "rejected", code: "recovery_required" });
    expect((await cold.inspect({ parentSessionId })).completions[0]?.consumption).toBe("pending");
    await cold.dispatch({ type: "close", parentSessionId });
  } finally {
    subscription.abort();
    await harness.close();
  }
});

test("ManagedAgentControl reports a cleanup deadline and incomplete close while retaining settlement authority", async () => {
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  const closeTimer = Promise.withResolvers<() => void>();
  const callbacks: (() => void)[] = [];
  const harness = await controlHarness({
    async *stream() {
      yield { type: "text_delta", text: "Retain outcome during cleanup." };
      yield { type: "usage", inputTokens: 20, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  const control = createManagedAgentControl({
    ...harness.options,
    cleanupScheduler: {
      schedule(milliseconds, expire) {
        expect(milliseconds).toBe(10_000);
        callbacks.push(expire);
        if (callbacks.length === 2) closeTimer.resolve(expire);
        return { cancel() {} };
      },
    },
    [managedAgentSettlementBarrier]: async () => {
      cleanupEntered.resolve();
      await cleanupRelease.promise;
    },
  });
  const subscription = new AbortController();
  const settled = (async () => {
    for await (const frame of control.observe({ parentSessionId, signal: subscription.signal }))
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return;
    throw new Error("Missing late cleanup settlement.");
  })();
  void settled.catch(() => undefined);
  try {
    await control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Inspect evidence.",
      description: "Cleanup evidence",
    });
    await withManagedFailureGuard(cleanupEntered.promise, "cleanup entry");
    const expire = callbacks[0];
    if (expire === undefined) throw new Error("Missing cleanup deadline.");
    expire();
    expect((await control.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "settling",
      recovery: "required",
      diagnostic: "Cleanup has not settled. Inspect durable state.",
    });
    const closing = control.dispatch({ type: "close", parentSessionId });
    (await withManagedFailureGuard(closeTimer.promise, "bounded close deadline"))();
    expect(await closing).toMatchObject({ status: "rejected", code: "recovery_required" });
    cleanupRelease.resolve();
    await withManagedFailureGuard(settled, "late causal cleanup settlement");
    expect(await control.dispatch({ type: "close", parentSessionId })).toMatchObject({
      status: "closed",
    });
  } finally {
    cleanupRelease.resolve();
    subscription.abort();
    await control.dispatch({ type: "close", parentSessionId });
    await harness.close();
  }
});

test.each(["managed-agent-tools.a1.v1", "managed-agent-tools.a1.v2"] as const)(
  "Historical %s decodes its exact schema and refuses new execution without a manager",
  (profile) => {
    const registry = createManagedAgentToolRegistry({ readOnly: true, profile });
    expect(registry.resolve("spawn_agents")).toBeUndefined();
    expect(registry.resolve("spawn_agent")?.prepare('{"task":"Inspect evidence."}')).toMatchObject({
      status: "failed",
      error: { code: "managed_agent_unavailable" },
    });
    expect(registry.resolve("spawn_agent")?.prepare('{"task":5}')).toMatchObject({
      status: "failed",
      error: { code: "invalid_tool_input" },
    });
  },
);

test("ManagedAgentControl cannot inspect cancel or recover another parent's live turn", async () => {
  const started = Promise.withResolvers<void>();
  const harness = await controlHarness({
    async *stream(request) {
      started.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "finish", reason: "stop" };
    },
  });
  const parent = "00000000-0000-4000-8000-000000000099";
  const second = createManagedAgentControl({ ...harness.options, parentSessionId: parent });
  try {
    const receipt = await second.dispatch({
      type: "start_thread",
      parentSessionId: parent,
      role: "builtin:explore",
      task: "Other parent's work.",
      description: "Other parent",
    });
    if (receipt.status !== "accepted") throw new Error("Missing foreign turn.");
    await withManagedFailureGuard(started.promise, "foreign provider start");
    const before = await harness.options.store.forParent(parent).read();
    for (const type of ["cancel_turn", "recover_turn"] as const)
      expect(
        await harness.control.dispatch({
          type,
          parentSessionId,
          threadId: receipt.threadId,
          expectedTurnId: receipt.turnId,
        }),
      ).toMatchObject({ status: "rejected", code: "stale_revision" });
    await expect(harness.control.inspect({ parentSessionId: parent })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await harness.options.store.forParent(parent).read()).toEqual(before);
  } finally {
    await second.dispatch({ type: "close", parentSessionId: parent });
    await harness.close();
  }
});

test("ManagedAgentControl keeps outcome Settling until cleanup and admits immediate continuation under the live project root", async () => {
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: "Exact child evidence." };
      yield { type: "usage", inputTokens: 20, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const domain = createProjectExecutionDomain({
    lifecycleOwner: {
      async acquire() {
        return { async release() {} };
      },
      async run(operation) {
        return operation();
      },
    },
  });
  const root = await domain.claimRoot({ rootId: "project-runtime" });
  const control = createManagedAgentControl({
    parentSessionId,
    projectId,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store: createInMemoryManagedAgentControlStore(),
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    [managedAgentSettlementBarrier]: async () => {
      cleanupEntered.resolve();
      await cleanupRelease.promise;
    },
  });
  const subscription = new AbortController();
  const frames = control.observe({ parentSessionId, signal: subscription.signal });
  const settled = (async () => {
    for await (const frame of frames) {
      if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
    }
    throw new Error("Missing settled thread.");
  })();
  try {
    const admitted = await control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Find exact evidence.",
      description: "Inspect evidence",
    });
    expect(admitted.status).toBe("accepted");
    await withManagedFailureGuard(cleanupEntered.promise, "outcome cleanup entry");
    const thread = (await control.inspect({ parentSessionId })).threads[0];
    expect(thread).toMatchObject({
      parentSessionId,
      lifecycle: "open",
      handle: "@explore-1",
      displayName: "Explore",
      residency: "live",
      turn: {
        phase: "settling",
        label: "Settling",
        ownerPhase: "releasing",
        health: "healthy",
        waitReason: "none",
        lastOutcome: "completed",
      },
    });
    if (thread === undefined) throw new Error("Missing admitted thread.");
    expect(
      await control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Continue exact evidence.",
      }),
    ).toMatchObject({ status: "rejected", code: "authority_busy" });
    cleanupRelease.resolve();
    const terminal = await withManagedFailureGuard(settled, "settled observation");
    expect(
      await control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: terminal.threadId,
        expectedTurnId: terminal.turn.turnId,
        task: "Continue exact evidence.",
      }),
    ).toMatchObject({ status: "accepted", threadId: terminal.threadId });
  } finally {
    cleanupRelease.resolve();
    subscription.abort();
    await control.dispatch({ type: "close", parentSessionId });
    await root.release();
    await domain.close();
  }
});

test.each(["starting", "executing"] as const)(
  "ManagedAgentControl discards a queued reset already covered by its initial %s snapshot",
  async (phase) => {
    const providerStarted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const harness = await controlHarness({
      async *stream() {
        providerStarted.resolve();
        await finish.promise;
        yield { type: "text_delta", text: "Current observer evidence." };
        yield { type: "finish", reason: "stop" };
      },
    });
    const createReached = Promise.withResolvers<void>();
    const releaseCreate = Promise.withResolvers<void>();
    const children = harness.options.childSessionStores;
    const childSessionStores: typeof children = {
      ...children,
      async create(id) {
        createReached.resolve();
        if (phase === "starting") await releaseCreate.promise;
        return children.create(id);
      },
    };
    const firstRead = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let gate = true;
    const backing = harness.options.store;
    const store: typeof backing = {
      ...backing,
      forParent() {
        return store;
      },
      async read() {
        if (gate) {
          gate = false;
          firstRead.resolve();
          await releaseRead.promise;
        }
        return backing.read();
      },
    };
    const control = createManagedAgentControl({ ...harness.options, store, childSessionStores });
    const abort = new AbortController();
    const iterator = control
      .observe({ parentSessionId, signal: abort.signal })
      [Symbol.asyncIterator]();
    try {
      const initialPending = iterator.next();
      await firstRead.promise;
      expect(
        await control.dispatch({
          type: "start_thread",
          parentSessionId,
          role: "builtin:explore",
          task: "Inspect",
          description: "Snapshot boundary",
        }),
      ).toMatchObject({ status: "accepted" });
      await createReached.promise;
      if (phase === "executing") await providerStarted.promise;
      releaseRead.resolve();
      const initial = await initialPending;
      if (initial.done) throw new Error("Missing initial snapshot");
      expect(initial.value.type).toBe("snapshot");
      expect(initial.value.snapshot.revision).toBe((await backing.read()).length);
      expect(initial.value.snapshot.threads[0]?.turn.phase).toBe(phase);
      const next = iterator.next();
      releaseCreate.resolve();
      finish.resolve();
      await withManagedFailureGuard(
        (async () => {
          let current = await next;
          while (
            !current.done &&
            current.value.snapshot.revision === initial.value.snapshot.revision
          ) {
            expect(current.value.type).toBe("reset");
            expect(current.value.snapshot.threads[0]).toMatchObject({
              residency: "live",
              turn: { phase, label: phase === "starting" ? "Starting" : "Running" },
            });
            current = await iterator.next();
          }
          if (current.done) throw new Error("Missing current change");
          expect(current.value.snapshot.revision).toBe(initial.value.snapshot.revision + 1);
          expect(current.value.type).toBe("change");
        })(),
        "post-snapshot durable change",
      );
    } finally {
      releaseRead.resolve();
      releaseCreate.resolve();
      finish.resolve();
      abort.abort();
      await iterator.return?.();
      await control.dispatch({ type: "close", parentSessionId });
      await harness.close();
    }
  },
);

test("ManagedAgentControl requires recovery after a committed child terminal barrier fails", async () => {
  let providerCalls = 0;
  const harness = await controlHarness({
    async *stream() {
      providerCalls += 1;
      yield { type: "text_delta", text: "Durably completed child evidence." };
      yield { type: "usage", inputTokens: 5, outputTokens: 3 };
      yield { type: "finish", reason: "stop" };
    },
  });
  const original = createManagedAgentControl({
    ...harness.options,
    [sessionRecordCommittedBarrier]: async (record) => {
      if (
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "session_settled"
      )
        throw new Error("Private committed barrier fault.");
    },
  });
  const subscription = new AbortController();
  const stopped = (async () => {
    for await (const frame of original.observe({ parentSessionId, signal: subscription.signal })) {
      const thread = frame.snapshot.threads[0];
      if (thread?.turn.recovery === "required" || thread?.turn.phase === "idle") return thread;
    }
    throw new Error("Missing the stopped child projection.");
  })();
  let cold: ReturnType<typeof createManagedAgentControl> | undefined;
  try {
    await original.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Complete once before the required barrier.",
      description: "Committed barrier evidence",
    });
    const thread = await withManagedFailureGuard(
      stopped,
      "committed child terminal barrier projection",
    );
    expect(thread.turn.recovery).toBe("required");
    expect(thread.turn.outcome).toBeUndefined();
    const records = await harness.options.store.read();
    expect(
      records.some((record) => ["outcome", "settled", "completion"].includes(record.event.type)),
    ).toBe(false);
    const admission = records.find((record) => record.event.type === "admitted");
    if (admission === undefined) throw new Error("Missing exact child admission.");
    const child = await harness.options.childSessionStores.open(admission.childSessionId);
    const durable = await child?.read();
    expect(durable?.at(-1)).toMatchObject({
      record: {
        type: "runtime_event",
        event: {
          type: "session_settled",
          result: { status: "completed", answer: "Durably completed child evidence." },
        },
      },
    });
    await original.dispatch({ type: "close", parentSessionId });
    cold = createManagedAgentControl(harness.options);
    expect(
      await cold.dispatch({
        type: "recover_turn",
        parentSessionId,
        threadId: admission.threadId,
        expectedTurnId: admission.turnId,
      }),
    ).toMatchObject({ status: "recovered" });
    expect((await cold.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "idle",
      outcome: { status: "completed", summary: "Durably completed child evidence." },
    });
    expect(await child?.read()).toEqual(durable);
    expect(providerCalls).toBe(1);
  } finally {
    subscription.abort();
    await original.dispatch({ type: "close", parentSessionId });
    await cold?.dispatch({ type: "close", parentSessionId });
    await harness.close();
  }
});
