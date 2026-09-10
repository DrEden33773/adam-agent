import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDriver } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test("archive refuses an owned Main run without stopping or changing the selected session", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-archive-owner-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let aborted = false;
  const driver: ModelDriver = {
    async *stream(request) {
      started.resolve();
      await release.promise;
      aborted = request.signal.aborted;
      yield { type: "finish", reason: "stop" };
    },
  };
  const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
    workspaceRoot: root,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
  });
  let run: ReturnType<typeof lifecycle.continue> | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    run = lifecycle.continue({ sessionId: session.sessionId, input: { text: "Hold this run" } });
    await withManagedFailureGuard(started.promise, "active provider request");
    expect(
      await lifecycle.setSessionVisibility({
        sessionId: session.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: "blocked", message: expect.stringContaining("Stop") });
    release.resolve();
    await run;
    expect(aborted).toBe(false);
    expect((await lifecycle.inspect({ sessionId: session.sessionId })).status).toBe("settled");
  } finally {
    release.resolve();
    await run;
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["starting", "executing", "permission", "parent_input", "suspended"] as const)(
  "archive detects persisted %s Child work without starting Control or a provider",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "adam-archive-child-"));
    await mkdir(join(root, "state"));
    const store = createInMemoryManagedAgentControlStore();
    let modelCalls = 0;
    const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      modelTargets: modelTargetsWithDriver(
        new FakeModelDriver(() => {
          modelCalls += 1;
          return [{ type: "finish", reason: "stop" }];
        }),
      ),
      managedControl: {
        store,
        childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
      },
    });
    try {
      const session = await lifecycle.create({ targetIdentity });
      const identity = {
        schemaVersion: 3 as const,
        parentSessionId: session.sessionId,
        threadId: randomUUID(),
        turnId: randomUUID(),
        attemptId: randomUUID(),
        childSessionId: randomUUID(),
      };
      let sequence = 0;
      const append = (event: Parameters<typeof store.append>[0]["event"]) =>
        store.append({ ...identity, sequence: ++sequence, event });
      await append({
        type: "admitted",
        role: "builtin:explore",
        description: "Retained Child",
        task: "Keep work",
      });
      if (phase !== "starting") await append({ type: "started" });
      if (phase === "permission" || phase === "parent_input")
        await append({ type: "capacity_wait", reason: phase });
      if (phase === "suspended") await append({ type: "suspend_requested" });
      const before = await store.read();
      const result = await lifecycle.setSessionVisibility({
        sessionId: session.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      });
      expect(result).toMatchObject({
        status: "blocked",
        message: expect.stringContaining(identity.threadId),
      });
      expect(await store.read()).toEqual(before);
      expect(modelCalls).toBe(0);
    } finally {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
