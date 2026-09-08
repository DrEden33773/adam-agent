import { watch } from "node:fs";
import { dirname } from "node:path";

export async function observeFilesystemEffect<T>(
  path: string,
  observe: () => Promise<T | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let change = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  // Subscribe before the first probe; async-iterator watch starts only on next().
  const watcher = watch(dirname(path), () => change.resolve());
  watcher.on("error", failure.reject);
  const onAbort = () => failure.reject(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const changed = change.promise;
      const observed = await Promise.race([observe(), failure.promise]);
      if (observed !== undefined) return observed;
      await Promise.race([changed, failure.promise]);
      change = Promise.withResolvers<void>();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    watcher.close();
  }
}
