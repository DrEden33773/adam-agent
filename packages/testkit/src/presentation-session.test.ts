import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createExtensionHost,
  createFileArtifactStore,
  createInMemoryOperationStore,
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createPresentationSession as createProductPresentationSession,
  createReadToolRegistry,
  createSessionLifecycle,
  type ModelDriver,
  ModelDriverError,
  type ModelTargetIdentity,
  type ModelTargets,
  type OperationStore,
  type SessionLifecycle,
} from "@adam-agent/agent";
import {
  assemblePromptMessagesV1,
  createInMemorySessionStoreDirectory,
  digestPromptRequestV1,
  mcpCatalogStaleDurableBarrier,
  mcpTransportFactory,
  openJsonlSessionStore,
  preparedDirectDeepSeekV2ContextProfile,
  presentationCatalogPageSize,
  presentationHistoryPageSize,
  presentationHydrationBarrier,
  presentationRuntimeRefreshBarrier,
  presentationSessionRecordReader,
  resolvePresentationTerminalContext,
  type SessionRecord,
  type SessionStore,
  type SessionStoreDirectory,
  sessionAutomaticTitlesEnabled,
  sessionLogicalRunStartedBarrier,
  sessionRuntimeNotificationTransform,
  sessionStoreDirectory,
  sessionTitleDeadlineScheduler,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import {
  createInMemorySessionLifecycleHarness,
  createScriptedMcpTransportFactory,
  FakeModelDriver,
  type ScriptedMcpServer,
} from "./index.js";

const targetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

const contextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
};

async function createPresentationSession(
  options: Parameters<typeof createProductPresentationSession>[0],
) {
  if ("targetIdentity" in options && options.targetIdentity !== undefined) {
    const { lifecycle, targetIdentity: fixtureTargetIdentity, ...base } = options;
    const created = await lifecycle.create({ targetIdentity: fixtureTargetIdentity });
    return createProductPresentationSession({
      ...base,
      lifecycle,
      sessionId: created.sessionId,
    });
  }
  return createProductPresentationSession(options);
}
function settledModelTargets(answer = "Presentation fixture answer."): ModelTargets {
  const driver = new FakeModelDriver([
    { type: "text_delta", text: answer },
    { type: "finish", reason: "stop" },
  ]);
  return {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
}

async function createThinkingPolicyPresentationFixture(prefix: string) {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const policyTargetIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
  const productionTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
  });
  const productionSnapshot = await productionTargets.snapshot({
    signal: new AbortController().signal,
  });
  const thinkingCapability = productionSnapshot.targets.find(
    (target) =>
      target.identity.targetId === policyTargetIdentity.targetId &&
      target.identity.profileVersion === policyTargetIdentity.profileVersion,
  )?.thinkingCapability;
  if (thinkingCapability === undefined) {
    throw new Error("Expected the exact Direct DeepSeek thinking capability.");
  }
  let resolvedThinkingCapability = thinkingCapability;
  const requestPolicies: Array<unknown> = [];
  const driver = new FakeModelDriver((request) => {
    requestPolicies.push(request.thinkingPolicy);
    const latestUser = request.messages.findLast((message) => message.role === "user")?.content;
    const text =
      latestUser === "Use low thinking."
        ? "Low thinking response."
        : latestUser === "Use max thinking next."
          ? "Max thinking response."
          : "Thinking policy session";
    return [
      { type: "text_delta", text },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: policyTargetIdentity,
        driver,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        thinkingCapability: resolvedThinkingCapability,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: policyTargetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            thinkingCapability,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  const open = (sessionId?: string) =>
    createPresentationSession({
      lifecycle,
      modelTargets,
      ...(sessionId === undefined ? { openProject: true } : { sessionId }),
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
  return {
    close: async () => {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    },
    harness,
    open,
    policyTargetIdentity,
    replaceResolvedThinkingCapability(capability: typeof thinkingCapability) {
      resolvedThinkingCapability = capability;
    },
    requestPolicies,
    thinkingCapability,
  };
}

function waitForAssistantMessage(
  presentation: Awaited<ReturnType<typeof createPresentationSession>>,
  text: string,
): Promise<void> {
  const completed = Promise.withResolvers<void>();
  const observed = () =>
    presentation
      .getState()
      .authoritative.active?.transcript.items.some(
        (item) => item.type === "assistant_message" && item.text === text,
      ) === true;
  const unsubscribe = presentation.subscribe(() => {
    if (observed()) {
      unsubscribe();
      completed.resolve();
    }
  });
  if (observed()) {
    unsubscribe();
    completed.resolve();
  }
  return completed.promise;
}

async function writePresentationOperationExtension(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            kind: "operation",
            id: "fixture.review",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute(input) { return { accepted: true, revision: input.revision }; },
  });
}
`,
    "utf8",
  );
}

async function writePresentationProgressOperationExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writePresentationOperationExtension(packageRoot);
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, operation) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      await operation.progress({
        completed: 1,
        phase: "analyzing",
        total: 2,
        detail: "x".repeat(1_000),
      });
      control.progressPublished();
      await control.releaseExecution;
      return { accepted: true, revision: input.revision };
    },
  });
}
`,
    "utf8",
  );
}

async function writePresentationRepairOperationExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writePresentationOperationExtension(packageRoot);
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, operation) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.executionStarted();
      await control.releaseProgress;
      await operation.progress({ phase: "repairing" });
      control.progressPublished();
      await control.releaseExecution;
      return { accepted: true, revision: input.revision };
    },
  });
}
`,
    "utf8",
  );
}

async function writePresentationConcurrentRepairOperationExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writePresentationOperationExtension(packageRoot);
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(input, operation) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.executionStarted(input.revision);
      await control.releaseProgress[input.revision];
      await operation.progress({ phase: input.revision });
      control.progressPublished(input.revision);
      await control.releaseExecution[input.revision];
      return { accepted: true, revision: input.revision };
    },
  });
}
`,
    "utf8",
  );
}

async function writePresentationCancellableOperationExtension(
  packageRoot: string,
  controlKey: string,
): Promise<void> {
  await writePresentationOperationExtension(packageRoot);
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(_input, operation) {
      globalThis[${JSON.stringify(controlKey)}].executionStarted();
      await new Promise((resolve, reject) => {
        operation.signal.addEventListener("abort", () => reject(operation.signal.reason), {
          once: true,
        });
      });
      return { unreachable: true };
    },
  });
}
`,
    "utf8",
  );
}

async function writePresentationRecoverableOperationExtension(
  packageRoot: string,
  controlKey?: string,
): Promise<void> {
  await writePresentationOperationExtension(packageRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  packageJson.adamAgent.contributions[0].recovery = { version: 1 };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(packageJson), "utf8");
  const reconciliation =
    controlKey === undefined
      ? `reconcile(input) {
      return {
        status: "completed",
        output: { accepted: true, recovered: true, revision: input.revision },
      };
    },`
      : `async reconcile(input) {
      const control = globalThis[${JSON.stringify(controlKey)}];
      control.reconciliationStarted();
      await control.releaseReconciliation;
      if (control.rejectReconciliation === true) {
        throw new Error("injected reconciliation failure");
      }
      return {
        status: "completed",
        output: { accepted: true, recovered: true, revision: input.revision },
      };
    },`;
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute(input) { return { accepted: true, revision: input.revision }; },
    ${reconciliation}
  });
}
`,
    "utf8",
  );
}

async function writePresentationArtifactOperationExtension(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.extension",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: {
          required: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [
          {
            kind: "operation",
            id: "fixture.review",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
            report: { id: "fixture.report", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `export function activate(context) {
  const codec = (id) => ({
    id,
    version: 1,
    decode(value) { return { ok: true, value }; },
    encode(value) { return { ok: true, value }; },
  });
  context.registerOperation({
    id: "fixture.review",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    async execute(_input, operation) {
      const report = await operation.capabilities["adam.artifact.publish@1"].publish({
        bytes: new TextEncoder().encode("# Fixture review report"),
        contract: { id: "fixture.report", version: 1 },
        mediaType: "text/markdown",
      });
      return { report };
    },
  });
}
`,
    "utf8",
  );
}

function presentationThinkingSelection(
  capability: {
    readonly capabilityId: string;
    readonly capabilityVersion: 1;
    readonly capabilityDigest: `sha256:${string}`;
  },
  requestedLevelId: string,
) {
  return {
    requestedLevelId,
    capability: {
      id: capability.capabilityId,
      version: capability.capabilityVersion,
      digest: capability.capabilityDigest,
    },
  };
}

function readInMemoryPresentationRecords(directory: SessionStoreDirectory<SessionRecord>) {
  return async (sessionId: string): Promise<readonly SessionRecord[]> =>
    (await directory.open(sessionId))?.read() ?? [];
}
const testEnvironment = process.env as NodeJS.ProcessEnv & { HOME?: string };
async function writeScriptedMcpConfiguration(
  testRoot: string,
  workspaceRoot: string,
): Promise<void> {
  const executablePath = join(testRoot, "scripted-mcp");
  await writeFile(executablePath, "#!/bin/sh\nexit 1\n");
  await chmod(executablePath, 0o755);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: executablePath } } }),
    "utf8",
  );
}

function ordinaryScriptedMcpServer(): ScriptedMcpServer {
  const inputSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  } as const;
  return {
    toolPages: [
      {
        tools: [{ name: "echo", description: "Echo a value.", inputSchema }],
        nextCursor: "page-2",
      },
      {
        cursor: "page-2",
        tools: [{ name: "uppercase", description: "Uppercase a value.", inputSchema }],
      },
    ],
  };
}

async function openActivatedMcpPresentationFixture(prefix: string) {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  const peer = createScriptedMcpTransportFactory({ fixture: ordinaryScriptedMcpServer() });
  const lifecycle = createSessionLifecycle({
    [mcpTransportFactory]: peer,
    stateRoot,
    workspaceRoot,
  });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const initial = presentation.getState().authoritative.active;
    if (initial?.mcp === null || initial?.mcp === undefined) {
      throw new Error("Expected MCP confirmation state.");
    }
    await presentation.dispatch({
      type: "confirm_mcp_workspace",
      sessionId: initial.session.id,
      sourceDigest: initial.mcp.source.digest,
    });
    const server = presentation.getState().authoritative.active?.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("Expected MCP server preview.");
    }
    await presentation.dispatch({
      type: "approve_mcp_server",
      sessionId: initial.session.id,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });
    await presentation.dispatch({
      type: "activate_mcp_servers",
      sessionId: initial.session.id,
      servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
    });
    return {
      lifecycle,
      peer,
      presentation,
      stateRoot,
      testRoot,
      workspaceRoot,
      async close() {
        await presentation.close();
        await lifecycle.close();
        await rm(testRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
    throw error;
  }
}

test("PresentationSession opens an empty project catalog without creating a session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-project-open-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    const state = presentation.getState();
    expect(state).toEqual({
      revision: 1,
      authoritative: {
        schemaVersion: 1,
        continuity: {
          status: "current",
          sessionThroughSequence: 0,
          operationThrough: [],
        },
        project: { id: state.authoritative.project.id, label: "workspace" },
        targets: { items: [], defaultTargetId: null, diagnostic: null },
        sessions: { items: [], nextCursor: null },
        active: null,
      },
      draft: null,
      transient: null,
    });
    expect(state.authoritative.project.id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects exact target identity and readiness for project launch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-targets-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const thinkingCapability = {
    schemaVersion: 1 as const,
    capabilityId: "deepseek-thinking:test-profile",
    capabilityVersion: 1 as const,
    capabilityDigest: `sha256:${"2".repeat(64)}` as const,
    targetIdentity,
    providerProfile: {
      id: "@ai-sdk/deepseek/chat" as const,
      version: "3.0.28" as const,
      requestPath: "provider_options.deepseek" as const,
    },
    supportsOff: true as const,
    defaultLevelId: "high",
    providerDefault: { effectiveLevelId: "high", mutable: true as const },
    levels: [
      {
        id: "off",
        label: "Off",
        effectiveLevelId: "off",
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "disabled" as const,
        },
      },
      ...(["low", "high", "max"] as const).map((level) => ({
        id: level,
        label: `${level[0]?.toUpperCase()}${level.slice(1)}`,
        effectiveLevelId: level,
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "enabled" as const,
          reasoningEffort: level,
        },
      })),
    ],
    reasoningArtifact: "provider_reasoning" as const,
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Target projection does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
            thinkingCapability,
          },
          {
            identity: {
              targetId: "poolside-laguna-s-2.1-free.gateway",
              vendor: "poolside",
              modelId: "poolside/laguna-s-2.1-free",
              route: "vercel-ai-gateway",
              upstreamProviderId: "poolside",
              profileVersion: 1,
              certification: "experimental",
            },
            readiness: { status: "missing", credentialSource: "AI_GATEWAY_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };

  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    expect(presentation.getState().authoritative.targets).toEqual({
      items: [
        {
          targetId: "deepseek-v4-flash.direct",
          label: "deepseek-v4-flash",
          route: "direct",
          certification: "Certified",
          readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
          thinking: {
            capabilityId: "deepseek-thinking:test-profile",
            capabilityVersion: 1,
            capabilityDigest: `sha256:${"2".repeat(64)}`,
            defaultLevelId: "high",
            levels: [
              { id: "off", label: "Off", effectiveLevelId: "off" },
              { id: "low", label: "Low", effectiveLevelId: "low" },
              { id: "high", label: "High", effectiveLevelId: "high" },
              { id: "max", label: "Max", effectiveLevelId: "max" },
            ],
          },
        },
        {
          targetId: "poolside-laguna-s-2.1-free.gateway",
          label: "poolside/laguna-s-2.1-free",
          route: "vercel-ai-gateway",
          certification: "Experimental",
          readiness: { status: "missing", credentialSource: "AI_GATEWAY_API_KEY" },
          thinking: null,
        },
      ],
      defaultTargetId: null,
      diagnostic: null,
    });
    expect(presentation.getState().authoritative.active).toBeNull();

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession admits exact thinking choices for draft and active prompts", async () => {
  const fixture = await createThinkingPolicyPresentationFixture(
    "adam-agent-presentation-thinking-policy-",
  );
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;

  try {
    presentation = await fixture.open();
    await presentation.dispatch({
      type: "create_session",
      targetId: fixture.policyTargetIdentity.targetId,
    });
    const firstResponse = waitForAssistantMessage(presentation, "Low thinking response.");
    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Use low thinking.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "low"),
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await firstResponse;
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected the draft prompt to admit one active session.");
    }
    await presentation.close();
    presentation = await fixture.open(sessionId);
    const secondResponse = waitForAssistantMessage(presentation, "Max thinking response.");
    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Use max thinking next.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "max"),
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await secondResponse;

    const records = await readInMemoryPresentationRecords(fixture.harness.sessions)(sessionId);
    expect(
      records.flatMap((record) =>
        record.schemaVersion === 3 && record.record.type === "logical_run_started"
          ? [record.record.thinkingPolicy]
          : [],
      ),
    ).toMatchObject([
      { requestedLevelId: "low", effectiveLevelId: "low" },
      { requestedLevelId: "max", effectiveLevelId: "max" },
    ]);
    expect(
      fixture.requestPolicies.filter(
        (policy): policy is { readonly requestedLevelId: string } => policy !== undefined,
      ),
    ).toMatchObject([{ requestedLevelId: "low" }, { requestedLevelId: "max" }]);
    expect(fixture.requestPolicies).toContain(undefined);
  } finally {
    await presentation?.close();
    await fixture.close();
  }
});

test("PresentationSession returns actionable choices for an unsupported draft thinking level", async () => {
  const fixture = await createThinkingPolicyPresentationFixture(
    "adam-agent-presentation-thinking-draft-rejection-",
  );
  const presentation = await fixture.open();

  try {
    await presentation.dispatch({
      type: "create_session",
      targetId: fixture.policyTargetIdentity.targetId,
    });
    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Reject an unsupported draft level.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "medium"),
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "thinking_policy_unsupported",
      message: "The requested thinking policy is unavailable. Choose off, low, high, max.",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(fixture.requestPolicies).toEqual([]);
  } finally {
    await presentation.close();
    await fixture.close();
  }
});

