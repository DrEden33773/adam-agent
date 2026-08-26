import { access, readdir, readFile, rm, watch } from "node:fs/promises";
import { join } from "node:path";

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

async function waitForFilesystemEffect<T>(
  path: string,
  observe: () => Promise<T | undefined>,
  action: string,
): Promise<T> {
  const directory = join(path, "..");
  const filename = path.slice(directory.length + 1);
  const watcher = watch(directory);
  const failure = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => failure.reject(new Error(`The fixture did not ${action} ${filename}.`)),
    missingFilesystemEffectFailureMilliseconds,
  );
  guard.unref();
  try {
    const initial = await observe();
    if (initial !== undefined) {
      return initial;
    }
    return await Promise.race([
      (async () => {
        for await (const _event of watcher) {
          const observed = await observe();
          if (observed !== undefined) {
            return observed;
          }
        }
        throw new Error(
          `The filesystem watcher closed before the fixture could ${action} ${filename}.`,
        );
      })(),
      failure.promise,
    ]);
  } finally {
    clearTimeout(guard);
    await watcher.return?.();
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
