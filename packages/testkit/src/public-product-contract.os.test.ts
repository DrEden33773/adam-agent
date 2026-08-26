import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const productRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("the public walkthrough starts from one diagnostic failing test", async () => {
  const fixtureRoot = join(productRoot, "examples", "portfolio-walkthrough");
  const result = await runFixtureTest(fixtureRoot);

  expect(result).toMatchObject({ exitCode: 1, signal: null, stderr: "" });
  expect(result.stdout).toContain("applies the quantity discount to the subtotal in integer cents");
  expect(result.stdout).toContain("2000 !== 2700");
});

function runFixtureTest(cwd: string): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["test/order-total.test.ts"], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (spawnError !== undefined) {
        rejectPromise(spawnError);
        return;
      }
      resolvePromise({ exitCode, signal, stderr, stdout });
    });
  });
}
