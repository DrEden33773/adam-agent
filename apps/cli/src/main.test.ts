import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe("one-shot CLI", () => {
  test("answers a repository question through one read-only tool turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-"));
    const readmePath = join(workspaceRoot, "README.md");
    const originalReadme = "# Orchard\n\nThis repository grows pears.\n";

    try {
      await writeFile(readmePath, originalReadme, "utf8");

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [cliPath, "What does this repository grow?"],
        { cwd: workspaceRoot },
      );

      expect({ stdout, stderr, readme: await readFile(readmePath, "utf8") }).toEqual({
        stdout: "This repository grows pears.\n",
        stderr: "",
        readme: originalReadme,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
