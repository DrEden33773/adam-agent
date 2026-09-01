import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const agentSourceRoot = fileURLToPath(new URL("../../agent/src/", import.meta.url));

test("ProjectExecutionDomain is the sole production caller of ProjectLifecycleOwner", async () => {
  const sources = await productionAgentSources();
  const ownerMethodCalls = sources.flatMap(({ path, source }) =>
    [...source.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(acquire|run)\(/gu)].map(
      (match) => ({ call: `${match[1]}.${match[2]}`, path }),
    ),
  );

  expect(ownerMethodCalls).toEqual([
    { call: "options.lifecycleOwner.acquire", path: "project-execution-domain.ts" },
    { call: "session.run", path: "session-lifecycle.ts" },
    { call: "coordinator.run", path: "tool-runtime.ts" },
  ]);
  expect(
    sources.flatMap(({ path, source }) =>
      /\[["'](?:acquire|run)["']\]/u.test(source) ? [path] : [],
    ),
  ).toEqual([]);
});

test("ProjectExecutionDomain stays out of the public ExtensionHost interface", async () => {
  const extensionHostSource = await readFile(join(agentSourceRoot, "extension-host.ts"), "utf8");
  const publicFacadeSource = await readFile(join(agentSourceRoot, "index.ts"), "utf8");
  const interfaceSource = extensionHostSource.match(
    /export interface ExtensionHost \{([\s\S]*?)\n\}/u,
  )?.[1];

  expect(interfaceSource).toBeDefined();
  expect(interfaceSource).not.toMatch(/ProjectExecutionDomain|extensionProjectExecutionDomain/u);
  expect(publicFacadeSource).not.toMatch(/ProjectExecutionDomain/u);
});

async function productionAgentSources(): Promise<readonly { path: string; source: string }[]> {
  const entries = (await readdir(agentSourceRoot, { recursive: true }))
    .filter(
      (entry) =>
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".os.test.ts") &&
        !entry.endsWith(".fixture.ts"),
    )
    .sort();
  return Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(agentSourceRoot, entry);
      return {
        path: relative(agentSourceRoot, absolutePath),
        source: await readFile(absolutePath, "utf8"),
      };
    }),
  );
}
