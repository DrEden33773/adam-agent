import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe("one-shot CLI", () => {
  test("prints one fake-model answer and exits successfully", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "Introduce yourself",
    ]);

    expect(stdout).toBe("Adam Agent received: Introduce yourself\n");
    expect(stderr).toBe("");
  });
});
