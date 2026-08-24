import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { FixtureScenario } from "./fixture-scenario.js";
import { runTuiFixture } from "./test-fixture.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

const fixturePath = fileURLToPath(new URL("../dist/test-fixture.js", import.meta.url));
const fixtureFailureMilliseconds = 30_000;

export type TuiFixtureResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
};

export type TuiFixture = {
  readonly cleanup: () => Promise<void>;
  readonly closed: Promise<TuiFixtureResult>;
  readonly output: () => string;
  readonly resize: (columns: number, rows: number) => Promise<void>;
  readonly terminate: (signal: "SIGHUP" | "SIGKILL" | "SIGTERM") => Promise<void>;
  readonly waitFor: (text: string) => Promise<void>;
  readonly waitForAfter: (text: string, offset: number) => Promise<void>;
  readonly waitForCompleteFrameAfter: (text: string, offset: number) => Promise<void>;
  readonly write: (text: string) => void;
};

export type StartTuiFixtureOptions = {
  readonly controlRoot?: string;
  readonly external?: boolean;
  readonly launch?: {
    readonly configRoot?: string;
    readonly seedTargetIds?: readonly string[];
    readonly startupTargetId?: string;
  };
  readonly noColor?: boolean;
  readonly program?: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly entrypoint: string;
    readonly environment?: Readonly<Record<string, string>>;
  };
  readonly scenario?: FixtureScenario;
  readonly stateRoot: string;
  readonly terminalProcessMarker?: string;
  readonly workspaceRoot: string;
};

const activeFixtures = new Set<TuiFixture>();

export function startTuiFixture(input: StartTuiFixtureOptions): TuiFixture {
  if (input.launch !== undefined && (input.external === true || input.program !== undefined)) {
    throw new TypeError(
      "Project-launch fixture state is available only through the in-process harness.",
    );
  }
  return input.external === true || input.program !== undefined
    ? startExternalTuiFixture(input)
    : startInProcessTuiFixture(input);
}

export async function cleanupActiveTuiFixtures(): Promise<void> {
  await Promise.all([...activeFixtures].map((fixture) => fixture.cleanup()));
  activeFixtures.clear();
}

