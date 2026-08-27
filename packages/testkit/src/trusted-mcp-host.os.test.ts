import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPermissionPolicy, type ModelRequest, type ModelTargets } from "@adam-agent/agent";
import {
  mcpBootstrapScheduler,
  mcpCatalogStaleDurableBarrier,
  mcpCatalogStaleObservationBarrier,
  mcpDiscoveryScheduler,
  mcpIdleScheduler,
  mcpPackageManagerCliPath,
  mcpPackageRegistryUrl,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import {
  createSessionLifecycleForTesting as createSessionLifecycle,
  FakeModelDriver,
} from "./index.js";
import {
  createForeignTransitiveNpmRegistryFixture,
  createGatedLocalNpmRegistryFixture,
  createHeldLocalNpmRegistryFixture,
  createLocalNpmRegistryFixture,
} from "./local-npm-registry.fixture.js";

import {
  commitFixtureEchoTool,
  trustedMcpContextProfile as contextProfile,
  createManualMcpIdleScheduler,
  trustedMcpTargetIdentity as targetIdentity,
  withFailureGuard,
} from "./trusted-mcp-host.test-support.js";

const mcpServerFixturePath = fileURLToPath(
  new URL("../dist/mcp-stdio-server.fixture.js", import.meta.url),
);

type PersistedRecordProjection = Readonly<Record<string, unknown>> & {
  readonly reason?: unknown;
  readonly status?: unknown;
  readonly type?: unknown;
};

type PersistedRecordEnvelope = {
  readonly record?: PersistedRecordProjection;
};

function observeFileCreation(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const observeTarget = () => {
      void stat(path).then(finish, () => undefined);
    };
    const watcher = watch(dirname(path), observeTarget);
    const guard = setTimeout(() => {
      settled = true;
      watcher.close();
      reject(new Error(`Timed out waiting for fixture file: ${path}`));
    }, 5_000);
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      watcher.close();
      resolve();
    };
    observeTarget();
  });
}

function bestEffortKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process either exited causally or became unavailable during cleanup.
  }
}

