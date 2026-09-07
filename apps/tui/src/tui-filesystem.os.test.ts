import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { waitForFilesystemEffect } from "./tui-filesystem.test-support.js";

test("a filesystem effect published during the initial probe is observed without another write", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-file-observation-"));
  const path = join(root, "receipt");
  let initial = true;
  const observed = waitForFilesystemEffect(
    path,
    async () => {
      const snapshot = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (initial) {
        initial = false;
        // The real effect arrives after the probe's snapshot, before it returns.
        await writeFile(path, "ready\n");
      }
      return snapshot;
    },
    "publish",
  );
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const missing = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(
        () => reject(new Error("The initial-probe filesystem notification was lost.")),
        10000,
      );
    });
    await expect(Promise.race([observed, missing])).resolves.toBe("ready\n");
  } finally {
    clearTimeout(guard);
    // Release the old lazy watcher after failure, without changing that verdict.
    await writeFile(path, "ready\n");
    await observed.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