test("PresentationSession rejects a changed thinking capability between display and draft admission", async () => {
  const fixture = await createThinkingPolicyPresentationFixture(
    "adam-agent-presentation-thinking-capability-race-",
  );
  const presentation = await fixture.open();

  try {
    await presentation.dispatch({
      type: "create_session",
      targetId: fixture.policyTargetIdentity.targetId,
    });
    const { capabilityDigest: _digest, ...changedProfile } = {
      ...fixture.thinkingCapability,
      capabilityId: `${fixture.thinkingCapability.capabilityId}:refreshed`,
    };
    const changedCapability = {
      ...changedProfile,
      capabilityDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(changedProfile), "utf8")
        .digest("hex")}` as const,
    };
    fixture.replaceResolvedThinkingCapability(changedCapability);

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Do not reinterpret the displayed thinking choice.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "low"),
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "thinking_policy_unsupported",
      message: "The requested thinking policy is unavailable. Choose off, low, high, max.",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(fixture.requestPolicies).toEqual([]);
  } finally {
    await presentation.close();
    await fixture.close();
  }
});

test("PresentationSession returns actionable choices for an unsupported active thinking level", async () => {
  const fixture = await createThinkingPolicyPresentationFixture(
    "adam-agent-presentation-thinking-active-rejection-",
  );
  let presentation = await fixture.open();

  try {
    await presentation.dispatch({
      type: "create_session",
      targetId: fixture.policyTargetIdentity.targetId,
    });
    const firstResponse = waitForAssistantMessage(presentation, "Low thinking response.");
    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Use low thinking.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "low"),
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await firstResponse;
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected the draft prompt to admit one active session.");
    }
    await presentation.close();
    presentation = await fixture.open(sessionId);
    const providerCallsBeforeRejection = fixture.requestPolicies.length;

    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Reject an unsupported active-session level.",
        skills: [],
        thinkingSelection: presentationThinkingSelection(fixture.thinkingCapability, "medium"),
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "thinking_policy_unsupported",
      message: "The requested thinking policy is unavailable. Choose off, low, high, max.",
      supportedLevelIds: ["off", "low", "high", "max"],
    });
    expect(fixture.requestPolicies).toHaveLength(providerCallsBeforeRejection);
  } finally {
    await presentation.close();
    await fixture.close();
  }
});

test("PresentationSession begins a new-session draft without creating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-session-draft-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Draft target selection does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    await expect(
      presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });

    expect(presentation.getState()).toMatchObject({
      draft: { targetId: targetIdentity.targetId },
      authoritative: {
        active: null,
        sessions: { items: [] },
      },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession previews the draft Skill catalog without creating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-skills-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-review\ndescription: Reviews the first draft prompt.\n---\nDraft-only preview body.\n",
    "utf8",
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Draft catalog preview does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });

    expect(presentation.getState().draft).toMatchObject({
      targetId: targetIdentity.targetId,
      skills: {
        items: [
          {
            qualifiedId: "skill:v1:project:.:draft-review",
            name: "draft-review",
            active: false,
          },
        ],
        reloadAvailable: false,
      },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession resolves a first-prompt Skill mention through atomic draft admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-skill-mention-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const isolatedHome = join(testRoot, "home");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-review");
  const previousHome = testEnvironment.HOME;
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(isolatedHome);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-review\ndescription: Reviews the first mentioned draft.\n---\nMENTIONED_DRAFT_SKILL\n",
    "utf8",
  );
  testEnvironment.HOME = isolatedHome;
  const modelTargets = settledModelTargets("Mention admission complete.");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.transcript.items.some(
            (item) =>
              item.type === "assistant_message" && item.text === "Mention admission complete.",
          )
      ) {
        completed.resolve();
      }
    });
    const text = "Use $draft-review before answering.";
    try {
      await expect(
        presentation.dispatch({
          type: "submit_draft_prompt",
          text,
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted" });
      await completed.promise;
    } finally {
      unsubscribe();
    }

    const listed = await lifecycle.listProjectSessions();
    expect(listed.items).toHaveLength(1);
    const sessionId = listed.items[0]?.sessionId;
    if (sessionId === undefined) {
      throw new Error("Expected one admitted session.");
    }
    const records = await readInMemoryPresentationRecords(harness.sessions)(sessionId);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "skill_activation_batch_committed",
            outcomes: [
              expect.objectContaining({
                qualifiedId: "skill:v1:project:.:draft-review",
              }),
            ],
            skillContext: expect.objectContaining({
              active: [expect.objectContaining({ reason: "user_explicit" })],
            }),
          }),
        }),
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started", userMessage: text }),
        }),
      ]),
    );
    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession resolves a Skill mention for an existing session through durable admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-active-skill-mention-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const isolatedHome = join(testRoot, "home");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "active-review");
  const previousHome = testEnvironment.HOME;
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(isolatedHome);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: active-review\ndescription: Reviews a mentioned active-session prompt.\n---\nACTIVE_MENTION_SKILL\n",
    "utf8",
  );
  testEnvironment.HOME = isolatedHome;
  const modelTargets = settledModelTargets("Active mention admission complete.");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an existing active session.");
    }
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.transcript.items.some(
            (item) =>
              item.type === "assistant_message" &&
              item.text === "Active mention admission complete.",
          )
      ) {
        completed.resolve();
      }
    });
    const text = "Use $active-review before answering this follow-up.";
    try {
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text,
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted" });
      await completed.promise;
    } finally {
      unsubscribe();
    }

    const records = await readInMemoryPresentationRecords(harness.sessions)(sessionId);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({
            type: "skill_activation_batch_committed",
            outcomes: [
              expect.objectContaining({
                qualifiedId: "skill:v1:project:.:active-review",
              }),
            ],
            skillContext: expect.objectContaining({
              active: [expect.objectContaining({ reason: "user_explicit" })],
            }),
          }),
        }),
        expect.objectContaining({
          record: expect.objectContaining({ type: "logical_run_started", userMessage: text }),
        }),
      ]),
    );
    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects an ambiguous Skill mention before extending an existing session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-active-skill-collision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const userHome = join(testRoot, "home");
  const previousHome = testEnvironment.HOME;
  for (const directory of [
    join(workspaceRoot, ".agents", "skills", "shared-name"),
    join(userHome, ".agents", "skills", "shared-name"),
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: shared-name\ndescription: Collides across exact Skill scopes.\n---\nCollision body.\n",
      "utf8",
    );
  }
  testEnvironment.HOME = userHome;
  let providerResolutions = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      providerResolutions += 1;
      throw new Error("An ambiguous Skill mention must fail before target resolution.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an existing active session.");
    }
    const before = await readInMemoryPresentationRecords(harness.sessions)(sessionId);

    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Use $shared-name without guessing.",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_command",
      message: expect.stringContaining("skill:v1:project:.:shared-name"),
    });

    expect(providerResolutions).toBe(0);
    await expect(readInMemoryPresentationRecords(harness.sessions)(sessionId)).resolves.toEqual(
      before,
    );
    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps an ambiguous first-prompt Skill mention outside persistence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-skill-collision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const userHome = join(testRoot, "home");
  const previousHome = testEnvironment.HOME;
  for (const directory of [
    join(workspaceRoot, ".agents", "skills", "shared-name"),
    join(userHome, ".agents", "skills", "shared-name"),
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: shared-name\ndescription: Collides across exact Skill scopes.\n---\nCollision body.\n",
      "utf8",
    );
  }
  testEnvironment.HOME = userHome;
  let providerResolutions = 0;
  const modelTargets: ModelTargets = {
    async resolve() {
      providerResolutions += 1;
      throw new Error("An ambiguous Skill mention must fail before target resolution.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });
    const text = "Use $shared-name without guessing.";

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text,
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_command",
      message: expect.stringContaining("skill:v1:project:.:shared-name"),
    });
    expect(presentation.getState()).toMatchObject({ draft: { targetId: targetIdentity.targetId } });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });
    expect(providerResolutions).toBe(0);
    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession freezes the current exact target identity against historical catalog entries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-exact-target-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const currentIdentity: ModelTargetIdentity = { ...targetIdentity, profileVersion: 2 };
  const observedAdmissionProfiles: number[] = [];
  const modelTargets: ModelTargets = {
    async resolve(input) {
      const exact = (input as typeof input & { readonly targetIdentity?: ModelTargetIdentity })
        .targetIdentity;
      const identity = exact?.profileVersion === 1 ? targetIdentity : currentIdentity;
      observedAdmissionProfiles.push(identity.profileVersion);
      return {
        identity,
        driver: new FakeModelDriver([
          { type: "text_delta", text: `Profile ${identity.profileVersion} admitted.` },
          { type: "finish", reason: "stop" },
        ]),
        contextProfile:
          identity.profileVersion === 1 ? contextProfile : preparedDirectDeepSeekV2ContextProfile,
      };
    },
    async snapshot(input) {
      const current = {
        identity: currentIdentity,
        readiness: { status: "available" as const, credentialSource: "current profile" },
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
      };
      const historical = {
        identity: targetIdentity,
        readiness: { status: "available" as const, credentialSource: "historical profile" },
        contextProfile,
      };
      return {
        targets: input.includeHistoricalProfiles ? [current, historical] : [current],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const historical = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: historical.sessionId,
      input: { text: "Persist the historical exact profile" },
    });
    observedAdmissionProfiles.length = 0;
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: currentIdentity.targetId });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Use the current exact profile",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    const admittedSessionId = presentation.getState().authoritative.active?.session.id;
    if (admittedSessionId === undefined) {
      throw new Error("Expected the current exact target draft to be admitted.");
    }
    await expect(lifecycle.inspect({ sessionId: admittedSessionId })).resolves.toMatchObject({
      targetIdentity: currentIdentity,
    });
    expect(observedAdmissionProfiles[0]).toBe(2);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession admits the first non-empty draft prompt as one durable session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-admission-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Draft admitted." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const items = presentation.getState().authoritative.active?.transcript.items ?? [];
      if (
        items.some((item) => item.type === "assistant_message" && item.text === "Draft admitted.")
      ) {
        completed.resolve();
      }
    });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Persist this first prompt",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    await completed.promise;
    unsubscribe();

    const state = presentation.getState();
    expect(state).toMatchObject({
      draft: null,
      authoritative: {
        active: {
          session: { targetId: targetIdentity.targetId },
          transcript: {
            items: [
              { type: "user_message", text: "Persist this first prompt" },
              { type: "assistant_message", text: "Draft admitted." },
            ],
          },
        },
        sessions: { items: [{ targetId: targetIdentity.targetId }] },
      },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({
      items: [{ sessionId: state.authoritative.active?.session.id }],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps the draft unpersisted when target resolution rejects admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-target-reject-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("The exact target became unavailable.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Do not partially persist this prompt",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    expect(presentation.getState()).toMatchObject({
      draft: { targetId: targetIdentity.targetId },
      authoritative: { active: null, sessions: { items: [] } },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps an admitted draft durable when the provider fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-provider-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver: ModelDriver = {
    async *stream() {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "Inspect the failing transport.",
      } as const;
      yield await Promise.reject(
        new ModelDriverError("transport", "private provider failure", {
          cause: new Error("fixture transport failure"),
        }),
      );
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
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });
    const failed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.transcript.items.some(
            (item) => item.type === "session_notice" && item.status === "failed",
          ) === true
      ) {
        failed.resolve();
      }
    });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Persist before provider failure",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    await failed.promise;
    unsubscribe();

    const state = presentation.getState();
    expect(state).toMatchObject({
      draft: null,
      authoritative: {
        active: {
          transcript: {
            items: [
              { type: "user_message", text: "Persist before provider failure" },
              {
                type: "reasoning_block",
                status: "failed",
                provider: "DeepSeek",
                text: null,
                artifact: null,
              },
              { type: "session_notice", status: "failed", code: "model_request_failed" },
            ],
          },
        },
        sessions: { items: [{ id: state.authoritative.active?.session.id }] },
      },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({
      items: [{ sessionId: state.authoritative.active?.session.id }],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps its draft when logical input persistence fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-draft-input-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const backing = createInMemorySessionStoreDirectory<SessionRecord>();
  const wrappedStores = new Map<string, SessionStore<SessionRecord>>();
  const failingDirectory: SessionStoreDirectory<SessionRecord> = {
    async create(sessionId) {
      const store = await backing.create(sessionId);
      const wrapped: SessionStore<SessionRecord> = {
        async append(record) {
          if (record.schemaVersion === 3 && record.record.type === "logical_run_started") {
            throw new Error("Injected logical-input persistence failure.");
          }
          await store.append(record);
        },
        read: () => store.read(),
      };
      wrappedStores.set(sessionId, wrapped);
      return wrapped;
    },
    listSessionIds: () => backing.listSessionIds(),
    async open(sessionId) {
      return (await backing.open(sessionId)) === undefined
        ? undefined
        : wrappedStores.get(sessionId);
    },
  };
  const modelTargets = settledModelTargets("The model must not run after persistence failure.");
  const lifecycle = createSessionLifecycle({
    modelTargets,
    workspaceRoot,
    [sessionStoreDirectory]: failingDirectory,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      workspaceRoot,
    });
    await presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId });

    await expect(
      presentation.dispatch({
        type: "submit_draft_prompt",
        text: "Keep this draft after persistence failure",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "persistence_failed" });
    expect(presentation.getState()).toMatchObject({
      draft: { targetId: targetIdentity.targetId },
      authoritative: { active: null, sessions: { items: [] } },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects one valid owner-only exact default target preference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-default-target-"));
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspaceRoot);
  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({ schemaVersion: 1, defaultTargetId: targetIdentity.targetId }),
    { encoding: "utf8", mode: 0o600 },
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Target projection does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences: createPresentationPreferences({
        environment: { XDG_CONFIG_HOME: configRoot },
      }),
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.targets).toMatchObject({
      defaultTargetId: targetIdentity.targetId,
      diagnostic: null,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects a symlinked default-target directory without hiding exact targets", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-unsafe-target-config-"));
  const configRoot = join(testRoot, "config");
  const actualDirectory = join(testRoot, "actual-config");
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(configRoot);
  await mkdir(actualDirectory, { mode: 0o700 });
  await symlink(actualDirectory, join(configRoot, "adam-agent"));
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Target projection does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences: createPresentationPreferences({
        environment: { XDG_CONFIG_HOME: configRoot },
      }),
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.targets).toMatchObject({
      items: [expect.objectContaining({ targetId: targetIdentity.targetId })],
      defaultTargetId: null,
      diagnostic: { code: "target_configuration_unsafe" },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession saves one exact default target through a distinct semantic command", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-save-target-"));
  const configRoot = join(testRoot, "config");
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(configRoot);
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Target preference does not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      preferences: createPresentationPreferences({
        environment: { XDG_CONFIG_HOME: configRoot },
      }),
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({ type: "set_default_target", targetId: targetIdentity.targetId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.targets).toMatchObject({
      defaultTargetId: targetIdentity.targetId,
      diagnostic: null,
    });
    const configurationPath = join(configRoot, "adam-agent", "config.json");
    await expect(readFile(configurationPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ schemaVersion: 1, defaultTargetId: targetIdentity.targetId })}\n`,
    );
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession begins a draft only from an exact available launch target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-target-create-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Session creation does not resolve a model before the first turn.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "DEEPSEEK_API_KEY" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState()).toMatchObject({
      draft: { targetId: targetIdentity.targetId },
      authoritative: { active: null, sessions: { items: [] } },
    });
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession opens an exact target as a process-local draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-open-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("Opening an exact target draft must not resolve a model driver.");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  try {
    const presentation = await createProductPresentationSession({
      lifecycle,
      modelTargets,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });

    const state = presentation.getState();
    expect(state).toEqual({
      revision: 1,
      authoritative: {
        schemaVersion: 1,
        continuity: {
          status: "current",
          sessionThroughSequence: 0,
          operationThrough: [],
        },
        project: { id: state.authoritative.project.id, label: "workspace" },
        targets: {
          items: [expect.objectContaining({ targetId: targetIdentity.targetId })],
          defaultTargetId: null,
          diagnostic: null,
        },
        sessions: { items: [], nextCursor: null },
        active: null,
      },
      draft: {
        targetId: targetIdentity.targetId,
        projectPaths: expect.objectContaining({ items: [], omittedCount: 0 }),
        skills: expect.objectContaining({ items: [], reloadAvailable: false }),
      },
      transient: null,
    });
    expect(state.authoritative.project.id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(lifecycle.listProjectSessions()).resolves.toMatchObject({ items: [] });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects the frozen repository instruction revision without file contents", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-instructions-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# Rules\n\nKeep tests causal.\n", "utf8");

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.repositoryInstructions).toEqual({
      revision: 1,
      activeScopes: ["."],
      sources: [
        {
          scope: ".",
          path: "AGENTS.md",
          selectedName: "AGENTS.md",
          loadReason: "root_eager",
        },
      ],
      diagnostics: [],
      effectiveDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      reloadAvailable: true,
    });
    expect(JSON.stringify(presentation.getState())).not.toContain("Keep tests causal.");

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession reloads repository instructions only through the lifecycle command", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-reload-instructions-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const instructionsPath = join(workspaceRoot, "AGENTS.md");
  await writeFile(instructionsPath, "# Rules\n\nFirst revision.\n", "utf8");

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    const originalDigest =
      presentation.getState().authoritative.active?.repositoryInstructions?.effectiveDigest;
    await writeFile(instructionsPath, "# Rules\n\nSecond revision.\n", "utf8");

    await expect(
      presentation.dispatch({ type: "reload_repository_instructions", sessionId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.repositoryInstructions).toMatchObject({
      revision: 2,
      activeScopes: ["."],
      sources: [{ path: "AGENTS.md", loadReason: "explicit_reload" }],
      reloadAvailable: true,
    });
    expect(
      presentation.getState().authoritative.active?.repositoryInstructions?.effectiveDigest,
    ).not.toBe(originalDigest);
    expect(JSON.stringify(presentation.getState())).not.toContain("Second revision.");

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects exact qualified Skill metadata without Skill body bytes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-skills-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const isolatedHome = join(testRoot, "home");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "project-review");
  const previousHome = testEnvironment.HOME;
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(isolatedHome);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: project-review\ndescription: Reviews the exact project state.\n---\nPRIVATE_SKILL_BODY\n",
    "utf8",
  );
  testEnvironment.HOME = isolatedHome;

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.skills).toEqual({
      revision: 1,
      items: [
        {
          qualifiedId: "skill:v1:project:.:project-review",
          name: "project-review",
          description: "Reviews the exact project state.",
          source: { type: "project", scope: "." },
          active: false,
        },
      ],
      diagnostics: [],
      overflow: { omittedCount: 0, shortenedCount: 0 },
      reloadAvailable: true,
    });
    expect(JSON.stringify(presentation.getState())).not.toContain("PRIVATE_SKILL_BODY");

    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession reloads the exact Skill catalog through lifecycle authority", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-reload-skills-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const isolatedHome = join(testRoot, "home");
  const skillRoot = join(workspaceRoot, ".agents", "skills");
  const previousHome = testEnvironment.HOME;
  await mkdir(join(skillRoot, "first"), { recursive: true });
  await mkdir(isolatedHome);
  await writeFile(
    join(skillRoot, "first", "SKILL.md"),
    "---\nname: first\ndescription: First exact procedure.\n---\nFirst body.\n",
    "utf8",
  );
  testEnvironment.HOME = isolatedHome;

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    await mkdir(join(skillRoot, "second"));
    await writeFile(
      join(skillRoot, "second", "SKILL.md"),
      "---\nname: second\ndescription: Second exact procedure.\n---\nSecond body.\n",
      "utf8",
    );

    await expect(
      presentation.dispatch({ type: "reload_skills", sessionId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.skills).toMatchObject({
      revision: 2,
      items: [
        { qualifiedId: "skill:v1:project:.:first" },
        { qualifiedId: "skill:v1:project:.:second" },
      ],
      reloadAvailable: true,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    if (previousHome === undefined) {
      delete testEnvironment.HOME;
    } else {
      testEnvironment.HOME = previousHome;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects bounded ordinary project paths without reading file bytes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-project-paths-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "PRIVATE_README_BYTES\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "alpha.ts"), "PRIVATE_SOURCE_BYTES\n", "utf8");
  await symlink(join(workspaceRoot, "README.md"), join(workspaceRoot, "linked-readme"));

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.projectPaths).toEqual({
      items: ["README.md", "src/alpha.ts"],
      omittedCount: 0,
      diagnostic: null,
    });
    expect(JSON.stringify(presentation.getState())).not.toContain("PRIVATE_README_BYTES");
    expect(JSON.stringify(presentation.getState())).not.toContain("PRIVATE_SOURCE_BYTES");

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects the initial inert MCP workspace-confirmation state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-confirmation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    }),
    "utf8",
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.mcp).toEqual({
      schemaVersion: 1,
      status: "workspace_confirmation_required",
      workspaceConfirmed: false,
      source: {
        path: ".mcp.json",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      servers: [],
      activation: null,
      catalog: null,
      profile: null,
      diagnostics: [],
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession confirms only the exact MCP workspace source digest", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-workspace-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    }),
    "utf8",
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const active = presentation.getState().authoritative.active;
    if (active?.mcp === null || active?.mcp === undefined) {
      throw new Error("Expected MCP confirmation state.");
    }

    await expect(
      presentation.dispatch({
        type: "confirm_mcp_workspace",
        sessionId: active.session.id,
        sourceDigest: active.mcp.source.digest,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.mcp).toMatchObject({
      status: "server_approval_required",
      workspaceConfirmed: true,
      servers: [
        {
          serverId: "fixture",
          status: "approval_required",
          transport: "stdio",
          command: { kind: "executable" },
          definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
      activation: null,
      catalog: null,
      profile: null,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession approves only one exact MCP server definition", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-server-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    }),
    "utf8",
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const initial = presentation.getState().authoritative.active;
    if (initial?.mcp === null || initial?.mcp === undefined) {
      throw new Error("Expected MCP confirmation state.");
    }
    await presentation.dispatch({
      type: "confirm_mcp_workspace",
      sessionId: initial.session.id,
      sourceDigest: initial.mcp.source.digest,
    });
    const confirmed = presentation.getState().authoritative.active;
    const server = confirmed?.mcp?.servers[0];
    if (confirmed?.mcp === null || confirmed?.mcp === undefined || server === undefined) {
      throw new Error("Expected an exact MCP server preview.");
    }

    await expect(
      presentation.dispatch({
        type: "approve_mcp_server",
        sessionId: confirmed.session.id,
        serverId: server.serverId,
        definitionDigest: server.definitionDigest,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.mcp).toMatchObject({
      status: "activation_required",
      servers: [
        {
          serverId: "fixture",
          status: "approved",
          definitionDigest: server.definitionDigest,
        },
      ],
      activation: null,
      catalog: null,
      profile: null,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession atomically activates approved MCP servers into one exact catalog", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const peer = createScriptedMcpTransportFactory({ fixture: ordinaryScriptedMcpServer() });
  const lifecycle = createSessionLifecycle({
    [mcpTransportFactory]: peer,
    stateRoot,
    workspaceRoot,
  });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const initial = presentation.getState().authoritative.active;
    if (initial?.mcp === null || initial?.mcp === undefined) {
      throw new Error("Expected MCP confirmation state.");
    }
    await presentation.dispatch({
      type: "confirm_mcp_workspace",
      sessionId: initial.session.id,
      sourceDigest: initial.mcp.source.digest,
    });
    const server = presentation.getState().authoritative.active?.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("Expected MCP server preview.");
    }
    await presentation.dispatch({
      type: "approve_mcp_server",
      sessionId: initial.session.id,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });

    await expect(
      presentation.dispatch({
        type: "activate_mcp_servers",
        sessionId: initial.session.id,
        servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.mcp).toMatchObject({
      status: "tool_selection_required",
      servers: [{ serverId: "fixture", status: "ready" }],
      activation: { attempt: 1, status: "ready" },
      catalog: {
        status: "ready",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        tools: [
          { serverId: "fixture", originalName: "echo" },
          { serverId: "fixture", originalName: "uppercase" },
        ],
      },
      profile: null,
    });
    expect(
      peer.requests("fixture").filter((request) => request.method === "initialize"),
    ).toHaveLength(1);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession commits one discovery-bound immutable MCP Tool Profile", async () => {
  const fixture = await openActivatedMcpPresentationFixture("adam-agent-presentation-mcp-profile-");
  try {
    const active = fixture.presentation.getState().authoritative.active;
    const tool = active?.mcp?.catalog?.tools.find((candidate) => candidate.originalName === "echo");
    const generationId = active?.mcp?.activation?.generationId;
    if (
      active?.mcp === null ||
      active?.mcp === undefined ||
      tool === undefined ||
      generationId === undefined
    ) {
      throw new Error("Expected an activated MCP catalog.");
    }

    await expect(
      fixture.presentation.dispatch({
        type: "commit_mcp_tool_profile",
        sessionId: active.session.id,
        generationId,
        selections: [
          {
            qualifiedName: tool.qualifiedName,
            definitionDigest: tool.definitionDigest,
            effect: "read",
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(fixture.presentation.getState().authoritative.active?.mcp).toMatchObject({
      status: "profile_committed",
      profile: {
        version: 1,
        projectorVersion: 1,
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        tools: [
          {
            serverId: "fixture",
            originalName: "echo",
            qualifiedName: tool.qualifiedName,
            definitionDigest: tool.definitionDigest,
            effect: "read",
          },
        ],
      },
    });
  } finally {
    await fixture.close();
  }
});

test("PresentationSession explicitly reactivates one exact committed MCP profile after restart", async () => {
  const fixture = await openActivatedMcpPresentationFixture(
    "adam-agent-presentation-mcp-reactivation-",
  );
  let restarted: SessionLifecycle | undefined;
  let reopened: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const active = fixture.presentation.getState().authoritative.active;
    const tool = active?.mcp?.catalog?.tools.find((candidate) => candidate.originalName === "echo");
    const generationId = active?.mcp?.activation?.generationId;
    if (
      active?.mcp === null ||
      active?.mcp === undefined ||
      tool === undefined ||
      generationId === undefined
    ) {
      throw new Error("Expected an activated MCP catalog.");
    }
    await fixture.presentation.dispatch({
      type: "commit_mcp_tool_profile",
      sessionId: active.session.id,
      generationId,
      selections: [
        {
          qualifiedName: tool.qualifiedName,
          definitionDigest: tool.definitionDigest,
          effect: "read",
        },
      ],
    });
    const profileDigest =
      fixture.presentation.getState().authoritative.active?.mcp?.profile?.digest;
    if (profileDigest === undefined) {
      throw new Error("Expected one committed MCP Tool Profile.");
    }
    await fixture.presentation.close();
    await fixture.lifecycle.close();

    restarted = createSessionLifecycle({
      [mcpTransportFactory]: fixture.peer,
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.workspaceRoot,
    });
    reopened = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: active.session.id,
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.workspaceRoot,
    });
    const reactivation = reopened.getState().authoritative.active;
    const server = reactivation?.mcp?.servers[0];
    expect(reactivation?.mcp).toMatchObject({ status: "profile_reactivation_required" });
    if (server === undefined) {
      throw new Error("Expected the exact approved MCP server.");
    }

    await expect(
      reopened.dispatch({
        type: "activate_mcp_servers",
        sessionId: active.session.id,
        servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(reopened.getState().authoritative.active?.mcp).toMatchObject({
      status: "profile_committed",
      profile: { digest: profileDigest },
    });
  } finally {
    await reopened?.close();
    await restarted?.close();
    await fixture.presentation.close();
    await fixture.lifecycle.close();
    await rm(fixture.testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession refreshes and explicitly revalidates an asynchronously stale MCP catalog", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-revalidate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  const peer = createScriptedMcpTransportFactory({ fixture: ordinaryScriptedMcpServer() });
  const staleDurable = Promise.withResolvers<void>();
  const lifecycle = createSessionLifecycle({
    [mcpCatalogStaleDurableBarrier]: { committed: () => staleDurable.resolve() },
    [mcpTransportFactory]: peer,
    stateRoot,
    workspaceRoot,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    try {
      const initial = presentation.getState().authoritative.active;
      if (initial?.mcp === null || initial?.mcp === undefined) {
        throw new Error("Expected MCP confirmation state.");
      }
      await presentation.dispatch({
        type: "confirm_mcp_workspace",
        sessionId: initial.session.id,
        sourceDigest: initial.mcp.source.digest,
      });
      const server = presentation.getState().authoritative.active?.mcp?.servers[0];
      if (server === undefined) {
        throw new Error("Expected MCP server preview.");
      }
      await presentation.dispatch({
        type: "approve_mcp_server",
        sessionId: initial.session.id,
        serverId: server.serverId,
        definitionDigest: server.definitionDigest,
      });
      await presentation.dispatch({
        type: "activate_mcp_servers",
        sessionId: initial.session.id,
        servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
      });
      const activated = presentation.getState().authoritative.active?.mcp;
      const tool = activated?.catalog?.tools.find((candidate) => candidate.originalName === "echo");
      const generationId = activated?.activation?.generationId;
      if (tool === undefined || generationId === undefined) {
        throw new Error("Expected an activated MCP catalog.");
      }
      await presentation.dispatch({
        type: "commit_mcp_tool_profile",
        sessionId: initial.session.id,
        generationId,
        selections: [
          {
            qualifiedName: tool.qualifiedName,
            definitionDigest: tool.definitionDigest,
            effect: "read",
          },
        ],
      });
      const stale = Promise.withResolvers<void>();
      let failureGuard: ReturnType<typeof setTimeout> | undefined;
      const failed = new Promise<never>((_resolve, reject) => {
        failureGuard = setTimeout(() => {
          const current = presentation.getState();
          reject(
            new Error(
              `Asynchronous MCP Presentation state did not settle: ${JSON.stringify({
                mcp: current.authoritative.active?.mcp?.status,
                naming: current.authoritative.active?.session.naming.generation.status,
                transient: current.transient?.activity ?? null,
                transcript: current.authoritative.active?.transcript.items.map((item) =>
                  item.type === "assistant_message" ? item.text : item.type,
                ),
              })}`,
            ),
          );
        }, 20_000);
      });
      const unsubscribe = presentation.subscribe(() => {
        const current = presentation.getState();
        if (current.authoritative.active?.mcp?.status === "catalog_stale") {
          stale.resolve();
        }
      });
      try {
        peer.notifyToolsChanged("fixture");
        await Promise.race([Promise.all([stale.promise, staleDurable.promise]), failed]);
      } finally {
        if (failureGuard !== undefined) {
          clearTimeout(failureGuard);
        }
        unsubscribe();
      }
      const staleMcp = presentation.getState().authoritative.active?.mcp;
      expect(staleMcp).toMatchObject({ status: "catalog_stale", catalog: { status: "stale" } });
      const staleGenerationId = staleMcp?.activation?.generationId;
      if (staleGenerationId === undefined) {
        throw new Error("Expected one stale MCP generation.");
      }
      const revalidated = await presentation.dispatch({
        type: "revalidate_mcp_catalog",
        sessionId: initial.session.id,
        generationId: staleGenerationId,
      });
      const lifecycleAfterRevalidate = await lifecycle.inspect({ sessionId: initial.session.id });
      expect({ revalidated, lifecycleAfterRevalidate }).toMatchObject({
        revalidated: { status: "admitted", resource: null },
        lifecycleAfterRevalidate: { mcp: { status: "profile_committed" } },
      });
      expect(presentation.getState().authoritative.active?.mcp).toMatchObject({
        status: "profile_committed",
        catalog: { status: "ready" },
      });
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession exposes one failed MCP generation before explicit exact retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-mcp-retry-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let initializeAttempts = 0;
  const peer = createScriptedMcpTransportFactory({
    fixture: {
      ...ordinaryScriptedMcpServer(),
      respond(request, defaultReply) {
        if (request.method !== "initialize") {
          return defaultReply;
        }
        initializeAttempts += 1;
        return initializeAttempts === 1
          ? { kind: "error", code: -32_000, message: "injected initialize failure" }
          : defaultReply;
      },
    },
  });
  const lifecycle = createSessionLifecycle({
    [mcpTransportFactory]: peer,
    stateRoot,
    workspaceRoot,
  });
  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      stateRoot,
      targetIdentity,
      workspaceRoot,
    });
    const initial = presentation.getState().authoritative.active;
    if (initial?.mcp === null || initial?.mcp === undefined) {
      throw new Error("Expected MCP confirmation state.");
    }
    await presentation.dispatch({
      type: "confirm_mcp_workspace",
      sessionId: initial.session.id,
      sourceDigest: initial.mcp.source.digest,
    });
    const server = presentation.getState().authoritative.active?.mcp?.servers[0];
    if (server === undefined) {
      throw new Error("Expected MCP server preview.");
    }
    await presentation.dispatch({
      type: "approve_mcp_server",
      sessionId: initial.session.id,
      serverId: server.serverId,
      definitionDigest: server.definitionDigest,
    });
    await expect(
      presentation.dispatch({
        type: "activate_mcp_servers",
        sessionId: initial.session.id,
        servers: [{ serverId: server.serverId, definitionDigest: server.definitionDigest }],
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    const failed = presentation.getState().authoritative.active?.mcp;
    expect(failed).toMatchObject({
      status: "activation_failed",
      activation: { attempt: 1, status: "failed" },
      catalog: null,
      profile: null,
    });
    const generationId = failed?.activation?.generationId;
    if (generationId === undefined) {
      throw new Error("Expected one failed MCP generation.");
    }

    await expect(
      presentation.dispatch({
        type: "retry_mcp_activation",
        sessionId: initial.session.id,
        generationId,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.mcp).toMatchObject({
      status: "tool_selection_required",
      activation: { attempt: 2, status: "ready" },
      catalog: { status: "ready" },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession opens an existing authoritative session by identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-existing-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState()).toMatchObject({
      authoritative: {
        continuity: { status: "current", sessionThroughSequence: 1 },
        project: { id: created.projectId },
        sessions: { items: [{ id: created.sessionId }] },
        active: {
          session: {
            id: created.sessionId,
            targetId: "deepseek-v4-flash.direct",
            status: "idle",
          },
          transcript: { items: [] },
        },
      },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession preserves linked operation truth through session and runtime refreshes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-linked-operation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationOperationExtension(packageRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-linked-operation-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const record of host.operations.events({ operationId: operation.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }

    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    expect(presentation.getState().authoritative.active?.linkedOperations).toMatchObject([
      {
        operationId: operation.operationId,
        origin: {
          invocation: { id: "review", kind: "presentation_command", version: 1 },
          sessionId: created.sessionId,
          sourceSequence: created.lastSequence,
        },
        provenance: {
          contributionId: "fixture.review",
          extensionId: "fixture.extension",
          extensionVersion: "1.0.0",
        },
        status: "completed",
      },
    ]);
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      operationThrough: [{ operationId: operation.operationId, sequence: 2 }],
      status: "current",
    });
    await expect(
      presentation.dispatch({
        type: "set_session_manual_name",
        sessionId: created.sessionId,
        name: "Operation session",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      operationThrough: [{ operationId: operation.operationId, sequence: 2 }],
      status: "current",
    });
    const answerVisible = waitForAssistantMessage(presentation, "Presentation fixture answer.");
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Refresh the active session" },
    });
    await answerVisible;
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      operationThrough: [{ operationId: operation.operationId, sequence: 2 }],
      status: "current",
    });
    expect(
      presentation
        .getState()
        .authoritative.active?.transcript.items.some(
          (item) => item.type === "operation_link" && item.operationId === operation.operationId,
        ),
    ).toBe(true);
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession publishes linked operation progress and replaces it with durable completion", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-progress-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationOperation${Date.now()}${Math.random()}`;
  const progressPublished = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    progressPublished: progressPublished.resolve,
    releaseExecution: releaseExecution.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationProgressOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-progress-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    await progressPublished.promise;
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation.getState().authoritative.active?.linkedOperations[0]?.status === "completed"
      ) {
        completed.resolve();
      }
    });

    expect(presentation.getState().authoritative.active?.linkedOperations).toMatchObject([
      {
        operationId: operation.operationId,
        progress: {
          summary: expect.stringMatching(/^\{"completed":1,"detail":"x+/),
        },
        status: "running",
      },
    ]);
    const progress = presentation.getState().authoritative.active?.linkedOperations[0]?.progress;
    expect(progress).not.toBeNull();
    expect(typeof progress === "object" && progress !== null && "summary" in progress).toBe(true);
    if (typeof progress === "object" && progress !== null && "summary" in progress) {
      expect(new TextEncoder().encode(progress.summary as string).byteLength).toBeLessThanOrEqual(
        240,
      );
    }
    releaseExecution.resolve();
    await completed.promise;
    expect(presentation.getState().authoritative).toMatchObject({
      continuity: {
        operationThrough: [{ operationId: operation.operationId, sequence: 3 }],
        status: "current",
      },
      active: {
        linkedOperations: [
          {
            operationId: operation.operationId,
            progress,
            status: "completed",
          },
        ],
      },
    });
    unsubscribe();
    await presentation.close();
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseExecution.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rechecks Host truth when a running operation stream closes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-stream-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationOperationClose${Date.now()}${Math.random()}`;
  const progressPublished = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    progressPublished: progressPublished.resolve,
    releaseExecution: releaseExecution.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationProgressOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  let rejectTerminal = true;
  const interruptedStore: OperationStore = {
    append(record) {
      if (rejectTerminal && record.event.type === "operation_completed") {
        rejectTerminal = false;
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: interruptedStore,
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-stream-close-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    await progressPublished.promise;
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const recoveryRequired = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation.getState().authoritative.active?.linkedOperations[0]?.status ===
        "recovery_required"
      ) {
        recoveryRequired.resolve();
      }
    });
    try {
      expect(presentation.getState().authoritative.active?.linkedOperations[0]?.status).toBe(
        "running",
      );
      releaseExecution.resolve();
      await recoveryRequired.promise;
      expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
        actions: [],
        operationId: operation.operationId,
        status: "recovery_required",
      });
    } finally {
      unsubscribe();
      releaseExecution.resolve();
      await presentation.close();
    }
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseExecution.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession repairs one failed operation refresh and resumes observation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-repair-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationOperationRepair${Date.now()}${Math.random()}`;
  const executionStarted = Promise.withResolvers<void>();
  const releaseProgress = Promise.withResolvers<void>();
  const progressPublished = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    executionStarted: executionStarted.resolve,
    progressPublished: progressPublished.resolve,
    releaseExecution: releaseExecution.promise,
    releaseProgress: releaseProgress.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationRepairOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  const observerReady = Promise.withResolvers<void>();
  let readCount = 0;
  let rejectNextRead = false;
  const repairStore: OperationStore = {
    append: (record) => durableStore.append(record),
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    async read(operationId) {
      const records = await durableStore.read(operationId);
      readCount += 1;
      if (readCount === 2) {
        observerReady.resolve();
      }
      if (rejectNextRead) {
        rejectNextRead = false;
        throw new Error("injected operation refresh failure");
      }
      return records;
    },
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: repairStore,
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-repair-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    await executionStarted.promise;
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const repairing = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let repairingObserved = false;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      failureGuard = setTimeout(
        () => reject(new Error("Operation refresh repair did not settle.")),
        5_000,
      );
    });
    const unsubscribe = presentation.subscribe(() => {
      const current = presentation.getState();
      if (current.authoritative.continuity.status === "repairing") {
        repairingObserved = true;
        repairing.resolve();
      }
      const linked = current.authoritative.active?.linkedOperations[0];
      if (
        repairingObserved &&
        current.authoritative.continuity.status === "current" &&
        linked?.progress?.summary === '{"phase":"repairing"}'
      ) {
        repaired.resolve();
      }
      if (linked?.status === "completed") {
        completed.resolve();
      }
    });
    try {
      await observerReady.promise;
      rejectNextRead = true;
      releaseProgress.resolve();
      await progressPublished.promise;
      await Promise.race([repairing.promise, failed]);
      await Promise.race([repaired.promise, failed]);
      releaseExecution.resolve();
      await Promise.race([completed.promise, failed]);
      expect(presentation.getState().authoritative.continuity).toMatchObject({
        operationThrough: [{ operationId: operation.operationId, sequence: 3 }],
        status: "current",
      });
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      unsubscribe();
      await presentation.close();
    }
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseProgress.resolve();
    releaseExecution.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps every operation cursor monotonic during one concurrent repair", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-monotonic-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationOperationMonotonic${Date.now()}${Math.random()}`;
  const revisions = ["repair", "concurrent"] as const;
  const started = new Map(revisions.map((revision) => [revision, Promise.withResolvers<void>()]));
  const progressReleases = new Map(
    revisions.map((revision) => [revision, Promise.withResolvers<void>()]),
  );
  const progressPublished = new Map(
    revisions.map((revision) => [revision, Promise.withResolvers<void>()]),
  );
  const executionReleases = new Map(
    revisions.map((revision) => [revision, Promise.withResolvers<void>()]),
  );
  (globalThis as Record<string, unknown>)[controlKey] = {
    executionStarted(revision: string) {
      if (revision === "repair" || revision === "concurrent") {
        started.get(revision)?.resolve();
      }
    },
    progressPublished(revision: string) {
      if (revision === "repair" || revision === "concurrent") {
        progressPublished.get(revision)?.resolve();
      }
    },
    releaseExecution: Object.fromEntries(
      revisions.map((revision) => [revision, executionReleases.get(revision)?.promise]),
    ),
    releaseProgress: Object.fromEntries(
      revisions.map((revision) => [revision, progressReleases.get(revision)?.promise]),
    ),
  };
  await mkdir(workspaceRoot);
  await writePresentationConcurrentRepairOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  const observerReady = new Map(
    revisions.map((revision) => [revision, Promise.withResolvers<void>()]),
  );
  const readCounts = new Map<string, number>();
  const repairReadStarted = Promise.withResolvers<void>();
  const releaseRepairRead = Promise.withResolvers<void>();
  let repairOperationId: string | undefined;
  let concurrentOperationId: string | undefined;
  let rejectRepairRead = false;
  let rejectConcurrentRead = false;
  let blockRepairRead = false;
  const operationRevision = new Map<string, (typeof revisions)[number]>();
  const repairStore: OperationStore = {
    append: (record) => durableStore.append(record),
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    async read(operationId) {
      const records = await durableStore.read(operationId);
      const count = (readCounts.get(operationId) ?? 0) + 1;
      readCounts.set(operationId, count);
      if (count === 2) {
        const revision = operationRevision.get(operationId);
        if (revision !== undefined) {
          observerReady.get(revision)?.resolve();
        }
      }
      if (operationId === repairOperationId && rejectRepairRead) {
        rejectRepairRead = false;
        throw new Error("injected concurrent operation refresh failure");
      }
      if (operationId === concurrentOperationId && rejectConcurrentRead) {
        rejectConcurrentRead = false;
        throw new Error("injected second operation refresh failure");
      }
      if (operationId === repairOperationId && blockRepairRead) {
        blockRepairRead = false;
        repairReadStarted.resolve();
        await releaseRepairRead.promise;
      }
      return records;
    },
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: repairStore,
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operations = await Promise.all(
      revisions.map(async (revision) => {
        const reference = await host.operations.startLinked({
          contributionId: "fixture.review",
          idempotencyKey: `presentation-operation-monotonic-${revision}`,
          input: { revision },
          origin: {
            invocation: { id: "review", kind: "presentation_command", version: 1 },
            sessionId: created.sessionId,
            sourceSequence: created.lastSequence,
          },
        });
        operationRevision.set(reference.operationId, revision);
        return reference;
      }),
    );
    repairOperationId = operations[0]?.operationId;
    concurrentOperationId = operations[1]?.operationId;
    await Promise.all(revisions.map((revision) => started.get(revision)?.promise));
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const repairing = Promise.withResolvers<void>();
    const concurrentVisible = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const current = presentation.getState();
      if (current.authoritative.continuity.status === "repairing") {
        repairing.resolve();
      }
      const linked = current.authoritative.active?.linkedOperations ?? [];
      if (
        current.authoritative.continuity.status === "repairing" &&
        linked.some((operation) => operation.progress?.summary === '{"phase":"concurrent"}')
      ) {
        concurrentVisible.resolve();
      }
      if (
        current.authoritative.continuity.status === "current" &&
        linked.some((operation) => operation.progress?.summary === '{"phase":"repair"}')
      ) {
        repaired.resolve();
      }
    });
    try {
      await Promise.all(revisions.map((revision) => observerReady.get(revision)?.promise));
      rejectRepairRead = true;
      blockRepairRead = true;
      progressReleases.get("repair")?.resolve();
      await progressPublished.get("repair")?.promise;
      await repairing.promise;
      await repairReadStarted.promise;
      await expect(
        presentation.dispatch({
          type: "set_session_manual_name",
          sessionId: created.sessionId,
          name: "Repair remains authoritative",
        }),
      ).resolves.toMatchObject({ status: "admitted" });
      expect(presentation.getState().authoritative.continuity).toEqual({
        status: "repairing",
        reason: "reconnect",
      });
      rejectConcurrentRead = true;
      progressReleases.get("concurrent")?.resolve();
      await progressPublished.get("concurrent")?.promise;
      await concurrentVisible.promise;
      releaseRepairRead.resolve();
      await repaired.promise;
      expect(presentation.getState().authoritative.continuity).toMatchObject({
        operationThrough: expect.arrayContaining(
          operations.map((operation) => ({ operationId: operation.operationId, sequence: 2 })),
        ),
        status: "current",
      });
    } finally {
      unsubscribe();
      for (const revision of revisions) {
        progressReleases.get(revision)?.resolve();
        executionReleases.get(revision)?.resolve();
      }
      releaseRepairRead.resolve();
      await presentation.close();
    }
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    for (const revision of revisions) {
      progressReleases.get(revision)?.resolve();
      executionReleases.get(revision)?.resolve();
    }
    releaseRepairRead.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession observes an operation first discovered by a runtime refresh", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-discovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationOperationDiscovery${Date.now()}${Math.random()}`;
  const executionStarted = Promise.withResolvers<void>();
  const releaseProgress = Promise.withResolvers<void>();
  const progressPublished = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    executionStarted: executionStarted.resolve,
    progressPublished: progressPublished.resolve,
    releaseExecution: releaseExecution.promise,
    releaseProgress: releaseProgress.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationRepairOperationExtension(packageRoot, controlKey);
  const modelTargets = settledModelTargets();
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-discovery-1",
      input: { revision: "discovered" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    await executionStarted.promise;
    const linkedVisible = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const linked = presentation.getState().authoritative.active?.linkedOperations[0];
      if (linked?.operationId === operation.operationId) {
        linkedVisible.resolve();
      }
      if (linked?.operationId === operation.operationId && linked.status === "completed") {
        completed.resolve();
      }
    });
    try {
      await lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Discover the linked operation" },
      });
      await linkedVisible.promise;
      releaseProgress.resolve();
      await progressPublished.promise;
      releaseExecution.resolve();
      await completed.promise;
      expect(presentation.getState().authoritative.continuity).toMatchObject({
        operationThrough: [{ operationId: operation.operationId, sequence: 3 }],
        status: "current",
      });
    } finally {
      unsubscribe();
      releaseProgress.resolve();
      releaseExecution.resolve();
      await presentation.close();
    }
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseProgress.resolve();
    releaseExecution.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession inherits only operation links inside an authoritative branch prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationOperationExtension(packageRoot);
  const modelTargets = settledModelTargets("Branch operation answer.");
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  const parent = await lifecycle.create({ targetIdentity });
  const firstTurn = await lifecycle.continue({
    sessionId: parent.sessionId,
    input: { text: "Create the included operation boundary" },
  });
  const includedThrough = firstTurn.snapshot.lastSequence;
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const included = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-branch-included",
      input: { revision: "included" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: parent.sessionId,
        sourceSequence: includedThrough,
      },
    });
    for await (const record of host.operations.events({ operationId: included.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }
    const secondTurn = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create the excluded operation boundary" },
    });
    const excluded = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-branch-excluded",
      input: { revision: "excluded" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: parent.sessionId,
        sourceSequence: secondTurn.snapshot.lastSequence,
      },
    });
    for await (const record of host.operations.events({ operationId: excluded.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: includedThrough,
    });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    expect(
      presentation
        .getState()
        .authoritative.active?.linkedOperations.map((operation) => operation.operationId),
    ).toEqual([included.operationId]);
    expect(
      presentation
        .getState()
        .authoritative.active?.transcript.items.filter((item) => item.type === "operation_link"),
    ).toEqual([
      {
        type: "operation_link",
        id: `operation:${included.operationId}`,
        operationId: included.operationId,
        sequence: includedThrough,
        sourceSessionId: parent.sessionId,
        branchBoundary: { sessionId: parent.sessionId, sequence: includedThrough },
      },
    ]);
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession admits cancel only for the currently running linked operation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationCancellation${Date.now()}${Math.random()}`;
  const executionStarted = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    executionStarted: executionStarted.resolve,
  };
  await mkdir(workspaceRoot);
  await writePresentationCancellableOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-cancel-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    await executionStarted.promise;
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const cancelled = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation.getState().authoritative.active?.linkedOperations[0]?.status === "cancelled"
      ) {
        cancelled.resolve();
      }
    });

    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      actions: ["cancel"],
      operationId: operation.operationId,
      status: "running",
    });
    await expect(
      presentation.dispatch({ type: "cancel_operation", operationId: operation.operationId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    await cancelled.promise;
    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      actions: [],
      operationId: operation.operationId,
      settlement: { reason: "caller" },
      status: "cancelled",
    });
    await expect(
      presentation.dispatch({ type: "cancel_operation", operationId: operation.operationId }),
    ).resolves.toMatchObject({ code: "stale_interaction", status: "rejected" });
    unsubscribe();
    await presentation.close();
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession recovers only an interrupted linked operation from immutable Host truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-recover-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationRecovery${Date.now()}${Math.random()}`;
  const reconciliationStarted = Promise.withResolvers<void>();
  const releaseReconciliation = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    reconciliationStarted: reconciliationStarted.resolve,
    releaseReconciliation: releaseReconciliation.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationRecoverableOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  let rejectTerminal = true;
  const interruptedStore: OperationStore = {
    append(record) {
      if (rejectTerminal && record.event.type === "operation_completed") {
        rejectTerminal = false;
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: interruptedStore,
    projectRoot: workspaceRoot,
    stateRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-recover-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const _record of host.operations.events({ operationId: operation.operationId })) {
      // The real Host closes this causal stream when terminal persistence fails.
    }
    await expect(host.operations.query(operation.operationId)).resolves.toMatchObject({
      status: "recovery_required",
    });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });

    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      actions: ["recover"],
      operationId: operation.operationId,
      status: "recovery_required",
    });
    const recovered = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation.getState().authoritative.active?.linkedOperations[0]?.status === "completed"
      ) {
        recovered.resolve();
      }
    });
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      failureGuard = setTimeout(
        () => reject(new Error("Recovery admission waited for operation settlement.")),
        5_000,
      );
    });
    const receipt = presentation.dispatch({
      type: "recover_operation",
      operationId: operation.operationId,
    });
    await reconciliationStarted.promise;
    await expect(Promise.race([receipt, failed])).resolves.toMatchObject({
      status: "admitted",
      resource: null,
    });
    releaseReconciliation.resolve();
    await Promise.race([recovered.promise, failed]);
    if (failureGuard !== undefined) {
      clearTimeout(failureGuard);
    }
    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      actions: [],
      operationId: operation.operationId,
      status: "completed",
    });
    await expect(
      presentation.dispatch({ type: "recover_operation", operationId: operation.operationId }),
    ).resolves.toMatchObject({ code: "stale_interaction", status: "rejected" });
    unsubscribe();
    await presentation.close();
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseReconciliation.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession advances durable recovery truth after reconciliation rejects", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-recovery-reject-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  const controlKey = `__adamPresentationRecoveryReject${Date.now()}${Math.random()}`;
  const reconciliationStarted = Promise.withResolvers<void>();
  const releaseReconciliation = Promise.withResolvers<void>();
  (globalThis as Record<string, unknown>)[controlKey] = {
    reconciliationStarted: reconciliationStarted.resolve,
    rejectReconciliation: true,
    releaseReconciliation: releaseReconciliation.promise,
  };
  await mkdir(workspaceRoot);
  await writePresentationRecoverableOperationExtension(packageRoot, controlKey);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  let rejectTerminal = true;
  const interruptedStore: OperationStore = {
    append(record) {
      if (rejectTerminal && record.event.type === "operation_completed") {
        rejectTerminal = false;
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: interruptedStore,
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-recovery-reject-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const _record of host.operations.events({ operationId: operation.operationId })) {
      // The real Host closes this stream after terminal persistence fails.
    }
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const durableAttemptVisible = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const current = presentation.getState();
      if (
        current.authoritative.continuity.status === "current" &&
        current.authoritative.continuity.operationThrough.some(
          (cursor) => cursor.operationId === operation.operationId && cursor.sequence === 2,
        )
      ) {
        durableAttemptVisible.resolve();
      }
    });
    try {
      await expect(
        presentation.dispatch({ type: "recover_operation", operationId: operation.operationId }),
      ).resolves.toMatchObject({ status: "admitted" });
      await reconciliationStarted.promise;
      releaseReconciliation.resolve();
      await durableAttemptVisible.promise;
      expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
        actions: ["recover"],
        operationId: operation.operationId,
        status: "recovery_required",
      });
    } finally {
      unsubscribe();
      releaseReconciliation.resolve();
      await presentation.close();
    }
  } finally {
    delete (globalThis as Record<string, unknown>)[controlKey];
    releaseReconciliation.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps an unavailable recovery generic and actionless", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-generic-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationRecoverableOperationExtension(packageRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const durableStore = createInMemoryOperationStore();
  let rejectTerminal = true;
  const interruptedStore: OperationStore = {
    append(record) {
      if (rejectTerminal && record.event.type === "operation_completed") {
        rejectTerminal = false;
        return Promise.reject(new Error("injected terminal persistence failure"));
      }
      return durableStore.append(record);
    },
    findByIdempotency: (scope) => durableStore.findByIdempotency(scope),
    listLinkedStarts: (options) => durableStore.listLinkedStarts(options),
    read: (operationId) => durableStore.read(operationId),
  };
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: interruptedStore,
    projectRoot: workspaceRoot,
    stateRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-generic-recovery-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const _record of host.operations.events({ operationId: operation.operationId })) {
      // The real Host closes this stream after terminal persistence fails.
    }
    await host.disableExtension("fixture.extension");
    await expect(host.operations.query(operation.operationId)).resolves.toMatchObject({
      presentation: { kind: "generic" },
      recoverable: false,
      status: "recovery_required",
    });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    expect(presentation.getState().authoritative.active?.linkedOperations[0]).toMatchObject({
      actions: [],
      operationId: operation.operationId,
      provenance: { presentation: "generic" },
      status: "recovery_required",
    });
    await expect(
      presentation.dispatch({ type: "recover_operation", operationId: operation.operationId }),
    ).resolves.toMatchObject({ code: "stale_interaction", status: "rejected" });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps a generic linked operation and reads its bounded report artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-artifact-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationArtifactOperationExtension(packageRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    artifactStore: await createFileArtifactStore({ root: join(stateRoot, "artifacts") }),
    capabilities: [{ id: "adam.artifact.publish@1", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [{ id: "adam.artifact.publish@1", version: "^1.0.0" }],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operation = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-artifact-1",
      input: { revision: "abc123" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const record of host.operations.events({ operationId: operation.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const projected = presentation.getState().authoritative.active?.linkedOperations[0];

    expect(projected).toMatchObject({
      artifacts: [
        {
          contract: { id: "fixture.report", version: 1 },
          reference: {
            byteCount: 23,
            mediaType: "text/markdown",
            source: "operation",
          },
          role: "report",
        },
      ],
      operationId: operation.operationId,
      provenance: {
        presentation: "generic",
        title: "fixture.review",
      },
      status: "completed",
    });
    const report = projected?.artifacts[0]?.reference;
    if (report === undefined) {
      throw new Error("Expected one projected operation report.");
    }
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: report,
        range: { offset: 0, maximumBytes: 16 * 1024 },
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      resource: { eof: true, text: "# Fixture review report" },
    });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession bounds linked-operation overflow without rejecting the session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-pages-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationOperationExtension(packageRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    modelTargets: settledModelTargets(),
    stateRoot,
    workspaceRoot,
  });
  const created = await lifecycle.create({ targetIdentity });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const operations = await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        host.operations.startLinked({
          contributionId: "fixture.review",
          idempotencyKey: `presentation-operation-page-${index}`,
          input: { revision: `${index}` },
          origin: {
            invocation: { id: "review", kind: "presentation_command", version: 1 },
            sessionId: created.sessionId,
            sourceSequence: created.lastSequence,
          },
        }),
      ),
    );
    await Promise.all(
      operations.map(async (operation) => {
        for await (const record of host.operations.events({ operationId: operation.operationId })) {
          if (record.event.type === "operation_completed") {
            break;
          }
        }
      }),
    );
    const firstPage = await host.operations.listLinked({
      limit: 100,
      sessionId: created.sessionId,
      throughSequence: created.lastSequence,
    });
    expect(firstPage).toMatchObject({ items: { length: 100 }, nextCursor: expect.any(String) });
    if (firstPage.nextCursor === null) {
      throw new Error("Expected a second linked-operation page.");
    }
    await expect(
      host.operations.listLinked({
        cursor: firstPage.nextCursor,
        limit: 100,
        sessionId: created.sessionId,
        throughSequence: created.lastSequence,
      }),
    ).resolves.toMatchObject({ items: { length: 100 }, nextCursor: expect.any(String) });
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: created.lastSequence,
    });
    const exactBound = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    expect(exactBound.getState().authoritative.active).toMatchObject({
      linkedOperations: { length: 256 },
      linkedOperationsTruncated: false,
    });
    expect(exactBound.getState().authoritative.continuity).toMatchObject({ status: "current" });
    await exactBound.close();
    const overflow = await host.operations.startLinked({
      contributionId: "fixture.review",
      idempotencyKey: "presentation-operation-page-overflow",
      input: { revision: "overflow" },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: child.sessionId,
        sourceSequence: child.lastSequence,
      },
    });
    for await (const record of host.operations.events({ operationId: overflow.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets: settledModelTargets(),
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    const projected = presentation.getState().authoritative.active?.linkedOperations ?? [];

    expect(projected).toHaveLength(256);
    expect(new Set(projected.map((operation) => operation.operationId)).size).toBe(256);
    expect(presentation.getState().authoritative.active).toMatchObject({
      linkedOperationsTruncated: true,
    });
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      status: "degraded",
      fault: { code: "authoritative_state_unavailable" },
    });
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession replaces linked operation truth when selecting another project session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-operation-select-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageRoot = join(testRoot, "extension");
  await mkdir(workspaceRoot);
  await writePresentationOperationExtension(packageRoot);
  const harness = createInMemorySessionLifecycleHarness();
  const modelTargets = settledModelTargets();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
  const firstCreated = await lifecycle.create({ targetIdentity });
  const secondCreated = await lifecycle.create({ targetIdentity });
  const first = (
    await lifecycle.continue({
      sessionId: firstCreated.sessionId,
      input: { text: "First session" },
    })
  ).snapshot;
  const second = (
    await lifecycle.continue({
      sessionId: secondCreated.sessionId,
      input: { text: "Second session" },
    })
  ).snapshot;
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.extension",
        grants: [],
        packageName: "@fixture/extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore: createInMemoryOperationStore(),
    projectRoot: workspaceRoot,
  });

  try {
    await host.loadConfiguredExtensions();
    const starts = await Promise.all(
      [first, second].map((session, index) =>
        host.operations.startLinked({
          contributionId: "fixture.review",
          idempotencyKey: `presentation-operation-select-${index}`,
          input: { revision: `${index}` },
          origin: {
            invocation: { id: "review", kind: "presentation_command", version: 1 },
            sessionId: session.sessionId,
            sourceSequence: session.lastSequence,
          },
        }),
      ),
    );
    await Promise.all(
      starts.map(async (operation) => {
        for await (const record of host.operations.events({ operationId: operation.operationId })) {
          if (record.event.type === "operation_completed") {
            break;
          }
        }
      }),
    );
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      operations: host.operations,
      projectLabel: "workspace",
      sessionId: first.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationSessionRecordReader]: readInMemoryPresentationRecords(harness.sessions),
    });
    expect(
      presentation
        .getState()
        .authoritative.active?.linkedOperations.map((operation) => operation.operationId),
    ).toEqual([starts[0]?.operationId]);

    await expect(
      presentation.dispatch({ type: "select_session", sessionId: second.sessionId }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(
      presentation
        .getState()
        .authoritative.active?.linkedOperations.map((operation) => operation.operationId),
    ).toEqual([starts[1]?.operationId]);
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      operationThrough: [{ operationId: starts[1]?.operationId, sequence: 2 }],
      status: "current",
    });
    expect(
      presentation
        .getState()
        .authoritative.active?.transcript.items.filter((item) => item.type === "operation_link"),
    ).toHaveLength(1);
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession catches up a durable settlement that arrives after hydration", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-catch-up-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Durable answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: true,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationHydrationBarrier]: {
        async afterHydrate() {
          await lifecycle.continue({
            sessionId: created.sessionId,
            input: { text: "Complete during hydration" },
          });
        },
      },
    });

    const caughtUp = presentation.getState();
    expect(caughtUp).toMatchObject({
      authoritative: {
        continuity: { status: "current" },
        active: { session: { id: created.sessionId, status: "settled" } },
      },
      transient: null,
    });
    if (caughtUp.authoritative.continuity.status !== "current") {
      throw new Error("Expected current Presentation continuity after hydration catch-up.");
    }
    expect([9, 10]).toContain(caughtUp.authoritative.continuity.sessionThroughSequence);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects one settled run as stable user and assistant chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-chronology-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Durable answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Complete before opening" },
    });

    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.transcript).toEqual({
      items: [
        {
          type: "user_message",
          id: `${created.sessionId}:2`,
          sequence: 2,
          sourceSessionId: created.sessionId,
          branchBoundary: null,
          text: "Complete before opening",
        },
        {
          type: "assistant_message",
          id: `${created.sessionId}:6`,
          sequence: 6,
          sourceSessionId: created.sessionId,
          branchBoundary: { sessionId: created.sessionId, sequence: 8 },
          text: "Durable answer.",
          artifact: null,
        },
      ],
      olderCursor: null,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession restores provider-reported context occupancy after restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-provider-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Provider usage answer." },
    { type: "usage", inputTokens: 12_345, outputTokens: 99 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Persist exact provider usage" },
    });
    await lifecycle.close();

    const restarted = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      modelTargets,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.context).toEqual({
      profile: contextProfile,
      ordinaryUsage: {
        inputTokens: 12_345,
        outputTokens: 99,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "provider_reported", tokens: 12_345 },
    });

    await presentation.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession restores inherited provider context for a fresh child", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-branch-context-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Inherited provider usage answer." },
    { type: "usage", inputTokens: 23_456, outputTokens: 101 },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    const completed = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Persist usage before branching" },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: completed.snapshot.lastSequence,
    });
    await lifecycle.close();

    const restarted = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      modelTargets,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.context).toEqual({
      profile: contextProfile,
      ordinaryUsage: {
        inputTokens: 23_456,
        outputTokens: 101,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      compactionUsage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        unknownCalls: 0,
      },
      active: { source: "provider_reported", tokens: 23_456 },
    });

    await presentation.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession prefers terminal lifecycle context over stale Presentation context", () => {
  const latest = {
    profile: contextProfile,
    ordinaryUsage: {
      inputTokens: 12_345,
      outputTokens: 99,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheMissInputTokens: 0,
      unknownCalls: 0,
    },
    compactionUsage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheMissInputTokens: 0,
      unknownCalls: 0,
    },
    active: { source: "provider_reported" as const, tokens: 12_345 },
  };
  const terminal = {
    ...latest,
    ordinaryUsage: { ...latest.ordinaryUsage, unknownCalls: 1 },
    active: { source: "unknown" as const },
  };

  expect({
    terminal: resolvePresentationTerminalContext(latest, terminal),
    fallback: resolvePresentationTerminalContext(latest, null),
  }).toEqual({ terminal, fallback: latest });
});

