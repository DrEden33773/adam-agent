import { createHash } from "node:crypto";
import {
  AgentSession,
  createPermissionPolicy,
  createPresentationSession,
  type ModelDriver,
  type ModelRequest,
} from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStore,
  createInMemorySessionStoreDirectory,
  createManagedAgentControl,
  createManagedAgentControlToolRegistry,
  createProjectExecutionDomain,
  createPromptContextV1,
  managedAgentRequestBoundary,
  managedAgentSettlementBarrier,
  managedControlMainRequestBoundary,
  presentationSessionRecordReader,
  type SessionRecord,
  type SessionStore,
  sessionDurableContext,
  sessionManagedControl,
  sessionToolProfileNames,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

function confirmRequestedEnvelopes(
  owner: Pick<AgentSession, "subscribe" | "decidePermission">,
): () => void {
  return owner.subscribe((event) => {
    if (
      event.type === "tool_permission_requested" &&
      (event.subject.type === "managed_agent_batch" ||
        (event.subject.type === "managed_agent_action" && event.subject.envelope !== undefined))
    )
      owner.decidePermission({ requestId: event.requestId, decision: "allow" });
  });
}
async function runConfirmedParent(
  dependencies: ConstructorParameters<typeof AgentSession>[0],
  input: Parameters<AgentSession["run"]>[0],
) {
  const parent = new AgentSession(dependencies);
  const unsubscribe = confirmRequestedEnvelopes(parent);
  try {
    return await parent.run(input);
  } finally {
    unsubscribe();
  }
}

const parentSessionId = "00000000-0000-4000-8000-000000000001";
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

