import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPermissionPolicy, type ModelDriver } from "@adam-agent/agent";
import {
  createJsonlManagedAgentControlStore,
  createJsonlSessionStoreDirectory,
  createManagedAgentCapacityConfiguration,
  type SessionRecord,
  sessionManagedControl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

const parentSessionId = "00000000-0000-4000-8000-000000000001";
const secondParentSessionId = "00000000-0000-4000-8000-000000000002";

async function configurationPath(workspaceRoot: string, stateRoot: string, parent: string) {
  const canonicalRoot = await realpath(workspaceRoot);
  const project = createHash("sha256").update(canonicalRoot).digest("hex");
  return join(stateRoot, "projects", project, "managed-agents", `capacity-${parent}.json`);
}

test("background capacity is durable per Main, including explicit unlimited", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-capacity-configuration-"));
  const stateRoot = join(workspaceRoot, "state");
  const options = { workspaceRoot, stateRoot, parentSessionId };
  try {
    const first = await createManagedAgentCapacityConfiguration(options);
    const second = await createManagedAgentCapacityConfiguration({
      ...options,
      parentSessionId: secondParentSessionId,
    });
    expect(await first.load()).toBeUndefined();
    await first.save(17);
    await second.save("unlimited");
    expect(await (await createManagedAgentCapacityConfiguration(options)).load()).toBe(17);
    expect(await second.load()).toBe("unlimited");
    expect(
      JSON.parse(
        await readFile(await configurationPath(workspaceRoot, stateRoot, parentSessionId), "utf8"),
      ),
    ).toEqual({ version: 1, backgroundRunning: 17 });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test.each([
  '{"version":1,"backgroundRunning":0}',
  '{"version":1,"backgroundRunning":1.5}',
  '{"version":1,"backgroundRunning":9007199254740992}',
  '{"version":1,"backgroundRunning":"8"}',
  '{"version":1,"backgroundRunning":8,"backgroundRunning":"unlimited"}',
  '{"version":1,"backgroundRunning":8,"queued":32}',
])("invalid persisted background capacity is refused: %s", async (text) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-capacity-invalid-"));
  const stateRoot = join(workspaceRoot, "state");
  try {
    const path = await configurationPath(workspaceRoot, stateRoot, parentSessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
    const configuration = await createManagedAgentCapacityConfiguration({
      workspaceRoot,
      stateRoot,
      parentSessionId,
    });
    await expect(configuration.load()).rejects.toMatchObject({
      code: "managed_agent_capacity_configuration_invalid",
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("capacity configuration refuses an unsafe symlink without changing its target", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-capacity-unsafe-"));
  const stateRoot = join(workspaceRoot, "state");
  try {
    const path = await configurationPath(workspaceRoot, stateRoot, parentSessionId);
    const target = join(workspaceRoot, "other.json");
    const original = '{"version":1,"backgroundRunning":2}\n';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(target, original, { mode: 0o600 });
    await symlink(target, path);
    const configuration = await createManagedAgentCapacityConfiguration({
      workspaceRoot,
      stateRoot,
      parentSessionId,
    });
    await expect(configuration.load()).rejects.toMatchObject({
      code: "managed_agent_capacity_configuration_unsafe",
    });
    await expect(configuration.save(9)).rejects.toMatchObject({
      code: "managed_agent_capacity_configuration_unavailable",
    });
    expect(await readFile(target, "utf8")).toBe(original);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test.each([1, 2] as const)(
  "Lifecycle retains an explicitly configured v%s fleet policy",
  async (version) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-capacity-historical-"));
    const stateRoot = join(workspaceRoot, "state");
    const h = createInMemorySessionLifecycleHarness();
    const policy = {
      version,
      background: { running: 2, queued: 4 },
      reserved: { running: 1 as const, queued: 4 },
      maximumAttempts: 2,
      threadTokens: version === 1 ? 128_000 : null,
      batchTokens: version === 1 ? 256_000 : null,
      sessionTokens: version === 1 ? 512_000 : null,
      storageBytes: 32 * 1024 * 1024,
    };
    const lifecycle = h.createLifecycle({
      workspaceRoot,
      stateRoot,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      modelTargets: modelTargetsWithDriver({
        async *stream() {
          yield { type: "finish", reason: "stop" };
        },
      }),
      [sessionManagedControl]: {
        policy,
        store: await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot }),
        childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
          workspaceRoot,
          stateRoot: join(stateRoot, "children"),
        }),
      },
    });
    try {
      const parent = await lifecycle.create({ targetIdentity });
      const configuration = await createManagedAgentCapacityConfiguration({
        workspaceRoot,
        stateRoot,
        parentSessionId: parent.sessionId,
      });
      await configuration.save("unlimited");
      const control = await lifecycle[sessionManagedControl](parent.sessionId);
      if (control === undefined) throw new Error("Missing historical policy Control");
      expect((await control.inspect({ parentSessionId: parent.sessionId })).policy).toEqual(policy);
    } finally {
      await lifecycle.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("candidate Lifecycle persists Owner capacity before applying it and cold loading never starts its queue", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-capacity-lifecycle-"));
  const stateRoot = join(workspaceRoot, "state");
  const h = createInMemorySessionLifecycleHarness();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      calls += 1;
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const options = {
    workspaceRoot,
    stateRoot,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
    modelTargets: modelTargetsWithDriver(driver),
    [sessionManagedControl]: {
      store: await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot }),
      childSessionStores: createJsonlSessionStoreDirectory<SessionRecord>({
        workspaceRoot,
        stateRoot: join(stateRoot, "children"),
      }),
    },
  };
  const warm = h.createLifecycle(options);
  let cold: ReturnType<typeof h.createLifecycle> | undefined;
  try {
    const parent = await warm.create({ targetIdentity });
    const control = await warm[sessionManagedControl](parent.sessionId);
    if (control === undefined) throw new Error("Missing candidate Control");
    expect(
      await control.configureBackgroundCapacity({ parentSessionId: parent.sessionId, running: 1 }),
    ).toMatchObject({ policy: { version: 3, background: { running: 1 } } });
    const path = await configurationPath(workspaceRoot, stateRoot, parent.sessionId);
    await chmod(path, 0o644);
    await expect(
      control.configureBackgroundCapacity({ parentSessionId: parent.sessionId, running: 3 }),
    ).rejects.toMatchObject({ code: "managed_agent_capacity_configuration_unavailable" });
    expect(await control.inspect({ parentSessionId: parent.sessionId })).toMatchObject({
      policy: { background: { running: 1 } },
    });
    await chmod(path, 0o600);
    const admission = await control.dispatch({
      type: "spawn_agents",
      parentSessionId: parent.sessionId,
      mode: "background",
      origin: { kind: "direct_request", id: randomUUID() },
      entries: [
        { role: "builtin:explore", task: "First durable task", description: "First task" },
        { role: "builtin:explore", task: "Second durable task", description: "Queued task" },
      ],
    });
    if (admission.status !== "admitted") throw new Error(JSON.stringify(admission));
    await withManagedFailureGuard(started.promise, "first configured-capacity child start");
    const queued = admission.turns[1];
    if (queued === undefined) throw new Error("Missing queued task");
    expect(
      (await control.inspect({ parentSessionId: parent.sessionId })).threads[1]?.turn.phase,
    ).toBe("queued");
    expect(await warm.close()).toMatchObject({ status: "closed" });
    cold = h.createLifecycle(options);
    const recovered = await cold[sessionManagedControl](parent.sessionId);
    if (recovered === undefined) throw new Error("Missing reopened candidate Control");
    const snapshot = await recovered.inspect({ parentSessionId: parent.sessionId });
    expect(snapshot).toMatchObject({ policy: { version: 3, background: { running: 1 } } });
    expect(
      snapshot.threads.find((thread) => thread.threadId === queued.threadId)?.turn,
    ).toMatchObject({
      turnId: queued.turnId,
      recovery: "required",
    });
    expect(
      await options[sessionManagedControl].childSessionStores.open(queued.childSessionId),
    ).toBeUndefined();
    expect(calls).toBe(1);
    expect(
      await recovered.configureBackgroundCapacity({
        parentSessionId: parent.sessionId,
        running: "unlimited",
      }),
    ).toMatchObject({ policy: { background: { running: "unlimited" } } });
    expect(calls).toBe(1);
    expect(
      await (
        await createManagedAgentCapacityConfiguration({
          workspaceRoot,
          stateRoot,
          parentSessionId: parent.sessionId,
        })
      ).load(),
    ).toBe("unlimited");
  } finally {
    await cold?.close();
    await warm.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
