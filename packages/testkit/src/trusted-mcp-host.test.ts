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
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContextProfile,
  createCodingToolRegistry,
  createPermissionPolicy,
  createPresentationSession,
  type ModelRequest,
  type ModelTargetIdentity,
  type ModelTargets,
  type RuntimeEvent,
  type ToolEffect,
} from "@adam-agent/agent";
import {
  createInMemorySessionStoreDirectory,
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
  mcpTransportFactory,
  type SessionRecord,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import {
  createInMemorySessionLifecycleHarness,
  createScriptedMcpTransportFactory,
  createSessionLifecycleForTesting as createSessionLifecycle,
  FakeModelDriver,
  type ScriptedMcpServer,
  type ScriptedMcpTransportFactory,
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

async function writeScriptedMcpConfiguration(
  testRoot: string,
  workspaceRoot: string,
  serverIds: readonly string[] = ["fixture"],
): Promise<void> {
  const executablePath = join(testRoot, "scripted-mcp");
  await writeFile(executablePath, "#!/bin/sh\nexit 1\n");
  await chmod(executablePath, 0o755);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        serverIds.map((serverId) => [serverId, { command: executablePath }]),
      ),
    }),
  );
}

function createScriptedMcpLifecycle(
  options: Parameters<typeof createSessionLifecycle>[0],
  servers: Readonly<Record<string, ScriptedMcpServer>>,
): {
  readonly harness: ReturnType<typeof createInMemorySessionLifecycleHarness>;
  readonly lifecycle: ReturnType<typeof createSessionLifecycle>;
  readonly peer: ScriptedMcpTransportFactory;
} {
  const peer = createScriptedMcpTransportFactory(servers);
  const harness = createInMemorySessionLifecycleHarness();
  return {
    harness,
    lifecycle: harness.createLifecycle({ ...options, [mcpTransportFactory]: peer }),
    peer,
  };
}

function scriptedStringTool(
  name: string,
  inputSchema: Readonly<Record<string, unknown>> = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
): {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
} {
  return { inputSchema, name };
}

function ordinaryScriptedMcpServer(): ScriptedMcpServer {
  return {
    toolPages: [
      {
        tools: [
          {
            ...scriptedStringTool("echo"),
            description: "Echo a value.",
          },
        ],
        nextCursor: "page-2",
      },
      {
        cursor: "page-2",
        tools: [
          {
            ...scriptedStringTool("uppercase"),
            description: "Uppercase a value.",
          },
        ],
      },
    ],
  };
}

function scriptedReferenceDepthSchema(referenceCount: number): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    $defs: Object.fromEntries(
      Array.from({ length: referenceCount }, (_unused, index) => [
        `level_${index}`,
        index === referenceCount - 1 ? { type: "string" } : { $ref: `#/$defs/level_${index + 1}` },
      ]),
    ),
    properties: { value: { $ref: "#/$defs/level_0" } },
    required: ["value"],
    additionalProperties: false,
  };
}

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
  effect: ToolEffect = "read",
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
        effect,
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

