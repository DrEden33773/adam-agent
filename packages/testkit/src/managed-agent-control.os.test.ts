import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  createSessionLifecycle,
} from "@adam-agent/agent";

import {
  createJsonlManagedAgentControlStore,
  createJsonlManagedAgentStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentControl,
  createProjectExecutionDomain,
  createProjectLifecycleOwner,
  createTrustedWorkspaceTrustForTesting,
  scoutManagedAgentProfileV1,
  sessionAutomaticTitlesEnabled,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

test("ManagedAgentStore v3 preflight preserves and backs up exact legacy bytes before first admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-preflight-"));
  const options = { workspaceRoot: directory, stateRoot: join(directory, "state") };
  try {
    const legacy = await createJsonlManagedAgentStore(options);
    await legacy.append(legacyAdmission());
    const logDirectory = join(
      options.stateRoot,
      "projects",
      createHash("sha256").update(directory).digest("hex"),
      "managed-agents",
    );
    const before = await readFile(join(logDirectory, "events-v1.jsonl"));
    const store = await createJsonlManagedAgentControlStore(options);
    await store.preflight();
    expect(await readFile(join(logDirectory, "events-v1.pre-v3.jsonl"))).toEqual(before);
    expect(await readFile(join(logDirectory, "events-v1.jsonl"))).toEqual(before);
    expect(await store.read()).toEqual([]);
    expect(await store.readLegacy()).toMatchObject([
      { type: "managed_agent_admitted", profile: "scout.v1" },
    ]);
    await writeFile(join(logDirectory, "events-v1.jsonl"), "invalid\n");
    const reopened = await createJsonlManagedAgentControlStore(options);
    await expect(reopened.preflight()).rejects.toMatchObject({ code: "managed_agent_log_invalid" });
    expect(await readFile(join(logDirectory, "events-v1.pre-v3.jsonl"))).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["provider_attempt_interrupted", "session_settled", "outcome", "settled", "completion"])(
  "ManagedAgentControl recovers a real process crash after %s without replay or duplicate completion",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), `adam-control-crash-${phase}-`));
    const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
    const fixture = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/managed-agent-control-owner.fixture.js", import.meta.url))],
      {
        env: {
          ...process.env,
          ADAM_CONTROL_FIXTURE_ROOT: directory,
          ADAM_CONTROL_FIXTURE_PHASE: phase,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const closed = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
    const ready = new Promise<{ threadId: string; turnId: string }>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.once("close", () => reject(new Error("Fixture closed before its durable barrier.")));
      fixture.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "phase" in message &&
          message.phase === phase &&
          "threadId" in message &&
          typeof message.threadId === "string" &&
          "turnId" in message &&
          typeof message.turnId === "string"
        )
          resolve({ threadId: message.threadId, turnId: message.turnId });
      });
    });
    const stateRoot = join(directory, "state");
    const domain = createProjectExecutionDomain({
      lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot: directory, stateRoot }),
    });
    const store = await createJsonlManagedAgentControlStore({
      workspaceRoot: directory,
      stateRoot,
    });
    const control = createManagedAgentControl({
      parentSessionId,
      projectId: `sha256:${createHash("sha256").update(directory).digest("hex")}`,
      workspaceRoot: directory,
      targetIdentity: {
        targetId: "deepseek-v4-flash.direct",
        vendor: "deepseek",
        modelId: "deepseek-v4-flash",
        route: "direct",
        profileVersion: 1,
        certification: "certified",
      },
      contextProfile: {
        version: 1,
        contextWindowTokens: 128_000,
        maximumOutputTokens: 4096,
        compactAtTokens: 96_000,
        postCompactTargetTokens: 32_000,
        retainedTargetTokens: 8000,
        estimatorVersion: 1,
      },
      model: {
        stream() {
          throw new Error("Settled recovery cannot resend a provider request.");
        },
      },
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      executionDomain: domain,
      store,
      childSessionStores: createJsonlSessionStoreDirectory({
        workspaceRoot: directory,
        stateRoot: join(directory, "children"),
      }),
    });
    try {
      const identity = await withManagedFailureGuard(ready, `durable ${phase} IPC`);
      const before = await store.read();
      expect((await control.inspect({ parentSessionId })).threads).toHaveLength(1);
      expect(
        await control.dispatch({
          type: "recover_turn",
          parentSessionId,
          threadId: identity.threadId,
          expectedTurnId: identity.turnId,
        }),
      ).toMatchObject({ status: "rejected", code: "authority_busy" });
      expect(await store.read()).toEqual(before);
      fixture.kill("SIGKILL");
      await withManagedFailureGuard(closed, "crashed owner close");
      const command = {
        type: "recover_turn" as const,
        parentSessionId,
        threadId: identity.threadId,
        expectedTurnId: identity.turnId,
      };
      expect(await control.dispatch(command)).toMatchObject({ status: "recovered" });
      expect(await control.dispatch(command)).toMatchObject({ status: "recovered" });
      expect(
        (await store.read()).filter((record) => record.event.type === "completion"),
      ).toHaveLength(1);
      expect((await control.inspect({ parentSessionId })).threads[0]?.turn.outcome?.summary).toBe(
        "Crash-retained evidence.",
      );
    } finally {
      fixture.kill("SIGKILL");
      await withManagedFailureGuard(closed, "fixture close");
      await control.dispatch({ type: "close", parentSessionId });
      await domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ManagedAgentControl isolates a corrupted JSONL child while another thread remains inspectable and continuable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-corruption-"));
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
  const projectKey = createHash("sha256").update(directory).digest("hex");
  const childRoot = join(directory, "children");
  const { control, domain } = await jsonlControlFixture(directory);
  const subscription = new AbortController();
  const settled = (async () => {
    for await (const frame of control.observe({ parentSessionId, signal: subscription.signal })) {
      if (
        frame.snapshot.threads.length === 2 &&
        frame.snapshot.threads.every((thread) => thread.turn.phase === "idle")
      )
        return frame.snapshot.threads;
    }
    throw new Error("Missing two settled children.");
  })();
  try {
    expect(
      await control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "First evidence.",
        description: "First evidence",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "Second evidence.",
        description: "Second evidence",
      }),
    ).toMatchObject({ status: "accepted" });
    const threads = await withManagedFailureGuard(settled, "two JSONL child settlements");
    const first = threads[0];
    const second = threads[1];
    if (first === undefined || second === undefined) throw new Error("Missing child identities.");
    await writeFile(
      join(childRoot, "projects", projectKey, "sessions", `${first.turn.childSessionId}.jsonl`),
      "corrupt\n",
    );
    const snapshot = await control.inspect({ parentSessionId });
    expect(snapshot.threads[0]?.turn).toMatchObject({
      recovery: "required",
      diagnostic: "Child history is unavailable. Inspect durable state.",
    });
    expect(snapshot.threads[1]?.turn.recovery).toBe("none");
    expect(
      await control.dispatch({
        type: "next_turn",
        parentSessionId,
        threadId: second.threadId,
        expectedTurnId: second.turn.turnId,
        task: "Continue intact evidence.",
      }),
    ).toMatchObject({ status: "accepted" });
  } finally {
    subscription.abort();
    await control.dispatch({ type: "close", parentSessionId });
    await domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function jsonlControlFixture(directory: string) {
  const stateRoot = join(directory, "state");
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
  const projectKey = createHash("sha256").update(directory).digest("hex");
  const childRoot = join(directory, "children");
  const domain = createProjectExecutionDomain({
    lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot: directory, stateRoot }),
  });
  const store = await createJsonlManagedAgentControlStore({ workspaceRoot: directory, stateRoot });
  const controlOptions = {
    parentSessionId,
    projectId: `sha256:${projectKey}` as const,
    workspaceRoot: directory,
    targetIdentity: {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct" as const,
      profileVersion: 1,
      certification: "certified" as const,
    },
    contextProfile: {
      version: 1,
      contextWindowTokens: 128_000,
      maximumOutputTokens: 4096,
      compactAtTokens: 96_000,
      postCompactTargetTokens: 32_000,
      retainedTargetTokens: 8000,
      estimatorVersion: 1 as const,
    },
    model: {
      async *stream() {
        yield { type: "text_delta" as const, text: "Retained child evidence." };
        yield { type: "finish" as const, reason: "stop" as const };
      },
    },
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store,
    childSessionStores: createJsonlSessionStoreDirectory({
      workspaceRoot: directory,
      stateRoot: childRoot,
    }),
  };
  const control = createManagedAgentControl(controlOptions);
  return { control, domain, store, controlOptions };
}