test("PresentationSession loads older chronology through an opaque tail cursor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-paging-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver((request) => {
    const message = [...request.messages].reverse().find((entry) => entry.role === "user");
    return [
      { type: "text_delta", text: `Answer: ${message?.content ?? "missing"}` },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({ sessionId: created.sessionId, name: "Paging" });
    for (const text of ["First", "Second", "Third"]) {
      await lifecycle.continue({ sessionId: created.sessionId, input: { text } });
    }
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationHistoryPageSize]: 2,
    });

    const initial = presentation.getState();
    expect(initial.authoritative.active?.transcript).toMatchObject({
      items: [
        { type: "user_message", text: "Third" },
        { type: "assistant_message", text: "Answer: Third" },
      ],
      olderCursor: expect.any(String),
    });
    const before = initial.authoritative.active?.transcript.olderCursor;
    if (before === null || before === undefined) {
      throw new Error("Expected an opaque older-history cursor.");
    }
    let notifications = 0;
    const unsubscribe = presentation.subscribe(() => {
      notifications += 1;
    });

    await expect(
      presentation.dispatch({ type: "load_older_transcript", before }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.transcript).toMatchObject({
      items: [
        { type: "user_message", text: "Second" },
        { type: "assistant_message", text: "Answer: Second" },
        { type: "user_message", text: "Third" },
        { type: "assistant_message", text: "Answer: Third" },
      ],
      olderCursor: expect.any(String),
    });
    expect(notifications).toBe(1);
    unsubscribe();
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession links an artifact-backed assistant response without embedding bytes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-artifact-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const answer = `${"a".repeat(16_383)}😀${"b".repeat(256 * 1024)}`;
  const answerByteCount = Buffer.byteLength(answer, "utf8");
  const driver = new FakeModelDriver([
    { type: "text_delta", text: answer },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create a large response" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    const assistant = presentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "assistant_message" && item.artifact !== null,
      );
    expect(assistant).toMatchObject({
      type: "assistant_message",
      id: expect.stringMatching(new RegExp(`^${created.sessionId}:[0-9]+$`, "u")),
      sequence: expect.any(Number),
      sourceSessionId: created.sessionId,
      branchBoundary: { sessionId: created.sessionId, sequence: expect.any(Number) },
      text: null,
      artifact: {
        id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        mediaType: "text/plain; charset=utf-8",
        byteCount: answerByteCount,
        source: "model_response",
      },
    });
    expect(JSON.stringify(presentation.getState())).not.toContain(answer.slice(0, 4_096));
    if (assistant?.type !== "assistant_message" || assistant.artifact === null) {
      throw new Error("Expected an artifact-backed assistant response.");
    }
    const firstPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: assistant.artifact,
      range: { offset: 0, maximumBytes: 16 * 1024 },
    });
    expect(firstPage).toMatchObject({
      status: "admitted",
      resource: {
        offset: 0,
        totalByteCount: answerByteCount,
      },
    });
    if (firstPage.status !== "admitted" || firstPage.resource === null) {
      throw new Error("Expected the first bounded assistant artifact page.");
    }
    expect(firstPage.resource.text).not.toContain("�");
    const secondPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: assistant.artifact,
      range: {
        offset: firstPage.resource.byteCount,
        maximumBytes: 16 * 1024,
      },
    });
    expect(secondPage).toMatchObject({ status: "admitted" });
    if (secondPage.status !== "admitted" || secondPage.resource === null) {
      throw new Error("Expected the second bounded assistant artifact page.");
    }
    expect(`${firstPage.resource.text}${secondPage.resource.text}`).toBe(
      answer.slice(0, firstPage.resource.text.length + secondPage.resource.text.length),
    );
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: assistant.artifact,
        range: { offset: 0, maximumBytes: 16 * 1024 + 1 },
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "not_available" });
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: { ...assistant.artifact, source: "tool_output" },
        range: { offset: 0, maximumBytes: 16 * 1024 },
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "stale_interaction" });
    const artifactPath = join(
      stateRoot,
      "artifacts",
      assistant.artifact.id.replace(/^sha256:/u, ""),
    );
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, Buffer.alloc(answerByteCount, 0x78));
    await expect(
      presentation.dispatch({
        type: "read_artifact",
        artifact: assistant.artifact,
        range: { offset: 0, maximumBytes: 16 * 1024 },
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "not_available" });
    await writeFile(artifactPath, answer, "utf8");
    await presentation.close();

    const projectId = createHash("sha256").update(workspaceRoot).digest("hex");
    const sessionPath = join(
      stateRoot,
      "projects",
      projectId,
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const durableLog = await readFile(sessionPath, "utf8");
    const forgedLog = durableLog.replaceAll(
      `"byteCount":${answerByteCount}`,
      `"byteCount":${answerByteCount + 1}`,
    );
    expect(forgedLog).not.toBe(durableLog);
    await writeFile(sessionPath, forgedLog, "utf8");
    const forgedPresentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    const forgedAssistant = forgedPresentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "assistant_message" && item.artifact !== null,
      );
    if (forgedAssistant?.type !== "assistant_message" || forgedAssistant.artifact === null) {
      throw new Error("Expected a forged artifact-backed assistant response.");
    }
    expect(forgedAssistant.artifact.byteCount).toBe(answerByteCount + 1);
    await expect(
      forgedPresentation.dispatch({
        type: "read_artifact",
        artifact: forgedAssistant.artifact,
        range: null,
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "not_available" });

    await forgedPresentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession replays artifact-backed provider reasoning through an owner-only reference", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-reasoning-artifact-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const reasoning = `Evidence: ${"r".repeat(256 * 1024)}`;
  const reasoningByteCount = Buffer.byteLength(reasoning, "utf8");
  const driver = new FakeModelDriver([
    {
      type: "reasoning_start",
      id: "provider-reasoning-0",
      artifactType: "provider_reasoning",
    },
    { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoning },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    { type: "text_delta", text: "Verified." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Store large provider reasoning" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    try {
      const block = presentation
        .getState()
        .authoritative.active?.transcript.items.find(
          (item) => item.type === "reasoning_block" && item.artifact !== null,
        );
      expect(block).toMatchObject({
        type: "reasoning_block",
        artifactType: "provider_reasoning",
        disclosure: "owner_only",
        provider: "DeepSeek",
        status: "completed",
        text: null,
        artifact: {
          mediaType: "text/plain; charset=utf-8",
          byteCount: reasoningByteCount,
          source: "model_response",
        },
      });
      expect(JSON.stringify(presentation.getState())).not.toContain(reasoning.slice(0, 4_096));
      if (block?.type !== "reasoning_block" || block.artifact === null) {
        throw new Error("Expected artifact-backed provider reasoning.");
      }
      await expect(
        presentation.dispatch({
          type: "read_artifact",
          artifact: block.artifact,
          range: { offset: 0, maximumBytes: 16 * 1024 },
        }),
      ).resolves.toMatchObject({
        status: "admitted",
        resource: { offset: 0, totalByteCount: reasoningByteCount },
      });
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession preserves a durable compaction marker in visible chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-compaction-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "context.txt"), "durable context detail ".repeat(1_000));
  const compactingProfile: ContextProfile = {
    ...contextProfile,
    contextWindowTokens: 20_000,
    maximumOutputTokens: 100,
    compactAtTokens: 4_000,
    postCompactTargetTokens: 3_000,
    retainedTargetTokens: 500,
  };
  let ordinaryCall = 0;
  const summary = JSON.stringify({
    schemaVersion: 1,
    objective: "Use the repository context and finish the requested task.",
    constraints: ["Keep durable history authoritative."],
    progress: ["The context file was read."],
    unresolvedQuestions: [],
    failures: [],
    remainingVerification: ["Return the final answer."],
    nextSafeAction: "Continue with the compacted context.",
  });
  const driver = new FakeModelDriver((request) => {
    if (request.tools.length === 0) {
      return [
        { type: "text_delta", text: summary },
        { type: "usage", inputTokens: 560, outputTokens: 40 },
        { type: "finish", reason: "stop" },
      ];
    }
    ordinaryCall += 1;
    if (ordinaryCall === 1) {
      return [
        { type: "usage", inputTokens: 20, outputTokens: 8 },
        { type: "tool_call_start", id: "read-context", name: "read_file" },
        { type: "tool_call_delta", id: "read-context", json: '{"path":"context.txt"}' },
        { type: "tool_call_end", id: "read-context" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Compaction preserved the task." },
      { type: "usage", inputTokens: 90, outputTokens: 12 },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile: compactingProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile: compactingProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read context.txt and finish the task." },
      limits: { maxTurns: 2 },
    });
    expect(continued.result).toEqual({
      status: "completed",
      answer: "Compaction preserved the task.",
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.transcript.items).toContainEqual({
      type: "compaction_marker",
      id: expect.stringMatching(new RegExp(`^${created.sessionId}:[0-9]+$`, "u")),
      sequence: expect.any(Number),
      sourceSessionId: created.sessionId,
      branchBoundary: null,
      windowNumber: 1,
      sourceThrough: expect.any(Number),
      retainedFrom: expect.any(Number),
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession preserves a causally cancelled run as an interrupted notice", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-interrupted-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelStarted = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "Inspect before cancellation.",
      } as const;
      modelStarted.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw request.signal.reason;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const controller = new AbortController();
    const continuation = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Cancel after the model starts" },
      signal: controller.signal,
    });
    await modelStarted.promise;
    controller.abort(new Error("fixture cancellation"));
    await expect(continuation).resolves.toMatchObject({ result: { status: "cancelled" } });

    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.transcript.items).toContainEqual({
      type: "reasoning_block",
      id: expect.stringMatching(new RegExp(`^${created.sessionId}:`, "u")),
      sequence: expect.any(Number),
      sourceSessionId: created.sessionId,
      branchBoundary: { sessionId: created.sessionId, sequence: expect.any(Number) },
      artifactType: "provider_reasoning",
      disclosure: "owner_only",
      provider: "DeepSeek",
      status: "interrupted",
      text: null,
      artifact: null,
    });
    expect(presentation.getState().authoritative.active?.transcript.items).toContainEqual({
      type: "session_notice",
      id: expect.stringMatching(new RegExp(`^${created.sessionId}:[0-9]+$`, "u")),
      sequence: expect.any(Number),
      sourceSessionId: created.sessionId,
      branchBoundary: { sessionId: created.sessionId, sequence: expect.any(Number) },
      status: "interrupted",
      reason: "cancelled",
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession resumes and normalizes an in-flight provider attempt before display", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const firstLifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });

  try {
    const created = await firstLifecycle.create({ targetIdentity });
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const genesis = (await store.read())[0];
    if (
      genesis?.schemaVersion !== 3 ||
      genesis.record.type !== "session_genesis" ||
      genesis.record.promptContext === undefined
    ) {
      throw new Error("Expected a current prompt context fixture.");
    }
    const promptMessages = assemblePromptMessagesV1(
      [{ role: "user", content: "Recover the display" }],
      genesis.record.promptContext,
      genesis.record.skillContext,
      new Map(),
    );
    const promptTools = genesis.record.promptContext.toolProfile.definitions.map(
      ({ definition }) => definition,
    );
    const runId = "123e4567-e89b-42d3-a456-426614170001";
    await store.append({
      schemaVersion: 3,
      sequence: 2,
      record: { type: "logical_run_started", runId, userMessage: "Recover the display" },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 3,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "user_message", text: "Recover the display" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 4,
      record: {
        type: "provider_attempt_started",
        runId,
        turn: 1,
        attempt: 1,
        targetIdentity,
        promptProjection: {
          version: 1,
          assemblyIdentityDigest: genesis.record.promptContext.assemblyIdentityDigest,
          requestProjectionDigest: digestPromptRequestV1(promptMessages, promptTools),
        },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 5,
      record: {
        type: "runtime_event",
        runId,
        event: { type: "model_message_started" },
      },
    });
    await store.append({
      schemaVersion: 3,
      sequence: 6,
      record: {
        type: "runtime_event",
        runId,
        event: {
          type: "model_reasoning_started",
          id: "1:1:provider-reasoning-0",
          artifactType: "provider_reasoning",
        },
      },
    });
    await firstLifecycle.close();

    const resumeTargets: ModelTargets = {
      async resolve() {
        return {
          identity: targetIdentity,
          driver: new FakeModelDriver([]),
          contextProfile,
        };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile,
            },
          ],
        };
      },
    };
    const restarted = createSessionLifecycle({
      modelTargets: resumeTargets,
      stateRoot,
      workspaceRoot,
    });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState()).toMatchObject({
      authoritative: {
        continuity: { status: "current", sessionThroughSequence: 8 },
        active: {
          session: { status: "interrupted" },
          transcript: {
            items: [
              { type: "user_message", text: "Recover the display" },
              {
                type: "reasoning_block",
                status: "interrupted",
                provider: "DeepSeek",
              },
              { type: "session_notice", status: "interrupted", reason: "process_restart" },
            ],
          },
        },
      },
    });

    await presentation.close();
    await restarted.close();
  } finally {
    await firstLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession reconstructs a child transcript from its durable branch prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    {
      type: "reasoning_start",
      id: "provider-reasoning-0",
      artifactType: "provider_reasoning",
    },
    {
      type: "reasoning_delta",
      id: "provider-reasoning-0",
      text: "Inspect the parent branch.",
    },
    { type: "reasoning_end", id: "provider-reasoning-0" },
    { type: "text_delta", text: "Parent answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({ sessionId: parent.sessionId, name: "Parent" });
    const completed = await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Parent prompt" },
    });
    const child = await lifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: completed.snapshot.lastSequence,
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.transcript).toEqual({
      items: [
        {
          type: "user_message",
          id: `${parent.sessionId}:3`,
          sequence: 3,
          sourceSessionId: parent.sessionId,
          branchBoundary: null,
          text: "Parent prompt",
        },
        {
          type: "reasoning_block",
          id: expect.stringMatching(new RegExp(`^${parent.sessionId}:`, "u")),
          sequence: 9,
          sourceSessionId: parent.sessionId,
          branchBoundary: { sessionId: parent.sessionId, sequence: 11 },
          artifactType: "provider_reasoning",
          disclosure: "owner_only",
          provider: "DeepSeek",
          status: "completed",
          text: "Inspect the parent branch.",
          artifact: null,
        },
        {
          type: "assistant_message",
          id: `${parent.sessionId}:9`,
          sequence: 9,
          sourceSessionId: parent.sessionId,
          branchBoundary: { sessionId: parent.sessionId, sequence: 11 },
          text: "Parent answer.",
          artifact: null,
        },
      ],
      olderCursor: null,
    });
    expect(presentation.getState().authoritative.active?.session.id).toBe(child.sessionId);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession uses the atomically recorded first-run fallback label", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-fallback-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Named." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "  Fix\n transcript\u0007 hydration  " },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.session.naming.fallbackTitle).toBe(
      "Fix transcript hydration",
    );
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    expect(
      (await store.read()).find(
        (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
      ),
    ).toMatchObject({
      record: {
        type: "logical_run_started",
        userMessage: "  Fix\n transcript\u0007 hydration  ",
        naming: { profileVersion: 1, fallbackTitle: "Fix transcript hydration" },
      },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle exposes the atomic fallback at the post-fsync crash boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-fallback-crash-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const reachedBoundary = Promise.withResolvers<void>();
  const releaseBoundary = Promise.withResolvers<void>();
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: targetIdentity,
        driver: new FakeModelDriver([
          { type: "text_delta", text: "Must not precede the boundary." },
          { type: "finish", reason: "stop" },
        ]),
        contextProfile,
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionLogicalRunStartedBarrier]: {
      async afterDurableRecord() {
        reachedBoundary.resolve();
        await releaseBoundary.promise;
      },
    },
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const controller = new AbortController();
    const continuation = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "  Atomic\n fallback at crash  " },
      signal: controller.signal,
    });
    await reachedBoundary.promise;
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    expect(await store.read()).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ type: "session_genesis" }) }),
      expect.objectContaining({
        sequence: 2,
        record: {
          type: "logical_run_started",
          runId: expect.any(String),
          userMessage: "  Atomic\n fallback at crash  ",
          naming: { profileVersion: 1, fallbackTitle: "Atomic fallback at crash" },
        },
      }),
    ]);
    controller.abort();
    releaseBoundary.resolve();
    await expect(continuation).resolves.toMatchObject({ result: { status: "cancelled" } });
  } finally {
    releaseBoundary.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession durably sets a manual name with authoritative sequence truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-manual-name-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }

    await expect(
      presentation.dispatch({
        type: "set_session_manual_name",
        sessionId,
        name: "Manual presentation name",
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState()).toMatchObject({
      authoritative: {
        continuity: { status: "current", sessionThroughSequence: 2 },
        sessions: {
          items: [
            {
              id: sessionId,
              label: "Manual presentation name",
              naming: {
                manualName: "Manual presentation name",
                generatedTitle: null,
                fallbackTitle: null,
                displayLabel: "Manual presentation name",
              },
            },
          ],
        },
        active: {
          session: {
            id: sessionId,
            label: "Manual presentation name",
            naming: { manualName: "Manual presentation name" },
          },
        },
      },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession clears a manual name to reveal the durable fallback", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-clear-name-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Done." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "Temporary manual title",
    });
    await lifecycle.continue({ sessionId: created.sessionId, input: { text: "Fallback title" } });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await expect(
      presentation.dispatch({
        type: "clear_session_manual_name",
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState().authoritative.active?.session).toMatchObject({
      label: "Fallback title",
      naming: {
        manualName: null,
        generatedTitle: null,
        fallbackTitle: "Fallback title",
        displayLabel: "Fallback title",
      },
    });
    expect(presentation.getState().authoritative.continuity).toMatchObject({
      status: "current",
      sessionThroughSequence: 11,
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession closes the automatic title slot as in progress after the first turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-started-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseTitle = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        await releaseTitle.promise;
        yield { type: "text_delta", text: "Generated later" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  lifecycle.enableAutomaticTitles();

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "First successful prompt" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: null,
      generatedTitle: null,
      fallbackTitle: "First successful prompt",
      displayLabel: "First successful prompt",
      generation: {
        status: "in_progress",
        generationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      },
    });

    await presentation.close();
    releaseTitle.resolve();
  } finally {
    releaseTitle.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession restores one completed no-tools automatic title with separate usage", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-completed-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let ordinaryCalls = 0;
  let titleRequest:
    | { readonly tools: number; readonly maximumOutputTokens: number; readonly messages: unknown }
    | undefined;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleRequest = {
          tools: request.tools.length,
          maximumOutputTokens: request.maximumOutputTokens,
          messages: request.messages,
        };
        yield { type: "text_delta", text: "Generated concise title" };
        yield { type: "usage", inputTokens: 14, outputTokens: 4 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCalls += 1;
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  lifecycle.enableAutomaticTitles();

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Summarize this session title" },
    });
    await lifecycle.close();

    const restarted = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: null,
      generatedTitle: "Generated concise title",
      fallbackTitle: "Summarize this session title",
      displayLabel: "Generated concise title",
      generation: {
        status: "completed",
        usage: { status: "known", inputTokens: 14, outputTokens: 4 },
      },
    });
    expect({ ordinaryCalls, titleRequest }).toEqual({
      ordinaryCalls: 1,
      titleRequest: {
        tools: 0,
        maximumOutputTokens: 64,
        messages: [
          {
            role: "system",
            content:
              "Generate one concise plain-text title for this coding session. Return only the title.",
          },
          { role: "user", content: "Summarize this session title" },
        ],
      },
    });

    await presentation.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps the fallback when automatic title generation fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-failed-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        throw new Error("private provider failure");
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  lifecycle.enableAutomaticTitles();

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Fallback survives title failure" },
    });
    await lifecycle.close();

    const restarted = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      generatedTitle: null,
      fallbackTitle: "Fallback survives title failure",
      displayLabel: "Fallback survives title failure",
      generation: {
        status: "failed",
        reason: "model_request_failed",
      },
    });

    await presentation.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle defaults automatic titles on before Presentation attaches", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-catchup-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let titleCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleCalls += 1;
        yield { type: "text_delta", text: "Caught up title" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Headless answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Name this earlier headless turn" },
    });
    await lifecycle.close();
    expect(titleCalls).toBe(1);

    const restarted = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      generatedTitle: "Caught up title",
      displayLabel: "Caught up title",
      generation: { status: "completed" },
    });
    expect(titleCalls).toBe(1);
    await presentation.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the 30-second title deadline through an injected scheduler", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-deadline-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const deadlineScheduled = Promise.withResolvers<void>();
  let expireTitle: (() => void) | undefined;
  let scheduledMilliseconds: number | undefined;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionTitleDeadlineScheduler]: {
      schedule(delayMilliseconds, onDeadline) {
        scheduledMilliseconds = delayMilliseconds;
        expireTitle = onDeadline;
        deadlineScheduled.resolve();
        return { cancel() {} };
      },
    },
  });
  lifecycle.enableAutomaticTitles();

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Bound title generation by policy" },
    });
    await deadlineScheduled.promise;
    expect(scheduledMilliseconds).toBe(30_000);
    expireTitle?.();
    await lifecycle.close();
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    expect(await store.read()).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "session_title_generation_failed",
          reason: "model_request_failed",
        }),
      }),
    );
  } finally {
    expireTitle?.();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession settles an orphaned title attempt once without retry after restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-restart-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseTitle = Promise.withResolvers<void>();
  let titleCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleCalls += 1;
        await releaseTitle.promise;
        yield { type: "text_delta", text: "Must not win after restart" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const firstLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  firstLifecycle.enableAutomaticTitles();

  try {
    const created = await firstLifecycle.create({ targetIdentity });
    await firstLifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Do not retry this title" },
    });
    expect(titleCalls).toBe(1);

    const restarted = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      generatedTitle: null,
      fallbackTitle: "Do not retry this title",
      displayLabel: "Do not retry this title",
      generation: { status: "failed", reason: "process_restart" },
    });
    expect(titleCalls).toBe(1);

    await presentation.close();
    await restarted.close();
  } finally {
    releaseTitle.resolve();
    await firstLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession records skipped manual automatic naming without a title call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-skipped-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let titleCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleCalls += 1;
        yield { type: "text_delta", text: "Should not be requested" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  lifecycle.enableAutomaticTitles();

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    await presentation.dispatch({
      type: "set_session_manual_name",
      sessionId,
      name: "Manual wins",
    });
    await lifecycle.continue({ sessionId, input: { text: "First prompt after manual naming" } });
    await lifecycle.close();

    const restarted = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const restored = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(restored.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: "Manual wins",
      generatedTitle: null,
      fallbackTitle: "First prompt after manual naming",
      displayLabel: "Manual wins",
      generation: { status: "skipped_manual" },
    });
    expect(titleCalls).toBe(0);

    await restored.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession explicitly regenerates and replaces the generated title", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-regenerate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let titleCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleCalls += 1;
        yield {
          type: "text_delta",
          text: titleCalls === 1 ? "Initial generated title" : "Regenerated title",
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const firstLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  firstLifecycle.enableAutomaticTitles();

  try {
    const created = await firstLifecycle.create({ targetIdentity });
    await firstLifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Regenerate this title" },
    });
    await firstLifecycle.close();

    const secondLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const presentation = await createPresentationSession({
      lifecycle: secondLifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await expect(
      presentation.dispatch({
        type: "regenerate_session_title",
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    await presentation.close();
    await secondLifecycle.close();

    const thirdLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const restored = await createPresentationSession({
      lifecycle: thirdLifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    expect(restored.getState().authoritative.active?.session.naming).toMatchObject({
      generatedTitle: "Regenerated title",
      displayLabel: "Regenerated title",
      generation: { status: "completed" },
    });
    expect(titleCalls).toBe(2);

    await restored.close();
    await thirdLifecycle.close();
  } finally {
    await firstLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession gives a child an immutable branch fallback before its first turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-branch-name-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let titleCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        titleCalls += 1;
        yield { type: "text_delta", text: "Generated parent title" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Parent answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const firstLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  firstLifecycle.enableAutomaticTitles();

  try {
    const parent = await firstLifecycle.create({ targetIdentity });
    await firstLifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Parent prompt" },
    });
    await firstLifecycle.close();

    const secondLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await secondLifecycle.setSessionManualName({
      sessionId: parent.sessionId,
      name: "Parent snapshot name",
    });
    const parentSnapshot = await secondLifecycle.inspect({ sessionId: parent.sessionId });
    const child = await secondLifecycle.branch({
      parentSessionId: parent.sessionId,
      atSequence: parentSnapshot.lastSequence,
    });
    const presentation = await createPresentationSession({
      lifecycle: secondLifecycle,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
    });

    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: null,
      generatedTitle: null,
      fallbackTitle: "Branch of Parent snapshot name",
      displayLabel: "Branch of Parent snapshot name",
      generation: { status: "not_started" },
    });
    expect(titleCalls).toBe(1);

    await presentation.close();
    await secondLifecycle.close();
  } finally {
    await firstLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession strips terminal controls and bounds manual names by grapheme", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-name-unicode-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    await presentation.dispatch({
      type: "set_session_manual_name",
      sessionId,
      name: `\u001b[31m${"界".repeat(61)}\u001b[0m`,
    });

    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: "界".repeat(60),
      displayLabel: "界".repeat(60),
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps manual precedence when an in-flight title settles late", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-title-race-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseTitle = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        await releaseTitle.promise;
        yield { type: "text_delta", text: "Late generated title" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Ordinary answer." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  lifecycle.enableAutomaticTitles();

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Race the title" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    await presentation.dispatch({
      type: "set_session_manual_name",
      sessionId: created.sessionId,
      name: "Manual stays visible",
    });
    const invalidated = Promise.withResolvers<"invalidated">();
    const unsubscribe = presentation.subscribe(() => invalidated.resolve("invalidated"));

    releaseTitle.resolve();
    const closed = lifecycle.close().then(() => "closed" as const);
    await expect(Promise.race([invalidated.promise, closed])).resolves.toBe("invalidated");
    expect(presentation.getState().authoritative.active?.session.naming).toMatchObject({
      manualName: "Manual stays visible",
      generatedTitle: "Late generated title",
      displayLabel: "Manual stays visible",
      generation: { status: "completed" },
    });

    unsubscribe();
    await presentation.close();
    await closed;
  } finally {
    releaseTitle.resolve();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession normalizes a real read call without exposing raw arguments", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-read-card-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "notes.txt"), "r".repeat(70_000));
  let call = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        throw new Error("The fixture does not allow a title call.");
      }
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "read-notes", name: "read_file" };
        yield { type: "tool_call_delta", id: "read-notes", json: '{"path":"notes.txt"}' };
        yield { type: "tool_call_end", id: "read-notes" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Read complete." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({ sessionId: created.sessionId, name: "No auto title" });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read notes.txt" },
      limits: { maxTurns: 2 },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    const tool = presentation
      .getState()
      .authoritative.active?.transcript.items.find((item) => item.type === "tool_call");
    expect(tool).toMatchObject({
      type: "tool_call",
      id: expect.stringMatching(new RegExp(`^${created.sessionId}:[0-9]+$`, "u")),
      sequence: expect.any(Number),
      callId: "read-notes",
      qualifiedName: "read_file",
      kind: "read",
      effect: "read",
      label: "read",
      subject: { type: "path", value: "notes.txt" },
      status: "completed",
      resultSummary: "65536 bytes · output truncated",
      artifacts: [],
      changePreviewRef: null,
    });
    expect(JSON.stringify(tool)).not.toContain('{"path":"notes.txt"}');
    expect(JSON.stringify(tool)).not.toContain("r".repeat(1_024));

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession exposes a bounded shell summary and durable overflow artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-shell-artifact-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const command =
    "{ printf '%*s' 16382 '' | tr ' ' x; printf '😀'; printf '%*s' 53614 '' | tr ' ' x; } >&2";
  let call = 0;
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        throw new Error("The fixture does not allow a title call.");
      }
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "shell-output", name: "run_shell" };
        yield {
          type: "tool_call_delta",
          id: "shell-output",
          json: JSON.stringify({ command }),
        };
        yield { type: "tool_call_end", id: "shell-output" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Shell complete." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
    stateRoot,
    tools: createCodingToolRegistry({
      artifactStore: await createFileArtifactStore({ root: join(stateRoot, "artifacts") }),
      stateRoot,
      workspaceRoot,
    }),
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({ sessionId: created.sessionId, name: "No auto title" });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Run a bounded output command" },
      limits: { maxTurns: 2 },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });

    const tool = presentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "tool_call" && item.callId === "shell-output",
      );
    expect(tool).toMatchObject({
      type: "tool_call",
      kind: "shell",
      effect: "execute",
      label: "shell",
      subject: { type: "command", value: command },
      status: "completed",
      resultSummary: "exit 0 · 70000 stderr bytes · output truncated",
      artifacts: [
        {
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          mediaType: "application/octet-stream",
          byteCount: 70_000,
          source: "tool_output",
        },
      ],
    });
    if (tool?.type !== "tool_call" || tool.artifacts[0] === undefined) {
      throw new Error("Expected one shell output artifact.");
    }
    const firstPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: tool.artifacts[0],
      range: { offset: 0, maximumBytes: 16 * 1024 },
    });
    expect(firstPage).toMatchObject({
      status: "admitted",
      resource: { byteCount: 16 * 1024 - 2, offset: 0, totalByteCount: 70_000 },
    });
    if (
      firstPage.status !== "admitted" ||
      firstPage.resource === null ||
      firstPage.resource.nextRange === null
    ) {
      throw new Error("Expected a second shell output artifact page.");
    }
    expect(firstPage.resource.text).not.toContain("�");
    const secondPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: tool.artifacts[0],
      range: firstPage.resource.nextRange,
    });
    expect(secondPage).toMatchObject({ status: "admitted" });
    if (secondPage.status !== "admitted" || secondPage.resource === null) {
      throw new Error("Expected the second shell output artifact page.");
    }
    expect(secondPage.resource.text.startsWith("😀")).toBe(true);
    expect(secondPage.resource.text).not.toContain("�");

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession projects one live pending permission with its inline tool card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-permission-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "pending.txt"), "pending\n");
  const model = new FakeModelDriver([
    { type: "tool_call_start", id: "pending-read", name: "read_file" },
    { type: "tool_call_delta", id: "pending-read", json: '{"path":"pending.txt"}' },
    { type: "tool_call_end", id: "pending-read" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });
  let requestId: string | undefined;
  const permissionRequested = Promise.withResolvers<void>();
  const unsubscribeLifecycle = lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      requestId = event.requestId;
      permissionRequested.resolve();
    }
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    const pendingVisible = Promise.withResolvers<void>();
    const unsubscribePresentation = presentation.subscribe(() => {
      if (presentation.getState().authoritative.active?.pendingInteractions.length === 1) {
        pendingVisible.resolve();
      }
    });
    const continuation = lifecycle.continue({
      sessionId,
      input: { text: "Read pending.txt" },
      limits: { maxTurns: 1 },
    });
    await permissionRequested.promise;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pendingVisible.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The pending Presentation state was never published.")),
            5_000,
          );
        }),
      ]);
      const active = presentation.getState().authoritative.active;
      expect(active?.transcript.items).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          callId: "pending-read",
          status: "permission_required",
        }),
      );
      expect(active?.pendingInteractions).toEqual([
        {
          type: "permission",
          requestId,
          callId: "pending-read",
          effect: "read",
          subject: { type: "path", value: "pending.txt" },
          canAllow: true,
          changePreviewRef: null,
        },
      ]);
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      if (requestId !== undefined) {
        lifecycle.decidePermission({ requestId, decision: "deny" });
      }
      await continuation;
      unsubscribePresentation();
      await presentation.close();
    }
  } finally {
    unsubscribeLifecycle();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession publishes a durable change preview before write permission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-write-preview-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const model = new FakeModelDriver([
    { type: "tool_call_start", id: "pending-write", name: "write_file" },
    {
      type: "tool_call_delta",
      id: "pending-write",
      json: '{"path":"created.txt","content":"line one\\nline two\\n"}',
    },
    { type: "tool_call_end", id: "pending-write" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
    workspaceRoot,
  });
  let requestId: string | undefined;
  const permissionRequested = Promise.withResolvers<void>();
  const unsubscribeLifecycle = lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      requestId = event.requestId;
      permissionRequested.resolve();
    }
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    const previewVisible = Promise.withResolvers<void>();
    const unsubscribePresentation = presentation.subscribe(() => {
      const preview =
        presentation.getState().authoritative.active?.pendingInteractions[0]?.changePreviewRef;
      if (preview !== undefined && preview !== null) {
        previewVisible.resolve();
      }
    });
    const continuation = lifecycle.continue({
      sessionId,
      input: { text: "Create created.txt" },
      limits: { maxTurns: 1 },
    });
    await permissionRequested.promise;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previewVisible.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The durable change preview was never published.")),
            5_000,
          );
        }),
      ]);
      const pending = presentation.getState().authoritative.active?.pendingInteractions[0];
      expect(pending).toMatchObject({
        type: "permission",
        requestId,
        callId: "pending-write",
        effect: "write",
        subject: { type: "path", value: "created.txt" },
        canAllow: true,
        changePreviewRef: {
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          mediaType: "text/x-diff; charset=utf-8",
          byteCount: expect.any(Number),
          source: "change_preview",
        },
      });
      expect(
        presentation
          .getState()
          .authoritative.active?.transcript.items.find(
            (item) => item.type === "tool_call" && item.callId === "pending-write",
          ),
      ).toMatchObject({ changePreviewRef: pending?.changePreviewRef });
      const previewId = pending?.changePreviewRef?.id;
      if (previewId === undefined || requestId === undefined) {
        throw new Error("Expected an actionable canonical preview.");
      }
      rmSync(join(stateRoot, "artifacts", previewId.replace(/^sha256:/u, "")));
      await expect(
        presentation.dispatch({
          type: "decide_permission",
          requestId,
          decision: "allow",
        }),
      ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      if (requestId !== undefined) {
        lifecycle.decidePermission({ requestId, decision: "deny" });
      }
      await continuation;
      unsubscribePresentation();
      await presentation.close();
    }
  } finally {
    unsubscribeLifecycle();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession publishes a canonical structured-edit preview before permission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-edit-preview-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n");
  const model = new FakeModelDriver([
    { type: "tool_call_start", id: "pending-edit", name: "edit_file" },
    {
      type: "tool_call_delta",
      id: "pending-edit",
      json: JSON.stringify({
        operations: [
          {
            kind: "update",
            path: "edit.txt",
            edits: [{ oldText: "before", newText: "after" }],
          },
        ],
      }),
    },
    { type: "tool_call_end", id: "pending-edit" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
    workspaceRoot,
  });
  let requestId: string | undefined;
  const permissionRequested = Promise.withResolvers<void>();
  const unsubscribeLifecycle = lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      requestId = event.requestId;
      permissionRequested.resolve();
    }
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    const previewVisible = Promise.withResolvers<void>();
    const unsubscribePresentation = presentation.subscribe(() => {
      const preview =
        presentation.getState().authoritative.active?.pendingInteractions[0]?.changePreviewRef;
      if (preview !== undefined && preview !== null) {
        previewVisible.resolve();
      }
    });
    const continuation = lifecycle.continue({
      sessionId,
      input: { text: "Update edit.txt" },
      limits: { maxTurns: 1 },
    });
    await permissionRequested.promise;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previewVisible.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The structured-edit preview was never published.")),
            5_000,
          );
        }),
      ]);
      expect(presentation.getState().authoritative.active?.pendingInteractions[0]).toMatchObject({
        requestId,
        callId: "pending-edit",
        canAllow: true,
        changePreviewRef: { source: "change_preview" },
      });
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      if (requestId !== undefined) {
        lifecycle.decidePermission({ requestId, decision: "deny" });
      }
      await continuation;
      unsubscribePresentation();
      await presentation.close();
    }
  } finally {
    unsubscribeLifecycle();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession disables allow when the canonical preview artifact is missing", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-preview-missing-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const model = new FakeModelDriver([
    { type: "tool_call_start", id: "missing-preview", name: "write_file" },
    {
      type: "tool_call_delta",
      id: "missing-preview",
      json: '{"path":"missing.txt","content":"content\\n"}',
    },
    { type: "tool_call_end", id: "missing-preview" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
    workspaceRoot,
  });
  let requestId: string | undefined;
  const permissionRequested = Promise.withResolvers<void>();
  const unsubscribeLifecycle = lifecycle.subscribe((event) => {
    if (event.type !== "tool_permission_requested") {
      return;
    }
    requestId = event.requestId;
    const artifactId = event.changePreviewRef?.id;
    if (artifactId !== undefined) {
      rmSync(join(stateRoot, "artifacts", artifactId.replace(/^sha256:/u, "")));
    }
    permissionRequested.resolve();
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    const pendingVisible = Promise.withResolvers<void>();
    const unsubscribePresentation = presentation.subscribe(() => {
      if (presentation.getState().authoritative.active?.pendingInteractions.length === 1) {
        pendingVisible.resolve();
      }
    });
    const continuation = lifecycle.continue({
      sessionId,
      input: { text: "Create a file with a missing preview" },
      limits: { maxTurns: 1 },
    });
    await permissionRequested.promise;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pendingVisible.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The pending missing-preview state was never published.")),
            5_000,
          );
        }),
      ]);
      expect(presentation.getState().authoritative.active?.pendingInteractions[0]).toMatchObject({
        requestId,
        callId: "missing-preview",
        effect: "write",
        canAllow: false,
        changePreviewRef: {
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          source: "change_preview",
        },
      });
      await expect(
        presentation.dispatch({
          type: "decide_permission",
          requestId: requestId ?? "missing-request",
          decision: "allow",
        }),
      ).resolves.toMatchObject({ status: "rejected", code: "authority_rejected" });
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      if (requestId !== undefined) {
        lifecycle.decidePermission({ requestId, decision: "deny" });
      }
      await continuation;
      unsubscribePresentation();
      await presentation.close();
    }
  } finally {
    unsubscribeLifecycle();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a preview reference whose provenance no longer matches its call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-preview-provenance-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const model = new FakeModelDriver([
    { type: "tool_call_start", id: "bound-preview", name: "write_file" },
    {
      type: "tool_call_delta",
      id: "bound-preview",
      json: '{"path":"bound.txt","content":"content\\n"}',
    },
    { type: "tool_call_end", id: "bound-preview" },
    { type: "finish", reason: "tool_calls" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
    stateRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
    workspaceRoot,
  });
  const requested = Promise.withResolvers<string>();
  const unsubscribe = lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      requested.resolve(event.requestId);
    }
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const continuation = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Prepare one bound preview" },
      limits: { maxTurns: 1 },
    });
    const requestId = await requested.promise;
    expect(lifecycle.decidePermission({ requestId, decision: "deny" })).toMatchObject({
      status: "accepted",
    });
    await continuation;
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const records = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionRecord);
    const tampered = records.map((record) => {
      if (
        record.schemaVersion !== 3 ||
        record.record.type !== "runtime_event" ||
        record.record.event.type !== "tool_permission_requested" ||
        record.record.event.changePreviewRef === undefined
      ) {
        return record;
      }
      return {
        ...record,
        record: {
          ...record.record,
          event: {
            ...record.record.event,
            changePreviewRef: {
              ...record.record.event.changePreviewRef,
              source: {
                ...record.record.event.changePreviewRef.source,
                callId: "substituted-call",
              },
            },
          },
        },
      };
    });
    await writeFile(
      sessionPath,
      `${tampered.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    unsubscribe();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession starts a draft and selects admitted sessions through semantic commands", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-create-select-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = settledModelTargets();
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const first = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: first.sessionId,
      input: { text: "First admitted project session" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      openProject: true,
      projectLabel: "workspace",
      stateRoot,
      workspaceRoot,
    });

    await expect(
      presentation.dispatch({
        type: "create_session",
        targetId: "deepseek-v4-flash.direct",
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState()).toMatchObject({
      draft: { targetId: targetIdentity.targetId },
      authoritative: {
        active: null,
        sessions: { items: [{ id: first.sessionId }] },
      },
    });

    await expect(
      presentation.dispatch({ type: "select_session", sessionId: first.sessionId }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    expect(presentation.getState()).toMatchObject({
      draft: null,
      authoritative: {
        active: {
          session: { id: first.sessionId },
          transcript: {
            items: [
              { type: "user_message", text: "First admitted project session" },
              { type: "assistant_message", text: "Presentation fixture answer." },
            ],
            olderCursor: null,
          },
        },
      },
    });

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession discovers and selects cold sibling project sessions", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-cold-catalog-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = settledModelTargets("Cold catalog answer.");
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const first = await lifecycle.create({ targetIdentity });
    const second = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: first.sessionId, input: { text: "Cold first" } });
    await lifecycle.continue({ sessionId: second.sessionId, input: { text: "Cold second" } });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: second.sessionId,
      stateRoot,
      workspaceRoot,
    });
    try {
      expect(
        presentation
          .getState()
          .authoritative.sessions.items.map((session) => session.id)
          .sort(),
      ).toEqual([first.sessionId, second.sessionId].sort());
      await expect(
        presentation.dispatch({ type: "select_session", sessionId: first.sessionId }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      expect(presentation.getState().authoritative.active?.session.id).toBe(first.sessionId);
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession consumes the opaque project catalog cursor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-catalog-page-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = settledModelTargets("Catalog page answer.");
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = [
      await lifecycle.create({ targetIdentity }),
      await lifecycle.create({ targetIdentity }),
    ];
    for (const [index, session] of created.entries()) {
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: `Catalog page ${index + 1}` },
      });
    }
    created.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const first = created[0];
    if (first === undefined) {
      throw new Error("Expected a project session.");
    }
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: first.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationCatalogPageSize]: 1,
    });
    try {
      const cursor = presentation.getState().authoritative.sessions.nextCursor;
      expect(presentation.getState().authoritative.sessions.items).toHaveLength(1);
      if (cursor === null) {
        throw new Error("Expected an opaque catalog cursor.");
      }
      await expect(
        presentation.dispatch({ type: "load_more_sessions", after: cursor }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      expect(presentation.getState().authoritative.sessions).toMatchObject({
        items: [{ id: created[0]?.sessionId }, { id: created[1]?.sessionId }],
        nextCursor: null,
      });
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects a failed catalog page inside CommandReceipt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-catalog-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets = settledModelTargets("Catalog failure answer.");
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const first = await lifecycle.create({ targetIdentity });
    const second = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: first.sessionId,
      input: { text: "Catalog failure first" },
    });
    await lifecycle.continue({
      sessionId: second.sessionId,
      input: { text: "Catalog failure second" },
    });
    const presentationLifecycle: SessionLifecycle = {
      ...lifecycle,
      async listProjectSessions(input) {
        if (input?.cursor !== undefined) {
          throw new Error("injected catalog read failure");
        }
        return lifecycle.listProjectSessions(input);
      },
    };
    const presentation = await createPresentationSession({
      lifecycle: presentationLifecycle,
      projectLabel: "workspace",
      sessionId: first.sessionId,
      stateRoot,
      workspaceRoot,
      [presentationCatalogPageSize]: 1,
    });
    try {
      const cursor = presentation.getState().authoritative.sessions.nextCursor;
      if (cursor === null) {
        throw new Error("Expected an opaque catalog cursor.");
      }
      await expect(
        presentation.dispatch({ type: "load_more_sessions", after: cursor }),
      ).resolves.toEqual({
        status: "rejected",
        code: "persistence_failed",
        message: "The project session catalog could not be read.",
      });
      expect(presentation.getState().authoritative.sessions.nextCursor).toBe(cursor);
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession admits one submit and cancellation without retrying the run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-submit-cancel-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelStarted = Promise.withResolvers<void>();
  let modelCalls = 0;
  const model: ModelDriver = {
    async *stream(request) {
      modelCalls += 1;
      modelStarted.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw request.signal.reason;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }

    await expect(
      presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Cancel this run",
        skills: [],
        thinkingSelection: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    await modelStarted.promise;
    const cancelledVisible = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.transcript.items.some(
            (item) =>
              item.type === "session_notice" &&
              item.status === "interrupted" &&
              item.reason === "cancelled",
          )
      ) {
        cancelledVisible.resolve();
      }
    });
    await expect(presentation.dispatch({ type: "cancel_run", sessionId })).resolves.toMatchObject({
      status: "admitted",
      resource: null,
    });
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cancelledVisible.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The cancelled durable settlement was never projected.")),
            5_000,
          );
        }),
      ]);
      expect(modelCalls).toBe(1);
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      unsubscribe();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession rejects submit when lifecycle admission fails before durable user input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-submit-rejected-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("target unavailable");
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "This cannot be admitted",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "rejected", code: "not_available" });
      expect(presentation.getState().authoritative.active?.transcript.items).toEqual([]);
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession binds a submit receipt to its exact durable run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-submit-run-id-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Exact run." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let durableRunId: string | undefined;
  const unsubscribe = lifecycle.subscribeSessionEvents((notification) => {
    if (notification.event.type === "user_message") {
      durableRunId = notification.runId;
    }
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      const receipt = await presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Bind this exact run",
        skills: [],
        thinkingSelection: null,
      });
      expect(receipt).toMatchObject({ status: "admitted", resource: null });
      if (receipt.status !== "admitted") {
        throw new Error("Expected an admitted submit command.");
      }
      expect(receipt.commandId).toBe(durableRunId);
    } finally {
      await presentation.close();
    }
  } finally {
    unsubscribe();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession publishes live assistant progress and replaces it with durable completion", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-live-reconcile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseCompletion = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      if (request.tools.length === 0) {
        yield { type: "text_delta", text: "Live reconciliation" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Streaming answer" };
      await releaseCompletion.promise;
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      const transientVisible = Promise.withResolvers<void>();
      const durableVisible = Promise.withResolvers<void>();
      let failureGuard: ReturnType<typeof setTimeout> | undefined;
      const failed = new Promise<never>((_resolve, reject) => {
        failureGuard = setTimeout(
          () => reject(new Error("Live Presentation reconciliation did not settle.")),
          5_000,
        );
      });
      const unsubscribe = presentation.subscribe(() => {
        const current = presentation.getState();
        if (current.transient?.assistant?.text === "Streaming answer") {
          transientVisible.resolve();
        }
        if (
          current.transient === null &&
          current.authoritative.active?.transcript.items.some(
            (item) => item.type === "assistant_message" && item.text === "Streaming answer",
          )
        ) {
          durableVisible.resolve();
        }
      });
      try {
        await expect(
          presentation.dispatch({
            type: "submit_prompt",
            sessionId,
            text: "Stream one answer",
            skills: [],
            thinkingSelection: null,
          }),
        ).resolves.toMatchObject({ status: "admitted", resource: null });
        await Promise.race([transientVisible.promise, failed]);
        releaseCompletion.resolve();
        await Promise.race([durableVisible.promise, failed]);
        expect(presentation.getState().transient).toBeNull();
      } finally {
        if (failureGuard !== undefined) {
          clearTimeout(failureGuard);
        }
        unsubscribe();
      }
    } finally {
      releaseCompletion.resolve();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession publishes cumulative provider reasoning separately from the durable answer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-live-reasoning-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseSecondDelta = Promise.withResolvers<void>();
  const releaseCompletion = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream() {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "Inspect ",
      } as const;
      await releaseSecondDelta.promise;
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "the evidence.",
      } as const;
      await releaseCompletion.promise;
      yield { type: "reasoning_end", id: "provider-reasoning-0" } as const;
      yield { type: "text_delta", text: "Verified." } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      const firstVisible = Promise.withResolvers<void>();
      const cumulativeVisible = Promise.withResolvers<void>();
      const durableVisible = Promise.withResolvers<void>();
      const unsubscribe = presentation.subscribe(() => {
        const current = presentation.getState();
        if (current.transient?.reasoning?.text === "Inspect ") {
          firstVisible.resolve();
        }
        if (current.transient?.reasoning?.text === "Inspect the evidence.") {
          cumulativeVisible.resolve();
        }
        if (
          current.transient === null &&
          current.authoritative.active?.transcript.items.some(
            (item) =>
              item.type === "reasoning_block" &&
              item.status === "completed" &&
              item.text === "Inspect the evidence.",
          )
        ) {
          durableVisible.resolve();
        }
      });
      try {
        await expect(
          presentation.dispatch({
            type: "submit_prompt",
            sessionId,
            text: "Reason, then answer",
            skills: [],
            thinkingSelection: null,
          }),
        ).resolves.toMatchObject({ status: "admitted", resource: null });
        await firstVisible.promise;
        expect(presentation.getState().transient?.reasoning).toMatchObject({
          artifactType: "provider_reasoning",
          provider: "DeepSeek",
          status: "active",
          text: "Inspect ",
        });
        releaseSecondDelta.resolve();
        await cumulativeVisible.promise;
        releaseCompletion.resolve();
        await durableVisible.promise;
        expect(
          presentation.getState().authoritative.active?.transcript.items.map((item) => item.type),
        ).toEqual(["user_message", "reasoning_block", "assistant_message"]);
      } finally {
        unsubscribe();
      }
    } finally {
      releaseSecondDelta.resolve();
      releaseCompletion.resolve();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession repairs a dropped canonical reasoning start from a cumulative snapshot", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-reasoning-start-gap-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const releaseCompletion = Promise.withResolvers<void>();
  let droppedStart = false;
  const model: ModelDriver = {
    async *stream() {
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      } as const;
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning-0",
        text: "Recovered cumulative reasoning.",
      } as const;
      await releaseCompletion.promise;
      yield { type: "reasoning_end", id: "provider-reasoning-0" } as const;
      yield { type: "text_delta", text: "Recovered answer." } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionRuntimeNotificationTransform]: {
      project(notification) {
        if (!droppedStart && notification.event.type === "model_reasoning_started") {
          droppedStart = true;
          return [];
        }
        return [notification];
      },
    },
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const recovered = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation.getState().transient?.reasoning?.text === "Recovered cumulative reasoning."
      ) {
        recovered.resolve();
      }
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "Repair reasoning start",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await recovered.promise;
      expect(droppedStart).toBe(true);
      expect(presentation.getState().transient?.reasoning).toMatchObject({
        provider: "DeepSeek",
        status: "active",
        text: "Recovered cumulative reasoning.",
      });
    } finally {
      unsubscribe();
      releaseCompletion.resolve();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession deduplicates notifications and repairs an impossible durable gap", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-gap-repair-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let injected = false;
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Gap repaired." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionRuntimeNotificationTransform]: {
      project(notification) {
        if (injected || notification.event.type !== "user_message") {
          return [notification];
        }
        injected = true;
        return [
          notification,
          notification,
          {
            ...notification,
            notificationId: `${notification.notificationId}:impossible-gap`,
            throughSequence: notification.throughSequence + 100,
          },
        ];
      },
    },
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const repairing = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    let repairingObserved = false;
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      failureGuard = setTimeout(() => {
        reject(
          new Error(
            repairingObserved
              ? "Presentation entered repair but did not return to current state."
              : "Presentation did not publish the injected repair state.",
          ),
        );
      }, 10_000);
    });
    const unsubscribe = presentation.subscribe(() => {
      const continuity = presentation.getState().authoritative.continuity;
      if (continuity.status === "repairing") {
        repairingObserved = true;
        repairing.resolve();
      } else if (repairingObserved && continuity.status === "current") {
        repaired.resolve();
      }
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "Repair one notification gap",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await Promise.race([repairing.promise, failed]);
      await Promise.race([repaired.promise, failed]);
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      unsubscribe();
      await presentation.close();
    }
    expect(presentation.getState().authoritative.continuity).toMatchObject({ status: "current" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession repairs a lower-sequence runtime notification regression", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-regression-repair-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  let injected = false;
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Regression repaired." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionRuntimeNotificationTransform]: {
      project(notification) {
        if (injected || notification.event.type !== "model_message_started") {
          return [notification];
        }
        injected = true;
        return [
          notification,
          {
            ...notification,
            notificationId: `${notification.notificationId}:regression`,
            throughSequence: Math.max(0, notification.throughSequence - 1),
          },
        ];
      },
    },
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const repairing = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const current = presentation.getState();
      if (current.authoritative.continuity.status === "repairing") {
        repairing.resolve();
      }
      if (
        injected &&
        current.authoritative.continuity.status === "current" &&
        current.authoritative.active?.transcript.items.some(
          (item) => item.type === "assistant_message" && item.text === "Regression repaired.",
        )
      ) {
        completed.resolve();
      }
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "Repair one lower notification",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await repairing.promise;
      await completed.promise;
      expect(presentation.getState().authoritative.continuity).toMatchObject({
        status: "current",
      });
    } finally {
      unsubscribe();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession recovers after one authoritative runtime refresh failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-refresh-recovery-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Recovered answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
  let failedOnce = false;

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
      [presentationRuntimeRefreshBarrier]: {
        async beforeRead(notification) {
          if (!failedOnce && notification.event.type === "user_message") {
            failedOnce = true;
            throw new Error("injected read failure");
          }
        },
      },
    });
    const degraded = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      const current = presentation.getState();
      if (current.authoritative.continuity.status === "degraded") {
        degraded.resolve();
      }
      if (
        failedOnce &&
        current.authoritative.continuity.status === "current" &&
        current.authoritative.active?.transcript.items.some(
          (item) => item.type === "assistant_message" && item.text === "Recovered answer.",
        )
      ) {
        recovered.resolve();
      }
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "Recover one failed refresh",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await degraded.promise;
      await recovered.promise;
    } finally {
      unsubscribe();
      await expect(presentation.close()).resolves.toBeUndefined();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession subscriber failures cannot poison runtime settlement or close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-subscriber-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Observer-safe answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const subscriberCalled = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      subscriberCalled.resolve();
      throw new Error("subscriber failed");
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId,
          text: "Keep observer failures isolated",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await subscriberCalled.promise;
      await expect(presentation.close()).resolves.toBeUndefined();
    } finally {
      unsubscribe();
      await presentation.close().catch(() => undefined);
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession keeps an active run bound to its source session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-session-bound-run-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const modelStarted = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      modelStarted.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw request.signal.reason;
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const source = await lifecycle.create({ targetIdentity });
    const sibling = await lifecycle.create({ targetIdentity });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: source.sessionId,
      stateRoot,
      workspaceRoot,
    });
    try {
      await expect(
        presentation.dispatch({
          type: "submit_prompt",
          sessionId: source.sessionId,
          text: "Remain bound to this session",
          skills: [],
          thinkingSelection: null,
        }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await modelStarted.promise;
      await expect(
        presentation.dispatch({ type: "select_session", sessionId: sibling.sessionId }),
      ).resolves.toMatchObject({ status: "rejected", code: "conflict" });
      await expect(
        presentation.dispatch({ type: "create_session", targetId: targetIdentity.targetId }),
      ).resolves.toMatchObject({ status: "rejected", code: "conflict" });
      expect(presentation.getState().authoritative.active?.session.id).toBe(source.sessionId);
      await expect(
        presentation.dispatch({ type: "cancel_run", sessionId: source.sessionId }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession preserves failed and output-limited run notices", async () => {
  for (const scenario of ["failed", "incomplete"] as const) {
    const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-presentation-${scenario}-notice-`));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const model: ModelDriver = {
      async *stream() {
        if (scenario === "failed") {
          throw new ModelDriverError("transport", "private provider detail", {
            cause: new Error("private cause"),
          });
        }
        yield { type: "text_delta", text: "Partial answer" };
        yield { type: "finish", reason: "length" };
      },
    };
    const modelTargets: ModelTargets = {
      async resolve() {
        return { identity: targetIdentity, driver: model, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              readiness: { status: "available", credentialSource: "deterministic test adapter" },
              contextProfile,
            },
          ],
        };
      },
    };
    const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

    try {
      const presentation = await createPresentationSession({
        lifecycle,
        projectLabel: "workspace",
        targetIdentity,
        stateRoot,
        workspaceRoot,
      });
      const noticeVisible = Promise.withResolvers<void>();
      const unsubscribe = presentation.subscribe(() => {
        if (
          presentation
            .getState()
            .authoritative.active?.transcript.items.some(
              (item) => item.type === "session_notice" && item.status === scenario,
            )
        ) {
          noticeVisible.resolve();
        }
      });
      try {
        const sessionId = presentation.getState().authoritative.active?.session.id;
        if (sessionId === undefined) {
          throw new Error("Expected an active session.");
        }
        await expect(
          presentation.dispatch({
            type: "submit_prompt",
            sessionId,
            text: `Project the ${scenario} outcome`,
            skills: [],
            thinkingSelection: null,
          }),
        ).resolves.toMatchObject({ status: "admitted", resource: null });
        await noticeVisible.promise;
        const notice = presentation
          .getState()
          .authoritative.active?.transcript.items.find(
            (item) => item.type === "session_notice" && item.status === scenario,
          );
        expect(notice).toMatchObject(
          scenario === "failed"
            ? { status: "failed", code: expect.any(String), message: expect.any(String) }
            : { status: "incomplete", reason: "output_limit" },
        );
        expect(JSON.stringify(notice)).not.toContain("private provider detail");
      } finally {
        unsubscribe();
        await presentation.close();
      }
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  }
});

