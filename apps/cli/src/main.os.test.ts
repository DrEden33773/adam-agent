import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("one-shot CLI deterministic coding process", () => {
  test("keeps the fake coding prompt authoritative when user Skills are visible", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-fake-skill-context-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const configRoot = join(testRoot, "config");
    const userHome = join(testRoot, "home");
    const skillRoot = join(userHome, ".agents", "skills", "visible-skill");
    const demoPath = join(workspaceRoot, "demo.txt");
    await mkdir(workspaceRoot);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(demoPath, "before\n", "utf8");
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: visible-skill\ndescription: Visible deterministic fixture.\n---\n\nKeep this bounded.\n",
      "utf8",
    );

    try {
      const trusted = await runCliArguments({
        args: ["--trust-workspace"],
        cwd: workspaceRoot,
        environment: { HOME: userHome, XDG_CONFIG_HOME: configRoot },
        stateRoot,
      });
      expect(trusted).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
      const result = await runCliArguments({
        args: ["Update the demo file and verify it"],
        cwd: workspaceRoot,
        environment: { HOME: userHome, XDG_CONFIG_HOME: configRoot },
        stateRoot,
        permissionDecisions: ["y", "y"],
      });
      expect({ result, content: await readFile(demoPath, "utf8") }).toEqual({
        result: {
          stdout: "The demo file was updated and verified.\n",
          stderr:
            'Allow edit_file patch (update "demo.txt"; sha256:3140812d57f41d8a7cd3d7631794832d62016234af63f1bc9ea87fc29fd6a441) [y/N] Allow run_shell at ".": "test \\"$(cat demo.txt)\\" = after && printf verified" [y/N] ',
          exitCode: 0,
          signal: null,
        },
        content: "after\n",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});

async function runCliArguments(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stateRoot: string;
  readonly permissionDecisions?: readonly string[];
}): Promise<CliResult> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...input.environment };
  for (const name of [
    "ADAM_AGENT_MODEL",
    "ADAM_AGENT_PROVIDER",
    "ADAM_AGENT_TARGET",
    "DEEPSEEK_API_KEY",
  ] as const) {
    delete environment[name];
  }
  const child = spawn(process.execPath, [cliPath, ...input.args], {
    cwd: input.cwd,
    env: {
      ...environment,
      ADAM_AGENT_STATE_ROOT: input.stateRoot,
      ADAM_AGENT_TARGET: "fake.local",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let permissionPromptOffset = 0;
  let permissionDecisionIndex = 0;
  let allPermissionDecisionsWritten = false;
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    if (allPermissionDecisionsWritten) {
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    const stderrText = Buffer.concat(stderr).toString("utf8");
    let promptIndex = stderrText.indexOf("[y/N] ", permissionPromptOffset);
    while (promptIndex !== -1) {
      permissionPromptOffset = promptIndex + "[y/N] ".length;
      const decision = input.permissionDecisions?.[permissionDecisionIndex];
      if (decision !== undefined) {
        permissionDecisionIndex += 1;
        child.stdin.write(`${decision}\n`);
        if (permissionDecisionIndex === input.permissionDecisions?.length) {
          allPermissionDecisionsWritten = true;
        }
      }
      promptIndex = stderrText.indexOf("[y/N] ", permissionPromptOffset);
    }
  });
  if (input.permissionDecisions === undefined || input.permissionDecisions.length === 0) {
    child.stdin.end();
  }

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
