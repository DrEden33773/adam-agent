import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const agentSourceRoot = fileURLToPath(new URL("../../agent/src/", import.meta.url));

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
