import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createPermissionPolicy,
  type ModelRequest,
  type ModelTargetIdentity,
  type ModelTargets,
  type RuntimeEvent,
} from "@adam-agent/agent";
import {
  type McpIdleScheduler,
  mcpActivationSettlementBarrier,
  mcpBeforeToolDispatchBarrier,
  mcpBootstrapScheduler,
  mcpCatalogStaleDurableBarrier,
  mcpCatalogStaleObservationBarrier,
  mcpCloseConfirmation,
  mcpDiscoveryScheduler,
  mcpIdleScheduler,
  mcpPackageManagerCliPath,
  mcpPackageRegistryUrl,
  mcpRequestScheduler,
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
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 48_000,
  retainedTargetTokens: 16_000,
  estimatorVersion: 1,
};

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
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path)) {
        finish();
      }
    });
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
    void stat(path).then(finish, () => undefined);
  });
}

function withFailureGuard<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(guard);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(guard);
        reject(error);
      },
    );
  });
}

function bestEffortKillProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process either exited causally or became unavailable during cleanup.
  }
}

function createManualMcpIdleScheduler(): {
  readonly scheduler: McpIdleScheduler;
  readonly advanceBy: (milliseconds: number) => Promise<void>;
} {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { readonly due: number; readonly task: () => Promise<void> }>();
  return {
    scheduler: {
      schedule(delayMilliseconds, task) {
        const id = nextId;
        nextId += 1;
        tasks.set(id, { due: now + delayMilliseconds, task });
        return { cancel: () => tasks.delete(id) };
      },
    },
    async advanceBy(milliseconds) {
      now += milliseconds;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, scheduled]) => scheduled.due <= now)
          .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
        if (due === undefined) {
          return;
        }
        tasks.delete(due[0]);
        await due[1].task();
      }
    },
  };
}

async function commitFixtureEchoTool(
  lifecycle: ReturnType<typeof createSessionLifecycle>,
): Promise<{
  readonly sessionId: string;
  readonly qualifiedName: string;
  readonly definitionDigest: `sha256:${string}`;
}> {
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
  const activeMcp = activated.snapshot.mcp;
  if (activeMcp?.status !== "tool_selection_required") {
    throw new Error("The fixture requires a discovered MCP catalog.");
  }
  const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
  const generationId = activeMcp.activation?.generationId;
  if (echo === undefined || generationId === undefined) {
    throw new Error("The fixture requires the discovered echo tool and generation.");
  }
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
  return {
    sessionId: created.sessionId,
    qualifiedName: echo.qualifiedName,
    definitionDigest: echo.definitionDigest,
  };
}

