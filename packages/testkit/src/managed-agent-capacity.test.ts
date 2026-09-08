import { createPermissionPolicy, type ModelDriver } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createManagedAgentControl,
  createProjectExecutionDomain,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

const parentSessionId = "00000000-0000-4000-8000-000000000001";
const secondParentSessionId = "00000000-0000-4000-8000-000000000002";
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
  maximumOutputTokens: 4096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8000,
  estimatorVersion: 1,
} as const;
type Control = ReturnType<typeof createManagedAgentControl>;
type Snapshot = Awaited<ReturnType<Control["inspect"]>>;

function batch(count: number, prefix = "Work", parentId = parentSessionId) {
  return {
    type: "spawn_agents" as const,
    parentSessionId: parentId,
    entries: Array.from({ length: count }, (_, index) => ({
      role: "builtin:explore" as const,
      task: `${prefix} ${index}`,
      description: `${prefix} ${index}`,
    })),
  };
}

function gatedProvider() {
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let changed = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      const message = request.messages.findLast((entry) => entry.role === "user");
      if (message?.role !== "user" || typeof message.content !== "string")
        throw new Error("Missing external provider task.");
      const gate = Promise.withResolvers<void>();
      const abort = () => gate.resolve();
      gates.set(message.content, gate);
      started.push(message.content);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      try {
        await gate.promise;
        yield { type: "text_delta", text: `Completed ${message.content}.` };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
    },
  };
  return {
    model,
    started,
    release(task: string) {
      const gate = gates.get(task);
      if (gate === undefined) throw new Error(`Provider has not started ${task}.`);
      gate.resolve();
    },
    async waitFor(count: number) {
      await withManagedFailureGuard(
        (async () => {
          while (started.length < count) await changed.promise;
        })(),
        `${count} actual provider starts`,
      );
    },
  };
}

async function fixture(model: ModelDriver) {
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
    projectId: `sha256:${"d".repeat(64)}` as const,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores,
    async persistBackgroundCapacity() {},
  };
  const control = createManagedAgentControl(options);
  return {
    control,
    store,
    options,
    async close() {
      await control.dispatch({ type: "close", parentSessionId });
      await root.release();
      await domain.close();
    },
  };
}

async function observeUntil(
  control: Control,
  predicate: (snapshot: Snapshot) => boolean,
  parentId = parentSessionId,
): Promise<Snapshot> {
  const observer = new AbortController();
  try {
    return await withManagedFailureGuard(
      (async () => {
        for await (const frame of control.observe({
          parentSessionId: parentId,
          signal: observer.signal,
        })) {
          if (predicate(frame.snapshot)) return frame.snapshot;
        }
        throw new Error("Managed observation ended before its expected snapshot.");
      })(),
      "managed capacity snapshot",
    );
  } finally {
    observer.abort();
  }
}

function phases(snapshot: Snapshot) {
  return {
    executing: snapshot.threads.filter((thread) => thread.turn.phase === "executing").length,
    queued: snapshot.threads.filter((thread) => thread.turn.phase === "queued").length,
    idle: snapshot.threads.filter((thread) => thread.turn.phase === "idle").length,
  };
}

test("successive batches admit 65 identities with eight running, 57 queued, FIFO release and queued cancellation", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  try {
    for (const command of [batch(32), batch(32, "Tail"), batch(1, "Last")])
      expect(await f.control.dispatch(command)).toMatchObject({ status: "admitted" });
    await provider.waitFor(8);
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 8,
      queued: 57,
      idle: 0,
    });
    expect(provider.started).toEqual(Array.from({ length: 8 }, (_, index) => `Work ${index}`));
    provider.release("Work 0");
    await provider.waitFor(9);
    expect(provider.started.at(-1)).toBe("Work 8");
    const cancelled = (await f.control.inspect({ parentSessionId })).threads[9];
    if (cancelled === undefined) throw new Error("Missing queued identity.");
    expect(
      await f.control.dispatch({
        type: "cancel_turn",
        parentSessionId,
        threadId: cancelled.threadId,
        expectedTurnId: cancelled.turn.turnId,
      }),
    ).toMatchObject({ status: "cancelled" });
    provider.release("Work 1");
    await provider.waitFor(10);
    expect(provider.started.at(-1)).toBe("Work 10");
    expect(provider.started).not.toContain("Work 9");
    const settled = await observeUntil(f.control, (snapshot) => phases(snapshot).idle === 3);
    expect(phases(settled)).toEqual({ executing: 8, queued: 54, idle: 3 });
    expect(settled.threads[9]?.turn.outcome).toMatchObject({ status: "cancelled" });
  } finally {
    await f.close();
  }
});

