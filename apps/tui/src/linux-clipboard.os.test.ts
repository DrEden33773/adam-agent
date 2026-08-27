import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { DeadlineScheduler } from "./exit-policy.js";
import {
  createLinuxClipboardAdapter,
  type LinuxClipboardChild,
  linuxClipboardSpawn,
} from "./linux-clipboard.js";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";

test("the Linux clipboard adapter copies exact UTF-8 text through wl-copy", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-linux-clipboard-"));
  const helperPath = join(testRoot, "wl-copy");
  const markerPath = join(testRoot, "clipboard.txt");
  const text = "Adam clipboard · 中文\nsecond line";
  await writeFile(helperPath, '#!/bin/sh\n/bin/cat > "$ADAM_TEST_CLIPBOARD_MARKER"\n', {
    mode: 0o755,
  });

  try {
    const adapter = createLinuxClipboardAdapter({
      environment: {
        ...process.env,
        ADAM_TEST_CLIPBOARD_MARKER: markerPath,
        PATH: testRoot,
      },
    });

    await expect(adapter.writeText(text)).resolves.toBe("copied");
    await expect(readFile(markerPath, "utf8")).resolves.toBe(text);
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("the Linux clipboard adapter falls back to xclip when wl-copy is unavailable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-linux-clipboard-xclip-"));
  const helperPath = join(testRoot, "xclip");
  const markerPath = join(testRoot, "clipboard.txt");
  const text = "fallback clipboard text";
  await writeFile(
    helperPath,
    '#!/bin/sh\n[ "$1" = "-selection" ] && [ "$2" = "clipboard" ] && [ "$3" = "-in" ] || exit 64\n/bin/cat > "$ADAM_TEST_CLIPBOARD_MARKER"\n',
    { mode: 0o755 },
  );

  try {
    const adapter = createLinuxClipboardAdapter({
      environment: {
        ...process.env,
        ADAM_TEST_CLIPBOARD_MARKER: markerPath,
        PATH: testRoot,
      },
    });

    await expect(adapter.writeText(text)).resolves.toBe("copied");
    await expect(readFile(markerPath, "utf8")).resolves.toBe(text);
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("the Linux clipboard adapter falls back to xsel when Wayland and xclip helpers are unavailable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-linux-clipboard-xsel-"));
  const helperPath = join(testRoot, "xsel");
  const markerPath = join(testRoot, "clipboard.txt");
  const text = "last Linux clipboard fallback";
  await writeFile(
    helperPath,
    '#!/bin/sh\n[ "$1" = "--clipboard" ] && [ "$2" = "--input" ] || exit 64\n/bin/cat > "$ADAM_TEST_CLIPBOARD_MARKER"\n',
    { mode: 0o755 },
  );

  try {
    const adapter = createLinuxClipboardAdapter({
      environment: {
        ...process.env,
        ADAM_TEST_CLIPBOARD_MARKER: markerPath,
        PATH: testRoot,
      },
    });

    await expect(adapter.writeText(text)).resolves.toBe("copied");
    await expect(readFile(markerPath, "utf8")).resolves.toBe(text);
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("the Linux clipboard adapter terminates a helper when its deadline expires", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-linux-clipboard-deadline-"));
  const helperPath = join(testRoot, "wl-copy");
  await writeFile(helperPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
  let expire: (() => void) | undefined;
  const spawned = Promise.withResolvers<void>();
  const scheduler: DeadlineScheduler = {
    schedule(_delayMilliseconds, onDeadline) {
      expire = onDeadline;
      return { cancel() {} };
    },
  };

  try {
    const adapter = createLinuxClipboardAdapter({
      environment: {
        ...process.env,
        PATH: testRoot,
      },
      scheduler,
      [linuxClipboardSpawn](command, arguments_, options) {
        const child = spawn(command, [...arguments_], options);
        child.once("spawn", () => spawned.resolve());
        return child as LinuxClipboardChild;
      },
    });
    const result = adapter.writeText("bounded clipboard text");
    await spawned.promise;
    expect(expire).toBeTypeOf("function");
    expire?.();

    await expect(result).resolves.toBe("failed");
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});