test("SessionLifecycle bootstraps one exact package and invokes its resolved MCP bin", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-call-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  const lifecycleMarker = join(testRoot, "lifecycle-script-ran");
  await mkdir(workspaceRoot);
  const registry = await createLocalNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
    lifecycleMarker,
  });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: [
            "-y",
            "@adam-agent/mcp-fixture@1.2.3",
            spawnMarker,
            closeMarker,
            "ordinary",
            callMarker,
          ],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-package", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-package", json: '{"value":"package"}' },
        { type: "tool_call_end", id: "mcp-package" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      latest.result.status === "completed" &&
      JSON.stringify(latest.result.output) ===
        JSON.stringify({
          version: 1,
          content: [{ type: "text", text: "package" }],
          structuredContent: { echoed: "package" },
          isError: false,
        });
    return [
      { type: "text_delta", text: accepted ? "Package MCP returned." : "Package MCP failed." },
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
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    [mcpPackageRegistryUrl]: registry.url,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    expect(registry.requests).toEqual([]);
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    expect(registry.requests).toEqual([]);
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one package server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    expect(registry.requests).toEqual([]);
    const activated = await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered package MCP catalog.");
    }
    expect(registry.requests.some((request) => request.endsWith("/package.tgz"))).toBe(true);
    await expect(stat(lifecycleMarker)).rejects.toMatchObject({ code: "ENOENT" });
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the package echo tool and generation.");
    }
    qualifiedName = echo.qualifiedName;
    await lifecycle.configureMcp({
      type: "commit_tool_profile",
      sessionId: created.sessionId,
      generationId,
      selections: [
        {
          qualifiedName: echo.qualifiedName,
          definitionDigest: echo.definitionDigest,
          effect: "read",
        },
      ],
    });

    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Call the exact package MCP tool" },
      limits: { maxTurns: 2 },
    });
    expect(continued.result).toEqual({ status: "completed", answer: "Package MCP returned." });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "package" },
    });
  } finally {
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle removes its session-scoped package installation after causal close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-cleanup-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const modulePathMarker = join(testRoot, "module-path");
  await mkdir(workspaceRoot);
  const registry = await createLocalNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
  });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: [
            "-y",
            "@adam-agent/mcp-fixture@1.2.3",
            spawnMarker,
            closeMarker,
            "report-module-path",
            modulePathMarker,
          ],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({
    [mcpPackageRegistryUrl]: registry.url,
    stateRoot,
    workspaceRoot,
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one exact package preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const installedModulePath = await readFile(modulePathMarker, "utf8");
    await expect(stat(installedModulePath)).resolves.toBeDefined();

    await expect(lifecycle.close()).resolves.toEqual({ status: "closed" });
    await expect(stat(installedModulePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle retains one exact package cache across idle reactivation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-idle-cache-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  await mkdir(workspaceRoot);
  const registry = await createLocalNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
  });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: [
            "-y",
            "@adam-agent/mcp-fixture@1.2.3",
            spawnMarker,
            closeMarker,
            "ordinary",
            callMarker,
          ],
        },
      },
    }),
  );

  const manualIdle = createManualMcpIdleScheduler();
  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-package-idle", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-package-idle", json: '{"value":"cached"}' },
        { type: "tool_call_end", id: "mcp-package-idle" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Cached package MCP returned." },
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
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    [mcpIdleScheduler]: manualIdle.scheduler,
    [mcpPackageRegistryUrl]: registry.url,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const activationRequests = [...registry.requests];
    expect(activationRequests.some((request) => request.endsWith("/package.tgz"))).toBe(true);

    await manualIdle.advanceBy(10 * 60 * 1_000);
    await expect(stat(closeMarker)).resolves.toBeDefined();
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Call the cached package after idle close" },
      limits: { maxTurns: 2 },
    });

    expect(continued.result).toEqual({
      status: "completed",
      answer: "Cached package MCP returned.",
    });
    expect(registry.requests).toEqual(activationRequests);
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "cached" },
    });
  } finally {
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects changed package bytes behind the same exact version on cold reactivation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-identity-change-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const modifiedBinSourcePath = join(testRoot, "modified-mcp-server.mjs");
  await mkdir(workspaceRoot);
  await writeFile(
    modifiedBinSourcePath,
    `${await readFile(mcpServerFixturePath, "utf8")}\n// changed package bytes\n`,
  );
  const initialRegistry = await createLocalNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
  });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@1.2.3", spawnMarker, closeMarker],
        },
      },
    }),
  );

  const initial = createSessionLifecycle({
    [mcpPackageRegistryUrl]: initialRegistry.url,
    stateRoot,
    workspaceRoot,
  });
  let changedRegistry: Awaited<ReturnType<typeof createLocalNpmRegistryFixture>> | undefined;
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    await initialRegistry.close();
    changedRegistry = await createLocalNpmRegistryFixture({
      packageName: "@adam-agent/mcp-fixture",
      version: "1.2.3",
      binName: "adam-mcp-fixture",
      binSourcePath: modifiedBinSourcePath,
    });
    let modelRequestCount = 0;
    const driver = new FakeModelDriver(() => {
      modelRequestCount += 1;
      throw new Error("The model must not run after package identity changes.");
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
              readiness: { status: "available", credentialSource: "test" },
              contextProfile,
            },
          ],
        };
      },
    };
    cold = createSessionLifecycle({
      [mcpPackageRegistryUrl]: changedRegistry.url,
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });

    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not rebind changed package bytes" },
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    expect(modelRequestCount).toBe(0);
    await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed\nclosed\n");
  } finally {
    await initial.close();
    await cold?.close();
    await initialRegistry.close().catch(() => undefined);
    await changedRegistry?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a package whose transitive tarball escapes the approved registry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-transitive-origin-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  const registry = await createForeignTransitiveNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
    dependencyPackageName: "@adam-agent/mcp-transitive",
    dependencyVersion: "1.0.0",
  });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@1.2.3", spawnMarker, closeMarker, "ordinary"],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({
    [mcpPackageRegistryUrl]: registry.url,
    stateRoot,
    workspaceRoot,
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one exact package preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_bootstrap_failed" });
    expect(registry.requests.some((request) => request.startsWith("foreign:"))).toBe(true);
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle aborts a held package bootstrap through a deterministic total deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-timeout-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  const registry = await createHeldLocalNpmRegistryFixture();
  const manualBootstrapDeadline = createManualMcpIdleScheduler();
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@1.2.3", spawnMarker, closeMarker, "ordinary"],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({
    [mcpBootstrapScheduler]: manualBootstrapDeadline.scheduler,
    [mcpPackageRegistryUrl]: registry.url,
    stateRoot,
    workspaceRoot,
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one exact package preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const observedActivation = activation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await registry.requestReceived;
    await manualBootstrapDeadline.advanceBy(120_000);
    const outcome = await observedActivation;
    await registry.requestClosed;

    expect(outcome).toMatchObject({
      status: "rejected",
      error: { code: "mcp_bootstrap_failed" },
    });
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle causally reaps a package-bootstrap process group after its leader exits", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-descendant-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const packageManagerCliPath = join(testRoot, "package-manager.cjs");
  const descendantMarker = join(testRoot, "descendant.pid");
  const descendantSocketPath = join(testRoot, "descendant.sock");
  const descendantConnected = Promise.withResolvers<void>();
  const descendantClosed = Promise.withResolvers<"closed">();
  let descendantConnection: Socket | undefined;
  const descendantServer = createServer((socket) => {
    descendantConnection = socket;
    descendantConnected.resolve();
    socket.once("close", () => descendantClosed.resolve("closed"));
  });
  let lifecycle: ReturnType<typeof createSessionLifecycle> | undefined;
  let descendantPid: number | undefined;
  const bodyOutcome = await (async () => {
    await mkdir(workspaceRoot);
    await new Promise<void>((resolve, reject) => {
      const rejectListen = (error: Error) => reject(error);
      descendantServer.once("error", rejectListen);
      descendantServer.listen(descendantSocketPath, () => {
        descendantServer.off("error", rejectListen);
        resolve();
      });
    });
    await writeFile(
      packageManagerCliPath,
      [
        'const { spawn } = require("node:child_process");',
        `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(
          `const socket = require("node:net").createConnection(${JSON.stringify(
            descendantSocketPath,
          )}, () => require("node:fs").writeFileSync(${JSON.stringify(
            descendantMarker,
          )}, String(process.pid))); socket.on("error", () => {}); process.on("SIGTERM", () => {}); setInterval(() => undefined, 60000);`,
        )}], { stdio: "ignore" });`,
        "if (descendant.pid === undefined) process.exit(2);",
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => undefined, 60000);",
      ].join("\n"),
    );
    await writeFile(
      join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: "npx",
            args: ["-y", "@adam-agent/mcp-fixture@1.2.3"],
          },
        },
      }),
    );

    const manualBootstrapDeadline = createManualMcpIdleScheduler();
    lifecycle = createSessionLifecycle({
      [mcpBootstrapScheduler]: manualBootstrapDeadline.scheduler,
      [mcpPackageManagerCliPath]: packageManagerCliPath,
      [mcpPackageRegistryUrl]: "http://127.0.0.1:1",
      stateRoot,
      workspaceRoot,
    });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one exact package preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const descendantSpawned = observeFileCreation(descendantMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const observedActivation = activation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await descendantSpawned;
    await descendantConnected.promise;
    descendantPid = Number.parseInt(await readFile(descendantMarker, "utf8"), 10);
    await manualBootstrapDeadline.advanceBy(120_000);
    const outcome = await observedActivation;
    const descendantState = await withFailureGuard(
      descendantClosed.promise,
      5_000,
      "The package-bootstrap descendant did not close its causal connection.",
    );

    expect({ outcome, descendantState }).toMatchObject({
      outcome: { status: "rejected", error: { code: "mcp_bootstrap_failed" } },
      descendantState: "closed",
    });
  })().then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  const failures: unknown[] = bodyOutcome.status === "rejected" ? [bodyOutcome.error] : [];
  const attemptCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  await attemptCleanup(async () => {
    await lifecycle?.close();
  });
  await attemptCleanup(() => {
    if (descendantPid !== undefined) {
      bestEffortKillProcess(descendantPid);
    }
    descendantConnection?.destroy();
  });
  await attemptCleanup(async () => {
    if (descendantServer.listening) {
      await new Promise<void>((resolve, reject) => {
        descendantServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
  await attemptCleanup(() => rm(testRoot, { recursive: true, force: true }));

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "The package-bootstrap descendant fixture had multiple causal failures.",
    );
  }
});

test("SessionLifecycle starts the initialize and discovery budget only after package bootstrap", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-budget-order-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  const registry = await createGatedLocalNpmRegistryFixture({
    packageName: "@adam-agent/mcp-fixture",
    version: "1.2.3",
    binName: "adam-mcp-fixture",
    binSourcePath: mcpServerFixturePath,
  });
  const manualDiscoveryDeadline = createManualMcpIdleScheduler();
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@1.2.3", spawnMarker, closeMarker, "ordinary"],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({
    [mcpDiscoveryScheduler]: manualDiscoveryDeadline.scheduler,
    [mcpPackageRegistryUrl]: registry.url,
    stateRoot,
    workspaceRoot,
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one exact package preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });

    await registry.requestReceived;
    await manualDiscoveryDeadline.advanceBy(30_000);
    registry.release();
    const activated = await withFailureGuard(
      activation,
      10_000,
      "Package activation did not settle after the registry gate opened.",
    );

    expect(activated.snapshot.mcp).toMatchObject({
      status: "tool_selection_required",
      activation: { status: "ready" },
    });
    await expect(stat(spawnMarker)).resolves.toBeDefined();
  } finally {
    registry.release();
    await lifecycle.close();
    await registry.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle activates an approved stdio server and discovers every tool page", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const requestMarker = join(testRoot, "requests");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "request-log", requestMarker],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const activated = await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [
        {
          serverId: preview.serverId,
          definitionDigest: preview.definitionDigest,
        },
      ],
    });
    expect(activated).toMatchObject({
      status: "updated",
      snapshot: {
        lastSequence: 5,
        mcp: {
          status: "tool_selection_required",
          activation: {
            attempt: 1,
            generationId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            ),
            status: "ready",
          },
          servers: [{ serverId: "fixture", status: "ready" }],
          catalog: {
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            tools: [
              {
                serverId: "fixture",
                originalName: "echo",
                qualifiedName: expect.stringMatching(/^mcp__fixture__echo__[0-9a-f]{12}$/u),
                definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              },
              {
                serverId: "fixture",
                originalName: "uppercase",
                qualifiedName: expect.stringMatching(/^mcp__fixture__uppercase__[0-9a-f]{12}$/u),
                definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              },
            ],
          },
        },
      },
    });
    await expect(stat(spawnMarker)).resolves.toBeDefined();
    await expect(readFile(requestMarker, "utf8")).resolves.toBe(
      "initialize\nnotifications/initialized\ntools/list\ntools/list\n",
    );
  } finally {
    const closed = await lifecycle.close();
    expect(closed).toEqual({ status: "closed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle receives a real stdio list_changed after one completed tool response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-stdio-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "list-changed-once", callMarker],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  let requestCount = 0;
  const driver = new FakeModelDriver(() => {
    requestCount += 1;
    return requestCount === 1
      ? [
          { type: "tool_call_start", id: "stdio-list-changed", name: qualifiedName as string },
          {
            type: "tool_call_delta",
            id: "stdio-list-changed",
            json: '{"value":"transport-contract"}',
          },
          { type: "tool_call_end", id: "stdio-list-changed" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "Real stdio list change forwarded." },
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
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const staleDurable = Promise.withResolvers<void>();
  const lifecycle = createSessionLifecycle({
    [mcpCatalogStaleDurableBarrier]: { committed: () => staleDurable.resolve() },
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Observe one real stdio list change" },
      limits: { maxTurns: 2 },
    });
    await withFailureGuard(
      staleDurable.promise,
      5_000,
      "The real stdio list_changed notification was not durably observed.",
    );

    await expect(continued).resolves.toMatchObject({
      result: { status: "completed", answer: "Real stdio list change forwarded." },
    });
    await expect(lifecycle.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: { status: "catalog_stale", catalog: { status: "stale" } },
    });
    expect(requestCount).toBe(2);
    await expect(
      readFile(callMarker, "utf8").then((value) => value.trim().split("\n")),
    ).resolves.toEqual([
      JSON.stringify({ name: "echo", arguments: { value: "transport-contract" } }),
    ]);
  } finally {
    await lifecycle.close();
    await expect(stat(closeMarker)).resolves.toBeDefined();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle treats malformed MCP stdout as fatal and reaps the server", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-malformed-frame-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const malformedMarker = join(testRoot, "malformed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "malformed-tools-list",
            malformedMarker,
          ],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const malformed = observeFileCreation(malformedMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    await malformed;
    await expect(
      withFailureGuard(
        activation,
        2_000,
        "Malformed MCP stdout did not settle the activation causally.",
      ),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    const fixturePid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    let processAbsent = false;
    try {
      process.kill(fixturePid, 0);
    } catch (error) {
      processAbsent = error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(processAbsent).toBe(true);
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);

test("SessionLifecycle aborts an MCP frame while it exceeds the 64 MiB accumulation bound", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-frame-limit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const streamMarker = join(testRoot, "streaming");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "oversized-frame", streamMarker],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const streaming = observeFileCreation(streamMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    await streaming;
    await expect(
      withFailureGuard(
        activation,
        15_000,
        "Oversized MCP stdout did not settle the activation causally.",
      ),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    const fixturePid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    let processAbsent = false;
    try {
      process.kill(fixturePid, 0);
    } catch (error) {
      processAbsent = error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(processAbsent).toBe(true);
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 20_000);

test("SessionLifecycle drains bounded-private MCP stderr without blocking activation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-stderr-flood-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const drainedMarker = join(testRoot, "stderr-drained");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "stderr-flood", drainedMarker],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const activated = await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    await expect(stat(drainedMarker)).resolves.toBeDefined();
    expect(activated.snapshot.mcp).toMatchObject({
      status: "tool_selection_required",
      activation: { status: "ready" },
    });

    const sessionPath = join(
      stateRoot,
      "projects",
      activated.snapshot.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    expect(JSON.stringify(activated.snapshot)).not.toContain("never-persist-stderr-secret");
    expect(await readFile(sessionPath, "utf8")).not.toContain("never-persist-stderr-secret");
    await expect(lifecycle.close()).resolves.toEqual({ status: "closed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);

test("SessionLifecycle fences an unexpectedly exited MCP generation without automatic restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unexpected-exit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const exitGate = join(testRoot, "exit-gate");
  const descendantMarker = join(testRoot, "descendant");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "exit-after-gate",
            exitGate,
            descendantMarker,
          ],
        },
      },
    }),
  );
  let observeCrash!: (input: {
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: `sha256:${string}`;
  }) => void;
  const crashObserved = new Promise<{
    readonly sessionId: string;
    readonly generationId: string;
    readonly serverId: string;
    readonly catalogDigest: `sha256:${string}`;
  }>((resolve) => {
    observeCrash = resolve;
  });
  const lifecycle = createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    [mcpCatalogStaleObservationBarrier]: { observed: observeCrash },
  });
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    const before = await lifecycle.inspect({ sessionId: committed.sessionId });
    if (
      before.schemaVersion !== 3 ||
      before.mcp?.workspaceConfirmed !== true ||
      before.mcp.activation?.generationId === undefined
    ) {
      throw new Error("The fixture requires one committed MCP generation.");
    }
    const generationId = before.mcp.activation.generationId;
    const leaderPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    const descendantPid = Number.parseInt(await readFile(descendantMarker, "utf8"), 10);

    await writeFile(exitGate, "exit");
    await expect(
      withFailureGuard(
        crashObserved,
        5_000,
        "The unexpected MCP exit was not fenced and observed.",
      ),
    ).resolves.toMatchObject({ sessionId: committed.sessionId, generationId, serverId: "fixture" });
    expect(
      [leaderPid, descendantPid].map((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }),
    ).toEqual([true, true]);
    await expect(
      lifecycle.configureMcp({
        type: "revalidate_catalog",
        sessionId: committed.sessionId,
        generationId,
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    const after = await lifecycle.inspect({ sessionId: committed.sessionId });
    expect(after).toMatchObject({ mcp: { status: "catalog_stale" } });
    const sessionPath = join(
      stateRoot,
      "projects",
      after.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${committed.sessionId}.jsonl`,
    );
    const records = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records
        .filter(
          (entry) =>
            entry.record?.generationId === generationId &&
            (entry.record?.type === "mcp_server_closed" ||
              entry.record?.type === "mcp_catalog_state_changed"),
        )
        .map((entry) => ({ type: entry.record.type, reason: entry.record.reason })),
    ).toEqual([
      { type: "mcp_server_closed", reason: "stale" },
      { type: "mcp_catalog_state_changed", reason: "server_closed" },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { mode: "malformed-on-call", output: "malformed JSON" },
  { mode: "invalid-utf8-on-call", output: "invalid UTF-8" },
  { mode: "partial-frame-on-call", output: "partial-frame EOF" },
] as const)(
  "SessionLifecycle distinguishes post-dispatch $output protocol output from disconnect",
  async ({ mode }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-call-protocol-error-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    const spawnMarker = join(testRoot, "spawned");
    const closeMarker = join(testRoot, "closed");
    const callMarker = join(testRoot, "called");
    await mkdir(workspaceRoot);
    await writeFile(
      join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [mcpServerFixturePath, spawnMarker, closeMarker, mode, callMarker],
          },
        },
      }),
    );

    let qualifiedName: string | undefined;
    const requests: ModelRequest[] = [];
    const driver = new FakeModelDriver((request) => {
      requests.push(request);
      return [
        { type: "tool_call_start", id: "mcp-protocol-error", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-protocol-error", json: '{"value":"once"}' },
        { type: "tool_call_end", id: "mcp-protocol-error" },
        { type: "finish", reason: "tool_calls" },
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
              readiness: { status: "available", credentialSource: "test" },
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
      workspaceRoot,
    });

    try {
      const committed = await commitFixtureEchoTool(lifecycle);
      qualifiedName = committed.qualifiedName;
      const continued = await lifecycle.continue({
        sessionId: committed.sessionId,
        input: { text: "Call an MCP tool that emits malformed protocol output" },
        limits: { maxTurns: 2 },
      });

      expect({ continued, requestCount: requests.length }).toMatchObject({
        continued: {
          result: {
            status: "failed",
            error: {
              code: "tool_effect_indeterminate",
              reason: "mcp_protocol_error",
              message: "The MCP protocol failed before a complete tool response was confirmed.",
            },
          },
        },
        requestCount: 1,
      });
      await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
        name: "echo",
        arguments: { value: "once" },
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle close interrupts an in-progress activation and waits for causal process close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-close-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const initializeGate = join(testRoot, "initialize-gate");
  const initializeReceivedMarker = join(testRoot, "initialize-received");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "gated-initialize",
            initializeGate,
            initializeReceivedMarker,
          ],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const initializeReceived = observeFileCreation(initializeReceivedMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const observedActivation = activation.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
    await initializeReceived;
    const fixturePid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    const firstClose = await lifecycle.close();
    let processAbsentBeforeGate = false;
    try {
      process.kill(fixturePid, 0);
    } catch (error) {
      processAbsentBeforeGate = error instanceof Error && "code" in error && error.code === "ESRCH";
    }

    await writeFile(initializeGate, "continue only for failed-implementation cleanup");
    const activationOutcome = await observedActivation;
    await lifecycle.close();
    const cold = createSessionLifecycle({ stateRoot, workspaceRoot });
    const inspected = await cold.inspect({ sessionId: created.sessionId });
    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const terminalRecords = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope)
      .filter((entry) =>
        ["mcp_activation_started", "mcp_server_closed", "mcp_activation_settled"].includes(
          String(entry.record?.type),
        ),
      )
      .map((entry) => ({
        type: entry.record?.type,
        status: entry.record?.status,
        reason: entry.record?.reason,
      }));
    await cold.close();

    expect({
      firstClose,
      processAbsentBeforeGate,
      activationOutcome,
      inspected,
      terminalRecords,
    }).toMatchObject({
      firstClose: { status: "closed" },
      processAbsentBeforeGate: true,
      activationOutcome: "rejected",
      inspected: {
        mcp: { status: "activation_required", activation: { status: "cancelled" } },
      },
      terminalRecords: [
        { type: "mcp_activation_started", status: undefined, reason: "initial" },
        { type: "mcp_server_closed", status: undefined, reason: "session_close" },
        { type: "mcp_activation_settled", status: "cancelled", reason: undefined },
      ],
    });
  } finally {
    await writeFile(initializeGate, "cleanup").catch(() => undefined);
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);

test("SessionLifecycle close causally reaps the MCP process group descendants", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-descendant-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const descendantMarker = join(testRoot, "descendant");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "descendant", descendantMarker],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    await lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const leaderPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    const descendantPid = Number.parseInt(await readFile(descendantMarker, "utf8"), 10);

    const closed = await lifecycle.close();
    const absent = [leaderPid, descendantPid].map((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error instanceof Error && "code" in error && error.code === "ESRCH";
      }
    });

    expect({ closed, absent }).toEqual({
      closed: { status: "closed" },
      absent: [true, true],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);
