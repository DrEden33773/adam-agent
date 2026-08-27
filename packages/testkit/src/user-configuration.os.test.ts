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

import { createPresentationPreferences } from "@adam-agent/agent";
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
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}
