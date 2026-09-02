import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type AgentSessionDependencies,
  type ArtifactStore,
  createCodingToolRegistry,
  createExtensionHost,
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  createSessionLifecycle,
  type ModelDriver,
  ModelDriverError,
  type ModelRequest,
  type ModelTargets,
  type RuntimeEvent,
} from "@adam-agent/agent";
import {
  createAgentManager,
  createInMemoryManagedAgentStore,
  createInMemorySessionStore,
  createInMemorySessionStoreDirectory,
  createManagedAgentToolRegistry,
  createProjectExecutionDomain,
  createPromptContextV1,
  createTrustedWorkspaceTrustForTesting,
  createWebEvidenceToolRegistry,
  type ManagedAgentDeadlineScheduler,
  ManagedAgentStoreError,
  managedAgentPromptSummary,
  type ProjectLifecycleOwner,
  presentationManagedAgentTranscriptPageSize,
  presentationRuntimeRefreshBarrier,
  recoverInterruptedManagedAgents,
  researchManagedAgentProfileV1,
  type SessionRecord,
  type SessionStore,
  type SessionStoreDirectory,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
  sessionDurableContext,
  sessionManagedAgentInactivityScheduler,
  sessionToolProfileNames,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { withManagedFailureGuard } from "./managed-agent-test-support.js";

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

const thinkingPolicy = {
  schemaVersion: 1,
  requestedLevelId: "high",
  effectiveLevelId: "high",
  capability: {
    id: "deepseek-thinking.v1",
    version: 1,
    digest: `sha256:${"a".repeat(64)}` as const,
  },
  mapping: {
    requestPath: "reasoning.effort",
    thinkingType: "enabled",
    reasoningEffort: "high",
  },
  reasoningArtifact: "provider_reasoning",
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

test("AgentSession spawns one permitted foreground scout and receives its durable result", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-scout-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "foreground scout evidence\n", "utf8");
  const childRequests: ModelRequest[] = [];
  let childCall = 0;
  const childModel: ModelDriver = {
    async *stream(request) {
      childRequests.push(request);
      childCall += 1;
      if (childCall === 1) {
        yield { type: "tool_call_start", id: "child-read", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "child-read",
          json: '{"path":"evidence.txt"}',
        };
        yield { type: "tool_call_end", id: "child-read" };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Scout found foreground scout evidence." };
      yield { type: "usage", inputTokens: 120, outputTokens: 12 };
      yield { type: "finish", reason: "stop" };
    },
  };
  let parentCall = 0;
  let parentToolResult: unknown;
  const parentRequests: ModelRequest[] = [];
  const parentModel: ModelDriver = {
    async *stream(request) {
      parentRequests.push(request);
      parentCall += 1;
      if (parentCall === 1) {
        yield { type: "tool_call_start", id: "spawn-scout", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-scout",
          json: '{"task":"Read evidence.txt and report its exact evidence."}',
        };
        yield { type: "tool_call_end", id: "spawn-scout" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      parentToolResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "The foreground scout completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    thinkingPolicy,
    workspaceRoot,
  });
  const parentStore = createInMemorySessionStore();
  const parentDependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model: parentModel,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["delegate"] }),
    store: parentStore,
    tools: createManagedAgentToolRegistry({ manager }),
    [sessionToolProfileNames]: ["spawn_agent"],
  };
  const parent = new AgentSession(parentDependencies);
  const permissionSubjects: unknown[] = [];
  parent.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissionSubjects.push(event.subject);
      parent.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const result = await parent.run({ text: "Ask one foreground scout for evidence." });
    const managedRecords = await managedStore.read();
    const terminal = managedRecords.find((record) => record.type === "managed_agent_terminal");
    const childSessionId = terminal?.childSessionId;
    const childStore =
      childSessionId === undefined ? undefined : await childSessionStores.open(childSessionId);
    const childRecords = await childStore?.read();

    expect(result).toEqual({ status: "completed", answer: "The foreground scout completed." });
    expect(parentToolResult).toMatchObject({ role: "tool", result: { status: "completed" } });
    expect(permissionSubjects).toEqual([
      expect.objectContaining({
        type: "managed_agent_spawn",
        parentRootId: "parent-session",
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        profile: "scout.v1",
        profileDigest: scoutManagedAgentProfileV1.digest,
        limits: managedLimits,
        targetIdentity,
        thinkingPolicy,
      }),
    ]);
    expect(parentToolResult).toMatchObject({
      role: "tool",
      result: {
        status: "completed",
        output: {
          profile: "scout.v1",
          status: "completed",
          result: { text: "Scout found foreground scout evidence." },
          targetIdentity,
          thinkingPolicy,
          usage: { inputTokens: 220, outputTokens: 32, reasoningTokens: 0 },
          cost: { status: "unavailable" },
          transcript: {
            sessionId: expect.any(String),
            digest: expect.stringMatching(/^sha256:/u),
            throughSequence: expect.any(Number),
          },
        },
      },
    });
    expect(managedRecords.map((record) => record.type)).toEqual([
      "managed_agent_admitted",
      "managed_agent_terminal",
    ]);
    expect(
      childRecords?.findLast(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "session_settled",
      ),
    ).toMatchObject({
      record: {
        event: {
          type: "session_settled",
          result: {
            status: "completed",
            answer: "Scout found foreground scout evidence.",
          },
        },
      },
    });
    expect(childRequests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          callId: "child-read",
          name: "read_file",
          result: {
            status: "completed",
            output: {
              path: "evidence.txt",
              content: "foreground scout evidence\n",
              truncated: false,
            },
          },
        }),
      ]),
    );
    expect(childRequests.every((request) => request.thinkingPolicy === thinkingPolicy)).toBe(true);
    expect(parentRequests[0]?.tools).toEqual([
      expect.objectContaining({
        name: "spawn_agent",
        inputSchema: expect.objectContaining({
          additionalProperties: false,
          required: ["task"],
          properties: { task: expect.any(Object) },
        }),
      }),
    ]);
    expect(childRequests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "search_repository",
    ]);
    expect(await readFile(join(workspaceRoot, "evidence.txt"), "utf8")).toBe(
      "foreground scout evidence\n",
    );
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager current scout crosses the legacy token and provider-call boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-capacity-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "current child evidence\n", "utf8");
  const currentContextProfile = {
    version: 2,
    contextWindowTokens: 1_000_000,
    maximumOutputTokens: 384_000,
    ordinaryOutputReserveTokens: 4_096,
    compactionSummaryMaximumOutputTokens: 32_768,
    compactAtTokens: 900_000,
    postCompactTargetTokens: 200_000,
    retainedTargetTokens: 20_000,
    estimatorVersion: 1,
  } as const;
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      if (providerCalls <= 9) {
        const callId = `read-evidence-${providerCalls}`;
        yield { type: "tool_call_start", id: callId, name: "read_file" };
        yield { type: "tool_call_delta", id: callId, json: '{"path":"evidence.txt"}' };
        yield { type: "tool_call_end", id: callId };
        yield {
          type: "usage",
          inputTokens: 16_000,
          outputTokens: 4,
          reasoningTokens: 2,
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Current scout completed after every read." };
      yield { type: "usage", inputTokens: 16_000, outputTokens: 8, reasoningTokens: 3 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174501";
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const managedStore = createInMemoryManagedAgentStore();
  const baseChildSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  let childReadsUnavailable = false;
  const childSessionStores: SessionStoreDirectory<SessionRecord> = {
    create: (sessionId) => baseChildSessionStores.create(sessionId),
    async open(sessionId) {
      if (childReadsUnavailable) {
        throw new Error("Child transcript reads are unavailable.");
      }
      return baseChildSessionStores.open(sessionId);
    },
    listSessionEntries: () => baseChildSessionStores.listSessionEntries(),
    listSessionIds: () => baseChildSessionStores.listSessionIds(),
  };
  const currentProfileOptions = { builtInProfileVersion: 2 as const };
  const manager = createAgentManager({
    childContextProfile: currentContextProfile,
    childModel,
    childSessionStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
    ...currentProfileOptions,
  });

  try {
    await expect(
      manager.spawnForeground({
        callId: "current-capacity-spawn",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "Read every required evidence step before answering.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: {
        profile: "scout.v2",
        result: { text: "Current scout completed after every read." },
      },
    });
    expect(providerCalls).toBe(10);
    const records = await managedStore.read();
    const admission = records.find((record) => record.type === "managed_agent_admitted");
    expect(admission).toMatchObject({
      profile: "scout.v2",
      limits: {
        maximumTokens: currentContextProfile.contextWindowTokens,
        maximumInactivityMilliseconds: 300_000,
      },
    });
    expect(admission?.limits).not.toHaveProperty("maximumTurns");
    expect(admission).not.toHaveProperty("deadlineAtUnixMilliseconds");
    if (admission?.type !== "managed_agent_admitted") {
      throw new Error("Expected the current managed admission.");
    }
    const childStore = await childSessionStores.open(admission.childSessionId);
    const childRecords = await childStore?.read();
    expect(
      childRecords?.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed" &&
          record.record.event.name === "read_file",
      ),
    ).toHaveLength(9);
    await expect(manager.snapshot()).resolves.toMatchObject({
      agents: [
        {
          profile: "scout.v2",
          context: { contextWindowTokens: 1_000_000 },
          usage: {
            inputTokens: 160_000,
            outputTokens: 44,
            reasoningTokens: 21,
            providerCalls: 10,
          },
          budget: {
            maximumCumulativeTokens: 1_000_000,
            usedTokens: 160_044,
            remainingTokens: 839_956,
          },
          attempts: {
            childAttempts: 1,
            maximumChildAttempts: 4,
            parentAttempts: 1,
            maximumParentAttempts: 16,
          },
          watchdog: { state: "terminal", maximumInactivityMilliseconds: 300_000 },
        },
      ],
    });
    const beforeRecovery = await managedStore.read();
    await recoverInterruptedManagedAgents(managedStore, childSessionStores);
    await expect(managedStore.read()).resolves.toEqual(beforeRecovery);
    childReadsUnavailable = true;
    await expect(manager.snapshot()).resolves.toMatchObject({
      agents: [
        {
          usage: {
            inputTokens: 160_000,
            outputTokens: 44,
            reasoningTokens: 21,
            providerCalls: 10,
          },
          budget: { usedTokens: 160_044, remainingTokens: 839_956 },
        },
      ],
    });
  } finally {
    childReadsUnavailable = false;
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession rejects managed profile selection before permission or child provider work", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-profile-reject-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let childProviderCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      childProviderCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  let parentCall = 0;
  let toolResult: unknown;
  const parentModel: ModelDriver = {
    async *stream(request) {
      parentCall += 1;
      if (parentCall === 1) {
        yield { type: "tool_call_start", id: "invalid-spawn", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "invalid-spawn",
          json: '{"task":"Inspect the repository","profile":"research.v1"}',
        };
        yield { type: "tool_call_end", id: "invalid-spawn" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      toolResult = request.messages.findLast(
        (message) => message.role === "tool" && message.name === "spawn_agent",
      );
      yield { type: "text_delta", text: "The invalid spawn was rejected." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const parentStore = createInMemorySessionStore();
  const parentDependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model: parentModel,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["delegate"] }),
    store: parentStore,
    tools: createManagedAgentToolRegistry({ manager }),
    [sessionToolProfileNames]: ["spawn_agent"],
  };
  const parent = new AgentSession(parentDependencies);
  let permissionRequests = 0;
  parent.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissionRequests += 1;
    }
  });

  try {
    await expect(parent.run({ text: "Try an invalid managed profile." })).resolves.toEqual({
      status: "completed",
      answer: "The invalid spawn was rejected.",
    });
    expect(toolResult).toMatchObject({
      result: { status: "failed", error: { code: "invalid_tool_input" } },
    });
    expect({
      childProviderCalls,
      permissionRequests,
      managedRecords: await managedStore.read(),
    }).toEqual({ childProviderCalls: 0, permissionRequests: 0, managedRecords: [] });
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager records missing child token usage as durable terminal failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-usage-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childModel: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: "Unaccounted child answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await expect(
      manager.spawnForeground({
        callId: "missing-usage-spawn",
        parentSessionId: "123e4567-e89b-42d3-a456-426614174105",
        signal: new AbortController().signal,
        task: "Return an answer without usage.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_failed" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      {
        type: "managed_agent_terminal",
        status: "failed",
        error: { code: "token_usage_missing" },
      },
    ]);
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager records recovery-required before releasing a post-admission failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-post-admission-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let ownerReleases = 0;
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return {
        async release() {
          ownerReleases += 1;
        },
      };
    },
    async run(operation) {
      return operation();
    },
  };
  const unavailableChildStores: SessionStoreDirectory<SessionRecord> = {
    async create() {
      throw new Error("injected child genesis failure");
    },
    async listSessionEntries() {
      return [];
    },
    async listSessionIds() {
      return [];
    },
    async open() {
      return undefined;
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel: { async *stream() {} },
    childSessionStores: unavailableChildStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await expect(
      manager.spawnForeground({
        callId: "post-admission-failure-spawn",
        parentSessionId: "123e4567-e89b-42d3-a456-426614174161",
        signal: new AbortController().signal,
        task: "Fail after durable admission.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_unavailable" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_terminal", status: "recovery_required" },
    ]);
    expect(ownerReleases).toBe(0);
    await parentRoot.release();
    expect(ownerReleases).toBe(1);
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle exposes foreground scout through the exact new-session Tool Profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-lifecycle-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "lifecycle scout evidence\n", "utf8");
  await writeFile(
    join(workspaceRoot, "AGENTS.md"),
    "# Scout repository instruction\n\nReport exact file evidence.\n",
    "utf8",
  );
  const requestCounts = new Map<"child" | "parent", number>();
  let parentToolResult: unknown;
  let parentFirstTools: ModelRequest["tools"] | undefined;
  let childFirstMessages: ModelRequest["messages"] | undefined;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        yield { type: "text_delta", text: "Managed scout session" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Read lifecycle evidence"),
      );
      const kind = child ? "child" : "parent";
      const count = (requestCounts.get(kind) ?? 0) + 1;
      requestCounts.set(kind, count);
      if (kind === "parent" && count === 1) {
        parentFirstTools = request.tools;
        yield { type: "tool_call_start", id: "lifecycle-spawn", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "lifecycle-spawn",
          json: '{"task":"Read lifecycle evidence from evidence.txt."}',
        };
        yield { type: "tool_call_end", id: "lifecycle-spawn" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (kind === "child" && count === 1) {
        childFirstMessages = request.messages;
        yield { type: "tool_call_start", id: "lifecycle-child-read", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "lifecycle-child-read",
          json: '{"path":"evidence.txt"}',
        };
        yield { type: "tool_call_end", id: "lifecycle-child-read" };
        yield { type: "usage", inputTokens: 80, outputTokens: 15 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (kind === "child") {
        yield { type: "text_delta", text: "Scout found lifecycle scout evidence." };
        yield { type: "usage", inputTokens: 100, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentToolResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "Lifecycle foreground scout completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a1.v1",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["delegate"] }),
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const lifecyclePermissionSubjects: unknown[] = [];
  lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      lifecyclePermissionSubjects.push(event.subject);
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await lifecycle.create({ targetIdentity });
    expect(created.promptContext?.toolProfile.definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "spawn_agent" })]),
    );
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Use the foreground scout." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Lifecycle foreground scout completed." },
    });
    expect(parentToolResult).toMatchObject({
      result: {
        status: "completed",
        output: {
          profile: "scout.v1",
          result: { text: "Scout found lifecycle scout evidence." },
          targetIdentity,
        },
      },
    });
    expect(lifecyclePermissionSubjects).toEqual([
      expect.objectContaining({
        type: "managed_agent_spawn",
        parentRootId: `session:${created.sessionId}`,
        parentSessionId: created.sessionId,
        profileDigest: scoutManagedAgentProfileV1.digest,
        limits: managedLimits,
      }),
    ]);
    expect(parentFirstTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "spawn_agent",
          description:
            "Run one foreground read-only scout with fresh bounded context. It cannot run in background, select Skills, write, execute, spawn, inherit extensions, or change its model or permissions.",
        }),
      ]),
    );
    expect(childFirstMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "developer",
          content: expect.stringContaining("Managed child profile scout.v1"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Report exact file evidence."),
        }),
      ]),
    );
    expect(childFirstMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Use the foreground scout." }),
      ]),
    );
    expect(requestCounts).toEqual(
      new Map<"child" | "parent", number>([
        ["parent", 2],
        ["child", 2],
      ]),
    );
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({
      items: [{ sessionId: created.sessionId }],
    });
    await lifecycle.close();
    const requestCountsBeforeResume = new Map(requestCounts);
    cold = createSessionLifecycle({
      managedAgentTools: "managed-agent-tools.a1.v1",
      modelTargets,
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["delegate"],
      }),
      stateRoot,
      workspaceRoot,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    });
    await expect(cold.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
      snapshot: {
        promptContext: {
          toolProfile: {
            definitions: expect.arrayContaining([expect.objectContaining({ name: "spawn_agent" })]),
          },
        },
      },
    });
    expect(requestCounts).toEqual(requestCountsBeforeResume);
  } finally {
    await cold?.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle publishes only current managed profiles in a new v2 Tool Profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-tool-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const currentTargetIdentity = { ...targetIdentity, profileVersion: 3 };
  let modelTools: ModelRequest["tools"] | undefined;
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: currentTargetIdentity,
        driver: {
          async *stream(request) {
            if (request.purpose === "ordinary") {
              modelTools = request.tools;
            }
            yield { type: "text_delta", text: "Current Tool Profile observed." };
            yield { type: "finish", reason: "stop" };
          },
        },
        contextProfile: {
          version: 2,
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 384_000,
          ordinaryOutputReserveTokens: 4_096,
          compactionSummaryMaximumOutputTokens: 32_768,
          compactAtTokens: 900_000,
          postCompactTargetTokens: 200_000,
          retainedTargetTokens: 20_000,
          estimatorVersion: 1,
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: currentTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: {
              version: 2,
              contextWindowTokens: 1_000_000,
              maximumOutputTokens: 384_000,
              ordinaryOutputReserveTokens: 4_096,
              compactionSummaryMaximumOutputTokens: 32_768,
              compactAtTokens: 900_000,
              postCompactTargetTokens: 200_000,
              retainedTargetTokens: 20_000,
              estimatorVersion: 1,
            },
          },
        ],
      };
    },
  };
  const currentTools = { managedAgentTools: "managed-agent-tools.a3-long-lived.v2" as const };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    ...currentTools,
  });

  try {
    const created = await lifecycle.create({ targetIdentity: currentTargetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect the current managed Tool Profile." },
    });
    expect(continued.result).toEqual({
      status: "completed",
      answer: "Current Tool Profile observed.",
    });
    const spawn = modelTools?.find((definition) => definition.name === "spawn_agent");
    const inputSchema = JSON.stringify(spawn?.inputSchema);
    expect(inputSchema).toContain("scout.v2");
    expect(inputSchema).toContain("research.v2");
    expect(inputSchema).not.toContain("scout.v1");
    expect(inputSchema).not.toContain("research.v1");
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager cancels a foreground child through its exact caller signal before terminal link", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childStarted = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream(request) {
      childStarted.resolve();
      if (!request.signal.aborted) {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const controller = new AbortController();

  try {
    const spawning = manager.spawnForeground({
      callId: "cancel-spawn",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174106",
      signal: controller.signal,
      task: "Wait until cancelled.",
    });
    await childStarted.promise;
    controller.abort(new Error("caller cancelled foreground scout"));

    await expect(spawning).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_cancelled" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_terminal", status: "cancelled", reason: "caller" },
    ]);
  } finally {
    controller.abort();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager settles its injected aggregate deadline as durable terminal failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childStarted = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream(request) {
      childStarted.resolve();
      if (!request.signal.aborted) {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  };
  let scheduledDelay: number | undefined;
  let expire = () => {};
  const deadlineScheduler: ManagedAgentDeadlineScheduler = {
    schedule(delayMilliseconds, onDeadline) {
      scheduledDelay = delayMilliseconds;
      expire = onDeadline;
      return { cancel() {} };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    deadlineScheduler,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawning = manager.spawnForeground({
      callId: "deadline-spawn",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174107",
      signal: new AbortController().signal,
      task: "Wait for the aggregate deadline.",
    });
    await childStarted.promise;
    expect(scheduledDelay).toBe(10 * 60 * 1_000);
    expire();

    await expect(spawning).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_deadline_exceeded" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_deadline_expired" },
      {
        type: "managed_agent_terminal",
        status: "failed",
        error: { code: "managed_agent_deadline_exceeded" },
      },
    ]);
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager marks a current child stalled after one causal inactivity window", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-stall-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childStarted = Promise.withResolvers<void>();
  const releaseProgress = Promise.withResolvers<void>();
  const progressProcessed = Promise.withResolvers<void>();
  const releaseCompletion = Promise.withResolvers<void>();
  let childSignal: AbortSignal | undefined;
  const childModel: ModelDriver = {
    async *stream(request) {
      childSignal = request.signal;
      childStarted.resolve();
      await releaseProgress.promise;
      yield { type: "text_delta", text: "Progress resumed after attention." };
      progressProcessed.resolve();
      await releaseCompletion.promise;
      yield { type: "usage", inputTokens: 10, outputTokens: 4 };
      yield { type: "finish", reason: "stop" };
    },
  };
  let scheduledDelay: number | undefined;
  let expire = () => {};
  const scheduled: Array<{ readonly fire: () => void; cancelled: boolean }> = [];
  const inactivityScheduler = {
    schedule(delayMilliseconds: number, onDeadline: () => void) {
      scheduledDelay = delayMilliseconds;
      const entry = { fire: onDeadline, cancelled: false };
      scheduled.push(entry);
      expire = () => {
        if (!entry.cancelled) {
          entry.fire();
        }
      };
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
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
  const parentRoot = await domain.claimRoot({ rootId: "current-stall-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const currentOptions = { builtInProfileVersion: 2 as const, inactivityScheduler };
  const manager = createAgentManager({
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
    ...currentOptions,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "current-stall-spawn",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Wait at one causal provider barrier.",
    });
    if (
      spawned.status !== "completed" ||
      spawned.output === null ||
      typeof spawned.output !== "object" ||
      !("agentId" in spawned.output)
    ) {
      throw new Error("Expected one current background identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = spawned.output["agentId"] as string;
    await childStarted.promise;
    expect(scheduledDelay).toBe(300_000);
    const waiting = manager.wait({
      agentIds: [agentId],
      until: "attention",
      signal: new AbortController().signal,
    });
    expire();
    await expect(waiting).resolves.toMatchObject({
      status: "completed",
      output: {
        counts: { active: 1, attention: 1 },
        agents: [{ agentId, status: "stalled" }],
      },
    });
    expect(childSignal?.aborted).toBe(false);
    expect(await managedStore.read()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "managed_agent_stalled", agentId })]),
    );
    expect(
      (await managedStore.read()).some((record) => record.type === "managed_agent_terminal"),
    ).toBe(false);
    const firstStallRevision = (await manager.snapshot()).agents[0]?.revision;
    releaseProgress.resolve();
    await progressProcessed.promise;
    await expect(manager.snapshot()).resolves.toMatchObject({
      counts: { active: 1, attention: 0 },
      agents: [{ agentId, status: "running", revision: (firstStallRevision ?? 0) + 1 }],
    });
    expect(await managedStore.read()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "managed_agent_resumed", agentId })]),
    );
    const resumedWindow = scheduled.at(-1);
    if (resumedWindow?.cancelled === false) {
      resumedWindow.fire();
    }
    await expect(
      manager.wait({
        agentIds: [agentId],
        until: "attention",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { agents: [{ agentId, status: "stalled" }] },
    });
    expect(
      (await managedStore.read()).filter((record) => record.type === "managed_agent_stalled"),
    ).toHaveLength(2);
  } finally {
    releaseProgress.resolve();
    releaseCompletion.resolve();
    await manager.waitForIdle();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager resets current inactivity after one changed nonempty assistant delta", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-progress-reset-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseDelta = Promise.withResolvers<void>();
  const requestStarted = Promise.withResolvers<void>();
  const deltaProcessed = Promise.withResolvers<void>();
  const releaseReasoning = Promise.withResolvers<void>();
  const reasoningProcessed = Promise.withResolvers<void>();
  const releaseIgnoredDeltas = Promise.withResolvers<void>();
  const ignoredDeltasProcessed = Promise.withResolvers<void>();
  const releaseCompletion = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream() {
      requestStarted.resolve();
      await releaseDelta.promise;
      yield { type: "text_delta", text: "changed progress" };
      deltaProcessed.resolve();
      await releaseIgnoredDeltas.promise;
      yield { type: "text_delta", text: "" };
      yield { type: "text_delta", text: "changed progress" };
      ignoredDeltasProcessed.resolve();
      await releaseReasoning.promise;
      yield {
        type: "reasoning_start",
        id: "current-reasoning",
        artifactType: "provider_reasoning",
      };
      yield { type: "reasoning_delta", id: "current-reasoning", text: "changed reasoning" };
      yield { type: "reasoning_end", id: "current-reasoning" };
      reasoningProcessed.resolve();
      await releaseCompletion.promise;
      yield { type: "usage", inputTokens: 10, outputTokens: 3 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const scheduled: Array<{
    readonly delayMilliseconds: number;
    readonly fire: () => void;
    cancelled: boolean;
  }> = [];
  const inactivityScheduler = {
    schedule(delayMilliseconds: number, onInactivity: () => void) {
      const entry = { delayMilliseconds, fire: onInactivity, cancelled: false };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
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
  const parentRoot = await domain.claimRoot({ rootId: "current-progress-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const currentOptions = { builtInProfileVersion: 2 as const, inactivityScheduler };
  const manager = createAgentManager({
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
    ...currentOptions,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "current-progress-spawn",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Reset only for changed nonempty progress.",
    });
    if (
      spawned.status !== "completed" ||
      spawned.output === null ||
      typeof spawned.output !== "object" ||
      !("agentId" in spawned.output)
    ) {
      throw new Error("Expected one current background identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = spawned.output["agentId"] as string;
    await requestStarted.promise;
    const windowsBeforeDelta = scheduled.length;
    expect(windowsBeforeDelta).toBeGreaterThan(0);
    releaseDelta.resolve();
    await deltaProcessed.promise;
    expect(scheduled).toHaveLength(windowsBeforeDelta + 1);
    const preDeltaWindow = scheduled[windowsBeforeDelta - 1];
    expect(preDeltaWindow).toMatchObject({ delayMilliseconds: 300_000, cancelled: true });
    preDeltaWindow?.fire();
    await expect(manager.snapshot()).resolves.toMatchObject({
      counts: { active: 1, attention: 0 },
      agents: [{ agentId, status: "running" }],
    });
    expect(
      (await managedStore.read()).some((record) => record.type === "managed_agent_stalled"),
    ).toBe(false);
    const windowsAfterChangedDelta = scheduled.length;
    releaseIgnoredDeltas.resolve();
    await ignoredDeltasProcessed.promise;
    expect(scheduled).toHaveLength(windowsAfterChangedDelta);
    releaseReasoning.resolve();
    await reasoningProcessed.promise;
    expect(scheduled).toHaveLength(windowsBeforeDelta + 4);
    expect(
      scheduled.slice(windowsBeforeDelta, windowsBeforeDelta + 3).every((entry) => entry.cancelled),
    ).toBe(true);
  } finally {
    releaseDelta.resolve();
    releaseIgnoredDeltas.resolve();
    releaseReasoning.resolve();
    releaseCompletion.resolve();
    await manager.waitForIdle();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager resets current inactivity across one real tool settlement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-tool-reset-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "tool reset evidence\n", "utf8");
  const secondRequest = Promise.withResolvers<void>();
  const releaseCompletion = Promise.withResolvers<void>();
  let providerCalls = 0;
  let schedulesAtFirstRequest = 0;
  const scheduled: Array<{
    readonly fire: () => void;
    cancelled: boolean;
  }> = [];
  const inactivityScheduler = {
    schedule(_delayMilliseconds: number, onInactivity: () => void) {
      const entry = { fire: onInactivity, cancelled: false };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        schedulesAtFirstRequest = scheduled.length;
        yield { type: "tool_call_start", id: "current-tool-reset", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "current-tool-reset",
          json: '{"path":"evidence.txt"}',
        };
        yield { type: "tool_call_end", id: "current-tool-reset" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      secondRequest.resolve();
      await releaseCompletion.promise;
      yield { type: "text_delta", text: "Tool settlement completed." };
      yield { type: "usage", inputTokens: 12, outputTokens: 4 };
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
  const parentRoot = await domain.claimRoot({ rootId: "current-tool-reset-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const currentOptions = { builtInProfileVersion: 2 as const, inactivityScheduler };
  const manager = createAgentManager({
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
    ...currentOptions,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "current-tool-reset-spawn",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Read one exact file before waiting.",
    });
    if (
      spawned.status !== "completed" ||
      spawned.output === null ||
      typeof spawned.output !== "object" ||
      !("agentId" in spawned.output)
    ) {
      throw new Error("Expected one current background identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = spawned.output["agentId"] as string;
    await secondRequest.promise;
    expect(scheduled.length).toBeGreaterThan(schedulesAtFirstRequest);
    const oldWindow = scheduled[schedulesAtFirstRequest - 1];
    expect(oldWindow?.cancelled).toBe(true);
    if (oldWindow?.cancelled === false) {
      oldWindow.fire();
    }
    await expect(manager.snapshot()).resolves.toMatchObject({
      agents: [{ agentId, status: "running" }],
    });
    expect(
      (await managedStore.read()).some((record) => record.type === "managed_agent_stalled"),
    ).toBe(false);
  } finally {
    releaseCompletion.resolve();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager pauses current inactivity for permission and resumes after the exact decision", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-permission-pause-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const researchTools = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("A denied permission fixture must not publish Web evidence.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("A denied permission fixture must not reach HTTP.");
      },
    },
  });
  const permissionRequested =
    Promise.withResolvers<Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>>();
  const permissionDecided = Promise.withResolvers<void>();
  const scheduled: Array<{
    readonly fire: () => void;
    cancelled: boolean;
  }> = [];
  const inactivityScheduler = {
    schedule(_delayMilliseconds: number, onInactivity: () => void) {
      const entry = { fire: onInactivity, cancelled: false };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        yield { type: "tool_call_start", id: "permission-pause-web", name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: "permission-pause-web",
          json: '{"url":"https://example.com/permission-pause"}',
        };
        yield { type: "tool_call_end", id: "permission-pause-web" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Permission decision resumed progress." };
      yield { type: "usage", inputTokens: 12, outputTokens: 4 };
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
  const parentRoot = await domain.claimRoot({ rootId: "current-permission-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const currentOptions = { builtInProfileVersion: 2 as const, inactivityScheduler };
  const manager = createAgentManager({
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    onChildPermissionEvent(event) {
      if (event.type === "tool_permission_requested") {
        permissionRequested.resolve(event);
      } else if (event.type === "tool_permission_decided") {
        permissionDecided.resolve();
      }
    },
    parentCoordination: { interactive: true },
    parentPermissions: createPermissionPolicy({
      allowedEffects: ["read"],
      askedEffects: ["network"],
    }),
    parentRoot,
    projectId,
    researchTools,
    targetIdentity,
    workspaceRoot,
    ...currentOptions,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "current-permission-spawn",
      parentSessionId: manager.parentSessionId,
      profile: "research.v2",
      signal: new AbortController().signal,
      task: "Request one exact Web permission.",
    });
    if (
      spawned.status !== "completed" ||
      spawned.output === null ||
      typeof spawned.output !== "object" ||
      !("agentId" in spawned.output)
    ) {
      throw new Error("Expected one current background identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = spawned.output["agentId"] as string;
    const request = await permissionRequested.promise;
    const pausedWindow = scheduled.at(-1);
    expect(pausedWindow?.cancelled).toBe(true);
    const schedulesWhilePaused = scheduled.length;
    pausedWindow?.fire();
    await expect(manager.snapshot()).resolves.toMatchObject({
      agents: [
        {
          agentId,
          status: "permission_required",
          watchdog: { state: "paused_permission" },
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            reasoningTokens: 0,
            providerCalls: 1,
          },
          budget: { usedTokens: 13, remainingTokens: 999_987 },
        },
      ],
    });
    expect(scheduled).toHaveLength(schedulesWhilePaused);
    expect(manager.decidePermission({ requestId: request.requestId, decision: "deny" })).toEqual({
      status: "accepted",
    });
    await permissionDecided.promise;
    await manager.snapshot();
    expect(scheduled.length).toBeGreaterThan(schedulesWhilePaused);
    await manager.waitForIdle();
    expect(providerCalls).toBe(2);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager pauses current inactivity while waiting for the exact parent reply", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-parent-pause-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const secondRequest = Promise.withResolvers<void>();
  const releaseCompletion = Promise.withResolvers<void>();
  const scheduled: Array<{ readonly fire: () => void; cancelled: boolean }> = [];
  const inactivityScheduler = {
    schedule(_delayMilliseconds: number, onInactivity: () => void) {
      const entry = { fire: onInactivity, cancelled: false };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        yield { type: "tool_call_start", id: "current-parent-wait", name: "request_parent_input" };
        yield {
          type: "tool_call_delta",
          id: "current-parent-wait",
          json: '{"question":"Which exact evidence should I prioritize?"}',
        };
        yield { type: "tool_call_end", id: "current-parent-wait" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      secondRequest.resolve();
      await releaseCompletion.promise;
      yield { type: "text_delta", text: "Exact parent reply delivered." };
      yield { type: "usage", inputTokens: 12, outputTokens: 4 };
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
  const parentRoot = await domain.claimRoot({ rootId: "current-parent-pause-root" });
  const managedStore = createInMemoryManagedAgentStore();
  const currentOptions = { builtInProfileVersion: 2 as const, inactivityScheduler };
  const manager = createAgentManager({
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentCoordination: { interactive: true },
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
    ...currentOptions,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "current-parent-pause-spawn",
      parentSessionId: manager.parentSessionId,
      profile: "research.v2",
      signal: new AbortController().signal,
      task: "Request one exact parent reply.",
    });
    if (
      spawned.status !== "completed" ||
      spawned.output === null ||
      typeof spawned.output !== "object" ||
      !("agentId" in spawned.output)
    ) {
      throw new Error("Expected one current background identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = spawned.output["agentId"] as string;
    const attention = await manager.wait({
      agentIds: [agentId],
      until: "attention",
      signal: new AbortController().signal,
    });
    if (
      attention.status !== "completed" ||
      attention.output === null ||
      typeof attention.output !== "object" ||
      !("agents" in attention.output) ||
      // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
      !Array.isArray(attention.output["agents"])
    ) {
      throw new Error("Expected one current attention snapshot.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agent = attention.output["agents"][0] as {
      readonly attention: { readonly attentionId: string };
      readonly revision: number;
    };
    const pausedWindow = scheduled.at(-1);
    expect(pausedWindow?.cancelled).toBe(true);
    const schedulesWhilePaused = scheduled.length;
    await expect(
      manager.send({
        agentId,
        expectedRevision: agent.revision,
        attentionId: agent.attention.attentionId,
        callId: "current-parent-pause-reply",
        message: "Prioritize the exact durable evidence.",
      }),
    ).resolves.toMatchObject({ status: "completed", output: { delivery: "enqueued" } });
    await secondRequest.promise;
    expect(scheduled.length).toBeGreaterThan(schedulesWhilePaused);
    if (pausedWindow?.cancelled === false) {
      pausedWindow.fire();
    }
    expect(
      (await managedStore.read()).some((record) => record.type === "managed_agent_stalled"),
    ).toBe(false);
    expect(await managedStore.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "managed_agent_parent_reply_delivered" }),
      ]),
    );
  } finally {
    releaseCompletion.resolve();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager cannot publish completion when deadline expires during artifact durability", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-deadline-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const largeAnswer = `Deadline artifact\n${"z".repeat(20 * 1024)}`;
  const childModel: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: largeAnswer };
      yield { type: "usage", inputTokens: 50, outputTokens: 6_000 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const artifactWriteStarted = Promise.withResolvers<void>();
  const allowArtifactWrite = Promise.withResolvers<void>();
  const artifactStore: ArtifactStore = {
    async write({ bytes, mediaType, source }) {
      artifactWriteStarted.resolve();
      await allowArtifactWrite.promise;
      const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      return { id, mediaType, byteCount: bytes.byteLength, source };
    },
    async read() {
      return undefined;
    },
  };
  let expire = () => {};
  const deadlineScheduler: ManagedAgentDeadlineScheduler = {
    schedule(_delayMilliseconds, onDeadline) {
      expire = onDeadline;
      return { cancel() {} };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    artifactStore,
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    deadlineScheduler,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawning = manager.spawnForeground({
      callId: "deadline-artifact-spawn",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174181",
      signal: new AbortController().signal,
      task: "Return a large result before the deadline.",
    });
    await artifactWriteStarted.promise;
    expire();
    allowArtifactWrite.resolve();

    await expect(spawning).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_deadline_exceeded" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_deadline_expired" },
      {
        type: "managed_agent_terminal",
        status: "failed",
        error: { code: "managed_agent_deadline_exceeded" },
      },
    ]);
  } finally {
    allowArtifactWrite.resolve();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager publishes an oversized completed result through one immutable artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-result-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const largeAnswer = `Managed result\n${"x".repeat(70 * 1024)}`;
  const childModel: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: largeAnswer };
      yield { type: "usage", inputTokens: 100, outputTokens: 20_000 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const storedArtifacts = new Map<string, Uint8Array>();
  const artifactStore: ArtifactStore = {
    async write({ bytes, mediaType, source }) {
      const stored = Uint8Array.from(bytes);
      const id = `sha256:${createHash("sha256").update(stored).digest("hex")}`;
      storedArtifacts.set(id, stored);
      return { id, mediaType, byteCount: stored.byteLength, source };
    },
    async read(id) {
      return storedArtifacts.get(id);
    },
  };
  const manager = createAgentManager({
    artifactStore,
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const result = await manager.spawnForeground({
      callId: "overflow-spawn",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174108",
      signal: new AbortController().signal,
      task: "Return one large result.",
    });
    expect(result).toMatchObject({
      status: "completed",
      output: {
        status: "completed",
        result: {
          artifact: {
            id: expect.stringMatching(/^sha256:/u),
            mediaType: "text/plain; charset=utf-8",
            byteCount: Buffer.byteLength(largeAnswer, "utf8"),
          },
        },
      },
    });
    const output =
      result.status === "completed"
        ? (result.output as { readonly result: { readonly artifact: { readonly id: string } } })
        : undefined;
    if (output === undefined) {
      throw new Error("Expected one Managed Agent result artifact.");
    }
    const bytes = await artifactStore.read(output.result.artifact.id);
    expect(new TextDecoder().decode(bytes)).toBe(largeAnswer);
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      {
        type: "managed_agent_terminal",
        status: "completed",
        result: { artifact: { id: output.result.artifact.id } },
      },
    ]);
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore folds an admitted restart window without child provider replay", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174111",
    attemptId: "123e4567-e89b-42d3-a456-426614174112",
    childSessionId: "123e4567-e89b-42d3-a456-426614174113",
    parentSessionId: "123e4567-e89b-42d3-a456-426614174114",
    parentToolCallId: "restart-window-spawn",
    parentRootId: "session:123e4567-e89b-42d3-a456-426614174114",
    projectId,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest("Interrupted admitted task."),
    childInputDigest: testTaskDigest(`Interrupted admitted task.\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });
  await recoverInterruptedManagedAgents(managedStore);

  expect(await managedStore.read()).toMatchObject([
    { type: "managed_agent_admitted" },
    {
      type: "managed_agent_terminal",
      status: "recovery_required",
      error: { code: "managed_agent_recovery_required" },
    },
  ]);
});

test("ManagedAgentStore fails closed for a current admission without its context genesis", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174504";
  const task = "Reject an unproven current capacity.";
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174501",
    attemptId: "123e4567-e89b-42d3-a456-426614174502",
    childSessionId: "123e4567-e89b-42d3-a456-426614174503",
    parentSessionId,
    parentToolCallId: "unproven-current-capacity",
    parentRootId: `session:${parentSessionId}`,
    projectId,
    profile: "scout.v2",
    mode: "background",
    profileDigest: scoutManagedAgentProfileV2.digest,
    usageAccountingVersion: 2,
    limits: {
      maximumTokens: 2_000_000,
      maximumInactivityMilliseconds: 300_000,
    },
    admittedAtUnixMilliseconds: 1_800_000_000_000,
    taskDigest: testTaskDigest(task),
    childInputDigest: testTaskDigest(`${task}\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_terminal",
    sequence: 2,
    agentId: "123e4567-e89b-42d3-a456-426614174501",
    attemptId: "123e4567-e89b-42d3-a456-426614174502",
    childSessionId: "123e4567-e89b-42d3-a456-426614174503",
    status: "recovery_required",
    recoveryPhase: "pre_genesis",
    error: {
      code: "managed_agent_recovery_required",
      message: "The current child stopped before its context genesis became durable.",
    },
  });

  await recoverInterruptedManagedAgents(managedStore);

  await expect(managedStore.read()).resolves.toMatchObject([
    { type: "managed_agent_admitted", profile: "scout.v2" },
    {
      type: "managed_agent_terminal",
      status: "recovery_required",
    },
    {
      type: "managed_agent_inspection_required",
      error: { code: "managed_agent_inspection_required" },
    },
  ]);
  let providerCalls = 0;
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
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const manager = createAgentManager({
    builtInProfileVersion: 2,
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel: {
      async *stream() {
        providerCalls += 1;
        yield { type: "finish", reason: "stop" };
      },
    },
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot: process.cwd(),
  });
  try {
    await expect(
      manager.followUp({
        agentId: "123e4567-e89b-42d3-a456-426614174501",
        expectedRevision: 3,
        callId: "reject-unproven-current-follow-up",
        parentSessionId,
        signal: new AbortController().signal,
        task: "Do not continue from an unproven current capacity.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    expect(providerCalls).toBe(0);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
  }
});

test("ManagedAgentStore recovers an interrupted research profile without provider replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-research-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childEntered = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      childEntered.resolve();
      await releaseChild.promise;
      yield { type: "text_delta", text: "Original process result." };
      yield { type: "usage", inputTokens: 10, outputTokens: 4 };
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
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174301";
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const liveStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores,
    managedStore: liveStore,
    parentCoordination: { interactive: true },
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await manager.spawnBackground({
      callId: "spawn-research-recovery",
      parentSessionId,
      profile: "research.v1",
      signal: new AbortController().signal,
      task: "Remain at one interrupted research request.",
    });
    await childEntered.promise;
    const admission = (await liveStore.read()).find(
      (record) => record.type === "managed_agent_admitted",
    );
    if (admission?.type !== "managed_agent_admitted") {
      throw new Error("The research admission was not durable.");
    }
    const recoveredStore = createInMemoryManagedAgentStore();
    await recoveredStore.append(admission);
    await recoverInterruptedManagedAgents(recoveredStore, childSessionStores);
    expect(providerCalls).toBe(1);
    expect(await recoveredStore.read()).toMatchObject([
      {
        type: "managed_agent_admitted",
        profile: "research.v1",
        effectiveToolProfileDigest: expect.stringMatching(/^sha256:/u),
      },
      { type: "managed_agent_terminal", status: "recovery_required" },
    ]);
  } finally {
    releaseChild.resolve();
    await manager.waitForIdle();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager starts an explicit post-restart attempt from recovery-required truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-recovery-attempt-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174214";
  const agentId = "123e4567-e89b-42d3-a456-426614174211";
  const recoveryNow = 1_800_000_000_000;
  const managedStore = createInMemoryManagedAgentStore();
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId,
    attemptId: "123e4567-e89b-42d3-a456-426614174212",
    childSessionId: "123e4567-e89b-42d3-a456-426614174213",
    parentSessionId,
    parentToolCallId: "recovery-attempt-spawn",
    parentRootId: `session:${parentSessionId}`,
    projectId,
    profile: "scout.v1",
    mode: "background",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    deadlineAtUnixMilliseconds: recoveryNow + 600_000,
    admittedAtUnixMilliseconds: recoveryNow,
    taskDigest: testTaskDigest("Interrupted recovery task."),
    childInputDigest: testTaskDigest(`Interrupted recovery task.\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });
  await recoverInterruptedManagedAgents(managedStore);
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "text_delta", text: "Recovered by an explicit new attempt." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    now: () => recoveryNow,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    expect(providerCalls).toBe(0);
    await manager.snapshot();
    expect(manager.promptSummary()).toContain("0 active, 1 terminal");
    expect(manager.promptSummary()).toContain(agentId);
    await expect(
      manager.followUp({
        agentId,
        expectedRevision: 2,
        callId: "explicit-recovery-attempt",
        parentSessionId,
        signal: new AbortController().signal,
        task: "Continue only from the last complete boundary.",
      }),
    ).resolves.toMatchObject({ status: "completed", output: { agentId, revision: 3 } });
    await manager.waitForIdle();
    expect(providerCalls).toBe(1);
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_terminal", status: "recovery_required" },
      { type: "managed_agent_admitted", agentId },
      { type: "managed_agent_terminal", agentId, status: "completed" },
    ]);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager rejects follow-up before provider work when a transcript-linked source store is missing", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-missing-follow-up-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174224";
  const agentId = "123e4567-e89b-42d3-a456-426614174221";
  const attemptId = "123e4567-e89b-42d3-a456-426614174222";
  const childSessionId = "123e4567-e89b-42d3-a456-426614174223";
  const managedStore = createInMemoryManagedAgentStore();
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId,
    attemptId,
    childSessionId,
    parentSessionId,
    parentToolCallId: "missing-source-spawn",
    parentRootId: `session:${parentSessionId}`,
    projectId,
    profile: "scout.v1",
    mode: "background",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    admittedAtUnixMilliseconds: 1_800_000_000_000,
    deadlineAtUnixMilliseconds: 1_800_000_600_000,
    taskDigest: testTaskDigest("Missing source task."),
    childInputDigest: testTaskDigest(`Missing source task.\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_terminal",
    sequence: 2,
    agentId,
    attemptId,
    childSessionId,
    status: "completed",
    result: { text: "Source result whose transcript disappeared." },
    transcriptDigest: `sha256:${"a".repeat(64)}`,
    throughSequence: 9,
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0 },
    cost: { status: "unavailable" },
  });
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    now: () => 1_800_000_000_100,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await expect(
      manager.followUp({
        agentId,
        expectedRevision: 2,
        callId: "missing-source-follow-up",
        parentSessionId,
        signal: new AbortController().signal,
        task: "Must fail before provider work.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    expect(providerCalls).toBe(0);
    expect(await managedStore.read()).toHaveLength(2);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

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

test("ManagedAgentStore links a complete child transcript after a terminal-link crash", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const childSessionId = "123e4567-e89b-42d3-a456-426614174123";
  const recoveredTask = "Complete before the manager link.";
  const childStore = await childSessionStores.create(childSessionId);
  const childTools = createReadToolRegistry({ workspaceRoot: process.cwd() });
  const childPromptContext = createPromptContextV1(childTools);
  await childStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: childSessionId,
      projectId,
      targetIdentity,
      contextProfile,
      promptContext: childPromptContext,
    },
  });
  let providerCalls = 0;
  const childDependencies: AgentSessionDependencies & {
    readonly [sessionDurableContext]: {
      readonly nextSequence: number;
      readonly projectId: string;
      readonly promptContext: typeof childPromptContext;
      readonly sessionId: string;
      readonly targetIdentity: typeof targetIdentity;
    };
  } = {
    contextProfile,
    model: {
      async *stream() {
        providerCalls += 1;
        yield { type: "text_delta", text: "Recovered completed scout result." };
        yield { type: "usage", inputTokens: 30, outputTokens: 8 };
        yield { type: "finish", reason: "stop" };
      },
    },
    store: childStore as SessionStore,
    tools: childTools,
    [sessionDurableContext]: {
      nextSequence: 2,
      projectId,
      promptContext: childPromptContext,
      sessionId: childSessionId,
      targetIdentity,
    },
  };
  const child = new AgentSession(childDependencies);
  await child.run(
    { text: `${recoveredTask}\n\n${childLiveWorkspaceNotice}` },
    { limits: { maxTurns: 8, maxTokens: 128_000 } },
  );
  const childRecordsBeforeCompaction = await childStore.read();
  await childStore.append({
    schemaVersion: 3,
    sequence: childRecordsBeforeCompaction.length + 1,
    record: {
      type: "context_compaction_interrupted",
      recordVersion: 1,
      runId: "123e4567-e89b-42d3-a456-426614174125",
      attemptId: "123e4567-e89b-42d3-a456-426614174126",
      attemptNumber: 1,
      windowNumber: 1,
      trigger: "automatic_threshold",
      sourceThrough: 1,
      reason: "caller_cancelled",
      usage: { inputTokens: 11, outputTokens: 3, reasoningTokens: 2 },
    },
  });
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174121",
    attemptId: "123e4567-e89b-42d3-a456-426614174122",
    childSessionId,
    parentSessionId: "123e4567-e89b-42d3-a456-426614174124",
    parentToolCallId: "terminal-link-window-spawn",
    parentRootId: "session:123e4567-e89b-42d3-a456-426614174124",
    projectId,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest(recoveredTask),
    childInputDigest: testTaskDigest(`${recoveredTask}\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });

  await recoverInterruptedManagedAgents(managedStore, childSessionStores);

  expect(providerCalls).toBe(1);
  expect(await managedStore.read()).toMatchObject([
    { type: "managed_agent_admitted" },
    {
      type: "managed_agent_terminal",
      status: "completed",
      result: { text: "Recovered completed scout result." },
      transcriptDigest: expect.stringMatching(/^sha256:/u),
      throughSequence: expect.any(Number),
      usage: { inputTokens: 41, outputTokens: 11, reasoningTokens: 2 },
      cost: { status: "unavailable" },
    },
  ]);
});

test("ManagedAgentStore requires inspection for a child genesis with a different project identity", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const childSessionId = "123e4567-e89b-42d3-a456-426614174173";
  const childStore = await childSessionStores.create(childSessionId);
  const childTools = createReadToolRegistry({ workspaceRoot: process.cwd() });
  await childStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: childSessionId,
      projectId,
      targetIdentity,
      contextProfile,
      promptContext: createPromptContextV1(childTools),
    },
  });
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174174";
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174171",
    attemptId: "123e4567-e89b-42d3-a456-426614174172",
    childSessionId,
    parentSessionId,
    parentToolCallId: "identity-mismatch-spawn",
    parentRootId: `session:${parentSessionId}`,
    projectId: `sha256:${"9".repeat(64)}`,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest("Inspect a mismatched child identity."),
    childInputDigest: testTaskDigest(
      `Inspect a mismatched child identity.\n\n${childLiveWorkspaceNotice}`,
    ),
    targetIdentity,
  });

  await recoverInterruptedManagedAgents(managedStore, childSessionStores);

  expect(await managedStore.read()).toMatchObject([
    { type: "managed_agent_admitted" },
    {
      type: "managed_agent_terminal",
      status: "inspection_required",
      error: { code: "managed_agent_inspection_required" },
    },
  ]);
});

test("ManagedAgentStore preserves a durable deadline between child genesis and logical run", async () => {
  const managedStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const childSessionId = "123e4567-e89b-42d3-a456-426614174193";
  const childStore = await childSessionStores.create(childSessionId);
  const childTools = createReadToolRegistry({ workspaceRoot: process.cwd() });
  await childStore.append({
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "session_genesis",
      recordVersion: 2,
      sessionId: childSessionId,
      projectId,
      targetIdentity,
      contextProfile,
      promptContext: createPromptContextV1(childTools),
    },
  });
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174194";
  const agentId = "123e4567-e89b-42d3-a456-426614174191";
  const attemptId = "123e4567-e89b-42d3-a456-426614174192";
  const task = "Expire before the child logical run.";
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_admitted",
    sequence: 1,
    agentId,
    attemptId,
    childSessionId,
    parentSessionId,
    parentToolCallId: "pre-run-deadline-spawn",
    parentRootId: `session:${parentSessionId}`,
    projectId,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: managedLimits,
    taskDigest: testTaskDigest(task),
    childInputDigest: testTaskDigest(`${task}\n\n${childLiveWorkspaceNotice}`),
    targetIdentity,
  });
  await managedStore.append({
    schemaVersion: 1,
    type: "managed_agent_deadline_expired",
    sequence: 2,
    agentId,
    attemptId,
    childSessionId,
  });

  await recoverInterruptedManagedAgents(managedStore, childSessionStores);

  expect(await managedStore.read()).toMatchObject([
    { type: "managed_agent_admitted" },
    { type: "managed_agent_deadline_expired" },
    {
      type: "managed_agent_terminal",
      status: "failed",
      error: { code: "managed_agent_deadline_exceeded" },
    },
  ]);
});

test("AgentManager rejects a ninth foreground identity before child provider work", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-identity-cap-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "text_delta", text: "Bounded scout result." };
      yield { type: "usage", inputTokens: 20, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174131";

  try {
    for (let index = 0; index < 8; index += 1) {
      await expect(
        manager.spawnForeground({
          callId: `bounded-spawn-${index + 1}`,
          parentSessionId,
          signal: new AbortController().signal,
          task: `Run bounded scout ${index + 1}.`,
        }),
      ).resolves.toMatchObject({ status: "completed" });
    }
    await expect(
      manager.spawnForeground({
        callId: "bounded-spawn-9",
        parentSessionId,
        signal: new AbortController().signal,
        task: "Run forbidden ninth scout.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_capacity_exceeded" },
    });
    expect(providerCalls).toBe(8);
    expect(
      (await managedStore.read()).filter((record) => record.type === "managed_agent_admitted"),
    ).toHaveLength(8);
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager bounds an eight-result list below the aggregate tool envelope", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-list-bound-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childModel: ModelDriver = {
    async *stream() {
      yield { type: "text_delta", text: `Large bounded result ${"x".repeat(8 * 1024)}` };
      yield { type: "usage", inputTokens: 10, outputTokens: 2_000 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "bounded-list-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    for (let index = 0; index < 8; index += 1) {
      await manager.spawnForeground({
        callId: `bounded-list-${index + 1}`,
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: `Return result ${index + 1}.`,
      });
    }
    const listed = await manager.list({ limit: 8 });
    expect(listed).toMatchObject({
      status: "completed",
      output: {
        agents: Array.from({ length: 8 }, () => ({ resultTruncated: true })),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThanOrEqual(16 * 1024);
    await expect(manager.list({ limit: 1 })).resolves.toMatchObject({
      status: "completed",
      output: {
        agents: [{ resultTruncated: false, result: { text: expect.stringContaining("x") } }],
      },
    });
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager hard-denies child read when the current parent ceiling does not allow it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-parent-ceiling-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "secret.txt"), "must not be returned\n", "utf8");
  let childCall = 0;
  let childToolResult: unknown;
  const childModel: ModelDriver = {
    async *stream(request) {
      childCall += 1;
      if (childCall === 1) {
        yield { type: "tool_call_start", id: "denied-child-read", name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: "denied-child-read",
          json: '{"path":"secret.txt"}',
        };
        yield { type: "tool_call_end", id: "denied-child-read" };
        yield { type: "usage", inputTokens: 40, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      childToolResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "The parent ceiling denied the read." };
      yield { type: "usage", inputTokens: 50, outputTokens: 8 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "parent-session" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await expect(
      manager.spawnForeground({
        callId: "parent-ceiling-spawn",
        parentSessionId: "123e4567-e89b-42d3-a456-426614174141",
        signal: new AbortController().signal,
        task: "Attempt the parent-denied read.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { result: { text: "The parent ceiling denied the read." } },
    });
    expect(childToolResult).toMatchObject({
      result: { status: "failed", error: { code: "permission_denied" } },
    });
    expect(JSON.stringify(childToolResult)).not.toContain("must not be returned");
  } finally {
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession controls two background scouts across turns while their claims fence other roots", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-background-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childReleases = new Map<string, () => void>();
  const childEntered = new Map<string, Promise<void>>();
  const childEnteredResolvers = new Map<string, () => void>();
  for (const task of ["background-one", "background-two"]) {
    childEntered.set(
      task,
      new Promise<void>((resolve) => {
        childEnteredResolvers.set(task, resolve);
      }),
    );
  }
  const childModel: ModelDriver = {
    async *stream(request) {
      const content = request.messages.findLast((message) => message.role === "user")?.content;
      const task = typeof content === "string" ? content : "";
      const taskId = task.startsWith("background-one")
        ? "background-one"
        : task.startsWith("background-two")
          ? "background-two"
          : "unknown";
      childEnteredResolvers.get(taskId)?.();
      await new Promise<void>((resolve) => {
        childReleases.set(taskId, resolve);
        if (request.signal.aborted) {
          resolve();
        } else {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      if (request.signal.aborted) {
        return;
      }
      yield { type: "text_delta", text: `${taskId} complete` };
      yield { type: "usage", inputTokens: 10, outputTokens: 3 };
      yield { type: "finish", reason: "stop" };
    },
  };
  let parentCall = 0;
  let activeSummaries: readonly { readonly agentId: string; readonly revision: number }[] = [];
  const parentModel: ModelDriver = {
    async *stream(request) {
      parentCall += 1;
      if (parentCall === 1) {
        for (const [id, task] of [
          ["spawn-background-one", "background-one"],
          ["spawn-background-two", "background-two"],
        ] as const) {
          yield { type: "tool_call_start", id, name: "spawn_agent" };
          yield { type: "tool_call_delta", id, json: JSON.stringify({ task, mode: "background" }) };
          yield { type: "tool_call_end", id };
        }
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCall === 2) {
        yield { type: "text_delta", text: "Both background scouts started." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCall === 3) {
        yield { type: "tool_call_start", id: "list-active", name: "list_agents" };
        yield { type: "tool_call_delta", id: "list-active", json: "{}" };
        yield { type: "tool_call_end", id: "list-active" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCall === 4) {
        const tool = request.messages.findLast((message) => message.role === "tool");
        const output =
          tool?.role === "tool" && tool.result.status === "completed"
            ? tool.result.output
            : undefined;
        const agents =
          output !== null && typeof output === "object" && "agents" in output
            ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
              output["agents"]
            : undefined;
        activeSummaries = Array.isArray(agents)
          ? (agents as readonly { readonly agentId: string; readonly revision: number }[])
          : [];
        yield { type: "text_delta", text: "Two active scouts listed." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCall === 5) {
        const first = activeSummaries[0];
        if (first === undefined) {
          throw new Error("The active child summary was not available.");
        }
        yield { type: "tool_call_start", id: "cancel-first", name: "cancel_agent" };
        yield {
          type: "tool_call_delta",
          id: "cancel-first",
          json: JSON.stringify({ agentId: first.agentId, expectedRevision: first.revision }),
        };
        yield { type: "tool_call_end", id: "cancel-first" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "One scout cancelled." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({
    rootId: "session:123e4567-e89b-42d3-a456-426614174151",
  });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const backgroundParentStore = createInMemorySessionStore();
  const parentDependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model: parentModel,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    store: backgroundParentStore,
    tools: createManagedAgentToolRegistry({
      manager,
      profile: "managed-agent-tools.a2-long-lived.v1",
    }),
    [sessionToolProfileNames]: ["spawn_agent", "list_agents", "cancel_agent"],
  };
  const parent = new AgentSession(parentDependencies);

  try {
    await expect(parent.run({ text: "Start two background scouts." })).resolves.toMatchObject({
      status: "completed",
    });
    await Promise.all([childEntered.get("background-one"), childEntered.get("background-two")]);
    await parentRoot.release();
    await expect(parent.run({ text: "List the active scouts." })).resolves.toMatchObject({
      status: "completed",
    });
    expect(activeSummaries).toHaveLength(2);
    await expect(
      manager.spawnBackground({
        callId: "spawn-over-capacity",
        parentSessionId: "00000000-0000-4000-8000-000000000001",
        signal: new AbortController().signal,
        task: "background-three",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_capacity_exceeded" },
    });
    const cancelledForeground = new AbortController();
    cancelledForeground.abort(new Error("Capacity must reject before cancellation handling."));
    await expect(
      manager.spawnForeground({
        callId: "foreground-over-capacity",
        parentSessionId: manager.parentSessionId,
        signal: cancelledForeground.signal,
        task: "foreground-three",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_capacity_exceeded" },
    });
    await expect(domain.claimRoot({ rootId: "different-session" })).rejects.toMatchObject({
      code: "root_conflict",
    });
    await expect(parent.run({ text: "Cancel the first scout." })).resolves.toMatchObject({
      status: "completed",
    });
    childReleases.get("background-two")?.();
    await expect(manager.waitForIdle()).resolves.toBeUndefined();
    const otherRoot = await domain.claimRoot({ rootId: "different-session" });
    await otherRoot.release();
  } finally {
    childReleases.get("background-one")?.();
    childReleases.get("background-two")?.();
    await manager.waitForIdle();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession delivers one durable parent message only at the child next model request", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-mailbox-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "mailbox evidence\n", "utf8");
  const firstChildRequestEntered = Promise.withResolvers<void>();
  const releaseFirstChildRequest = Promise.withResolvers<void>();
  const secondChildRequestEntered = Promise.withResolvers<void>();
  const childRequests: ModelRequest[] = [];
  const deliveryOrder: string[] = [];
  const childModel: ModelDriver = {
    async *stream(request) {
      childRequests.push(request);
      if (childRequests.length === 1) {
        firstChildRequestEntered.resolve();
        await releaseFirstChildRequest.promise;
        yield { type: "tool_call_start", id: "child-read", name: "read_file" };
        yield { type: "tool_call_delta", id: "child-read", json: '{"path":"evidence.txt"}' };
        yield { type: "tool_call_end", id: "child-read" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      deliveryOrder.push("provider-dispatch");
      secondChildRequestEntered.resolve();
      yield { type: "text_delta", text: "Parent message observed on the next request." };
      yield { type: "usage", inputTokens: 12, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  let parentCall = 0;
  let agentId = "";
  let parentSendResult: unknown;
  const parentRequests: ModelRequest[] = [];
  const parentModel: ModelDriver = {
    async *stream(request) {
      parentRequests.push(request);
      parentCall += 1;
      if (parentCall === 1) {
        yield { type: "tool_call_start", id: "send-mailbox-message", name: "send_agent_message" };
        yield {
          type: "tool_call_delta",
          id: "send-mailbox-message",
          json: JSON.stringify({
            agentId,
            expectedRevision: 1,
            message: "Use the exact parent mailbox evidence.",
          }),
        };
        yield { type: "tool_call_end", id: "send-mailbox-message" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      parentSendResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "The message was durably queued." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174421";
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const durableManagedStore = createInMemoryManagedAgentStore();
  const managedStore = {
    async append(record: Parameters<typeof durableManagedStore.append>[0]) {
      await durableManagedStore.append(record);
      if (record.type === "managed_agent_parent_message_delivered") {
        deliveryOrder.push("delivered-ack");
      }
    },
    read: () => durableManagedStore.read(),
  };
  const durableChildStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const instrumentedChildStores = new Map<string, SessionStore<SessionRecord>>();
  const instrumentChildStore = (
    store: SessionStore<SessionRecord>,
  ): SessionStore<SessionRecord> => ({
    async append(record) {
      await store.append(record);
      if (
        record.schemaVersion === 3 &&
        record.record.type === "provider_attempt_started" &&
        (record.record.managedAgentDeliveries?.length ?? 0) > 0
      ) {
        deliveryOrder.push("request-start");
      }
    },
    async appendBatch(records) {
      await store.appendBatch(records);
      for (const record of records) {
        if (
          record.schemaVersion === 3 &&
          record.record.type === "provider_attempt_started" &&
          (record.record.managedAgentDeliveries?.length ?? 0) > 0
        ) {
          deliveryOrder.push("request-start");
        }
      }
    },
    read: () => store.read(),
  });
  const childSessionStores: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      const store = instrumentChildStore(await durableChildStores.create(sessionId));
      instrumentedChildStores.set(sessionId, store);
      return store;
    },
    listSessionEntries: () => durableChildStores.listSessionEntries(),
    listSessionIds: () => durableChildStores.listSessionIds(),
    async open(sessionId) {
      const existing = instrumentedChildStores.get(sessionId);
      if (existing !== undefined) {
        return existing;
      }
      const opened = await durableChildStores.open(sessionId);
      if (opened === undefined) {
        return undefined;
      }
      const store = instrumentChildStore(opened);
      instrumentedChildStores.set(sessionId, store);
      return store;
    },
  };
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const parentStore = createInMemorySessionStore();
  const parentDependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model: parentModel,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    store: parentStore,
    tools: createManagedAgentToolRegistry({
      manager,
      profile: "managed-agent-tools.a3-long-lived.v1",
    }),
    [sessionToolProfileNames]: [
      "spawn_agent",
      "list_agents",
      "wait_agents",
      "follow_up_agent",
      "cancel_agent",
      "send_agent_message",
    ],
  };
  const parent = new AgentSession(parentDependencies);

  try {
    const admission = await manager.spawnBackground({
      callId: "spawn-mailbox-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Read evidence.txt after the first request.",
    });
    if (
      admission.status !== "completed" ||
      admission.output === null ||
      typeof admission.output !== "object" ||
      !("agentId" in admission.output)
    ) {
      throw new Error("The background child identity was not returned.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    agentId = String(admission.output["agentId"]);
    await firstChildRequestEntered.promise;
    expect(JSON.stringify(childRequests[0]?.messages)).not.toContain(
      "Use the exact parent mailbox evidence.",
    );
    await expect(
      parent.run({ text: "Send the active child one bounded message." }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(parentRequests[0]?.tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "list_agents",
      "wait_agents",
      "follow_up_agent",
      "cancel_agent",
      "send_agent_message",
    ]);
    const waitDefinition = parentRequests[0]?.tools.find((tool) => tool.name === "wait_agents");
    const spawnDefinition = parentRequests[0]?.tools.find((tool) => tool.name === "spawn_agent");
    expect(JSON.stringify(spawnDefinition?.inputSchema)).toContain("research.v1");
    expect(JSON.stringify(spawnDefinition?.inputSchema)).toContain("skills");
    expect(waitDefinition).toMatchObject({
      description:
        "Wait causally for selected managed children to reach terminal state or request parent attention. Cancelling this wait does not cancel a child.",
    });
    expect(JSON.stringify(waitDefinition?.inputSchema)).toContain("attention");
    expect(parentSendResult, JSON.stringify(parentSendResult)).toMatchObject({
      role: "tool",
      result: { status: "completed", output: { delivery: "enqueued" } },
    });
    const concurrent = await Promise.all([
      manager.send({
        agentId,
        expectedRevision: 2,
        callId: "send-mailbox-concurrent-a",
        message: "Second queued message.",
      }),
      manager.send({
        agentId,
        expectedRevision: 2,
        callId: "send-mailbox-concurrent-b",
        message: "Only one concurrent message may become durable.",
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "failed")).toMatchObject([
      { error: { code: "invalid_tool_input" } },
    ]);
    for (const [index, message] of ["Third queued message.", "Fourth queued message."].entries()) {
      await expect(
        manager.send({
          agentId,
          expectedRevision: index + 3,
          callId: `send-mailbox-${index + 3}`,
          message,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        output: { delivery: "enqueued", revision: index + 4 },
      });
    }
    await expect(
      manager.send({
        agentId,
        expectedRevision: 5,
        callId: "send-mailbox-overflow",
        message: "This fifth ordinary message must not be dropped or admitted.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    expect(
      (await managedStore.read()).filter(
        (record) => record.type === "managed_agent_parent_message_enqueued",
      ),
    ).toHaveLength(4);
    releaseFirstChildRequest.resolve();
    await secondChildRequestEntered.promise;
    expect(JSON.stringify(childRequests[1]?.messages)).toContain(
      "Use the exact parent mailbox evidence.",
    );
    expect(JSON.stringify(childRequests[1]?.messages)).toContain("Fourth queued message.");
    const requestStartIndex = deliveryOrder.indexOf("request-start");
    const providerDispatchIndex = deliveryOrder.indexOf("provider-dispatch");
    const deliveredIndexes = deliveryOrder.flatMap((event, index) =>
      event === "delivered-ack" ? [index] : [],
    );
    expect(requestStartIndex).toBeGreaterThanOrEqual(0);
    expect(deliveredIndexes).toHaveLength(4);
    expect(deliveredIndexes.every((index) => index > requestStartIndex)).toBe(true);
    expect(deliveredIndexes.every((index) => index < providerDispatchIndex)).toBe(true);
    const originalMessage = (await durableManagedStore.read()).find(
      (record) =>
        record.type === "managed_agent_parent_message_enqueued" &&
        record.parentToolCallId === "send-mailbox-message",
    );
    if (
      originalMessage?.type !== "managed_agent_parent_message_enqueued" ||
      originalMessage.sourceRunId === undefined ||
      originalMessage.sourceTurn === undefined ||
      originalMessage.sourceProviderAttempt === undefined
    ) {
      throw new Error("The exact parent message identity was unavailable.");
    }
    await expect(
      manager.send({
        agentId,
        expectedRevision: 1,
        callId: "send-mailbox-message",
        message: "Use the exact parent mailbox evidence.",
        sourceRunId: originalMessage.sourceRunId,
        sourceTurn: originalMessage.sourceTurn,
        sourceProviderAttempt: originalMessage.sourceProviderAttempt,
      }),
    ).resolves.toMatchObject({ status: "completed", output: { delivery: "delivered" } });
    await expect(
      manager.send({
        agentId,
        expectedRevision: 1,
        callId: "send-mailbox-message",
        message: "Reusing one effect identity with different bytes must fail closed.",
        sourceRunId: originalMessage.sourceRunId,
        sourceTurn: originalMessage.sourceTurn,
        sourceProviderAttempt: originalMessage.sourceProviderAttempt,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_unavailable" },
    });
    await manager.waitForIdle();
    const managerRecords = await durableManagedStore.read();
    const parentRecords = await parentStore.read();
    const corruptedParentJson = JSON.stringify(parentRecords).replace(
      `"output":{"agentId":"${agentId}","attemptId"`,
      '"output":{"attemptId"',
    );
    expect(corruptedParentJson).not.toBe(JSON.stringify(parentRecords));
    const corruptedParentRecords = JSON.parse(corruptedParentJson) as SessionRecord[];
    const recoveryStore = createInMemoryManagedAgentStore();
    for (const record of managerRecords) {
      await recoveryStore.append(record);
    }
    await recoverInterruptedManagedAgents(
      recoveryStore,
      durableChildStores,
      undefined,
      parentSessionId,
      Date.now,
      corruptedParentRecords,
    );
    expect(await recoveryStore.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "managed_agent_inspection_required" }),
      ]),
    );
  } finally {
    releaseFirstChildRequest.resolve();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager distinguishes one reused parent tool-call ID across source model attempts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-source-attempt-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childEntered = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream(request) {
      childEntered.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
  const parentRoot = await domain.claimRoot({ rootId: "source-attempt-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "spawn-source-attempt-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Hold one source-attempt child.",
    });
    const agentId =
      spawned.status === "completed" &&
      spawned.output !== null &&
      typeof spawned.output === "object" &&
      "agentId" in spawned.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          String(spawned.output["agentId"])
        : "";
    await childEntered.promise;
    const first = await manager.send({
      agentId,
      expectedRevision: 1,
      callId: "reused-provider-call",
      message: "First source model attempt.",
      sourceRunId: "123e4567-e89b-42d3-a456-426614174431",
      sourceTurn: 1,
      sourceProviderAttempt: 1,
    });
    const second = await manager.send({
      agentId,
      expectedRevision: 2,
      callId: "reused-provider-call",
      message: "Second source model attempt.",
      sourceRunId: "123e4567-e89b-42d3-a456-426614174432",
      sourceTurn: 1,
      sourceProviderAttempt: 1,
    });
    expect(first).toMatchObject({ status: "completed", output: { delivery: "enqueued" } });
    expect(second).toMatchObject({ status: "completed", output: { delivery: "enqueued" } });
    if (first.status !== "completed" || second.status !== "completed") {
      throw new Error("Both distinct source attempts must be admitted.");
    }
    const firstMessageId =
      first.output !== null && typeof first.output === "object" && "messageId" in first.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          first.output["messageId"]
        : undefined;
    const secondMessageId =
      second.output !== null && typeof second.output === "object" && "messageId" in second.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          second.output["messageId"]
        : undefined;
    expect(firstMessageId).toMatch(/^sha256:/u);
    expect(secondMessageId).toMatch(/^sha256:/u);
    expect(firstMessageId).not.toBe(secondMessageId);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession holds one attention barrier until the exact parent reply", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-attention-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const secondRequestEntered = Promise.withResolvers<void>();
  const childRequests: ModelRequest[] = [];
  const childModel: ModelDriver = {
    async *stream(request) {
      childRequests.push(request);
      if (childRequests.length === 1) {
        expect(request.tools.map((tool) => tool.name)).toEqual([
          "read_file",
          "search_repository",
          "report_to_parent",
          "request_parent_input",
        ]);
        yield { type: "tool_call_start", id: "report-progress", name: "report_to_parent" };
        yield {
          type: "tool_call_delta",
          id: "report-progress",
          json: '{"kind":"finding","message":"Durable evidence located."}',
        };
        yield { type: "tool_call_end", id: "report-progress" };
        yield { type: "tool_call_start", id: "request-parent", name: "request_parent_input" };
        yield {
          type: "tool_call_delta",
          id: "request-parent",
          json: '{"question":"Which exact evidence should I prioritize?"}',
        };
        yield { type: "tool_call_end", id: "request-parent" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      secondRequestEntered.resolve();
      expect(
        request.messages.find(
          (message) => message.role === "tool" && message.callId === "report-progress",
        ),
      ).toMatchObject({
        role: "tool",
        result: { status: "completed", output: { status: "reported" } },
      });
      expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
        role: "tool",
        callId: "request-parent",
        result: {
          status: "completed",
          output: { reply: "Prioritize the durable mailbox evidence.", revision: 4 },
        },
      });
      yield { type: "text_delta", text: "Exact parent reply applied." };
      yield { type: "usage", inputTokens: 12, outputTokens: 4 };
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
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174401";
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const durableManagedStore = createInMemoryManagedAgentStore();
  const reportAppendDurable = Promise.withResolvers<void>();
  const releaseReportAppend = Promise.withResolvers<void>();
  let failReplyNotificationRead = false;
  const managedStore = {
    async append(record: Parameters<typeof durableManagedStore.append>[0]) {
      await durableManagedStore.append(record);
      if (record.type === "managed_agent_child_reported") {
        reportAppendDurable.resolve();
        await releaseReportAppend.promise;
      }
      if (record.type === "managed_agent_parent_reply_enqueued") {
        failReplyNotificationRead = true;
      }
    },
    async read() {
      if (failReplyNotificationRead) {
        failReplyNotificationRead = false;
        throw new Error("Injected failure after the reply became durable.");
      }
      return durableManagedStore.read();
    },
  };
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    parentCoordination: { interactive: true },
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "spawn-attention-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Request one exact parent decision.",
    });
    expect(spawned).toMatchObject({ status: "completed", output: { status: "running" } });
    const agentId =
      spawned.status === "completed" &&
      spawned.output !== null &&
      typeof spawned.output === "object" &&
      "agentId" in spawned.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          String(spawned.output["agentId"])
        : "";
    const childSessionId =
      spawned.status === "completed" &&
      spawned.output !== null &&
      typeof spawned.output === "object" &&
      "childSessionId" in spawned.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          String(spawned.output["childSessionId"])
        : "";
    await reportAppendDurable.promise;
    const sourceCrashStore = createInMemoryManagedAgentStore();
    for (const record of await durableManagedStore.read()) {
      await sourceCrashStore.append(record);
    }
    await recoverInterruptedManagedAgents(sourceCrashStore, childSessionStores);
    expect(await sourceCrashStore.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "managed_agent_child_reported" }),
        expect.objectContaining({ type: "managed_agent_terminal", status: "recovery_required" }),
      ]),
    );
    expect(childRequests).toHaveLength(1);
    releaseReportAppend.resolve();
    const attention = await manager.wait({
      agentIds: [agentId],
      until: "attention",
      signal: new AbortController().signal,
    });
    expect(attention).toMatchObject({
      status: "completed",
      output: {
        counts: { active: 1, terminal: 0, attention: 1 },
        agents: [
          {
            agentId,
            status: "waiting_for_parent",
            revision: 3,
            attention: { question: "Which exact evidence should I prioritize?" },
          },
        ],
      },
    });
    expect(manager.promptSummary()).toContain("1 need attention");
    const stoppedTerminalWait = new AbortController();
    stoppedTerminalWait.abort(new Error("Stop only this terminal wait."));
    await expect(
      manager.wait({
        agentIds: [agentId],
        until: "all_terminal",
        signal: stoppedTerminalWait.signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_cancelled" },
    });
    await expect(manager.snapshot()).resolves.toMatchObject({
      agents: [
        {
          agentId,
          status: "waiting_for_parent",
          reports: [
            {
              kind: "finding",
              message: "Durable evidence located.",
              messageTruncated: false,
            },
          ],
        },
      ],
    });
    const snapshot = await manager.snapshot();
    const attentionId = snapshot.agents[0]?.attention?.attentionId ?? "";
    await expect(
      manager.send({
        agentId,
        expectedRevision: 3,
        callId: "ordinary-while-waiting",
        message: "An ordinary message cannot consume the reserved reply slot.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    await expect(
      manager.send({
        agentId,
        expectedRevision: 3,
        callId: "wrong-attention-reply",
        attentionId: "00000000-0000-4000-8000-000000000099",
        message: "This stale reply must resolve nothing.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    expect(childRequests).toHaveLength(1);
    const unrelatedAgentId = "123e4567-e89b-42d3-a456-426614174411";
    const unrelatedAttemptId = "123e4567-e89b-42d3-a456-426614174412";
    const unrelatedChildSessionId = "123e4567-e89b-42d3-a456-426614174413";
    const unrelatedSequence = (await durableManagedStore.read()).length + 1;
    await durableManagedStore.append({
      schemaVersion: 1,
      type: "managed_agent_admitted",
      sequence: unrelatedSequence,
      agentId: unrelatedAgentId,
      attemptId: unrelatedAttemptId,
      childSessionId: unrelatedChildSessionId,
      parentSessionId,
      parentToolCallId: "unrelated-interleaved-admission",
      parentRootId: `session:${parentSessionId}`,
      projectId,
      profile: "scout.v1",
      mode: "background",
      profileDigest: scoutManagedAgentProfileV1.digest,
      limits: managedLimits,
      deadlineAtUnixMilliseconds: 1_900_000_600_000,
      admittedAtUnixMilliseconds: 1_900_000_000_000,
      taskDigest: testTaskDigest("Unrelated interleaved child."),
      childInputDigest: testTaskDigest(
        `Unrelated interleaved child.\n\n${childLiveWorkspaceNotice}`,
      ),
      targetIdentity,
    });
    await durableManagedStore.append({
      schemaVersion: 1,
      type: "managed_agent_terminal",
      sequence: unrelatedSequence + 1,
      agentId: unrelatedAgentId,
      attemptId: unrelatedAttemptId,
      childSessionId: unrelatedChildSessionId,
      status: "cancelled",
      reason: "caller",
      transcriptDigest: testTaskDigest("unrelated transcript"),
      throughSequence: 1,
    });
    await expect(
      manager.send({
        agentId,
        expectedRevision: 3,
        callId: "exact-attention-reply",
        attentionId,
        message: "Prioritize the durable mailbox evidence.",
      }),
    ).rejects.toThrow("Injected failure after the reply became durable.");
    expect(childRequests).toHaveLength(1);
    await expect(
      manager.send({
        agentId,
        expectedRevision: 3,
        callId: "exact-attention-reply",
        attentionId,
        message: "Prioritize the durable mailbox evidence.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { attentionId, delivery: "enqueued", revision: 4 },
    });
    await secondRequestEntered.promise;
    await manager.waitForIdle();
    const terminalAttentionWait = await manager.wait({
      agentIds: [agentId],
      until: "attention",
      signal: new AbortController().signal,
    });
    expect(terminalAttentionWait).toMatchObject({ status: "completed" });
    const terminalAgents =
      terminalAttentionWait.status === "completed" &&
      terminalAttentionWait.output !== null &&
      typeof terminalAttentionWait.output === "object" &&
      "agents" in terminalAttentionWait.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          terminalAttentionWait.output["agents"]
        : undefined;
    expect(terminalAgents).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId, status: "completed" })]),
    );
    await expect(
      manager.send({
        agentId,
        expectedRevision: 3,
        callId: "exact-attention-reply",
        attentionId,
        message: "Prioritize the durable mailbox evidence.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { attentionId, delivery: "delivered" },
    });
    expect(childRequests).toHaveLength(2);
    const managerRecords = await durableManagedStore.read();
    const reportRecord = managerRecords.find(
      (record) => record.type === "managed_agent_child_reported",
    );
    const replyRecord = managerRecords.find(
      (record) => record.type === "managed_agent_parent_reply_enqueued",
    );
    const childStore = await childSessionStores.open(childSessionId);
    const childRecords = await childStore?.read();
    if (
      reportRecord?.type !== "managed_agent_child_reported" ||
      replyRecord?.type !== "managed_agent_parent_reply_enqueued" ||
      childRecords === undefined
    ) {
      throw new Error("The exact coordination recovery fixtures were unavailable.");
    }
    const coordinationSubjects = childRecords.flatMap((record) => {
      const event =
        record.schemaVersion === 1 || record.schemaVersion === 2
          ? record.event
          : record.record.type === "runtime_event"
            ? record.record.event
            : undefined;
      return event?.type === "tool_permission_decided" &&
        event.subject?.type === "parent_coordination"
        ? [event.subject]
        : [];
    });
    expect(coordinationSubjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childToolCallId: "report-progress",
          operation: "report",
          sourceRunId: expect.any(String),
          sourceTurn: 1,
          sourceProviderAttempt: 1,
        }),
        expect.objectContaining({
          childToolCallId: "request-parent",
          operation: "request_input",
          sourceRunId: expect.any(String),
          sourceTurn: 1,
          sourceProviderAttempt: 1,
        }),
      ]),
    );
    const corruptions = [
      {
        name: "source receipt digest",
        original: JSON.stringify({
          id: reportRecord.reportId,
          revision: reportRecord.sequence,
          digest: testTaskDigest(JSON.stringify(reportRecord)),
        }),
        corrupted: JSON.stringify({
          id: reportRecord.reportId,
          revision: reportRecord.sequence,
          digest: `sha256:${"0".repeat(64)}`,
        }),
      },
      {
        name: "request delivery digest",
        original: JSON.stringify({
          id: replyRecord.messageId,
          digest: testTaskDigest(JSON.stringify(replyRecord)),
        }),
        corrupted: JSON.stringify({
          id: replyRecord.messageId,
          digest: `sha256:${"0".repeat(64)}`,
        }),
      },
    ];
    for (const corruption of corruptions) {
      const serialized = JSON.stringify(childRecords);
      const corruptedSerialized = serialized.replace(corruption.original, corruption.corrupted);
      expect(corruptedSerialized, corruption.name).not.toBe(serialized);
      const corruptedRecords = JSON.parse(corruptedSerialized) as SessionRecord[];
      const recoveryStore = createInMemoryManagedAgentStore();
      for (const record of managerRecords) {
        await recoveryStore.append(record);
      }
      const recoverySessions = createInMemorySessionStoreDirectory<SessionRecord>();
      const recoveryChildStore = await recoverySessions.create(childSessionId);
      for (const record of corruptedRecords) {
        await recoveryChildStore.append(record);
      }
      await recoverInterruptedManagedAgents(recoveryStore, recoverySessions);
      expect(await recoveryStore.read()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "managed_agent_inspection_required",
            attemptId: reportRecord.attemptId,
          }),
        ]),
      );
      await recoverInterruptedManagedAgents(recoveryStore, recoverySessions);
      expect(
        (await recoveryStore.read()).filter(
          (record) => record.type === "managed_agent_inspection_required",
        ),
      ).toHaveLength(1);
    }
  } finally {
    releaseReportAppend.resolve();
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentSession keeps the aggregate deadline active while waiting for parent input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-attention-deadline-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let expireDeadline = () => {};
  const deadlineScheduler: ManagedAgentDeadlineScheduler = {
    schedule(_delayMilliseconds, onDeadline) {
      expireDeadline = onDeadline;
      return { cancel() {} };
    },
  };
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "tool_call_start", id: "deadline-attention", name: "request_parent_input" };
      yield {
        type: "tool_call_delta",
        id: "deadline-attention",
        json: '{"question":"Will the aggregate deadline remain active?"}',
      };
      yield { type: "tool_call_end", id: "deadline-attention" };
      yield { type: "usage", inputTokens: 10, outputTokens: 3 };
      yield { type: "finish", reason: "tool_calls" };
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
  const parentRoot = await domain.claimRoot({ rootId: "attention-deadline-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    deadlineScheduler,
    managedStore: createInMemoryManagedAgentStore(),
    parentCoordination: { interactive: true },
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawned = await manager.spawnBackground({
      callId: "spawn-attention-deadline",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Wait for parent input until the aggregate deadline.",
    });
    const agentId =
      spawned.status === "completed" &&
      spawned.output !== null &&
      typeof spawned.output === "object" &&
      "agentId" in spawned.output
        ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          String(spawned.output["agentId"])
        : "";
    await manager.wait({
      agentIds: [agentId],
      until: "attention",
      signal: new AbortController().signal,
    });
    expireDeadline();
    await manager.waitForIdle();
    expect(providerCalls).toBe(1);
    await expect(manager.snapshot()).resolves.toMatchObject({
      counts: { active: 0, terminal: 1, attention: 0 },
      agents: [
        {
          agentId,
          status: "failed",
          error: { code: "managed_agent_deadline_exceeded" },
          attention: { status: "orphaned" },
        },
      ],
    });
    expect(manager.promptSummary()).toContain("0 need attention");
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle spawns an unconfigured research child with its exact non-mutating tools", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-research-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const childRequests: ModelRequest[] = [];
  let parentCalls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Configured research Web" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v1"),
      );
      if (child) {
        childRequests.push(request);
        yield { type: "text_delta", text: "Research profile inspected." };
        yield { type: "usage", inputTokens: 10, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-research",
          json: '{"task":"Inspect exact research tools.","profile":"research.v1","mode":"foreground"}',
        };
        yield { type: "tool_call_end", id: "spawn-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Research child completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const workspaceTrust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate", "network"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    webHttp: {
      async fetch() {
        throw new Error("Profile construction must not perform network access.");
      },
    },
    webSearchConfiguration: {
      async load() {
        return { status: "unconfigured", provider: null, diagnostic: null };
      },
    },
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Start one unconfigured research child." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "search_repository",
      "web_fetch",
      "web_open",
      "web_find",
      "report_to_parent",
    ]);
    expect(JSON.stringify(childRequests[0]?.tools)).not.toMatch(
      /web_search|read_skill_resource|activate_skill|write_file|edit_file|run_shell|spawn_agent|list_agents|wait_agents|send_agent_message|follow_up_agent|cancel_agent/u,
    );
    await lifecycle.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle delivers configured Web evidence through a child-labeled research permission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-research-web-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const endpoint = "https://search.example.test/search";
  const permissionSubjects: unknown[] = [];
  const childRequests: ModelRequest[] = [];
  let childWebAllowed = true;
  let webHttpCalls = 0;
  let parentCalls = 0;
  let configuredSpawnResult: unknown;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Configured research Web" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v1"),
      );
      if (child) {
        childRequests.push(request);
        if (childRequests.length === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain("web_search");
          yield { type: "tool_call_start", id: "child-web-search", name: "web_search" };
          yield {
            type: "tool_call_delta",
            id: "child-web-search",
            json: '{"query":"Adam durable evidence","limit":1}',
          };
          yield { type: "tool_call_end", id: "child-web-search" };
          yield { type: "usage", inputTokens: 10, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (childRequests.length === 2) {
          expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
            role: "tool",
            callId: "child-web-search",
            result: { status: "completed" },
          });
          expect(JSON.stringify(request.messages)).toContain("https://example.com/evidence");
          childWebAllowed = false;
          yield { type: "tool_call_start", id: "child-web-revoked", name: "web_search" };
          yield {
            type: "tool_call_delta",
            id: "child-web-revoked",
            json: '{"query":"Revoked exact query","limit":1}',
          };
          yield { type: "tool_call_end", id: "child-web-revoked" };
          yield { type: "usage", inputTokens: 12, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
          role: "tool",
          callId: "child-web-revoked",
          result: { status: "failed", error: { code: "permission_denied" } },
        });
        yield { type: "text_delta", text: "Configured Web evidence received." };
        yield { type: "usage", inputTokens: 12, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-web-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-web-research",
          json: '{"task":"Search exact Web evidence.","profile":"research.v1","mode":"foreground"}',
        };
        yield { type: "tool_call_end", id: "spawn-web-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      configuredSpawnResult = request.messages.findLast(
        (message) => message.role === "tool" && message.callId === "spawn-web-research",
      );
      yield { type: "text_delta", text: "Research child completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: {
      decide(input) {
        permissionSubjects.push(input.subject);
        return input.subject.type === "managed_agent_web_request" && !childWebAllowed
          ? "deny"
          : "allow";
      },
    },
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    webHttp: {
      async fetch(input) {
        webHttpCalls += 1;
        expect(input.url).toContain("Adam+durable+evidence");
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from(
            '{"results":[{"url":"https://example.com/evidence","title":"Durable Evidence","content":"Exact result"}]}',
            "utf8",
          ),
        };
      },
    },
    webSearchConfiguration: {
      async load() {
        return {
          status: "configured",
          provider: {
            kind: "searxng",
            endpoint,
            activation: { protocol: "searxng-json.v1", endpointDigest: testTaskDigest(endpoint) },
          },
          diagnostic: null,
        };
      },
    },
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Start configured research." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    expect(permissionSubjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "managed_agent_web_request",
          operation: "search",
          profile: "research.v1",
          providerOrigin: "https://search.example.test",
          queryOrUrl: "Adam durable evidence",
        }),
      ]),
    );
    expect(childRequests).toHaveLength(3);
    expect(webHttpCalls).toBe(1);
    expect(configuredSpawnResult).toMatchObject({
      role: "tool",
      result: {
        status: "completed",
        output: {
          profile: "research.v1",
          effectiveToolProfileDigest: expect.stringMatching(/^sha256:/u),
          transcript: { sessionId: expect.any(String) },
        },
      },
    });
    if (
      configuredSpawnResult === null ||
      typeof configuredSpawnResult !== "object" ||
      !("result" in configuredSpawnResult) ||
      configuredSpawnResult.result === null ||
      typeof configuredSpawnResult.result !== "object" ||
      !("output" in configuredSpawnResult.result) ||
      configuredSpawnResult.result.output === null ||
      typeof configuredSpawnResult.result.output !== "object" ||
      !("effectiveToolProfileDigest" in configuredSpawnResult.result.output) ||
      !("transcript" in configuredSpawnResult.result.output)
    ) {
      throw new Error("The configured research profile receipt was unavailable.");
    }
    const configuredOutput = configuredSpawnResult.result.output as {
      readonly effectiveToolProfileDigest: string;
      readonly transcript: { readonly sessionId: string };
    };
    const configuredChildLog = await readFile(
      join(
        stateRoot,
        "managed-child-sessions",
        "projects",
        created.projectId.replace(/^sha256:/u, ""),
        "sessions",
        `${configuredOutput.transcript.sessionId}.jsonl`,
      ),
      "utf8",
    );
    expect(JSON.parse(configuredChildLog.split("\n")[0] ?? "null")).toMatchObject({
      record: {
        promptContext: {
          toolProfile: { digest: configuredOutput.effectiveToolProfileDigest },
        },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager denies a non-interactive research Web ask before the HTTP Adapter", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-web-noninteractive-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let httpCalls = 0;
  const researchTools = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("A denied non-interactive request must not write an artifact.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        httpCalls += 1;
        throw new Error("A denied non-interactive request must not reach HTTP.");
      },
    },
  });
  const childRequests: ModelRequest[] = [];
  const childModel: ModelDriver = {
    async *stream(request) {
      childRequests.push(request);
      if (childRequests.length === 1) {
        yield { type: "tool_call_start", id: "noninteractive-web", name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: "noninteractive-web",
          json: '{"url":"https://example.com/evidence"}',
        };
        yield { type: "tool_call_end", id: "noninteractive-web" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
        role: "tool",
        callId: "noninteractive-web",
        result: { status: "failed", error: { code: "permission_denied" } },
      });
      yield { type: "text_delta", text: "Non-interactive Web ask denied." };
      yield { type: "usage", inputTokens: 12, outputTokens: 4 };
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
  const parentRoot = await domain.claimRoot({ rootId: "noninteractive-web-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({
      allowedEffects: ["read"],
      askedEffects: ["network"],
    }),
    parentRoot,
    projectId,
    researchTools,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await expect(
      manager.spawnForeground({
        callId: "spawn-noninteractive-web",
        parentSessionId: manager.parentSessionId,
        profile: "research.v1",
        signal: new AbortController().signal,
        task: "Attempt one non-interactive Web request.",
      }),
    ).resolves.toMatchObject({ status: "completed", output: { profile: "research.v1" } });
    expect(httpCalls).toBe(0);
    expect(childRequests).toHaveLength(2);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle denies a research Web ask when no Presentation sink is registered", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-web-no-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  let httpCalls = 0;
  let parentCalls = 0;
  const childRequests: ModelRequest[] = [];
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "No Presentation sink" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v1"),
      );
      if (child) {
        childRequests.push(request);
        if (childRequests.length === 1) {
          yield { type: "tool_call_start", id: "lifecycle-no-sink-web", name: "web_fetch" };
          yield {
            type: "tool_call_delta",
            id: "lifecycle-no-sink-web",
            json: '{"url":"https://example.com/no-sink"}',
          };
          yield { type: "tool_call_end", id: "lifecycle-no-sink-web" };
          yield { type: "usage", inputTokens: 10, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
          role: "tool",
          callId: "lifecycle-no-sink-web",
          result: { status: "failed", error: { code: "permission_denied" } },
        });
        yield { type: "text_delta", text: "Lifecycle Web ask denied without a sink." };
        yield { type: "usage", inputTokens: 12, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-no-sink-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-no-sink-research",
          json: '{"task":"Try Web without a Presentation sink.","profile":"research.v1","mode":"foreground"}',
        };
        yield { type: "tool_call_end", id: "spawn-no-sink-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Non-interactive lifecycle completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: {
      decide(input) {
        return input.subject.type === "managed_agent_web_request" ? "ask" : "allow";
      },
    },
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    webHttp: {
      async fetch() {
        httpCalls += 1;
        throw new Error("A no-sink Web ask must not reach HTTP.");
      },
    },
    webSearchConfiguration: {
      async load() {
        return { status: "unconfigured", provider: null, diagnostic: null };
      },
    },
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Start no-sink research." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    expect(httpCalls).toBe(0);
    expect(childRequests).toHaveLength(2);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle serializes child Web permission overlays and projects permission-required state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-web-permissions-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const endpoint = "https://search.example.test/search";
  const permissionEvents: Extract<
    Parameters<Parameters<ReturnType<typeof createSessionLifecycle>["subscribe"]>[0]>[0],
    { readonly type: "tool_permission_requested" }
  >[] = [];
  const permissionDecisionEvents: RuntimeEvent[] = [];
  const firstPermission = Promise.withResolvers<string>();
  const secondPermission = Promise.withResolvers<string>();
  const thirdPermission = Promise.withResolvers<string>();
  let expectedThirdRequestId: string | undefined;
  const bothChildrenCompleted = Promise.withResolvers<void>();
  let completedChildren = 0;
  let parentCalls = 0;
  let activeAgentIds: string[] = [];
  const childCalls = new Map<string, number>();
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Child Web permissions" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const childTask = request.messages.findLast((message) => message.role === "user")?.content;
      const childId =
        typeof childTask === "string" && childTask.startsWith("permission-child-")
          ? childTask.slice(0, "permission-child-1".length)
          : undefined;
      if (childId !== undefined) {
        const call = (childCalls.get(childId) ?? 0) + 1;
        childCalls.set(childId, call);
        if (call === 1) {
          yield { type: "tool_call_start", id: `${childId}-search`, name: "web_search" };
          yield {
            type: "tool_call_delta",
            id: `${childId}-search`,
            json: JSON.stringify({ query: `${childId} exact query`, limit: 1 }),
          };
          yield { type: "tool_call_end", id: `${childId}-search` };
          yield { type: "usage", inputTokens: 10, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        completedChildren += 1;
        if (completedChildren === 2) {
          bothChildrenCompleted.resolve();
        }
        yield { type: "text_delta", text: `${childId} complete` };
        yield { type: "usage", inputTokens: 12, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        for (const child of ["permission-child-1", "permission-child-2"]) {
          yield { type: "tool_call_start", id: `spawn-${child}`, name: "spawn_agent" };
          yield {
            type: "tool_call_delta",
            id: `spawn-${child}`,
            json: JSON.stringify({ task: child, profile: "research.v1", mode: "background" }),
          };
          yield { type: "tool_call_end", id: `spawn-${child}` };
        }
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 2) {
        activeAgentIds = request.messages.flatMap((message) => {
          if (
            message.role !== "tool" ||
            message.name !== "spawn_agent" ||
            message.result.status !== "completed" ||
            message.result.output === null ||
            typeof message.result.output !== "object" ||
            !("agentId" in message.result.output)
          ) {
            return [];
          }
          // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
          return [String(message.result.output["agentId"])];
        });
        yield { type: "text_delta", text: "Both research children started." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCalls === 3) {
        yield { type: "tool_call_start", id: "wait-permission-children", name: "wait_agents" };
        yield {
          type: "tool_call_delta",
          id: "wait-permission-children",
          json: JSON.stringify({ agentIds: activeAgentIds, until: "all_terminal" }),
        };
        yield { type: "tool_call_end", id: "wait-permission-children" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 5) {
        yield { type: "tool_call_start", id: "spawn-permission-child-3", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-permission-child-3",
          json: JSON.stringify({
            task: "permission-child-3",
            profile: "research.v1",
            mode: "background",
          }),
        };
        yield { type: "tool_call_end", id: "spawn-permission-child-3" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Both research children started." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: {
      decide(input) {
        return input.subject.type === "managed_agent_web_request" ? "ask" : "allow";
      },
    },
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    webHttp: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from('{"results":[]}', "utf8"),
        };
      },
    },
    webSearchConfiguration: {
      async load() {
        return {
          status: "configured",
          provider: {
            kind: "searxng",
            endpoint,
            activation: { protocol: "searxng-json.v1", endpointDigest: testTaskDigest(endpoint) },
          },
          diagnostic: null,
        };
      },
    },
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_decided") {
      permissionDecisionEvents.push(event);
    }
    if (
      event.type !== "tool_permission_requested" ||
      event.subject.type !== "managed_agent_web_request"
    ) {
      return;
    }
    permissionEvents.push(event);
    if (permissionEvents.length === 3) {
      expectedThirdRequestId = event.requestId;
    }
    (permissionEvents.length === 1
      ? firstPermission
      : permissionEvents.length === 2
        ? secondPermission
        : thirdPermission
    ).resolve(event.requestId);
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "child-web-permissions",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    const permissionStatusVisible = Promise.withResolvers<void>();
    const unsubscribePermissionStatus = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.managedAgents.agents.some(
            (agent) => agent.status === "permission_required",
          )
      ) {
        permissionStatusVisible.resolve();
      }
    });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Start both permission children." },
    });
    const firstRequestId = await firstPermission.promise;
    await withManagedFailureGuard(
      permissionStatusVisible.promise,
      "The managed permission-required state was never projected.",
    );
    expect(permissionEvents).toHaveLength(1);
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 2, attention: 1 },
      agents: expect.arrayContaining([
        expect.objectContaining({
          status: "permission_required",
          phase: "permission_required",
          activeTool: {
            callId: expect.stringMatching(/-search$/u),
            name: "web_search",
            status: "permission_required",
          },
        }),
      ]),
    });
    expect(presentation.getState().managedAgentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activity: "using_tool",
          tool: expect.objectContaining({ name: "web_search", status: "requested" }),
        }),
      ]),
    );
    expect(presentation.getState().authoritative.active?.pendingInteractions).toMatchObject([
      {
        requestId: firstRequestId,
        effect: "network",
        warning: expect.stringContaining("research.v1"),
      },
    ]);
    await expect(
      presentation.dispatch({
        type: "decide_permission",
        requestId: firstRequestId,
        decision: "allow",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    const secondRequestId = await secondPermission.promise;
    expect(permissionEvents).toHaveLength(2);
    expect(presentation.getState().authoritative.active?.pendingInteractions).toMatchObject([
      { requestId: secondRequestId },
    ]);
    await expect(
      presentation.dispatch({
        type: "decide_permission",
        requestId: secondRequestId,
        decision: "allow",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await bothChildrenCompleted.promise;
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Wait causally for both research children." },
    });
    await expect(
      lifecycle.inspectManagedAgents({ sessionId: created.sessionId }),
    ).resolves.toMatchObject({
      counts: { active: 0, terminal: 2, attention: 0 },
    });
    const thirdOverlayVisible = Promise.withResolvers<void>();
    const unsubscribeThirdOverlay = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.pendingInteractions.some(
            (interaction) =>
              expectedThirdRequestId !== undefined &&
              interaction.requestId === expectedThirdRequestId,
          )
      ) {
        thirdOverlayVisible.resolve();
      }
    });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Start one permission-cleanup child." },
    });
    const thirdRequestId = await thirdPermission.promise;
    await thirdOverlayVisible.promise;
    unsubscribeThirdOverlay();
    expect(thirdRequestId).toBe(expectedThirdRequestId);
    expect(
      permissionDecisionEvents.filter(
        (event) => event.type === "tool_permission_decided" && event.requestId === thirdRequestId,
      ),
    ).toEqual([]);
    const thirdSubject = permissionEvents[2]?.subject;
    const thirdAgentId =
      thirdSubject?.type === "managed_agent_web_request" ? thirdSubject.agentId : "";
    const beforeCancel = await lifecycle.inspectManagedAgents({ sessionId: created.sessionId });
    const thirdAgent = beforeCancel.agents.find((agent) => agent.agentId === thirdAgentId);
    if (thirdAgent === undefined) {
      throw new Error("The pending-permission child was unavailable for cancellation.");
    }
    await lifecycle.cancelManagedAgent({
      sessionId: created.sessionId,
      agentId: thirdAgent.agentId,
      expectedRevision: thirdAgent.revision,
    });
    expect(presentation.getState().authoritative.active?.pendingInteractions).toEqual([]);
    await expect(
      lifecycle.inspectManagedAgents({ sessionId: created.sessionId }),
    ).resolves.toMatchObject({
      counts: { active: 0, terminal: 3, attention: 0 },
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: thirdAgentId, status: "cancelled" }),
      ]),
    });
    unsubscribePermissionStatus();
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle freezes one exact selected Skill and pages its research resource", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-research-skill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "research-guide");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: research-guide\ndescription: Supplies exact research guidance.\n---\nSELECTED_RESEARCH_SKILL_BODY\n",
    "utf8",
  );
  await writeFile(join(skillDirectory, "guide.txt"), "paged research resource evidence\n", "utf8");
  const childRequests: ModelRequest[] = [];
  let parentCalls = 0;
  let skilledSpawnResult: unknown;
  let changedSkillSpawnResult: unknown;
  let revokedSkillSpawnResult: unknown;
  let unavailableSkillResourceResult: unknown;
  let skilledAgentId = "";
  const thirdSkillRequestEntered = Promise.withResolvers<void>();
  const releaseThirdSkillRequest = Promise.withResolvers<void>();
  const skilledPermissionSubjects: unknown[] = [];
  const workspaceTrust = createTrustedWorkspaceTrustForTesting(workspaceRoot);
  const driver: ModelDriver = {
    async *stream(request) {
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v1"),
      );
      if (child) {
        childRequests.push(request);
        if (childRequests.length === 1) {
          expect(JSON.stringify(request.messages)).toContain("SELECTED_RESEARCH_SKILL_BODY");
          expect(request.tools.map((tool) => tool.name)).toContain("read_skill_resource");
          yield { type: "tool_call_start", id: "read-research-guide", name: "read_skill_resource" };
          yield {
            type: "tool_call_delta",
            id: "read-research-guide",
            json: '{"qualifiedId":"skill:v1:project:.:research-guide","path":"guide.txt","maxByteCount":8}',
          };
          yield { type: "tool_call_end", id: "read-research-guide" };
          yield { type: "usage", inputTokens: 10, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (childRequests.length === 2) {
          expect(JSON.stringify(request.messages)).toContain("paged re");
          yield {
            type: "tool_call_start",
            id: "read-research-guide-next",
            name: "read_skill_resource",
          };
          yield {
            type: "tool_call_delta",
            id: "read-research-guide-next",
            json: '{"qualifiedId":"skill:v1:project:.:research-guide","path":"guide.txt","offset":8,"maxByteCount":64}',
          };
          yield { type: "tool_call_end", id: "read-research-guide-next" };
          yield { type: "usage", inputTokens: 12, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (childRequests.length === 3) {
          expect(JSON.stringify(request.messages)).toContain("search resource evidence");
          thirdSkillRequestEntered.resolve();
          await releaseThirdSkillRequest.promise;
          yield {
            type: "tool_call_start",
            id: "read-revoked-resource",
            name: "read_skill_resource",
          };
          yield {
            type: "tool_call_delta",
            id: "read-revoked-resource",
            json: '{"qualifiedId":"skill:v1:project:.:research-guide","path":"guide.txt"}',
          };
          yield { type: "tool_call_end", id: "read-revoked-resource" };
          yield { type: "usage", inputTokens: 14, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        unavailableSkillResourceResult = request.messages.findLast(
          (message) => message.role === "tool" && message.callId === "read-revoked-resource",
        );
        yield { type: "text_delta", text: "Selected Skill resource observed." };
        yield { type: "usage", inputTokens: 12, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Research skill session" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-skilled-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-skilled-research",
          json: '{"task":"Use selected research guidance.","profile":"research.v1","skills":["skill:v1:project:.:research-guide"],"mode":"background"}',
        };
        yield { type: "tool_call_end", id: "spawn-skilled-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 2) {
        const spawn = request.messages.findLast(
          (message) => message.role === "tool" && message.callId === "spawn-skilled-research",
        );
        if (
          spawn?.role !== "tool" ||
          spawn.result.status !== "completed" ||
          spawn.result.output === null ||
          typeof spawn.result.output !== "object" ||
          !("agentId" in spawn.result.output)
        ) {
          throw new Error("The skilled child identity was unavailable.");
        }
        skilledSpawnResult = spawn;
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        skilledAgentId = String(spawn.result.output["agentId"]);
        yield { type: "text_delta", text: "Skilled research started." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCalls === 3) {
        yield { type: "tool_call_start", id: "wait-skilled-research", name: "wait_agents" };
        yield {
          type: "tool_call_delta",
          id: "wait-skilled-research",
          json: JSON.stringify({ agentIds: [skilledAgentId], until: "all_terminal" }),
        };
        yield { type: "tool_call_end", id: "wait-skilled-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 5) {
        yield { type: "tool_call_start", id: "spawn-changed-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-changed-research",
          json: '{"task":"Use changed research guidance.","profile":"research.v1","skills":["skill:v1:project:.:research-guide"],"mode":"foreground"}',
        };
        yield { type: "tool_call_end", id: "spawn-changed-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 6) {
        changedSkillSpawnResult = request.messages.findLast(
          (message) => message.role === "tool" && message.callId === "spawn-changed-research",
        );
      }
      if (parentCalls === 7) {
        yield { type: "tool_call_start", id: "spawn-revoked-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-revoked-research",
          json: '{"task":"Use revoked research guidance.","profile":"research.v1","skills":["skill:v1:project:.:research-guide"],"mode":"foreground"}',
        };
        yield { type: "tool_call_end", id: "spawn-revoked-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 8) {
        revokedSkillSpawnResult = request.messages.findLast(
          (message) => message.role === "tool" && message.callId === "spawn-revoked-research",
        );
      }
      yield { type: "text_delta", text: "Skilled research completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: {
      decide(input) {
        skilledPermissionSubjects.push(input.subject);
        return "allow";
      },
    },
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Start selected-Skill research." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    await thirdSkillRequestEntered.promise;
    await workspaceTrust.setTrusted({ projectId: created.projectId, trusted: false });
    releaseThirdSkillRequest.resolve();
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Wait for the trust-narrowed child." },
    });
    expect(childRequests, JSON.stringify(skilledSpawnResult)).toHaveLength(4);
    expect(unavailableSkillResourceResult).toMatchObject({
      role: "tool",
      callId: "read-revoked-resource",
      result: { status: "failed", error: { code: "skill_resource_unavailable" } },
    });
    expect(skilledSpawnResult, JSON.stringify(skilledSpawnResult)).toMatchObject({
      role: "tool",
      result: {
        status: "completed",
        output: {
          profile: "research.v1",
          profileDigest: researchManagedAgentProfileV1.digest,
          effectiveToolProfileDigest: expect.stringMatching(/^sha256:/u),
          skillActivationDigest: expect.stringMatching(/^sha256:/u),
        },
      },
    });
    if (
      skilledSpawnResult === null ||
      typeof skilledSpawnResult !== "object" ||
      !("result" in skilledSpawnResult) ||
      skilledSpawnResult.result === null ||
      typeof skilledSpawnResult.result !== "object" ||
      !("output" in skilledSpawnResult.result) ||
      skilledSpawnResult.result.output === null ||
      typeof skilledSpawnResult.result.output !== "object" ||
      !("childSessionId" in skilledSpawnResult.result.output) ||
      !("effectiveToolProfileDigest" in skilledSpawnResult.result.output) ||
      !("skillActivationDigest" in skilledSpawnResult.result.output)
    ) {
      throw new Error("The exact skilled child profile receipt was unavailable.");
    }
    const skilledOutput = skilledSpawnResult.result.output as {
      readonly childSessionId: string;
      readonly effectiveToolProfileDigest: string;
      readonly skillActivationDigest: string;
    };
    const childSessionLog = await readFile(
      join(
        stateRoot,
        "managed-child-sessions",
        "projects",
        created.projectId.replace(/^sha256:/u, ""),
        "sessions",
        `${skilledOutput.childSessionId}.jsonl`,
      ),
      "utf8",
    );
    const childGenesis = JSON.parse(childSessionLog.split("\n")[0] ?? "null") as SessionRecord;
    expect(childGenesis).toMatchObject({
      schemaVersion: 3,
      record: {
        type: "session_genesis",
        promptContext: {
          toolProfile: { digest: skilledOutput.effectiveToolProfileDigest },
        },
        skillContext: { activationDigest: skilledOutput.skillActivationDigest },
      },
    });
    expect(skilledPermissionSubjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "managed_agent_spawn",
          profile: "research.v1",
          selectedSkills: [
            {
              qualifiedId: "skill:v1:project:.:research-guide",
              digest: expect.stringMatching(/^sha256:/u),
            },
          ],
        }),
      ]),
    );
    expect(JSON.stringify(childRequests[0]?.tools)).not.toMatch(
      /activate_skill|write_file|edit_file|run_shell|spawn_agent|mcp/u,
    );
    await workspaceTrust.setTrusted({ projectId: created.projectId, trusted: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: research-guide\ndescription: Supplies exact research guidance.\n---\nCHANGED_AFTER_APPROVAL\n",
      "utf8",
    );
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Try the changed selected Skill." },
    });
    expect(changedSkillSpawnResult).toMatchObject({
      role: "tool",
      result: { status: "failed", error: { code: "invalid_tool_input" } },
    });
    expect(childRequests).toHaveLength(4);
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: research-guide\ndescription: Supplies exact research guidance.\n---\nSELECTED_RESEARCH_SKILL_BODY\n",
      "utf8",
    );
    await workspaceTrust.setTrusted({ projectId: created.projectId, trusted: false });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Try the workspace-trust-revoked Skill." },
    });
    expect(revokedSkillSpawnResult).toMatchObject({
      role: "tool",
      result: { status: "failed", error: { code: "invalid_tool_input" } },
    });
    expect(childRequests).toHaveLength(4);
  } finally {
    releaseThirdSkillRequest.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle narrows an admitted extension Skill after extension disable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-extension-skill-revoke-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const packageRoot = join(testRoot, "extension-package");
  const skillDirectory = join(packageRoot, "skills", "managed-extension-guide");
  const references = join(skillDirectory, "references");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(references, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/managed-extension-skill",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.managed-extension-skill",
        apiVersion: "^0.3.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: managed-extension-guide\ndescription: Supplies revocable managed guidance.\n---\nMANAGED_EXTENSION_SKILL_BODY\n",
    "utf8",
  );
  await writeFile(join(references, "guide.txt"), "REVOCABLE_EXTENSION_RESOURCE\n", "utf8");
  const qualifiedId =
    "skill:v1:extension:fixture.managed-extension-skill:%40fixture%2Fmanaged-extension-skill:1.0.0:managed-extension-guide";
  const childModelEntered = Promise.withResolvers<void>();
  const releaseChildModel = Promise.withResolvers<void>();
  const childRequests: ModelRequest[] = [];
  let parentCalls = 0;
  let childAgentId = "";
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Managed extension Skill" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v1"),
      );
      if (child) {
        childRequests.push(request);
        childModelEntered.resolve();
        await releaseChildModel.promise;
        yield {
          type: "tool_call_start",
          id: "read-revoked-extension",
          name: "read_skill_resource",
        };
        yield {
          type: "tool_call_delta",
          id: "read-revoked-extension",
          json: JSON.stringify({ qualifiedId, path: "references/guide.txt" }),
        };
        yield { type: "tool_call_end", id: "read-revoked-extension" };
        yield { type: "usage", inputTokens: 10, outputTokens: 3 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-extension-research", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-extension-research",
          json: JSON.stringify({
            task: "Use the exact extension Skill.",
            profile: "research.v1",
            skills: [qualifiedId],
            mode: "background",
          }),
        };
        yield { type: "tool_call_end", id: "spawn-extension-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 2) {
        const spawn = request.messages.findLast(
          (message) => message.role === "tool" && message.callId === "spawn-extension-research",
        );
        if (
          spawn?.role !== "tool" ||
          spawn.result.status !== "completed" ||
          spawn.result.output === null ||
          typeof spawn.result.output !== "object" ||
          !("agentId" in spawn.result.output)
        ) {
          throw new Error("The extension research child identity was unavailable.");
        }
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        childAgentId = String(spawn.result.output["agentId"]);
        yield { type: "text_delta", text: "Extension research child started." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCalls === 3) {
        yield { type: "tool_call_start", id: "wait-extension-research", name: "wait_agents" };
        yield {
          type: "tool_call_delta",
          id: "wait-extension-research",
          json: JSON.stringify({ agentIds: [childAgentId], until: "all_terminal" }),
        };
        yield { type: "tool_call_end", id: "wait-extension-research" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Extension research child settled." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const extensionHost = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.managed-extension-skill",
        grants: [],
        packageName: "@fixture/managed-extension-skill",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    projectRoot: workspaceRoot,
    stateRoot,
  });
  const lifecycle = createSessionLifecycle({
    extensionHost,
    managedAgentTools: "managed-agent-tools.a3-long-lived.v1",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createCodingToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Start extension-Skill research." },
    });
    await childModelEntered.promise;
    await extensionHost.disableExtension("fixture.managed-extension-skill");
    releaseChildModel.resolve();
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Wait for extension revocation settlement." },
    });
    expect(childRequests).toHaveLength(1);
    const managed = await lifecycle.inspectManagedAgents({ sessionId: created.sessionId });
    expect(managed.agents.find((agent) => agent.agentId === childAgentId)).toMatchObject({
      agentId: childAgentId,
      status: "failed",
      error: { code: "skill_activation_failed" },
    });
  } finally {
    releaseChildModel.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager waits causally for any or all selected background terminals without cancelling on wait abort", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-wait-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releases = new Map<string, () => void>();
  const entered = new Map<string, Promise<void>>();
  const enter = new Map<string, () => void>();
  for (const task of ["first", "second"]) {
    entered.set(
      task,
      new Promise<void>((resolve) => {
        enter.set(task, resolve);
      }),
    );
  }
  const childModel: ModelDriver = {
    async *stream(request) {
      const content = request.messages.findLast((message) => message.role === "user")?.content;
      const task = typeof content === "string" && content.startsWith("first") ? "first" : "second";
      enter.get(task)?.();
      await new Promise<void>((resolve) => {
        releases.set(task, resolve);
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (request.signal.aborted) {
        return;
      }
      yield { type: "text_delta", text: `${task} complete` };
      yield { type: "usage", inputTokens: 10, outputTokens: 3 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "wait-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore: createInMemoryManagedAgentStore(),
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });
  const [first, second, third] = await Promise.all([
    manager.spawnBackground({
      callId: "wait-first",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "first child",
    }),
    manager.spawnBackground({
      callId: "wait-second",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "second child",
    }),
    manager.spawnBackground({
      callId: "wait-third-over-capacity",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "third child",
    }),
  ]);
  expect(third).toMatchObject({
    status: "failed",
    error: { code: "managed_agent_capacity_exceeded" },
  });
  const identities = [first, second].map((result) => {
    if (
      result.status !== "completed" ||
      result.output === null ||
      typeof result.output !== "object" ||
      !("agentId" in result.output)
    ) {
      throw new Error("Background admission did not return an agent identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    return result.output["agentId"] as string;
  });

  try {
    await Promise.all([entered.get("first"), entered.get("second")]);
    releases.get("first")?.();
    await expect(
      manager.wait({
        agentIds: identities,
        until: "any_terminal",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "completed", output: { counts: { active: 1 } } });
    const waitAbort = new AbortController();
    waitAbort.abort(new Error("Stop waiting only."));
    await expect(
      manager.wait({
        agentIds: [identities[1] as string],
        until: "all_terminal",
        signal: waitAbort.signal,
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "managed_agent_cancelled" } });
    await expect(manager.list()).resolves.toMatchObject({
      status: "completed",
      output: { counts: { active: 1 } },
    });
    releases.get("second")?.();
    await expect(
      manager.wait({
        agentIds: identities,
        until: "all_terminal",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "completed", output: { counts: { active: 0 } } });
  } finally {
    releases.get("first")?.();
    releases.get("second")?.();
    await manager.waitForIdle();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager starts one explicit follow-up attempt on the same terminal child identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-follow-up-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseFollowUp = Promise.withResolvers<void>();
  let childCalls = 0;
  let followUpRequest: ModelRequest | undefined;
  const childModel: ModelDriver = {
    async *stream(request) {
      childCalls += 1;
      const content = request.messages.findLast((message) => message.role === "user")?.content;
      const task = typeof content === "string" ? content.split("\n", 1)[0] : "unknown";
      if (childCalls === 2) {
        followUpRequest = request;
        await releaseFollowUp.promise;
      }
      yield { type: "text_delta", text: `${task} complete` };
      yield { type: "usage", inputTokens: 10, outputTokens: 3, reasoningTokens: 2 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "follow-up-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const first = await manager.spawnBackground({
      callId: "initial-attempt",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "initial task",
    });
    if (
      first.status !== "completed" ||
      first.output === null ||
      typeof first.output !== "object" ||
      !("agentId" in first.output)
    ) {
      throw new Error("Initial background attempt did not return identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = first.output["agentId"] as string;
    await manager.waitForIdle();
    await expect(
      manager.followUp({
        agentId,
        expectedRevision: 2,
        callId: "follow-up-attempt",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "follow-up task",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { agentId, status: "running", revision: 3 },
    });
    const waitAbort = new AbortController();
    waitAbort.abort(new Error("Stop only the wait on the running follow-up."));
    await expect(
      manager.wait({ agentIds: [agentId], until: "any_terminal", signal: waitAbort.signal }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_cancelled" },
    });
    expect(JSON.stringify(followUpRequest?.messages)).toContain("initial task complete");
    expect(JSON.stringify(followUpRequest?.messages)).toContain("follow-up task");
    releaseFollowUp.resolve();
    await manager.waitForIdle();
    const admissions = (await managedStore.read()).filter(
      (record) => record.type === "managed_agent_admitted",
    );
    expect(admissions).toHaveLength(2);
    expect(admissions.map((record) => record.agentId)).toEqual([agentId, agentId]);
    expect(new Set(admissions.map((record) => record.attemptId))).toHaveLength(2);
    expect(admissions[1]).toMatchObject({
      usageAccountingVersion: 2,
      limits: { maximumTokens: 127_987 },
      deadlineAtUnixMilliseconds: admissions[0]?.deadlineAtUnixMilliseconds,
      resume: {
        sourceAttemptId: admissions[0]?.attemptId,
        sourceChildSessionId: admissions[0]?.childSessionId,
      },
    });
    expect(admissions[1]?.limits.maximumDeadlineMilliseconds).toBeGreaterThan(0);
    expect(admissions[1]?.limits.maximumDeadlineMilliseconds).toBeLessThanOrEqual(600_000);
    await expect(manager.list()).resolves.toMatchObject({
      status: "completed",
      output: { counts: { active: 0, terminal: 1 } },
    });
  } finally {
    releaseFollowUp.resolve();
    await manager.waitForIdle();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager retains the current context budget across exactly four child attempts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-current-attempts-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "text_delta", text: `Current attempt ${providerCalls} complete.` };
      yield { type: "usage", inputTokens: 10, outputTokens: 3, reasoningTokens: 2 };
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
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174551";
  const parentRoot = await domain.claimRoot({ rootId: `session:${parentSessionId}` });
  const managedStore = createInMemoryManagedAgentStore();
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const manager = createAgentManager({
    builtInProfileVersion: 2,
    childContextProfile: {
      version: 2,
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
      ordinaryOutputReserveTokens: 4_096,
      compactionSummaryMaximumOutputTokens: 32_768,
      compactAtTokens: 900_000,
      postCompactTargetTokens: 200_000,
      retainedTargetTokens: 20_000,
      estimatorVersion: 1,
    },
    childModel,
    childSessionStores,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    parentSessionId,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const first = await manager.spawnBackground({
      callId: "current-attempt-1",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Complete current attempt one.",
    });
    if (
      first.status !== "completed" ||
      first.output === null ||
      typeof first.output !== "object" ||
      !("agentId" in first.output)
    ) {
      throw new Error("Expected one current child identity.");
    }
    // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
    const agentId = first.output["agentId"] as string;
    await manager.waitForIdle();
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await expect(
        manager.followUp({
          agentId,
          expectedRevision: (attempt - 1) * 2,
          callId: `current-attempt-${attempt}`,
          parentSessionId: manager.parentSessionId,
          signal: new AbortController().signal,
          task: `Complete current attempt ${attempt}.`,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        output: { agentId, profile: "scout.v2", status: "running" },
      });
      await manager.waitForIdle();
    }
    await expect(
      manager.followUp({
        agentId,
        expectedRevision: 8,
        callId: "current-attempt-5",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "The fifth attempt must be rejected.",
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
    expect(providerCalls).toBe(4);
    const admissions = (await managedStore.read()).filter(
      (record) => record.type === "managed_agent_admitted",
    );
    expect(admissions.map((admission) => admission.limits.maximumTokens)).toEqual([
      1_000_000, 999_987, 999_974, 999_961,
    ]);
    expect(admissions.every((admission) => admission.profile === "scout.v2")).toBe(true);
    expect(
      admissions.every(
        (admission) =>
          admission.limits.maximumTurns === undefined &&
          admission.deadlineAtUnixMilliseconds === undefined,
      ),
    ).toBe(true);
    const beforeFollowUpRecovery = await managedStore.read();
    await recoverInterruptedManagedAgents(managedStore, childSessionStores);
    await expect(managedStore.read()).resolves.toEqual(beforeFollowUpRecovery);
    for (let identity = 2; identity <= 4; identity += 1) {
      const admitted = await manager.spawnBackground({
        callId: `current-identity-${identity}-attempt-1`,
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: `Complete identity ${identity} attempt one.`,
      });
      if (
        admitted.status !== "completed" ||
        admitted.output === null ||
        typeof admitted.output !== "object" ||
        !("agentId" in admitted.output)
      ) {
        throw new Error("Expected one additional current child identity.");
      }
      // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
      const nextAgentId = admitted.output["agentId"] as string;
      await manager.waitForIdle();
      const maximumAttempt = identity === 4 ? 3 : 4;
      for (let attempt = 2; attempt <= maximumAttempt; attempt += 1) {
        await expect(
          manager.followUp({
            agentId: nextAgentId,
            expectedRevision: (attempt - 1) * 2,
            callId: `current-identity-${identity}-attempt-${attempt}`,
            parentSessionId: manager.parentSessionId,
            signal: new AbortController().signal,
            task: `Complete identity ${identity} attempt ${attempt}.`,
          }),
        ).resolves.toMatchObject({ status: "completed" });
        await manager.waitForIdle();
      }
    }
    expect(providerCalls).toBe(15);
    const concurrentAdmissions = await Promise.all([
      manager.spawnBackground({
        callId: "current-parent-attempt-16-concurrent",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "Admit the sixteenth aggregate attempt.",
      }),
      manager.spawnBackground({
        callId: "current-parent-attempt-17-concurrent",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "Reject the concurrent seventeenth aggregate attempt.",
      }),
    ]);
    expect(concurrentAdmissions.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(concurrentAdmissions.filter((result) => result.status === "failed")).toMatchObject([
      { error: { code: "managed_agent_capacity_exceeded" } },
    ]);
    await manager.waitForIdle();
    expect(providerCalls).toBe(16);
    expect(
      (await managedStore.read()).filter(
        (record) =>
          record.type === "managed_agent_admitted" &&
          record.parentSessionId === manager.parentSessionId,
      ),
    ).toHaveLength(16);
    await expect(
      manager.spawnBackground({
        callId: "current-parent-attempt-17",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "The seventeenth aggregate attempt must be rejected.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_capacity_exceeded" },
    });
    expect(providerCalls).toBe(16);
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
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

test("AgentManager close causally cancels and drains active background children", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-close-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const entered = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream(request) {
      entered.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "close-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await manager.spawnBackground({
      callId: "close-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Wait until close.",
    });
    await entered.promise;
    await parentRoot.release();
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(manager.close()).resolves.toBeUndefined();
    await expect(
      manager.spawnBackground({
        callId: "after-close-forbidden",
        parentSessionId: manager.parentSessionId,
        signal: new AbortController().signal,
        task: "Must not start after close.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "managed_agent_unavailable" },
    });
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_cancel_requested" },
      { type: "managed_agent_terminal", status: "cancelled" },
    ]);
    const otherRoot = await domain.claimRoot({ rootId: "after-close" });
    await otherRoot.release();
  } finally {
    await manager.close();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager close fences an unresponsive child as recovery-required at the aggregate drain bound", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-close-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const entered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  const providerExited = Promise.withResolvers<void>();
  const childModel: ModelDriver = {
    async *stream() {
      entered.resolve();
      await releaseProvider.promise;
      providerExited.resolve();
      yield { type: "text_delta", text: "Late output must stay fenced." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  let expireDrain = () => {};
  const closeDrainScheduler: ManagedAgentDeadlineScheduler = {
    schedule(delayMilliseconds, onDeadline) {
      expect(delayMilliseconds).toBe(10_000);
      expireDrain = onDeadline;
      return { cancel() {} };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "close-recovery-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    closeDrainScheduler,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await manager.spawnBackground({
      callId: "close-recovery-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Ignore cancellation until the close fence settles.",
    });
    await entered.promise;
    await parentRoot.release();
    const closing = manager.close();
    expireDrain();
    await closing;
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_cancel_requested" },
      { type: "managed_agent_terminal", status: "recovery_required" },
    ]);
    const otherRoot = await domain.claimRoot({ rootId: "after-close-recovery" });
    await otherRoot.release();
    releaseProvider.resolve();
    await providerExited.promise;
    expect(
      (await managedStore.read()).filter((record) => record.type === "managed_agent_terminal"),
    ).toHaveLength(1);
  } finally {
    releaseProvider.resolve();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager close cannot pass a blocked terminal append as a successful recovery fence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-close-terminal-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const childEntered = Promise.withResolvers<void>();
  const terminalAppendBlocked = Promise.withResolvers<void>();
  const allowTerminalAppend = Promise.withResolvers<void>();
  let terminalDurable = false;
  const baseStore = createInMemoryManagedAgentStore();
  const managedStore = {
    async append(record: Parameters<typeof baseStore.append>[0]) {
      if (record.type === "managed_agent_terminal") {
        terminalAppendBlocked.resolve();
        await allowTerminalAppend.promise;
      }
      await baseStore.append(record);
      if (record.type === "managed_agent_terminal") {
        terminalDurable = true;
      }
    },
    read: () => baseStore.read(),
  };
  const childModel: ModelDriver = {
    async *stream(request) {
      childEntered.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (!request.signal.aborted) {
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  let expireDrain = () => {};
  const closeDrainScheduler: ManagedAgentDeadlineScheduler = {
    schedule(_delayMilliseconds, onDeadline) {
      expireDrain = onDeadline;
      return { cancel() {} };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "close-terminal-parent" });
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    closeDrainScheduler,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    await manager.spawnBackground({
      callId: "close-terminal-child",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Settle cancellation into a blocked terminal append.",
    });
    await childEntered.promise;
    await parentRoot.release();
    const closing = manager.close();
    const verifiedClose = closing.then(() => expect(terminalDurable).toBe(true));
    await terminalAppendBlocked.promise;
    expireDrain();
    allowTerminalAppend.resolve();
    await verifiedClose;
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_cancel_requested" },
      { type: "managed_agent_terminal", status: "cancelled" },
    ]);
  } finally {
    allowTerminalAppend.resolve();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("AgentManager close fences a manager-admitted child before logical-run publication", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-close-admission-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const logicalRunBlocked = Promise.withResolvers<void>();
  const allowLogicalRun = Promise.withResolvers<void>();
  const baseDirectory = createInMemorySessionStoreDirectory<SessionRecord>();
  const childSessionStores: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      const store = await baseDirectory.create(sessionId);
      return {
        async append(record) {
          if (record.schemaVersion === 3 && record.record.type === "logical_run_started") {
            logicalRunBlocked.resolve();
            await allowLogicalRun.promise;
          }
          await store.append(record);
        },
        async appendBatch(records) {
          if (
            records.some(
              (record) =>
                record.schemaVersion === 3 && record.record.type === "logical_run_started",
            )
          ) {
            logicalRunBlocked.resolve();
            await allowLogicalRun.promise;
          }
          await store.appendBatch(records);
        },
        read: () => store.read(),
      };
    },
    open: (sessionId) => baseDirectory.open(sessionId),
    listSessionEntries: () => baseDirectory.listSessionEntries(),
    listSessionIds: () => baseDirectory.listSessionIds(),
  };
  let expireDrain = () => {};
  const closeDrainScheduler: ManagedAgentDeadlineScheduler = {
    schedule(_delayMilliseconds, onDeadline) {
      expireDrain = onDeadline;
      return { cancel() {} };
    },
  };
  let providerCalls = 0;
  const childModel: ModelDriver = {
    async *stream() {
      providerCalls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };
  const owner: ProjectLifecycleOwner = {
    async acquire() {
      return { async release() {} };
    },
    async run(operation) {
      return operation();
    },
  };
  const domain = createProjectExecutionDomain({ lifecycleOwner: owner });
  const parentRoot = await domain.claimRoot({ rootId: "close-admission-parent" });
  const managedStore = createInMemoryManagedAgentStore();
  const manager = createAgentManager({
    childContextProfile: contextProfile,
    childModel,
    childSessionStores,
    closeDrainScheduler,
    managedStore,
    parentPermissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    parentRoot,
    projectId,
    targetIdentity,
    workspaceRoot,
  });

  try {
    const spawning = manager.spawnBackground({
      callId: "close-during-admission",
      parentSessionId: manager.parentSessionId,
      signal: new AbortController().signal,
      task: "Block before provider publication.",
    });
    await logicalRunBlocked.promise;
    await parentRoot.release();
    const closing = manager.close();
    expireDrain();
    await closing;
    expect(providerCalls).toBe(0);
    expect(await managedStore.read()).toMatchObject([
      { type: "managed_agent_admitted" },
      { type: "managed_agent_terminal", status: "recovery_required" },
    ]);
    const otherRoot = await domain.claimRoot({ rootId: "after-close-admission" });
    await otherRoot.release();
    allowLogicalRun.resolve();
    await spawning.catch(() => undefined);
    expect(
      (await managedStore.read()).filter((record) => record.type === "managed_agent_terminal"),
    ).toHaveLength(1);
  } finally {
    allowLogicalRun.resolve();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession causally projects a background child admission while the parent run remains active", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const childEntered = Promise.withResolvers<void>();
  const releaseChildProgress = Promise.withResolvers<void>();
  const childProgressed = Promise.withResolvers<void>();
  const releaseChildReasoning = Promise.withResolvers<void>();
  const childReasoningChanged = Promise.withResolvers<void>();
  const releaseParent = Promise.withResolvers<void>();
  const releaseRuntimeRefresh = Promise.withResolvers<void>();
  let parentCalls = 0;
  let expireInactivity = () => {};
  const driver: ModelDriver = {
    async *stream(request) {
      const child = request.messages.some(
        (message) =>
          message.role === "developer" && message.content.startsWith("Managed child profile"),
      );
      if (child) {
        childEntered.resolve();
        await releaseChildProgress.promise;
        yield { type: "text_delta", text: "Causal child progress." };
        childProgressed.resolve();
        await releaseChildReasoning.promise;
        yield {
          type: "reasoning_start",
          id: "managed-causal-reasoning",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "managed-causal-reasoning",
          text: "private managed reasoning",
        };
        childReasoningChanged.resolve();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        expect(request.tools.map((tool) => tool.name)).toEqual([
          "read_file",
          "search_repository",
          "spawn_agent",
          "list_agents",
          "wait_agents",
          "follow_up_agent",
          "cancel_agent",
        ]);
        expect(JSON.stringify(request.tools)).not.toMatch(
          /write_file|edit_file|run_shell|web_|skill|send_agent_message|request_parent_input/u,
        );
        yield { type: "tool_call_start", id: "presentation-background", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "presentation-background",
          json: '{"task":"Inspect through Presentation.","mode":"background"}',
        };
        yield { type: "tool_call_end", id: "presentation-background" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      await releaseParent.promise;
      yield { type: "text_delta", text: "Background scout started." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a2-long-lived.v2",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionManagedAgentInactivityScheduler]: {
      schedule(_delayMilliseconds, onInactivity) {
        let cancelled = false;
        expireInactivity = () => {
          if (!cancelled) {
            onInactivity();
          }
        };
        return {
          cancel() {
            cancelled = true;
          },
        };
      },
    },
  });
  const created = await lifecycle.create({ targetIdentity });
  const presentation = await createPresentationSession({
    lifecycle,
    projectLabel: "managed-presentation",
    sessionId: created.sessionId,
    stateRoot,
    workspaceRoot,
    [presentationRuntimeRefreshBarrier]: {
      beforeRead: () => releaseRuntimeRefresh.promise,
    },
  });
  const observerLifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a2-long-lived.v2",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const runningVisible = Promise.withResolvers<void>();
  const stalledVisible = Promise.withResolvers<void>();
  const resumedVisible = Promise.withResolvers<void>();
  let sawStalled = false;
  const unsubscribe = presentation.subscribe(() => {
    if (
      presentation.getState().authoritative.managedAgents.counts.active === 1 &&
      presentation.getState().authoritative.managedAgents.agents[0]?.status === "running"
    ) {
      runningVisible.resolve();
    }
    if (presentation.getState().authoritative.managedAgents.agents[0]?.status === "stalled") {
      sawStalled = true;
      stalledVisible.resolve();
    }
    if (
      sawStalled &&
      presentation.getState().authoritative.managedAgents.agents[0]?.status === "running"
    ) {
      resumedVisible.resolve();
    }
  });
  try {
    const parentRun = presentation.dispatch({
      type: "submit_prompt",
      sessionId: created.sessionId,
      text: "Start one background child.",
      skills: [],
      thinkingSelection: null,
    });
    await childEntered.promise;
    await withManagedFailureGuard(
      runningVisible.promise,
      "The managed child admission was never projected.",
    );
    const active = presentation.getState().authoritative.managedAgents.agents[0];
    expect(active).toMatchObject({
      profile: "scout.v2",
      status: "running",
      revision: 1,
      targetIdentity,
      transcript: {
        childSessionId: expect.any(String),
        throughSequence: expect.any(Number),
      },
      attemptHistory: [
        {
          attemptId: expect.any(String),
          childSessionId: expect.any(String),
          status: "running",
          current: true,
          throughSequence: expect.any(Number),
        },
      ],
    });
    if (active === undefined) {
      throw new Error("Presentation did not expose the active child.");
    }
    expireInactivity();
    await withManagedFailureGuard(
      stalledVisible.promise,
      "The managed child stalled state was never projected.",
    );
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 1, attention: 1 },
      agents: [{ agentId: active.agentId, status: "stalled", watchdog: { state: "stalled" } }],
    });
    const stalled = presentation.getState().authoritative.managedAgents.agents[0];
    if (stalled === undefined) {
      throw new Error("Presentation did not expose the stalled child.");
    }
    releaseChildProgress.resolve();
    await childProgressed.promise;
    expect(presentation.getState().managedAgentActivity).toMatchObject([
      {
        agentId: active.agentId,
        attemptId: active.attemptId,
        childSessionId: active.transcript.childSessionId,
        activity: "replying",
        assistant: {
          itemId: expect.any(String),
          text: "Causal child progress.",
        },
      },
    ]);
    releaseChildReasoning.resolve();
    await childReasoningChanged.promise;
    expect(presentation.getState().managedAgentActivity).toMatchObject([
      {
        agentId: active.agentId,
        attemptId: active.attemptId,
        childSessionId: active.transcript.childSessionId,
        activity: "thinking",
        reasoning: {
          itemId: expect.stringMatching(/managed-causal-reasoning$/u),
          status: "active",
          hasContent: true,
        },
      },
    ]);
    expect(JSON.stringify(presentation.getState().managedAgentActivity)).not.toContain(
      "private managed reasoning",
    );
    await withManagedFailureGuard(
      resumedVisible.promise,
      "The managed child resumed state was never projected.",
    );
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 1, attention: 0 },
      agents: [{ agentId: active.agentId, status: "running", watchdog: { state: "running" } }],
    });
    const resumed = presentation.getState().authoritative.managedAgents.agents[0];
    if (resumed === undefined) {
      throw new Error("Presentation did not expose the resumed child.");
    }
    await expect(
      observerLifecycle.inspectManagedAgents({ sessionId: created.sessionId }),
    ).resolves.toMatchObject({ counts: { active: 1 }, agents: [{ status: "running" }] });
    await expect(
      lifecycle.inspectManagedAgents({ sessionId: created.sessionId }),
    ).resolves.toMatchObject({
      counts: { active: 1 },
      agents: [{ status: "running" }],
    });
    await expect(
      lifecycle.sendManagedAgentMessage({
        sessionId: created.sessionId,
        agentId: active.agentId,
        expectedRevision: resumed.revision,
        callId: "a2-send-must-stay-unavailable",
        message: "Historical A2 must not gain a mailbox.",
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "project_in_use",
    });
    await expect(
      lifecycle.branch({ parentSessionId: created.sessionId, atSequence: 1 }),
    ).rejects.toMatchObject({ code: "project_in_use" });
    releaseRuntimeRefresh.resolve();
    releaseParent.resolve();
    await expect(parentRun).resolves.toMatchObject({ status: "admitted" });
    await expect(
      presentation.dispatch({
        type: "cancel_managed_agent",
        sessionId: created.sessionId,
        agentId: active.agentId,
        expectedRevision: resumed.revision,
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentControl: {
        action: "cancel",
        agentId: active.agentId,
        record: { digest: expect.stringMatching(/^sha256:/u) },
      },
    });
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 0, terminal: 1 },
      agents: [{ agentId: active.agentId, status: "cancelled", revision: 5 }],
    });
    const cancelled = presentation.getState().authoritative.managedAgents.agents[0];
    if (cancelled === undefined) {
      throw new Error("Presentation did not expose the cancelled child transcript.");
    }
    const cancelledTranscript = await presentation.dispatch({
      type: "read_managed_agent_transcript",
      sessionId: created.sessionId,
      agentId: cancelled.agentId,
      attemptId: cancelled.attemptId,
      expectedRevision: cancelled.revision,
      expectedThroughSequence: cancelled.transcript.throughSequence,
      cursor: null,
    });
    expect(cancelledTranscript).toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning_block",
            text: null,
            artifact: null,
          }),
        ]),
      },
    });
    expect(JSON.stringify(cancelledTranscript)).not.toMatch(
      /Start one background child|private managed reasoning/u,
    );
  } finally {
    unsubscribe();
    releaseRuntimeRefresh.resolve();
    releaseParent.resolve();
    releaseChildProgress.resolve();
    releaseChildReasoning.resolve();
    await observerLifecycle.close();
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession replies to one exact attention without waking a parent turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-presentation-reply-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "managed transcript evidence\n", "utf8");
  let parentCalls = 0;
  let agentId = "";
  let attentionId = "";
  let attentionRevision = 0;
  const childReplyObserved = Promise.withResolvers<void>();
  const recoveryRequestStarted = Promise.withResolvers<void>();
  const releaseRecoveryRequest = Promise.withResolvers<void>();
  const childRequests: ModelRequest[] = [];
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Managed attention" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v2"),
      );
      if (child) {
        childRequests.push(request);
        if (childRequests.length === 1) {
          yield {
            type: "tool_call_start",
            id: "presentation-attention",
            name: "request_parent_input",
          };
          yield {
            type: "tool_call_delta",
            id: "presentation-attention",
            json: '{"question":"Which exact Presentation source should I use?"}',
          };
          yield { type: "tool_call_end", id: "presentation-attention" };
          yield { type: "usage", inputTokens: 10, outputTokens: 3 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (childRequests.length === 2) {
          expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
            role: "tool",
            callId: "presentation-attention",
            result: {
              status: "completed",
              output: { reply: "Use the immutable Presentation source." },
            },
          });
          childReplyObserved.resolve();
          yield { type: "text_delta", text: "Presentation reply observed." };
          yield { type: "usage", inputTokens: 12, outputTokens: 4 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        if (childRequests.length === 3) {
          throw new Error("injected interrupted follow-up");
        }
        if (childRequests.length === 4) {
          recoveryRequestStarted.resolve();
          await releaseRecoveryRequest.promise;
          yield { type: "tool_call_start", id: "presentation-recovery-read", name: "read_file" };
          yield {
            type: "tool_call_delta",
            id: "presentation-recovery-read",
            json: '{"path":"evidence.txt"}',
          };
          yield { type: "tool_call_end", id: "presentation-recovery-read" };
          yield { type: "usage", inputTokens: 6, outputTokens: 2 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (childRequests.length === 5) {
          expect(JSON.stringify(request.messages)).toContain(
            "Use the queued Presentation message.",
          );
          yield { type: "text_delta", text: "Recovered Presentation follow-up." };
          yield { type: "usage", inputTokens: 7, outputTokens: 3 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        if (childRequests.length === 6) {
          yield {
            type: "tool_call_start",
            id: "presentation-follow-up-report",
            name: "report_to_parent",
          };
          yield {
            type: "tool_call_delta",
            id: "presentation-follow-up-report",
            json: '{"kind":"progress","message":"Follow-up evidence is being verified."}',
          };
          yield { type: "tool_call_end", id: "presentation-follow-up-report" };
          yield { type: "tool_call_start", id: "presentation-follow-up-read", name: "read_file" };
          yield {
            type: "tool_call_delta",
            id: "presentation-follow-up-read",
            json: '{"path":"evidence.txt"}',
          };
          yield { type: "tool_call_end", id: "presentation-follow-up-read" };
          yield { type: "usage", inputTokens: 5, outputTokens: 2 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Partial failed follow-up." };
        throw new ModelDriverError("transport", "injected follow-up provider failure", {
          cause: new Error("private injected failure"),
        });
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-presentation-attention", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-presentation-attention",
          json: '{"task":"Request Presentation input.","profile":"research.v2","mode":"background"}',
        };
        yield { type: "tool_call_end", id: "spawn-presentation-attention" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 2) {
        const spawn = request.messages.findLast(
          (message) => message.role === "tool" && message.name === "spawn_agent",
        );
        if (
          spawn?.role !== "tool" ||
          spawn.result.status !== "completed" ||
          spawn.result.output === null ||
          typeof spawn.result.output !== "object" ||
          !("agentId" in spawn.result.output)
        ) {
          throw new Error("The Presentation child identity was unavailable.");
        }
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        agentId = String(spawn.result.output["agentId"]);
        yield { type: "tool_call_start", id: "wait-presentation-attention", name: "wait_agents" };
        yield {
          type: "tool_call_delta",
          id: "wait-presentation-attention",
          json: JSON.stringify({ agentIds: [agentId], until: "attention" }),
        };
        yield { type: "tool_call_end", id: "wait-presentation-attention" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (parentCalls === 3) {
        const wait = request.messages.findLast(
          (message) => message.role === "tool" && message.name === "wait_agents",
        );
        const output =
          wait?.role === "tool" && wait.result.status === "completed" ? wait.result.output : null;
        const agents =
          output !== null && typeof output === "object" && "agents" in output
            ? // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
              output["agents"]
            : undefined;
        const attention = Array.isArray(agents) ? agents[0] : undefined;
        if (attention === null || typeof attention !== "object" || !("attention" in attention)) {
          throw new Error("The exact attention snapshot was unavailable.");
        }
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        const attentionValue = attention["attention"];
        if (
          attentionValue === null ||
          typeof attentionValue !== "object" ||
          !("attentionId" in attentionValue) ||
          !("revision" in attention)
        ) {
          throw new Error("The exact attention identity was unavailable.");
        }
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        attentionId = String(attentionValue["attentionId"]);
        // biome-ignore lint/complexity/useLiteralKeys: narrowed JsonValue index signatures require bracket access.
        attentionRevision = Number(attention["revision"]);
        yield { type: "text_delta", text: "The child needs exact parent input." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (parentCalls === 4) {
        yield { type: "tool_call_start", id: "wait-presentation-terminal", name: "wait_agents" };
        yield {
          type: "tool_call_delta",
          id: "wait-presentation-terminal",
          json: JSON.stringify({ agentIds: [agentId], until: "all_terminal" }),
        };
        yield { type: "tool_call_end", id: "wait-presentation-terminal" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "The child reached terminal state." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a3-long-lived.v2",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "attention-presentation",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationManagedAgentTranscriptPageSize]: 1,
    });
    const attentionVisible = Promise.withResolvers<void>();
    const unsubscribeAttention = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.managedAgents.agents.some(
            (agent) => agent.status === "waiting_for_parent" && agent.attention !== undefined,
          )
      ) {
        attentionVisible.resolve();
      }
    });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Start and wait for one attention request." },
    });
    expect(parentCalls).toBe(3);
    await attentionVisible.promise;
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 1, terminal: 0, attention: 1 },
      agents: [
        {
          agentId,
          status: "waiting_for_parent",
          revision: attentionRevision,
          attention: {
            attentionId,
            question: "Which exact Presentation source should I use?",
          },
        },
      ],
    });
    unsubscribeAttention();
    await expect(
      presentation.dispatch({
        type: "send_managed_agent_message",
        sessionId: created.sessionId,
        agentId,
        expectedRevision: attentionRevision,
        attentionId,
        message: "Use the immutable Presentation source.",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await childReplyObserved.promise;
    expect(parentCalls).toBe(3);
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Now wait for the replied child to finish." },
    });
    await presentation.dispatch({ type: "refresh_managed_agents", sessionId: created.sessionId });
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 0, terminal: 1, attention: 0 },
      agents: [{ agentId, status: "completed" }],
    });
    expect(presentation.getState().authoritative.managedAgents.counts).toEqual({
      active: 0,
      terminal: 1,
      attention: 0,
    });
    const terminalAgent = presentation
      .getState()
      .authoritative.managedAgents.agents.find((agent) => agent.agentId === agentId);
    if (terminalAgent === undefined) {
      throw new Error("The terminal managed child was unavailable for transcript inspection.");
    }
    const latestTranscript = await presentation.dispatch({
      type: "read_managed_agent_transcript",
      sessionId: created.sessionId,
      agentId,
      attemptId: terminalAgent.attemptId,
      expectedRevision: terminalAgent.revision,
      expectedThroughSequence: terminalAgent.transcript.throughSequence,
      cursor: null,
    });
    expect(latestTranscript).toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        type: "managed_agent_transcript_page",
        agentId,
        attemptId: terminalAgent.attemptId,
        childSessionId: terminalAgent.transcript.childSessionId,
        throughSequence: terminalAgent.transcript.throughSequence,
        items: [
          expect.objectContaining({
            type: "assistant_message",
            text: "Presentation reply observed.",
          }),
        ],
        olderCursor: expect.stringMatching(/^managed-agent-transcript:/u),
      },
    });
    expect(JSON.stringify(latestTranscript)).not.toMatch(
      /Request Presentation input|Which exact Presentation source should I use/u,
    );
    await expect(
      presentation.dispatch({
        type: "read_managed_agent_transcript",
        sessionId: created.sessionId,
        agentId,
        attemptId: terminalAgent.attemptId,
        expectedRevision: terminalAgent.revision,
        expectedThroughSequence: terminalAgent.transcript.throughSequence - 1,
        cursor: null,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "stale_interaction" });
    if (
      latestTranscript.status !== "admitted" ||
      latestTranscript.managedAgentTranscript === undefined
    ) {
      throw new Error("The latest managed transcript page was unavailable.");
    }
    await expect(
      presentation.dispatch({
        type: "read_managed_agent_transcript",
        sessionId: created.sessionId,
        agentId,
        attemptId: terminalAgent.attemptId,
        expectedRevision: terminalAgent.revision,
        expectedThroughSequence: terminalAgent.transcript.throughSequence,
        cursor: latestTranscript.managedAgentTranscript.olderCursor,
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: [
          expect.objectContaining({
            type: "tool_call",
            qualifiedName: "request_parent_input",
          }),
        ],
        olderCursor: null,
      },
    });
    const interruptedVisible = Promise.withResolvers<void>();
    const recoveredVisible = Promise.withResolvers<void>();
    const unsubscribeRecovery = presentation.subscribe(() => {
      const agent = presentation
        .getState()
        .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
      if (agent?.status === "recovery_required" && agent.attemptHistory.length === 2) {
        interruptedVisible.resolve();
      }
      if (agent?.status === "completed" && agent.attemptHistory.length === 3) {
        recoveredVisible.resolve();
      }
    });
    await expect(
      presentation.dispatch({
        type: "follow_up_managed_agent",
        sessionId: created.sessionId,
        agentId,
        expectedRevision: terminalAgent.revision,
        task: "Create one interrupted recovery boundary.",
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentControl: {
        action: "follow_up",
        agentId,
        record: { digest: expect.stringMatching(/^sha256:/u) },
      },
    });
    await interruptedVisible.promise;
    const recoveryRequiredAgent = presentation
      .getState()
      .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
    expect(recoveryRequiredAgent).toMatchObject({
      status: "recovery_required",
      attemptHistory: [
        expect.objectContaining({ status: "completed", current: false }),
        expect.objectContaining({ status: "recovery_required", current: true }),
      ],
    });
    if (recoveryRequiredAgent === undefined) {
      throw new Error("The recovery-required managed child was unavailable.");
    }
    await expect(
      presentation.dispatch({
        type: "recover_managed_agent",
        sessionId: created.sessionId,
        agentId,
        expectedRevision: recoveryRequiredAgent.revision,
        task: "Recover from the exact interrupted attempt.",
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentControl: {
        action: "recovery",
        agentId,
        record: { digest: expect.stringMatching(/^sha256:/u) },
      },
    });
    await recoveryRequestStarted.promise;
    const activeRecoveryAgent = presentation
      .getState()
      .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
    expect(activeRecoveryAgent).toMatchObject({ status: "running" });
    if (activeRecoveryAgent === undefined) {
      throw new Error("The active managed recovery attempt was unavailable.");
    }
    await expect(
      presentation.dispatch({
        type: "send_managed_agent_message",
        sessionId: created.sessionId,
        agentId,
        expectedRevision: activeRecoveryAgent.revision,
        message: "Use the queued Presentation message.",
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentControl: {
        action: "message",
        agentId,
        attemptId: activeRecoveryAgent.attemptId,
        revision: activeRecoveryAgent.revision + 1,
        messageId: expect.stringMatching(/^sha256:/u),
        delivery: "enqueued",
        record: {
          id: expect.stringMatching(/^sha256:/u),
          revision: expect.any(Number),
          digest: expect.stringMatching(/^sha256:/u),
        },
      },
    });
    expect(
      presentation
        .getState()
        .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId),
    ).toMatchObject({
      messages: [
        expect.objectContaining({
          kind: "reply",
          status: "delivered",
        }),
        expect.objectContaining({
          kind: "message",
          message: "Use the queued Presentation message.",
          status: "enqueued",
        }),
      ],
    });
    releaseRecoveryRequest.resolve();
    await recoveredVisible.promise;
    unsubscribeRecovery();
    const recoveredAgent = presentation
      .getState()
      .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
    expect(recoveredAgent).toMatchObject({
      status: "completed",
      attemptHistory: [
        expect.objectContaining({ status: "completed", current: false }),
        expect.objectContaining({ status: "recovery_required", current: false }),
        expect.objectContaining({ status: "completed", current: true }),
      ],
    });
    if (recoveredAgent === undefined) {
      throw new Error("The recovered managed child was unavailable for follow-up.");
    }
    const failedVisible = Promise.withResolvers<void>();
    const reportVisible = Promise.withResolvers<void>();
    const unsubscribeFailed = presentation.subscribe(() => {
      const agent = presentation
        .getState()
        .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
      if (agent?.status === "failed") {
        failedVisible.resolve();
      }
      if (
        agent?.reports?.some((report) => report.message === "Follow-up evidence is being verified.")
      ) {
        reportVisible.resolve();
      }
    });
    await expect(
      presentation.dispatch({
        type: "follow_up_managed_agent",
        sessionId: created.sessionId,
        agentId,
        expectedRevision: recoveredAgent.revision,
        task: "Read the exact evidence and report again.",
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentControl: {
        action: "follow_up",
        agentId,
        record: { digest: expect.stringMatching(/^sha256:/u) },
      },
    });
    await reportVisible.promise;
    await withManagedFailureGuard(
      failedVisible.promise,
      "The managed follow-up failure was never projected.",
    );
    unsubscribeFailed();
    const failedAgent = presentation
      .getState()
      .authoritative.managedAgents.agents.find((candidate) => candidate.agentId === agentId);
    expect(failedAgent).toMatchObject({
      status: "failed",
      phase: "terminal",
      error: { code: "model_request_failed" },
      partialOutput: {
        text: "Partial failed follow-up.",
        byteCount: 25,
        truncated: false,
      },
      reports: [
        expect.objectContaining({
          kind: "progress",
          message: "Follow-up evidence is being verified.",
        }),
      ],
      attemptHistory: [
        expect.objectContaining({ status: "completed", current: false }),
        expect.objectContaining({ status: "recovery_required", current: false }),
        expect.objectContaining({ status: "completed", current: false }),
        expect.objectContaining({ status: "failed", current: true }),
      ],
      usage: {
        inputTokens: 40,
        outputTokens: 14,
        reasoningTokens: 0,
        providerCalls: 7,
      },
      budget: {
        maximumCumulativeTokens: 128_000,
        usedTokens: 54,
        remainingTokens: 127_946,
      },
    });
    if (failedAgent === undefined) {
      throw new Error("The failed managed child was unavailable for transcript inspection.");
    }
    const failedTranscript = await presentation.dispatch({
      type: "read_managed_agent_transcript",
      sessionId: created.sessionId,
      agentId,
      attemptId: failedAgent.attemptId,
      expectedRevision: failedAgent.revision,
      expectedThroughSequence: failedAgent.transcript.throughSequence,
      cursor: null,
    });
    expect(failedTranscript).toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: [
          expect.objectContaining({
            type: "session_notice",
            status: "failed",
            code: "model_request_failed",
          }),
        ],
        olderCursor: expect.stringMatching(/^managed-agent-transcript:/u),
      },
    });
    if (
      failedTranscript.status !== "admitted" ||
      failedTranscript.managedAgentTranscript === undefined
    ) {
      throw new Error("The failed managed transcript page was unavailable.");
    }
    const failedPartialTranscript = await presentation.dispatch({
      type: "read_managed_agent_transcript",
      sessionId: created.sessionId,
      agentId,
      attemptId: failedAgent.attemptId,
      expectedRevision: failedAgent.revision,
      expectedThroughSequence: failedAgent.transcript.throughSequence,
      cursor: failedTranscript.managedAgentTranscript.olderCursor,
    });
    expect(failedPartialTranscript).toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: [
          expect.objectContaining({
            type: "assistant_message",
            text: "Partial failed follow-up.",
          }),
        ],
        olderCursor: expect.stringMatching(/^managed-agent-transcript:/u),
      },
    });
    if (
      failedPartialTranscript.status !== "admitted" ||
      failedPartialTranscript.managedAgentTranscript === undefined
    ) {
      throw new Error("The failed managed partial-output page was unavailable.");
    }
    const failedToolTranscript = await presentation.dispatch({
      type: "read_managed_agent_transcript",
      sessionId: created.sessionId,
      agentId,
      attemptId: failedAgent.attemptId,
      expectedRevision: failedAgent.revision,
      expectedThroughSequence: failedAgent.transcript.throughSequence,
      cursor: failedPartialTranscript.managedAgentTranscript.olderCursor,
    });
    expect(failedToolTranscript).toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: [
          expect.objectContaining({
            type: "tool_call",
            qualifiedName: "read_file",
            status: "completed",
          }),
        ],
        olderCursor: expect.stringMatching(/^managed-agent-transcript:/u),
      },
    });
    if (
      failedToolTranscript.status !== "admitted" ||
      failedToolTranscript.managedAgentTranscript === undefined
    ) {
      throw new Error("The failed managed tool page was unavailable.");
    }
    await expect(
      presentation.dispatch({
        type: "read_managed_agent_transcript",
        sessionId: created.sessionId,
        agentId,
        attemptId: failedAgent.attemptId,
        expectedRevision: failedAgent.revision,
        expectedThroughSequence: failedAgent.transcript.throughSequence,
        cursor: failedToolTranscript.managedAgentTranscript.olderCursor,
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      managedAgentTranscript: {
        items: [
          expect.objectContaining({
            type: "tool_call",
            qualifiedName: "report_to_parent",
            status: "completed",
          }),
        ],
        olderCursor: null,
      },
    });
    await presentation.close();
  } finally {
    releaseRecoveryRequest.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
