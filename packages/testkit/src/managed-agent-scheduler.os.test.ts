import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileArtifactStore, createPermissionPolicy } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createJsonlManagedAgentControlStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentControl,
  createProjectExecutionDomain,
  createProjectLifecycleOwner,
  type SessionRecord,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";

const parentSessionId = "123e4567-e89b-42d3-a456-426614174601";
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
  contextWindowTokens: 128000,
  maximumOutputTokens: 4096,
  compactAtTokens: 96000,
  postCompactTargetTokens: 32000,
  retainedTargetTokens: 8000,
  estimatorVersion: 1,
} as const;

test.each([
  "scheduler_batch",
  "scheduler_interrupt",
  "scheduler_settled",
  "scheduler_started",
  "scheduler_outcome_input",
  "scheduler_delivery",
  "scheduler_unknown",
])(
  "real owner crash at %s retains current Registry, input receipts and writer fencing",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-scheduler-crash-"));
    await writeFile(join(directory, "evidence.txt"), "Exact file evidence.");
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
    let stderr = "";
    fixture.stderr?.setEncoding("utf8");
    fixture.stderr?.on("data", (text: string) => {
      stderr += text;
    });
    const closed = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
    const barrier = new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.once("close", () => reject(new Error(`Fixture closed before ${phase}: ${stderr}`)));
      fixture.on("message", (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "phase" in value &&
          value.phase === phase
        )
          resolve();
      });
    });
    const stateRoot = join(directory, "state");
    const store = await createJsonlManagedAgentControlStore({
      workspaceRoot: directory,
      stateRoot,
    });
    const domain = createProjectExecutionDomain({
      lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot: directory, stateRoot }),
    });
    let calls = 0;
    let resumedMessages: unknown;
    const control = createManagedAgentControl({
      parentSessionId,
      projectId: `sha256:${createHash("sha256").update(directory).digest("hex")}`,
      workspaceRoot: directory,
      targetIdentity,
      contextProfile,
      model: {
        async *stream(request) {
          resumedMessages = request.messages;
          calls++;
          yield { type: "text_delta", text: "Explicit resumed evidence." };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "finish", reason: "stop" };
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
      await withManagedFailureGuard(barrier, `durable ${phase} receipt`);
      const before = await store.read();
      const admission = before.find((record) => record.event.type === "admitted");
      if (admission === undefined) throw new Error("No durable admission");
      if (phase === "scheduler_unknown") {
        expect(
          await control.dispatch({
            type: "cancel_agents",
            parentSessionId,
            targets: [{ threadId: admission.threadId, expectedTurnId: admission.turnId }],
          }),
        ).toMatchObject({ status: "rejected", code: "authority_busy" });
        expect(await store.read()).toEqual(before);
        const reservation = before.find((record) => record.event.type === "provider_reserved");
        if (reservation?.event.type !== "provider_reserved") throw new Error("No reservation");
        await expect(
          control.settleUsage({
            requestId: reservation.event.requestId,
            inputTokens: 20,
            outputTokens: 10,
            reasoningTokens: 0,
          }),
        ).rejects.toMatchObject({ code: "project_in_use" });
        expect(await store.read()).toEqual(before);
      }
      fixture.kill("SIGKILL");
      await withManagedFailureGuard(closed, "crashed owner release");
      const target = {
        parentSessionId,
        threadId: admission.threadId,
        expectedTurnId: admission.turnId,
      };
      if (phase === "scheduler_batch") {
        expect(before.filter((record) => record.event.type === "admitted")).toHaveLength(32);
        const path = join(
          stateRoot,
          "projects",
          createHash("sha256").update(directory).digest("hex"),
          "managed-agents",
          `events-v3-${parentSessionId}.jsonl`,
        );
        const prefix = `${JSON.stringify(admission)}\n`;
        await writeFile(path, prefix);
        expect((await control.inspect({ parentSessionId })).status).toBe("recovery_required");
        expect(await control.dispatch({ type: "recover_turn", ...target })).toMatchObject({
          status: "rejected",
          code: "recovery_required",
        });
        expect(await readFile(path, "utf8")).toBe(prefix);
        expect(calls).toBe(0);
      } else if (phase === "scheduler_settled") {
        expect(
          (await control.inspect({ parentSessionId })).storage?.reservedTerminalBytes,
        ).toBeGreaterThan(0);
        expect(await control.dispatch({ type: "recover_turn", ...target })).toMatchObject({
          status: "recovered",
        });
        expect((await control.inspect({ parentSessionId })).storage?.reservedTerminalBytes).toBe(0);
        expect(calls).toBe(0);
      } else if (phase === "scheduler_interrupt") {
        expect(await control.dispatch({ type: "recover_turn", ...target })).toMatchObject({
          status: "accepted",
        });
        expect(
          await withManagedFailureGuard(
            control.dispatch({
              type: "wait_agents",
              parentSessionId,
              targets: [{ threadId: admission.threadId, expectedTurnId: admission.turnId }],
              mode: "all",
            }),
            "resumed interrupt receipt",
          ),
        ).toMatchObject({ status: "completed" });
        expect(JSON.stringify(resumedMessages)).toContain("Retain this exact input receipt.");
        expect(calls).toBe(1);
        expect((await control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
          { status: "delivered" },
        ]);
      } else if (phase === "scheduler_started") {
        expect(await control.dispatch({ type: "recover_turn", ...target })).toMatchObject({
          status: "accepted",
          turnId: admission.turnId,
        });
        expect(
          await withManagedFailureGuard(
            control.dispatch({
              type: "wait_agents",
              parentSessionId,
              targets: [{ threadId: admission.threadId, expectedTurnId: admission.turnId }],
              mode: "all",
            }),
            "resumed completion",
          ),
        ).toMatchObject({ status: "completed" });
        expect(calls).toBe(1);
      } else if (phase === "scheduler_outcome_input") {
        expect(await control.dispatch({ type: "recover_turn", ...target })).toMatchObject({
          status: "recovered",
        });
        expect((await control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
          { status: "undelivered", reason: "settled" },
        ]);
        expect(calls).toBe(0);
      } else if (phase === "scheduler_delivery") {
        expect(await control.dispatch({ type: "cancel_turn", ...target })).toMatchObject({
          status: "cancelled",
        });
        expect((await control.inspect({ parentSessionId })).threads[0]?.inputs).toMatchObject([
          { status: "delivered" },
        ]);
        expect(calls).toBe(0);
      }
    } finally {
      fixture.kill("SIGKILL");
      await closed;
      await control.dispatch({ type: "close", parentSessionId });
      await domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["stop", "length"] as const)(
  "large child %s output remains inspectable through an immutable artifact and cold settlement",
  async (finish) => {
    const directory = await mkdtemp(join(tmpdir(), "adam-managed-artifact-"));
    const stateRoot = join(directory, "state");
    const artifactStore = await createFileArtifactStore({ root: join(directory, "artifacts") });
    const domain = createProjectExecutionDomain({
      lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot: directory, stateRoot }),
    });
    const root = await domain.claimRoot({ rootId: "project-runtime" });
    const store = await createJsonlManagedAgentControlStore({
      workspaceRoot: directory,
      stateRoot,
    });
    const children = createJsonlSessionStoreDirectory({
      workspaceRoot: directory,
      stateRoot: join(directory, "children"),
    });
    const output = "Evidence 中文\n".repeat(24000);
    const control = createManagedAgentControl({
      parentSessionId,
      projectId: `sha256:${createHash("sha256").update(directory).digest("hex")}`,
      workspaceRoot: directory,
      targetIdentity,
      contextProfile,
      artifactStore,
      model: {
        async *stream() {
          yield { type: "text_delta", text: output };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: finish };
        },
      },
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      executionDomain: domain,
      store,
      childSessionStores: children,
    });
    try {
      const result = await withManagedFailureGuard(
        control.dispatch({
          type: "spawn_agents",
          parentSessionId,
          mode: "foreground",
          entries: [
            {
              role: "builtin:explore",
              task: "Return bounded large evidence.",
              description: "Large evidence",
            },
          ],
        }),
        "artifact-backed settled result",
      );
      expect(result).toMatchObject({
        status: "completed",
        results: [
          {
            outcome: {
              status: finish === "stop" ? "completed" : "failed",
              artifact: { byteCount: Buffer.byteLength(output) },
            },
          },
        ],
      });
      if (result.status !== "completed" || result.results[0]?.outcome.artifact === undefined)
        throw new Error("No output artifact");
      expect(
        Buffer.from(
          (await artifactStore.read(result.results[0].outcome.artifact.id)) ?? [],
        ).toString("utf8"),
      ).toBe(output);
      expect(Buffer.byteLength(result.results[0].outcome.summary)).toBeLessThanOrEqual(16 * 1024);
      expect((await control.inspect({ parentSessionId })).threads[0]?.turn.recovery).toBe("none");
      await control.dispatch({ type: "close", parentSessionId });
      const persisted = await store.read();
      const outcome = persisted.find((record) => record.event.type === "outcome");
      if (outcome === undefined) throw new Error("No outcome boundary");
      const path = join(
        stateRoot,
        "projects",
        createHash("sha256").update(directory).digest("hex"),
        "managed-agents",
        `events-v3-${parentSessionId}.jsonl`,
      );
      await writeFile(
        path,
        persisted
          .filter((record) => record.sequence < outcome.sequence)
          .map((record) => `${JSON.stringify(record)}\n`)
          .join(""),
      );
      const cold = createManagedAgentControl({
        parentSessionId,
        projectId: `sha256:${createHash("sha256").update(directory).digest("hex")}`,
        workspaceRoot: directory,
        targetIdentity,
        contextProfile,
        artifactStore,
        model: {
          stream() {
            throw new Error("Cold terminal materialization must not dispatch a provider.");
          },
        },
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        executionDomain: domain,
        store,
        childSessionStores: children,
      });
      try {
        expect(
          await cold.dispatch({
            type: "recover_turn",
            parentSessionId,
            threadId: outcome.threadId,
            expectedTurnId: outcome.turnId,
          }),
        ).toMatchObject({ status: "recovered" });
        expect((await cold.inspect({ parentSessionId })).completions[0]?.outcome).toMatchObject({
          status: finish === "stop" ? "completed" : "failed",
          summary: result.results[0].outcome.summary,
          artifact: result.results[0].outcome.artifact,
        });
      } finally {
        await cold.dispatch({ type: "close", parentSessionId });
      }
    } finally {
      await control.dispatch({ type: "close", parentSessionId });
      await root.release();
      await domain.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Lifecycle freezes reloaded repository instructions in the child genesis without rewriting ordinary genesis rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-managed-context-"));
  await writeFile(join(directory, "AGENTS.md"), "Original root context.\n");
  const h = createInMemorySessionLifecycleHarness();
  const store = createInMemoryManagedAgentControlStore();
  let prompt = "";
  const driver = {
    async *stream(request: import("@adam-agent/agent").ModelRequest) {
      prompt = JSON.stringify(request.messages);
      yield { type: "text_delta" as const, text: "Frozen instructions." };
      yield { type: "usage" as const, inputTokens: 20, outputTokens: 10 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const lifecycle = h.createLifecycle({
    workspaceRoot: directory,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "fixture" },
            },
          ],
        };
      },
    },
    [sessionManagedControl]: {
      store,
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  try {
    const parent = await lifecycle.create({ targetIdentity });
    await writeFile(join(directory, "AGENTS.md"), "Reloaded exact parent instructions.\n");
    await lifecycle.reloadRepositoryInstructions({ sessionId: parent.sessionId });
    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("No current control");
    expect(
      await withManagedFailureGuard(
        control.dispatch({
          type: "spawn_agents",
          parentSessionId: parent.sessionId,
          mode: "foreground",
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect with exact parent instructions.",
              description: "Frozen parent",
            },
          ],
        }),
        "reloaded child settlement",
      ),
    ).toMatchObject({ status: "completed", results: [{ outcome: { status: "completed" } }] });
    expect(prompt).toContain("Reloaded exact parent instructions.");
    const admission = (await store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      frozen: { promptContext: { repository: { revision: 2 } } },
    });
  } finally {
    await lifecycle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Lifecycle refuses switching away from an unreadable Fleet with an active provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-fleet-transition-"));
  const stateRoot = join(directory, "state");
  const store = await createJsonlManagedAgentControlStore({ workspaceRoot: directory, stateRoot });
  const h = createInMemorySessionLifecycleHarness();
  const started = Promise.withResolvers<void>();
  const driver: import("@adam-agent/agent").ModelDriver = {
    async *stream(request) {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const lifecycle = h.createLifecycle({
    workspaceRoot: directory,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "fixture" },
            },
          ],
        };
      },
    },
    [sessionManagedControl]: {
      store,
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  let journal: string | undefined;
  let original = "";
  try {
    const a = await lifecycle.create({ targetIdentity });
    const control = await lifecycle[sessionManagedControl](a.sessionId);
    if (control === undefined) throw new Error("No source Control");
    await control.dispatch({
      type: "spawn_agents",
      parentSessionId: a.sessionId,
      entries: [{ role: "builtin:explore", task: "Hold source execution.", description: "Source" }],
    });
    await withManagedFailureGuard(started.promise, "source provider start");
    journal = join(
      stateRoot,
      "projects",
      createHash("sha256").update(directory).digest("hex"),
      "managed-agents",
      `events-v3-${a.sessionId}.jsonl`,
    );
    original = await readFile(journal, "utf8");
    await writeFile(journal, `${original}{invalid}\n`);
    expect(await control.inspect({ parentSessionId: a.sessionId })).toMatchObject({
      status: "recovery_required",
    });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "session_managed_transition_required",
    });
    await writeFile(journal, original);
    journal = undefined;
    expect(
      await control.dispatch({
        type: "spawn_agents",
        parentSessionId: a.sessionId,
        entries: [{ role: "builtin:explore", task: "Still source family.", description: "Source" }],
      }),
    ).toMatchObject({ status: "admitted" });
  } finally {
    if (journal !== undefined) await writeFile(journal, original);
    await lifecycle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("large frozen child genesis is budgeted before atomic admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adam-managed-context-"));
  await writeFile(join(directory, "AGENTS.md"), "Context. ".repeat(1500));
  const h = createInMemorySessionLifecycleHarness();
  const store = createInMemoryManagedAgentControlStore();
  let prompt = "";
  const driver = {
    async *stream(request: import("@adam-agent/agent").ModelRequest) {
      prompt = JSON.stringify(request.messages);
      yield { type: "text_delta" as const, text: "Frozen instructions." };
      yield { type: "usage" as const, inputTokens: 20, outputTokens: 10 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const lifecycle = h.createLifecycle({
    workspaceRoot: directory,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    modelTargets: {
      async resolve() {
        return { identity: targetIdentity, driver, contextProfile };
      },
      async snapshot() {
        return {
          targets: [
            {
              identity: targetIdentity,
              contextProfile,
              readiness: { status: "available", credentialSource: "fixture" },
            },
          ],
        };
      },
    },
    [sessionManagedControl]: {
      store,
      policy: {
        version: 1,
        background: { running: 4, queued: 32 },
        reserved: { running: 1, queued: 4 },
        maximumAttempts: 4,
        threadTokens: 128000,
        batchTokens: 512000,
        sessionTokens: 2048000,
        storageBytes: 352000,
      },
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
    },
  });
  try {
    const parent = await lifecycle.create({ targetIdentity });

    const control = await lifecycle[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("No current control");
    expect(
      await withManagedFailureGuard(
        control.dispatch({
          type: "spawn_agents",
          parentSessionId: parent.sessionId,
          mode: "foreground",
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect with exact parent instructions.",
              description: "Frozen parent",
            },
          ],
        }),
        "reloaded child settlement",
      ),
    ).toMatchObject({ status: "rejected", code: "storage_quota_exceeded" });
    expect(await store.read()).toEqual([]);
    expect(prompt).toBe("");
  } finally {
    await lifecycle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
