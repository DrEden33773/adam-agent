import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPresentationPreferences, createWorkspaceTrust } from "@adam-agent/agent";
import { expect, test } from "vitest";

const emptyPolicy = {
  contextWindowTokens: null,
  maximumOutputTokens: null,
  automaticCompactionWindowTokens: null,
};

const agentEntryUrl = new URL("../../agent/dist/index.js", import.meta.url).href;

test("user configuration survives Adapter restart with owner-only durable modes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-durability-"));
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const configurationPath = join(configurationDirectory, "config.json");
  const environment = { XDG_CONFIG_HOME: configurationRoot };

  try {
    await createPresentationPreferences({ environment }).setModelPolicy({
      field: "maximumOutputTokens",
      value: 1_234,
    });

    const restarted = createPresentationPreferences({ environment });
    await expect(restarted.load()).resolves.toEqual({
      defaultTargetId: null,
      modelPolicy: { ...emptyPolicy, maximumOutputTokens: 1_234 },
      diagnostic: null,
    });
    expect({
      directoryMode: (await stat(configurationDirectory)).mode & 0o777,
      fileMode: (await stat(configurationPath)).mode & 0o777,
      bytes: await readFile(configurationPath, "utf8"),
    }).toEqual({
      directoryMode: 0o700,
      fileMode: 0o600,
      bytes: `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: { ...emptyPolicy, maximumOutputTokens: 1_234 },
      })}\n`,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("user configuration survives an actual process restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-process-restart-"));
  const configurationRoot = join(testRoot, "config");
  const resultPath = join(testRoot, "restart-result.json");

  try {
    await expect(runPreferenceProcess("write", configurationRoot)).resolves.toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    });
    await expect(runPreferenceProcess("read", configurationRoot, resultPath)).resolves.toEqual({
      code: 0,
      signal: null,
      stderr: "",
      stdout: "",
    });
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      defaultTargetId: null,
      modelPolicy: { ...emptyPolicy, maximumOutputTokens: 1_234 },
      diagnostic: null,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { name: "group-readable file", directoryMode: 0o700, fileMode: 0o640 },
  { name: "searchable directory", directoryMode: 0o710, fileMode: 0o600 },
])("user configuration rejects an unsafe $name", async ({ directoryMode, fileMode }) => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-mode-"));
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configurationDirectory, "config.json"),
    `${JSON.stringify({ schemaVersion: 2, defaultTargetId: null, modelPolicy: emptyPolicy })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(configurationDirectory, directoryMode);
  await chmod(join(configurationDirectory, "config.json"), fileMode);

  try {
    await expect(
      createPresentationPreferences({
        environment: { XDG_CONFIG_HOME: configurationRoot },
      }).load(),
    ).resolves.toMatchObject({
      diagnostic: { code: "target_configuration_unsafe" },
    });
  } finally {
    await chmod(configurationDirectory, 0o700).catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("user configuration rejects a symlinked document without reading its target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-symlink-"));
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const outsidePath = join(testRoot, "outside.json");
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    outsidePath,
    `${JSON.stringify({ schemaVersion: 2, defaultTargetId: null, modelPolicy: emptyPolicy })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await symlink(outsidePath, join(configurationDirectory, "config.json"));

  try {
    const preferences = createPresentationPreferences({
      environment: { XDG_CONFIG_HOME: configurationRoot },
    });
    await expect(preferences.load()).resolves.toMatchObject({
      diagnostic: { code: "target_configuration_unsafe" },
    });
    await expect(preferences.setDefaultTarget("fake.local")).rejects.toThrow();
    expect((await lstat(join(configurationDirectory, "config.json"))).isSymbolicLink()).toBe(true);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["fifo", "directory"])(
  "user configuration rejects a non-ordinary %s without blocking",
  async (name) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-nonordinary-"));
    const configurationRoot = join(testRoot, "config");
    const configurationDirectory = join(configurationRoot, "adam-agent");
    const configurationPath = join(configurationDirectory, "config.json");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    if (name === "fifo") {
      execFileSync("mkfifo", [configurationPath]);
    } else {
      await mkdir(configurationPath, { mode: 0o700 });
    }

    try {
      await expect(
        createPresentationPreferences({
          environment: { XDG_CONFIG_HOME: configurationRoot },
        }).load(),
      ).resolves.toMatchObject({ diagnostic: { code: "target_configuration_unsafe" } });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("a failed atomic replacement preserves the last durable bytes and snapshot", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-write-failure-"));
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const configurationPath = join(configurationDirectory, "config.json");
  const extensionsPath = join(configurationDirectory, "extensions.json");
  const extensions = '{"schemaVersion":1,"extensions":[]}\n';
  const original = `${JSON.stringify({
    schemaVersion: 2,
    defaultTargetId: "fake.local",
    modelPolicy: emptyPolicy,
  })}\n`;
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configurationPath, original, { encoding: "utf8", mode: 0o600 });
  await writeFile(extensionsPath, extensions, { encoding: "utf8", mode: 0o600 });
  const preferences = createPresentationPreferences({
    environment: { XDG_CONFIG_HOME: configurationRoot },
  });

  try {
    await preferences.load();
    await chmod(configurationDirectory, 0o500);
    await expect(
      preferences.setModelPolicy({ field: "maximumOutputTokens", value: 1_234 }),
    ).rejects.toThrow();
    await chmod(configurationDirectory, 0o700);

    expect({
      bytes: await readFile(configurationPath, "utf8"),
      extensions: await readFile(extensionsPath, "utf8"),
      snapshot: await preferences.load(),
    }).toEqual({
      bytes: original,
      extensions,
      snapshot: {
        defaultTargetId: "fake.local",
        modelPolicy: emptyPolicy,
        diagnostic: null,
      },
    });
  } finally {
    await chmod(configurationDirectory, 0o700).catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("user configuration rejects a document larger than the 8 KiB bound", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-user-configuration-oversize-"));
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configurationDirectory, "config.json"), " ".repeat(8 * 1024 + 1), {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    await expect(
      createPresentationPreferences({
        environment: { XDG_CONFIG_HOME: configurationRoot },
      }).load(),
    ).resolves.toMatchObject({ diagnostic: { code: "target_configuration_unsafe" } });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("workspace trust survives Adapter restart with owner-only durable modes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-durability-"));
  const workspaceRoot = join(testRoot, "workspace");
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const trustPath = join(configurationDirectory, "workspace-trust.json");
  const environment = { XDG_CONFIG_HOME: configurationRoot };
  await mkdir(workspaceRoot);

  try {
    const trust = createWorkspaceTrust({ environment, workspaceRoot });
    const initial = await trust.load();
    if (initial.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await trust.setTrusted({ projectId: initial.projectId, trusted: true });

    const restarted = createWorkspaceTrust({ environment, workspaceRoot });
    await expect(restarted.load()).resolves.toMatchObject({
      projectId: initial.projectId,
      status: "trusted",
      diagnostic: null,
    });
    expect({
      directoryMode: (await stat(configurationDirectory)).mode & 0o777,
      fileMode: (await stat(trustPath)).mode & 0o777,
      bytes: await readFile(trustPath, "utf8"),
    }).toEqual({
      directoryMode: 0o700,
      fileMode: 0o600,
      bytes: `${JSON.stringify({ schemaVersion: 1, trustedProjectIds: [initial.projectId] })}\n`,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("workspace trust survives an actual process restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-process-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  const configurationRoot = join(testRoot, "config");
  const resultPath = join(testRoot, "restart-result.json");
  await mkdir(workspaceRoot);

  try {
    await expect(
      runWorkspaceTrustProcess("write", configurationRoot, workspaceRoot),
    ).resolves.toMatchObject({
      code: 0,
      signal: null,
      stderr: "",
    });
    await expect(
      runWorkspaceTrustProcess("read", configurationRoot, workspaceRoot, resultPath),
    ).resolves.toEqual({ code: 0, signal: null, stderr: "", stdout: "" });
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
      projectLabel: "workspace",
      status: "trusted",
      diagnostic: null,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("concurrent project processes preserve both additions to the global trust document", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-concurrent-"));
  const configurationRoot = join(testRoot, "config");
  const firstWorkspace = join(testRoot, "first");
  const secondWorkspace = join(testRoot, "second");
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  const environment = { XDG_CONFIG_HOME: configurationRoot };
  let first: ReturnType<typeof startConcurrentWorkspaceTrustGrant> | undefined;
  let second: ReturnType<typeof startConcurrentWorkspaceTrustGrant> | undefined;

  try {
    const firstIdentity = await createWorkspaceTrust({
      environment,
      workspaceRoot: firstWorkspace,
    }).load();
    const secondIdentity = await createWorkspaceTrust({
      environment,
      workspaceRoot: secondWorkspace,
    }).load();
    if (firstIdentity.projectId === null || secondIdentity.projectId === null) {
      throw new Error("The fixture requires two canonical project identities.");
    }
    first = startConcurrentWorkspaceTrustGrant(configurationRoot, firstWorkspace);
    second = startConcurrentWorkspaceTrustGrant(configurationRoot, secondWorkspace);
    await Promise.all([first.ready, second.ready]);

    const results = await Promise.all([first.run(), second.run()]);

    expect(results).toEqual([
      { code: 0, signal: null, stderr: "", stdout: "" },
      { code: 0, signal: null, stderr: "", stdout: "" },
    ]);
    expect(
      JSON.parse(
        await readFile(join(configurationRoot, "adam-agent", "workspace-trust.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      trustedProjectIds: [firstIdentity.projectId, secondIdentity.projectId].sort(),
    });
  } finally {
    await Promise.allSettled([first?.close(), second?.close()]);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  { name: "group-readable file", directoryMode: 0o700, fileMode: 0o640 },
  { name: "searchable directory", directoryMode: 0o710, fileMode: 0o600 },
])("workspace trust rejects an unsafe $name", async ({ directoryMode, fileMode }) => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-mode-"));
  const workspaceRoot = join(testRoot, "workspace");
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  await mkdir(workspaceRoot);
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configurationDirectory, "workspace-trust.json"),
    `${JSON.stringify({ schemaVersion: 1, trustedProjectIds: [] })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(configurationDirectory, directoryMode);
  await chmod(join(configurationDirectory, "workspace-trust.json"), fileMode);

  try {
    await expect(
      createWorkspaceTrust({
        environment: { XDG_CONFIG_HOME: configurationRoot },
        workspaceRoot,
      }).load(),
    ).resolves.toMatchObject({
      status: "untrusted",
      diagnostic: { code: "workspace_trust_unsafe" },
    });
  } finally {
    await chmod(configurationDirectory, 0o700).catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("workspace trust rejects a symlinked document without reading its target", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-symlink-"));
  const workspaceRoot = join(testRoot, "workspace");
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const outsidePath = join(testRoot, "outside.json");
  await mkdir(workspaceRoot);
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await writeFile(outsidePath, `${JSON.stringify({ schemaVersion: 1, trustedProjectIds: [] })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await symlink(outsidePath, join(configurationDirectory, "workspace-trust.json"));

  try {
    const trust = createWorkspaceTrust({
      environment: { XDG_CONFIG_HOME: configurationRoot },
      workspaceRoot,
    });
    await expect(trust.load()).resolves.toMatchObject({
      status: "untrusted",
      diagnostic: { code: "workspace_trust_unsafe" },
    });
    const identity = await trust.load();
    if (identity.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await expect(
      trust.setTrusted({ projectId: identity.projectId, trusted: true }),
    ).rejects.toThrow();
    expect(
      (await lstat(join(configurationDirectory, "workspace-trust.json"))).isSymbolicLink(),
    ).toBe(true);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["fifo", "directory"])(
  "workspace trust rejects a non-ordinary %s without blocking",
  async (name) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-nonordinary-"));
    const workspaceRoot = join(testRoot, "workspace");
    const configurationRoot = join(testRoot, "config");
    const configurationDirectory = join(configurationRoot, "adam-agent");
    const trustPath = join(configurationDirectory, "workspace-trust.json");
    await mkdir(workspaceRoot);
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    if (name === "fifo") {
      execFileSync("mkfifo", [trustPath]);
    } else {
      await mkdir(trustPath, { mode: 0o700 });
    }

    try {
      await expect(
        createWorkspaceTrust({
          environment: { XDG_CONFIG_HOME: configurationRoot },
          workspaceRoot,
        }).load(),
      ).resolves.toMatchObject({
        status: "untrusted",
        diagnostic: { code: "workspace_trust_unsafe" },
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("a failed workspace trust replacement preserves every owner-local document", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-workspace-trust-write-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const configurationRoot = join(testRoot, "config");
  const configurationDirectory = join(configurationRoot, "adam-agent");
  const trustPath = join(configurationDirectory, "workspace-trust.json");
  const configPath = join(configurationDirectory, "config.json");
  const extensionsPath = join(configurationDirectory, "extensions.json");
  const config = `${JSON.stringify({ schemaVersion: 1, defaultTargetId: "fake.local" })}\n`;
  const extensions = '{"schemaVersion":1,"extensions":[]}\n';
  await mkdir(workspaceRoot);
  const trust = createWorkspaceTrust({
    environment: { XDG_CONFIG_HOME: configurationRoot },
    workspaceRoot,
  });

  try {
    const initial = await trust.load();
    if (initial.projectId === null) {
      throw new Error("The fixture requires one canonical project identity.");
    }
    await trust.setTrusted({ projectId: initial.projectId, trusted: true });
    const originalTrust = await readFile(trustPath, "utf8");
    await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });
    await writeFile(extensionsPath, extensions, { encoding: "utf8", mode: 0o600 });
    await chmod(configurationDirectory, 0o500);
    await expect(
      trust.setTrusted({ projectId: initial.projectId, trusted: false }),
    ).rejects.toThrow();
    await chmod(configurationDirectory, 0o700);

    expect({
      trust: await readFile(trustPath, "utf8"),
      config: await readFile(configPath, "utf8"),
      extensions: await readFile(extensionsPath, "utf8"),
      snapshot: await trust.load(),
    }).toEqual({
      trust: originalTrust,
      config,
      extensions,
      snapshot: expect.objectContaining({ status: "trusted", diagnostic: null }),
    });
  } finally {
    await chmod(configurationDirectory, 0o700).catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

function runPreferenceProcess(
  operation: "read" | "write",
  configurationRoot: string,
  resultPath?: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const script = `
    import { writeFile } from "node:fs/promises";
    import { createPresentationPreferences } from ${JSON.stringify(agentEntryUrl)};
    const preferences = createPresentationPreferences({ environment: process.env });
    if (${JSON.stringify(operation)} === "write") {
      await preferences.setModelPolicy({ field: "maximumOutputTokens", value: 1234 });
    } else {
      await writeFile(process.env.ADAM_AGENT_CONFIGURATION_RESULT, JSON.stringify(await preferences.load()), "utf8");
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ...(resultPath === undefined ? {} : { ADAM_AGENT_CONFIGURATION_RESULT: resultPath }),
      XDG_CONFIG_HOME: configurationRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let processError: Error | undefined;
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (processError === undefined) {
        resolve({ code, signal, stderr, stdout });
      } else {
        reject(processError);
      }
    });
  });
}

function runWorkspaceTrustProcess(
  operation: "read" | "write",
  configurationRoot: string,
  workspaceRoot: string,
  resultPath?: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const script = `
    import { writeFile } from "node:fs/promises";
    import { createWorkspaceTrust } from ${JSON.stringify(agentEntryUrl)};
    const trust = createWorkspaceTrust({ environment: process.env, workspaceRoot: process.env.ADAM_AGENT_WORKSPACE_ROOT });
    const snapshot = await trust.load();
    if (${JSON.stringify(operation)} === "write") {
      if (snapshot.projectId === null) throw new Error("missing project identity");
      await trust.setTrusted({ projectId: snapshot.projectId, trusted: true });
    } else {
      await writeFile(process.env.ADAM_AGENT_CONFIGURATION_RESULT, JSON.stringify(snapshot), "utf8");
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ...(resultPath === undefined ? {} : { ADAM_AGENT_CONFIGURATION_RESULT: resultPath }),
      ADAM_AGENT_WORKSPACE_ROOT: workspaceRoot,
      XDG_CONFIG_HOME: configurationRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let processError: Error | undefined;
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (processError === undefined) {
        resolve({ code, signal, stderr, stdout });
      } else {
        reject(processError);
      }
    });
  });
}

function startConcurrentWorkspaceTrustGrant(
  configurationRoot: string,
  workspaceRoot: string,
): {
  readonly ready: Promise<void>;
  run(): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly stdout: string;
  }>;
  close(): Promise<void>;
} {
  const script = `
    import { createWorkspaceTrust } from ${JSON.stringify(agentEntryUrl)};
    const trust = createWorkspaceTrust({ environment: process.env, workspaceRoot: process.env.ADAM_AGENT_WORKSPACE_ROOT });
    process.send("ready");
    await new Promise((resolve) => process.once("message", resolve));
    const snapshot = await trust.load();
    if (snapshot.projectId === null) throw new Error("missing project identity");
    await trust.setTrusted({ projectId: snapshot.projectId, trusted: true });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ADAM_AGENT_WORKSPACE_ROOT: workspaceRoot,
      XDG_CONFIG_HOME: configurationRoot,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let processError: Error | undefined;
  let readyObserved = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.once("message", (message) => {
    if (message === "ready") {
      readyObserved = true;
      resolveReady?.();
    } else {
      processError = new Error("The workspace trust writer sent an invalid ready message.");
      child.kill("SIGTERM");
    }
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly stdout: string;
  }>((resolve) => {
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (!readyObserved) {
        rejectReady?.(processError ?? new Error("The workspace trust writer closed before ready."));
      }
      resolve({ code, signal, stderr, stdout });
    });
  });
  let closePromise: Promise<void> | undefined;
  return {
    ready,
    async run() {
      child.send("run", (error) => {
        if (error !== null) {
          processError = error;
          child.kill("SIGTERM");
        }
      });
      const result = await closed;
      if (processError !== undefined) {
        throw processError;
      }
      return result;
    },
    close() {
      closePromise ??= closeWorkspaceTrustWriter(child, closed);
      return closePromise;
    },
  };
}

async function closeWorkspaceTrustWriter(
  child: ReturnType<typeof spawn>,
  closed: Promise<unknown>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const closedBeforeDeadline = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (!closedBeforeDeadline) {
    child.kill("SIGKILL");
    await closed;
  }
}