test("PresentationSession preserves a bounded tool failure cause", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-tool-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const model = new FakeModelDriver((request) =>
    request.messages.at(-1)?.role === "user"
      ? [
          { type: "tool_call_start", id: "missing-read", name: "read_file" },
          {
            type: "tool_call_delta",
            id: "missing-read",
            json: '{"path":"missing.txt"}',
          },
          { type: "tool_call_end", id: "missing-read" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "The missing read was handled." },
          { type: "finish", reason: "stop" },
        ],
  );
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const failedToolVisible = Promise.withResolvers<void>();
    const unsubscribe = presentation.subscribe(() => {
      if (
        presentation
          .getState()
          .authoritative.active?.transcript.items.some(
            (item) =>
              item.type === "tool_call" &&
              item.callId === "missing-read" &&
              item.status === "failed",
          )
      ) {
        failedToolVisible.resolve();
      }
    });
    try {
      const sessionId = presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined) {
        throw new Error("Expected an active session.");
      }
      await presentation.dispatch({
        type: "submit_prompt",
        sessionId,
        text: "Read one missing file",
        skills: [],
        thinkingSelection: null,
      });
      await failedToolVisible.promise;
      expect(
        presentation
          .getState()
          .authoritative.active?.transcript.items.find(
            (item) => item.type === "tool_call" && item.callId === "missing-read",
          ),
      ).toMatchObject({
        status: "failed",
        source: {
          provenance: "provider_model_response",
          argumentsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
        durationMs: null,
        outcome: {
          status: "failed",
          code: "not_found",
          message: expect.any(String),
        },
        resultSummary: expect.stringContaining("not_found"),
      });
    } finally {
      unsubscribe();
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession exposes indeterminate tool truth without parsing summary prose", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-indeterminate-tool-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  const runId = "123e4567-e89b-42d3-a456-426614170099";
  const call = { id: "uncertain-call", name: "mcp__server__mutate", argumentsJson: "{}" };
  const argumentsDigest = `sha256:${createHash("sha256").update(call.argumentsJson).digest("hex")}`;
  const indeterminate = {
    code: "tool_effect_indeterminate" as const,
    reason: "mcp_connection_closed" as const,
    message: "The remote effect requires inspection.",
  };

  try {
    const created = await lifecycle.create({ targetIdentity });
    const store = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    });
    const genesis = (await store.read())[0];
    if (
      genesis?.schemaVersion !== 3 ||
      genesis.record.type !== "session_genesis" ||
      genesis.record.promptContext === undefined
    ) {
      throw new Error("Expected a current prompt context fixture.");
    }
    const promptMessages = assemblePromptMessagesV1(
      [{ role: "user", content: "Mutate remotely" }],
      genesis.record.promptContext,
      genesis.record.skillContext,
      new Map(),
    );
    const promptTools = genesis.record.promptContext.toolProfile.definitions.map(
      ({ definition }) => definition,
    );
    const records = [
      {
        schemaVersion: 3,
        record: { type: "logical_run_started", runId, userMessage: "Mutate remotely" },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "user_message", text: "Mutate remotely" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "provider_attempt_started",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          promptProjection: {
            version: 1,
            assemblyIdentityDigest: genesis.record.promptContext.assemblyIdentityDigest,
            requestProjectionDigest: digestPromptRequestV1(promptMessages, promptTools),
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_started" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "model_response_completed",
          runId,
          turn: 1,
          attempt: 1,
          targetIdentity,
          response: {
            text: "",
            toolCalls: [call],
            toolIntents: [
              {
                callId: call.id,
                name: call.name,
                argumentsDigest,
                effect: "network",
                definitionDigest: `sha256:${"b".repeat(64)}`,
                replay: "never",
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "model_message_completed", text: "" },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_requested", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_permission_decided",
            callId: call.id,
            name: call.name,
            decision: "allow",
            effect: "network",
            scope: "call",
            subject: {
              type: "mcp_tool",
              serverId: "server",
              originalName: "mutate",
              qualifiedName: call.name,
              serverDefinitionDigest: `sha256:${"c".repeat(64)}`,
              definitionDigest: `sha256:${"b".repeat(64)}`,
              argumentsDigest,
            },
          },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_started", callId: call.id, name: call.name },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "tool_failed", callId: call.id, name: call.name, error: indeterminate },
        },
      },
      {
        schemaVersion: 3,
        record: {
          type: "runtime_event",
          runId,
          event: { type: "session_settled", result: { status: "failed", error: indeterminate } },
        },
      },
    ] as const;
    for (const [index, record] of records.entries()) {
      await store.append({ ...record, sequence: index + 2 } as SessionRecord);
    }

    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    try {
      expect(
        presentation
          .getState()
          .authoritative.active?.transcript.items.find(
            (item) => item.type === "tool_call" && item.callId === call.id,
          ),
      ).toMatchObject({
        status: "failed",
        outcome: {
          status: "indeterminate",
          code: "tool_effect_indeterminate",
          reason: "mcp_connection_closed",
        },
      });
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession admits one exact permission decision and rejects its duplicate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-permission-command-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "allow.txt"), "allowed\n");
  let modelCalls = 0;
  const model = new FakeModelDriver((_request) => {
    modelCalls += 1;
    return modelCalls === 1
      ? [
          { type: "tool_call_start", id: "allow-read", name: "read_file" },
          { type: "tool_call_delta", id: "allow-read", json: '{"path":"allow.txt"}' },
          { type: "tool_call_end", id: "allow-read" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Allowed once." },
          { type: "finish", reason: "stop" },
        ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
    workspaceRoot,
  });
  const settled = Promise.withResolvers<void>();
  const unsubscribeLifecycle = lifecycle.subscribe((event) => {
    if (event.type === "session_settled") {
      settled.resolve();
    }
  });

  try {
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      targetIdentity,
      stateRoot,
      workspaceRoot,
    });
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) {
      throw new Error("Expected an active session.");
    }
    await presentation.dispatch({
      type: "set_session_manual_name",
      sessionId,
      name: "No automatic title",
    });
    await presentation.dispatch({
      type: "submit_prompt",
      sessionId,
      text: "Read allow.txt once",
      skills: [],
      thinkingSelection: null,
    });
    const pending = Promise.withResolvers<string>();
    const unsubscribePresentation = presentation.subscribe(() => {
      const requestId =
        presentation.getState().authoritative.active?.pendingInteractions[0]?.requestId;
      if (requestId !== undefined) {
        pending.resolve(requestId);
      }
    });
    const alreadyPending =
      presentation.getState().authoritative.active?.pendingInteractions[0]?.requestId;
    if (alreadyPending !== undefined) {
      pending.resolve(alreadyPending);
    }
    let failureGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      const requestId = await Promise.race([
        pending.promise,
        new Promise<never>((_resolve, reject) => {
          failureGuard = setTimeout(
            () => reject(new Error("The permission command fixture never became pending.")),
            5_000,
          );
        }),
      ]);
      await expect(
        presentation.dispatch({ type: "decide_permission", requestId, decision: "allow" }),
      ).resolves.toMatchObject({ status: "admitted", resource: null });
      await expect(
        presentation.dispatch({ type: "decide_permission", requestId, decision: "allow" }),
      ).resolves.toMatchObject({ status: "rejected", code: "stale_interaction" });
      await settled.promise;
      expect(modelCalls).toBe(2);
    } finally {
      if (failureGuard !== undefined) {
        clearTimeout(failureGuard);
      }
      unsubscribePresentation();
      await presentation.close();
    }
  } finally {
    unsubscribeLifecycle();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession branches at an exact boundary and activates the child", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-branch-command-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver([
    { type: "text_delta", text: "Branch source answer." },
    { type: "finish", reason: "stop" },
  ]);
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const parent = await lifecycle.create({ targetIdentity });
    await lifecycle.setSessionManualName({ sessionId: parent.sessionId, name: "Branch source" });
    await lifecycle.continue({
      sessionId: parent.sessionId,
      input: { text: "Create a branch source" },
    });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: parent.sessionId,
      stateRoot,
      workspaceRoot,
    });
    const boundary = presentation.getState().authoritative.continuity;
    if (boundary.status !== "current") {
      throw new Error("Expected a current branch boundary.");
    }

    await expect(
      presentation.dispatch({
        type: "branch_session",
        parentSessionId: parent.sessionId,
        atSequence: boundary.sessionThroughSequence,
        targetId: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    const child = presentation.getState().authoritative.active;
    expect(child?.session).toMatchObject({
      id: expect.not.stringMatching(parent.sessionId),
      naming: {
        manualName: null,
        fallbackTitle: "Branch of Branch source",
        displayLabel: "Branch of Branch source",
      },
    });
    expect(child?.transcript.items).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Branch source answer." }),
    );
    expect(presentation.getState().authoritative.sessions.items).toHaveLength(2);

    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PresentationSession branches a branch at one inherited source-aware boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-presentation-source-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const driver = new FakeModelDriver((request) => {
    const message = request.messages.findLast((candidate) => candidate.role === "user");
    const prompt = message?.content ?? "";
    return [
      {
        type: "text_delta",
        text: prompt.includes("root") ? "Root answer." : "Child-only answer.",
      },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test adapter" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    [sessionAutomaticTitlesEnabled]: false,
  });

  try {
    const root = await lifecycle.create({ targetIdentity });
    const settledRoot = await lifecycle.continue({
      sessionId: root.sessionId,
      input: { text: "Complete the root turn" },
    });
    const child = await lifecycle.branch({
      parentSessionId: root.sessionId,
      atSequence: settledRoot.snapshot.lastSequence,
    });
    await lifecycle.setSessionManualName({ sessionId: child.sessionId, name: "Active child" });
    await lifecycle.continue({
      sessionId: child.sessionId,
      input: { text: "Complete the child-only turn" },
    });
    const unrelated = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.branch({
        parentSessionId: child.sessionId,
        sourceBoundary: { sessionId: unrelated.sessionId, sequence: 1 },
      }),
    ).rejects.toMatchObject({ code: "session_branch_boundary_invalid" });
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: child.sessionId,
      stateRoot,
      workspaceRoot,
    });
    const rootAnswer = presentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "assistant_message" && item.text === "Root answer.",
      );
    if (rootAnswer?.branchBoundary === null || rootAnswer?.branchBoundary === undefined) {
      throw new Error("Expected the inherited root answer to expose a complete source boundary.");
    }

    await expect(
      presentation.dispatch({
        type: "branch_session",
        parentSessionId: child.sessionId,
        sourceBoundary: rootAnswer.branchBoundary,
        targetId: null,
      }),
    ).resolves.toMatchObject({ status: "admitted", resource: null });
    const grandchild = presentation.getState().authoritative.active;
    expect(grandchild?.session.naming).toMatchObject({
      fallbackTitle: "Branch of Active child",
      displayLabel: "Branch of Active child",
    });
    expect(grandchild?.transcript.items).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Root answer." }),
    );
    expect(grandchild?.transcript.items).not.toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Child-only answer." }),
    );
    const grandchildId = grandchild?.session.id;
    if (grandchildId === undefined) {
      throw new Error("Expected a source-aware grandchild session.");
    }
    await expect(lifecycle.inspect({ sessionId: grandchildId })).resolves.toMatchObject({
      lineage: {
        recordVersion: 2,
        parentSessionId: child.sessionId,
        sourceSessionId: root.sessionId,
        sourceEventPosition: rootAnswer.branchBoundary.sequence,
      },
    });

    await presentation.close();
    await lifecycle.close();
    const restarted = createSessionLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      [sessionAutomaticTitlesEnabled]: false,
    });
    const reopened = await createPresentationSession({
      lifecycle: restarted,
      projectLabel: "workspace",
      sessionId: grandchildId,
      stateRoot,
      workspaceRoot,
    });
    expect(reopened.getState().authoritative.active?.transcript.items).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Root answer." }),
    );
    expect(reopened.getState().authoritative.active?.transcript.items).not.toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "Child-only answer." }),
    );
    await reopened.close();
    await restarted.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
