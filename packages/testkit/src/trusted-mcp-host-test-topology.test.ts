import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("trusted-mcp-host.test.ts keeps process contracts in its OS suite", async () => {
  const source = await readFile(new URL("./trusted-mcp-host.test.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/(?:node:)?child_process/u);
});