test("SessionLifecycle orders MCP diagnostics by server ID without exposing endpoint data", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-diagnostic-order-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  const endpoints = [
    "https://zeta-secret.example.invalid/mcp",
    "https://alpha-secret.example.invalid/mcp",
    "https://capital-secret.example.invalid/mcp",
  ] as const;
  const configurationSource =
    '{"mcpServers":{"zeta":{"type":"http","url":"https://zeta-secret.example.invalid/mcp"},"alpha":{"type":"http","url":"https://alpha-secret.example.invalid/mcp"},"Alpha":{"type":"http","url":"https://capital-secret.example.invalid/mcp"}}}';
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, ".mcp.json"), configurationSource);

  try {
    const lifecycle = createInMemorySessionLifecycleHarness().createLifecycle({
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
    const snapshot = confirmed.snapshot.mcp;
    const serialized = JSON.stringify(snapshot);

    expect(snapshot?.servers).toEqual([]);
    expect(snapshot?.source.digest).toBe(
      "sha256:7731e1a173155dde64a639f8da6f7b7edb9c322ee7c84c936d6216e6041564fe",
    );
    expect(snapshot?.diagnostics).toEqual(
      ["Alpha", "alpha", "zeta"].map((serverId) => ({
        code: "mcp_transport_unsupported",
        serverId,
      })),
    );
    for (const endpoint of endpoints) {
      expect(serialized).not.toContain(endpoint);
    }
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

test("SessionLifecycle keeps a discovered MCP catalog private until its ready settlement is durable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-activation-publication-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let releaseSettlement = () => {};
  const settlementRelease = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  let announceSettlement = (_input: { readonly generationId: string }) => {};
  const settlementReached = new Promise<{ readonly generationId: string }>((resolve) => {
    announceSettlement = resolve;
  });
  const scriptedPeer = createScriptedMcpTransportFactory({
    fixture: {
      toolPages: [
        {
          tools: [
            {
              name: "echo",
              description: "Echo a value.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
          nextCursor: "page-2",
        },
        {
          cursor: "page-2",
          tools: [
            {
              name: "uppercase",
              description: "Uppercase a value.",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
  });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    [mcpActivationSettlementBarrier]: {
      async beforeReadySettlement(input) {
        announceSettlement(input);
        await settlementRelease;
      },
    },
    [mcpTransportFactory]: scriptedPeer,
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let releaseSettlement = () => {};
  const settlementRelease = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  let announceSettlement = () => {};
  const settlementReached = new Promise<void>((resolve) => {
    announceSettlement = resolve;
  });
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpActivationSettlementBarrier]: {
        async beforeReadySettlement() {
          announceSettlement();
          await settlementRelease;
        },
      },
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    const transportClosed = peer.nextClose("fixture");
    const closing = lifecycle.close();
    await transportClosed;
    releaseSettlement();
    await expect(activation).rejects.toMatchObject({ code: "mcp_activation_cancelled" });
    await expect(closing).resolves.toEqual({ status: "closed" });

    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const settlements = (await sessionStore.read()).filter(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_activation_settled",
    );
    expect(settlements).toHaveLength(1);

    const cold = harness.createLifecycle({ stateRoot, workspaceRoot });
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: { ...ordinaryScriptedMcpServer(), serverName: "x".repeat(257) } },
  );
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

    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });
    await transportClosed;
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({
      mcp: {
        status: "activation_failed",
        diagnostics: [{ code: "mcp_initialize_failed", serverId: "fixture" }],
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle causally closes a prepared MCP generation when ready publication fails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-publication-failure-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let rejectNextSettlement = true;
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
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
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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

    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_start_failed" });
    await transportClosed;

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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          { tools: [scriptedStringTool("first")], nextCursor: "loop" },
          { cursor: "loop", tools: [scriptedStringTool("second")], nextCursor: "loop" },
        ],
      },
    },
  );
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

    const transportClosed = peer.nextClose("fixture");
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
    await transportClosed;
    const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
    expect(inspected).toMatchObject({
      lastSequence: 6,
      mcp: {
        status: "activation_failed",
        diagnostics: [{ code: "mcp_catalog_invalid", serverId: "fixture" }],
      },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle surfaces unconfirmed activation shutdown without offering retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-unconfirmed-activation-close-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let confirmationAttempts = 0;
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      stateRoot,
      workspaceRoot,
      [mcpCloseConfirmation]: {
        async confirm() {
          confirmationAttempts += 1;
          throw new Error("Injected close-proof failure.");
        },
      },
    },
    {
      fixture: {
        toolPages: [
          { tools: [scriptedStringTool("first")], nextCursor: "loop" },
          { cursor: "loop", tools: [scriptedStringTool("second")], nextCursor: "loop" },
        ],
      },
    },
  );
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

    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_shutdown_unconfirmed" });
    await transportClosed;
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle(
    {
      [mcpCloseConfirmation]: {
        async confirm() {
          throw new Error("Injected close-proof failure.");
        },
      },
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    const transportClosed = peer.nextClose("fixture");
    await expect(initial.close()).resolves.toEqual({ status: "mcp_shutdown_unconfirmed" });
    await transportClosed;
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
    cold = harness.createLifecycle({ modelTargets, stateRoot, workspaceRoot });
    await expect(cold.inspect({ sessionId: committed.sessionId })).resolves.toMatchObject({
      mcp: { status: "mcp_shutdown_unconfirmed" },
    });
    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not restart an unconfirmed MCP generation" },
      }),
    ).rejects.toMatchObject({ code: "mcp_shutdown_unconfirmed" });
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let initializeAttempts = 0;
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method !== "initialize") {
            return defaultReply;
          }
          initializeAttempts += 1;
          return initializeAttempts === 1
            ? { kind: "error", code: -32_000, message: "injected initialize failure" }
            : defaultReply;
        },
      },
    },
  );
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
    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });
    await transportClosed;
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot, ["blocked", "failing"]);

  let announceBlockedInitialize: (() => void) | undefined;
  const blockedInitializeReceived = new Promise<void>((resolve) => {
    announceBlockedInitialize = resolve;
  });
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      blocked: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method === "initialize") {
            announceBlockedInitialize?.();
            return { kind: "hold" };
          }
          return defaultReply;
        },
      },
      failing: {
        ...ordinaryScriptedMcpServer(),
        async respond(request, defaultReply) {
          if (request.method === "initialize") {
            await blockedInitializeReceived;
            return { kind: "error", code: -32_000, message: "injected peer failure" };
          }
          return defaultReply;
        },
      },
    },
  );
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
    expect(peer.requests("blocked")).toHaveLength(0);
    expect(peer.requests("failing")).toHaveLength(0);

    const blockedClosed = peer.nextClose("blocked");
    const failingClosed = peer.nextClose("failing");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: approved.map((server) => ({
          serverId: server.serverId,
          definitionDigest: server.definitionDigest,
        })),
      }),
    ).rejects.toMatchObject({ code: "mcp_initialize_failed" });
    await Promise.all([blockedClosed, failingClosed]);
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

    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const records = (await sessionStore.read()).filter((entry) => entry.schemaVersion === 3);
    const settled = records.findLast(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_activation_settled",
    );
    expect(settled?.schemaVersion === 3 ? settled.record : undefined).toMatchObject({
      status: "failed",
      error: { code: "mcp_initialize_failed", serverId: "failing" },
    });
    const closeRecords = records
      .filter((entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_server_closed")
      .map((entry) =>
        entry.schemaVersion === 3 && entry.record.type === "mcp_server_closed"
          ? { serverId: entry.record.serverId, reason: entry.record.reason }
          : undefined,
      );
    expect(closeRecords).toEqual([
      { serverId: "blocked", reason: "peer_failure" },
      { serverId: "failing", reason: "failed" },
    ]);
    expect(
      records
        .filter(
          (entry) =>
            entry.schemaVersion === 3 &&
            ["mcp_activation_started", "mcp_server_closed", "mcp_activation_settled"].includes(
              entry.record.type,
            ),
        )
        .map((entry) => (entry.schemaVersion === 3 ? entry.record.type : undefined)),
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { modelTargets, stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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

    const transportClosed = peer.nextClose("fixture");
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
    await transportClosed;
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle cancels an activation blocked in initialize without waiting for its owner lock", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-cancel-activation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let announceInitialize: (() => void) | undefined;
  const initializeReceived = new Promise<void>((resolve) => {
    announceInitialize = resolve;
  });
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method === "initialize") {
            announceInitialize?.();
            return { kind: "hold" };
          }
          return defaultReply;
        },
      },
    },
  );
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
    const activationSettlement = activation.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await initializeReceived;
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

    const transportClosed = peer.nextClose("fixture");
    const cancelled = await lifecycle.configureMcp({
      type: "cancel_configuration",
      sessionId: created.sessionId,
      generationId,
    });
    await transportClosed;

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
    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const terminalRecords = (await sessionStore.read())
      .filter(
        (entry) =>
          entry.schemaVersion === 3 &&
          ["mcp_activation_started", "mcp_server_closed", "mcp_activation_settled"].includes(
            entry.record.type,
          ),
      )
      .map((entry) => {
        if (entry.schemaVersion !== 3) {
          throw new Error("The filtered record must use schema version 3.");
        }
        return {
          type: entry.record.type,
          status: "status" in entry.record ? entry.record.status : undefined,
          reason: "reason" in entry.record ? entry.record.reason : undefined,
        };
      });
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const manualDiscoveryDeadline = createManualMcpIdleScheduler();
  let announceInitialize: (() => void) | undefined;
  const initializeReceived = new Promise<void>((resolve) => {
    announceInitialize = resolve;
  });
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpDiscoveryScheduler]: manualDiscoveryDeadline.scheduler,
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method === "initialize") {
            announceInitialize?.();
            return { kind: "hold" };
          }
          return defaultReply;
        },
      },
    },
  );
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
    const observedActivation = activation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await initializeReceived;
    const transportClosed = peer.nextClose("fixture");
    await manualDiscoveryDeadline.advanceBy(30_000);
    const outcome = await observedActivation;
    await transportClosed;

    expect({ outcome }).toMatchObject({
      outcome: { status: "rejected", error: { code: "mcp_startup_timeout" } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects an oversized MCP tool definition without truncation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-definition-limit-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              {
                ...scriptedStringTool("oversized"),
                description: "x".repeat(16 * 1024),
              },
            ],
          },
        ],
      },
    },
  );
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

    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_too_large" });
    await transportClosed;
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle orders MCP catalog identity by code unit rather than host locale", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-canonical-order-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [{ tools: [scriptedStringTool("äther"), scriptedStringTool("zeta")] }],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: Array.from({ length: 257 }, (_unused, toolIndex) =>
              scriptedStringTool(`tool_${toolIndex.toString().padStart(3, "0")}`),
            ),
          },
        ],
      },
    },
  );
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

    const transportClosed = peer.nextClose("fixture");
    await expect(
      lifecycle.configureMcp({
        type: "activate_servers",
        sessionId: created.sessionId,
        servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_too_large" });
    await transportClosed;
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle projects root allOf local references without narrowing the raw MCP schema", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-allof-projection-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              scriptedStringTool("echo", {
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
                allOf: [{ $ref: "#/$defs/left" }, { $ref: "#/$defs/right" }],
                additionalProperties: false,
              }),
            ],
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              scriptedStringTool("echo", {
                type: "object",
                properties: { next: { $ref: "#" } },
                additionalProperties: false,
              }),
            ],
            nextCursor: "page-2",
          },
          { cursor: "page-2", tools: [scriptedStringTool("uppercase")] },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              scriptedStringTool("bounded_local_ref", {
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
              }),
              scriptedStringTool("plain_good"),
              scriptedStringTool("cyclic_local_ref", {
                type: "object",
                $defs: {
                  node: {
                    type: "object",
                    properties: { next: { $ref: "#/$defs/node" } },
                  },
                },
                properties: { node: { $ref: "#/$defs/node" } },
              }),
              scriptedStringTool("remote_ref", {
                type: "object",
                properties: { value: { $ref: "https://example.invalid/schema.json" } },
              }),
            ],
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              scriptedStringTool("within_limit", scriptedReferenceDepthSchema(16)),
              scriptedStringTool("over_limit", scriptedReferenceDepthSchema(17)),
              scriptedStringTool("plain_good"),
            ],
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              scriptedStringTool("echo", {
                type: "object",
                oneOf: [
                  {
                    properties: { kind: { const: "left" }, left: { type: "string" } },
                    required: ["kind", "left"],
                  },
                  {
                    properties: { kind: { const: "right" }, right: { type: "integer" } },
                    required: ["kind", "right"],
                  },
                ],
              }),
            ],
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: Array.from({ length: 20 }, (_unused, toolIndex) =>
              scriptedStringTool(`wide_${toolIndex.toString().padStart(2, "0")}`, {
                type: "object",
                properties: Object.fromEntries(
                  Array.from({ length: 48 }, (_property, propertyIndex) => [
                    `property_${propertyIndex.toString().padStart(2, "0")}`,
                    {
                      type: "string",
                      description: "A bounded property used to exercise aggregate profile limits.",
                    },
                  ]),
                ),
                additionalProperties: false,
              }),
            ),
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    {
      fixture: {
        toolPages: [
          {
            tools: Array.from({ length: 21 }, (_unused, toolIndex) =>
              scriptedStringTool(`selectable_${toolIndex.toString().padStart(2, "0")}`),
            ),
          },
        ],
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
  let transportClosed: Promise<void> | undefined;
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
    transportClosed = peer.nextClose("fixture");

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
    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the committed in-memory session store.");
    }
    expect(
      (await sessionStore.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "mcp_tool_profile_committed",
      ),
    ).toHaveLength(1);

    const cold = await harness.createLifecycle({ stateRoot, workspaceRoot }).inspect({
      sessionId: created.sessionId,
    });
    expect(cold).toMatchObject({
      lastSequence: 6,
      mcp: { status: "profile_reactivation_required", profile: expectedProfile },
    });
  } finally {
    const closed = await lifecycle.close();
    if (transportClosed !== undefined) {
      await transportClosed;
    }
    expect(closed).toEqual({ status: "closed" });
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a persisted MCP Tool Profile whose canonical schema digest is invalid", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-profile-canonical-tamper-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const {
    harness,
    lifecycle: initial,
    peer: initialPeer,
  } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
  let corrupted: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    const initialStore = await harness.sessions.open(committed.sessionId);
    if (initialStore === undefined) {
      throw new Error("The fixture requires the committed in-memory session store.");
    }
    const committedRecords = await initialStore.read();
    const initialTransportClosed = initialPeer.nextClose("fixture");
    expect(await initial.close()).toEqual({ status: "closed" });
    await initialTransportClosed;

    const corruptedDirectory = createInMemorySessionStoreDirectory<SessionRecord>();
    const corruptedStore = await corruptedDirectory.create(committed.sessionId);
    let corruptedProfileRecords = 0;
    for (const entry of committedRecords) {
      const corruptedEntry: SessionRecord =
        entry.schemaVersion === 3 && entry.record.type === "mcp_tool_profile_committed"
          ? {
              ...entry,
              record: {
                ...entry.record,
                profile: {
                  ...entry.record.profile,
                  tools: entry.record.profile.tools.map((tool, index) =>
                    index === 0
                      ? {
                          ...tool,
                          rawSchema: {
                            ...tool.rawSchema,
                            value: { ...tool.rawSchema.value, fixtureTamper: true },
                          },
                        }
                      : tool,
                  ),
                },
              },
            }
          : entry;
      if (corruptedEntry !== entry) {
        corruptedProfileRecords += 1;
      }
      await corruptedStore.append(corruptedEntry);
    }
    expect(corruptedProfileRecords).toBe(1);

    let modelResolveCount = 0;
    const modelTargets: ModelTargets = {
      async resolve() {
        modelResolveCount += 1;
        throw new Error("The model must not resolve an invalid durable MCP Tool Profile.");
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
    const corruptedPeer = createScriptedMcpTransportFactory({
      fixture: ordinaryScriptedMcpServer(),
    });
    corrupted = createSessionLifecycle({
      [mcpTransportFactory]: corruptedPeer,
      [sessionStoreDirectory]: corruptedDirectory,
      modelTargets,
      stateRoot,
      workspaceRoot,
    });

    await expect(corrupted.inspect({ sessionId: committed.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    expect(modelResolveCount).toBe(0);
    expect(corruptedPeer.requests("fixture")).toEqual([]);
  } finally {
    await initial.close();
    await corrupted?.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle commits MCP after a base-only run and exposes it only to the next run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-after-base-run-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle } = createScriptedMcpLifecycle(
    { modelTargets, stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );

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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpIdleScheduler]: manualIdle.scheduler,
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "initialize"),
    ).toHaveLength(1);

    const idleTransportClosed = peer.nextClose("fixture");
    await manualIdle.advanceBy(10 * 60 * 1_000);
    await idleTransportClosed;

    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      mcp: { status: "profile_reactivation_required" },
    });

    const pendingContinue = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Use MCP after its idle close" },
      limits: { maxTurns: 2 },
    });
    const permission = await permissionRequested;
    expect(
      peer.requests("fixture").filter((request) => request.method === "initialize"),
    ).toHaveLength(2);
    expect(
      peer.requests("fixture").filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
    expect(
      lifecycle.decidePermission({ requestId: permission.requestId, decision: "allow" }),
    ).toEqual({ status: "accepted" });
    const continued = await pendingContinue;
    expect(continued.result).toEqual({ status: "completed", answer: "Idle MCP returned." });

    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the committed in-memory session store.");
    }
    const records = await sessionStore.read();
    const idleTransitions: Array<{
      readonly attempt: number | undefined;
      readonly reason: unknown;
      readonly type: string;
    }> = [];
    for (const entry of records.slice(6)) {
      if (entry.schemaVersion !== 3) {
        continue;
      }
      if (
        entry.record.type === "mcp_server_closed" ||
        entry.record.type === "mcp_activation_started" ||
        entry.record.type === "mcp_activation_settled"
      ) {
        idleTransitions.push({
          type: entry.record.type,
          reason: "reason" in entry.record ? entry.record.reason : undefined,
          attempt: "attempt" in entry.record ? entry.record.attempt : undefined,
        });
        continue;
      }
      const event = entry.record.type === "runtime_event" ? entry.record.event : undefined;
      if (event !== undefined && "callId" in event && event.callId === "mcp-after-idle") {
        idleTransitions.push({ type: event.type, attempt: undefined, reason: undefined });
      }
    }
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(await initial.close()).toEqual({ status: "closed" });

    cold = harness.createLifecycle({
      [mcpTransportFactory]: peer,
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

    expect({
      continued,
      requestCount: requests.length,
      activationCount: peer.requests("fixture").filter((request) => request.method === "initialize")
        .length,
    }).toMatchObject({
      continued: { result: { status: "completed", answer: "Cold MCP profile restored." } },
      requestCount: 2,
      activationCount: 2,
    });
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "cold" } } },
    ]);
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let serverVersion = "1.0.0";
  const server: ScriptedMcpServer = {
    ...ordinaryScriptedMcpServer(),
    respond(request, defaultReply) {
      return request.method === "initialize"
        ? {
            kind: "result",
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "adam-scripted-mcp-peer", version: serverVersion },
            },
          }
        : defaultReply;
    },
  };
  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle({ stateRoot, workspaceRoot }, { fixture: server });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    const initialTransportClosed = peer.nextClose("fixture");
    await expect(initial.close()).resolves.toEqual({ status: "closed" });
    await initialTransportClosed;
    serverVersion = "2.0.0";
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
    cold = harness.createLifecycle({
      [mcpTransportFactory]: peer,
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    });

    const reactivationTransportClosed = peer.nextClose("fixture");
    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not rebind a changed MCP server identity" },
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    await reactivationTransportClosed;
    expect(modelRequestCount).toBe(0);
    expect(
      peer.requests("fixture").filter((request) => request.method === "initialize"),
    ).toHaveLength(2);
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let schemaType = "string";
  const server: ScriptedMcpServer = {
    get toolPages() {
      return [
        {
          tools: [
            {
              ...scriptedStringTool("echo", {
                type: "object",
                properties: { value: { type: schemaType } },
                required: ["value"],
                additionalProperties: false,
              }),
              description: "Echo a value.",
            },
          ],
        },
      ];
    },
  };
  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle({ stateRoot, workspaceRoot }, { fixture: server });
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(initial);
    const initialTransportClosed = peer.nextClose("fixture");
    expect(await initial.close()).toEqual({ status: "closed" });
    await initialTransportClosed;
    schemaType = "integer";
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
    cold = harness.createLifecycle({
      [mcpTransportFactory]: peer,
      modelTargets,
      stateRoot,
      workspaceRoot,
    });

    const reactivationTransportClosed = peer.nextClose("fixture");
    await expect(
      cold.continue({
        sessionId: committed.sessionId,
        input: { text: "Do not use a changed MCP profile" },
      }),
    ).rejects.toMatchObject({ code: "mcp_catalog_invalid" });
    await reactivationTransportClosed;
    expect(modelRequests).toBe(0);
    const sessionStore = await harness.sessions.open(committed.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the committed in-memory session store.");
    }
    const records = await sessionStore.read();
    const started = records.findLast(
      (entry) =>
        entry.schemaVersion === 3 &&
        entry.record.type === "mcp_activation_started" &&
        entry.record.reason === "idle_reactivate",
    );
    const startedGenerationId =
      started?.schemaVersion === 3 && started.record.type === "mcp_activation_started"
        ? started.record.generationId
        : undefined;
    expect(
      records
        .filter(
          (entry) =>
            entry.schemaVersion === 3 &&
            "generationId" in entry.record &&
            entry.record.generationId === startedGenerationId,
        )
        .map((entry) => {
          if (entry.schemaVersion !== 3) {
            throw new Error("The filtered record must use schema version 3.");
          }
          return {
            type: entry.record.type,
            reason: "reason" in entry.record ? entry.record.reason : undefined,
            status: "status" in entry.record ? entry.record.status : undefined,
            error: "error" in entry.record ? entry.record.error : undefined,
          };
        }),
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { lifecycle } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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

    cold = harness.createLifecycle({
      [mcpTransportFactory]: peer,
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  const peer = createScriptedMcpTransportFactory({ fixture: ordinaryScriptedMcpServer() });
  const lifecycle = createSessionLifecycle({
    [mcpTransportFactory]: peer,
    stateRoot,
    workspaceRoot,
  });
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

test("SessionLifecycle binds MCP permission arguments to a canonical code-unit digest", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-canonical-arguments-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  let qualifiedName: string | undefined;
  let modelRequestCount = 0;
  const driver = new FakeModelDriver(() => {
    modelRequestCount += 1;
    if (modelRequestCount === 1) {
      return [
        { type: "tool_call_start", id: "mcp-canonical", name: qualifiedName as string },
        {
          type: "tool_call_delta",
          id: "mcp-canonical",
          json: '{"zeta":{"Zulu":2,"alpha":1},"value":"hello","Alpha":true}',
        },
        { type: "tool_call_end", id: "mcp-canonical" },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Denied canonical MCP call settled." },
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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              {
                ...scriptedStringTool("echo", {
                  type: "object",
                  properties: {
                    zeta: {
                      type: "object",
                      properties: { Zulu: { type: "number" }, alpha: { type: "number" } },
                      required: ["Zulu", "alpha"],
                      additionalProperties: false,
                    },
                    value: { type: "string" },
                    Alpha: { type: "boolean" },
                  },
                  required: ["zeta", "value", "Alpha"],
                  additionalProperties: false,
                }),
                description: "Echo a value.",
              },
            ],
          },
        ],
      },
    },
  );
  let resolvePermissionRequest:
    | ((event: Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>) => void)
    | undefined;
  const permissionRequested = new Promise<
    Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>
  >((resolve) => {
    resolvePermissionRequest = resolve;
  });
  lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested" && event.callId === "mcp-canonical") {
      resolvePermissionRequest?.(event);
    }
  });
  let transportClosed: Promise<void> | undefined;

  try {
    const committed = await commitFixtureEchoTool(lifecycle, "execute");
    qualifiedName = committed.qualifiedName;
    transportClosed = peer.nextClose("fixture");
    const pendingContinue = lifecycle.continue({
      sessionId: committed.sessionId,
      input: { text: "Characterize canonical MCP arguments" },
      limits: { maxTurns: 2 },
    });
    const permissionRequest = await permissionRequested;

    expect(permissionRequest.subject).toMatchObject({
      type: "mcp_tool",
      argumentsDigest: "sha256:4cc12dac3291c3482baf1146911db47606ff92ea3c1576c7bec2197b190e5380",
    });
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual(
      [],
    );
    expect(
      lifecycle.decidePermission({ requestId: permissionRequest.requestId, decision: "deny" }),
    ).toEqual({ status: "accepted" });
    await expect(pendingContinue).resolves.toMatchObject({
      result: { status: "completed", answer: "Denied canonical MCP call settled." },
    });
    expect(modelRequestCount).toBe(2);
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual(
      [],
    );
  } finally {
    const closed = await lifecycle.close();
    if (transportClosed !== undefined) {
      await transportClosed;
    }
    expect(closed).toEqual({ status: "closed" });
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle keeps user-assigned MCP effect authority over server annotations", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-invocation-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["execute"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        toolPages: [
          {
            tools: [
              {
                ...scriptedStringTool("echo"),
                annotations: { readOnlyHint: true },
                description: "Echo a value.",
              },
            ],
          },
        ],
      },
    },
  );
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
  let transportClosed: Promise<void> | undefined;

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
    transportClosed = peer.nextClose("fixture");
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "hello" } } },
    ]);
  } finally {
    const closed = await lifecycle.close();
    if (transportClosed !== undefined) {
      await transportClosed;
    }
    expect(closed).toEqual({ status: "closed" });
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a core and MCP qualified-name collision before model use", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-qualified-collision-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const {
    harness,
    lifecycle: initial,
    peer,
  } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    cold = harness.createLifecycle({
      [mcpTransportFactory]: peer,
      modelTargets,
      stateRoot,
      tools,
      workspaceRoot,
    });

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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call"
            ? {
                kind: "result",
                result: {
                  content: [{ type: "text", text: "denied" }],
                  structuredContent: { echoed: "denied" },
                  isError: true,
                },
              }
            : defaultReply;
        },
      },
    },
  );
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "denied" } } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle treats a complete correlated MCP protocol error as determinate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-correlated-error-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call"
            ? { kind: "error", code: -32_000, message: "scripted MCP protocol error" }
            : defaultReply;
        },
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle spills a complete MCP result above 64 KiB before publishing it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-large-result-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const envelopePrefix = '{"content":[{"text":"';
  const unicodePrefixBytes = 16 * 1024 - Buffer.byteLength(envelopePrefix, "utf8") - 2;
  const fullText = `${"x".repeat(unicodePrefixBytes)}😀${"x".repeat(
    70_000 - unicodePrefixBytes - Buffer.byteLength("😀", "utf8"),
  )}`;
  const fullEnvelopeBytes = Buffer.from(
    `${envelopePrefix}${fullText}","type":"text"}],"isError":false,"version":1}`,
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
  const peer = createScriptedMcpTransportFactory({
    fixture: {
      ...ordinaryScriptedMcpServer(),
      respond(request, defaultReply) {
        return request.method === "tools/call"
          ? { kind: "result", result: { content: [{ type: "text", text: fullText }] } }
          : defaultReply;
      },
    },
  });
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    stateRoot,
    workspaceRoot,
    [mcpTransportFactory]: peer,
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
    const presentation = await createPresentationSession({
      lifecycle,
      projectLabel: "workspace",
      sessionId: created.sessionId,
      stateRoot,
      workspaceRoot,
    });
    while (presentation.getState().authoritative.active?.transcript.olderCursor !== null) {
      const before = presentation.getState().authoritative.active?.transcript.olderCursor;
      if (typeof before !== "string") {
        break;
      }
      await presentation.dispatch({ type: "load_older_transcript", before });
    }
    const transcriptItems = presentation.getState().authoritative.active?.transcript.items;
    const tool = transcriptItems?.find(
      (item) => item.type === "tool_call" && item.callId === "mcp-large",
    );
    if (tool === undefined) {
      throw new Error(`Projected transcript: ${JSON.stringify(transcriptItems)}`);
    }
    expect(tool).toMatchObject({
      type: "tool_call",
      resultSummary: "Completed · output truncated",
      artifacts: [
        {
          id: expectedArtifactId,
          mediaType: "application/json",
          byteCount: fullEnvelopeBytes.byteLength,
          source: "tool_output",
        },
      ],
    });
    if (tool?.type !== "tool_call" || tool.artifacts[0] === undefined) {
      throw new Error("The Presentation fixture requires one MCP tool artifact.");
    }
    const firstPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: tool.artifacts[0],
      range: { offset: 0, maximumBytes: 16 * 1024 },
    });
    expect(firstPage).toMatchObject({
      status: "admitted",
      resource: {
        offset: 0,
        byteCount: 16 * 1024 - 2,
        totalByteCount: fullEnvelopeBytes.byteLength,
      },
    });
    if (
      firstPage.status !== "admitted" ||
      firstPage.resource === null ||
      firstPage.resource.nextRange === null
    ) {
      throw new Error("The Presentation fixture requires a second MCP artifact page.");
    }
    expect(firstPage.resource.text).not.toContain("�");
    const secondPage = await presentation.dispatch({
      type: "read_artifact",
      artifact: tool.artifacts[0],
      range: firstPage.resource.nextRange,
    });
    expect(secondPage).toMatchObject({ status: "admitted" });
    if (secondPage.status !== "admitted" || secondPage.resource === null) {
      throw new Error("The Presentation fixture requires the second MCP artifact page.");
    }
    expect(secondPage.resource.text.startsWith("😀")).toBe(true);
    expect(secondPage.resource.text).not.toContain("�");
    await presentation.close();
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies a post-dispatch MCP disconnect without another model turn", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-indeterminate-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call" ? { kind: "disconnect" } : defaultReply;
        },
      },
    },
  );
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "once" } } },
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

