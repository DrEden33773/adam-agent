import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createLinuxClipboardImageReader } from "./linux-clipboard-image.js";
import { removeTuiFixtureRoot as rm, waitForFileContents } from "./tui-filesystem.test-support.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
  "the $name reader returns exact bytes through a real child process",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-process-"));
    const helperPath = join(testRoot, fixture.helper);
    const argumentsPath = join(testRoot, "arguments.txt");
    const sourcePath = join(testRoot, "source.png");
    await writeFile(
      helperPath,
      '#!/bin/sh\nif [ -n "$ADAM_TEST_ARGUMENTS" ]; then printf "%s\\n" "$@" > "$ADAM_TEST_ARGUMENTS"; fi\n/bin/cat "$ADAM_TEST_IMAGE_SOURCE"\n',
      { mode: 0o755 },
    );
    await writeFile(sourcePath, onePixelPng);

    try {
      const fixtureEnvironment: ReaderEnvironment = fixture.environment;
      const reader = createLinuxClipboardImageReader({
        environment: {
          ...process.env,
          ...fixtureEnvironment,
          ADAM_TEST_ARGUMENTS: argumentsPath,
          ADAM_TEST_IMAGE_SOURCE: sourcePath,
          DISPLAY: fixtureEnvironment.DISPLAY,
          PATH: testRoot,
          WAYLAND_DISPLAY: fixtureEnvironment.WAYLAND_DISPLAY,
          WSL_DISTRO_NAME: fixtureEnvironment.WSL_DISTRO_NAME,
          WSL_INTEROP: fixtureEnvironment.WSL_INTEROP,
        },
      });
      await expect(reader.readImage()).resolves.toEqual({
        status: "read",
        bytes: onePixelPng,
        platform: fixture.expectedPlatform,
      });
      if (fixture.expectedPlatform === "wsl_bridge") {
        await expect(readFile(argumentsPath, "utf8")).resolves.toContain("-STA");
      }
      await expect(reader.close()).resolves.toBeUndefined();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name reader reports typed failure through real child close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-failure-"));
    await writeFile(join(testRoot, fixture.helper), "#!/bin/sh\nexit 2\n", { mode: 0o755 });

    try {
      const reader = createLinuxClipboardImageReader({
        environment: readerEnvironment(testRoot, fixture.environment),
      });
      await expect(reader.readImage()).resolves.toMatchObject({ status: "unsupported" });
      await expect(reader.close()).resolves.toBeUndefined();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name reader bounds real helper output and confirms child close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-output-bound-"));
    await writeFile(
      join(testRoot, fixture.helper),
      "#!/bin/sh\n/usr/bin/head -c 8388609 /dev/zero\n",
      { mode: 0o755 },
    );

    try {
      const reader = createLinuxClipboardImageReader({
        environment: readerEnvironment(testRoot, fixture.environment),
      });
      await expect(reader.readImage()).resolves.toMatchObject({ status: "failed" });
      await expect(reader.close()).resolves.toBeUndefined();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "aborting the $name image reader terminates and joins its real child",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-cancel-"));
    const signalPath = join(testRoot, "signals.txt");
    const startedPath = join(testRoot, "started.txt");
    await writeFile(
      join(testRoot, fixture.helper),
      '#!/bin/sh\nprintf "started\\n" >> "$ADAM_TEST_STARTED"\ntrap \'printf "term\\n" >> "$ADAM_TEST_SIGNALS"\' TERM\nwhile :; do :; done\n',
      { mode: 0o755 },
    );

    try {
      const controller = new AbortController();
      const reader = createLinuxClipboardImageReader({
        environment: readerEnvironment(testRoot, fixture.environment, {
          ADAM_TEST_SIGNALS: signalPath,
          ADAM_TEST_STARTED: startedPath,
        }),
        terminationGraceMilliseconds: 25,
      });
      const result = reader.readImage(controller.signal);
      await waitForFileContents(startedPath, "started\n");
      controller.abort();
      await expect(result).resolves.toEqual({
        status: "failed",
        message: "Clipboard image acquisition cancelled.",
      });
      await expect(reader.close()).resolves.toBeUndefined();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test.each(readerFixtures)(
  "the $name reader escalates TERM to KILL and confirms real child close",
  async (fixture) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-deadline-"));
    const signalPath = join(testRoot, "signals.txt");
    const startedPath = join(testRoot, "started.txt");
    await writeFile(
      join(testRoot, fixture.helper),
      '#!/bin/sh\nprintf "started\\n" >> "$ADAM_TEST_STARTED"\ntrap \'printf "term\\n" >> "$ADAM_TEST_SIGNALS"\' TERM\nwhile :; do :; done\n',
      { mode: 0o755 },
    );

    try {
      const reader = createLinuxClipboardImageReader({
        candidateDeadlineMilliseconds: 50,
        environment: readerEnvironment(testRoot, fixture.environment, {
          ADAM_TEST_SIGNALS: signalPath,
          ADAM_TEST_STARTED: startedPath,
        }),
        terminationGraceMilliseconds: 25,
      });
      await expect(reader.readImage()).resolves.toEqual({
        status: "failed",
        message: "Clipboard image acquisition reached its deadline.",
      });
      const expectedAttempts = fixture.expectedPlatform === "wsl_bridge" ? 1 : 2;
      expect((await readFile(startedPath, "utf8")).trim().split("\n")).toHaveLength(
        expectedAttempts,
      );
      expect((await readFile(signalPath, "utf8")).trim().split("\n")).toHaveLength(
        expectedAttempts,
      );
      await expect(reader.close()).resolves.toBeUndefined();
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
