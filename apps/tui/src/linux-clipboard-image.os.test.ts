import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createLinuxClipboardImageReader } from "./linux-clipboard-image.js";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.each([
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
])("the $name reader returns exact bytes through a real child process", async (fixture) => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-process-"));
  const helperPath = join(testRoot, fixture.helper);
  const sourcePath = join(testRoot, "source.png");
  await writeFile(helperPath, '#!/bin/sh\n/bin/cat "$ADAM_TEST_IMAGE_SOURCE"\n', {
    mode: 0o755,
  });
  await writeFile(sourcePath, onePixelPng);

  try {
    const reader = createLinuxClipboardImageReader({
      environment: {
        ...process.env,
        ...fixture.environment,
        ADAM_TEST_IMAGE_SOURCE: sourcePath,
        DISPLAY: fixture.environment.DISPLAY,
        PATH: testRoot,
        WAYLAND_DISPLAY: fixture.environment.WAYLAND_DISPLAY,
        WSL_DISTRO_NAME: fixture.environment.WSL_DISTRO_NAME,
      },
    });
    await expect(reader.readImage()).resolves.toEqual({
      status: "read",
      bytes: onePixelPng,
      platform: fixture.expectedPlatform,
    });
    await expect(reader.close()).resolves.toBeUndefined();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real clipboard image reader terminates a non-closing helper at its deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-clipboard-image-deadline-"));
  const helperPath = join(testRoot, "wl-paste");
  await writeFile(helperPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });

  try {
    const reader = createLinuxClipboardImageReader({
      deadlineMilliseconds: 50,
      environment: { ...process.env, PATH: testRoot, WAYLAND_DISPLAY: "wayland-0" },
    });
    await expect(reader.readImage()).resolves.toEqual({
      status: "failed",
      message: "Clipboard image acquisition reached its deadline.",
    });
    await expect(reader.close()).resolves.toBeUndefined();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