test("SessionLifecycle times out a dispatched MCP request through a deterministic deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-request-timeout-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  let resolveDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpRequestScheduler]: manualRequestDeadline.scheduler,
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method === "tools/call") {
            resolveDispatched?.();
            return { kind: "hold" };
          }
          return defaultReply;
        },
      },
    },
  );
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => events.push(event));

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "once" } } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle classifies caller cancellation after MCP dispatch without retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-caller-cancelled-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  let resolveDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  const { lifecycle } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method === "tools/call") {
            resolveDispatched?.();
            return { kind: "hold" };
          }
          return defaultReply;
        },
      },
    },
  );

  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    qualifiedName = committed.qualifiedName;
    const controller = new AbortController();
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
    await mkdir(workspaceRoot);
    await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
    const { lifecycle } = createScriptedMcpLifecycle(
      {
        modelTargets,
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        stateRoot,
        workspaceRoot,
      },
      {
        fixture: {
          toolPages: [
            {
              tools: [
                {
                  ...scriptedStringTool("echo"),
                  description: "Echo a value.",
                  outputSchema: {
                    type: "object",
                    properties: { echoed: { type: "integer" } },
                    required: ["echoed"],
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
          respond(request, defaultReply) {
            return request.method === "tools/call"
              ? {
                  kind: "result",
                  result: {
                    content: [{ type: "text", text: "wrong" }],
                    structuredContent: { echoed: "wrong" },
                    ...(mode === "invalid-error-output" ? { isError: true } : {}),
                  },
                }
              : defaultReply;
          },
        },
      },
    );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let deepStructured: unknown = { echoed: "deep" };
  for (let depth = 0; depth < 128; depth += 1) {
    deepStructured = { nested: deepStructured };
  }

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
  const { lifecycle } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call"
            ? {
                kind: "result",
                result: {
                  content: [{ type: "text", text: "deep" }],
                  structuredContent: deepStructured,
                },
              }
            : defaultReply;
        },
      },
    },
  );
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call"
            ? {
                kind: "result",
                result: {
                  content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
                },
              }
            : defaultReply;
        },
      },
    },
  );
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "image" } } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rejects a complete MCP result above its raw output limit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-result-too-large-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call"
            ? {
                kind: "result",
                result: {
                  content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024 + 1) }],
                },
              }
            : defaultReply;
        },
      },
    },
  );
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
    expect(peer.requests("fixture").filter((request) => request.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "echo", arguments: { value: "large" } } },
    ]);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}, 10_000);