test.each(["session_genesis", "started", "tool_started"])(
  "ManagedAgentControl explicitly resumes a real process stopped at %s using its exact safe boundary",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-control-safe-recovery-"));
    await writeFile(join(directory, "evidence.txt"), "BEFORE_CRASH_READ");
    const fixture = startControlCrashFixture(directory, phase);
    const harness = await jsonlControlFixture(directory);
    const parentSessionId = harness.controlOptions.parentSessionId;
    const subscription = new AbortController();
    let calls = 0;
    const control = createManagedAgentControl({
      ...harness.controlOptions,
      model: {
        async *stream(request) {
          calls += 1;
          if (phase === "tool_started")
            expect(JSON.stringify(request.messages)).toContain("AFTER_CRASH_READ");
          yield { type: "text_delta", text: "Explicit safe recovery." };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    try {
      const identity = await withManagedFailureGuard(fixture.ready, `durable ${phase} barrier`);
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "safe recovery process close");
      await writeFile(join(directory, "evidence.txt"), "AFTER_CRASH_READ");
      expect((await control.inspect({ parentSessionId })).threads[0]?.turn.recovery).toBe(
        "required",
      );
      expect(calls).toBe(0);
      const settled = (async () => {
        for await (const frame of control.observe({
          parentSessionId,
          signal: subscription.signal,
        })) {
          if (frame.snapshot.threads[0]?.turn.phase === "idle") return frame.snapshot.threads[0];
        }
        throw new Error("Missing safe recovered settlement.");
      })();
      void settled.catch(() => undefined);
      expect(
        await control.dispatch({
          type: "recover_turn",
          parentSessionId,
          threadId: identity.threadId,
          expectedTurnId: identity.turnId,
        }),
      ).toMatchObject({ status: "accepted", turnId: identity.turnId });
      expect(
        (await withManagedFailureGuard(settled, "safe recovered settlement")).turn.outcome?.summary,
      ).toBe("Explicit safe recovery.");
      expect(calls).toBe(1);
    } finally {
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "safe fixture cleanup");
      subscription.abort();
      await control.dispatch({ type: "close", parentSessionId });
      await harness.control.dispatch({ type: "close", parentSessionId });
      await harness.domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["admitted", "session_genesis"])(
  "ManagedAgentControl cancels a pre-provider crash at %s without inventing a logical run",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-control-admitted-crash-"));
    const fixture = startControlCrashFixture(directory, phase);
    const harness = await jsonlControlFixture(directory);
    const parentSessionId = harness.controlOptions.parentSessionId;
    try {
      const identity = await withManagedFailureGuard(
        fixture.ready,
        "durable admission before genesis",
      );
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "admitted process close");
      expect(
        await harness.control.dispatch({
          type: "cancel_turn",
          parentSessionId,
          threadId: identity.threadId,
          expectedTurnId: identity.turnId,
        }),
      ).toMatchObject({ status: "cancelled", turnId: identity.turnId });
      const snapshot = await harness.control.inspect({ parentSessionId });
      expect(snapshot.threads[0]?.turn).toMatchObject({
        phase: "idle",
        recovery: "none",
        outcome: { status: "cancelled", transcript: { sequence: phase === "admitted" ? 0 : 1 } },
      });
      expect(await harness.controlOptions.childSessionStores.listSessionEntries()).toHaveLength(
        phase === "admitted" ? 0 : 1,
      );
    } finally {
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "admitted fixture cleanup");
      await harness.control.dispatch({ type: "close", parentSessionId });
      await harness.domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function startControlCrashFixture(directory: string, phase: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/managed-agent-control-owner.fixture.js", import.meta.url))],
    {
      env: {
        ...process.env,
        ADAM_CONTROL_FIXTURE_ROOT: directory,
        ADAM_CONTROL_FIXTURE_PHASE: phase,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const ready = new Promise<{ threadId: string; turnId: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => reject(new Error(`Fixture closed before ${phase}: ${stderr}`)));
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "phase" in message &&
        message.phase === phase &&
        "threadId" in message &&
        typeof message.threadId === "string" &&
        "turnId" in message &&
        typeof message.turnId === "string"
      )
        resolve({ threadId: message.threadId, turnId: message.turnId });
    });
  });
  return { process: child, closed, ready };
}

