import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { observeFilesystemEffect } from "./filesystem-observation.test-support.js";
import { cleanupActiveTuiFixtures } from "./tui-fixture.test-support.js";

const missingFilesystemEffectFailureMilliseconds = 30_000;

export async function removeTuiFixtureRoot(
  path: string,
  _options?: { readonly force: boolean; readonly recursive: boolean },
): Promise<void> {
  await cleanupActiveTuiFixtures();
  await rm(path, { recursive: true, force: true });
}

export async function waitForPath(path: string): Promise<void> {
  await waitForFilesystemEffect(
    path,
    async () =>
      access(path).then(
        () => true,
        () => undefined,
      ),
    "create",
  );
}

export async function waitForFileContents(path: string, expected: string): Promise<string> {
  return await waitForFilesystemEffect(
    path,
    async () => {
      try {
        const contents = await readFile(path, "utf8");
        return contents === expected ? contents : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    "publish the expected contents for",
  );
}

export async function waitForFilesystemEffect<T>(
  path: string,
  observe: () => Promise<T | undefined>,
  action: string,
): Promise<T> {
  const directory = join(path, "..");
  const filename = path.slice(directory.length + 1);
  const controller = new AbortController();
  const guard = setTimeout(
    () => controller.abort(new Error(`The fixture did not ${action} ${filename}.`)),
    missingFilesystemEffectFailureMilliseconds,
  );
  guard.unref();
  try {
    return await observeFilesystemEffect(path, observe, controller.signal);
  } finally {
    clearTimeout(guard);
  }
}

export async function readFilesRecursively(root: string): Promise<string> {
  const contents: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      contents.push(await readFilesRecursively(path));
    } else if (entry.isFile()) {
      contents.push(await readFile(path, "utf8"));
    }
  }
  return contents.join("\n");
}
