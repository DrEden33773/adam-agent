import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { observeFilesystemEffect } from "./filesystem-observation.test-support.js";
import { waitForFilesystemEffect } from "./tui-filesystem.test-support.js";

const filesystemObservationFailureMilliseconds = 10_000;

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
        filesystemObservationFailureMilliseconds,
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

test("a provider release published during its initial probe needs no later filesystem event", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-provider-observation-"));
  const path = join(root, "release-model");
  let initial = true;
  const controller = new AbortController();
  const observed = observeFilesystemEffect(
    path,
    async () => {
      const snapshot = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (initial) {
        initial = false;
        await writeFile(path, "release\n");
      }
      return snapshot;
    },
    controller.signal,
  );
  const guard = setTimeout(
    () => controller.abort(new Error("The provider release notification was lost.")),
    filesystemObservationFailureMilliseconds,
  );
  try {
    await expect(observed).resolves.toBe("release\n");
  } finally {
    clearTimeout(guard);
    controller.abort();
    await observed.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled filesystem observer rejects without needing a producer write", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-cancel-observation-"));
  const controller = new AbortController();
  const probing = Promise.withResolvers<void>();
  const reason = new Error("Fixture stopped.");
  try {
    const observed = observeFilesystemEffect(
      join(root, "release"),
      async () => {
        probing.resolve();
        return undefined;
      },
      controller.signal,
    );
    const rejected = expect(observed).rejects.toBe(reason);
    await probing.promise;
    controller.abort(reason);
    await rejected;
    await expect(
      observeFilesystemEffect(join(root, "release"), async () => undefined, controller.signal),
    ).rejects.toBe(reason);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
