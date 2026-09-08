import { createHash } from "node:crypto";

import {
  AgentSession,
  type AgentSessionDependencies,
  createReadToolRegistry,
  type ModelDriver,
  type ModelRequest,
} from "@adam-agent/agent";
import {
  createHistoricalManagedAgentToolRegistry,
  createInMemoryManagedAgentStore,
  createInMemorySessionStore,
  createInMemorySessionStoreDirectory,
  createPromptContextV1,
  ManagedAgentStoreError,
  managedAgentPromptSummary,
  managedAgentSnapshotWithChildHistories,
  type SessionRecord,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
  validateHistoricalManagedAgentChildHistory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

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

const projectId = `sha256:${"d".repeat(64)}` as const;
const managedLimits = {
  maximumTurns: 8,
  maximumTokens: 128_000,
  maximumDeadlineMilliseconds: 600_000,
} as const;
const childLiveWorkspaceNotice =
  "This child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.";
const testTaskDigest = (task: string) =>
  `sha256:${createHash("sha256").update(task).digest("hex")}` as const;

test("ManagedAgentStore rejects a terminal link with a different child identity", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const admission = {
    schemaVersion: 1 as const,
    type: "managed_agent_admitted" as const,
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174151",
    attemptId: "123e4567-e89b-42d3-a456-426614174152",
    childSessionId: "123e4567-e89b-42d3-a456-426614174153",
    parentSessionId: "123e4567-e89b-42d3-a456-426614174154",
    parentToolCallId: "mismatched-terminal-spawn",
    parentRootId: "session:123e4567-e89b-42d3-a456-426614174124",
    projectId,
    profile: "scout.v1" as const,
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest("Reject a mismatched terminal."),
    childInputDigest: testTaskDigest(
      `Reject a mismatched terminal.\n\n${childLiveWorkspaceNotice}`,
    ),
    targetIdentity,
  };
  await managedStore.append(admission);

  await expect(
    managedStore.append({
      schemaVersion: 1,
      type: "managed_agent_terminal",
      sequence: 2,
      agentId: admission.agentId,
      attemptId: admission.attemptId,
      childSessionId: "123e4567-e89b-42d3-a456-426614174155",
      status: "completed",
      result: { text: "Forged terminal." },
      transcriptDigest: `sha256:${"2".repeat(64)}`,
      throughSequence: 4,
      usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 },
      cost: { status: "unavailable" },
    }),
  ).rejects.toEqual(new ManagedAgentStoreError("managed_agent_log_invalid"));
  await expect(managedStore.read()).resolves.toEqual([admission]);
});

test("ManagedAgentStore atomically rejects a concurrent seventeenth parent attempt", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174651";
  const admission = (ordinal: number, sequence: number) => {
    const suffix = ordinal.toString().padStart(11, "0");
    const task = `Concurrent capacity attempt ${ordinal}.`;
    return {
      schemaVersion: 1 as const,
      type: "managed_agent_admitted" as const,
      sequence,
      agentId: `123e4567-e89b-42d3-a456-1${suffix}`,
      attemptId: `123e4567-e89b-42d3-a456-2${suffix}`,
      childSessionId: `123e4567-e89b-42d3-a456-3${suffix}`,
      parentSessionId,
      parentToolCallId: `concurrent-capacity-${ordinal}`,
      parentRootId: `session:${parentSessionId}`,
      projectId,
      profile: "scout.v2" as const,
      mode: "background" as const,
      profileDigest: scoutManagedAgentProfileV2.digest,
      usageAccountingVersion: 2 as const,
      limits: {
        maximumTokens: 1_000_000,
        maximumInactivityMilliseconds: 300_000,
      },
      admittedAtUnixMilliseconds: 1_800_000_000_000 + ordinal,
      taskDigest: testTaskDigest(task),
      childInputDigest: testTaskDigest(`${task}\n\n${childLiveWorkspaceNotice}`),
      targetIdentity,
    };
  };
  for (let ordinal = 1; ordinal <= 15; ordinal += 1) {
    await managedStore.append(admission(ordinal, ordinal));
  }

  const settlements = await Promise.allSettled([
    managedStore.append(admission(16, 16)),
    managedStore.append(admission(17, 17)),
  ]);

  expect(settlements.map((settlement) => settlement.status)).toEqual(["fulfilled", "rejected"]);
  expect(settlements[1]).toMatchObject({
    status: "rejected",
    reason: { code: "managed_agent_log_invalid" },
  });
  await expect(managedStore.read()).resolves.toHaveLength(16);

  const legacyStore = createInMemoryManagedAgentStore();
  for (let ordinal = 1; ordinal <= 17; ordinal += 1) {
    const suffix = ordinal.toString().padStart(11, "0");
    const task = `Historical capacity attempt ${ordinal}.`;
    await legacyStore.append({
      schemaVersion: 1,
      type: "managed_agent_admitted",
      sequence: ordinal,
      agentId: `123e4567-e89b-42d3-a456-4${suffix}`,
      attemptId: `123e4567-e89b-42d3-a456-5${suffix}`,
      childSessionId: `123e4567-e89b-42d3-a456-6${suffix}`,
      parentSessionId,
      parentToolCallId: `historical-capacity-${ordinal}`,
      parentRootId: `session:${parentSessionId}`,
      projectId,
      profile: "scout.v1",
      profileDigest: scoutManagedAgentProfileV1.digest,
      limits: managedLimits,
      taskDigest: testTaskDigest(task),
      childInputDigest: testTaskDigest(`${task}\n\n${childLiveWorkspaceNotice}`),
      targetIdentity,
    });
  }
  await expect(legacyStore.read()).resolves.toHaveLength(17);
});

