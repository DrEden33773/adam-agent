import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm as remove, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

const fixturePath = fileURLToPath(new URL("../dist/test-fixture.js", import.meta.url));
const productionPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixtureFailureMilliseconds = 30_000;
const activeFixtures = new Set<Fixture>();

afterEach(async () => {
  await cleanupActiveFixtures();
});

test("real TUI starts on an authoritative empty session and restores the terminal on exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Adam · New session");
    expect(result.stdout).toContain("fake.local · Certified");
    expect(result.stdout).toContain("\u001b[?2004h");
    expect(result.stdout).toContain("\u001b[?2004l");
    expect(result.stdout).toContain("\u001b[?2026h");
    expect(result.stdout).toContain("\u001b[?2026l");
    expect(result.stdout).toContain("\u001b[?25h");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI entry exposes its usage contract", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: { arguments: ["--help"], cwd: workspaceRoot, entrypoint: productionPath },
      stateRoot,
      workspaceRoot,
    });
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain(
      "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>]",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI entry rejects conflicting target and resume arguments", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-invalid-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: [
          "--resume",
          "session-id",
          "--target",
          "deepseek-v4-flash.direct",
          "--state-root",
          stateRoot,
        ],
        cwd: workspaceRoot,
        entrypoint: productionPath,
      },
      stateRoot,
      workspaceRoot,
    });
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(result.stdout).toContain("--resume and --target cannot be combined.");
    expect(result.stdout).toContain("Usage: adam-agent-tui");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI entry reaches a credentialed exact-target session without a model call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-startup-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("editor submission renders Working then a streamed Markdown answer from real Presentation truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-streaming-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Explain streaming\r");
    await fixture.waitFor("Explain streaming");
    await fixture.waitFor("Working");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("\u001b[48;2;49;50;68m");
    expect(result.stdout).toContain("\u001b[38;2;243;139;168m");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a real read tool is rendered as a bounded Pi-style tool card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-read-tool-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Fixture\n\nReadable content.\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "read", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Read README\r");
    await fixture.waitFor("read README.md");
    await fixture.waitFor("29 bytes");
    await fixture.waitFor("Read complete");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a shell tool card uses the accepted dollar-command grammar", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-shell-card-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "shell", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Show shell card\r");
    await fixture.waitFor("$ printf shell-card-fixture");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a mutation permission shows its canonical diff and Enter allows the exact call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mutation-permission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "mutation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Edit the file\r");
    await fixture.waitFor("Permission required");
    await fixture.waitFor("-before");
    await fixture.waitFor("+after");
    fixture.write("\r");
    await fixture.waitFor("Edit complete");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("after\n");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Enter cannot allow a mutation while its canonical preview is still loading", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-preview-loading-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "mutation-delayed-preview",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Edit before preview\r");
    await fixture.waitFor("Loading canonical preview");
    await fixture.waitFor("Allow unavailable");
    fixture.write("\r");
    await writeFile(join(controlRoot, "release-preview"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "preview-read-complete"));
    await fixture.waitFor("denied");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("before\n");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+C cancels one active run and repeated input cannot arm exit while settling", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "cancellation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Cancel this run\r");
    await fixture.waitFor("Working");
    fixture.write("\u0003\u0003");
    await fixture.waitFor("cancelled");
    expect(fixture.output()).not.toContain("Press Ctrl+C again");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("idle Ctrl+C preserves a CJK draft and copies it only on the confirming press", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-retained-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const draft = "保留草稿 🚀";

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write(draft);
    await fixture.waitFor(draft);
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit · draft will be copied");
    expect(fixture.output()).not.toContain("clipboard copied");
    fixture.write("\u0003");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(draft);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Kitty Ctrl+C repeat and release phases cannot confirm an armed exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-kitty-phases-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("草稿");
    await fixture.waitFor("草稿");
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    fixture.write("\u001b[99;5:2u\u001b[99;5:3ux");
    await fixture.waitFor("草稿x");
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe("草稿x");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the injected deadline causally expires an idle Ctrl+C exit arm", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-exit-expiry-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "deadline", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    await waitForPath(join(controlRoot, "scheduled-deadline-2000-1"));
    const armedOutputEnd = fixture.output().length;
    await writeFile(join(controlRoot, "deadline-2000-1"), "expire\n", "utf8");
    await fixture.waitForAfter("fake.local · Certified", armedOutputEnd);
    const expiredOutputEnd = fixture.output().length;
    fixture.write("\u001b[99;5:1u");
    await fixture.waitForAfter("Press Ctrl+C again within two seconds to exit", expiredOutputEnd);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the legacy duplicate guard consumes one immediate Ctrl+C duplicate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-legacy-duplicate-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "deadline", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("保留");
    await fixture.waitFor("保留");
    fixture.write("\u0003\u0003");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    await waitForPath(join(controlRoot, "scheduled-deadline-50-1"));
    await writeFile(join(controlRoot, "deadline-50-1"), "expire\n", "utf8");
    fixture.write("x");
    await fixture.waitFor("保留x");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a pending clipboard adapter fails closed from the injected deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clipboard-timeout-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-timeout",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("保留超时草稿");
    await fixture.waitFor("保留超时草稿");
    fixture.write("\u0011");
    await waitForPath(join(controlRoot, "clipboard-started"));
    await waitForPath(join(controlRoot, "scheduled-deadline-250-1"));
    await writeFile(join(controlRoot, "deadline-250-1"), "expire\n", "utf8");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Clipboard copy failed; draft was not copied.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("unsupported clipboard is reported after terminal restoration without blocking exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clipboard-unsupported-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("draft without clipboard");
    await fixture.waitFor("draft without clipboard");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Clipboard unavailable; draft was not copied.");
    expect(result.stdout.indexOf("\u001b[?2004l")).toBeLessThan(
      result.stdout.indexOf("Clipboard unavailable; draft was not copied."),
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a restarted TUI resumes an existing authoritative transcript", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-resume-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "resume", stateRoot, workspaceRoot });
    await fixture.waitFor("Resume transcript");
    await fixture.waitFor("Previous answer");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("untrusted model terminal controls are rendered as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-terminal-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      noColor: true,
      scenario: "unsafe-output",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Render unsafe output\r");
    await fixture.waitFor("Visible");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain("\u001b]52;c;YXR0YWNr\u0007");
    expect(result.stdout).not.toContain("\u001b[2Janswer");
    expect(result.stdout).not.toContain("\u001b[38;2;");
    expect(result.stdout).not.toContain("\u001b[48;2;");
    expect(result.stdout).toContain("› Render unsafe output");
    expect(result.stdout).toContain("Visible answer.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

type FixtureResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
};

type Fixture = {
  readonly cleanup: () => Promise<void>;
  readonly closed: Promise<FixtureResult>;
  readonly output: () => string;
  readonly waitFor: (text: string) => Promise<void>;
  readonly waitForAfter: (text: string, offset: number) => Promise<void>;
  readonly write: (text: string) => void;
};

function startFixture(input: {
  readonly controlRoot?: string;
  readonly noColor?: boolean;
  readonly program?: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly entrypoint: string;
    readonly environment?: Readonly<Record<string, string>>;
  };
  readonly scenario?:
    | "cancellation"
    | "clipboard-timeout"
    | "clipboard-success"
    | "deadline"
    | "mutation"
    | "mutation-delayed-preview"
    | "read"
    | "resume"
    | "shell"
    | "streaming"
    | "unsafe-output";
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): Fixture {
  const arguments_ =
    input.program === undefined
      ? [
          process.execPath,
          fixturePath,
          "--state-root",
          input.stateRoot,
          "--workspace-root",
          input.workspaceRoot,
          ...(input.controlRoot === undefined ? [] : ["--control-root", input.controlRoot]),
          ...(input.scenario === undefined ? [] : ["--scenario", input.scenario]),
        ]
      : [process.execPath, input.program.entrypoint, ...input.program.arguments];
  const command = arguments_.map(shellQuote).join(" ");
  const { NO_COLOR: _noColor, ...environment } = process.env;
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    ...(input.program === undefined ? {} : { cwd: input.program.cwd }),
    detached: true,
    env: {
      ...environment,
      ...input.program?.environment,
      ...(input.noColor === true ? { NO_COLOR: "1" } : {}),
      TERM: "xterm-256color",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let processClosed = false;
  const outputWaiters = new Set<{
    readonly offset: number;
    readonly text: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly guard: ReturnType<typeof setTimeout>;
  }>();
  let failureGuard: ReturnType<typeof setTimeout> | undefined;
  const processResult = Promise.withResolvers<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const waiter of outputWaiters) {
      if (stdout.indexOf(waiter.text, waiter.offset) >= 0) {
        clearTimeout(waiter.guard);
        outputWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("close", (code, signal) => {
    processClosed = true;
    processResult.resolve({ code, signal });
  });
  child.once("error", (error) => processResult.reject(error));

  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || processClosed) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
    }
  };
  const awaitCloseWithGuard = async (milliseconds: number): Promise<boolean> => {
    if (processClosed) {
      return true;
    }
    const guard = Promise.withResolvers<boolean>();
    const timeout = setTimeout(() => guard.resolve(false), milliseconds);
    timeout.unref();
    try {
      return await Promise.race([processResult.promise.then(() => true), guard.promise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const cleanup = async (): Promise<void> => {
    if (!processClosed) {
      signalProcessGroup("SIGTERM");
      if (!(await awaitCloseWithGuard(1_000))) {
        signalProcessGroup("SIGKILL");
      }
    }
    await processResult.promise.catch(() => undefined);
  };
  let timedOut = false;
  const result = new Promise<FixtureResult>((resolve, reject) => {
    processResult.promise.then(
      (settled) => {
        if (timedOut) {
          reject(new Error("The real TUI process did not reach startup and causal close."));
        } else {
          resolve({ ...settled, stderr, stdout });
        }
      },
      (error: unknown) => reject(error),
    );
    failureGuard = setTimeout(() => {
      timedOut = true;
      void cleanup();
    }, fixtureFailureMilliseconds);
    failureGuard.unref();
  });
  void result.then(
    () => {
      activeFixtures.delete(fixture);
    },
    () => {
      activeFixtures.delete(fixture);
    },
  );
  const settleOutputWaiters = () => {
    if (failureGuard !== undefined) {
      clearTimeout(failureGuard);
    }
    for (const waiter of outputWaiters) {
      clearTimeout(waiter.guard);
      waiter.reject(new Error(`The TUI process closed before rendering ${waiter.text}.`));
    }
    outputWaiters.clear();
  };
  void processResult.promise.then(settleOutputWaiters, settleOutputWaiters);
  const fixture: Fixture = {
    cleanup,
    closed: result,
    output: () => stdout,
    waitFor(text) {
      return waitForAfter(text, 0);
    },
    waitForAfter,
    write(text) {
      child.stdin.write(text);
    },
  };
  function waitForAfter(text: string, offset: number): Promise<void> {
    if (stdout.indexOf(text, offset) >= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        offset,
        text,
        resolve,
        reject,
        guard: setTimeout(() => {
          outputWaiters.delete(waiter);
          void cleanup().then(
            () => reject(new Error(`The real TUI process did not render ${text}.`)),
            () => reject(new Error(`The real TUI process did not render ${text}.`)),
          );
        }, fixtureFailureMilliseconds),
      };
      outputWaiters.add(waiter);
    });
  }
  activeFixtures.add(fixture);
  return fixture;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function cleanupActiveFixtures(): Promise<void> {
  await Promise.all([...activeFixtures].map((fixture) => fixture.cleanup()));
  activeFixtures.clear();
}

async function rm(path: string, options: { readonly force: boolean; readonly recursive: boolean }) {
  await cleanupActiveFixtures();
  await remove(path, options);
}

async function waitForPath(path: string): Promise<void> {
  const directory = join(path, "..");
  const filename = path.slice(directory.length + 1);
  const watcher = watch(directory);
  const failure = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => failure.reject(new Error(`The fixture did not create ${filename}.`)),
    fixtureFailureMilliseconds,
  );
  try {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await Promise.race([
      (async () => {
        for await (const event of watcher) {
          if (
            event.filename === filename &&
            (await access(path).then(
              () => true,
              () => false,
            ))
          ) {
            return;
          }
        }
      })(),
      failure.promise,
    ]);
  } finally {
    clearTimeout(guard);
    await watcher.return?.();
  }
}
