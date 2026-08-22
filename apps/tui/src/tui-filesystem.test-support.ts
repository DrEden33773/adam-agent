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
  const directory = join(path, "..");
  const filename = path.slice(directory.length + 1);
  const watcher = watch(directory);
  const failure = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => failure.reject(new Error(`The fixture did not create ${filename}.`)),
    missingFilesystemEffectFailureMilliseconds,
  );
  guard.unref();
  try {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await Promise.race([
      (async () => {
        for await (const _event of watcher) {
          if (
            await access(path).then(
              () => true,
              () => false,
            )
          ) {
            return;
          }
        }
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