test("AgentSession injects only the bounded O(1) managed-child summary into the parent prompt", async () => {
  const requests: ModelRequest[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Summary observed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const dependencies: AgentSessionDependencies & {
    readonly [managedAgentPromptSummary]: () => string;
  } = {
    contextProfile,
    model,
    store: createInMemorySessionStore(),
    tools: createReadToolRegistry({ workspaceRoot: process.cwd() }),
    [managedAgentPromptSummary]: () =>
      "Managed agents: 1 active, 1 terminal, 0 need attention; IDs: child-a, child-b",
  };
  const session = new AgentSession(dependencies);

  await expect(session.run({ text: "Continue without ambient child results." })).resolves.toEqual({
    status: "completed",
    answer: "Summary observed.",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages).toContainEqual({
    role: "developer",
    content: "Managed agents: 1 active, 1 terminal, 0 need attention; IDs: child-a, child-b",
  });
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("full child result secret");
});

// These literal identities are retained historical session contracts. Changing them
// makes existing tool profiles undecodable even when execution is unavailable.
const historicalProfiles = [
  ["managed-agent-tools.a1.v1", "5cda05981a18dbfd7a4bb8f5c802db58b1ac66edba5d3fbfb9ae5c8c90ccc80f"],
  ["managed-agent-tools.a1.v2", "5cda05981a18dbfd7a4bb8f5c802db58b1ac66edba5d3fbfb9ae5c8c90ccc80f"],
  ["managed-agent-tools.a1.v3", "63a0a967584b2d976d6cb2fbb922ac83a0805421159f34cf59c3f30f7b71d432"],
  [
    "managed-agent-tools.a2-long-lived.v1",
    "3ed0b3d6975333b88182f7c164b43a34483a2b95190bb521a5a75c57122c1c65",
  ],
  [
    "managed-agent-tools.a2-long-lived.v2",
    "3ed0b3d6975333b88182f7c164b43a34483a2b95190bb521a5a75c57122c1c65",
  ],
  [
    "managed-agent-tools.a3-long-lived.v1",
    "c0d8fcde731bd0e3fdf7ffb403365b7b1f81cec8ad3a166751642443276d3b9f",
  ],
  [
    "managed-agent-tools.a3-long-lived.v2",
    "9ed7c147f06e9742c904ce28529e9fef8008a05b39cfbe541f05674b72366379",
  ],
  [
    "managed-agent-tools.a3-long-lived.v3",
    "d6858f9e04dc788141f54317b90a2f54224a707466d67bacd06560964feb7441",
  ],
] as const;

test.each(historicalProfiles)(
  "historical %s keeps its exact persisted tool identities and refuses executable calls",
  (profile, spawnDigest) => {
    const tools = createHistoricalManagedAgentToolRegistry({ profile });
    const a1 = profile.includes(".a1.");
    const a3 = profile.includes(".a3-");
    const identities = Object.fromEntries(
      tools.definitions().map(({ name }) => [name, tools.resolve(name)?.definitionDigest]),
    );
    expect(identities).toEqual({
      spawn_agent: `sha256:${spawnDigest}`,
      ...(a1
        ? {}
        : {
            list_agents: profile.endsWith(".v1")
              ? "sha256:9d14f9c71a4a4aeff84c8061c2e7eb74e04a2275a2d67dcf31a2a0983703b32a"
              : "sha256:e0e4309944c389e7970262f5d1ad30cc44a147f22ecc72a5338ea93ef234b1b6",
            wait_agents: a3
              ? "sha256:7cfbb3bf6af496083acf616512ec7defb6a8f226809bb2c8fb0d6398be7ee22a"
              : "sha256:ed8b9af5ef5f093344f8ee23f5488e59788d67e55b2122709d01248eb5435327",
            follow_up_agent:
              "sha256:05d3436f665bbf8bdd3170d98d3c48f0d43b5fd7a92565bc97110ad3265fb6ad",
            cancel_agent: "sha256:bacd7299371bc6f548930c004b5104236a578fb1b2f2dd48b59acd0ef5ad242f",
            ...(a3
              ? {
                  send_agent_message:
                    "sha256:7ce99bc757994eeaf246d58d14ca17798ad1f089bbe1329f487a0b4db0ce3fae",
                }
              : {}),
          }),
    });
    const agentId = "123e4567-e89b-42d3-a456-426614174151";
    const argumentsByName: Record<string, unknown> = {
      spawn_agent: {
        task: "Historical child task.",
        ...(a3 ? { profile: `scout.${profile.slice(-2)}` } : {}),
      },
      list_agents: {},
      wait_agents: { agentIds: [agentId] },
      follow_up_agent: { agentId, expectedRevision: 1, task: "Historical next attempt." },
      cancel_agent: { agentId, expectedRevision: 1 },
      send_agent_message: { agentId, expectedRevision: 1, message: "Historical message." },
    };
    for (const { name } of tools.definitions()) {
      const tool = tools.resolve(name);
      expect(
        tool?.prepare(JSON.stringify(argumentsByName[name]), {
          callId: "historical-call",
          sessionId: agentId,
          toolName: name,
          runId: "historical-run",
          turn: 1,
          attempt: 1,
        }),
      ).toMatchObject({ status: "failed", error: { code: "managed_agent_unavailable" } });
      expect(tool?.prepare("null")).toMatchObject({
        status: "failed",
        error: { code: "invalid_tool_input" },
      });
    }
    if (!a1)
      expect(tools.resolve("list_agents")?.prepare('{"status":"stalled"}')).toMatchObject({
        status: "failed",
        error: {
          code: profile.endsWith(".v1") ? "invalid_tool_input" : "managed_agent_unavailable",
        },
      });
  },
);

test("historical child inspection checks exact identity and terminal evidence without rewriting records", async () => {
  const childSessionId = "123e4567-e89b-42d3-a456-426614174153";
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174154";
  const admission = {
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174151",
    attemptId: "123e4567-e89b-42d3-a456-426614174152",
    childSessionId,
    parentSessionId,
    parentRootId: `session:${parentSessionId}`,
    parentToolCallId: "historical-spawn",
    projectId,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest("Historical evidence."),
    childInputDigest: testTaskDigest(`Historical evidence.\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  } as const;
  const genesis = {
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: childSessionId,
      projectId,
      targetIdentity,
      contextProfile,
      promptContext: createPromptContextV1(
        createReadToolRegistry({ workspaceRoot: process.cwd() }),
      ),
    },
  } as const;
  const records = [genesis];
  const terminal = {
    schemaVersion: 1,
    type: "managed_agent_terminal",
    sequence: 2,
    agentId: admission.agentId,
    attemptId: admission.attemptId,
    childSessionId,
    status: "completed",
    result: { text: "Retained completed output." },
    transcriptDigest: testTaskDigest(JSON.stringify(records)),
    throughSequence: 1,
    usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 },
    cost: { status: "unavailable" },
  } as const;
  const before = structuredClone({ admission, terminal, records });
  expect(validateHistoricalManagedAgentChildHistory({ admission, terminal, records })).toBe(true);
  expect(validateHistoricalManagedAgentChildHistory({ admission, records })).toBe(true);
  expect(validateHistoricalManagedAgentChildHistory({ admission, terminal, records: [] })).toBe(
    false,
  );
  for (const patch of [
    { sessionId: parentSessionId },
    { projectId: `sha256:${"e".repeat(64)}` },
    { targetIdentity: { ...targetIdentity, modelId: "different-model" } },
  ]) {
    expect(
      validateHistoricalManagedAgentChildHistory({
        admission,
        records: [{ ...genesis, record: { ...genesis.record, ...patch } }],
      }),
    ).toBe(false);
  }
  expect(
    validateHistoricalManagedAgentChildHistory({
      admission: { ...admission, profileDigest: `sha256:${"e".repeat(64)}` },
      records,
    }),
  ).toBe(false);
  for (const patch of [
    { childSessionId: parentSessionId },
    { transcriptDigest: `sha256:${"e".repeat(64)}` as const },
    { throughSequence: 2 },
  ]) {
    expect(
      validateHistoricalManagedAgentChildHistory({
        admission,
        records,
        terminal: { ...terminal, ...patch },
      }),
    ).toBe(false);
  }
  expect({ admission, terminal, records }).toEqual(before);
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const childStore = await childSessionStores.create(childSessionId);
  await childStore.append(genesis);
  const storedTerminal = {
    ...terminal,
    transcriptDigest: testTaskDigest(JSON.stringify(await childStore.read())),
  };
  expect(
    await managedAgentSnapshotWithChildHistories({
      records: [admission, storedTerminal],
      parentSessionId,
      childSessionStores,
    }),
  ).toMatchObject({
    agents: [{ status: "completed", result: { text: "Retained completed output." } }],
  });
  const damagedTerminal = { ...terminal, transcriptDigest: `sha256:${"e".repeat(64)}` as const };
  const damaged = await managedAgentSnapshotWithChildHistories({
    records: [admission, damagedTerminal],
    parentSessionId,
    childSessionStores,
  });
  expect(damaged).toMatchObject({
    agents: [
      {
        status: "inspection_required",
        readOnly: true,
        error: { code: "managed_agent_inspection_required" },
      },
    ],
  });
  expect(damaged.agents[0]?.result).toBeUndefined();
  await expect(childStore.read()).resolves.toEqual(records);
  const journal = createInMemoryManagedAgentStore();
  await journal.append(admission);
  await journal.append(storedTerminal);
  const expectedIds = [admission.agentId as string];
  const longResult = "界".repeat(4666);
  for (let index = 1; index < 9; index++) {
    const suffix = String(index).padStart(11, "0");
    const childSessionId = `123e4567-e89b-42d3-a456-3${suffix}`;
    const store = await childSessionStores.create(childSessionId);
    await store.append({ ...genesis, record: { ...genesis.record, sessionId: childSessionId } });
    const nextAdmission = {
      ...admission,
      sequence: index * 2 + 1,
      agentId: `123e4567-e89b-42d3-a456-1${suffix}`,
      attemptId: `123e4567-e89b-42d3-a456-2${suffix}`,
      childSessionId,
      parentToolCallId: `recorded-spawn-${index}`,
    };
    expectedIds.push(nextAdmission.agentId);
    await journal.append(nextAdmission);
    await journal.append({
      ...terminal,
      sequence: index * 2 + 2,
      agentId: nextAdmission.agentId,
      attemptId: nextAdmission.attemptId,
      childSessionId,
      result: { text: longResult },
      transcriptDigest: testTaskDigest(JSON.stringify(await store.read())),
    });
  }
  const beforeList = await journal.read();
  const tools = createHistoricalManagedAgentToolRegistry({
    profile: "managed-agent-tools.a3-long-lived.v3",
    history: {
      parentSessionId,
      async read() {
        return managedAgentSnapshotWithChildHistories({
          records: await journal.read(),
          parentSessionId,
          childSessionStores,
        });
      },
    },
  });
  const listed: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const prepared = tools
      .resolve("list_agents")
      ?.prepare(JSON.stringify({ status: "terminal", ...(cursor === null ? {} : { cursor }) }));
    if (prepared?.status !== "ready") throw new Error("Historical list was not admitted.");
    const result = await prepared.execute({
      sessionId: parentSessionId,
      callId: `list-${page}`,
      toolName: "list_agents",
      toolProfileDigest: "historical-profile",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Historical list did not complete.");
    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(16 * 1024);
    const output = result.output as {
      agents: Array<{
        agentId: string;
        readOnly: true;
        result: { text: string };
        resultTruncated: boolean;
        resultByteCount: number;
      }>;
      nextCursor: string | null;
      counts: { terminal: number };
    };
    expect(output.counts.terminal).toBe(9);
    expect(output.agents.length).toBeGreaterThan(0);
    for (const agent of output.agents) {
      expect(agent.readOnly).toBe(true);
      listed.push(agent.agentId);
      if (agent.agentId !== admission.agentId) {
        expect(agent.resultTruncated).toBe(true);
        expect(agent.resultByteCount).toBe(13998);
        expect(agent.result.text).toMatch(/^界+$/u);
      }
    }
    cursor = output.nextCursor;
    if (cursor === null) break;
  }
  expect(cursor).toBeNull();
  expect(listed).toEqual(expectedIds);
  expect(await journal.read()).toEqual(beforeList);
});

test("historical list rejects malformed cursors and a different execution parent before reading", async () => {
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174154";
  const store = createInMemoryManagedAgentStore();
  const children = createInMemorySessionStoreDirectory<SessionRecord>();
  let reads = 0;
  const tools = createHistoricalManagedAgentToolRegistry({
    profile: "managed-agent-tools.a3-long-lived.v3",
    history: {
      parentSessionId,
      async read() {
        reads += 1;
        return managedAgentSnapshotWithChildHistories({
          records: await store.read(),
          parentSessionId,
          childSessionStores: children,
        });
      },
    },
  });
  const list = tools.resolve("list_agents");
  if (list === undefined) throw new Error("Missing historical list adapter.");
  const identity = { callId: "list", sessionId: parentSessionId, toolName: "list_agents" };
  for (const args of [
    { cursor: "managed-agent:01" },
    { cursor: "managed-agent:-1" },
    { cursor: "other-parent:1" },
    { cursor: "managed-agent:9007199254740992" },
    { limit: 9 },
    { status: "unknown" },
    { parentSessionId: "other" },
  ])
    expect(list.prepare(JSON.stringify(args), identity)).toMatchObject({
      status: "failed",
      error: { code: "invalid_tool_input" },
    });
  expect(list.prepare("{}", { ...identity, sessionId: "other-parent" })).toMatchObject({
    status: "failed",
    error: { code: "managed_agent_unavailable" },
  });
  const prepared = list.prepare("{}", identity);
  if (prepared.status !== "ready") throw new Error("Expected exact historical list admission.");
  expect(
    await prepared.execute({
      ...identity,
      sessionId: "other-parent",
      signal: new AbortController().signal,
      toolProfileDigest: "historical-profile",
    }),
  ).toMatchObject({ status: "failed", error: { code: "managed_agent_unavailable" } });
  expect(reads).toBe(0);
  expect(
    await prepared.execute({
      ...identity,
      signal: new AbortController().signal,
      toolProfileDigest: "historical-profile",
    }),
  ).toEqual({
    status: "completed",
    output: { agents: [], counts: { active: 0, terminal: 0, attention: 0 }, nextCursor: null },
  });
  expect(reads).toBe(1);
  const pastEnd = list.prepare('{"cursor":"managed-agent:1"}', identity);
  if (pastEnd.status !== "ready") throw new Error("Expected structurally valid cursor.");
  expect(
    await pastEnd.execute({
      ...identity,
      signal: new AbortController().signal,
      toolProfileDigest: "historical-profile",
    }),
  ).toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
  expect(await store.read()).toEqual([]);
});
