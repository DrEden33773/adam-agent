import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCodingToolRegistry,
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelRequest,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createInMemoryManagedAgentStore,
  createJsonlManagedAgentStore,
  createTrustedWorkspaceTrustForTesting,
  ManagedAgentStoreError,
  recoverInterruptedManagedAgents,
  researchManagedAgentProfileV1,
  scoutManagedAgentProfileV1,
  scoutManagedAgentProfileV2,
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
const durableTask = "Persist one durable scout result.";
const childLiveWorkspaceNotice =
  "This child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.";

const contextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8_000,
  estimatorVersion: 1,
} as const;

test("PresentationSession recovers one exact managed attempt after a JSONL restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-presentation-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const skillRoot = join(workspaceRoot, ".agents", "skills", "cold-research-guide");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: cold-research-guide\ndescription: Preserves exact cold managed research guidance.\n---\nCOLD_RESEARCH_SKILL_BODY\n",
    "utf8",
  );
  const endpoint = "https://search.example.test/search";
  let childCalls = 0;
  let parentCalls = 0;
  let recoveredRequest: ModelRequest | undefined;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose !== "ordinary") {
        yield { type: "text_delta", text: "Managed restart" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      const child = request.messages.some(
        (message) =>
          message.role === "developer" &&
          message.content.startsWith("Managed child profile research.v2"),
      );
      if (child) {
        childCalls += 1;
        if (childCalls === 1) {
          throw new Error("injected interrupted child");
        }
        recoveredRequest = request;
        yield { type: "text_delta", text: "Cold managed recovery completed." };
        yield { type: "usage", inputTokens: 6, outputTokens: 3 };
        yield { type: "finish", reason: "stop" };
        return;
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        yield { type: "tool_call_start", id: "spawn-cold-recovery", name: "spawn_agent" };
        yield {
          type: "tool_call_delta",
          id: "spawn-cold-recovery",
          json: '{"task":"Create one cold recovery boundary.","profile":"research.v2","skills":["skill:v1:project:.:cold-research-guide"],"mode":"background"}',
        };
        yield { type: "tool_call_end", id: "spawn-cold-recovery" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Managed child started." };
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
  const createLifecycle = () =>
    createSessionLifecycle({
      managedAgentTools: "managed-agent-tools.a3-long-lived.v2",
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      stateRoot,
      tools: createCodingToolRegistry({ workspaceRoot }),
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
              activation: {
                protocol: "searxng-json.v1",
                endpointDigest: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`,
              },
            },
            diagnostic: null,
          };
        },
      },
      workspaceRoot,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    });
  const warmLifecycle = createLifecycle();

  try {
    const created = await warmLifecycle.create({ targetIdentity });
    const warmPresentation = await createPresentationSession({
      lifecycle: warmLifecycle,
      projectLabel: "managed-restart-warm",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    const recoveryRequired = Promise.withResolvers<void>();
    const unsubscribeWarm = warmPresentation.subscribe(() => {
      if (
        warmPresentation
          .getState()
          .authoritative.managedAgents.agents.some((agent) => agent.phase === "terminal")
      ) {
        recoveryRequired.resolve();
      }
    });
    await warmPresentation.dispatch({
      type: "submit_prompt",
      sessionId: created.sessionId,
      text: "Start one interrupted managed child.",
      skills: [],
      thinkingSelection: null,
    });
    await withManagedFailureGuard(
      recoveryRequired.promise,
      "The warm managed recovery-required state was never published.",
    );
    unsubscribeWarm();
    const warmAgent = warmPresentation.getState().authoritative.managedAgents.agents[0];
    if (warmAgent === undefined) {
      throw new Error("The warm managed child was unavailable.");
    }
    expect(warmAgent.status).toBe("recovery_required");
    await warmPresentation.close();
    await warmLifecycle.close();

    const coldLifecycle = createLifecycle();
    try {
      const coldPresentation = await createPresentationSession({
        lifecycle: coldLifecycle,
        projectLabel: "managed-restart-cold",
        sessionId: created.sessionId,
        stateRoot,
        workspaceRoot,
      });
      try {
        const coldAgent = coldPresentation.getState().authoritative.managedAgents.agents[0];
        expect(coldAgent).toMatchObject({
          agentId: warmAgent.agentId,
          status: "recovery_required",
          attemptHistory: [expect.objectContaining({ status: "recovery_required" })],
        });
        if (coldAgent === undefined) {
          throw new Error("The cold managed child was unavailable.");
        }
        const recovered = Promise.withResolvers<void>();
        const unsubscribeCold = coldPresentation.subscribe(() => {
          const agent = coldPresentation.getState().authoritative.managedAgents.agents[0];
          if (agent?.phase === "terminal" && agent.attemptHistory.length === 2) {
            recovered.resolve();
          }
        });
        await expect(
          coldPresentation.dispatch({
            type: "recover_managed_agent",
            sessionId: created.sessionId,
            agentId: coldAgent.agentId,
            expectedRevision: coldAgent.revision,
            task: "Recover the exact interrupted child.",
          }),
        ).resolves.toMatchObject({
          status: "admitted",
          managedAgentControl: {
            action: "recovery",
            agentId: coldAgent.agentId,
          },
        });
        await withManagedFailureGuard(
          recovered.promise,
          "The cold managed recovery never reached terminal state.",
        );
        unsubscribeCold();
        expect(coldPresentation.getState().authoritative.managedAgents).toMatchObject({
          counts: { active: 0, terminal: 1, attention: 0 },
          agents: [
            {
              agentId: coldAgent.agentId,
              status: "completed",
              attemptHistory: [
                expect.objectContaining({ status: "recovery_required", current: false }),
                expect.objectContaining({ status: "completed", current: true }),
              ],
            },
          ],
        });
        expect(parentCalls).toBe(2);
        expect(childCalls).toBe(2);
        expect(recoveredRequest?.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["read_skill_resource", "web_search"]),
        );
        expect(JSON.stringify(recoveredRequest?.messages)).toContain("COLD_RESEARCH_SKILL_BODY");
      } finally {
        await coldPresentation.close();
      }
    } finally {
      await coldLifecycle.close();
    }
  } finally {
    await warmLifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore preserves one admitted and terminal identity across JSONL reopen", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-jsonl-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const records = managedStoreRecords();

  try {
    const memory = createInMemoryManagedAgentStore();
    const warm = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    for (const record of records) {
      await memory.append(record);
      await warm.append(record);
    }
    const cold = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });

    await expect(memory.read()).resolves.toEqual(records);
    await expect(cold.read()).resolves.toEqual(records);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore reopens A2 background cancel and repeated-attempt truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-a2-jsonl-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const records = managedA2StoreRecords();

  try {
    const store = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    for (const record of records) {
      await store.append(record);
    }
    const cold = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await expect(cold.read()).resolves.toEqual(records);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore reopens A3 mailbox, report, attention and exact reply truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-a3-jsonl-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const records = managedA3StoreRecords();

  try {
    const warm = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    for (const record of records) {
      await warm.append(record);
    }
    const cold = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await expect(cold.read()).resolves.toEqual(records);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore reopens current capacity and stall-resume truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-current-jsonl-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const records = managedCurrentStoreRecords();

  try {
    const warm = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    for (const record of records) {
      await warm.append(record);
    }
    const cold = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await expect(cold.read()).resolves.toEqual(records);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore folds a cold A2 background admission without provider replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-a2-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const admission = managedA2StoreRecords()[0];

  try {
    const warm = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await warm.append(admission);
    const cold = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await recoverInterruptedManagedAgents(cold);
    await expect(cold.read()).resolves.toMatchObject([
      { type: "managed_agent_admitted", mode: "background" },
      { type: "managed_agent_terminal", status: "recovery_required" },
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("ManagedAgentStore rejects a torn JSONL tail without truncation or replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-torn-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const store = await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    await store.append(managedStoreRecords()[0] as ReturnType<typeof managedStoreRecords>[number]);
    const logPath = await managedAgentLogPath(stateRoot, workspaceRoot);
    const before = `${JSON.stringify(managedStoreRecords()[0])}\n`;
    await writeFile(logPath, `${before}{"torn":true}`, "utf8");

    await expect(createJsonlManagedAgentStore({ stateRoot, workspaceRoot })).rejects.toEqual(
      new ManagedAgentStoreError("managed_agent_log_invalid"),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    caseName: "empty target identity",
    mutation: { targetIdentity: { ...targetIdentity, targetId: "" } },
  },
  { caseName: "malformed digest", mutation: { taskDigest: "sha256:not-a-digest" } },
])("ManagedAgentStore rejects restored authority with $caseName", async ({ mutation }) => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-managed-store-authority-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    await createJsonlManagedAgentStore({ stateRoot, workspaceRoot });
    const malformed = { ...managedStoreRecords()[0], ...mutation };
    await writeFile(
      await managedAgentLogPath(stateRoot, workspaceRoot),
      `${JSON.stringify(malformed)}\n`,
      "utf8",
    );

    await expect(createJsonlManagedAgentStore({ stateRoot, workspaceRoot })).rejects.toEqual(
      new ManagedAgentStoreError("managed_agent_log_invalid"),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function managedAgentLogPath(stateRoot: string, workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  const projectKey = createHash("sha256").update(canonicalRoot).digest("hex");
  return join(stateRoot, "projects", projectKey, "managed-agents", "events-v1.jsonl");
}

function managedCurrentStoreRecords() {
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
  const agentId = "123e4567-e89b-42d3-a456-426614174602";
  const attemptId = "123e4567-e89b-42d3-a456-426614174603";
  const childSessionId = "123e4567-e89b-42d3-a456-426614174604";
  return [
    {
      schemaVersion: 1 as const,
      type: "managed_agent_admitted" as const,
      sequence: 1,
      agentId,
      attemptId,
      childSessionId,
      parentSessionId,
      parentToolCallId: "current-jsonl-spawn",
      parentRootId: `session:${parentSessionId}`,
      projectId,
      profile: "scout.v2" as const,
      mode: "background" as const,
      profileDigest: scoutManagedAgentProfileV2.digest,
      usageAccountingVersion: 2 as const,
      effectiveToolProfileDigest: `sha256:${"e".repeat(64)}` as const,
      limits: {
        maximumTokens: 1_000_000,
        maximumInactivityMilliseconds: 300_000,
      },
      admittedAtUnixMilliseconds: 1_900_000_000_000,
      taskDigest: sha256("Current JSONL task."),
      childInputDigest: sha256(`Current JSONL task.\n\n${childLiveWorkspaceNotice}`),
      targetIdentity,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_stalled" as const,
      sequence: 2,
      agentId,
      attemptId,
      childSessionId,
      maximumInactivityMilliseconds: 300_000 as const,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_resumed" as const,
      sequence: 3,
      agentId,
      attemptId,
      childSessionId,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_terminal" as const,
      sequence: 4,
      agentId,
      attemptId,
      childSessionId,
      status: "completed" as const,
      result: { text: "Current JSONL result." },
      transcriptDigest: `sha256:${"f".repeat(64)}` as const,
      throughSequence: 5,
      usage: { inputTokens: 10, outputTokens: 3, reasoningTokens: 2 },
      providerCalls: 1,
      cost: { status: "unavailable" as const },
    },
  ];
}

function managedStoreRecords() {
  return [
    {
      schemaVersion: 1 as const,
      type: "managed_agent_admitted" as const,
      sequence: 1,
      agentId: "123e4567-e89b-42d3-a456-426614174101",
      attemptId: "123e4567-e89b-42d3-a456-426614174102",
      childSessionId: "123e4567-e89b-42d3-a456-426614174103",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174104",
      parentToolCallId: "spawn-store-contract",
      parentRootId: "parent-session",
      projectId,
      profile: "scout.v1" as const,
      profileDigest: scoutManagedAgentProfileV1.digest,
      limits: managedLimits,
      taskDigest: `sha256:${createHash("sha256").update(durableTask).digest("hex")}` as const,
      childInputDigest: `sha256:${createHash("sha256")
        .update(`${durableTask}\n\n${childLiveWorkspaceNotice}`)
        .digest("hex")}` as const,
      targetIdentity,
      thinkingPolicy,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_terminal" as const,
      sequence: 2,
      agentId: "123e4567-e89b-42d3-a456-426614174101",
      attemptId: "123e4567-e89b-42d3-a456-426614174102",
      childSessionId: "123e4567-e89b-42d3-a456-426614174103",
      status: "completed" as const,
      result: { text: "Durable scout result." },
      transcriptDigest: `sha256:${"c".repeat(64)}` as const,
      throughSequence: 9,
      usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
      cost: { status: "unavailable" as const },
    },
  ] as const;
}

function managedA2StoreRecords() {
  const first = {
    ...managedStoreRecords()[0],
    mode: "background" as const,
    parentRootId: "session:123e4567-e89b-42d3-a456-426614174104",
    deadlineAtUnixMilliseconds: 1_900_000_000_000,
    admittedAtUnixMilliseconds: 1_899_999_400_000,
  };
  return [
    first,
    {
      schemaVersion: 1 as const,
      type: "managed_agent_cancel_requested" as const,
      sequence: 2,
      agentId: first.agentId,
      attemptId: first.attemptId,
      childSessionId: first.childSessionId,
      expectedRevision: 1,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_terminal" as const,
      sequence: 3,
      agentId: first.agentId,
      attemptId: first.attemptId,
      childSessionId: first.childSessionId,
      status: "cancelled" as const,
      reason: "caller" as const,
      transcriptDigest: `sha256:${"e".repeat(64)}` as const,
      throughSequence: 5,
    },
    {
      ...first,
      sequence: 4,
      attemptId: "123e4567-e89b-42d3-a456-426614174105",
      childSessionId: "123e4567-e89b-42d3-a456-426614174106",
      parentToolCallId: "follow-up-store-contract",
      limits: {
        ...managedLimits,
        maximumTokens: 127_500,
        maximumDeadlineMilliseconds: 590_000,
      },
      admittedAtUnixMilliseconds: 1_899_999_410_000,
      resume: {
        sourceAttemptId: first.attemptId,
        sourceChildSessionId: first.childSessionId,
        sourceTranscriptDigest:
          `sha256:${createHash("sha256").update("[]").digest("hex")}` as const,
        replayMessagesDigest: `sha256:${createHash("sha256").update("[]").digest("hex")}` as const,
        throughSequence: 0,
      },
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_terminal" as const,
      sequence: 5,
      agentId: first.agentId,
      attemptId: "123e4567-e89b-42d3-a456-426614174105",
      childSessionId: "123e4567-e89b-42d3-a456-426614174106",
      status: "recovery_required" as const,
      recoveryPhase: "pre_genesis" as const,
      error: {
        code: "managed_agent_recovery_required" as const,
        message:
          "The child process ended without a causally proven terminal result. Adam did not replay the interrupted model request.",
      },
    },
  ] as const;
}

function managedA3StoreRecords() {
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174304";
  const agentId = "123e4567-e89b-42d3-a456-426614174301";
  const attemptId = "123e4567-e89b-42d3-a456-426614174302";
  const childSessionId = "123e4567-e89b-42d3-a456-426614174303";
  const sourceRunId = "123e4567-e89b-42d3-a456-426614174306";
  const parentRootId = `session:${parentSessionId}`;
  const parentMessage = "Inspect the exact durable source.";
  const parentArgumentsDigest = sha256(
    JSON.stringify({ agentId, expectedRevision: 1, message: parentMessage }),
  );
  const parentMessageId = sha256(
    JSON.stringify({
      parentRootId,
      parentSessionId,
      attemptId,
      callId: "send-a3-message",
      toolName: "send_agent_message",
      argumentsDigest: parentArgumentsDigest,
    }),
  );
  const reportArgumentsDigest = sha256(
    JSON.stringify({ kind: "finding", message: "Durable finding." }),
  );
  const reportId = sha256(
    JSON.stringify({
      parentRootId,
      sourceSessionId: childSessionId,
      sourceAttemptId: attemptId,
      sourceToolCallId: "report-a3-finding",
      sourceRunId,
      sourceTurn: 1,
      sourceProviderAttempt: 1,
      toolName: "report_to_parent",
      argumentsDigest: reportArgumentsDigest,
    }),
  );
  const question = "Which source should I prioritize?";
  const attentionArgumentsDigest = sha256(JSON.stringify({ question }));
  const attentionEffectId = sha256(
    JSON.stringify({
      parentRootId,
      sourceSessionId: childSessionId,
      sourceAttemptId: attemptId,
      sourceToolCallId: "request-a3-input",
      sourceRunId,
      sourceTurn: 1,
      sourceProviderAttempt: 1,
      toolName: "request_parent_input",
      argumentsDigest: attentionArgumentsDigest,
    }),
  );
  const attentionId = "123e4567-e89b-42d3-a456-426614174305";
  const replyMessage = "Prioritize the immutable receipt.";
  const replyArgumentsDigest = sha256(
    JSON.stringify({
      agentId,
      expectedRevision: 5,
      message: replyMessage,
      attentionId,
    }),
  );
  const replyMessageId = sha256(
    JSON.stringify({
      parentRootId,
      parentSessionId,
      attemptId,
      callId: "reply-a3-attention",
      toolName: "send_agent_message",
      argumentsDigest: replyArgumentsDigest,
    }),
  );
  return [
    {
      schemaVersion: 1 as const,
      type: "managed_agent_admitted" as const,
      sequence: 1,
      agentId,
      attemptId,
      childSessionId,
      parentSessionId,
      parentToolCallId: "spawn-a3-research",
      parentRootId,
      projectId,
      profile: "research.v1" as const,
      mode: "background" as const,
      profileDigest: researchManagedAgentProfileV1.digest,
      effectiveToolProfileDigest: sha256("a3-effective-tools"),
      limits: managedLimits,
      deadlineAtUnixMilliseconds: 1_900_000_000_000,
      admittedAtUnixMilliseconds: 1_899_999_400_000,
      taskDigest: sha256("A3 durable coordination."),
      childInputDigest: sha256(`A3 durable coordination.\n\n${childLiveWorkspaceNotice}`),
      targetIdentity,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_parent_message_enqueued" as const,
      sequence: 2,
      agentId,
      attemptId,
      childSessionId,
      messageId: parentMessageId,
      parentToolCallId: "send-a3-message",
      expectedRevision: 1,
      argumentsDigest: parentArgumentsDigest,
      message: parentMessage,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_parent_message_delivered" as const,
      sequence: 3,
      agentId,
      attemptId,
      childSessionId,
      messageId: parentMessageId,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_child_reported" as const,
      sequence: 4,
      agentId,
      attemptId,
      childSessionId,
      reportId,
      childToolCallId: "report-a3-finding",
      sourceRunId,
      sourceTurn: 1,
      sourceProviderAttempt: 1,
      argumentsDigest: reportArgumentsDigest,
      kind: "finding" as const,
      message: "Durable finding.",
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_attention_requested" as const,
      sequence: 5,
      agentId,
      attemptId,
      childSessionId,
      attentionId,
      effectId: attentionEffectId,
      childToolCallId: "request-a3-input",
      sourceRunId,
      sourceTurn: 1,
      sourceProviderAttempt: 1,
      argumentsDigest: attentionArgumentsDigest,
      question,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_parent_reply_enqueued" as const,
      sequence: 6,
      agentId,
      attemptId,
      childSessionId,
      attentionId,
      messageId: replyMessageId,
      parentToolCallId: "reply-a3-attention",
      expectedRevision: 5,
      argumentsDigest: replyArgumentsDigest,
      message: replyMessage,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_parent_reply_delivered" as const,
      sequence: 7,
      agentId,
      attemptId,
      childSessionId,
      attentionId,
      messageId: replyMessageId,
    },
    {
      schemaVersion: 1 as const,
      type: "managed_agent_terminal" as const,
      sequence: 8,
      agentId,
      attemptId,
      childSessionId,
      status: "cancelled" as const,
      reason: "caller" as const,
      transcriptDigest: sha256("a3-child-transcript"),
      throughSequence: 12,
    },
  ] as const;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