test("SessionLifecycle refuses to commit a profile after its ready catalog becomes stale", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-stale-before-profile-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let announceStale = () => {};
  const staleObserved = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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

    peer.notifyToolsChanged("fixture");
    await staleObserved;
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
    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    expect(
      (await sessionStore.read()).some(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_tool_profile_committed",
      ),
    ).toBe(false);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle fences an MCP call when list_changed arrives during permission wait", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-permission-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
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
    peer.notifyToolsChanged("fixture");
    await staleObserved;
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle rechecks MCP catalog state after tool_started and before dispatch", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-dispatch-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const peer = createScriptedMcpTransportFactory({ fixture: ordinaryScriptedMcpServer() });
  const harness = createInMemorySessionLifecycleHarness();
  const lifecycle = harness.createLifecycle({
    [mcpBeforeToolDispatchBarrier]: {
      async beforeDispatch() {
        peer.notifyToolsChanged("fixture");
        await staleObserved;
      },
    },
    [mcpCatalogStaleObservationBarrier]: { observed: announceStale },
    [mcpTransportFactory]: peer,
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
    expect(
      peer.requests("fixture").filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("SessionLifecycle fences new MCP calls after a tools list-changed notification", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-mcp-list-changed-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  let completedCalls = 0;
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method !== "tools/call" || defaultReply.kind !== "result") {
            return defaultReply;
          }
          completedCalls += 1;
          return {
            ...defaultReply,
            ...(completedCalls === 1 ? { notifyToolsChanged: true } : {}),
          };
        },
      },
    },
  );
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
    const calls = peer
      .requests("fixture")
      .filter((request) => request.method === "tools/call")
      .map((request) => request.params);

    expect({ continued, inspected, requestCount: requests.length, calls }).toMatchObject({
      continued: { result: { status: "completed", answer: "Stale MCP catalog fenced." } },
      inspected: { mcp: { status: "catalog_stale" } },
      requestCount: 3,
      calls: [{ name: "echo", arguments: { value: "call-1" } }],
    });
    expect(secondEvents.map((event) => event.type)).toEqual(["tool_requested", "tool_failed"]);

    expect(await lifecycle.close()).toEqual({ status: "closed" });
    const sessionStore = await harness.sessions.open(created.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    expect(
      (await sessionStore.read()).filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "mcp_catalog_state_changed",
      ),
    ).toEqual([
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
    ]);

    cold = harness.createLifecycle({ stateRoot, workspaceRoot });
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);
  let announceDurable = () => {};
  const staleDurable = new Promise<void>((resolve) => {
    announceDurable = resolve;
  });
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      [mcpCatalogStaleDurableBarrier]: { committed: announceDurable },
      stateRoot,
      workspaceRoot,
    },
    { fixture: ordinaryScriptedMcpServer() },
  );
  let cold: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const committed = await commitFixtureEchoTool(lifecycle);
    peer.notifyToolsChanged("fixture");
    await staleDurable;

    cold = harness.createLifecycle({ stateRoot, workspaceRoot });
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  const { harness, lifecycle } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          return request.method === "tools/call" && defaultReply.kind === "result"
            ? { ...defaultReply, notifyToolsChanged: true }
            : defaultReply;
        },
      },
    },
  );

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
    const sessionStore = await harness.sessions.open(committed.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const catalogTransitions = (await sessionStore.read())
      .filter(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_catalog_state_changed",
      )
      .map((entry) => (entry.schemaVersion === 3 ? entry.record : undefined));

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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  let completedCalls = 0;
  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    {
      fixture: {
        ...ordinaryScriptedMcpServer(),
        respond(request, defaultReply) {
          if (request.method !== "tools/call" || defaultReply.kind !== "result") {
            return defaultReply;
          }
          completedCalls += 1;
          return {
            ...defaultReply,
            ...(completedCalls === 1 ? { notifyToolsChanged: true } : {}),
          };
        },
      },
    },
  );

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
    const calls = peer
      .requests("fixture")
      .filter((request) => request.method === "tools/call")
      .map((request) => request.params);

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
    const sessionStore = await harness.sessions.open(committed.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const catalogTransitions = (await sessionStore.read())
      .filter(
        (entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_catalog_state_changed",
      )
      .map((entry) => (entry.schemaVersion === 3 ? entry.record : undefined));
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

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
  let schemaType = "string";
  let completedCalls = 0;
  const server: ScriptedMcpServer = {
    get toolPages() {
      return [
        {
          tools: [
            {
              ...scriptedStringTool("echo", {
                type: "object",
                properties: { value: { type: schemaType } },
                required: ["value"],
                additionalProperties: false,
              }),
              description: "Echo a value.",
            },
          ],
        },
      ];
    },
    respond(request, defaultReply) {
      if (request.method !== "tools/call" || defaultReply.kind !== "result") {
        return defaultReply;
      }
      completedCalls += 1;
      if (completedCalls === 1) {
        schemaType = "integer";
        return { ...defaultReply, notifyToolsChanged: true };
      }
      return defaultReply;
    },
  };
  const { lifecycle, peer } = createScriptedMcpLifecycle(
    {
      modelTargets,
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      stateRoot,
      workspaceRoot,
    },
    { fixture: server },
  );

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
    const calls = peer
      .requests("fixture")
      .filter((request) => request.method === "tools/call")
      .map((request) => request.params);
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
  await mkdir(workspaceRoot);
  await writeScriptedMcpConfiguration(testRoot, workspaceRoot);

  const { harness, lifecycle, peer } = createScriptedMcpLifecycle(
    { stateRoot, workspaceRoot },
    { fixture: ordinaryScriptedMcpServer() },
  );
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

    const transportClosed = peer.nextClose("fixture");
    const firstClose = await lifecycle.close();
    await transportClosed;
    const secondClose = await lifecycle.close();
    const afterClose = await lifecycle.inspect({ sessionId: committed.sessionId });
    expect({ afterClose, firstClose, secondClose }).toMatchObject({
      afterClose: { mcp: { status: "profile_reactivation_required" } },
      firstClose: { status: "closed" },
      secondClose: { status: "closed" },
    });
    const sessionStore = await harness.sessions.open(committed.sessionId);
    if (sessionStore === undefined) {
      throw new Error("The fixture requires the in-memory session store.");
    }
    const closeRecords = (await sessionStore.read())
      .filter((entry) => entry.schemaVersion === 3 && entry.record.type === "mcp_server_closed")
      .map((entry) => (entry.schemaVersion === 3 ? entry.record : undefined));

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
