import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCodingToolRegistry,
  createReadToolRegistry,
  createSessionLifecycle,
  type ModelTargetIdentity,
} from "@adam-agent/agent";
import {
  openJsonlSessionStore,
  type SessionContextCompactionCommittedRecord,
  type SessionContextCompactionInterruptedRecord,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

const fixturePath = fileURLToPath(
  new URL("../dist/context-compaction.fixture.js", import.meta.url),
);
const targetIdentity: ModelTargetIdentity = {
  targetId: "fake.local",
  vendor: "adam",
  modelId: "fake",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

type FixtureObservation = {
  readonly messages: unknown[];
  stderr: string;
};

const fixtureObservations = new WeakMap<ChildProcess, FixtureObservation>();

test("real process restart continues a dangling compaction as attempt two", async () => {
  const harness = await createProcessHarness("adam-agent-context-started-process-");
  const first = spawnFixture(harness, "started-hang");

  try {
    await waitForMessage(first, "compaction-started");
    first.kill("SIGKILL");
    await waitForClose(first);

    const second = spawnFixture(harness, "started-continue");
    const completed = await waitForMessage(second, "context-continued");
    await waitForClose(second);
    expect(completed).toMatchObject({
      ordinaryCall: 1,
      compactionCall: 1,
      continued: {
        result: { status: "completed", answer: "Continued after interrupted compaction." },
        snapshot: {
          context: {
            checkpoint: { status: "committed", windowNumber: 1 },
            lastAttempt: { status: "committed", attemptNumber: 2 },
          },
        },
      },
    });
    const records = await readRecords(harness);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_interrupted",
      ) as readonly SessionContextCompactionInterruptedRecord[],
    ).toMatchObject([{ record: { reason: "process_restart", usage: { status: "unknown" } } }]);
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process restart fails closed when dangling compaction usage meets maxTokens", async () => {
  const harness = await createProcessHarness("adam-agent-context-started-budget-process-");
  const first = spawnFixture(harness, "started-hang-budget");

  try {
    await waitForMessage(first, "compaction-started");
    first.kill("SIGKILL");
    await waitForClose(first);

    const second = spawnFixture(harness, "started-budget-continue");
    const completed = await waitForMessage(second, "context-continued");
    await waitForClose(second);
    expect(completed).toMatchObject({
      ordinaryCall: 0,
      compactionCall: 0,
      continued: {
        result: {
          status: "failed",
          error: { code: "token_usage_missing" },
        },
      },
    });
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process restart counts the interrupted call before reactive recovery", async () => {
  const harness = await createProcessHarness("adam-agent-context-started-overflow-process-");
  const first = spawnFixture(harness, "started-hang");

  try {
    await waitForMessage(first, "compaction-started");
    first.kill("SIGKILL");
    await waitForClose(first);

    const second = spawnFixture(harness, "started-continue-overflow");
    const completed = await waitForMessage(second, "context-continued");
    await waitForClose(second);
    expect(completed).toMatchObject({
      ordinaryCall: 1,
      compactionCall: 1,
      continued: {
        result: {
          status: "failed",
          error: { code: "context_window_unrecoverable" },
        },
      },
    });
    expect(
      (await readRecords(harness)).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_started",
      ),
    ).toHaveLength(2);
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process restart uses a committed checkpoint without duplicating it", async () => {
  const harness = await createProcessHarness("adam-agent-context-committed-process-");
  const first = spawnFixture(harness, "committed-event-hang");

  try {
    await waitForMessage(first, "checkpoint-committed-before-swap");
    first.kill("SIGKILL");
    await waitForClose(first);

    const second = spawnFixture(harness, "committed-continue");
    const [observed, completed] = await Promise.all([
      waitForMessage(second, "checkpoint-request-observed"),
      waitForMessage(second, "context-continued"),
    ]);
    await waitForClose(second);
    expect(observed).toMatchObject({ hasSummary: true, hasRawBulk: false });
    expect(completed).toMatchObject({
      compactionCall: 0,
      continued: {
        result: { status: "completed", answer: "Continued from committed checkpoint." },
      },
    });
    const commits = (await readRecords(harness)).filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as readonly SessionContextCompactionCommittedRecord[];
    expect(commits).toHaveLength(1);
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process restart preserves a pre-effect repository activation without rereading disk", async () => {
  const harness = await createProcessHarness("adam-agent-repository-activation-process-");
  await mkdir(join(harness.workspaceRoot, "nested"), { recursive: true });
  await writeFile(join(harness.workspaceRoot, "nested", "AGENTS.md"), "Process nested rule.\n");
  await writeFile(join(harness.workspaceRoot, "nested", "fact.txt"), "process nested fact\n");
  const first = spawnFixture(harness, "repository-activation-hang");

  try {
    await expect(waitForMessage(first, "repository-activation-committed")).resolves.toMatchObject({
      revision: 2,
    });
    first.kill("SIGKILL");
    await waitForClose(first);
    await rm(join(harness.workspaceRoot, "nested", "AGENTS.md"));

    const second = spawnFixture(harness, "repository-activation-continue");
    const [observed, completed] = await Promise.all([
      waitForMessage(second, "repository-request-observed"),
      waitForMessage(second, "context-continued"),
    ]);
    await waitForClose(second);
    expect(observed).toMatchObject({ hasFrozenRule: true, hasReadResult: true });
    expect(completed).toMatchObject({
      continued: {
        result: { status: "completed", answer: "Repository activation recovered." },
        snapshot: { promptContext: { repository: { revision: 2 } } },
      },
    });
    const records = await readRecords(harness);
    expect(
      records.filter(
        (record) => record.schemaVersion === 3 && record.record.type === "path_context_committed",
      ),
    ).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed" &&
          record.record.event.callId === "read-process-context",
      ),
    ).toHaveLength(1);
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process restart and prefix branch replay frozen Skill activation and resource bytes without source access", async () => {
  const harness = await createSkillProcessHarness();
  const first = spawnFixture(harness, "skill-activation-hang");

  try {
    await expect(
      waitForMessage(first, "skill-request-observed-before-resource"),
    ).resolves.toMatchObject({
      hasSkillBody: true,
    });
    await expect(waitForMessage(first, "skill-state-observed-before-crash")).resolves.toMatchObject(
      {
        hasSkillBody: true,
        hasResource: true,
      },
    );
    first.kill("SIGKILL");
    await waitForClose(first);
    await rm(join(harness.workspaceRoot, ".agents", "skills", "process-skill"), {
      recursive: true,
      force: true,
    });

    const second = spawnFixture(harness, "skill-activation-continue");
    const [restartObserved, restarted] = await Promise.all([
      waitForMessage(second, "skill-restart-request-observed"),
      waitForMessage(second, "context-continued"),
    ]);
    await waitForClose(second);
    expect(restartObserved).toMatchObject({ hasSkillBody: true, hasResource: true });
    expect(restarted).toMatchObject({
      ordinaryCall: 1,
      continued: {
        result: { status: "completed", answer: "Skill activation and resource recovered." },
        snapshot: {
          skillContext: {
            active: [
              {
                qualifiedId: "skill:v1:project:.:process-skill",
                reason: "user_explicit",
              },
            ],
          },
        },
      },
    });

    const parentRecords = await readRecords(harness);
    expect(
      parentRecords.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "skill_activation_batch_committed",
      ),
    ).toHaveLength(1);
    expect(
      parentRecords.filter(
        (record) => record.schemaVersion === 3 && record.record.type === "skill_activated",
      ),
    ).toHaveLength(1);
    expect(
      parentRecords.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "skill_resource_read_committed",
      ),
    ).toHaveLength(1);

    const parentTail = parentRecords.at(-1)?.sequence;
    expect(parentTail).toBeTypeOf("number");
    const branchProcess = spawnFixture(harness, "skill-branch", {
      ADAM_AGENT_FIXTURE_AT_SEQUENCE: String(parentTail),
    });
    const [branchObserved, branched] = await Promise.all([
      waitForMessage(branchProcess, "skill-branch-request-observed"),
      waitForMessage(branchProcess, "skill-branched"),
    ]);
    await waitForClose(branchProcess);
    expect(branchObserved).toMatchObject({ hasSkillBody: true, hasResource: true });
    expect(branched).toMatchObject({
      ordinaryCall: 1,
      continued: {
        result: { status: "completed", answer: "Skill branch inherited frozen context." },
      },
    });

    const inspector = spawnFixture(harness, "inspect-only");
    const inspected = await waitForMessage(inspector, "context-inspected");
    await waitForClose(inspector);
    expect(inspected).toMatchObject({
      inspected: {
        skillContext: {
          active: [{ qualifiedId: "skill:v1:project:.:process-skill" }],
        },
      },
    });
    expect(JSON.stringify(inspected)).not.toContain("PROCESS_SKILL_BODY");
    expect(JSON.stringify(inspected)).not.toContain("PROCESS_SKILL_RESOURCE");
  } finally {
    first.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process performs one reactive compaction and one ordinary retry", async () => {
  const harness = await createProcessHarness("adam-agent-context-reactive-process-");
  const child = spawnFixture(harness, "reactive-complete");

  try {
    // Terminal IPC is causally published before close and must remain observable afterward.
    await waitForClose(child);
    const completed = await waitForMessage(child, "context-continued");
    expect(completed).toMatchObject({
      ordinaryCall: 2,
      compactionCall: 1,
      continued: {
        result: { status: "completed", answer: "Reactive process compaction completed." },
      },
    });
    const records = await readRecords(harness);
    expect(
      records.filter(
        (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
      ),
    ).toMatchObject([{ record: { turn: 1, attempt: 1 } }, { record: { turn: 1, attempt: 2 } }]);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
      ),
    ).toMatchObject([{ record: { trigger: "provider_overflow" } }]);
    expect(
      records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ),
    ).toHaveLength(1);
  } finally {
    child.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test("real process branches from the first of two parent checkpoints", async () => {
  const harness = await createProcessHarness("adam-agent-context-branch-process-");
  const parentProcess = spawnFixture(harness, "two-compactions-complete");

  try {
    const parentCompleted = await waitForMessage(parentProcess, "context-continued");
    await waitForClose(parentProcess);
    expect(parentCompleted).toMatchObject({
      ordinaryCall: 3,
      compactionCall: 2,
      continued: {
        result: { status: "completed", answer: "Two process compactions completed." },
      },
    });
    const parentRecordsBefore = await readRecords(harness);
    const commits = parentRecordsBefore.filter(
      (record) =>
        record.schemaVersion === 3 && record.record.type === "context_compaction_committed",
    ) as readonly SessionContextCompactionCommittedRecord[];
    expect(commits).toHaveLength(2);
    expect(commits[1]?.record).toMatchObject({
      windowNumber: 2,
      previousCheckpointSequence: commits[0]?.sequence,
    });

    const branchProcess = spawnFixture(harness, "branch-first-checkpoint", {
      ADAM_AGENT_FIXTURE_AT_SEQUENCE: String(commits[0]?.sequence),
    });
    const branched = await waitForMessage(branchProcess, "context-branched");
    await waitForClose(branchProcess);
    expect(branched).toMatchObject({
      ordinaryCall: 1,
      compactionCall: 0,
      child: {
        lineage: {
          parentSessionId: harness.sessionId,
          parentEventPosition: commits[0]?.sequence,
        },
        context: { checkpoint: { windowNumber: 1 } },
      },
      continued: {
        result: { status: "completed", answer: "Branch continued from the first checkpoint." },
      },
    });
    const parentInspector = spawnFixture(harness, "inspect-only");
    const parentRestarted = await waitForMessage(parentInspector, "context-inspected");
    await waitForClose(parentInspector);
    const childSessionId = String(
      (Reflect.get(branched, "child") as { sessionId: string }).sessionId,
    );
    const childInspector = spawnFixture(
      {
        ...harness,
        sessionId: childSessionId,
      },
      "inspect-only",
    );
    const childRestarted = await waitForMessage(childInspector, "context-inspected");
    await waitForClose(childInspector);
    expect({ parentRestarted, childRestarted }).toMatchObject({
      parentRestarted: {
        inspected: {
          context: {
            checkpoint: { windowNumber: 2, status: "committed" },
            ordinaryUsage: { inputTokens: 155, outputTokens: 30, unknownCalls: 0 },
            compactionUsage: { inputTokens: 1_040, outputTokens: 40, unknownCalls: 0 },
          },
        },
      },
      childRestarted: {
        inspected: {
          context: {
            checkpoint: { windowNumber: 1, status: "committed" },
            ordinaryUsage: { inputTokens: 30, outputTokens: 10, unknownCalls: 0 },
            compactionUsage: { inputTokens: 520, outputTokens: 20, unknownCalls: 0 },
          },
        },
      },
    });
    expect(await readRecords(harness)).toEqual(parentRecordsBefore);
  } finally {
    parentProcess.kill("SIGKILL");
    await harness.cleanup();
  }
}, 20_000);

test.each([
  "malformed-commit",
  "source-digest",
  "replacement-digest",
  "checkpoint-lineage",
  "torn-line",
] as const)(
  "real process rejects %s corruption without changing session bytes",
  async (corruption) => {
    const harness = await createProcessHarness(`adam-agent-context-${corruption}-process-`);
    const writer = spawnFixture(harness, "two-compactions-complete");

    try {
      await waitForMessage(writer, "context-continued");
      await waitForClose(writer);
      const sessionPath = await findSessionPath(harness.stateRoot);
      const valid = await readFile(sessionPath, "utf8");
      const corrupted = corruptContextSession(valid, corruption);
      expect(corrupted).not.toBe(valid);
      await writeFile(sessionPath, corrupted, "utf8");

      const inspector = spawnFixture(harness, "inspect-only");
      const failed = await waitForMessage(inspector, "context-inspection-failed");
      await waitForClose(inspector);
      expect(failed).toMatchObject({
        code:
          corruption === "torn-line" || corruption === "malformed-commit"
            ? "session_log_invalid"
            : "session_invalid",
      });
      expect(await readFile(sessionPath, "utf8")).toBe(corrupted);
    } finally {
      writer.kill("SIGKILL");
      await harness.cleanup();
    }
  },
  20_000,
);

function corruptContextSession(
  valid: string,
  corruption:
    | "malformed-commit"
    | "source-digest"
    | "replacement-digest"
    | "checkpoint-lineage"
    | "torn-line",
): string {
  if (corruption === "torn-line") {
    return valid.slice(0, -1);
  }
  let commitNumber = 0;
  const lines = valid.slice(0, -1).split("\n");
  const corrupted = lines.map((line) => {
    if (!line.includes('"type":"context_compaction_committed"')) {
      return line;
    }
    commitNumber += 1;
    if (corruption === "malformed-commit" && commitNumber === 1) {
      return line.replace('"recordVersion":1', '"recordVersion":2');
    }
    if (corruption === "source-digest" && commitNumber === 1) {
      return line.replace(
        /"sourceDigest":"sha256:[0-9a-f]{64}"/u,
        `"sourceDigest":"sha256:${"0".repeat(64)}"`,
      );
    }
    if (corruption === "replacement-digest" && commitNumber === 1) {
      return line.replace(
        /"replacementDigest":"sha256:[0-9a-f]{64}"/u,
        `"replacementDigest":"sha256:${"0".repeat(64)}"`,
      );
    }
    if (corruption === "checkpoint-lineage" && commitNumber === 2) {
      return line.replace(/"previousCheckpointSequence":\d+/u, '"previousCheckpointSequence":1');
    }
    return line;
  });
  return `${corrupted.join("\n")}\n`;
}

async function createProcessHarness(prefix: string): Promise<{
  readonly testRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly cleanup: () => Promise<void>;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), prefix));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "context.txt"),
    `${"process context line\n".repeat(500)}PROCESS_RAW_CONTEXT_TAIL`,
    "utf8",
  );
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
  }).create({ targetIdentity });
  return {
    testRoot,
    stateRoot,
    workspaceRoot,
    sessionId: created.sessionId,
    cleanup: () => rm(testRoot, { recursive: true, force: true }),
  };
}