test("AgentSession atomically spawns four running and twenty-eight queued children while Main completes", async () => {
  const fourStarted = Promise.withResolvers<void>();
  let childCalls = 0;
  const childModel: ModelDriver = {
    async *stream(request) {
      childCalls += 1;
      if (childCalls === 4) fourStarted.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
  const store = createInMemoryManagedAgentControlStore();
  const control = createManagedAgentControl({
    parentSessionId,
    projectId: `sha256:${"d".repeat(64)}`,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model: childModel,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
  });
  const entries = Array.from({ length: 32 }, (_, index) => ({
    role: "builtin:explore",
    task: `Inspect evidence ${index + 1}.`,
    description: `Evidence ${index + 1}`,
  }));
  let mainCalls = 0;
  let receipt: ModelRequest["messages"][number] | undefined;
  const parentDependencies: ConstructorParameters<typeof AgentSession>[0] & {
    [sessionToolProfileNames]: readonly string[];
  } = {
    [sessionToolProfileNames]: ["spawn_agents"],
    contextProfile,
    permissions: createPermissionPolicy({ allowedEffects: ["delegate"] }),
    store: createInMemorySessionStore(),
    tools: createManagedAgentControlToolRegistry({ control, parentSessionId }),
    model: {
      async *stream(request: ModelRequest) {
        if (++mainCalls === 1) {
          yield { type: "tool_call_start", id: "spawn-batch", name: "spawn_agents" };
          yield { type: "tool_call_delta", id: "spawn-batch", json: JSON.stringify({ entries }) };
          yield { type: "tool_call_end", id: "spawn-batch" };
          yield { type: "usage", inputTokens: 30, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        receipt = request.messages.findLast((message) => message.role === "tool");
        yield { type: "text_delta", text: "Main remains available." };
        yield { type: "finish", reason: "stop" };
      },
    },
  };
  const parent = new AgentSession(parentDependencies);
  const confirmation = confirmRequestedEnvelopes(parent);
  try {
    expect(
      await withManagedFailureGuard(
        parent.run({ text: "Inspect these thirty-two items." }),
        "Main batch admission receipt",
      ),
    ).toMatchObject({ status: "completed", answer: "Main remains available." });
    if (receipt?.role === "tool" && receipt.result.status === "failed")
      throw new Error(JSON.stringify(receipt.result.error));
    expect(receipt).toMatchObject({
      role: "tool",
      name: "spawn_agents",
      result: { status: "completed", output: { status: "admitted" } },
    });
    await withManagedFailureGuard(fourStarted.promise, "four actual child provider starts");
    const snapshot = await control.inspect({ parentSessionId });
    expect(snapshot.threads).toHaveLength(32);
    expect(snapshot.threads.filter((thread) => thread.turn.phase === "executing")).toHaveLength(4);
    expect(snapshot.threads.filter((thread) => thread.turn.phase === "queued")).toHaveLength(28);
    expect(snapshot.threads.map((thread) => thread.description)).toEqual(
      entries.map((entry) => entry.description),
    );
    expect(childCalls).toBe(4);
  } finally {
    confirmation();
    await control.dispatch({ type: "close", parentSessionId });
    await root.release();
    await domain.close();
  }
});

test("batch validation is atomic and foreground joins exactly one reserved-lane result", async () => {
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
  let calls = 0;
  const control = createManagedAgentControl({
    parentSessionId,
    projectId: `sha256:${"d".repeat(64)}`,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model: {
      async *stream() {
        calls++;
        yield { type: "text_delta", text: "Evidence found." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
  });
  const entry = {
    role: "builtin:explore" as const,
    task: "Inspect exactly this task.\n保留字节",
    description: "Evidence",
  };
  try {
    expect(
      await control.dispatch({
        type: "spawn_agents",
        parentSessionId,
        mode: "foreground",
        entries: [entry, entry],
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await store.read()).toHaveLength(0);
    const invalid = {
      type: "spawn_agents" as const,
      parentSessionId,
      entries: [entry],
      target: "caller-selected",
    };
    expect(await control.dispatch(invalid)).toMatchObject({ status: "rejected" });
    expect(await store.read()).toHaveLength(0);
    const result = await withManagedFailureGuard(
      control.dispatch({
        type: "spawn_agents",
        parentSessionId,
        mode: "foreground",
        entries: [entry],
      }),
      "foreground settled result",
    );
    expect(result).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "completed", summary: "Evidence found." } }],
    });
    expect(calls).toBe(1);
    const snapshot = await control.inspect({ parentSessionId });
    expect(snapshot.threads[0]?.turn).toMatchObject({ lane: "reserved", phase: "idle" });
    expect(snapshot.completions[0]?.consumption).toBe("pending");
    expect((await store.read())[0]?.event).toMatchObject({
      task: entry.task,
      frozen: { targetIdentity, contextProfile, parentBranchId: parentSessionId },
    });
  } finally {
    await control.dispatch({ type: "close", parentSessionId });
    await root.release();
    await domain.close();
  }
});

test("cold queued admission resumes exact protected context without adopting later parent configuration", async () => {
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
  const children = createInMemorySessionStoreDirectory<SessionRecord>();
  const base = {
    parentSessionId,
    projectId: `sha256:${"d".repeat(64)}` as const,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores: children,
  };
  const first = createManagedAgentControl({
    ...base,
    frozenContext: {
      parentBranchId: parentSessionId,
      parentRequest: "Original selected parent request.",
    },
    model: {
      async *stream(request) {
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      },
    },
  });
  let restarted: ModelRequest | undefined;
  let cold: ReturnType<typeof createManagedAgentControl> | undefined;
  try {
    const admitted = await first.dispatch({
      type: "spawn_agents",
      parentSessionId,
      entries: Array.from({ length: 5 }, (_, i) => ({
        role: "builtin:explore",
        task: `Exact bytes ${i}\n中文`,
        description: `Evidence ${i}`,
      })),
    });
    if (admitted.status !== "admitted") throw new Error("Expected batch admission");
    const queued = admitted.turns[4];
    if (queued === undefined) throw new Error("Missing queued identity");
    await first.dispatch({ type: "close", parentSessionId });
    expect(await children.open(queued.childSessionId)).toBeUndefined();
    cold = createManagedAgentControl({
      ...base,
      frozenContext: {
        parentBranchId: "00000000-0000-4000-8000-000000000002",
        parentRequest: "Later private text must not transfer.",
      },
      model: {
        async *stream(request) {
          restarted = request;
          yield { type: "text_delta", text: "Restored evidence." };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    expect((await cold.inspect({ parentSessionId })).threads[4]?.turn).toMatchObject({
      phase: "waiting",
      waitReason: "suspended",
    });
    expect(
      await cold.dispatch({
        type: "recover_turn",
        parentSessionId,
        threadId: queued.threadId,
        expectedTurnId: queued.turnId,
      }),
    ).toMatchObject({ status: "accepted", turnId: queued.turnId });
    const observer = new AbortController();
    try {
      for await (const frame of cold.observe({ parentSessionId, signal: observer.signal })) {
        if (frame.snapshot.completions.some((entry) => entry.turnId === queued.turnId)) break;
      }
    } finally {
      observer.abort();
    }
    expect(restarted?.messages).toContainEqual({ role: "user", content: "Exact bytes 4\n中文" });
    expect(JSON.stringify(restarted?.messages)).toContain("Original selected parent request.");
    expect(JSON.stringify(restarted?.messages)).not.toContain("Later private text");
  } finally {
    await first.dispatch({ type: "close", parentSessionId });
    await cold?.dispatch({ type: "close", parentSessionId });
    await root.release();
    await domain.close();
  }
});

async function schedulerFixture(
  model: ModelDriver,
  additions: Partial<Parameters<typeof createManagedAgentControl>[0]> = {},
) {
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
  const control = createManagedAgentControl({
    parentSessionId,
    projectId: `sha256:${"d".repeat(64)}`,
    workspaceRoot: process.cwd(),
    targetIdentity,
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    ...additions,
  });
  return {
    control,
    store,
    async close() {
      await control.dispatch({ type: "close", parentSessionId });
      await root.release();
      await domain.close();
    },
  };
}
const batch = (count: number, prefix = "Work") => ({
  type: "spawn_agents" as const,
  parentSessionId,
  entries: Array.from({ length: count }, (_, i) => ({
    role: "builtin:explore" as const,
    task: `${prefix} ${i}`,
    description: `${prefix} ${i}`,
  })),
});
async function observeUntil(
  control: ReturnType<typeof createManagedAgentControl>,
  predicate: (snapshot: Awaited<ReturnType<typeof control.inspect>>) => boolean,
) {
  const observer = new AbortController();
  try {
    await withManagedFailureGuard(
      (async () => {
        for await (const frame of control.observe({ parentSessionId, signal: observer.signal })) {
          if (predicate(frame.snapshot)) return;
        }
      })(),
      "managed scheduler receipt",
    ).catch(async (error) => {
      throw new Error(
        `${String(error)}: ${JSON.stringify(await control.inspect({ parentSessionId }))}`,
      );
    });
  } finally {
    observer.abort();
  }
}

test("lane reservations cap nonterminal admission and preserve FIFO without borrowing the reserved slot", async () => {
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const started: string[] = [];
  let startReceipt = Promise.withResolvers<void>();
  const waitStarted = async (task: string) => {
    while (!started.includes(task)) await startReceipt.promise;
  };
  const f = await schedulerFixture({
    async *stream(request) {
      const task = request.messages.findLast((message) => message.role === "user");
      if (task?.role !== "user" || typeof task.content !== "string")
        throw new Error("No child task");
      const gate = Promise.withResolvers<void>();
      gates.set(task.content, gate);
      started.push(task.content);
      startReceipt.resolve();
      startReceipt = Promise.withResolvers<void>();
      if (request.signal.aborted) gate.resolve();
      else request.signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      yield { type: "text_delta", text: `Done ${task.content}` };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(await f.control.dispatch(batch(32))).toMatchObject({ status: "admitted" });
    expect(await f.control.dispatch(batch(4, "Tail"))).toMatchObject({ status: "admitted" });
    await waitStarted("Work 3");
    const before = await f.store.read();
    expect(await f.control.dispatch(batch(1, "Overflow"))).toMatchObject({
      status: "rejected",
      code: "capacity_exhausted",
    });
    expect(await f.store.read()).toEqual(before);
    const foreground = f.control.dispatch({ ...batch(1, "Foreground"), mode: "foreground" });
    await observeUntil(
      f.control,
      (snapshot) => snapshot.threads.filter((t) => t.turn.phase === "executing").length === 5,
    );
    await waitStarted("Foreground 0");
    expect(started).toEqual(["Work 0", "Work 1", "Work 2", "Work 3", "Foreground 0"]);
    gates.get("Foreground 0")?.resolve();
    expect(await foreground).toMatchObject({ status: "completed" });
    gates.get("Work 0")?.resolve();
    await observeUntil(f.control, (snapshot) => snapshot.threads[4]?.turn.phase === "executing");
    await waitStarted("Work 4");
    expect(started.at(-1)).toBe("Work 4");
    const cancelled = (await f.control.inspect({ parentSessionId })).threads[5];
    if (cancelled === undefined) throw new Error("Missing queued thread");
    expect(
      await f.control.dispatch({
        type: "cancel_turn",
        parentSessionId,
        threadId: cancelled.threadId,
        expectedTurnId: cancelled.turn.turnId,
      }),
    ).toMatchObject({ status: "cancelled" });
    gates.get("Work 1")?.resolve();
    await observeUntil(f.control, (snapshot) => snapshot.threads[6]?.turn.phase === "executing");
    await waitStarted("Work 6");
    expect(started.at(-1)).toBe("Work 6");
    expect(started).not.toContain("Work 5");
  } finally {
    await f.close();
  }
});

test("permission waits retain admission, release running capacity and reacquire before the effect with resumption priority", async () => {
  const release = Promise.withResolvers<void>();
  const f = await schedulerFixture(
    {
      async *stream(request) {
        const task = request.messages.find((message) => message.role === "user");
        if (task?.role !== "user" || typeof task.content !== "string")
          throw new Error("Missing task");
        if (
          task.content === "Ask 0" &&
          !request.messages.some((message) => message.role === "tool")
        ) {
          yield { type: "tool_call_start", id: "read-evidence", name: "read_file" };
          yield { type: "tool_call_delta", id: "read-evidence", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "read-evidence" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (task.content !== "Ask 0") {
          const abort = Promise.withResolvers<void>();
          if (request.signal.aborted) abort.resolve();
          else request.signal.addEventListener("abort", () => abort.resolve(), { once: true });
          await Promise.race([release.promise, abort.promise]);
        }
        yield { type: "text_delta", text: task.content };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }) },
  );
  try {
    const result = await f.control.dispatch(batch(6, "Ask"));
    expect(result.status).toBe("admitted");
    await observeUntil(
      f.control,
      (snapshot) =>
        snapshot.threads[0]?.turn.waitReason === "permission" &&
        snapshot.threads[4]?.turn.phase === "executing",
    );
    const snapshot = await f.control.inspect({ parentSessionId });
    const thread = snapshot.threads[0];
    if (thread?.turn.attention === undefined) throw new Error("Missing exact permission request");
    expect(snapshot.threads.filter((entry) => entry.turn.phase === "executing")).toHaveLength(4);
    const decision = await f.control.dispatch({
      type: "decide_permission",
      parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      requestId: thread.turn.attention.id,
      decision: "allow",
    });
    expect(decision).toMatchObject({ status: "accepted" });
    await observeUntil(f.control, (state) => state.threads[0]?.turn.waitReason === "capacity");
    expect((await f.control.inspect({ parentSessionId })).threads[5]?.turn.phase).toBe("queued");
    release.resolve();
    await observeUntil(f.control, (state) => state.completions.length === 6);
    const resumed = (await f.store.read()).filter(
      (record) => record.event.type === "capacity_acquired",
    );
    expect(resumed[0]?.threadId).toBe(thread.threadId);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("immutable grants share one Session ceiling and unknown provider usage retains capacity until exact settlement", async () => {
  let calls = 0;
  const f = await schedulerFixture(
    {
      async *stream() {
        calls++;
        yield { type: "text_delta", text: "Usage omitted." };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts: 4,
        threadTokens: 6000,
        batchTokens: 6000,
        sessionTokens: 6000,
        storageBytes: 32 * 1024 * 1024,
      },
    },
  );
  try {
    const first = await withManagedFailureGuard(
      f.control.dispatch({ ...batch(1), mode: "foreground" }),
      "first budget settlement",
    ).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          error: String(error),
          records: (await f.store.read()).map((r) => r.event),
          snapshot: await f.control.inspect({ parentSessionId }),
        }),
      );
    });
    expect(first.status).toBe("completed");
    const budget = (await f.control.inspect({ parentSessionId })).budget;
    expect(budget?.knownUsed).toBe(0);
    expect(budget?.unknownReserved).toBeGreaterThan(4096);
    const second = await withManagedFailureGuard(
      f.control.dispatch({ ...batch(1, "Next grant"), mode: "foreground" }),
      "second budget settlement",
    ).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          error: String(error),
          records: (await f.store.read()).map((r) => r.event),
          snapshot: await f.control.inspect({ parentSessionId }),
        }),
      );
    });
    expect(second).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "failed", error: { code: "fleet_budget_exhausted" } } }],
    });
    expect(calls).toBe(1);
    const records = await f.store.read();
    const reservation = records.find((record) => record.event.type === "provider_reserved");
    if (reservation?.event.type !== "provider_reserved")
      throw new Error("Missing exact request reservation");
    expect(
      await f.control.settleUsage({
        requestId: reservation.event.requestId,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 5,
      }),
    ).toBe("settled");
    expect(
      await f.control.settleUsage({
        requestId: reservation.event.requestId,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 5,
      }),
    ).toBe("already_settled");
    expect((await f.control.inspect({ parentSessionId })).budget).toMatchObject({
      knownUsed: 30,
      unknownReserved: 0,
      available: 5970,
    });
    expect(
      await f.control.dispatch({ ...batch(1, "Later grant"), mode: "foreground" }),
    ).toMatchObject({ status: "completed" });
    expect(calls).toBe(2);
    const grants = (await f.store.read())
      .filter((record) => record.event.type === "admitted")
      .map((record) => (record.event.type === "admitted" ? record.event.envelope : undefined));
    expect(new Set(grants.map((grant) => grant?.id)).size).toBe(3);
    expect(
      grants.every(
        (grant) => grant?.sessionTokens === 6000 && grant.origin.kind === "direct_request",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("provider overshoot is durable and blocks further dispatch without counting reasoning twice", async () => {
  let calls = 0;
  const f = await schedulerFixture(
    {
      async *stream() {
        calls++;
        yield { type: "usage", inputTokens: 6000, outputTokens: 100, reasoningTokens: 70 };
        yield { type: "text_delta", text: "Must not be called success." };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts: 4,
        threadTokens: 128000,
        batchTokens: 512000,
        sessionTokens: 2048000,
        storageBytes: 32 * 1024 * 1024,
      },
    },
  );
  try {
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "failed", error: { code: "fleet_estimator_overrun" } } }],
    });
    expect((await f.control.inspect({ parentSessionId })).budget).toMatchObject({
      knownUsed: 6100,
    });
    expect((await f.control.inspect({ parentSessionId })).budget?.overrun).toBeGreaterThan(0);
    expect(
      (await f.control.inspect({ parentSessionId })).threads[0]?.turn.outcome?.usage,
    ).toMatchObject({ inputTokens: 6000, outputTokens: 100, reasoningTokens: 70 });
    expect(
      await f.control.dispatch({ ...batch(1, "After overrun"), mode: "foreground" }),
    ).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "failed", error: { code: "fleet_estimator_overrun" } } }],
    });
    expect(calls).toBe(1);
    expect((await f.store.read()).some((record) => record.event.type === "budget_blocked")).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test("compaction requests reserve and settle through the same Fleet ledger as ordinary requests", async () => {
  const purposes: string[] = [];
  let activeWatchdogs = 0;
  let compactionWasWatched = false;
  const f = await schedulerFixture(
    {
      async *stream(request) {
        purposes.push(request.purpose ?? "ordinary");
        if (request.purpose === "compaction") {
          compactionWasWatched = activeWatchdogs > 0;
          yield {
            type: "text_delta",
            text: JSON.stringify({
              schemaVersion: 1,
              objective: "Inspect delegated evidence.",
              constraints: [],
              progress: [],
              unresolvedQuestions: [],
              failures: [],
              remainingVerification: [],
              nextSafeAction: "Report the evidence.",
            }),
          };
        } else yield { type: "text_delta", text: "Compacted evidence." };
        yield { type: "usage", inputTokens: 100, outputTokens: 50 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      inactivityScheduler: {
        schedule() {
          activeWatchdogs++;
          let cancelled = false;
          return {
            cancel() {
              if (!cancelled) {
                cancelled = true;
                activeWatchdogs--;
              }
            },
          };
        },
      },
      contextProfile: {
        ...contextProfile,
        contextWindowTokens: 32000,
        maximumOutputTokens: 512,
        compactAtTokens: 4000,
        postCompactTargetTokens: 2500,
        retainedTargetTokens: 500,
      },
      frozenContext: {
        parentBranchId: parentSessionId,
        parentRequest: "Selected historical evidence. ".repeat(800),
      },
    },
  );
  try {
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "completed" } }],
    });
    expect(purposes).toContain("compaction");
    expect(compactionWasWatched).toBe(true);
    expect(purposes).toContain("ordinary");
    const reservations = (await f.store.read()).filter(
      (record) => record.event.type === "provider_reserved",
    );
    expect(
      reservations.map((record) =>
        record.event.type === "provider_reserved" ? record.event.purpose : undefined,
      ),
    ).toEqual(purposes);
    expect((await f.control.inspect({ parentSessionId })).budget).toMatchObject({
      knownUsed: 150 * purposes.length,
      outstandingReserved: 0,
      unknownReserved: 0,
    });
  } finally {
    await f.close();
  }
});