test("Owner capacity updates release admitted work and decreasing capacity preserves running tasks until slots free", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  try {
    const command = batch(20);
    const envelope = await f.control.prepareDelegation(command);
    expect(envelope).toMatchObject({ version: 3, concurrency: { mode: "owner" } });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    await provider.waitFor(8);
    await f.control.configureBackgroundCapacity({ parentSessionId, running: 12 });
    await provider.waitFor(12);
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 12,
      queued: 8,
      idle: 0,
    });
    const lowered = await f.control.configureBackgroundCapacity({ parentSessionId, running: 2 });
    expect(lowered.policy?.background.running).toBe(2);
    expect(phases(lowered)).toEqual({ executing: 12, queued: 8, idle: 0 });
    for (let index = 0; index < 10; index += 1) provider.release(`Work ${index}`);
    const drained = await observeUntil(f.control, (snapshot) => phases(snapshot).idle === 10);
    expect(phases(drained)).toEqual({ executing: 2, queued: 8, idle: 10 });
    expect(provider.started).toHaveLength(12);
    provider.release("Work 10");
    await provider.waitFor(13);
    expect(provider.started.at(-1)).toBe("Work 12");
    const unlimited = await f.control.configureBackgroundCapacity({
      parentSessionId,
      running: "unlimited",
    });
    expect(unlimited.policy?.background.running).toBe("unlimited");
    await provider.waitFor(20);
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 9,
      queued: 0,
      idle: 11,
    });
    const admission = (await f.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({ envelope });
  } finally {
    await f.close();
  }
});

test("an explicit two-running batch grant remains bounded after Owner capacity becomes unlimited", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  try {
    const command = batch(5);
    const envelope = await f.control.prepareDelegation(command, { running: 2 });
    expect(envelope).toMatchObject({ concurrency: { mode: "limited", running: 2 } });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    await provider.waitFor(2);
    await f.control.configureBackgroundCapacity({ parentSessionId, running: "unlimited" });
    expect(await f.control.dispatch(batch(1, "Independent"))).toMatchObject({ status: "admitted" });
    await provider.waitFor(3);
    expect(provider.started).toEqual(["Work 0", "Work 1", "Independent 0"]);
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 3,
      queued: 3,
      idle: 0,
    });
    provider.release("Work 0");
    await provider.waitFor(4);
    expect(provider.started.at(-1)).toBe("Work 2");
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 3,
      queued: 2,
      idle: 1,
    });
  } finally {
    await f.close();
  }
});