async function createSkillProcessHarness(): Promise<{
  readonly testRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly cleanup: () => Promise<void>;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-skill-replay-process-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "process-skill");
  await mkdir(join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: process-skill\ndescription: Exercises frozen Skill restart evidence.\n---\nPROCESS_SKILL_BODY\n",
    "utf8",
  );
  await writeFile(
    join(skillDirectory, "references", "process.txt"),
    "PROCESS_SKILL_RESOURCE\n",
    "utf8",
  );
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
  }).create({ targetIdentity });
  return {
    testRoot,
    stateRoot,
    workspaceRoot,
    sessionId: created.sessionId,
    cleanup: () => rm(testRoot, { recursive: true, force: true }),
  };
}

function spawnFixture(
  harness: {
    readonly stateRoot: string;
    readonly workspaceRoot: string;
    readonly sessionId: string;
  },
  mode: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): ChildProcess {
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: mode,
      ADAM_AGENT_FIXTURE_SESSION_ID: harness.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: harness.stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: harness.workspaceRoot,
      ...extraEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const observation: FixtureObservation = { messages: [], stderr: "" };
  fixtureObservations.set(child, observation);
  child.on("message", (message) => observation.messages.push(message));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    observation.stderr += chunk;
  });
  return child;
}

async function readRecords(harness: {
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
}): Promise<readonly SessionRecord[]> {
  return (
    await openJsonlSessionStore<SessionRecord>({
      stateRoot: harness.stateRoot,
      workspaceRoot: harness.workspaceRoot,
      sessionId: harness.sessionId,
    })
  ).read();
}

async function findSessionPath(stateRoot: string): Promise<string> {
  const paths = await readdir(stateRoot, { recursive: true });
  const relativePath = paths.find((path) => path.endsWith(".jsonl"));
  if (relativePath === undefined) {
    throw new Error("The context session JSONL file was not found.");
  }
  return join(stateRoot, relativePath);
}

async function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  const observation = fixtureObservations.get(child);
  if (observation === undefined) {
    throw new Error("The child process was not registered with the fixture collector.");
  }
  const existing = observation.messages.find(
    (message) => isFixtureMessage(message) && message.type === type,
  );
  if (isFixtureMessage(existing)) {
    return existing;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Process closed before ${type}: code=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${observation.stderr}`,
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${type}. stderr=${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (isFixtureMessage(message) && message.type === type) {
        cleanup();
        resolve(message as Record<string, unknown>);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Process closed before ${type}: code=${String(code)} signal=${String(signal)} stderr=${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
      child.off("message", onMessage);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("Timed out waiting for child process closure."));
    }, 10_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(guard);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function isFixtureMessage(value: unknown): value is Record<string, unknown> & {
  readonly type?: unknown;
} {
  return typeof value === "object" && value !== null;
}
