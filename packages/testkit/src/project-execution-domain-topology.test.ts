import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("ProjectExecutionDomain is the sole production caller of ProjectLifecycleOwner", async () => {
  const sources = await Promise.all(
    ["extension-host.ts", "operation-host.ts", "session-lifecycle.ts"].map(async (fileName) => ({
      fileName,
      source: await readFile(new URL(`../../agent/src/${fileName}`, import.meta.url), "utf8"),
    })),
  );

  for (const { fileName, source } of sources) {
    expect.soft(source, fileName).not.toMatch(/(?:lifecycleOwner|owner)\.(?:acquire|run)\(/u);
  }
});