test("logical storage admission reserves terminal room and refuses the whole batch before mutation", async () => {
  let calls = 0;
  const f = await schedulerFixture(
    {
      async *stream() {
        calls++;
        yield { type: "text_delta", text: "Small evidence." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts: 4,
        threadTokens: 128000,
        batchTokens: 512000,
        sessionTokens: 2048000,
        storageBytes: 400000,
      },
    },
  );
  try {
    expect(await f.control.dispatch(batch(2))).toMatchObject({
      status: "rejected",
      code: "storage_quota_exceeded",
    });
    expect(await f.store.read()).toHaveLength(0);
    expect(calls).toBe(0);
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
      results: [{ outcome: { status: "completed" } }],
    });
    expect((await f.control.inspect({ parentSessionId })).storage?.reservedTerminalBytes).toBe(0);
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});

test("post receipts distinguish accepted from exact request delivery and reject queued or stale targets", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const f = await schedulerFixture({
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        started.resolve();
        await release.promise;
        yield { type: "tool_call_start", id: "read-next", name: "read_file" };
        yield { type: "tool_call_delta", id: "read-next", json: '{"path":"package.json"}' };
        yield { type: "tool_call_end", id: "read-next" };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Final evidence." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const admission = await f.control.dispatch(batch(1));
    if (admission.status !== "admitted" || admission.turns[0] === undefined)
      throw new Error("No admission");
    const turn = admission.turns[0];
    await started.promise;
    const command = {
      type: "post_agent" as const,
      parentSessionId,
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
      inputId: "00000000-0000-4000-8000-000000000010",
      mode: "cooperative" as const,
      text: "Use this later evidence only now.",
    };
    expect(await f.control.dispatch(command)).toMatchObject({
      status: "input_accepted",
      inputId: command.inputId,
      turnId: turn.turnId,
    });
    expect(await f.control.dispatch(command)).toMatchObject({ status: "input_accepted" });
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
      { id: command.inputId, status: "accepted" },
    ]);
    expect(JSON.stringify(requests)).not.toContain(command.text);
    release.resolve();
    await observeUntil(f.control, (snapshot) => snapshot.completions.length === 1);
    expect(JSON.stringify(requests[1]?.messages)).toContain(command.text);
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
      { id: command.inputId, status: "delivered" },
    ]);
    expect(
      await f.control.dispatch({
        ...command,
        expectedTurnId: "00000000-0000-4000-8000-000000000011",
      }),
    ).toMatchObject({ status: "rejected", code: "stale_revision" });
    expect(
      await f.control.dispatch({ type: "list_agents", parentSessionId, limit: 1 }),
    ).toMatchObject({ status: "listed", threads: [{ threadId: turn.threadId }] });
    expect(
      await f.control.dispatch({
        type: "wait_agents",
        parentSessionId,
        targets: [{ threadId: turn.threadId, expectedTurnId: turn.turnId }],
        mode: "all",
      }),
    ).toMatchObject({ status: "completed", results: [{ turnId: turn.turnId }] });
  } finally {
    release.resolve();
    await f.close();
  }
});