test("ordinary task history exceeds 16 attempts and sixth same-thread turn retains its original grant and cumulative usage", async () => {
  let calls = 0;
  const f = await fixture({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Evidence retained." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(await f.control.dispatch(batch(18))).toMatchObject({ status: "admitted" });
    const history = await observeUntil(f.control, (snapshot) => snapshot.completions.length === 18);
    expect(history.threads).toHaveLength(18);
    expect(history.threads.every((thread) => thread.turn.outcome?.status === "completed")).toBe(
      true,
    );
    expect(calls).toBe(18);
    const command = batch(1, "Continued");
    const envelope = await f.control.prepareDelegation(command, { budgetTokens: 20_000 });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    let snapshot = await observeUntil(f.control, (current) => current.completions.length === 19);
    const original = snapshot.threads.at(-1);
    if (original === undefined) throw new Error("Missing funded thread.");
    for (let turn = 2; turn <= 6; turn += 1) {
      const thread = snapshot.threads.find((entry) => entry.threadId === original.threadId);
      if (thread === undefined) throw new Error("Lost continued identity.");
      expect(
        await f.control.dispatch({
          type: "next_turn",
          parentSessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
          task: `Ordinary user continuation ${turn}`,
        }),
      ).toMatchObject({ status: "accepted" });
      snapshot = await observeUntil(
        f.control,
        (current) => current.completions.length === 18 + turn,
      );
      const continued = snapshot.threads.find((entry) => entry.threadId === original.threadId);
      expect(continued?.turn.outcome).toMatchObject({ status: "completed" });
      expect(continued?.turn.configuration).toEqual(original.turn.configuration);
      expect(continued?.budget).toMatchObject({ ceiling: 20_000, knownUsed: turn * 15 });
    }
    const admissions = (await f.store.read()).filter(
      (record) => record.threadId === original.threadId && record.event.type === "admitted",
    );
    expect(admissions).toHaveLength(6);
    for (const admission of admissions)
      expect(admission.event).toMatchObject({ envelope: { taskBudget: envelope.taskBudget } });
    expect(calls).toBe(24);
    expect(snapshot.budget?.knownUsed).toBe(360);
  } finally {
    await f.close();
  }
});

test("an exhausted explicit task grant still blocks new provider work on an ordinary continuation", async () => {
  let calls = 0;
  const f = await fixture({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Budget consumed." };
      yield { type: "usage", inputTokens: 7000, outputTokens: 0 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const command = batch(1);
    const envelope = await f.control.prepareDelegation(command, { budgetTokens: 7000 });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    const first = await observeUntil(f.control, (snapshot) => snapshot.completions.length === 1);
    const thread = first.threads[0];
    if (thread === undefined) throw new Error("Missing budgeted thread.");
    expect(thread.budget).toMatchObject({ ceiling: 7000, knownUsed: 7000, available: 0 });
    expect(
      await f.control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Continue without a new grant.",
      }),
    ).toMatchObject({ status: "accepted" });
    const stopped = await observeUntil(f.control, (snapshot) => snapshot.completions.length === 2);
    expect(stopped.threads[0]?.turn.outcome).toMatchObject({ status: "failed" });
    expect(stopped.threads[0]?.budget).toMatchObject({
      ceiling: 7000,
      knownUsed: 7000,
      available: 0,
    });
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});

test("two Main sessions sharing one project domain and stores each retain eight independent background slots", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  const second = createManagedAgentControl({
    ...f.options,
    parentSessionId: secondParentSessionId,
  });
  try {
    expect(await f.control.dispatch(batch(9, "First"))).toMatchObject({ status: "admitted" });
    expect(await second.dispatch(batch(9, "Second", secondParentSessionId))).toMatchObject({
      status: "admitted",
    });
    await provider.waitFor(16);
    const before = await second.inspect({ parentSessionId: secondParentSessionId });
    expect(phases(before)).toEqual({ executing: 8, queued: 1, idle: 0 });
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 8,
      queued: 1,
      idle: 0,
    });
    const first = (await f.control.inspect({ parentSessionId })).threads[0];
    if (first === undefined) throw new Error("Missing first Main child.");
    expect(
      await f.control.dispatch({
        type: "cancel_turn",
        parentSessionId,
        threadId: first.threadId,
        expectedTurnId: first.turn.turnId,
      }),
    ).toMatchObject({ status: "cancelled" });
    await provider.waitFor(17);
    expect(provider.started.at(-1)).toBe("First 8");
    expect((await second.inspect({ parentSessionId: secondParentSessionId })).threads).toEqual(
      before.threads,
    );
    expect(provider.started).not.toContain("Second 8");
    provider.release("Second 0");
    await provider.waitFor(18);
    expect(provider.started.at(-1)).toBe("Second 8");
  } finally {
    await second.dispatch({ type: "close", parentSessionId: secondParentSessionId });
    await f.close();
  }
});