test("ManagedAgentControl never resends a durably acknowledged provider request and explicitly cancels its interrupted turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-provider-recovery-"));
  const fixture = startControlCrashFixture(directory, "provider_attempt_started");
  const harness = await jsonlControlFixture(directory);
  const parentSessionId = harness.controlOptions.parentSessionId;
  let calls = 0;
  const control = createManagedAgentControl({
    ...harness.controlOptions,
    model: {
      stream() {
        calls += 1;
        throw new Error("An acknowledged request must not be resent.");
      },
    },
  });
  try {
    const identity = await withManagedFailureGuard(fixture.ready, "acknowledged provider request");
    fixture.process.kill("SIGKILL");
    await withManagedFailureGuard(fixture.closed, "acknowledged provider process close");
    const before = await harness.store.read();
    expect(
      await control.dispatch({
        type: "recover_turn",
        parentSessionId,
        threadId: identity.threadId,
        expectedTurnId: identity.turnId,
      }),
    ).toMatchObject({ status: "rejected", code: "recovery_required" });
    expect(await harness.store.read()).toEqual(before);
    expect(
      await control.dispatch({
        type: "cancel_turn",
        parentSessionId,
        threadId: identity.threadId,
        expectedTurnId: identity.turnId,
      }),
    ).toMatchObject({ status: "cancelled", turnId: identity.turnId });
    expect((await control.inspect({ parentSessionId })).threads[0]?.turn).toMatchObject({
      phase: "idle",
      outcome: { status: "cancelled" },
    });
    expect(calls).toBe(0);
  } finally {
    fixture.process.kill("SIGKILL");
    await withManagedFailureGuard(fixture.closed, "provider fixture cleanup");
    await control.dispatch({ type: "close", parentSessionId });
    await harness.control.dispatch({ type: "close", parentSessionId });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["main_receipt", "consumed"])(
  "ManagedAgentControl reconciles a real process crash after %s from the exact Main receipt",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-control-main-receipt-"));
    const fixture = startControlCrashFixture(directory, phase);
    const harness = await jsonlControlFixture(directory);
    const parentSessionId = harness.controlOptions.parentSessionId;
    try {
      await withManagedFailureGuard(fixture.ready, `durable ${phase}`);
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "Main receipt owner close");
      const parentStore = await createJsonlSessionStoreDirectory({
        workspaceRoot: directory,
        stateRoot: join(directory, "parents"),
      }).open(parentSessionId);
      if (parentStore === undefined) throw new Error("Missing canonical Main store.");
      const before = await parentStore.read();
      const control = createManagedAgentControl({
        ...harness.controlOptions,
        parentSessionStore: parentStore,
      });
      expect(
        await control.dispatch({ type: "prepare_main_delivery", parentSessionId }),
      ).toMatchObject({ status: "delivery", messages: [], deliveries: [] });
      expect(
        await control.dispatch({ type: "prepare_main_delivery", parentSessionId }),
      ).toMatchObject({ status: "delivery", messages: [], deliveries: [] });
      expect(
        (await harness.store.read()).filter((record) => record.event.type === "consumed"),
      ).toHaveLength(1);
      expect(await parentStore.read()).toEqual(before);
      await control.dispatch({ type: "close", parentSessionId });
    } finally {
      fixture.process.kill("SIGKILL");
      await withManagedFailureGuard(fixture.closed, "Main receipt fixture cleanup");
      await harness.control.dispatch({ type: "close", parentSessionId });
      await harness.domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ManagedAgentControl exposes Fleet recovery and refuses mutation without rewriting a corrupted control journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-fleet-invalid-"));
  const { control, store, domain } = await jsonlControlFixture(directory);
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
  try {
    await store.preflight();
    const path = join(
      directory,
      "state",
      "projects",
      createHash("sha256").update(directory).digest("hex"),
      "managed-agents",
      `events-v3-${parentSessionId}.jsonl`,
    );
    await writeFile(path, "corrupt\n");
    expect(await control.inspect({ parentSessionId })).toMatchObject({
      status: "recovery_required",
      diagnostic: "Managed history is unavailable. Inspect durable state.",
    });
    expect(
      await control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "No mutation.",
        description: "No mutation",
      }),
    ).toMatchObject({ status: "rejected", code: "recovery_required" });
    expect(await readFile(path, "utf8")).toBe("corrupt\n");
  } finally {
    await control.dispatch({ type: "close", parentSessionId });
    await domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps ordinary Main conversation usable when its v3 Fleet journal is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-main-fleet-corrupt-"));
  const harness = await jsonlControlFixture(directory);
  const { targetIdentity, contextProfile, model: driver } = harness.controlOptions;
  const lifecycle = createSessionLifecycle({
    workspaceTrust: createTrustedWorkspaceTrustForTesting(directory),
    workspaceRoot: directory,
    stateRoot: join(directory, "parents"),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, contextProfile, driver };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "external fixture" },
            },
          ],
        };
      },
    },
    [sessionAutomaticTitlesEnabled]: false,
    [sessionManagedControl]: {
      store: harness.store,
      childSessionStores: harness.controlOptions.childSessionStores,
    },
  });
  try {
    const parent = await lifecycle.create({ targetIdentity });
    await harness.store.preflight();
    const path = join(
      directory,
      "state",
      "projects",
      createHash("sha256").update(directory).digest("hex"),
      "managed-agents",
      `events-v3-${parent.sessionId}.jsonl`,
    );
    await writeFile(path, "corrupt\n");
    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    expect(await control?.inspect({ parentSessionId: parent.sessionId })).toMatchObject({
      status: "recovery_required",
    });
    expect(
      (
        await lifecycle.continue({
          sessionId: parent.sessionId,
          input: { text: "Ordinary Main conversation." },
        })
      ).result.status,
    ).toBe("completed");
    expect(await readFile(path, "utf8")).toBe("corrupt\n");
  } finally {
    await lifecycle.close();
    await harness.control.dispatch({
      type: "close",
      parentSessionId: harness.controlOptions.parentSessionId,
    });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ManagedAgentStore isolates an attributable parent journal corruption from another parent under one project owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-parent-isolation-"));
  const harness = await jsonlControlFixture(directory);
  const firstParent = harness.controlOptions.parentSessionId;
  const secondParent = "123e4567-e89b-42d3-a456-426614174699";
  const second = createManagedAgentControl({
    ...harness.controlOptions,
    parentSessionId: secondParent,
  });
  const subscription = new AbortController();
  const completed = (control: typeof second, parentSessionId: string) =>
    (async () => {
      for await (const frame of control.observe({ parentSessionId, signal: subscription.signal }))
        if (frame.snapshot.completions.length > 0) return;
      throw new Error("Missing isolated parent completion.");
    })();
  const firstDone = completed(harness.control, firstParent);
  const secondDone = completed(second, secondParent);
  void firstDone.catch(() => undefined);
  void secondDone.catch(() => undefined);
  try {
    await harness.control.dispatch({
      type: "start_thread",
      parentSessionId: firstParent,
      role: "builtin:explore",
      task: "First parent.",
      description: "First parent",
    });
    await second.dispatch({
      type: "start_thread",
      parentSessionId: secondParent,
      role: "builtin:explore",
      task: "Second parent.",
      description: "Second parent",
    });
    await withManagedFailureGuard(Promise.all([firstDone, secondDone]), "both parent completions");
    const logDirectory = join(
      directory,
      "state",
      "projects",
      createHash("sha256").update(directory).digest("hex"),
      "managed-agents",
    );
    const paths = (await readdir(logDirectory)).filter(
      (name) => name.startsWith("events-v3") && name.endsWith(".jsonl"),
    );
    let corrupted = false;
    for (const name of paths) {
      const path = join(logDirectory, name);
      const contents = await readFile(path, "utf8");
      if (!contents.includes(firstParent)) continue;
      await writeFile(path, contents.replace('"role":"builtin:explore"', '"role":"invalid:role"'));
      corrupted = true;
      break;
    }
    expect(corrupted).toBe(true);
    expect(await harness.control.inspect({ parentSessionId: firstParent })).toMatchObject({
      status: "recovery_required",
    });
    expect(await second.inspect({ parentSessionId: secondParent })).toMatchObject({
      status: "ready",
    });
    expect(
      await second.dispatch({
        type: "start_thread",
        parentSessionId: secondParent,
        role: "builtin:explore",
        task: "Continue unaffected parent.",
        description: "Unaffected parent",
      }),
    ).toMatchObject({ status: "accepted" });
  } finally {
    subscription.abort();
    await second.dispatch({ type: "close", parentSessionId: secondParent });
    await harness.control.dispatch({ type: "close", parentSessionId: firstParent });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function legacyAdmission(
  parentSessionId = "123e4567-e89b-42d3-a456-426614174601",
): Extract<
  import("@adam-agent/agent/internal-testing").ManagedAgentRecord,
  { type: "managed_agent_admitted" }
> {
  return {
    schemaVersion: 1,
    sequence: 1,
    type: "managed_agent_admitted",
    agentId: "123e4567-e89b-42d3-a456-426614174602",
    attemptId: "123e4567-e89b-42d3-a456-426614174603",
    childSessionId: "123e4567-e89b-42d3-a456-426614174604",
    parentSessionId,
    parentToolCallId: "legacy-spawn",
    parentRootId: "project-runtime",
    projectId: `sha256:${"d".repeat(64)}`,
    profile: "scout.v1",
    profileDigest: scoutManagedAgentProfileV1.digest,
    limits: { maximumTokens: 128_000, maximumTurns: 8, maximumDeadlineMilliseconds: 600_000 },
    admittedAtUnixMilliseconds: 1_900_000_000_000,
    taskDigest: `sha256:${"a".repeat(64)}`,
    childInputDigest: `sha256:${"b".repeat(64)}`,
    targetIdentity: {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct",
      profileVersion: 1,
      certification: "certified",
    },
  };
}

test("PresentationSession keeps missing historical child evidence inspection-only without legacy writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-legacy-view-"));
  const harness = await jsonlControlFixture(directory);
  const { targetIdentity, contextProfile, model: driver } = harness.controlOptions;
  const modelTargets = {
    async resolve() {
      return { identity: targetIdentity, contextProfile, driver };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            contextProfile,
            readiness: { status: "available" as const, credentialSource: "external fixture" },
          },
        ],
      };
    },
  };
  const options = {
    workspaceRoot: directory,
    stateRoot: join(directory, "parents"),
    workspaceTrust: createTrustedWorkspaceTrustForTesting(directory),
    modelTargets,
    tools: createReadToolRegistry({ workspaceRoot: directory }),
    [sessionAutomaticTitlesEnabled]: false,
  };
  const old = createSessionLifecycle({
    ...options,
    managedAgentTools: "managed-agent-tools.a1.v1",
  });
  const parent = await old.create({ targetIdentity });
  await old.close();
  const legacy = await createJsonlManagedAgentStore({
    workspaceRoot: directory,
    stateRoot: join(directory, "state"),
  });
  const admission = {
    ...legacyAdmission(parent.sessionId),
    parentRootId: `session:${parent.sessionId}`,
    projectId: parent.projectId as `sha256:${string}`,
    mode: "foreground" as const,
    deadlineAtUnixMilliseconds: 1_900_000_600_000,
  };
  await legacy.append(admission);
  const before = await legacy.read();
  const lifecycle = createSessionLifecycle({
    ...options,
    [sessionManagedControl]: {
      store: harness.store,
      childSessionStores: harness.controlOptions.childSessionStores,
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot: directory,
      stateRoot: options.stateRoot,
      projectLabel: "Legacy history",
      sessionId: parent.sessionId,
    });
    const historicalChildren = createJsonlSessionStoreDirectory({
      workspaceRoot: directory,
      stateRoot: join(options.stateRoot, "managed-child-sessions"),
    });
    expect(await historicalChildren.open(admission.childSessionId)).toBeUndefined();
    const agent = presentation.getState().authoritative.managedAgents.agents[0];
    expect(agent).toMatchObject({
      agentId: admission.agentId,
      profile: "scout.v1",
      status: "inspection_required",
      readOnly: true,
      error: { code: "managed_agent_inspection_required" },
    });
    if (agent === undefined) throw new Error("Missing legacy projection.");
    expect(agent.result).toBeUndefined();
    expect(
      await presentation.dispatch({
        type: "cancel_managed_agent",
        sessionId: parent.sessionId,
        agentId: agent.agentId,
        expectedRevision: agent.revision,
      }),
    ).toMatchObject({ status: "rejected", code: "action_unavailable" });
    expect(await legacy.read()).toEqual(before);
    expect(await harness.store.read()).toEqual([]);
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await harness.control.dispatch({
      type: "close",
      parentSessionId: harness.controlOptions.parentSessionId,
    });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["outcome", "settled"])(
  "ManagedAgentControl recovers a pre-genesis cancellation crash after %s with its empty transcript receipt",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-control-empty-cancel-"));
    const admitted = startControlCrashFixture(directory, "admitted");
    const harness = await jsonlControlFixture(directory);
    const parentSessionId = harness.controlOptions.parentSessionId;
    let cancelled: ReturnType<typeof startControlCrashFixture> | undefined;
    try {
      const identity = await withManagedFailureGuard(admitted.ready, "empty child admission");
      admitted.process.kill("SIGKILL");
      await withManagedFailureGuard(admitted.closed, "empty admission process close");
      cancelled = startControlCrashFixture(directory, `cancel_${phase}`);
      await withManagedFailureGuard(cancelled.ready, `cancelled ${phase}`);
      cancelled.process.kill("SIGKILL");
      await withManagedFailureGuard(cancelled.closed, "cancelled process close");
      expect(
        await harness.control.dispatch({
          type: "recover_turn",
          parentSessionId,
          threadId: identity.threadId,
          expectedTurnId: identity.turnId,
        }),
      ).toMatchObject({ status: "recovered" });
      expect(
        (await harness.store.read()).filter((record) => record.event.type === "completion"),
      ).toHaveLength(1);
      expect(await harness.controlOptions.childSessionStores.listSessionEntries()).toEqual([]);
    } finally {
      admitted.process.kill("SIGKILL");
      cancelled?.process.kill("SIGKILL");
      await withManagedFailureGuard(admitted.closed, "first cancellation fixture close");
      if (cancelled !== undefined)
        await withManagedFailureGuard(cancelled.closed, "second cancellation fixture close");
      await harness.control.dispatch({ type: "close", parentSessionId });
      await harness.domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ManagedAgentControl preserves durable stall classification and partial output after child terminal but before outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-stalled-terminal-"));
  const fixture = startControlCrashFixture(directory, "stalled_terminal");
  const harness = await jsonlControlFixture(directory);
  const parentSessionId = harness.controlOptions.parentSessionId;
  try {
    const identity = await withManagedFailureGuard(fixture.ready, "stalled child terminal receipt");
    fixture.process.kill("SIGKILL");
    await withManagedFailureGuard(fixture.closed, "stalled owner close");
    expect(
      await harness.control.dispatch({
        type: "recover_turn",
        parentSessionId,
        threadId: identity.threadId,
        expectedTurnId: identity.turnId,
      }),
    ).toMatchObject({ status: "recovered" });
    expect(
      (await harness.control.inspect({ parentSessionId })).threads[0]?.turn.outcome,
    ).toMatchObject({
      status: "failed",
      error: { code: "managed_agent_stalled" },
      summary: "Partial crash evidence.",
    });
  } finally {
    fixture.process.kill("SIGKILL");
    await withManagedFailureGuard(fixture.closed, "stall fixture cleanup");
    await harness.control.dispatch({ type: "close", parentSessionId });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ManagedAgentControl publishes a reset when child filesystem setup fails after durable admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-control-setup-failure-"));
  const harness = await jsonlControlFixture(directory);
  const parentSessionId = harness.controlOptions.parentSessionId;
  await writeFile(join(directory, "children"), "not a directory");
  const subscription = new AbortController();
  const reset = (async () => {
    for await (const frame of harness.control.observe({
      parentSessionId,
      signal: subscription.signal,
    })) {
      if (frame.type === "reset" && frame.snapshot.threads[0]?.turn.recovery === "required")
        return frame;
    }
    throw new Error("Missing setup failure reset.");
  })();
  void reset.catch(() => undefined);
  try {
    expect(
      await harness.control.dispatch({
        type: "start_thread",
        parentSessionId,
        role: "builtin:explore",
        task: "Cannot open child store.",
        description: "Setup failure",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(await harness.control.dispatch({ type: "close", parentSessionId })).toMatchObject({
      status: "rejected",
      code: "recovery_required",
    });
    expect(
      (await withManagedFailureGuard(reset, "failure reset at unchanged control revision")).snapshot
        .threads[0]?.turn,
    ).toMatchObject({ phase: "waiting", recovery: "required" });
  } finally {
    subscription.abort();
    await harness.control.dispatch({ type: "close", parentSessionId });
    await harness.domain.close();
    await rm(directory, { recursive: true, force: true });
  }
});
