import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

describe("one-shot CLI process help", () => {
  test("prints public help without creating session state", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-help-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    await mkdir(workspaceRoot);

    try {
      const result = await runCliArguments({ args: ["--help"], cwd: workspaceRoot, stateRoot });

      expect({ result, statePersisted: await pathExists(stateRoot) }).toEqual({
        result: {
          stdout: expect.stringContaining("Usage: adam-agent <prompt>"),
          stderr: "",
          exitCode: 0,
          signal: null,
        },
        statePersisted: false,
      });
      expect(result.stdout).toContain("Linux source checkout");
      expect(result.stdout).toContain('ADAM_AGENT_TARGET=fake.local pnpm --silent adam "<prompt>"');
      expect(result.stdout).toContain("pnpm tui");
      expect(result.stdout).toContain("--resume without --continue hydrates only");
      expect(result.stdout).toContain("Final answers use stdout; approvals and errors use stderr");
      expect(result.stdout).toContain(
        "Approvals and built-in path confinement are not an OS, process, or network sandbox",
      );
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("prints identical short help before reading project environment", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-short-help-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    await mkdir(join(workspaceRoot, ".env"), { recursive: true });

    try {
      const shortResult = await runCliArguments({ args: ["-h"], cwd: workspaceRoot, stateRoot });
      const longResult = await runCliArguments({ args: ["--help"], cwd: workspaceRoot, stateRoot });

      expect({ result: shortResult, statePersisted: await pathExists(stateRoot) }).toEqual({
        result: {
          stdout: expect.stringContaining("Usage: adam-agent <prompt>"),
          stderr: "",
          exitCode: 0,
          signal: null,
        },
        statePersisted: false,
      });
      expect(shortResult).toEqual(longResult);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});

async function runCliArguments(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stateRoot: string;
}): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...input.args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ADAM_AGENT_STATE_ROOT: input.stateRoot,
      ADAM_AGENT_TARGET: "fake.local",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  return await new Promise<CliResult>((resolve, reject) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