function startInProcessTuiFixture(input: StartTuiFixtureOptions): TuiFixture {
  const terminal = new VirtualTerminal();
  const execution = withTuiColorEnvironment(input.noColor === true, () =>
    runTuiFixture({
      ...(input.controlRoot === undefined ? {} : { controlRoot: input.controlRoot }),
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
      stateRoot: input.stateRoot,
      terminal,
      workspaceRoot: input.workspaceRoot,
    }),
  );
  const closed = execution.then(
    (): TuiFixtureResult => ({ code: 0, signal: null, stderr: "", stdout: terminal.output() }),
  );
  const cleanup = async (): Promise<void> => {
    await Promise.race([
      terminal.whenStarted(),
      closed.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await closed.catch(() => undefined);
  };
  const fixture: TuiFixture = {
    cleanup,
    closed,
    output: () => terminal.output(),
    resize(columns, rows) {
      const offset = terminal.output().length;
      terminal.resize(columns, rows);
      return terminal.nextOutputContaining("\u001b[?2026l", offset);
    },
    terminate() {
      return Promise.reject(new Error("Only an external TUI fixture accepts process signals."));
    },
    waitFor: (text) => terminal.nextOutputContaining(text),
    waitForAfter: (text, offset) => terminal.nextOutputContaining(text, offset),
    waitForCompleteFrameAfter: (text, offset) =>
      terminal.nextSynchronizedFrameContaining(text, offset),
    write: (text) => terminal.input(text),
  };
  trackFixture(fixture);
  return fixture;
}

async function withTuiColorEnvironment<T>(
  noColor: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const environment = process.env as NodeJS.ProcessEnv & { NO_COLOR?: string };
  const inheritedNoColor = environment.NO_COLOR;
  if (noColor) {
    environment.NO_COLOR = "1";
  } else {
    Reflect.deleteProperty(environment, "NO_COLOR");
  }
  try {
    return await operation();
  } finally {
    if (inheritedNoColor === undefined) {
      Reflect.deleteProperty(environment, "NO_COLOR");
    } else {
      environment.NO_COLOR = inheritedNoColor;
    }
  }
}

function startExternalTuiFixture(input: StartTuiFixtureOptions): TuiFixture {
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
          ...(input.terminalProcessMarker === undefined
            ? []
            : ["--terminal-process-marker", input.terminalProcessMarker]),
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
  const processClose = Promise.withResolvers<void>();
  const outputWaiters = new Set<{
    readonly offset: number;
    readonly text: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly guard: ReturnType<typeof setTimeout>;
  }>();
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
    processClose.resolve();
    processResult.resolve({ code, signal });
  });
  child.once("error", (error) => {
    processResult.reject(error);
  });

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
      return await Promise.race([processClose.promise.then(() => true), guard.promise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const performCleanup = async (): Promise<void> => {
    if (!processClosed) {
      signalProcessGroup("SIGTERM");
      if (!(await awaitCloseWithGuard(1_000))) {
        signalProcessGroup("SIGKILL");
        if (!(await awaitCloseWithGuard(1_000))) {
          throw new Error("The real TUI process did not close after SIGKILL.");
        }
      }
    }
    await processResult.promise.catch(() => undefined);
  };
  let cleanupInFlight: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupInFlight ??= performCleanup();
    return cleanupInFlight;
  };
  const result = new Promise<TuiFixtureResult>((resolve, reject) => {
    processResult.promise.then(
      (settled) => resolve({ ...settled, stderr, stdout }),
      (error: unknown) => reject(error),
    );
    const failureGuard = setTimeout(() => {
      reject(
        new Error(
          `The real TUI process did not close after reaching its expected causal state. stdout tail: ${JSON.stringify(stdout.slice(-2_000))}; stderr: ${JSON.stringify(stderr)}`,
        ),
      );
      void cleanup().catch(() => undefined);
    }, fixtureFailureMilliseconds);
    failureGuard.unref();
    void processResult.promise.then(
      () => clearTimeout(failureGuard),
      () => clearTimeout(failureGuard),
    );
  });
  const settleOutputWaiters = () => {
    for (const waiter of outputWaiters) {
      clearTimeout(waiter.guard);
      waiter.reject(
        new Error(
          `The TUI process closed before rendering ${waiter.text}. stdout tail: ${JSON.stringify(stdout.slice(-2_000))}; stderr: ${JSON.stringify(stderr)}`,
        ),
      );
    }
    outputWaiters.clear();
  };
  void processResult.promise.then(settleOutputWaiters, settleOutputWaiters);
  const waitForAfter = (text: string, offset: number): Promise<void> => {
    if (stdout.indexOf(text, offset) >= 0) {
      return Promise.resolve();
    }
    if (processClosed) {
      return Promise.reject(
        new Error(
          `The TUI process already closed without rendering ${text}. stdout tail: ${JSON.stringify(stdout.slice(-2_000))}; stderr: ${JSON.stringify(stderr)}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        offset,
        text,
        resolve,
        reject,
        guard: setTimeout(() => {
          outputWaiters.delete(waiter);
          reject(
            new Error(
              `The real TUI process did not render ${text}. stdout tail: ${JSON.stringify(stdout.slice(-2_000))}; stderr: ${JSON.stringify(stderr)}`,
            ),
          );
          void cleanup().catch(() => undefined);
        }, fixtureFailureMilliseconds),
      };
      waiter.guard.unref();
      outputWaiters.add(waiter);
    });
  };
  const fixture: TuiFixture = {
    cleanup,
    closed: result,
    output: () => stdout,
    async resize(columns, rows) {
      if (input.terminalProcessMarker === undefined) {
        throw new Error("The external TUI fixture requires a terminal process marker to resize.");
      }
      const processId = Number.parseInt(await readFile(input.terminalProcessMarker, "utf8"), 10);
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        throw new Error("The external TUI fixture recorded an invalid terminal process identity.");
      }
      await resizeTerminalProcess(processId, columns, rows);
    },
    async terminate(signal) {
      if (signal === "SIGKILL") {
        signalProcessGroup(signal);
        return;
      }
      if (input.terminalProcessMarker === undefined) {
        throw new Error("The external TUI fixture requires a terminal process marker to signal.");
      }
      const processId = Number.parseInt(await readFile(input.terminalProcessMarker, "utf8"), 10);
      if (!Number.isSafeInteger(processId) || processId <= 0) {
        throw new Error("The external TUI fixture recorded an invalid terminal process identity.");
      }
      process.kill(processId, signal);
    },
    waitFor: (text) => waitForAfter(text, 0),
    waitForAfter,
    async waitForCompleteFrameAfter(text, offset) {
      await waitForAfter(text, offset);
      const occurrence = stdout.indexOf(text, offset);
      await waitForAfter("\u001b[?2026l", occurrence + text.length);
    },
    write: (text) => child.stdin.write(text),
  };
  trackFixture(fixture, processClose.promise);
  return fixture;
}

async function resizeTerminalProcess(
  processId: number,
  columns: number,
  rows: number,
): Promise<void> {
  if (!Number.isSafeInteger(columns) || columns <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new TypeError("Terminal dimensions must be positive safe integers.");
  }
  const resized = spawn(
    "stty",
    ["-F", `/proc/${processId}/fd/1`, "cols", String(columns), "rows", String(rows)],
    { stdio: "ignore" },
  );
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>((resolve, reject) => {
    resized.once("error", reject);
    resized.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error("The external TUI fixture could not resize its pseudo-terminal.");
  }
  process.kill(processId, "SIGWINCH");
}

function trackFixture(fixture: TuiFixture, settlement: Promise<unknown> = fixture.closed): void {
  activeFixtures.add(fixture);
  void fixture.closed.catch(() => undefined);
  void settlement.then(
    () => activeFixtures.delete(fixture),
    () => activeFixtures.delete(fixture),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