test("the reserved foreground lane retains one running and four queued while all eight background slots are occupied", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  const foreground: ReturnType<Control["dispatch"]>[] = [];
  try {
    expect(await f.control.dispatch(batch(9))).toMatchObject({ status: "admitted" });
    await provider.waitFor(8);
    for (let index = 0; index < 5; index += 1)
      foreground.push(
        f.control.dispatch({ ...batch(1, `Foreground ${index}`), mode: "foreground" }),
      );
    const full = await observeUntil(
      f.control,
      (snapshot) => snapshot.threads.length === 14 && phases(snapshot).executing === 9,
    );
    await provider.waitFor(9);
    expect(full.threads.filter((thread) => thread.turn.lane === "reserved")).toHaveLength(5);
    expect(
      full.threads.filter(
        (thread) => thread.turn.lane === "reserved" && thread.turn.phase === "queued",
      ),
    ).toHaveLength(4);
    expect(phases(full)).toEqual({ executing: 9, queued: 5, idle: 0 });
    expect(
      await f.control.dispatch({ ...batch(1, "Reserved overflow"), mode: "foreground" }),
    ).toMatchObject({ status: "rejected", code: "capacity_exhausted" });
    provider.release("Foreground 0 0");
    expect(await foreground[0]).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "completed" } }],
    });
    await provider.waitFor(10);
    expect(provider.started.at(-1)).toBe("Foreground 1 0");
    expect(provider.started).not.toContain("Work 8");
    expect(
      (await f.control.inspect({ parentSessionId })).threads.filter(
        (thread) => thread.turn.lane === "background" && thread.turn.phase === "executing",
      ),
    ).toHaveLength(8);
  } finally {
    await f.close();
    await Promise.all(foreground);
  }
});

test("retained child transcripts consume storage independently of ordinary task counts and reject new admission atomically", async () => {
  let calls = 0;
  const f = await fixture({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "e".repeat(16 * 1024) };
      yield { type: "usage", inputTokens: 20, outputTokens: 4096 };
      yield { type: "finish", reason: "stop" };
    },
  });
  let restored: Control | undefined;
  try {
    expect(await f.control.dispatch(batch(1))).toMatchObject({ status: "admitted" });
    let snapshot = await observeUntil(f.control, (current) => current.completions.length === 1);
    for (let turn = 2; turn <= 3; turn += 1) {
      const thread = snapshot.threads[0];
      if (thread === undefined) throw new Error("Missing retained transcript identity.");
      expect(
        await f.control.dispatch({
          type: "next_turn",
          parentSessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
          task: `Continue retained evidence ${turn}`,
        }),
      ).toMatchObject({ status: "accepted" });
      snapshot = await observeUntil(f.control, (current) => current.completions.length === turn);
      expect(snapshot.threads[0]?.turn.outcome).toMatchObject({ status: "completed" });
    }
    await f.control.dispatch({ type: "close", parentSessionId });
    if (snapshot.policy === undefined) throw new Error("Missing current execution policy.");
    const records = await f.store.read();
    const journalBytes = Buffer.byteLength(
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    const transcripts = await Promise.all(
      [...new Set(records.map((record) => record.childSessionId))].map(async (id) => {
        const store = await f.options.childSessionStores.open(id);
        if (store === undefined) throw new Error("Missing historical child transcript.");
        return store.read();
      }),
    );
    const childBytes = Buffer.byteLength(
      transcripts
        .flat()
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );
    expect(childBytes).toBeGreaterThan(48 * 1024);
    // The journal alone fits beside a fresh 320 KiB terminal reservation.
    expect(journalBytes + 320 * 1024).toBeLessThan(450_000);
    expect(journalBytes + childBytes + 320 * 1024).toBeGreaterThan(450_000);
    restored = createManagedAgentControl({
      ...f.options,
      policy: { ...snapshot.policy, storageBytes: 450_000 },
    });
    const retained = await restored.inspect({ parentSessionId });
    expect(retained.storage).toMatchObject({
      ceiling: 450_000,
      usedBytes: journalBytes + childBytes,
      reservedTerminalBytes: 0,
    });
    expect(retained.threads).toHaveLength(1);
    expect(await restored.dispatch(batch(1, "New task"))).toMatchObject({
      status: "rejected",
      code: "storage_quota_exceeded",
    });
    expect(await f.store.read()).toEqual(records);
    expect(calls).toBe(3);
    expect((await restored.inspect({ parentSessionId })).storage).toEqual(retained.storage);
  } finally {
    await restored?.dispatch({ type: "close", parentSessionId });
    await f.close();
  }
});

