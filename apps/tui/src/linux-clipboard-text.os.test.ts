import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLinuxClipboardTextReader } from "./linux-clipboard-text.js";
import { removeTuiFixtureRoot as rm, waitForFileContents } from "./tui-filesystem.test-support.js";

const readerFixtures = [
  {
    name: "Wayland wl-paste",
    helper: "wl-paste",
    environment: { WAYLAND_DISPLAY: "wayland-0" },
    expectedPlatform: "linux_wayland",
  },
  {
    name: "X11 xclip",
    helper: "xclip",
    environment: { DISPLAY: ":1" },
    expectedPlatform: "linux_x11",
  },
  {
    name: "WSL PowerShell bridge",
    helper: "powershell.exe",
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    expectedPlatform: "wsl_bridge",
  },
] as const;

type ReaderEnvironment = {
  readonly DISPLAY?: string;
  readonly WAYLAND_DISPLAY?: string;
  readonly WSL_DISTRO_NAME?: string;
  readonly WSL_INTEROP?: string;
};

test.each(readerFixtures)(
  "the $name text reader returns exact UTF-8 through a real child",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-text-process-"));
    const sourcePath = join(testRoot, "source.txt");
    const argumentsPath = join(testRoot, "arguments.txt");
    await writeFile(sourcePath, "剪贴板 e\u0301", "utf8");
    await writeFile(
      join(testRoot, fixture.helper),
      '#!/bin/sh\nif [ -n "$ADAM_TEST_ARGUMENTS" ]; then printf "%s\\n" "$@" > "$ADAM_TEST_ARGUMENTS"; fi\n/bin/cat "$ADAM_TEST_TEXT_SOURCE"\n',
      { mode: 0o755 },
    );

    try {
      const reader = createLinuxClipboardTextReader({
        environment: readerEnvironment(testRoot, fixture.environment, {
          ADAM_TEST_ARGUMENTS: argumentsPath,
          ADAM_TEST_TEXT_SOURCE: sourcePath,
        }),
      });
      await expect(reader.readText(new AbortController().signal)).resolves.toEqual({
        status: "read",
        platform: fixture.expectedPlatform,
        text: "剪贴板 é",
      });
      if (fixture.expectedPlatform === "wsl_bridge") {
        await expect(readFile(argumentsPath, "utf8")).resolves.toContain("-STA");
      }
      await reader.close();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name text reader reports typed failure through real close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-text-failure-"));
    await writeFile(join(testRoot, fixture.helper), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    try {
      const reader = createLinuxClipboardTextReader({
        environment: readerEnvironment(testRoot, fixture.environment),
      });
      await expect(reader.readText(new AbortController().signal)).resolves.toMatchObject({
        status: "unsupported",
      });
      await reader.close();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name text reader bounds output and confirms real close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-text-bound-"));
    await writeFile(
      join(testRoot, fixture.helper),
      "#!/bin/sh\n/usr/bin/head -c 1048577 /dev/zero\n",
      { mode: 0o755 },
    );
    try {
      const reader = createLinuxClipboardTextReader({
        environment: readerEnvironment(testRoot, fixture.environment),
      });
      await expect(reader.readText(new AbortController().signal)).resolves.toMatchObject({
        status: "failed",
      });
      await reader.close();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "aborting the $name text reader terminates and joins its real child",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-text-cancel-"));
    const signalPath = join(testRoot, "signals.txt");
    const startedPath = join(testRoot, "started.txt");
    await writeFile(
      join(testRoot, fixture.helper),
      '#!/bin/sh\nprintf "started\\n" >> "$ADAM_TEST_STARTED"\ntrap \'printf "term\\n" >> "$ADAM_TEST_SIGNALS"\' TERM\nwhile :; do :; done\n',
      { mode: 0o755 },
    );
    try {
      const controller = new AbortController();
      const reader = createLinuxClipboardTextReader({
        environment: readerEnvironment(testRoot, fixture.environment, {
          ADAM_TEST_SIGNALS: signalPath,
          ADAM_TEST_STARTED: startedPath,
        }),
        terminationGraceMilliseconds: 25,
      });
      const result = reader.readText(controller.signal);
      await waitForFileContents(startedPath, "started\n");
      controller.abort();
      await expect(result).resolves.toEqual({
        status: "failed",
        message: "Clipboard acquisition cancelled.",
      });
      await reader.close();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name text reader escalates TERM to KILL and confirms real close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-text-deadline-"));
    const signalPath = join(testRoot, "signals.txt");
    await writeFile(
      join(testRoot, fixture.helper),
      '#!/bin/sh\ntrap \'printf "term\\n" >> "$ADAM_TEST_SIGNALS"\' TERM\nwhile :; do :; done\n',
      { mode: 0o755 },
    );
    try {
      const reader = createLinuxClipboardTextReader({
        candidateDeadlineMilliseconds: 50,
        environment: readerEnvironment(testRoot, fixture.environment, {
          ADAM_TEST_SIGNALS: signalPath,
        }),
        terminationGraceMilliseconds: 25,
      });
      await expect(reader.readText(new AbortController().signal)).resolves.toEqual({
        status: "failed",
        message: "Clipboard text acquisition reached its deadline.",
      });
      expect(await readFile(signalPath, "utf8")).toContain("term");
      await reader.close();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

function readerEnvironment(
  testRoot: string,
  fixtureEnvironment: ReaderEnvironment,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...fixtureEnvironment,
    ...extra,
    DISPLAY: fixtureEnvironment.DISPLAY,
    PATH: testRoot,
    WAYLAND_DISPLAY: fixtureEnvironment.WAYLAND_DISPLAY,
    WSL_DISTRO_NAME: fixtureEnvironment.WSL_DISTRO_NAME,
    WSL_INTEROP: fixtureEnvironment.WSL_INTEROP,
  };
}
