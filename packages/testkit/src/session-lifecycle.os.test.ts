import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCodingToolRegistry,
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  SessionLifecycleError,
} from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import {
  sessionLifecycleAnswerOnlyDeepSeekStream as answerOnlyDeepSeekStream,
  sessionLifecycleBasePrompt as basePrompt,
  createSessionLifecycleForTests as createSessionLifecycle,
  sessionLifecycleSkillUsagePrompt as skillUsagePrompt,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const lifecycleOwnerFixturePath = fileURLToPath(
  new URL("../dist/session-lifecycle-owner.fixture.js", import.meta.url),
);

type ChildObservation = {
  readonly messages: unknown[];
  stderr: string;
};

const childObservations = new WeakMap<ChildProcess, ChildObservation>();

test("SessionLifecycle cold resume keeps a Direct DeepSeek v2 session on its historical profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-deepseek-v2-cold-resume-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const historicalIdentity = { ...targetIdentity, profileVersion: 2 } as const;
  const requests: unknown[] = [];
  const modelTargets = createModelTargets({
    environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(answerOnlyDeepSeekStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    },
  });
  const tools = createCodingToolRegistry({ stateRoot, workspaceRoot });
  const first = createSessionLifecycle({ modelTargets, stateRoot, tools, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

  try {
    const created = await first.create({ targetIdentity: historicalIdentity });
    await expect(
      first.continue({
        sessionId: created.sessionId,
        input: { text: "Record one historical turn." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });
    await first.close();

    cold = createSessionLifecycle({ modelTargets, stateRoot, tools, workspaceRoot });
    await expect(
      cold.continue({
        sessionId: created.sessionId,
        input: { text: "Continue the historical session." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Hello, Adam." },
      snapshot: { targetIdentity: historicalIdentity },
    });

    expect(
      requests.map((request) => {
        const body = request as {
          readonly max_tokens?: number;
          readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
          readonly model?: string;
          readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
        };
        return {
          maxTokens: body.max_tokens,
          model: body.model,
          toolNames: body.tools?.map((tool) => tool.function?.name),
          userMessages: body.messages
            ?.filter((message) => message.role === "user")
            .map((message) => message.content),
        };
      }),
    ).toEqual([
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn."],
      },
      {
        maxTokens: 384_000,
        model: "deepseek-v4-flash",
        toolNames: [
          "read_file",
          "write_file",
          "edit_file",
          "run_shell",
          "activate_skill",
          "read_skill_resource",
        ],
        userMessages: ["Record one historical turn.", "Continue the historical session."],
      },
    ]);
  } finally {
    await cold?.close();
    await first.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a competing project writer before model dispatch and takes over after owner death", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-lifecycle-owner-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const bootstrap = createSessionLifecycle({ stateRoot, workspaceRoot });
  const created = await bootstrap.create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    const inspectedWhileOwned = await bootstrap.inspect({ sessionId: created.sessionId });
    let competingModelRequests = 0;
    const contender = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          competingModelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      stateRoot,
      workspaceRoot,
    });

    const competing = contender.continue({ sessionId: created.sessionId });
    await expect(competing).rejects.toBeInstanceOf(SessionLifecycleError);
    await expect(competing).rejects.toMatchObject({ code: "project_in_use" });
    expect(inspectedWhileOwned).toEqual(
      expect.objectContaining({ sessionId: created.sessionId, status: "interrupted" }),
    );
    expect(competingModelRequests).toBe(0);

    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const takeover = await contender.resume({ sessionId: created.sessionId });

    expect({ competingModelRequests, takeover }).toEqual({
      competingModelRequests: 0,
      takeover: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 1, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process continuation preserves a completed safe read and starts a new attempt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-safe-replay-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Real restart\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createReadToolRegistry({ workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "safe-read-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "provider-started");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    const requests: unknown[] = [];
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      tools: createReadToolRegistry({ workspaceRoot }),
      workspaceRoot,
    });
    const hydrated = await lifecycle.resume({ sessionId: created.sessionId });
    const continued = await lifecycle.continue({ sessionId: created.sessionId });
    const persisted = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: created.sessionId,
    }).then((store) => store.read());

    expect({
      hydrated,
      continued,
      providerMessages: requests,
      userMessages: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "user_message",
      ).length,
      completedReads: persisted.filter(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed" &&
          record.record.event.name === "read_file",
      ).length,
    }).toEqual({
      hydrated: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "interrupted",
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 1, status: "interrupted" },
          }),
        }),
      }),
      continued: expect.objectContaining({
        result: { status: "completed", answer: "Hello, Adam." },
        snapshot: expect.objectContaining({
          run: expect.objectContaining({
            lastAttempt: { turn: 2, attempt: 2, status: "completed" },
          }),
        }),
      }),
      providerMessages: [
        expect.objectContaining({
          messages: [
            { role: "system", content: basePrompt },
            { role: "system", content: `Developer instruction:\n${skillUsagePrompt}` },
            { role: "user", content: "Read the project" },
            expect.objectContaining({ role: "assistant" }),
            expect.objectContaining({ role: "tool", tool_call_id: "read-before-crash" }),
          ],
        }),
      ],
      userMessages: 1,
      completedReads: 1,
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process restart marks a killed structured patch as indeterminate without replay", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-patch-crash-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "source.txt"), "source\n", "utf8");
  const created = await createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
  }).create({ targetIdentity });
  const owner = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_MODE: "patch-rename-then-hang",
      ADAM_AGENT_FIXTURE_SESSION_ID: created.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(owner);

  try {
    await waitForChildMessage(owner, "patch-renamed");
    owner.kill("SIGKILL");
    await waitForChildClose(owner);
    let modelRequests = 0;
    const lifecycle = createSessionLifecycle({
      modelTargets: createModelTargets({
        environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
        fetch: async () => {
          modelRequests += 1;
          return new Response(answerOnlyDeepSeekStream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          });
        },
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["write"] }),
      stateRoot,
      tools: createCodingToolRegistry({ stateRoot, workspaceRoot }),
      workspaceRoot,
    });
    const resumed = await lifecycle.resume({ sessionId: created.sessionId });

    expect({
      modelRequests,
      resumed,
      source: await readFile(join(workspaceRoot, "source.txt"), "utf8"),
      destination: await readFile(join(workspaceRoot, "destination.txt"), "utf8"),
    }).toEqual({
      modelRequests: 0,
      resumed: expect.objectContaining({
        status: "ready",
        snapshot: expect.objectContaining({
          status: "settled",
          run: expect.objectContaining({
            result: {
              status: "failed",
              error: {
                code: "tool_effect_indeterminate",
                reason: "process_restart",
                message:
                  "The edit_file effect started before restart and cannot be replayed safely.",
              },
            },
          }),
        }),
      }),
      source: "source\n",
      destination: "source\n",
    });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await waitForChildClose(owner);
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle real-process branch writes independently, survives restart, and stays project-scoped", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-session-real-branch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const otherWorkspaceRoot = join(testRoot, "other-workspace");
  await mkdir(workspaceRoot);
  await mkdir(otherWorkspaceRoot);
  const lifecycle = createSessionLifecycle({
    modelTargets: createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () =>
        new Response(answerOnlyDeepSeekStream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    }),
    stateRoot,
    workspaceRoot,
  });
  const parent = await lifecycle.create({ targetIdentity });
  const parentRun = await lifecycle.continue({
    sessionId: parent.sessionId,
    input: { text: "Create the parent boundary" },
  });
  const parentPath = join(
    stateRoot,
    "projects",
    parent.projectId.replace(/^sha256:/u, ""),
    "sessions",
    `${parent.sessionId}.jsonl`,
  );
  const parentBefore = await readFile(parentPath, "utf8");
  const branchProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
    env: {
      ...process.env,
      ADAM_AGENT_FIXTURE_AT_SEQUENCE: String(parentRun.snapshot.lastSequence),
      ADAM_AGENT_FIXTURE_MODE: "branch-child-complete",
      ADAM_AGENT_FIXTURE_SESSION_ID: parent.sessionId,
      ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
      ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observeChild(branchProcess);

  try {
    // Terminal IPC is causally published before close and must remain observable afterward.
    await waitForChildClose(branchProcess);
    const branchMessage = await waitForFixtureRecord<{
      readonly type: "branch-child-completed";
      readonly child: CurrentSessionSnapshotForFixture;
      readonly continued: { readonly result: { readonly status: string } };
    }>(branchProcess, "branch-child-completed");
    const childId = branchMessage.child.sessionId;
    const childStore = await openJsonlSessionStore<SessionRecord>({
      stateRoot,
      workspaceRoot,
      sessionId: childId,
    });
    const childRecords = await childStore.read();
    const inspectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: workspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(inspectProcess);
    const inspected = await waitForFixtureRecord<{
      readonly type: "session-inspected";
      readonly resumed: { readonly status: string; readonly snapshot: { readonly status: string } };
    }>(inspectProcess, "session-inspected");
    await waitForChildClose(inspectProcess);
    const crossProjectProcess = spawn(process.execPath, [lifecycleOwnerFixturePath], {
      env: {
        ...process.env,
        ADAM_AGENT_FIXTURE_MODE: "inspect-only",
        ADAM_AGENT_FIXTURE_SESSION_ID: childId,
        ADAM_AGENT_FIXTURE_STATE_ROOT: stateRoot,
        ADAM_AGENT_FIXTURE_WORKSPACE_ROOT: otherWorkspaceRoot,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    observeChild(crossProjectProcess);
    const crossProject = await waitForFixtureRecord<{
      readonly type: "session-inspection-failed";
      readonly code: string;
    }>(crossProjectProcess, "session-inspection-failed");
    await waitForChildClose(crossProjectProcess);

    expect({
      branchMessage,
      inspected,
      crossProject,
      parentUnchanged: (await readFile(parentPath, "utf8")) === parentBefore,
      childRecordCount: childRecords.length,
    }).toEqual({
      branchMessage: expect.objectContaining({
        child: expect.objectContaining({
          sessionId: expect.not.stringMatching(new RegExp(`^${parent.sessionId}$`, "u")),
          lineage: expect.objectContaining({
            parentSessionId: parent.sessionId,
            parentEventPosition: parentRun.snapshot.lastSequence,
          }),
        }),
        continued: expect.objectContaining({
          result: { status: "completed", answer: "Child completed." },
        }),
      }),
      inspected: expect.objectContaining({
        resumed: expect.objectContaining({
          status: "ready",
          snapshot: expect.objectContaining({ sessionId: childId, status: "settled" }),
        }),
      }),
      crossProject: { type: "session-inspection-failed", code: "session_not_found" },
      parentUnchanged: true,
      childRecordCount: 8,
    });
  } finally {
    for (const child of [branchProcess]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildClose(child);
      }
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

type CurrentSessionSnapshotForFixture = {
  readonly sessionId: string;
  readonly lineage?: {
    readonly parentSessionId: string;
    readonly parentEventPosition: number;
  };
};

function observeChild(child: ChildProcess): void {
  const observation: ChildObservation = { messages: [], stderr: "" };
  childObservations.set(child, observation);
  child.on("message", (message) => observation.messages.push(message));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    observation.stderr += chunk;
  });
}

async function waitForChildMessage(
  child: ReturnType<typeof spawn>,
  expectedMessage: string,
): Promise<void> {
  const observation = requiredChildObservation(child);
  if (observation.messages.includes(expectedMessage)) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before readiness: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedMessage}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (message === expectedMessage) {
        cleanup();
        resolve();
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
          `Child closed before readiness: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForFixtureRecord<RecordType extends { readonly type: string }>(
  child: ReturnType<typeof spawn>,
  expectedType: RecordType["type"],
): Promise<RecordType> {
  const observation = requiredChildObservation(child);
  const existing = observation.messages.find(
    (message) => isFixtureRecord(message) && message.type === expectedType,
  );
  if (isFixtureRecord(existing)) {
    return existing as RecordType;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Child closed before ${expectedType}: code=${String(child.exitCode)} signal=${String(child.signalCode)}. ${observation.stderr}`,
    );
  }
  return new Promise<RecordType>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}. stderr: ${observation.stderr}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (isFixtureRecord(message) && message.type === expectedType) {
        cleanup();
        resolve(message as RecordType);
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
          `Child closed before ${expectedType}: code=${String(code)} signal=${String(signal)}. ${observation.stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForChildClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("Timed out waiting for child closure."));
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
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function requiredChildObservation(child: ChildProcess): ChildObservation {
  const observation = childObservations.get(child);
  if (observation === undefined) {
    throw new Error("The child process was not registered with the fixture collector.");
  }
  return observation;
}

function isFixtureRecord(value: unknown): value is Record<string, unknown> & {
  readonly type?: unknown;
} {
  return typeof value === "object" && value !== null;
}