test("mutating a policy projection cannot change the Owner's execution capacity", async () => {
  const provider = gatedProvider();
  const f = await fixture(provider.model);
  try {
    const snapshot = await f.control.inspect({ parentSessionId });
    if (snapshot.policy === undefined) throw new Error("Missing policy projection.");
    Object.assign(snapshot.policy.background, { running: "unlimited" });
    const command = batch(9);
    const envelope = await f.control.prepareDelegation(command);
    expect(envelope.policy.background.running).toBe(8);
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    await provider.waitFor(8);
    expect(phases(await f.control.inspect({ parentSessionId }))).toEqual({
      executing: 8,
      queued: 1,
      idle: 0,
    });
  } finally {
    await f.close();
  }
});

test("supplied current envelopes cannot upgrade historical threads and valid continuations retain four slots", async () => {
  const f = await fixture({
    async *stream() {
      yield { type: "text_delta", text: "Historical evidence." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  const legacy = createManagedAgentControl({
    ...f.options,
    policy: {
      version: 2,
      background: { running: 4, queued: 32 },
      reserved: { running: 1, queued: 4 },
      maximumAttempts: 4,
      threadTokens: null,
      batchTokens: null,
      sessionTokens: null,
      storageBytes: 32 * 1024 * 1024,
    },
  });
  const provider = gatedProvider();
  let current: Control | undefined;
  try {
    expect(await legacy.dispatch(batch(5))).toMatchObject({ status: "admitted" });
    const original = await observeUntil(legacy, (snapshot) => snapshot.completions.length === 5);
    await legacy.dispatch({ type: "close", parentSessionId });
    current = createManagedAgentControl({ ...f.options, model: provider.model });
    const before = await f.store.read();
    for (const [index, thread] of original.threads.entries()) {
      const upgraded = await current.prepareDelegation(batch(1, `Upgrade ${index}`));
      expect(
        await current.dispatch({
          type: "next_turn",
          parentSessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
          task: `Upgrade ${index}`,
          envelope: upgraded,
        }),
      ).toMatchObject({ status: "rejected", code: "action_unavailable" });
    }
    expect(await f.store.read()).toEqual(before);
    for (const [index, thread] of original.threads.entries()) {
      const command = {
        type: "next_turn" as const,
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: `Historical continuation ${index}`,
      };
      const envelope = await current.prepareContinuation(command);
      expect(envelope.version).toBe(2);
      expect(await current.dispatch({ ...command, envelope })).toMatchObject({
        status: "accepted",
      });
    }
    await provider.waitFor(4);
    const snapshot = await current.inspect({ parentSessionId });
    expect(phases(snapshot)).toEqual({ executing: 4, queued: 1, idle: 0 });
    expect(snapshot.threads.every((thread) => thread.turn.envelope?.version === 2)).toBe(true);
    const records = await f.store.read();
    const initialTurns = new Set(original.threads.map((thread) => thread.turn.turnId));
    const nextIndex = records.findIndex(
      (record) => record.event.type === "admitted" && !initialTurns.has(record.turnId),
    );
    const nextAdmission = records[nextIndex];
    if (nextAdmission?.event.type !== "admitted")
      throw new Error("Missing historical continuation receipt.");
    const upgraded = await current.prepareDelegation(batch(1, "Invalid restored upgrade"));
    const restored = createInMemoryManagedAgentControlStore();
    for (const record of records.slice(0, nextIndex)) await restored.append(record);
    await expect(
      restored.append({
        ...nextAdmission,
        event: { ...nextAdmission.event, batchId: upgraded.id, envelope: upgraded },
      }),
    ).rejects.toMatchObject({ code: "managed_agent_log_invalid" });
  } finally {
    await current?.dispatch({ type: "close", parentSessionId });
    await legacy.dispatch({ type: "close", parentSessionId });
    await f.close();
  }
});