test("SessionLifecycle rejects an oversized MCP configuration without an orphan session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-oversized-config-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["x".repeat(65_536)],
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "mcp_config_invalid",
    });
    const stateFiles = await readdir(stateRoot, { recursive: true }).catch(
      (error: unknown): string[] => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    expect(stateFiles.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects non-UTF-8 MCP configuration bytes without an orphan session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-config-utf8-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    Buffer.from(`{"mcpServers":{"fixture":{"command":"${String.fromCharCode(0xff)}"}}}`, "latin1"),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "mcp_config_invalid",
    });
    const stateFiles = await readdir(stateRoot, { recursive: true }).catch(() => [] as string[]);
    expect(stateFiles.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
    await lifecycle.close();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects duplicate MCP configuration keys without an orphan session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-duplicate-config-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    `{"mcpServers":{},"mcpServers":{"fixture":{"command":${JSON.stringify(process.execPath)}}}}`,
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "mcp_config_invalid",
    });
    const stateFiles = await readdir(stateRoot, { recursive: true }).catch(
      (error: unknown): string[] => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    expect(stateFiles.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an invalid MCP server ID before creating a session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-invalid-server-id-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "../fixture": { command: process.execPath },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "mcp_config_invalid",
    });
    const stateFiles = await readdir(stateRoot, { recursive: true }).catch(
      (error: unknown): string[] => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    expect(stateFiles.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects unknown stdio configuration fields before creating a session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unknown-field-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, mysteryAuthority: true },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(lifecycle.create({ targetIdentity })).rejects.toMatchObject({
      code: "mcp_config_invalid",
    });
    const stateFiles = await readdir(stateRoot, { recursive: true }).catch(
      (error: unknown): string[] => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    expect(stateFiles.filter((path) => path.endsWith(".jsonl"))).toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps project MCP configuration inert until workspace confirmation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-inert-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "1")`],
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });

    const expectedMcp = {
      schemaVersion: 1,
      status: "workspace_confirmation_required",
      workspaceConfirmed: false,
      source: {
        path: ".mcp.json",
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      servers: [],
      diagnostics: [],
    };
    expect(created).toMatchObject({ mcp: expectedMcp });
    expect(inspected).toMatchObject({ mcp: expectedMcp });
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle durably confirms a workspace before resolving safe server previews", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-workspace-confirmation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const serverArguments = [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "1")`,
  ];
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: serverArguments,
          env: {},
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }

    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const expectedMcp = {
      schemaVersion: 1,
      status: "server_approval_required",
      workspaceConfirmed: true,
      source: created.mcp.source,
      servers: [
        {
          serverId: "fixture",
          status: "approval_required",
          transport: "stdio",
          command: { kind: "executable", path: await realpath(process.execPath) },
          arguments: serverArguments,
          cwd: await realpath(workspaceRoot),
          requestedEnvironmentNames: [],
          startupEffects: ["execute"],
          limits: {
            version: 1,
            packageBootstrapMilliseconds: 120_000,
            initializeAndDiscoveryMilliseconds: 30_000,
            toolRequestMilliseconds: 120_000,
            idleMilliseconds: 600_000,
            shutdownMilliseconds: 5_000,
            maximumFrameBytes: 64 * 1024 * 1024,
            maximumStderrTailBytes: 16 * 1024,
            maximumCatalogTools: 256,
            maximumCatalogPages: 64,
            maximumCatalogDefinitionBytes: 4 * 1024 * 1024,
            maximumToolDefinitionBytes: 16 * 1024,
            maximumCatalogCursorBytes: 16 * 1024,
          },
          definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
      diagnostics: [],
    };
    expect(configured).toMatchObject({
      status: "updated",
      snapshot: { lastSequence: 2, mcp: expectedMcp },
    });

    const restarted = createSessionLifecycle({ stateRoot, workspaceRoot });
    const inspected = await restarted.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({ lastSequence: 2, mcp: expectedMcp });
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle refuses to execute a locally replaced MCP executable after approval", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-executable-identity-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const executablePath = join(testRoot, "fixture-server.cjs");
  const spawnMarker = join(testRoot, "spawned");
  await mkdir(workspaceRoot);
  await writeFile(executablePath, `#!${process.execPath}\nprocess.exit(0);\n`);
  await chmod(executablePath, 0o755);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: executablePath } } }),
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
    expect(preview.command).toMatchObject({
      kind: "executable",
      path: await realpath(executablePath),
      identity: {
        version: 1,
        contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        size: expect.any(Number),
        mode: 0o755,
      },
    });
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    await writeFile(
      executablePath,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned");\n`,
    );
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    const inspectedMcp = inspected.schemaVersion === 3 ? inspected.mcp : undefined;
    expect(inspectedMcp).toMatchObject({
      status: "server_approval_required",
      servers: [
        {
          serverId: "fixture",
          status: "approval_required",
        },
      ],
    });
    expect(inspectedMcp?.servers[0]?.definitionDigest).not.toBe(preview.definitionDigest);
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle binds a project-relative MCP cwd into the exact server preview", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-relative-cwd-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const serverRoot = join(workspaceRoot, "packages", "fixture");
  await mkdir(serverRoot, { recursive: true });
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["--version"],
          cwd: "packages/fixture",
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });

    expect(configured.snapshot.mcp).toMatchObject({
      servers: [
        {
          serverId: "fixture",
          cwd: await realpath(serverRoot),
          arguments: ["--version"],
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle resolves a bare MCP command only through the controlled executable path", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-bare-command-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: basename(process.execPath), args: ["--version"] },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });

    expect(configured.snapshot.mcp).toMatchObject({
      servers: [
        {
          command: { kind: "executable", path: await realpath(process.execPath) },
          arguments: ["--version"],
        },
      ],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle normalizes an exact npx grammar into an inert package preview", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-preview-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@1.2.3", "--flag", "value"],
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
    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });

    expect(configured.snapshot.mcp).toMatchObject({
      status: "server_approval_required",
      servers: [
        {
          serverId: "fixture",
          status: "approval_required",
          command: {
            kind: "npm_package",
            packageName: "@adam-agent/mcp-fixture",
            version: "1.2.3",
            binPolicy: "npm-default-v1",
          },
          arguments: ["--flag", "value"],
          startupEffects: ["execute", "network"],
          definitionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      ],
      diagnostics: [],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps a mutable npx package spec inert and requires an exact pin", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-package-pin-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "npx",
          args: ["-y", "@adam-agent/mcp-fixture@latest"],
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
    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });

    expect(configured.snapshot.mcp).toMatchObject({
      status: "server_approval_required",
      servers: [],
      diagnostics: [{ code: "mcp_package_pin_required", serverId: "fixture" }],
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps non-npx package runners inert instead of treating them as executables", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-other-runners-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  await mkdir(workspaceRoot);
  const runnerEntries = [
    ["bunx", ["@adam-agent/mcp-fixture@1.2.3"]],
    ["npm", ["exec", "@adam-agent/mcp-fixture@1.2.3"]],
    ["pnpm", ["dlx", "@adam-agent/mcp-fixture@1.2.3"]],
    ["uvx", ["@adam-agent/mcp-fixture@1.2.3"]],
  ] as const;
  const mcpServers: Record<string, { readonly command: string; readonly args: readonly string[] }> =
    {};
  for (const [runner, args] of runnerEntries) {
    const runnerPath = join(testRoot, runner);
    await writeFile(
      runnerPath,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned");\n`,
    );
    await chmod(runnerPath, 0o755);
    mcpServers[runner] = { command: runnerPath, args };
  }
  await writeFile(join(workspaceRoot, ".mcp.json"), JSON.stringify({ mcpServers }));

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    expect(configured.snapshot.mcp).toMatchObject({
      status: "server_approval_required",
      servers: [],
      diagnostics: runnerEntries.map(([serverId]) => ({
        code: "mcp_package_pin_required",
        serverId,
      })),
    });
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

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
  await mkdir(workspaceRoot);
  await writeFile(
    packageManagerCliPath,
    [
      'const { spawn } = require("node:child_process");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(
        `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(
          descendantMarker,
        )}, String(process.pid)); setInterval(() => undefined, 60000);`,
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
  const lifecycle = createSessionLifecycle({
    [mcpBootstrapScheduler]: manualBootstrapDeadline.scheduler,
    [mcpPackageManagerCliPath]: packageManagerCliPath,
    [mcpPackageRegistryUrl]: "http://127.0.0.1:1",
    stateRoot,
    workspaceRoot,
  });
  let descendantPid: number | undefined;
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
    descendantPid = Number.parseInt(await readFile(descendantMarker, "utf8"), 10);
    await manualBootstrapDeadline.advanceBy(120_000);
    const outcome = await observedActivation;
    let descendantAbsent = false;
    try {
      process.kill(descendantPid, 0);
    } catch (error) {
      descendantAbsent = error instanceof Error && "code" in error && error.code === "ESRCH";
    }

    expect({ outcome, descendantAbsent }).toMatchObject({
      outcome: { status: "rejected", error: { code: "mcp_bootstrap_failed" } },
      descendantAbsent: true,
    });
  } finally {
    if (descendantPid !== undefined) {
      bestEffortKillProcess(descendantPid);
    }
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
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

test("SessionLifecycle keeps nonempty MCP environment values inert and undisclosed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-env-inert-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "1")`],
          env: { TOKEN: "never-persist-token", API_KEY: "never-persist-key" },
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const serialized = JSON.stringify(confirmed.snapshot.mcp);

    expect(confirmed.snapshot.mcp).toMatchObject({
      status: "server_approval_required",
      workspaceConfirmed: true,
      servers: [
        {
          serverId: "fixture",
          status: "unsupported",
          requestedEnvironmentNames: ["API_KEY", "TOKEN"],
        },
      ],
      diagnostics: [{ code: "mcp_environment_unsupported", serverId: "fixture" }],
    });
    expect(serialized).not.toContain("never-persist-token");
    expect(serialized).not.toContain("never-persist-key");
    const unsupported = confirmed.snapshot.mcp?.servers[0];
    if (unsupported === undefined) {
      throw new Error("The fixture requires one inert MCP server preview.");
    }
    await expect(
      lifecycle.configureMcp({
        type: "approve_server",
        sessionId: created.sessionId,
        serverId: unsupported.serverId,
        definitionDigest: unsupported.definitionDigest,
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle reports a remote MCP entry as inert without exposing endpoint data", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-remote-inert-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://secret.example.invalid/mcp?token=never-disclose",
          headers: { Authorization: "Bearer never-disclose" },
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
    const created = await lifecycle.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const serialized = JSON.stringify(confirmed.snapshot.mcp);

    expect(confirmed.snapshot.mcp).toMatchObject({
      status: "server_approval_required",
      workspaceConfirmed: true,
      servers: [],
      diagnostics: [{ code: "mcp_transport_unsupported", serverId: "remote" }],
    });
    expect(serialized).not.toContain("secret.example.invalid");
    expect(serialized).not.toContain("never-disclose");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps exact server approval separate from process launch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-server-approval-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "1")`],
        },
      },
    }),
  );

  try {
    const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
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

    const approved = await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    expect(approved).toMatchObject({
      status: "updated",
      snapshot: {
        lastSequence: 3,
        mcp: {
          status: "activation_required",
          workspaceConfirmed: true,
          servers: [
            {
              serverId: "fixture",
              status: "approved",
              definitionDigest: preview.definitionDigest,
            },
          ],
        },
      },
    });

    const inspected = await createSessionLifecycle({ stateRoot, workspaceRoot }).inspect({
      sessionId: created.sessionId,
    });
    expect(inspected).toMatchObject(approved.snapshot);
    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
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

test("SessionLifecycle keeps a discovered MCP catalog private until its ready settlement is durable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-activation-publication-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  let releaseSettlement = () => {};
  const settlementRelease = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  let announceSettlement = (_input: { readonly generationId: string }) => {};
  const settlementReached = new Promise<{ readonly generationId: string }>((resolve) => {
    announceSettlement = resolve;
  });
  const lifecycle = createSessionLifecycle({
    [mcpActivationSettlementBarrier]: {
      async beforeReadySettlement(input) {
        announceSettlement(input);
        await settlementRelease;
      },
    },
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
      throw new Error("The fixture requires one MCP server preview.");
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
    const pending = await withFailureGuard(
      settlementReached,
      5_000,
      "MCP discovery did not reach the durable settlement barrier.",
    );
    const beforeDurableSettlement = await lifecycle.inspect({ sessionId: created.sessionId });
    const beforeMcp =
      beforeDurableSettlement.schemaVersion === 3 ? beforeDurableSettlement.mcp : undefined;

    expect({ beforeMcp, generationId: pending.generationId }).toMatchObject({
      beforeMcp: {
        status: "activation_required",
        activation: { generationId: pending.generationId, status: "activating" },
      },
    });
    expect(beforeMcp === undefined ? true : "catalog" in beforeMcp).toBe(false);

    releaseSettlement();
    await expect(activation).resolves.toMatchObject({
      snapshot: { mcp: { status: "tool_selection_required", activation: { status: "ready" } } },
    });
  } finally {
    releaseSettlement();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close racing ready publication leaves one replayable MCP settlement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-publication-close-race-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  let releaseSettlement = () => {};
  const settlementRelease = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  let announceSettlement = () => {};
  const settlementReached = new Promise<void>((resolve) => {
    announceSettlement = resolve;
  });
  const lifecycle = createSessionLifecycle({
    [mcpActivationSettlementBarrier]: {
      async beforeReadySettlement() {
        announceSettlement();
        await settlementRelease;
      },
    },
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
      throw new Error("The fixture requires one MCP server preview.");
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
    await withFailureGuard(
      settlementReached,
      5_000,
      "MCP discovery did not reach the durable settlement barrier.",
    );
    const closing = lifecycle.close();
    releaseSettlement();
    await expect(activation).rejects.toMatchObject({ code: "mcp_activation_cancelled" });
    await expect(closing).resolves.toEqual({ status: "closed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();

    const sessionPath = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    const settlements = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope)
      .filter((entry) => entry.record?.type === "mcp_activation_settled");
    expect(settlements).toHaveLength(1);

    const cold = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      mcp: { status: "activation_required", activation: { status: "cancelled" } },
    });
    await cold.close();
  } finally {
    releaseSettlement();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close aborts an active permission wait before taking the project owner", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-close-active-permission-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Close active permission\n");

  const driver = new FakeModelDriver(() => [
    { type: "tool_call_start", id: "read-before-close", name: "read_file" },
    {
      type: "tool_call_delta",
      id: "read-before-close",
      json: '{"path":"README.md"}',
    },
    { type: "tool_call_end", id: "read-before-close" },
    { type: "finish", reason: "tool_calls" },
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
            readiness: { status: "available", credentialSource: "test" },
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
    workspaceRoot,
  });
  let announcePermission:
    | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
    | undefined;
  const permissionRequested = new Promise<
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >((resolve) => {
    announcePermission = resolve;
  });
  lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      announcePermission?.(event);
    }
  });
  let pendingContinue: ReturnType<typeof lifecycle.continue> | undefined;
  let pendingRequestId: string | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity });
    pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the project file" },
      limits: { maxTurns: 2 },
    });
    const permission = await withFailureGuard(
      permissionRequested,
      5_000,
      "The active run did not reach its permission boundary.",
    );
    pendingRequestId = permission.requestId;
    await expect(
      withFailureGuard(
        lifecycle.close(),
        2_000,
        "SessionLifecycle.close did not abort the active permission wait.",
      ),
    ).resolves.toEqual({ status: "closed" });
    await expect(pendingContinue).resolves.toMatchObject({
      result: { status: "cancelled", error: { code: "session_cancelled" } },
    });
    expect(
      lifecycle.decidePermission({ requestId: permission.requestId, decision: "allow" }),
    ).toMatchObject({ status: "rejected" });
    await expect(
      lifecycle.continue({ sessionId: created.sessionId, input: { text: "Try again" } }),
    ).rejects.toMatchObject({ code: "session_invalid" });
  } finally {
    if (pendingRequestId !== undefined) {
      lifecycle.decidePermission({ requestId: pendingRequestId, decision: "deny" });
    }
    if (pendingContinue !== undefined) {
      await pendingContinue.catch(() => undefined);
    }
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects and closes an MCP server whose negotiated identity is not durable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-server-identity-bounds-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "oversized-server-identity"],
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

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({
      mcp: {
        status: "activation_failed",
        diagnostics: [{ code: "mcp_initialize_failed", serverId: "fixture" }],
      },
    });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle causally closes a prepared MCP generation when ready publication fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-publication-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  let rejectNextSettlement = true;
  const lifecycle = createSessionLifecycle({
    [mcpActivationSettlementBarrier]: {
      async beforeReadySettlement() {
        if (rejectNextSettlement) {
          rejectNextSettlement = false;
          throw new Error("injected durable publication failure");
        }
      },
    },
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
      throw new Error("The fixture requires one MCP server preview.");
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
    ).rejects.toMatchObject({ code: "mcp_start_failed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();

    const failed = await lifecycle.inspect({ sessionId: created.sessionId });
    const failedMcp =
      failed.schemaVersion === 3 && failed.mcp?.workspaceConfirmed === true
        ? failed.mcp
        : undefined;
    if (failedMcp?.activation?.status !== "failed") {
      throw new Error("The fixture requires one failed MCP activation.");
    }
    await expect(
      lifecycle.configureMcp({
        type: "retry_activation",
        sessionId: created.sessionId,
        generationId: failedMcp.activation.generationId,
      }),
    ).resolves.toMatchObject({
      snapshot: { mcp: { status: "tool_selection_required", activation: { status: "ready" } } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a cyclic tool cursor and closes the failed activation causally", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cursor-loop-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "cursor-loop"],
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

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [
          {
            serverId: preview.serverId,
            definitionDigest: preview.definitionDigest,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({
      lastSequence: 6,
      mcp: {
        status: "activation_failed",
        diagnostics: [{ code: "mcp_catalog_invalid", serverId: "fixture" }],
      },
    });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle surfaces unconfirmed activation shutdown without offering retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unconfirmed-activation-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "cursor-loop"],
        },
      },
    }),
  );
  let confirmationAttempts = 0;
  const lifecycle = createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    [mcpCloseConfirmation]: {
      async confirm() {
        confirmationAttempts += 1;
        throw new Error("Injected close-proof failure.");
      },
    },
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
      throw new Error("The fixture requires one MCP server preview.");
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
    ).rejects.toMatchObject({ code: "mcp_shutdown_unconfirmed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({
      mcp: {
        status: "mcp_shutdown_unconfirmed",
        diagnostics: [{ code: "mcp_shutdown_unconfirmed", serverId: "fixture" }],
      },
    });
    if (inspected.schemaVersion !== 3) {
      throw new Error("The fixture requires a current session snapshot.");
    }
    const generationId =
      inspected.mcp?.workspaceConfirmed === true
        ? inspected.mcp.activation?.generationId
        : undefined;
    if (generationId === undefined) {
      throw new Error("The fixture requires one terminal MCP generation.");
    }
    await expect(
      lifecycle.configureMcp({
        type: "retry_activation",
        sessionId: created.sessionId,
        generationId,
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(lifecycle.close()).resolves.toEqual({ status: "mcp_shutdown_unconfirmed" });
    expect(confirmationAttempts).toBe(1);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle durably fences an unconfirmed committed MCP shutdown across restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unconfirmed-committed-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  const initial = createSessionLifecycle({
    [mcpCloseConfirmation]: {
      async confirm() {
        throw new Error("Injected close-proof failure.");
      },
    },
    stateRoot,
    workspaceRoot,
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    await expect(initial.close()).resolves.toEqual({ status: "mcp_shutdown_unconfirmed" });
    await expect(initial.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: {
        status: "mcp_shutdown_unconfirmed",
        diagnostics: [{ code: "mcp_shutdown_unconfirmed" }],
      },
    });

    const modelTargets: ModelTargets = {
      async resolve() {
        throw new Error("The model must not resolve for an unconfirmed MCP shutdown.");
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
    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(cold.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: { status: "mcp_shutdown_unconfirmed" },
    });
    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not restart an unconfirmed MCP generation" },
      }),
    ).rejects.toMatchObject({ code: "mcp_shutdown_unconfirmed" });
    await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed\n");
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle explicitly retries the exact failed MCP activation generation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-explicit-retry-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const failedOnceMarker = join(testRoot, "failed-once");
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
            "fail-once-initialize",
            failedOnceMarker,
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
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });
    const failed = await lifecycle.inspect({ sessionId: created.sessionId });
    if (failed.schemaVersion !== 3) {
      throw new Error("The fixture requires a current session snapshot.");
    }
    if (failed.mcp?.status !== "activation_failed") {
      throw new Error("The fixture requires an activation-failed MCP snapshot.");
    }
    const failedActivation = failed.mcp.activation;
    if (failedActivation?.status !== "failed") {
      throw new Error("The fixture requires one failed MCP activation generation.");
    }

    const retried = await lifecycle.configureMcp({
      type: "retry_activation",
      sessionId: created.sessionId,
      generationId: failedActivation.generationId,
    });

    expect(retried).toMatchObject({
      status: "updated",
      snapshot: {
        mcp: {
          status: "tool_selection_required",
          activation: {
            attempt: 2,
            generationId: expect.not.stringMatching(failedActivation.generationId),
            status: "ready",
          },
        },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle atomically fails one MCP generation and causally closes every peer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-peer-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const blockedSpawn = join(testRoot, "blocked-spawned");
  const blockedClose = join(testRoot, "blocked-closed");
  const blockedGate = join(testRoot, "blocked-gate");
  const failingSpawn = join(testRoot, "failing-spawned");
  const failingClose = join(testRoot, "failing-closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        blocked: {
          command: process.execPath,
          args: [mcpServerFixturePath, blockedSpawn, blockedClose, "gated-initialize", blockedGate],
        },
        failing: {
          command: process.execPath,
          args: [
            mcpServerFixturePath,
            failingSpawn,
            failingClose,
            "fail-initialize-after-gate",
            blockedSpawn,
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
    let configured = await lifecycle.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    for (const server of configured.snapshot.mcp?.servers ?? []) {
      configured = await lifecycle.configureMcp({
        type: "approve_server",
        sessionId: created.sessionId,
        serverId: server.serverId,
        definitionDigest: server.definitionDigest,
      });
    }
    const approved = configured.snapshot.mcp?.servers ?? [];
    expect(approved.map((server) => server.status)).toEqual(["approved", "approved"]);
    await expect(stat(blockedSpawn)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(failingSpawn)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      withFailureGuard(
        lifecycle.configureMcp({
          type: "activate_servers",
          sessionId: created.sessionId,
          servers: approved.map((server) => ({
            serverId: server.serverId,
            definitionDigest: server.definitionDigest,
          })),
        }),
        5_000,
        "Peer failure did not settle the MCP generation causally.",
      ),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });

    const pids = await Promise.all(
      [blockedSpawn, failingSpawn].map(async (path) =>
        Number.parseInt(await readFile(path, "utf8"), 10),
      ),
    );
    expect(
      pids.map((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }),
    ).toEqual([true, true]);
    expect(await readFile(blockedClose, "utf8")).toBe("closed\n");
    const failedSnapshot = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(failedSnapshot).toMatchObject({ mcp: { status: "activation_failed" } });
    expect(
      failedSnapshot.schemaVersion === 3 && failedSnapshot.mcp !== undefined
        ? {
            catalog: "catalog" in failedSnapshot.mcp,
            profile: "profile" in failedSnapshot.mcp,
          }
        : undefined,
    ).toEqual({ catalog: false, profile: false });

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
      .map((line) => JSON.parse(line));
    const settled = records.findLast((entry) => entry.record?.type === "mcp_activation_settled");
    expect(settled?.record).toMatchObject({
      status: "failed",
      error: { code: "mcp_initialize_failed", serverId: "failing" },
    });
    const closeRecords = records
      .filter((entry) => entry.record?.type === "mcp_server_closed")
      .map((entry) => ({
        serverId: entry.record.serverId,
        reason: entry.record.reason,
      }));
    expect(closeRecords).toEqual([
      { serverId: "blocked", reason: "peer_failure" },
      { serverId: "failing", reason: "failed" },
    ]);
    expect(
      records
        .filter((entry) =>
          ["mcp_activation_started", "mcp_server_closed", "mcp_activation_settled"].includes(
            entry.record?.type,
          ),
        )
        .map((entry) => entry.record.type),
    ).toEqual([
      "mcp_activation_started",
      "mcp_server_closed",
      "mcp_server_closed",
      "mcp_activation_settled",
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancels an uncommitted MCP generation and returns to base-only behavior", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cancel-configuration-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    return [
      { type: "text_delta", text: "Returned to base-only behavior." },
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
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const generationId = activeMcp.activation?.generationId;
    if (generationId === undefined) {
      throw new Error("The fixture requires an active MCP generation.");
    }

    const cancelled = await lifecycle.configureMcp({
      type: "cancel_configuration",
      sessionId: created.sessionId,
      generationId,
    });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Continue without MCP" },
    });

    expect({ cancelled, continued, requestCount: requests.length }).toMatchObject({
      cancelled: {
        status: "updated",
        snapshot: {
          mcp: {
            status: "activation_required",
            activation: { generationId, status: "cancelled" },
          },
        },
      },
      continued: {
        result: { status: "completed", answer: "Returned to base-only behavior." },
      },
      requestCount: 1,
    });
    expect(requests[0]?.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancels an activation blocked in initialize without waiting for its owner lock", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cancel-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const initializeGate = join(testRoot, "initialize-gate");
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

    const spawned = observeFileCreation(spawnMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const activationSettlement = activation.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await spawned;
    const activating = await lifecycle.inspect({ sessionId: created.sessionId });
    const activatingMcp = activating.schemaVersion === 3 ? activating.mcp : undefined;
    if (
      activatingMcp === undefined ||
      !activatingMcp.workspaceConfirmed ||
      activatingMcp.activation?.status !== "activating"
    ) {
      throw new Error("The fixture requires one activating MCP generation.");
    }
    const generationId = activatingMcp.activation.generationId;

    const cancelled = await lifecycle.configureMcp({
      type: "cancel_configuration",
      sessionId: created.sessionId,
      generationId,
    });

    expect(await activationSettlement).toMatchObject({
      status: "rejected",
      error: { code: "mcp_activation_cancelled" },
    });
    expect(cancelled).toMatchObject({
      status: "updated",
      snapshot: {
        mcp: {
          status: "activation_required",
          activation: { generationId, status: "cancelled" },
        },
      },
    });
    await expect(stat(closeMarker)).resolves.toBeDefined();
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
    expect(terminalRecords).toEqual([
      { type: "mcp_activation_started", status: undefined, reason: "initial" },
      { type: "mcp_server_closed", status: undefined, reason: "session_close" },
      { type: "mcp_activation_settled", status: "cancelled", reason: undefined },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle bounds initialize and discovery with a deterministic total deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-discovery-timeout-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const initializeGate = join(testRoot, "initialize-gate");
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
          ],
        },
      },
    }),
  );

  const manualDiscoveryDeadline = createManualMcpIdleScheduler();
  const lifecycle = createSessionLifecycle({
    [mcpDiscoveryScheduler]: manualDiscoveryDeadline.scheduler,
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
      throw new Error("The fixture requires one MCP server preview.");
    }
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const spawned = observeFileCreation(spawnMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const observedActivation = activation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await spawned;
    const fixturePid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    await manualDiscoveryDeadline.advanceBy(30_000);
    const outcome = await observedActivation;
    let fixtureAbsent = false;
    try {
      process.kill(fixturePid, 0);
    } catch (error) {
      fixtureAbsent = error instanceof Error && "code" in error && error.code === "ESRCH";
    }

    expect({ outcome, fixtureAbsent }).toMatchObject({
      outcome: { status: "rejected", error: { code: "mcp_startup_timeout" } },
      fixtureAbsent: true,
    });
  } finally {
    await writeFile(initializeGate, "cleanup").catch(() => undefined);
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an oversized MCP tool definition without truncation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-definition-limit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "oversized-definition"],
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

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_too_large" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle orders MCP catalog identity by code unit rather than host locale", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-canonical-order-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "unicode-tool-order"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires one ready MCP catalog.");
    }
    expect(activeMcp.catalog?.tools.map((tool) => tool.originalName)).toEqual(["zeta", "äther"]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies an MCP catalog over 256 tools as too large", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-catalog-tool-limit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "catalog-tool-overflow"],
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

    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_too_large" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects root allOf local references without narrowing the raw MCP schema", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-allof-projection-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "allof-schema"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");

    expect(echo).toMatchObject({
      inputSchema: {
        type: "object",
        $defs: {
          left: {
            type: "object",
            properties: { left: { type: "string" } },
            required: ["left"],
          },
          right: {
            type: "object",
            properties: { right: { type: "integer" } },
            required: ["right"],
          },
        },
        properties: { left: { type: "string" }, right: { type: "integer" } },
        required: ["left", "right"],
        additionalProperties: false,
      },
    });
    expect(echo?.inputSchema).not.toHaveProperty("allOf");
    expect(echo?.rawSchemaDigest).not.toBe(echo?.modelProjectionDigest);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle quarantines a recursive MCP schema without hiding its healthy sibling", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-recursive-schema-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "recursive-schema"],
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

    expect(activated.snapshot.mcp).toMatchObject({
      status: "tool_selection_required",
      catalog: {
        tools: [{ serverId: "fixture", originalName: "uppercase" }],
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle admits bounded local schema references while quarantining cyclic and remote siblings", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-schema-references-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "schema-reference-admission"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required" || activeMcp.catalog === undefined) {
      throw new Error("The fixture requires an admitted MCP catalog.");
    }

    expect(activeMcp.catalog.tools.map((tool) => tool.originalName)).toEqual([
      "bounded_local_ref",
      "plain_good",
    ]);
    expect(activeMcp.catalog.tools[0]?.inputSchema).toEqual({
      type: "object",
      $defs: {
        payload: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      properties: { payload: { $ref: "#/$defs/payload" } },
      required: ["payload"],
      additionalProperties: false,
    });
    expect(activeMcp.diagnostics).toEqual([]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle enforces the MCP local reference-chain depth at the 16/17 boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-schema-reference-depth-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "schema-reference-depth"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required" || activeMcp.catalog === undefined) {
      throw new Error("The fixture requires one admitted MCP catalog.");
    }

    expect(activeMcp.catalog.tools.map((tool) => tool.originalName)).toEqual([
      "plain_good",
      "within_limit",
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle broadens a root oneOf projection and labels its branch requirements", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-oneof-schema-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "oneof-schema"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");

    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: {
        kind: {},
        left: {},
        right: {},
      },
      required: ["kind"],
    });
    expect(echo?.description).toContain(
      "Compatibility hint: oneOf branches require [kind, left] or [kind, right].",
    );
  } finally {
    await lifecycle.close();
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

test("SessionLifecycle rejects a selected MCP Tool Profile above its aggregate definition limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-profile-overflow-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "selection-overflow"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required" || activeMcp.catalog === undefined) {
      throw new Error("The fixture requires a selectable MCP catalog.");
    }
    expect(activeMcp.catalog.tools).toHaveLength(20);

    await expect(
      lifecycle.configureMcp({
        type: "commit_tool_profile",
        sessionId: created.sessionId,
        generationId: activeMcp.activation?.generationId as string,
        selections: activeMcp.catalog.tools.map((tool) => ({
          qualifiedName: tool.qualifiedName,
          definitionDigest: tool.definitionDigest,
          effect: "read" as const,
        })),
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    if (inspected.schemaVersion !== 3) {
      throw new Error("The B8 fixture requires a current session snapshot.");
    }
    expect(inspected.mcp?.status).toBe("tool_selection_required");
    expect(inspected.mcp === undefined ? true : "profile" in inspected.mcp).toBe(false);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects 21 selected MCP tools without truncation and admits exactly 20", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-profile-count-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "selection-count-boundary"],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required" || activeMcp.catalog === undefined) {
      throw new Error("The fixture requires a selectable MCP catalog.");
    }
    const selections = activeMcp.catalog.tools.map((tool) => ({
      qualifiedName: tool.qualifiedName,
      definitionDigest: tool.definitionDigest,
      effect: "read" as const,
    }));
    expect(selections).toHaveLength(21);

    await expect(
      lifecycle.configureMcp({
        type: "commit_tool_profile",
        sessionId: created.sessionId,
        generationId: activeMcp.activation?.generationId as string,
        selections,
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    await expect(
      lifecycle.configureMcp({
        type: "commit_tool_profile",
        sessionId: created.sessionId,
        generationId: activeMcp.activation?.generationId as string,
        selections: selections.slice(0, 20),
      }),
    ).resolves.toMatchObject({ snapshot: { mcp: { status: "profile_committed" } } });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits one discovery-bound MCP Tool Profile before making it visible", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }

    const committed = await lifecycle.configureMcp({
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
    const expectedProfile = {
      version: 1,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      projectorVersion: 1,
      tools: [
        {
          serverId: "fixture",
          originalName: "echo",
          qualifiedName: echo.qualifiedName,
          definitionDigest: echo.definitionDigest,
          rawSchemaDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          modelProjectionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          effect: "read",
        },
      ],
    };
    expect(committed).toMatchObject({
      status: "updated",
      snapshot: {
        lastSequence: 6,
        mcp: { status: "profile_committed", profile: expectedProfile },
      },
    });
    await expect(
      lifecycle.configureMcp({
        type: "commit_tool_profile",
        sessionId: created.sessionId,
        generationId,
        selections: [
          {
            qualifiedName: echo.qualifiedName,
            definitionDigest: echo.definitionDigest,
            effect: "write",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    const sessionPath = join(
      stateRoot,
      "projects",
      committed.snapshot.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    expect(
      (await readFile(sessionPath, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => JSON.parse(line).record?.type === "mcp_tool_profile_committed"),
    ).toHaveLength(1);

    const cold = await createSessionLifecycle({ stateRoot, workspaceRoot }).inspect({
      sessionId: created.sessionId,
    });
    expect(cold).toMatchObject({
      lastSequence: 6,
      mcp: { status: "profile_reactivation_required", profile: expectedProfile },
    });
  } finally {
    const closed = await lifecycle.close();
    expect(closed).toEqual({ status: "closed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits MCP after a base-only run and exposes it only to the next run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-after-base-run-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    return [
      {
        type: "text_delta",
        text: requests.length === 1 ? "Base-only run completed." : "MCP profile is now visible.",
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
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

  try {
    const created = await lifecycle.create({ targetIdentity });
    const first = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Complete one base-only run" },
    });
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }
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
    const second = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Start the next run with MCP" },
    });

    expect({ first, second, requestCount: requests.length }).toMatchObject({
      first: { result: { status: "completed", answer: "Base-only run completed." } },
      second: { result: { status: "completed", answer: "MCP profile is now visible." } },
      requestCount: 2,
    });
    expect(requests[0]?.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    expect(requests[1]?.tools.map((tool) => tool.name)).toContain(echo.qualifiedName);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Complete one base-only run" }),
        expect.objectContaining({ role: "assistant", content: "Base-only run completed." }),
        expect.objectContaining({ role: "user", content: "Start the next run with MCP" }),
      ]),
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle idle-closes a committed MCP generation and reactivates it before permission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-idle-reactivation-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "ordinary", callMarker],
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
        { type: "tool_call_start", id: "mcp-after-idle", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-after-idle", json: '{"value":"idle"}' },
        { type: "tool_call_end", id: "mcp-after-idle" },
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
          content: [{ type: "text", text: "idle" }],
          structuredContent: { echoed: "idle" },
          isError: false,
        });
    return [
      { type: "text_delta", text: accepted ? "Idle MCP returned." : "Idle MCP failed." },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  let resolvePermissionRequest:
    | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
    | undefined;
  const permissionRequested = new Promise<
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >((resolve) => {
    resolvePermissionRequest = resolve;
  });
  lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested" && event.callId === "mcp-after-idle") {
      resolvePermissionRequest?.(event);
    }
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
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
    const initialPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);

    await manualIdle.advanceBy(10 * 60 * 1_000);

    expect(await readFile(closeMarker, "utf8")).toBe("closed\n");
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      mcp: { status: "profile_reactivation_required" },
    });

    const pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Use MCP after its idle close" },
      limits: { maxTurns: 2 },
    });
    const permission = await permissionRequested;
    const reactivatedPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    await expect(stat(callMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(reactivatedPid).not.toBe(initialPid);
    expect(
      lifecycle.decidePermission({ requestId: permission.requestId, decision: "allow" }),
    ).toEqual({ status: "accepted" });
    const continued = await pendingContinue;
    expect(continued.result).toEqual({ status: "completed", answer: "Idle MCP returned." });

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
      .map((line) => JSON.parse(line));
    const idleTransitions = records.slice(6).flatMap((entry) => {
      if (
        entry.record?.type === "mcp_server_closed" ||
        entry.record?.type === "mcp_activation_started" ||
        entry.record?.type === "mcp_activation_settled"
      ) {
        return [
          {
            type: entry.record.type,
            reason: entry.record.reason,
            attempt: entry.record.attempt,
          },
        ];
      }
      const event = entry.record?.type === "runtime_event" ? entry.record.event : undefined;
      return event?.callId === "mcp-after-idle"
        ? [{ type: event.type, attempt: undefined, reason: undefined }]
        : [];
    });
    expect(idleTransitions).toEqual([
      { type: "mcp_server_closed", reason: "idle", attempt: 1 },
      { type: "mcp_activation_started", reason: "idle_reactivate", attempt: 2 },
      { type: "mcp_activation_settled", reason: undefined, attempt: 2 },
      { type: "tool_requested", reason: undefined, attempt: undefined },
      { type: "tool_permission_requested", reason: undefined, attempt: undefined },
      { type: "tool_permission_decided", reason: undefined, attempt: undefined },
      { type: "tool_started", reason: undefined, attempt: undefined },
      { type: "tool_completed", reason: undefined, attempt: undefined },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cold-reactivates an exact committed MCP profile before model use", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cold-reactivation-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "ordinary", callMarker],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      if (request.tools.every((tool) => tool.name !== qualifiedName)) {
        throw new Error("The cold-reactivated MCP tool was not visible to the model.");
      }
      return [
        { type: "tool_call_start", id: "mcp-cold", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-cold", json: '{"value":"cold"}' },
        { type: "tool_call_end", id: "mcp-cold" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Cold MCP profile restored." },
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
  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const created = await initial.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await initial.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await initial.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const activated = await initial.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }
    qualifiedName = echo.qualifiedName;
    await initial.configureMcp({
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
    const initialPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);
    expect(await initial.close()).toEqual({ status: "closed" });

    cold = createSessionLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });
    const resumed = await cold.resume({ sessionId: created.sessionId });
    if (resumed.status === "rejected") {
      throw new Error(`Cold MCP resume rejected: ${JSON.stringify(resumed.error)}`);
    }
    expect(resumed).toMatchObject({
      status: "ready",
      snapshot: { mcp: { status: "profile_reactivation_required" } },
    });
    const continued = await cold.continue({
      sessionId: created.sessionId,
      input: { text: "Use the exact cold MCP profile" },
      limits: { maxTurns: 2 },
    });
    const reactivatedPid = Number.parseInt(await readFile(spawnMarker, "utf8"), 10);

    expect({
      continued,
      requestCount: requests.length,
      freshProcess: reactivatedPid !== initialPid,
    }).toMatchObject({
      continued: { result: { status: "completed", answer: "Cold MCP profile restored." } },
      requestCount: 2,
      freshProcess: true,
    });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "cold" },
    });
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects changed negotiated MCP server identity before model use", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-server-identity-change-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const versionMarker = join(testRoot, "server-version");
  await mkdir(workspaceRoot);
  await writeFile(versionMarker, "1.0.0");
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
            "server-version-from-file",
            versionMarker,
          ],
        },
      },
    }),
  );

  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    await writeFile(versionMarker, "2.0.0");
    let modelRequestCount = 0;
    const driver = new FakeModelDriver(() => {
      modelRequestCount += 1;
      throw new Error("The model must not run after negotiated MCP identity changes.");
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
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });

    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not rebind a changed MCP server identity" },
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    expect(modelRequestCount).toBe(0);
    await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed\nclosed\n");
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

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

test("SessionLifecycle records causal closure before a changed cold MCP profile fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cold-profile-change-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const schemaMarker = join(testRoot, "schema-type");
  await mkdir(workspaceRoot);
  await writeFile(schemaMarker, "string");
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "schema-from-file", schemaMarker],
        },
      },
    }),
  );
  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    expect(await initial.close()).toEqual({ status: "closed" });
    await writeFile(schemaMarker, "integer");
    let modelRequests = 0;
    const driver = new FakeModelDriver(() => {
      modelRequests += 1;
      return [
        { type: "text_delta", text: "must not run" },
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
    cold = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });

    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not use a changed MCP profile" },
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    expect(modelRequests).toBe(0);
    expect(await readFile(closeMarker, "utf8")).toBe("closed\nclosed\n");
    const sessionPath = join(
      stateRoot,
      "projects",
      (await cold.inspect({ sessionId: committed.sessionId })).projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${committed.sessionId}.jsonl`,
    );
    const records = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const started = records.findLast(
      (entry) =>
        entry.record?.type === "mcp_activation_started" &&
        entry.record?.reason === "idle_reactivate",
    );
    expect(
      records
        .filter((entry) => entry.record?.generationId === started?.record?.generationId)
        .map((entry) => ({
          type: entry.record.type,
          reason: entry.record.reason,
          status: entry.record.status,
          error: entry.record.error,
        })),
    ).toEqual([
      {
        type: "mcp_activation_started",
        reason: "idle_reactivate",
        status: undefined,
        error: undefined,
      },
      {
        type: "mcp_server_closed",
        reason: "stale",
        status: undefined,
        error: undefined,
      },
      {
        type: "mcp_activation_settled",
        reason: undefined,
        status: "failed",
        error: { code: "mcp_catalog_invalid" },
      },
    ]);
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle lets a branch approve against an inherited workspace confirmation only", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-branch-confirmation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
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
    const child = await lifecycle.branch({
      parentSessionId: created.sessionId,
      atSequence: confirmed.snapshot.lastSequence,
    });
    await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });

    const childBeforeApproval = await lifecycle.inspect({ sessionId: child.sessionId });
    expect(childBeforeApproval).toMatchObject({
      mcp: { workspaceConfirmed: true, status: "server_approval_required" },
    });
    const childApproved = await lifecycle.configureMcp({
      type: "approve_server",
      sessionId: child.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    expect(childApproved.snapshot).toMatchObject({
      mcp: { workspaceConfirmed: true, status: "activation_required" },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle inherits MCP authority only through the exact branch prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-branch-prefix-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "ordinary", callMarker],
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
        { type: "tool_call_start", id: "mcp-branch", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-branch", json: '{"value":"branch"}' },
        { type: "tool_call_end", id: "mcp-branch" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Branch MCP profile restored." },
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
  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const created = await initial.create({ targetIdentity });
    if (created.mcp === undefined) {
      throw new Error("The fixture requires an MCP configuration snapshot.");
    }
    const confirmed = await initial.configureMcp({
      type: "confirm_workspace",
      sessionId: created.sessionId,
      sourceDigest: created.mcp.source.digest,
    });
    const preview = confirmed.snapshot.mcp?.servers[0];
    if (preview === undefined) {
      throw new Error("The fixture requires one MCP server preview.");
    }
    await initial.configureMcp({
      type: "approve_server",
      sessionId: created.sessionId,
      serverId: preview.serverId,
      definitionDigest: preview.definitionDigest,
    });
    const activated = await initial.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }
    qualifiedName = echo.qualifiedName;
    const committed = await initial.configureMcp({
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
    const committedMcp = committed.snapshot.mcp;
    if (committedMcp?.status !== "profile_committed") {
      throw new Error("The fixture requires a committed MCP profile.");
    }
    const profileDigest = committedMcp.profile?.digest;
    const preCommit = await initial.branch({ parentSessionId: created.sessionId, atSequence: 3 });
    const postCommit = await initial.branch({ parentSessionId: created.sessionId, atSequence: 6 });

    expect(preCommit).toMatchObject({
      promptContext: { profileVersion: 3 },
      mcp: {
        status: "activation_required",
        workspaceConfirmed: true,
        servers: [{ serverId: "fixture", status: "approved" }],
      },
    });
    expect(preCommit.promptContext === undefined || "mcp" in preCommit.promptContext).toBe(false);
    expect(postCommit).toMatchObject({
      promptContext: { profileVersion: 3, mcp: { profileDigest } },
      mcp: {
        status: "profile_reactivation_required",
        workspaceConfirmed: true,
        profile: { digest: profileDigest },
      },
    });
    expect(await initial.close()).toEqual({ status: "closed" });

    cold = createSessionLifecycle({
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });
    const continued = await cold.continue({
      sessionId: postCommit.sessionId,
      input: { text: "Use the inherited exact MCP profile" },
      limits: { maxTurns: 2 },
    });
    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: { result: { status: "completed", answer: "Branch MCP profile restored." } },
      requestCount: 2,
    });
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a child activation outside its inherited MCP approval prefix", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-branch-authority-tamper-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "ordinary", callMarker],
        },
      },
    }),
  );
  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    const child = await lifecycle.branch({
      parentSessionId: committed.sessionId,
      atSequence: 6,
    });
    const childPath = join(
      stateRoot,
      "projects",
      child.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${child.sessionId}.jsonl`,
    );
    const generationId = randomUUID();
    const forgedDigest = `sha256:${"f".repeat(64)}`;
    await appendFile(
      childPath,
      `${JSON.stringify({
        schemaVersion: 3,
        sequence: 2,
        record: {
          type: "mcp_activation_started",
          recordVersion: 1,
          generationId,
          attempt: 1,
          reason: "idle_reactivate",
          servers: [
            {
              serverId: "fixture",
              definitionDigest: forgedDigest,
              startupEffects: ["execute"],
            },
          ],
        },
      })}\n${JSON.stringify({
        schemaVersion: 3,
        sequence: 3,
        record: {
          type: "mcp_activation_settled",
          recordVersion: 1,
          generationId,
          attempt: 1,
          status: "failed",
          servers: [],
          error: { code: "mcp_start_failed", serverId: "fixture" },
        },
      })}\n`,
    );

    await expect(lifecycle.inspect({ sessionId: child.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps user-assigned MCP effect authority over server annotations", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-invocation-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "annotated-readonly", callMarker],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (!request.messages.some((message) => message.role === "tool")) {
      const selected = request.tools.find((tool) => tool.name === qualifiedName);
      if (selected === undefined) {
        throw new Error("The selected MCP tool was not visible to the model.");
      }
      return [
        { type: "tool_call_start", id: "mcp-echo", name: selected.name },
        { type: "tool_call_delta", id: "mcp-echo", json: '{"value":"hello"}' },
        { type: "tool_call_end", id: "mcp-echo" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const answer =
      latest?.role === "tool" &&
      latest.name === qualifiedName &&
      JSON.stringify(latest.result) ===
        JSON.stringify({
          status: "completed",
          output: {
            version: 1,
            content: [{ type: "text", text: "hello" }],
            structuredContent: { echoed: "hello" },
            isError: false,
          },
        })
        ? "MCP returned hello."
        : "Unexpected MCP result.";
    return [
      { type: "text_delta", text: answer },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  let resolvePermissionRequest:
    | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
    | undefined;
  const permissionRequested = new Promise<
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >((resolve) => {
    resolvePermissionRequest = resolve;
  });
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested" && event.callId === "mcp-echo") {
      resolvePermissionRequest?.(event);
    }
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }
    qualifiedName = echo.qualifiedName;
    const committed = await lifecycle.configureMcp({
      type: "commit_tool_profile",
      sessionId: created.sessionId,
      generationId,
      selections: [
        {
          qualifiedName: echo.qualifiedName,
          definitionDigest: echo.definitionDigest,
          effect: "execute",
        },
      ],
    });
    const committedMcp = committed.snapshot.mcp;
    if (committedMcp?.status !== "profile_committed" || committedMcp.profile === undefined) {
      throw new Error("The fixture requires one committed MCP Tool Profile.");
    }

    expect(committed.snapshot).toMatchObject({
      promptContext: {
        profileVersion: 3,
        assemblyVersion: 3,
        mcp: {
          version: 1,
          profileDigest: committedMcp.profile.digest,
          generationId,
          projectorVersion: 1,
        },
      },
    });

    const pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Echo hello through MCP" },
      limits: { maxTurns: 2 },
    });
    const permissionRequest = await permissionRequested;
    await expect(stat(callMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      lifecycle.decidePermission({ requestId: permissionRequest.requestId, decision: "allow" }),
    ).toEqual({ status: "accepted" });
    const continued = await pendingContinue;
    const toolEvents = events.filter((event) => "callId" in event && event.callId === "mcp-echo");
    const secondRequestToolResult = requests[1]?.messages.find(
      (message) => message.role === "tool" && message.name === qualifiedName,
    );

    const subject = {
      type: "mcp_tool" as const,
      serverId: "fixture",
      qualifiedName,
      originalName: "echo",
      serverDefinitionDigest: preview.definitionDigest,
      definitionDigest: echo.definitionDigest,
      argumentsDigest: "sha256:5e99d76e946ff987af1402a9ef575fb4fbf3d2bc668d8be30ad48aac48cc3878",
    };
    expect({ continued, secondRequestToolResult, requestCount: requests.length }).toMatchObject({
      continued: { result: { status: "completed", answer: "MCP returned hello." } },
      secondRequestToolResult: {
        role: "tool",
        result: {
          status: "completed",
          output: {
            version: 1,
            content: [{ type: "text", text: "hello" }],
            structuredContent: { echoed: "hello" },
            isError: false,
          },
        },
      },
      requestCount: 2,
    });
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "run_shell",
      "activate_skill",
      "read_skill_resource",
      qualifiedName,
    ]);
    expect(requests[0]?.tools.find((tool) => tool.name === qualifiedName)?.description).toBe(
      'External MCP tool from approved server "fixture". Adam effect: execute. Echo a value.',
    );
    expect(toolEvents).toEqual([
      { type: "tool_requested", callId: "mcp-echo", name: qualifiedName },
      {
        type: "tool_permission_requested",
        requestId: permissionRequest.requestId,
        callId: "mcp-echo",
        name: qualifiedName,
        effect: "execute",
        scope: "call",
        subject,
      },
      {
        type: "tool_permission_decided",
        requestId: permissionRequest.requestId,
        callId: "mcp-echo",
        name: qualifiedName,
        decision: "allow",
        effect: "execute",
        scope: "call",
        subject,
      },
      { type: "tool_started", callId: "mcp-echo", name: qualifiedName },
      {
        type: "tool_completed",
        callId: "mcp-echo",
        name: qualifiedName,
        output: {
          version: 1,
          content: [{ type: "text", text: "hello" }],
          structuredContent: { echoed: "hello" },
          isError: false,
        },
      },
    ]);
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "hello" },
    });
  } finally {
    const closed = await lifecycle.close();
    expect(closed).toEqual({ status: "closed" });
    await expect(stat(closeMarker)).resolves.toBeDefined();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a core and MCP qualified-name collision before model use", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-qualified-collision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  const initial = createSessionLifecycle({ stateRoot, workspaceRoot });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    const base = createCodingToolRegistry({ workspaceRoot });
    const collidingDefinition = {
      name: committed.qualifiedName,
      description: "A conflicting core tool definition.",
      inputSchema: { type: "object", properties: {} },
    };
    const tools = {
      definitions: () => [...base.definitions(), collidingDefinition],
      resolve: (name: string) => base.resolve(name),
    };
    let modelSnapshotCalls = 0;
    const modelTargets: ModelTargets = {
      async resolve() {
        throw new Error("The model must not resolve after a tool-name collision.");
      },
      async snapshot() {
        modelSnapshotCalls += 1;
        return { targets: [] };
      },
    };
    cold = createSessionLifecycle({ modelTargets, stateRoot, tools, workspaceRoot });

    await expect(cold.resume({ sessionId: committed.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    expect(modelSnapshotCalls).toBe(0);
  } finally {
    await initial.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle completes an MCP tool-level error response without treating it as transport failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-tool-error-result-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "tool-error-result", callMarker],
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
        { type: "tool_call_start", id: "mcp-tool-error", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-tool-error", json: '{"value":"denied"}' },
        { type: "tool_call_end", id: "mcp-tool-error" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      JSON.stringify(latest.result) ===
        JSON.stringify({
          status: "completed",
          output: {
            version: 1,
            content: [{ type: "text", text: "denied" }],
            structuredContent: { echoed: "denied" },
            isError: true,
          },
        });
    return [
      {
        type: "text_delta",
        text: accepted ? "MCP tool error was complete." : "MCP tool error was misclassified.",
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
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Call the MCP tool that returns a tool-level error" },
      limits: { maxTurns: 2 },
    });

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: { status: "completed", answer: "MCP tool error was complete." },
      },
      requestCount: 2,
    });
    expect(
      events.find((event) => event.type === "tool_completed" && event.callId === "mcp-tool-error"),
    ).toEqual({
      type: "tool_completed",
      callId: "mcp-tool-error",
      name: qualifiedName,
      output: {
        version: 1,
        content: [{ type: "text", text: "denied" }],
        structuredContent: { echoed: "denied" },
        isError: true,
      },
    });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "denied" },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle treats a complete correlated MCP protocol error as determinate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-correlated-error-"));
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
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "jsonrpc-error-on-call",
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
        { type: "tool_call_start", id: "mcp-correlated-error", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-correlated-error", json: '{"value":"once"}' },
        { type: "tool_call_end", id: "mcp-correlated-error" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      latest.result.status === "failed" &&
      latest.result.error.code === "mcp_protocol_error";
    return [
      {
        type: "text_delta",
        text: accepted ? "Correlated MCP error was determinate." : "MCP error was ambiguous.",
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
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Call the MCP tool that returns a JSON-RPC error" },
      limits: { maxTurns: 2 },
    });

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: { status: "completed", answer: "Correlated MCP error was determinate." },
      },
      requestCount: 2,
    });
    expect(
      events.find(
        (event) => event.type === "tool_failed" && event.callId === "mcp-correlated-error",
      ),
    ).toEqual({
      type: "tool_failed",
      callId: "mcp-correlated-error",
      name: qualifiedName,
      error: {
        code: "mcp_protocol_error",
        message: "The MCP server returned a complete protocol error response.",
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects invalid raw MCP arguments before permission or dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-invalid-input-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "ordinary", callMarker],
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
        { type: "tool_call_start", id: "mcp-invalid-input", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-invalid-input", json: "{}" },
        { type: "tool_call_end", id: "mcp-invalid-input" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      JSON.stringify(latest.result) ===
        JSON.stringify({
          status: "failed",
          error: {
            code: "invalid_tool_input",
            message: "The MCP tool arguments do not match the approved input schema.",
          },
        });
    return [
      {
        type: "text_delta",
        text: accepted ? "Invalid MCP input rejected." : "Invalid MCP input escaped.",
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
            readiness: { status: "available", credentialSource: "test" },
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
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Attempt an invalid MCP call" },
      limits: { maxTurns: 2 },
    });
    const toolEvents = events.filter(
      (event) => "callId" in event && event.callId === "mcp-invalid-input",
    );

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: { status: "completed", answer: "Invalid MCP input rejected." },
      },
      requestCount: 2,
    });
    expect(toolEvents).toEqual([
      { type: "tool_requested", callId: "mcp-invalid-input", name: qualifiedName },
      {
        type: "tool_failed",
        callId: "mcp-invalid-input",
        name: qualifiedName,
        error: {
          code: "invalid_tool_input",
          message: "The MCP tool arguments do not match the approved input schema.",
        },
      },
    ]);
    await expect(stat(callMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle spills a complete MCP result above 64 KiB before publishing it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-large-result-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "large-result", callMarker],
        },
      },
    }),
  );

  const fullText = "x".repeat(70_000);
  const fullEnvelopeBytes = Buffer.from(
    `{"content":[{"text":"${fullText}","type":"text"}],"isError":false,"version":1}`,
    "utf8",
  );
  const expectedArtifactId = `sha256:${createHash("sha256")
    .update(fullEnvelopeBytes)
    .digest("hex")}`;
  let qualifiedName: string | undefined;
  let definitionDigest: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-large", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-large", json: '{"value":"large"}' },
        { type: "tool_call_end", id: "mcp-large" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const output =
      latest?.role === "tool" && latest.result.status === "completed"
        ? latest.result.output
        : undefined;
    const artifact =
      typeof output === "object" &&
      output !== null &&
      !Array.isArray(output) &&
      "artifact" in output
        ? (output as { readonly artifact?: unknown }).artifact
        : undefined;
    const accepted =
      artifact !== undefined &&
      JSON.stringify(artifact) ===
        JSON.stringify({
          id: expectedArtifactId,
          mediaType: "application/json",
          byteCount: fullEnvelopeBytes.byteLength,
          source: {
            type: "mcp_tool_result",
            schemaVersion: 1,
            callId: "mcp-large",
            toolName: qualifiedName,
            serverId: "fixture",
            originalName: "echo",
            definitionDigest,
          },
        });
    return [
      { type: "text_delta", text: accepted ? "MCP result spilled." : "Unexpected MCP result." },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
    }
    qualifiedName = echo.qualifiedName;
    definitionDigest = echo.definitionDigest;
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
      input: { text: "Store the large MCP result" },
      limits: { maxTurns: 2 },
    });
    const completed = events.find(
      (event): event is Extract<RuntimeEvent, { readonly type: "tool_completed" }> =>
        event.type === "tool_completed" && event.callId === "mcp-large",
    );
    if (completed === undefined) {
      throw new Error("The fixture requires one completed MCP call.");
    }

    expect(continued.result).toEqual({ status: "completed", answer: "MCP result spilled." });
    expect(Buffer.byteLength(JSON.stringify(completed.output), "utf8")).toBeLessThanOrEqual(65_536);
    expect(completed.output).toMatchObject({
      version: 1,
      content: [{ type: "text", text: "x".repeat(4_096), truncated: true, totalBytes: 70_000 }],
      isError: false,
      artifact: {
        id: expectedArtifactId,
        mediaType: "application/json",
        byteCount: fullEnvelopeBytes.byteLength,
      },
    });
    await expect(
      readFile(join(stateRoot, "artifacts", expectedArtifactId.slice("sha256:".length))),
    ).resolves.toEqual(fullEnvelopeBytes);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies a post-dispatch MCP disconnect without another model turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-indeterminate-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "close-on-call", callMarker],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      if (request.tools.every((tool) => tool.name !== qualifiedName)) {
        throw new Error("The selected MCP tool was not visible to the model.");
      }
      return [
        { type: "tool_call_start", id: "mcp-uncertain", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-uncertain", json: '{"value":"once"}' },
        { type: "tool_call_end", id: "mcp-uncertain" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "The model was incorrectly allowed to retry." },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
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
      input: { text: "Invoke the uncertain MCP effect once" },
      limits: { maxTurns: 2 },
    });
    const terminalEvents = events.filter(
      (event) =>
        ("callId" in event && event.callId === "mcp-uncertain") || event.type === "session_settled",
    );

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: {
          status: "failed",
          error: {
            code: "tool_effect_indeterminate",
            reason: "mcp_connection_closed",
            message: "The MCP connection closed before the tool returned a complete response.",
          },
        },
      },
      requestCount: 1,
    });
    expect(terminalEvents).toEqual([
      { type: "tool_requested", callId: "mcp-uncertain", name: qualifiedName },
      expect.objectContaining({
        type: "tool_permission_decided",
        callId: "mcp-uncertain",
        name: qualifiedName,
        decision: "allow",
      }),
      { type: "tool_started", callId: "mcp-uncertain", name: qualifiedName },
      {
        type: "tool_failed",
        callId: "mcp-uncertain",
        name: qualifiedName,
        error: {
          code: "tool_effect_indeterminate",
          reason: "mcp_connection_closed",
          message: "The MCP connection closed before the tool returned a complete response.",
        },
      },
      {
        type: "session_settled",
        result: {
          status: "failed",
          error: {
            code: "tool_effect_indeterminate",
            reason: "mcp_connection_closed",
            message: "The MCP connection closed before the tool returned a complete response.",
          },
        },
      },
    ]);
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "once" },
    });
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

test("SessionLifecycle times out a dispatched MCP request through a deterministic deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-request-timeout-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "hold-call", callMarker],
        },
      },
    }),
  );

  const manualRequestDeadline = createManualMcpIdleScheduler();
  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    return [
      { type: "tool_call_start", id: "mcp-timeout", name: qualifiedName as string },
      { type: "tool_call_delta", id: "mcp-timeout", json: '{"value":"once"}' },
      { type: "tool_call_end", id: "mcp-timeout" },
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
    [mcpRequestScheduler]: manualRequestDeadline.scheduler,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const dispatched = observeFileCreation(callMarker);
    const pending = lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Call an MCP tool that does not complete" },
      limits: { maxTurns: 2 },
    });
    await dispatched;
    await manualRequestDeadline.advanceBy(120_000);
    const continued = await pending;

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: {
          status: "failed",
          error: {
            code: "tool_effect_indeterminate",
            reason: "mcp_request_timeout",
            message: "The MCP tool request timed out after it was dispatched.",
          },
        },
      },
      requestCount: 1,
    });
    expect(
      events.find((event) => event.type === "tool_failed" && event.callId === "mcp-timeout"),
    ).toMatchObject({
      error: {
        code: "tool_effect_indeterminate",
        reason: "mcp_request_timeout",
      },
    });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "once" },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies caller cancellation after MCP dispatch without retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-caller-cancelled-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "hold-call", callMarker],
        },
      },
    }),
  );

  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    return [
      { type: "tool_call_start", id: "mcp-caller-cancelled", name: qualifiedName as string },
      { type: "tool_call_delta", id: "mcp-caller-cancelled", json: '{"value":"once"}' },
      { type: "tool_call_end", id: "mcp-caller-cancelled" },
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
    const controller = new AbortController();
    const dispatched = observeFileCreation(callMarker);
    const pending = lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Cancel only after the MCP call is dispatched" },
      limits: { maxTurns: 2 },
      signal: controller.signal,
    });
    await dispatched;
    controller.abort(new Error("caller cancelled"));
    const continued = await pending;

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: {
          status: "failed",
          error: {
            code: "tool_effect_indeterminate",
            reason: "mcp_caller_cancelled",
            message: "The MCP tool call was cancelled after it was dispatched.",
          },
        },
      },
      requestCount: 1,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { mode: "invalid-output", shape: "success" },
  { mode: "invalid-error-output", shape: "tool-level error" },
] as const)(
  "SessionLifecycle rejects a complete $shape MCP result that violates its output schema",
  async ({ mode }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-invalid-output-"));
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
      if (requests.length === 1) {
        return [
          { type: "tool_call_start", id: "mcp-invalid-output", name: qualifiedName as string },
          { type: "tool_call_delta", id: "mcp-invalid-output", json: '{"value":"wrong"}' },
          { type: "tool_call_end", id: "mcp-invalid-output" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      const latest = request.messages.at(-1);
      const answer =
        latest?.role === "tool" &&
        latest.result.status === "failed" &&
        latest.result.error.code === "mcp_output_invalid"
          ? "Invalid MCP output rejected."
          : "Invalid MCP output was accepted.";
      return [
        { type: "text_delta", text: answer },
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
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });
    const events: RuntimeEvent[] = [];
    lifecycle.subscribe((event) => events.push(event));

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
      const activeMcp = activated.snapshot.mcp;
      if (activeMcp?.status !== "tool_selection_required") {
        throw new Error("The fixture requires a discovered MCP catalog.");
      }
      const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
      const generationId = activeMcp.activation?.generationId;
      if (echo === undefined || generationId === undefined) {
        throw new Error("The fixture requires the discovered echo tool and generation.");
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
        input: { text: "Reject the invalid MCP structured output" },
        limits: { maxTurns: 2 },
      });
      const terminal = events
        .filter((event) => "callId" in event && event.callId === "mcp-invalid-output")
        .at(-1);

      expect({ continued, requestCount: requests.length, terminal }).toMatchObject({
        continued: { result: { status: "completed", answer: "Invalid MCP output rejected." } },
        requestCount: 2,
        terminal: {
          type: "tool_failed",
          error: {
            code: "mcp_output_invalid",
            message: "The MCP tool result did not match the discovered output schema.",
          },
        },
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("SessionLifecycle rejects an excessively deep complete MCP structured result deterministically", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-deep-output-"));
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
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "deep-structured-result",
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
        { type: "tool_call_start", id: "mcp-deep-output", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-deep-output", json: '{"value":"deep"}' },
        { type: "tool_call_end", id: "mcp-deep-output" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const rejected =
      latest?.role === "tool" &&
      latest.result.status === "failed" &&
      latest.result.error.code === "mcp_output_invalid";
    return [
      {
        type: "text_delta",
        text: rejected ? "Deep MCP output rejected." : "Deep output accepted.",
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
      input: { text: "Reject the overly deep structured output" },
      limits: { maxTurns: 2 },
    });
    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: { result: { status: "completed", answer: "Deep MCP output rejected." } },
      requestCount: 2,
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an unsupported MCP content block after a complete response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unsupported-output-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "unsupported-result", callMarker],
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
        { type: "tool_call_start", id: "mcp-unsupported", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-unsupported", json: '{"value":"image"}' },
        { type: "tool_call_end", id: "mcp-unsupported" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      JSON.stringify(latest.result) ===
        JSON.stringify({
          status: "failed",
          error: {
            code: "mcp_output_unsupported",
            message: "The MCP tool returned a content type that Adam does not support.",
          },
        });
    return [
      {
        type: "text_delta",
        text: accepted ? "Unsupported MCP output rejected." : "Unsupported MCP output leaked.",
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
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Reject the unsupported MCP image result" },
      limits: { maxTurns: 2 },
    });

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: { status: "completed", answer: "Unsupported MCP output rejected." },
      },
      requestCount: 2,
    });
    expect(
      events.find((event) => event.type === "tool_failed" && event.callId === "mcp-unsupported"),
    ).toEqual({
      type: "tool_failed",
      callId: "mcp-unsupported",
      name: qualifiedName,
      error: {
        code: "mcp_output_unsupported",
        message: "The MCP tool returned a content type that Adam does not support.",
      },
    });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "image" },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a complete MCP result above its raw output limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-result-too-large-"));
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
          args: [mcpServerFixturePath, spawnMarker, closeMarker, "oversized-result", callMarker],
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
        { type: "tool_call_start", id: "mcp-too-large", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-too-large", json: '{"value":"large"}' },
        { type: "tool_call_end", id: "mcp-too-large" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const accepted =
      latest?.role === "tool" &&
      JSON.stringify(latest.result) ===
        JSON.stringify({
          status: "failed",
          error: {
            code: "mcp_result_too_large",
            message: "The complete MCP tool result exceeded the 8 MiB raw output limit.",
          },
        });
    return [
      {
        type: "text_delta",
        text: accepted ? "Oversized MCP output rejected." : "Oversized MCP output leaked.",
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
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Reject the oversized MCP result" },
      limits: { maxTurns: 2 },
    });

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: {
        result: { status: "completed", answer: "Oversized MCP output rejected." },
      },
      requestCount: 2,
    });
    expect(
      events.find((event) => event.type === "tool_failed" && event.callId === "mcp-too-large"),
    ).toEqual({
      type: "tool_failed",
      callId: "mcp-too-large",
      name: qualifiedName,
      error: {
        code: "mcp_result_too_large",
        message: "The complete MCP tool result exceeded the 8 MiB raw output limit.",
      },
    });
    await expect(readFile(callMarker, "utf8").then(JSON.parse)).resolves.toEqual({
      name: "echo",
      arguments: { value: "large" },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);

test("SessionLifecycle refuses to commit a profile after its ready catalog becomes stale", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-stale-before-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  const notificationGate = join(testRoot, "notify-list-changed");
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
            "list-changed-on-gate",
            callMarker,
            notificationGate,
          ],
        },
      },
    }),
  );
  let announceStale = () => {};
  const staleObserved = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  const lifecycle = createSessionLifecycle({
    [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a ready MCP catalog.");
    }
    const generationId = activeMcp.activation?.generationId;
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    if (generationId === undefined || echo === undefined) {
      throw new Error("The fixture requires one discovered MCP tool.");
    }

    await writeFile(notificationGate, "notify");
    await withFailureGuard(staleObserved, 5_000, "Adam did not observe list_changed.");
    await expect(
      lifecycle.configureMcp({
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
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({ mcp: { status: "catalog_stale" } });
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
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope);
    expect(records.some((entry) => entry.record?.type === "mcp_tool_profile_committed")).toBe(
      false,
    );
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle fences an MCP call when list_changed arrives during permission wait", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-permission-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  const notificationGate = join(testRoot, "notify-list-changed");
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
            "list-changed-on-gate",
            callMarker,
            notificationGate,
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
        { type: "tool_call_start", id: "mcp-permission-stale", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-permission-stale", json: '{"value":"blocked"}' },
        { type: "tool_call_end", id: "mcp-permission-stale" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const fenced =
      latest?.role === "tool" &&
      latest.result.status === "failed" &&
      latest.result.error.code === "mcp_catalog_stale";
    return [
      {
        type: "text_delta",
        text: fenced ? "Stale permission call fenced." : "Stale call dispatched.",
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
            readiness: { status: "available", credentialSource: "test" },
            contextProfile,
          },
        ],
      };
    },
  };
  let announceStale = () => {};
  const staleObserved = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  const lifecycle = createSessionLifecycle({
    [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  let announcePermission:
    | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
    | undefined;
  const permissionRequested = new Promise<
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >((resolve) => {
    announcePermission = resolve;
  });
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_permission_requested" && event.callId === "mcp-permission-stale") {
      announcePermission?.(event);
    }
  });

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continuation = lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Wait for permission, then respect list_changed" },
      limits: { maxTurns: 2 },
    });
    const permission = await permissionRequested;
    await writeFile(notificationGate, "notify");
    await withFailureGuard(staleObserved, 5_000, "Adam did not observe list_changed.");
    expect(
      lifecycle.decidePermission({ requestId: permission.requestId, decision: "allow" }),
    ).toEqual({ status: "accepted" });
    const continued = await continuation;
    const callEvents = events.filter(
      (event) => "callId" in event && event.callId === "mcp-permission-stale",
    );

    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: { result: { status: "completed", answer: "Stale permission call fenced." } },
      requestCount: 2,
    });
    expect(callEvents.map((event) => event.type)).toEqual([
      "tool_requested",
      "tool_permission_requested",
      "tool_permission_decided",
      "tool_failed",
    ]);
    await expect(stat(callMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rechecks MCP catalog state after tool_started and before dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-dispatch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  const notificationGate = join(testRoot, "notify-list-changed");
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
            "list-changed-on-gate",
            callMarker,
            notificationGate,
          ],
        },
      },
    }),
  );

  let announceStale = () => {};
  const staleObserved = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  let qualifiedName: string | undefined;
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-dispatch-stale", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-dispatch-stale", json: '{"value":"blocked"}' },
        { type: "tool_call_end", id: "mcp-dispatch-stale" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const fenced =
      latest?.role === "tool" &&
      latest.result.status === "failed" &&
      latest.result.error.code === "mcp_catalog_stale";
    return [
      { type: "text_delta", text: fenced ? "Post-start call fenced." : "Post-start call sent." },
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
    [mcpBeforeToolDispatchBarrier]: {
      async beforeDispatch() {
        await writeFile(notificationGate, "notify");
        await staleObserved;
      },
    },
    [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const continued = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Fence a catalog change at the dispatch boundary" },
      limits: { maxTurns: 2 },
    });
    expect({ continued, requestCount: requests.length }).toMatchObject({
      continued: { result: { status: "completed", answer: "Post-start call fenced." } },
      requestCount: 2,
    });
    expect(
      events
        .filter((event) => "callId" in event && event.callId === "mcp-dispatch-stale")
        .map((event) => event.type),
    ).toEqual(["tool_requested", "tool_permission_decided", "tool_started", "tool_failed"]);
    await expect(stat(callMarker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle fences new MCP calls after a tools list-changed notification", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-"));
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
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "list-changed-after-call",
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
    if (requests.length <= 2) {
      const id = requests.length === 1 ? "mcp-before-stale" : "mcp-after-stale";
      return [
        { type: "tool_call_start", id, name: qualifiedName as string },
        { type: "tool_call_delta", id, json: `{"value":"call-${requests.length}"}` },
        { type: "tool_call_end", id },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    const latest = request.messages.at(-1);
    const answer =
      latest?.role === "tool" &&
      latest.result.status === "failed" &&
      latest.result.error.code === "mcp_catalog_stale"
        ? "Stale MCP catalog fenced."
        : "Stale MCP catalog was reused.";
    return [
      { type: "text_delta", text: answer },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;

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
    const activeMcp = activated.snapshot.mcp;
    if (activeMcp?.status !== "tool_selection_required") {
      throw new Error("The fixture requires a discovered MCP catalog.");
    }
    const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
    const generationId = activeMcp.activation?.generationId;
    if (echo === undefined || generationId === undefined) {
      throw new Error("The fixture requires the discovered echo tool and generation.");
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
      input: { text: "Call once, then respect list_changed" },
      limits: { maxTurns: 3 },
    });
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    const secondEvents = events.filter(
      (event) => "callId" in event && event.callId === "mcp-after-stale",
    );
    const calls = (await readFile(callMarker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect({ continued, inspected, requestCount: requests.length, calls }).toMatchObject({
      continued: { result: { status: "completed", answer: "Stale MCP catalog fenced." } },
      inspected: { mcp: { status: "catalog_stale" } },
      requestCount: 3,
      calls: [{ name: "echo", arguments: { value: "call-1" } }],
    });
    expect(secondEvents.map((event) => event.type)).toEqual(["tool_requested", "tool_failed"]);

    expect(await lifecycle.close()).toEqual({ status: "closed" });
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
      .map((line) => JSON.parse(line) as { readonly record?: { readonly type?: string } });
    expect(records.filter((record) => record.record?.type === "mcp_catalog_state_changed")).toEqual(
      [
        expect.objectContaining({
          record: expect.objectContaining({
            type: "mcp_catalog_state_changed",
            generationId,
            serverId: "fixture",
            catalogDigest: activeMcp.catalog?.digest,
            status: "stale",
            reason: "list_changed",
          }),
        }),
      ],
    );

    cold = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      mcp: { status: "catalog_stale" },
    });
  } finally {
    await lifecycle.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle persists an idle list_changed before a cold lifecycle can observe stale", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-idle-cold-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const callMarker = join(testRoot, "called");
  const notificationGate = join(testRoot, "notify-list-changed");
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
            "list-changed-on-gate",
            callMarker,
            notificationGate,
          ],
        },
      },
    }),
  );
  let announceDurable = () => {};
  const staleDurable = new Promise<void>((resolve) => {
    announceDurable = resolve;
  });
  const lifecycle = createSessionLifecycle({
    [mcpCatalogStaleDurableBarrier]: { committed: announceDurable },
    stateRoot,
    workspaceRoot,
  });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    await writeFile(notificationGate, "notify");
    await withFailureGuard(staleDurable, 5_000, "The idle list_changed was not made durable.");

    cold = createSessionLifecycle({ stateRoot, workspaceRoot });
    await expect(cold.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: { status: "catalog_stale" },
    });
  } finally {
    await lifecycle.close();
    await cold?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle durably records list_changed even without a later MCP call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-direct-"));
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
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-list-changed-direct", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-list-changed-direct", json: '{"value":"once"}' },
        { type: "tool_call_end", id: "mcp-list-changed-direct" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "List change observed." },
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
      input: { text: "Call once and retain the server list change" },
      limits: { maxTurns: 2 },
    });
    expect(continued).toMatchObject({
      result: { status: "completed", answer: "List change observed." },
      snapshot: { mcp: { status: "catalog_stale" } },
    });
    const sessionPath = join(
      stateRoot,
      "projects",
      continued.snapshot.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${committed.sessionId}.jsonl`,
    );
    const catalogTransitions = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope)
      .filter((entry) => entry.record?.type === "mcp_catalog_state_changed")
      .map((entry) => entry.record);

    expect(catalogTransitions).toEqual([
      expect.objectContaining({
        generationId: expect.any(String),
        serverId: "fixture",
        status: "stale",
        reason: "list_changed",
      }),
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle explicitly revalidates an unchanged stale MCP profile at clean idle", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-revalidated-"));
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
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [
        { type: "tool_call_start", id: "mcp-before-revalidate", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-before-revalidate", json: '{"value":"first"}' },
        { type: "tool_call_end", id: "mcp-before-revalidate" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (requests.length === 2) {
      return [
        { type: "tool_call_start", id: "mcp-observe-stale", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-observe-stale", json: '{"value":"fenced"}' },
        { type: "tool_call_end", id: "mcp-observe-stale" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (requests.length === 3) {
      return [
        { type: "text_delta", text: "Stale profile recorded." },
        { type: "finish", reason: "stop" },
      ];
    }
    if (requests.length === 4) {
      return [
        { type: "tool_call_start", id: "mcp-after-revalidate", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-after-revalidate", json: '{"value":"second"}' },
        { type: "tool_call_end", id: "mcp-after-revalidate" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Revalidated MCP profile returned." },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const before = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Observe one list_changed notification" },
      limits: { maxTurns: 3 },
    });
    expect(before).toMatchObject({
      result: { status: "completed", answer: "Stale profile recorded." },
      snapshot: { mcp: { status: "catalog_stale" } },
    });
    const staleGenerationId =
      before.snapshot.schemaVersion === 3 && before.snapshot.mcp?.workspaceConfirmed === true
        ? before.snapshot.mcp.activation?.generationId
        : undefined;
    if (staleGenerationId === undefined) {
      throw new Error("The fixture requires one stale MCP generation.");
    }

    const revalidated = await lifecycle.configureMcp({
      type: "revalidate_catalog",
      sessionId: committed.sessionId,
      generationId: staleGenerationId,
    });
    expect(revalidated.snapshot).toMatchObject({
      mcp: { status: "profile_committed", catalog: { status: "ready" } },
    });
    const after = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Call the unchanged revalidated profile" },
      limits: { maxTurns: 2 },
    });
    const calls = (await readFile(callMarker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect({ after, requestCount: requests.length, calls }).toMatchObject({
      after: {
        result: { status: "completed", answer: "Revalidated MCP profile returned." },
        snapshot: { mcp: { status: "profile_committed" } },
      },
      requestCount: 5,
      calls: [
        { name: "echo", arguments: { value: "first" } },
        { name: "echo", arguments: { value: "second" } },
      ],
    });
    const sessionPath = join(
      stateRoot,
      "projects",
      before.snapshot.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${committed.sessionId}.jsonl`,
    );
    const catalogTransitions = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope)
      .filter((entry) => entry.record?.type === "mcp_catalog_state_changed")
      .map((entry) => entry.record);
    expect(catalogTransitions).toEqual([
      expect.objectContaining({ status: "stale", reason: "list_changed" }),
      expect.objectContaining({ status: "ready", reason: "revalidated" }),
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps a stale historical profile closed when a selected tool changes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-revalidation-mismatch-"));
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
          args: [
            mcpServerFixturePath,
            spawnMarker,
            closeMarker,
            "list-changed-then-mutated",
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
        { type: "tool_call_start", id: "mcp-before-change", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-before-change", json: '{"value":"first"}' },
        { type: "tool_call_end", id: "mcp-before-change" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    if (requests.length === 2) {
      return [
        { type: "tool_call_start", id: "mcp-after-change", name: qualifiedName as string },
        { type: "tool_call_delta", id: "mcp-after-change", json: '{"value":"fenced"}' },
        { type: "tool_call_end", id: "mcp-after-change" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Changed profile stayed stale." },
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
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
  });

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const stale = await lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Observe a changed MCP definition" },
      limits: { maxTurns: 3 },
    });
    const generationId =
      stale.snapshot.schemaVersion === 3 && stale.snapshot.mcp?.workspaceConfirmed === true
        ? stale.snapshot.mcp.activation?.generationId
        : undefined;
    if (generationId === undefined) {
      throw new Error("The fixture requires one stale MCP generation.");
    }

    await expect(
      lifecycle.configureMcp({
        type: "revalidate_catalog",
        sessionId: committed.sessionId,
        generationId,
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    await expect(lifecycle.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: { status: "catalog_stale" },
    });
    expect(requests).toHaveLength(3);
    const calls = (await readFile(callMarker, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([{ name: "echo", arguments: { value: "first" } }]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close durably records each causally closed committed MCP server", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-close-record-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpServerFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
  );

  const lifecycle = createSessionLifecycle({ stateRoot, workspaceRoot });
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    const beforeClose = await lifecycle.inspect({ sessionId: committed.sessionId });
    if (
      beforeClose.schemaVersion !== 3 ||
      beforeClose.mcp?.workspaceConfirmed !== true ||
      beforeClose.mcp.activation?.generationId === undefined
    ) {
      throw new Error("The fixture requires one committed live MCP generation.");
    }
    const generationId = beforeClose.mcp.activation.generationId;
    const server = beforeClose.mcp.servers[0];
    if (server === undefined) {
      throw new Error("The fixture requires one committed MCP server.");
    }

    const firstClose = await lifecycle.close();
    const secondClose = await lifecycle.close();
    const afterClose = await lifecycle.inspect({ sessionId: committed.sessionId });
    expect({ afterClose, firstClose, secondClose }).toMatchObject({
      afterClose: { mcp: { status: "profile_reactivation_required" } },
      firstClose: { status: "closed" },
      secondClose: { status: "closed" },
    });
    await expect(stat(closeMarker)).resolves.toBeDefined();
    const sessionPath = join(
      stateRoot,
      "projects",
      beforeClose.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${committed.sessionId}.jsonl`,
    );
    const closeRecords = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedRecordEnvelope)
      .filter((entry) => entry.record?.type === "mcp_server_closed")
      .map((entry) => entry.record);

    expect(closeRecords).toEqual([
      {
        type: "mcp_server_closed",
        recordVersion: 1,
        generationId,
        attempt: 1,
        serverId: "fixture",
        definitionDigest: server.definitionDigest,
        reason: "session_close",
      },
    ]);
    await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed\n");
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle close interrupts an in-progress activation and waits for causal process close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-close-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const spawnMarker = join(testRoot, "spawned");
  const closeMarker = join(testRoot, "closed");
  const initializeGate = join(testRoot, "initialize-gate");
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

    const spawned = observeFileCreation(spawnMarker);
    const activation = lifecycle.configureMcp({
      type: "activate_servers",
      sessionId: created.sessionId,
      servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
    });
    const observedActivation = activation.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
    await spawned;
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
