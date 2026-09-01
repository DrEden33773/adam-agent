import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type AgentSessionDependencies,
  type ArtifactStore,
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  createSessionLifecycle,
  type ModelDriver,
  type ModelRequest,
  type ModelTargets,
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
  type ManagedAgentDeadlineScheduler,
  ManagedAgentStoreError,
  managedAgentPromptSummary,
  type ProjectLifecycleOwner,
  recoverInterruptedManagedAgents,
  type SessionRecord,
  type SessionStore,
  type SessionStoreDirectory,
  scoutManagedAgentProfileV1,
  sessionDurableContext,
  sessionToolProfileNames,
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
    expect(manager.promptSummary()).toContain("0 active, 1 completed");
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
      output: { counts: { active: 0, completed: 1 } },
    });
  } finally {
    releaseFollowUp.resolve();
    await manager.waitForIdle();
    await parentRoot.release();
    await domain.close();
    await rm(testRoot, { recursive: true, force: true });
  }
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
      "Managed agents: 1 active, 1 completed, 0 need attention; IDs: child-a, child-b",
  };
  const session = new AgentSession(dependencies);

  await expect(session.run({ text: "Continue without ambient child results." })).resolves.toEqual({
    status: "completed",
    answer: "Summary observed.",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages).toContainEqual({
    role: "developer",
    content: "Managed agents: 1 active, 1 completed, 0 need attention; IDs: child-a, child-b",
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

test("PresentationSession refreshes agent cards and cancels one exact active child", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const childEntered = Promise.withResolvers<void>();
  let parentCalls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      const child = request.messages.some(
        (message) =>
          message.role === "developer" && message.content.startsWith("Managed child profile"),
      );
      if (child) {
        childEntered.resolve();
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
    managedAgentTools: "managed-agent-tools.a2-long-lived.v1",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const created = await lifecycle.create({ targetIdentity });
  const presentation = await createPresentationSession({
    lifecycle,
    projectLabel: "managed-presentation",
    sessionId: created.sessionId,
    stateRoot,
    workspaceRoot,
  });
  const observerLifecycle = createSessionLifecycle({
    managedAgentTools: "managed-agent-tools.a2-long-lived.v1",
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId: created.sessionId,
        text: "Start one background child.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await childEntered.promise;
    await presentation.dispatch({
      type: "refresh_managed_agents",
      sessionId: created.sessionId,
    });
    const active = presentation.getState().authoritative.managedAgents.agents[0];
    expect(active).toMatchObject({ status: "running", revision: 1 });
    if (active === undefined) {
      throw new Error("Presentation did not expose the active child.");
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
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "project_in_use",
    });
    await expect(
      lifecycle.branch({ parentSessionId: created.sessionId, atSequence: 1 }),
    ).rejects.toMatchObject({ code: "project_in_use" });
    await expect(
      presentation.dispatch({
        type: "cancel_managed_agent",
        sessionId: created.sessionId,
        agentId: active.agentId,
        expectedRevision: active.revision,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.managedAgents).toMatchObject({
      counts: { active: 0, completed: 1 },
      agents: [{ agentId: active.agentId, status: "cancelled", revision: 3 }],
    });
  } finally {
    await observerLifecycle.close();
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
