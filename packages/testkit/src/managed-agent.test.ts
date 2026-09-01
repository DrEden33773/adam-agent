import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type AgentSessionDependencies,
  type ArtifactStore,
  createPermissionPolicy,
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
  const parentDependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model: parentModel,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["delegate"] }),
    store: createInMemorySessionStore(),
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
    task: "Interrupted admitted task.",
    taskDigest: testTaskDigest("Interrupted admitted task."),
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
    task: "Reject a mismatched terminal.",
    taskDigest: testTaskDigest("Reject a mismatched terminal."),
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
    task: recoveredTask,
    taskDigest: testTaskDigest(recoveredTask),
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
    task: "Inspect a mismatched child identity.",
    taskDigest: testTaskDigest("Inspect a mismatched child identity."),
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
