import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemoryManagedAgentStore,
  createJsonlManagedAgentStore,
  ManagedAgentStoreError,
  recoverInterruptedManagedAgents,
  scoutManagedAgentProfileV1,
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
