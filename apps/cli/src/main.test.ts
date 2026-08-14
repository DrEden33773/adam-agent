import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe("one-shot CLI", () => {
  test("answers a repository question through one read-only tool turn", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);
    const readmePath = join(workspaceRoot, "README.md");
    const originalReadme = "# Orchard\n\nThis repository grows pears.\n";

    try {
      await writeFile(readmePath, originalReadme, "utf8");

      const { stdout, stderr, exitCode, signal } = await runCli({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
        prompt: "What does this repository grow?",
        stdin: "",
      });

      expect({
        stdout,
        stderr,
        exitCode,
        signal,
        readme: await readFile(readmePath, "utf8"),
      }).toEqual({
        stdout: "This repository grows pears.\n",
        stderr: "",
        exitCode: 0,
        signal: null,
        readme: originalReadme,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("asks on stderr and accepts a piped y before running a shell command", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-shell-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const result = await runCli({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
        prompt: "Run the repository verification command",
        stdin: "y\n",
      });

      expect(result).toEqual({
        stdout: "The verification command produced cli-verified.\n",
        stderr: 'Allow run_shell at ".": "printf cli-verified" [y/N] ',
        exitCode: 0,
        signal: null,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test.each([
    { label: "n", stdin: "n\n" },
    { label: "invalid input", stdin: "yes\n" },
    { label: "surrounding whitespace", stdin: " y \n" },
    { label: "EOF", stdin: "" },
  ])("treats $label as a denied shell approval", async ({ stdin }) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-shell-deny-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const result = await runCli({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
        prompt: "Run the repository verification command",
        stdin,
      });

      expect(result).toEqual({
        stdout: "The verification command was not run.\n",
        stderr: 'Allow run_shell at ".": "printf cli-verified" [y/N] ',
        exitCode: 0,
        signal: null,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("escapes model-controlled control characters in an approval prompt", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-prompt-escaping-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const result = await runCli({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
        prompt: "Run the prompt escaping command",
        stdin: "n\n",
      });

      expect(result).toEqual({
        stdout: "The verification command was not run.\n",
        stderr:
          'Allow run_shell at ".": "printf first\\n\\u001b[31m\\u202ecommand\\u009b\\u2028forged" [y/N] ',
        exitCode: 0,
        signal: null,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("SIGINT while approval is pending cancels the session with exit code 130", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-permission-interrupt-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const result = await interruptCliAtPermission({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
      });

      expect(result).toEqual({
        stdout: "",
        stderr: 'Allow run_shell at ".": "printf cli-verified" [y/N] The session was cancelled.\n',
        exitCode: 130,
        signal: null,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("SIGINT during an approved shell command cancels and cleans up the command", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-shell-interrupt-"));
    const workspaceRoot = join(testRoot, "workspace");
    await mkdir(workspaceRoot);

    try {
      const result = await interruptCliDuringShell({
        cwd: workspaceRoot,
        stateRoot: join(testRoot, "state"),
        stdinPath: join(testRoot, "stdin"),
      });

      expect({
        ...result,
        survived: await readFile(join(workspaceRoot, "survived.txt"), "utf8").catch(
          () => undefined,
        ),
      }).toEqual({
        stdout: "",
        stderr:
          'Allow run_shell at ".": "trap \'\' TERM; printf started > started.txt; sleep 5; printf survived > survived.txt" [y/N] The session was cancelled.\n',
        exitCode: 130,
        signal: null,
        survived: undefined,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("edits, verifies, and persists one approved coding task", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-cli-coding-task-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const targetPath = join(workspaceRoot, "demo.txt");
    await mkdir(workspaceRoot);
    await writeFile(targetPath, "before\n", "utf8");

    try {
      const result = await runCli({
        cwd: workspaceRoot,
        stateRoot,
        prompt: "Update the demo file and verify it",
        stdin: "y\ny\n",
      });
      const persistedEvents = await readOnlySessionEvents(stateRoot);

      expect({
        ...result,
        content: await readFile(targetPath, "utf8"),
        completedTools: persistedEvents
          .filter((event) => event.type === "tool_completed")
          .map((event) => event.name),
        settled: persistedEvents.at(-1)?.type,
      }).toEqual({
        stdout: "The demo file was updated and verified.\n",
        stderr:
          'Allow edit_file for "demo.txt" [y/N] Allow run_shell at ".": "test \\"$(cat demo.txt)\\" = after && printf verified" [y/N] ',
        exitCode: 0,
        signal: null,
        content: "after\n",
        completedTools: ["edit_file", "run_shell"],
        settled: "session_settled",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});

type StoredEventSummary = {
  readonly type: string;
  readonly name?: string;
};

async function readOnlySessionEvents(stateRoot: string): Promise<readonly StoredEventSummary[]> {
  const projectIds = await readdir(join(stateRoot, "projects"));
  const projectId = projectIds.at(0);
  if (projectIds.length !== 1 || projectId === undefined) {
    throw new Error("Expected one persisted project.");
  }
  const sessionsDirectory = join(stateRoot, "projects", projectId, "sessions");
  const sessionFiles = await readdir(sessionsDirectory);
  const sessionFile = sessionFiles.at(0);
  if (sessionFiles.length !== 1 || sessionFile === undefined) {
    throw new Error("Expected one persisted session.");
  }
  return (await readFile(join(sessionsDirectory, sessionFile), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { readonly event: StoredEventSummary }).event);
}

async function interruptCliDuringShell(options: {
  readonly cwd: string;
  readonly stateRoot: string;
  readonly stdinPath: string;
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  await writeFile(options.stdinPath, "y\n", "utf8");
  const input = await open(options.stdinPath, "r");
  const child = spawn(process.execPath, [cliPath, "Run the long repository verification command"], {
    cwd: options.cwd,
    env: { ...process.env, ADAM_AGENT_STATE_ROOT: options.stateRoot },
    stdio: [input.fd, "pipe", "pipe"],
  });
  await input.close();
  if (child.stdout === null || child.stderr === null) {
    throw new Error("The CLI child did not expose output streams.");
  }
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (exitCode, signal) => {
      resolvePromise({ stdout, stderr, exitCode, signal });
    });
  });
  await waitForFile(join(options.cwd, "started.txt"));
  child.kill("SIGINT");
  return closed;
}

async function interruptCliAtPermission(options: {
  readonly cwd: string;
  readonly stateRoot: string;
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, "Run the repository verification command"], {
      cwd: options.cwd,
      env: { ...process.env, ADAM_AGENT_STATE_ROOT: options.stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    let shutdownGuard: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (!interrupted && stderr.includes("[y/N] ")) {
        interrupted = true;
        if (!child.kill("SIGINT")) {
          rejectPromise(new Error("The CLI process did not accept SIGINT."));
          return;
        }
        shutdownGuard = setTimeout(() => {
          child.kill("SIGKILL");
          rejectPromise(new Error("The CLI process did not exit after SIGINT."));
        }, 10_000);
      }
    });
    child.once("error", (error) => {
      clearTimeout(shutdownGuard);
      rejectPromise(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(shutdownGuard);
      resolvePromise({ stdout, stderr, exitCode, signal });
    });
  });
}

async function runCli(options: {
  readonly cwd: string;
  readonly stateRoot: string;
  readonly prompt: string;
  readonly stdin: string;
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'printf "%s" "$ADAM_AGENT_CLI_TEST_STDIN" | "$1" "$2" "$3"',
        "adam-agent-cli-test",
        process.execPath,
        cliPath,
        options.prompt,
      ],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ADAM_AGENT_CLI_TEST_STDIN: options.stdin,
          ADAM_AGENT_STATE_ROOT: options.stateRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode, signal) => {
      resolvePromise({ stdout, stderr, exitCode, signal });
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await readFile(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