test.each(["cooperative", "interrupt"] as const)(
  "%s input at a finishing provider has an explicit delivery outcome",
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const f = await schedulerFixture({
      async *stream() {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text_delta", text: "Evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    });
    try {
      const admission = await f.control.dispatch(batch(1));
      if (admission.status !== "admitted" || admission.turns[0] === undefined)
        throw new Error("No admission");
      const turn = admission.turns[0];
      await entered.promise;
      expect(
        await f.control.dispatch({
          type: "post_agent",
          parentSessionId,
          threadId: turn.threadId,
          expectedTurnId: turn.turnId,
          inputId: "00000000-0000-4000-8000-000000000012",
          mode,
          text: "Additional evidence.",
        }),
      ).toMatchObject({ status: "input_accepted" });
      release.resolve();
      await observeUntil(f.control, (snapshot) => snapshot.completions.length === 1);
      expect((await f.control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
        {
          status: mode === "interrupt" ? "delivered" : "undelivered",
          ...(mode === "cooperative" ? { reason: "settled" } : {}),
        },
      ]);
      expect(calls).toBe(mode === "interrupt" ? 2 : 1);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test("only an exact parent-input reply resumes the child and cannot answer a permission", async () => {
  let calls = 0;
  const requests: ModelRequest[] = [];
  const f = await schedulerFixture({
    async *stream(request) {
      requests.push(request);
      if (++calls === 1) {
        yield { type: "tool_call_start", id: "question-one", name: "request_parent_input" };
        yield {
          type: "tool_call_delta",
          id: "question-one",
          json: '{"question":"Which evidence matters?"}',
        };
        yield { type: "tool_call_end", id: "question-one" };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Answered evidence." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(await f.control.dispatch(batch(1))).toMatchObject({ status: "admitted" });
    await observeUntil(
      f.control,
      (snapshot) => snapshot.threads[0]?.turn.waitReason === "parent_input",
    );
    const thread = (await f.control.inspect({ parentSessionId })).threads[0];
    if (thread?.turn.attention === undefined) throw new Error("No attention receipt");
    expect(
      await f.control.dispatch({
        type: "decide_permission",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        requestId: thread.turn.attention.id,
        decision: "allow",
      }),
    ).toMatchObject({ status: "rejected" });
    const reply = {
      type: "reply_agent" as const,
      parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      attentionId: thread.turn.attention.id,
      inputId: "00000000-0000-4000-8000-000000000013",
      text: "Inspect repository ownership.",
    };
    expect(await f.control.dispatch({ ...reply, attentionId: "stale" })).toMatchObject({
      status: "rejected",
    });
    expect(await f.control.dispatch(reply)).toMatchObject({
      status: "input_accepted",
      inputId: reply.inputId,
    });
    await observeUntil(f.control, (snapshot) => snapshot.completions.length === 1);
    expect(JSON.stringify(requests[1]?.messages)).toContain(reply.text);
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
      { status: "delivered" },
    ]);
  } finally {
    await f.close();
  }
});

test("settled continuations retain frozen identity, cumulative budget and the four-attempt bound", async () => {
  let calls = 0;
  const f = await schedulerFixture({
    async *stream() {
      calls++;
      yield { type: "text_delta", text: "Evidence." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await f.control.dispatch({ ...batch(1), mode: "foreground" });
    for (let attempt = 2; attempt <= 4; attempt++) {
      const thread = (await f.control.inspect({ parentSessionId })).threads[0];
      if (thread === undefined) throw new Error("No thread");
      expect(
        await f.control.dispatch({
          type: "next_turn",
          parentSessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
          task: `Next evidence ${attempt}`,
        }),
      ).toMatchObject({ status: "accepted" });
      await observeUntil(f.control, (snapshot) => snapshot.completions.length === attempt);
      expect((await f.control.inspect({ parentSessionId })).threads[0]?.turn.configuration).toEqual(
        thread.turn.configuration,
      );
    }
    const thread = (await f.control.inspect({ parentSessionId })).threads[0];
    if (thread === undefined) throw new Error("No thread");
    expect(
      await f.control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Fifth attempt",
      }),
    ).toMatchObject({ status: "rejected", code: "attempt_limit" });
    expect(calls).toBe(4);
    expect((await f.control.inspect({ parentSessionId })).budget?.knownUsed).toBe(60);
  } finally {
    await f.close();
  }
});

test("cancel_agents registers all exact intents atomically before independent settlements", async () => {
  const f = await schedulerFixture({
    async *stream(request) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const receipt = await f.control.dispatch(batch(6));
    if (receipt.status !== "admitted") throw new Error("Missing batch");
    const targets = receipt.turns.map((turn) => ({
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
    }));
    expect(
      await f.control.dispatch({
        type: "cancel_agents",
        parentSessionId,
        targets: [
          ...targets,
          {
            threadId: "00000000-0000-4000-8000-000000000020",
            expectedTurnId: "00000000-0000-4000-8000-000000000021",
          },
        ],
      }),
    ).toMatchObject({ status: "rejected", code: "stale_revision" });
    expect((await f.store.read()).some((record) => record.event.type === "cancel_requested")).toBe(
      false,
    );
    expect(
      await f.control.dispatch({ type: "cancel_agents", parentSessionId, targets }),
    ).toMatchObject({
      status: "completed",
      results: expect.arrayContaining(
        targets.map((target) =>
          expect.objectContaining({
            turnId: target.expectedTurnId,
            outcome: expect.objectContaining({ status: "cancelled" }),
          }),
        ),
      ),
    });
    const events = await f.store.read();
    const cancelPositions = events
      .filter((record) => record.event.type === "cancel_requested")
      .map((record) => record.sequence);
    expect(cancelPositions).toHaveLength(6);
    expect(cancelPositions.at(-1)).toBe((cancelPositions[0] ?? 0) + 5);
    expect(
      (await f.control.inspect({ parentSessionId })).threads.every(
        (thread) => thread.turn.phase === "idle",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("the current Registry joins foreground and wait receipts once in the canonical Main run", async () => {
  const parentStore = createInMemorySessionStore<SessionRecord>();
  const f = await schedulerFixture(
    {
      async *stream() {
        yield { type: "text_delta", text: "Exact foreground evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { parentSessionStore: parentStore },
  );
  const registry = createManagedAgentControlToolRegistry({ control: f.control, parentSessionId });
  try {
    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "spawn_agents",
      "list_agents",
      "wait_agents",
      "post_agent",
      "reply_agent",
      "cancel_agents",
    ]);
    const promptContext = createPromptContextV1(registry);
    await parentStore.append({
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        recordVersion: 2,
        sessionId: parentSessionId,
        projectId: `sha256:${"d".repeat(64)}`,
        targetIdentity,
        contextProfile,
        promptContext,
      },
    });
    let calls = 0;
    const mainRequests: ModelRequest[] = [];
    const dependencies = {
      contextProfile,
      tools: registry,
      store: parentStore as SessionStore,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      [sessionDurableContext]: {
        sessionId: parentSessionId,
        projectId: `sha256:${"d".repeat(64)}`,
        targetIdentity,
        promptContext,
        nextSequence: 2,
        repositoryWorkspaceRoot: process.cwd(),
      },
      [managedAgentRequestBoundary]: managedControlMainRequestBoundary(f.control, parentSessionId),
      model: {
        async *stream(request: ModelRequest) {
          mainRequests.push(request);
          if (++calls === 1) {
            yield { type: "tool_call_start" as const, id: "foreground", name: "spawn_agents" };
            yield {
              type: "tool_call_delta" as const,
              id: "foreground",
              json: JSON.stringify({ mode: "foreground", entries: batch(1).entries }),
            };
            yield { type: "tool_call_end" as const, id: "foreground" };
            yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
            yield { type: "finish" as const, reason: "tool_calls" as const };
            return;
          }
          yield { type: "text_delta" as const, text: "Main saw foreground evidence." };
          yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
          yield { type: "finish" as const, reason: "stop" as const };
        },
      },
    };
    expect(await runConfirmedParent(dependencies, { text: "Inspect foreground." })).toMatchObject({
      status: "completed",
    });
    const childAdmission = (await f.store.read()).find(
      (record) => record.event.type === "admitted",
    );
    expect(childAdmission?.event).toMatchObject({
      envelope: { origin: { kind: "main_run", callId: "foreground" } },
    });
    expect((await f.control.inspect({ parentSessionId })).completions[0]?.consumption).toBe(
      "consumed",
    );
    expect(
      mainRequests[1]?.messages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Parent message"),
      ),
    ).toHaveLength(0);
    expect(
      await f.control.dispatch({ type: "prepare_main_delivery", parentSessionId }),
    ).toMatchObject({ status: "delivery", messages: [], deliveries: [] });
  } finally {
    await f.close();
  }
});

test("exit suspends queued intents, retains interrupted running outcomes and resumes only explicitly selected work", async () => {
  const model: ModelDriver = {
    async *stream(request) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const f = await schedulerFixture(model);
  try {
    const admitted = await f.control.dispatch(batch(6));
    if (admitted.status !== "admitted") throw new Error("No admission");
    expect(await f.control.dispatch({ type: "suspend_agents", parentSessionId })).toMatchObject({
      status: "suspended",
    });
    const snapshot = await f.control.inspect({ parentSessionId });
    expect(
      snapshot.threads.slice(0, 4).every((thread) => thread.turn.outcome?.status === "interrupted"),
    ).toBe(true);
    expect(
      snapshot.threads.slice(4).every((thread) => thread.turn.waitReason === "suspended"),
    ).toBe(true);
    const selected = snapshot.threads[4];
    if (selected === undefined) throw new Error("No queued item");
    expect(
      await f.control.dispatch({
        type: "resume_agents",
        parentSessionId,
        targets: [{ threadId: selected.threadId, expectedTurnId: selected.turn.turnId }],
      }),
    ).toMatchObject({ status: "resumed" });
    await observeUntil(f.control, (state) => state.threads[4]?.turn.phase === "executing");
    expect((await f.control.inspect({ parentSessionId })).threads[5]?.turn.waitReason).toBe(
      "suspended",
    );
    const terminal = snapshot.threads[0];
    if (terminal === undefined) throw new Error("No terminal item");
    expect(
      await f.control.dispatch({
        type: "close_thread",
        parentSessionId,
        threadId: terminal.threadId,
        expectedTurnId: terminal.turn.turnId,
      }),
    ).toMatchObject({ status: "closed" });
    expect(
      await f.control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: terminal.threadId,
        expectedTurnId: terminal.turn.turnId,
        task: "Forbidden continuation",
      }),
    ).toMatchObject({ status: "rejected", code: "action_unavailable" });
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.lifecycle).toBe("closed");
  } finally {
    await f.close();
  }
});

test("candidate Lifecycle exposes the current Registry under the new Plan policy while child evidence cannot revise a ready Plan", async () => {
  const h = createInMemorySessionLifecycleHarness();
  const records = createInMemoryManagedAgentControlStore();
  let mainCalls = 0;
  let childCalls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        if (++mainCalls === 1) {
          yield { type: "tool_call_start", id: "plan-explore", name: "spawn_agents" };
          yield {
            type: "tool_call_delta",
            id: "plan-explore",
            json: JSON.stringify({ mode: "foreground", entries: batch(1).entries }),
          };
          yield { type: "tool_call_end", id: "plan-explore" };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (mainCalls === 3) {
          yield { type: "tool_call_start", id: "publish-plan", name: "submit_plan" };
          yield {
            type: "tool_call_delta",
            id: "publish-plan",
            json: JSON.stringify({
              markdown: "# Exact Plan\n\nInspect bounded repository evidence.\n",
            }),
          };
          yield { type: "tool_call_end", id: "publish-plan" };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Plan evidence received." };
      } else {
        childCalls++;
        yield { type: "text_delta", text: "Local child evidence." };
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const lifecycle = h.createLifecycle({
    workspaceRoot: process.cwd(),
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
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
              readiness: { status: "available", credentialSource: "fixture" },
            },
          ],
        };
      },
    },
    [sessionManagedControl]: {
      store: records,
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  const confirmation = confirmRequestedEnvelopes(lifecycle);
  try {
    const parent = await lifecycle.create({ targetIdentity });
    expect((await lifecycle.enterPlan({ sessionId: parent.sessionId })).plan?.policyVersion).toBe(
      "plan-policy.hybrid-delegation-v1",
    );
    expect(
      await lifecycle.continue({
        sessionId: parent.sessionId,
        input: { text: "Gather local evidence for this Plan." },
      }),
    ).toMatchObject({ result: { status: "completed", answer: "Plan evidence received." } });
    expect(mainCalls).toBe(2);
    expect(childCalls).toBe(1);
    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("No current control");
    expect(
      (await control.inspect({ parentSessionId: parent.sessionId })).completions[0]?.consumption,
    ).toBe("consumed");
    await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Publish the exact Plan." },
    });
    const ready = await lifecycle.inspect({ sessionId: parent.sessionId });
    if (ready.schemaVersion !== 3) throw new Error("No current Plan");
    expect(ready.plan?.state).toBe("ready");
    expect(
      await control.dispatch({
        ...batch(1, "Ready evidence"),
        parentSessionId: parent.sessionId,
        mode: "foreground",
      }),
    ).toMatchObject({ status: "completed" });
    const after = await lifecycle.inspect({ sessionId: parent.sessionId });
    if (after.schemaVersion !== 3) throw new Error("No Plan after child evidence");
    expect(after.plan).toEqual(ready.plan);
    expect(after.lastSequence).toBe(ready.lastSequence);
  } finally {
    confirmation();
    await lifecycle.close();
  }
});

test("a tightened envelope bounds concurrency independently and queued task bytes stay immutable", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const f = await schedulerFixture({
    async *stream(request) {
      calls++;
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const command = batch(4);
    const proposal = await f.control.prepareDelegation(command);
    const { digest: _digest, ...fields } = proposal;
    const tightened = { ...fields, running: 1, queued: 3 };
    const envelope = {
      ...tightened,
      digest:
        `sha256:${createHash("sha256").update(JSON.stringify(tightened)).digest("hex")}` as const,
    };
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    await started.promise;
    const snapshot = await f.control.inspect({ parentSessionId });
    expect(snapshot.threads.filter((thread) => thread.turn.phase === "executing")).toHaveLength(1);
    expect(snapshot.threads.filter((thread) => thread.turn.phase === "queued")).toHaveLength(3);
    expect(calls).toBe(1);
    const queued = snapshot.threads[1];
    if (queued === undefined) throw new Error("No queue");
    expect(
      await f.control.dispatch({
        type: "post_agent",
        parentSessionId,
        threadId: queued.threadId,
        expectedTurnId: queued.turn.turnId,
        inputId: "00000000-0000-4000-8000-000000000050",
        mode: "cooperative",
        text: "Mutate the queued task",
      }),
    ).toMatchObject({ status: "rejected", code: "action_unavailable" });
    expect((await f.store.read()).some((record) => record.event.type === "input_accepted")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test.each([1, 4])(
  "cold continuation cannot widen the initial thread's limits (attempt cap %s)",
  async (maximumAttempts) => {
    let calls = 0;
    const children = createInMemorySessionStoreDirectory<SessionRecord>();
    const model: ModelDriver = {
      async *stream() {
        calls++;
        yield { type: "text_delta", text: "Bounded evidence." };
        yield { type: "usage", inputTokens: 2000, outputTokens: 1000 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const first = await schedulerFixture(model, {
      childSessionStores: children,
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts,
        threadTokens: 6000,
        batchTokens: 24000,
        sessionTokens: 96000,
        storageBytes: 32 * 1024 * 1024,
      },
    });
    await first.control.dispatch({ ...batch(1), mode: "foreground" });
    const thread = (await first.control.inspect({ parentSessionId })).threads[0];
    if (thread === undefined) throw new Error("No thread");
    await first.close();
    const cold = await schedulerFixture(model, {
      store: first.store,
      childSessionStores: children,
    });
    try {
      const continuation = await cold.control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Continue bounded evidence.",
      });
      if (maximumAttempts === 1)
        expect(continuation).toMatchObject({ status: "rejected", code: "attempt_limit" });
      else {
        expect(continuation).toMatchObject({ status: "accepted" });
        await observeUntil(cold.control, (snapshot) => snapshot.completions.length === 2);
        expect(
          (await cold.control.inspect({ parentSessionId })).threads[0]?.turn.outcome?.error?.code,
        ).toBe("fleet_budget_exhausted");
      }
      expect(calls).toBe(1);
    } finally {
      await cold.close();
    }
  },
);

test("foreground caller cancellation registers exact cancellation and returns after settlement", async () => {
  const entered = Promise.withResolvers<void>();
  const f = await schedulerFixture({
    async *stream(request) {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  });
  const caller = new AbortController();
  try {
    const foreground = f.control.dispatch(
      { ...batch(1), mode: "foreground" },
      { signal: caller.signal },
    );
    await entered.promise;
    caller.abort();
    expect(
      await withManagedFailureGuard(foreground, "foreground cancellation receipt"),
    ).toMatchObject({ status: "rejected" });
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "idle",
      outcome: { status: "cancelled" },
    });
  } finally {
    await f.close();
  }
});

test.each(["allow", "ask"] as const)(
  "Lifecycle current ceiling composes with %s permission and explicit resume",
  async (readPermission) => {
    const h = createInMemorySessionLifecycleHarness();
    const store = createInMemoryManagedAgentControlStore();
    const children = createInMemorySessionStoreDirectory<SessionRecord>();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const driver: ModelDriver = {
      async *stream() {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
          yield { type: "tool_call_start", id: "read-after-plan", name: "read_file" };
          yield { type: "tool_call_delta", id: "read-after-plan", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "read-after-plan" };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Resumed evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const lifecycle = h.createLifecycle({
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
                readiness: { status: "available", credentialSource: "fixture" },
              },
            ],
          };
        },
      },
      permissions: createPermissionPolicy({
        allowedEffects: readPermission === "allow" ? ["read", "delegate"] : ["delegate"],
        askedEffects: readPermission === "ask" ? ["read"] : [],
      }),
      [sessionManagedControl]: {
        store,
        childSessionStores: children,
        planPolicyVersion: "plan-policy.read-v1",
      },
    });
    try {
      const parent = await lifecycle.create({ targetIdentity });
      const control = await lifecycle[sessionManagedControl](parent.sessionId);
      if (control === undefined) throw new Error("No control");
      const receipt = await control.dispatch({ ...batch(1), parentSessionId: parent.sessionId });
      if (receipt.status !== "admitted" || receipt.turns[0] === undefined)
        throw new Error("No turn");
      const turn = receipt.turns[0];
      await entered.promise;
      const plan = (await lifecycle.enterPlan({ sessionId: parent.sessionId })).plan;
      if (plan === undefined) throw new Error("No Plan");
      release.resolve();
      const observer = new AbortController();
      try {
        await withManagedFailureGuard(
          (async () => {
            for await (const frame of control.observe({
              parentSessionId: parent.sessionId,
              signal: observer.signal,
            })) {
              const attention = frame.snapshot.threads[0]?.turn.attention;
              if (attention?.kind === "permission")
                await control.dispatch({
                  type: "decide_permission",
                  parentSessionId: parent.sessionId,
                  threadId: turn.threadId,
                  expectedTurnId: turn.turnId,
                  requestId: attention.id,
                  decision: "allow",
                });
              if (frame.snapshot.threads[0]?.turn.waitReason === "plan") return;
            }
          })(),
          "current Plan ceiling pause",
        );
      } finally {
        observer.abort();
      }
      const child = await (await children.open(turn.childSessionId))?.read();
      expect(
        child?.some(
          (record) =>
            record.schemaVersion === 3 &&
            record.record.type === "runtime_event" &&
            record.record.event.type === "tool_started",
        ),
      ).toBe(false);
      expect(
        await control.dispatch({ ...batch(1), parentSessionId: parent.sessionId }),
      ).toMatchObject({ status: "rejected", code: "plan_policy_paused" });
      expect(
        await control.dispatch({
          type: "post_agent",
          parentSessionId: parent.sessionId,
          threadId: turn.threadId,
          expectedTurnId: turn.turnId,
          inputId: "00000000-0000-4000-8000-000000000055",
          mode: "cooperative",
          text: "Forbidden direct input",
        }),
      ).toMatchObject({ status: "rejected", code: "plan_policy_paused" });
      await lifecycle.exitPlan({
        sessionId: parent.sessionId,
        cycleId: plan.cycleId,
        revision: plan.revision,
      });
      expect(
        await control.dispatch({ type: "resume_agents", parentSessionId: parent.sessionId }),
      ).toMatchObject({ status: "resumed" });
      expect(
        await withManagedFailureGuard(
          control.dispatch({
            type: "wait_agents",
            parentSessionId: parent.sessionId,
            targets: [{ threadId: turn.threadId, expectedTurnId: turn.turnId }],
            mode: "all",
          }),
          "Plan-ceiling resumed result",
        ),
      ).toMatchObject({ status: "completed" });
      expect(calls).toBe(2);
    } finally {
      release.resolve();
      await lifecycle.close();
    }
  },
);

test.each(["deny", "ask"] as const)(
  "new Plan delegation obeys ordinary %s permission before admission",
  async (permission) => {
    const h = createInMemorySessionLifecycleHarness();
    let children = 0;
    let main = 0;
    let asks = 0;
    const driver: ModelDriver = {
      async *stream(request) {
        if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          if (++main === 1) {
            yield { type: "tool_call_start", id: "denied-spawn", name: "spawn_agents" };
            yield {
              type: "tool_call_delta",
              id: "denied-spawn",
              json: JSON.stringify({ entries: batch(1).entries }),
            };
            yield { type: "tool_call_end", id: "denied-spawn" };
            yield { type: "usage", inputTokens: 10, outputTokens: 5 };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
        } else children++;
        yield { type: "text_delta", text: "Permission respected." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const store = createInMemoryManagedAgentControlStore();
    const lifecycle = h.createLifecycle({
      workspaceRoot: process.cwd(),
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: permission === "ask" ? ["delegate"] : [],
      }),
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
                readiness: { status: "available", credentialSource: "fixture" },
              },
            ],
          };
        },
      },
      [sessionManagedControl]: {
        store,
        childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
      },
    });
    const unsubscribe = lifecycle.subscribe((event) => {
      if (event.type === "tool_permission_requested" && event.effect === "delegate") {
        asks++;
        lifecycle.decidePermission({ requestId: event.requestId, decision: "deny" });
      }
    });
    try {
      const parent = await lifecycle.create({ targetIdentity });
      await lifecycle.enterPlan({ sessionId: parent.sessionId });
      await lifecycle.continue({
        sessionId: parent.sessionId,
        input: { text: "Respect exact permission." },
      });
      expect(children).toBe(0);
      expect(await store.read()).toHaveLength(0);
      expect(asks).toBe(permission === "ask" ? 1 : 0);
    } finally {
      unsubscribe();
      await lifecycle.close();
    }
  },
);

test("an exact envelope cannot admit additional threads on reuse or accept unsupported authority", async () => {
  const f = await schedulerFixture({
    async *stream() {
      yield { type: "text_delta", text: "One authorized thread." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  const sign = <T extends { digest: string }>(value: T): T => {
    const { digest: _digest, ...body } = value;
    return {
      ...body,
      digest: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
    } as T;
  };
  try {
    const command = { ...batch(1), mode: "foreground" as const };
    const envelope = await f.control.prepareDelegation(command);
    const first = await f.control.dispatch({ ...command, envelope });
    const before = await f.store.read();
    expect(await f.control.dispatch({ ...command, envelope })).toEqual(first);
    expect(await f.store.read()).toEqual(before);
    expect(
      await f.control.dispatch({
        ...command,
        envelope,
        entries: [{ role: "builtin:explore", description: "Work 0", task: "Different task" }],
      }),
    ).toMatchObject({ status: "rejected" });
    const unsupported = sign({
      ...(await f.control.prepareDelegation(batch(1))),
      skills: ["project:unsupported"],
    });
    expect(await f.control.dispatch({ ...batch(1), envelope: unsupported })).toMatchObject({
      status: "rejected",
    });
    const inconsistent = sign({
      ...(await f.control.prepareDelegation(batch(2))),
      running: 1,
      queued: 0,
    });
    expect(await f.control.dispatch({ ...batch(2), envelope: inconsistent })).toMatchObject({
      status: "rejected",
    });
    expect(await f.store.read()).toEqual(before);
  } finally {
    await f.close();
  }
});

test.each(["deny", "ask"] as const)(
  "cold queued work retains its original %s read ceiling",
  async (ceiling) => {
    const children = createInMemorySessionStoreDirectory<SessionRecord>();
    const first = await schedulerFixture(
      {
        async *stream(request) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        childSessionStores: children,
        permissions: createPermissionPolicy({
          allowedEffects: [],
          askedEffects: ceiling === "ask" ? ["read"] : [],
        }),
      },
    );
    const receipt = await first.control.dispatch(batch(5));
    if (receipt.status !== "admitted" || receipt.turns[4] === undefined)
      throw new Error("No queued item");
    const queued = receipt.turns[4];
    await first.close();
    let denied = false;
    const cold = await schedulerFixture(
      {
        async *stream(request) {
          const result = request.messages.find((message) => message.role === "tool");
          if (result === undefined) {
            yield { type: "tool_call_start", id: "frozen-read", name: "read_file" };
            yield { type: "tool_call_delta", id: "frozen-read", json: '{"path":"package.json"}' };
            yield { type: "tool_call_end", id: "frozen-read" };
            yield { type: "usage", inputTokens: 10, outputTokens: 5 };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          denied =
            result.role === "tool" &&
            result.result.status === "failed" &&
            result.result.error.code === "permission_denied";
          yield { type: "text_delta", text: "Frozen authority respected." };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        store: first.store,
        childSessionStores: children,
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      },
    );
    try {
      expect(
        await cold.control.dispatch({
          type: "recover_turn",
          parentSessionId,
          threadId: queued.threadId,
          expectedTurnId: queued.turnId,
        }),
      ).toMatchObject({ status: "accepted" });
      if (ceiling === "ask") {
        await observeUntil(
          cold.control,
          (snapshot) => snapshot.threads[4]?.turn.attention?.kind === "permission",
        );
        const attention = (await cold.control.inspect({ parentSessionId })).threads[4]?.turn
          .attention;
        if (attention === undefined) throw new Error("No exact permission");
        expect(
          await cold.control.dispatch({
            type: "decide_permission",
            parentSessionId,
            threadId: queued.threadId,
            expectedTurnId: queued.turnId,
            requestId: attention.id,
            decision: "deny",
          }),
        ).toMatchObject({ status: "accepted" });
      }
      await observeUntil(cold.control, (snapshot) =>
        snapshot.completions.some((completion) => completion.turnId === queued.turnId),
      );
      expect(denied).toBe(true);
    } finally {
      await cold.close();
    }
  },
);

test("direct start_thread shares the same lane admission budget", async () => {
  const f = await schedulerFixture(
    {
      async *stream(request) {
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      policy: {
        version: 1,
        background: { running: 1, queued: 0 },
        reserved: { running: 1, queued: 0 },
        maximumAttempts: 4,
        threadTokens: 128000,
        batchTokens: 512000,
        sessionTokens: 2048000,
        storageBytes: 32 * 1024 * 1024,
      },
    },
  );
  try {
    const command = {
      type: "start_thread" as const,
      parentSessionId,
      role: "builtin:explore" as const,
      task: "Exact direct task.",
      description: "Direct evidence",
    };
    expect(await f.control.dispatch(command)).toMatchObject({ status: "accepted" });
    expect(await f.control.dispatch(command)).toMatchObject({
      status: "rejected",
      code: "capacity_exhausted",
    });
    expect(
      (await f.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("model new_turn obtains an exact continuation envelope bound to its Main call", async () => {
  const parentStore = createInMemorySessionStore<SessionRecord>();
  const f = await schedulerFixture(
    {
      async *stream() {
        yield { type: "text_delta", text: "Continued evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { parentSessionStore: parentStore },
  );
  try {
    await f.control.dispatch({ ...batch(1), mode: "foreground" });
    const registry = createManagedAgentControlToolRegistry({ control: f.control, parentSessionId });
    const promptContext = createPromptContextV1(registry);
    await parentStore.append({
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        recordVersion: 2,
        sessionId: parentSessionId,
        projectId: `sha256:${"d".repeat(64)}`,
        targetIdentity,
        contextProfile,
        promptContext,
      },
    });
    let calls = 0;
    const deps = {
      contextProfile,
      tools: registry,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      store: parentStore as SessionStore,
      [sessionDurableContext]: {
        nextSequence: 2,
        sessionId: parentSessionId,
        projectId: `sha256:${"d".repeat(64)}`,
        targetIdentity,
        promptContext,
        repositoryWorkspaceRoot: process.cwd(),
      },
      model: {
        async *stream() {
          if (++calls === 1) {
            yield { type: "tool_call_start" as const, id: "next-exact", name: "post_agent" };
            yield {
              type: "tool_call_delta" as const,
              id: "next-exact",
              json: JSON.stringify({
                threadId: "@explore-1",
                mode: "new_turn",
                text: "Continue exact evidence.",
              }),
            };
            yield { type: "tool_call_end" as const, id: "next-exact" };
            yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
            yield { type: "finish" as const, reason: "tool_calls" as const };
            return;
          }
          yield { type: "text_delta" as const, text: "Main is available." };
          yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
          yield { type: "finish" as const, reason: "stop" as const };
        },
      },
    };
    expect(await runConfirmedParent(deps, { text: "Continue the exact child." })).toMatchObject({
      status: "completed",
    });
    await observeUntil(f.control, (snapshot) => snapshot.completions.length === 2);
    const next = (await f.store.read()).findLast((record) => record.event.type === "admitted");
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
      { id: next?.event.type === "admitted" ? next.event.inputId : undefined, status: "delivered" },
    ]);
    expect(next?.event).toMatchObject({
      envelope: { origin: { kind: "main_run", callId: "next-exact" } },
    });
    const permission = (await parentStore.read()).find(
      (record) =>
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "tool_permission_decided" &&
        record.record.event.callId === "next-exact",
    );
    expect(permission).toMatchObject({
      record: {
        event: {
          subject: { envelope: next?.event.type === "admitted" ? next.event.envelope : undefined },
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("exit fences new admission before awaiting child settlement", async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await schedulerFixture(
    {
      async *stream() {
        yield { type: "text_delta", text: "Settling evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      [managedAgentSettlementBarrier]: async () => {
        reached.resolve();
        await release.promise;
      },
    },
  );
  let closing: Promise<unknown> | undefined;
  try {
    await f.control.dispatch(batch(1));
    await reached.promise;
    closing = f.control.dispatch({ type: "close", parentSessionId, reason: "exit" });
    expect(await f.control.dispatch(batch(1, "After exit"))).toMatchObject({
      status: "rejected",
      code: "runtime_unavailable",
    });
    release.resolve();
    expect(await closing).toMatchObject({ status: "closed" });
  } finally {
    release.resolve();
    await closing;
    await f.close();
  }
});

test.each(["wait", "suspend"] as const)(
  "Presentation and Lifecycle %s transition fences stale Control references and isolates branches",
  async (choice) => {
    const h = createInMemorySessionLifecycleHarness();
    const store = createInMemoryManagedAgentControlStore();
    const fourStarted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const driver: ModelDriver = {
      async *stream(request) {
        if (request.purpose === "title") {
          yield { type: "text_delta", text: "Managed transition" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          yield { type: "text_delta", text: "Saved destination." };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        if (++calls === 4) fourStarted.resolve();
        await Promise.race([
          finish.promise,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        yield { type: "finish", reason: "stop" };
      },
    };
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
              readiness: { status: "available" as const, credentialSource: "fixture" },
            },
          ],
        };
      },
    };
    const lifecycle = h.createLifecycle({
      workspaceRoot: process.cwd(),
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      [sessionManagedControl]: {
        store,
        childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
      },
    });
    const a = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: a.sessionId, input: { text: "Saved source." } });
    const b = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: b.sessionId, input: { text: "Saved destination." } });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot: process.cwd(),
      projectLabel: "Managed transition",
      sessionId: a.sessionId,
      [presentationSessionRecordReader]: async (id) =>
        (await (await h.sessions.open(id))?.read()) ?? [],
    });
    try {
      const control = await lifecycle[sessionManagedControl](a.sessionId);
      if (control === undefined) throw new Error("No source Control");
      await control.dispatch({ ...batch(5), parentSessionId: a.sessionId });
      await fourStarted.promise;
      expect(
        await presentation.dispatch({ type: "select_session", sessionId: b.sessionId }),
      ).toMatchObject({ status: "rejected", code: "transition_required" });
      expect(presentation.getState().authoritative.active?.session.id).toBe(a.sessionId);
      const before = await (await h.sessions.open(b.sessionId))?.read();
      await expect(
        withManagedFailureGuard(
          lifecycle.continue({
            sessionId: b.sessionId,
            input: { text: "Must not bypass transition." },
          }),
          "lower-level transition rejection",
        ),
      ).rejects.toMatchObject({ code: "session_managed_transition_required" });
      expect(await (await h.sessions.open(b.sessionId))?.read()).toEqual(before);
      const transition = presentation.getState().authoritative.managedTransition;
      if (transition === undefined) throw new Error("No transition descriptor");
      expect(transition).toMatchObject({
        sourceSessionId: a.sessionId,
        destinationSessionId: b.sessionId,
        choices: ["stay", "wait", "suspend"],
      });
      expect(
        await presentation.dispatch({
          type: "resolve_managed_transition",
          transitionId: transition.id,
          decision: "stay",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(presentation.getState().authoritative.active?.session.id).toBe(a.sessionId);
      await presentation.dispatch({ type: "select_session", sessionId: b.sessionId });
      const again = presentation.getState().authoritative.managedTransition;
      if (again === undefined) throw new Error("No second transition");
      const switching = presentation.dispatch({
        type: "resolve_managed_transition",
        transitionId: again.id,
        decision: choice,
      });
      if (choice === "wait") finish.resolve();
      expect(await switching).toMatchObject({ status: "admitted" });
      expect(presentation.getState().authoritative.active?.session.id).toBe(b.sessionId);
      expect(presentation.getState().authoritative.managedControl?.threads).toEqual([]);
      expect((await control.inspect({ parentSessionId: a.sessionId })).threads[4]?.turn.phase).toBe(
        choice === "suspend" ? "waiting" : "idle",
      );
      expect(
        await control.dispatch({ ...batch(1, "Stale source"), parentSessionId: a.sessionId }),
      ).toMatchObject({ status: "rejected", code: "authority_busy" });
      const sourceSnapshot = await control.inspect({ parentSessionId: a.sessionId });
      const last = sourceSnapshot.threads[4];
      if (last === undefined) throw new Error("Missing original target");
      expect(
        await control.dispatch({
          type: "resume_agents",
          parentSessionId: a.sessionId,
          targets: [{ threadId: last.threadId, expectedTurnId: last.turn.turnId }],
        }),
      ).toMatchObject({
        status: "resumed",
        results: [{ status: "rejected", code: "authority_busy" }],
      });
      expect(calls).toBe(choice === "suspend" ? 4 : 5);
      const source = await lifecycle.inspect({ sessionId: a.sessionId });
      if (source.schemaVersion !== 3) throw new Error("Missing source");
      const branch = await lifecycle.branch({
        parentSessionId: a.sessionId,
        atSequence: source.lastSequence,
      });
      const branchControl = await lifecycle[sessionManagedControl](branch.sessionId);
      if (branchControl === undefined) throw new Error("Missing branch Control");
      expect((await branchControl.inspect({ parentSessionId: branch.sessionId })).threads).toEqual(
        [],
      );
      expect(
        (await branchControl.inspect({ parentSessionId: branch.sessionId })).completions,
      ).toEqual([]);
      expect(
        await branchControl.dispatch({ ...batch(1), parentSessionId: branch.sessionId }),
      ).toMatchObject({ status: "rejected", code: "authority_busy" });
      expect(
        await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId }),
      ).toMatchObject({ status: "admitted" });
      expect(presentation.getState().authoritative.active).toBeNull();
      expect(presentation.getState().authoritative.managedControl).toBeUndefined();
    } finally {
      finish.resolve();
      await presentation.close();
      await lifecycle.close();
    }
  },
);

test("each fresh envelope requires exact confirmation even under allow delegate in the same Main run", async () => {
  const parentStore = createInMemorySessionStore<SessionRecord>();
  let childCalls = 0;
  const f = await schedulerFixture(
    {
      async *stream() {
        childCalls++;
        yield { type: "text_delta", text: "Explicitly authorized evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { parentSessionStore: parentStore },
  );
  const registry = createManagedAgentControlToolRegistry({ control: f.control, parentSessionId });
  const promptContext = createPromptContextV1(registry);
  await parentStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: parentSessionId,
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity,
      contextProfile,
      promptContext,
    },
  });
  let calls = 0;
  const firstAsk = Promise.withResolvers<void>();
  const secondAsk = Promise.withResolvers<void>();
  const requests: Extract<
    import("@adam-agent/agent").RuntimeEvent,
    { type: "tool_permission_requested" }
  >[] = [];
  const deps = {
    contextProfile,
    tools: registry,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    store: parentStore as SessionStore,
    [sessionDurableContext]: {
      nextSequence: 2,
      sessionId: parentSessionId,
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity,
      promptContext,
      repositoryWorkspaceRoot: process.cwd(),
    },
    model: {
      async *stream() {
        if (++calls <= 2) {
          const id = `new-envelope-${calls}`;
          yield { type: "tool_call_start" as const, id, name: "spawn_agents" };
          yield {
            type: "tool_call_delta" as const,
            id,
            json: JSON.stringify({ entries: batch(1, `Grant ${calls}`).entries }),
          };
          yield { type: "tool_call_end" as const, id };
          yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
          yield { type: "finish" as const, reason: "tool_calls" as const };
          return;
        }
        yield { type: "text_delta" as const, text: "Confirmed Main." };
        yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
        yield { type: "finish" as const, reason: "stop" as const };
      },
    },
  };
  const parent = new AgentSession(deps);
  const unsubscribe = parent.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      requests.push(event);
      if (requests.length === 1) firstAsk.resolve();
      if (requests.length === 2) secondAsk.resolve();
    }
  });
  const run = parent.run({ text: "Obtain two concrete delegations." });
  try {
    expect(
      await Promise.race([firstAsk.promise.then(() => "asked"), run.then(() => "finished")]),
    ).toBe("asked");
    expect(await f.store.read()).toHaveLength(0);
    expect(childCalls).toBe(0);
    const first = requests[0];
    if (first?.subject.type !== "managed_agent_batch") throw new Error("No exact envelope");
    parent.decidePermission({ requestId: first.requestId, decision: "allow" });
    await withManagedFailureGuard(secondAsk.promise, "second explicit envelope");
    expect(
      (await f.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
    const second = requests[1];
    if (second?.subject.type !== "managed_agent_batch") throw new Error("No second envelope");
    expect(second.subject.envelope.id).not.toBe(first.subject.envelope.id);
    expect(second.subject.envelope.origin.id).toBe(first.subject.envelope.origin.id);
    parent.decidePermission({ requestId: second.requestId, decision: "allow" });
    expect(await run).toMatchObject({ status: "completed" });
    await observeUntil(f.control, (snapshot) => snapshot.completions.length === 2);
    expect(childCalls).toBe(2);
  } finally {
    parent.abort();
    unsubscribe();
    await run;
    await f.close();
  }
});

test("insufficient Main receipt capacity keeps completion pending without appending or consuming it", async () => {
  const parentStore = createInMemorySessionStore<SessionRecord>();
  const promptContext = createPromptContextV1(undefined);
  await parentStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: parentSessionId,
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity,
      contextProfile,
      promptContext,
    },
  });
  const deps = {
    contextProfile,
    store: parentStore as SessionStore,
    [sessionDurableContext]: {
      nextSequence: 2,
      sessionId: parentSessionId,
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity,
      promptContext,
      repositoryWorkspaceRoot: process.cwd(),
    },
    model: {
      async *stream() {
        yield { type: "text_delta" as const, text: "Parent remains inspectable." };
        yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
        yield { type: "finish" as const, reason: "stop" as const };
      },
    },
  };
  expect(
    await new AgentSession(deps).run({ text: "Retained context. ".repeat(19000) }),
  ).toMatchObject({ status: "completed" });
  const f = await schedulerFixture(
    {
      async *stream() {
        yield { type: "text_delta", text: "Pending evidence." };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      parentSessionStore: parentStore,
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts: 4,
        threadTokens: 128000,
        batchTokens: 512000,
        sessionTokens: 2048000,
        storageBytes: 400000,
      },
    },
  );
  try {
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
    });
    const before = await parentStore.read();
    expect(
      await f.control.dispatch({ type: "prepare_main_delivery", parentSessionId }),
    ).toMatchObject({ status: "delivery", messages: [], deliveries: [] });
    expect(await parentStore.read()).toEqual(before);
    expect((await f.control.inspect({ parentSessionId })).completions[0]?.consumption).toBe(
      "pending",
    );
    expect((await f.store.read()).some((record) => record.event.type === "consumed")).toBe(false);
  } finally {
    await f.close();
  }
});

test("incomplete child responses retain their bounded partial evidence", async () => {
  const f = await schedulerFixture({
    async *stream() {
      yield { type: "text_delta", text: "Partial evidence before the output limit." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "length" };
    },
  });
  try {
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
      results: [
        { outcome: { status: "failed", summary: "Partial evidence before the output limit." } },
      ],
    });
  } finally {
    await f.close();
  }
});

test("Lifecycle admission serialization releases before a foreground join so background capacity remains usable", async () => {
  const h = createInMemorySessionLifecycleHarness();
  const entered = Promise.withResolvers<void>();
  const driver: ModelDriver = {
    async *stream(request) {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const lifecycle = h.createLifecycle({
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
              readiness: { status: "available", credentialSource: "fixture" },
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
  let foreground: Promise<unknown> | undefined;
  try {
    const parent = await lifecycle.create({ targetIdentity });
    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("No current Control");
    foreground = control.dispatch({
      ...batch(1),
      parentSessionId: parent.sessionId,
      mode: "foreground",
    });
    await entered.promise;
    expect(
      await withManagedFailureGuard(
        control.dispatch({ ...batch(1, "Parallel background"), parentSessionId: parent.sessionId }),
        "independent background admission",
      ),
    ).toMatchObject({ status: "admitted" });
    await control.dispatch({ type: "close", parentSessionId: parent.sessionId });
    await foreground;
  } finally {
    await lifecycle.close();
    await foreground;
  }
});

test("default candidate task completes beyond cumulative context capacity without lowering output capability", async () => {
  let calls = 0;
  const f = await schedulerFixture({
    async *stream(request) {
      calls += 1;
      expect(request.maximumOutputTokens).toBe(4096);
      if (calls <= 7) {
        const id = `read-${calls}`;
        yield { type: "tool_call_start", id, name: "read_file" };
        yield { type: "tool_call_delta", id, json: '{"path":"package.json"}' };
        yield { type: "tool_call_end", id };
        yield { type: "usage", inputTokens: 20_000, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "All seven evidence steps completed." };
        yield { type: "usage", inputTokens: 20_000, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    expect(await f.control.dispatch({ ...batch(1), mode: "foreground" })).toMatchObject({
      status: "completed",
      results: [
        { outcome: { status: "completed", summary: "All seven evidence steps completed." } },
      ],
    });
    expect(calls).toBe(8);
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.budget).toMatchObject({
      ceiling: null,
      knownUsed: 160_080,
      available: null,
      overrun: expect.any(Number),
    });
  } finally {
    await f.close();
  }
});

test("candidate members and continuations share one explicit task grant while new tasks remain unbudgeted", async () => {
  let calls = 0;
  const f = await schedulerFixture({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Evidence retained." };
      yield { type: "usage", inputTokens: calls === 1 ? 7000 : 10, outputTokens: 0 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const command = batch(2);
    const envelope = await f.control.prepareDelegation(command, {
      budgetTokens: 7000,
      running: 1,
      queued: 1,
    });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "admitted",
    });
    await observeUntil(
      f.control,
      (snapshot) =>
        snapshot.threads.length === 2 &&
        snapshot.threads.every((thread) => thread.turn.phase === "idle"),
    );
    expect(calls).toBe(1);
    const snapshot = await f.control.inspect({ parentSessionId });
    expect(snapshot.threads.map((thread) => thread.budget)).toEqual([
      expect.objectContaining({ ceiling: 7000, knownUsed: 7000, available: 0 }),
      expect.objectContaining({ ceiling: 7000, knownUsed: 7000, available: 0 }),
    ]);
    const failed = snapshot.threads.find((thread) => thread.turn.outcome?.status === "failed");
    if (failed === undefined) throw new Error("Missing budget-stopped member");
    expect(
      await f.control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: failed.threadId,
        expectedTurnId: failed.turn.turnId,
        inputId: "00000000-0000-4000-8000-000000000090",
        task: "Continue with the retained evidence.",
        additionalBudgetTokens: 7000,
      }),
    ).toMatchObject({ status: "accepted" });
    await observeUntil(f.control, (current) =>
      current.threads.every((thread) => thread.turn.phase === "idle"),
    );
    expect(calls).toBe(2);
    expect((await f.control.inspect({ parentSessionId })).threads[0]?.budget).toMatchObject({
      ceiling: 14000,
      knownUsed: 7010,
    });
    const admissions = (await f.store.read()).filter((record) => record.event.type === "admitted");
    expect(admissions[0]?.event).toMatchObject({
      envelope: { taskBudget: { mode: "limited", grants: [{ tokens: 7000 }] } },
    });
    expect(admissions.at(-1)?.event).toMatchObject({
      envelope: { taskBudget: { mode: "limited", grants: [{ tokens: 7000 }, { tokens: 7000 }] } },
    });
    expect(
      await f.control.dispatch({ ...batch(1, "Unrelated"), mode: "foreground" }),
    ).toMatchObject({ status: "completed", results: [{ outcome: { status: "completed" } }] });
    expect(calls).toBe(3);
  } finally {
    await f.close();
  }
});

test("a funded candidate closing request uses existing evidence and records its exact tool-free prompt", async () => {
  let calls = 0;
  const f = await schedulerFixture({
    async *stream(request) {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool_call_start", id: "read", name: "read_file" };
        yield { type: "tool_call_delta", id: "read", json: '{"path":"package.json"}' };
        yield { type: "tool_call_end", id: "read" };
        yield { type: "usage", inputTokens: 12000, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        expect(request.tools).toEqual([]);
        expect(JSON.stringify(request.messages)).toContain("Task budget closing request");
        yield {
          type: "text_delta",
          text: "Package evidence collected; remaining checks are incomplete.",
        };
        yield { type: "usage", inputTokens: 1000, outputTokens: 50 };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    const command = { ...batch(1), mode: "foreground" as const };
    const envelope = await f.control.prepareDelegation(command, { budgetTokens: 20000 });
    expect(await f.control.dispatch({ ...command, envelope })).toMatchObject({
      status: "completed",
      results: [
        {
          outcome: {
            status: "completed",
            summary: "Package evidence collected; remaining checks are incomplete.",
          },
        },
      ],
    });
    expect(calls).toBe(2);
    const thread = (await f.control.inspect({ parentSessionId })).threads[0];
    expect(thread?.budget).toMatchObject({ ceiling: 20000, knownUsed: 13060 });
    expect(thread?.turn.recovery).not.toBe("required");
  } finally {
    await f.close();
  }
});
