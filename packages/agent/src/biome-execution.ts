import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  EXTENSION_BIOME_MAX_STDERR_BYTES,
  EXTENSION_BIOME_MAX_STDOUT_BYTES,
  EXTENSION_BIOME_PROFILE,
  type ExtensionBiomeFileSnapshot,
} from "@adam-agent/extension-api";

export type BiomeExecutionInput = {
  readonly deadlineAt: string;
  readonly files: readonly ExtensionBiomeFileSnapshot[];
  readonly profile: "adam-biome-recommended-v1";
  readonly signal: AbortSignal;
};

export type BiomeExecutionOutput = {
  readonly analyzerVersion: string;
  readonly exitCode: number;
  readonly report: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
};

export interface BiomeExecutionAdapter {
  execute(input: BiomeExecutionInput): Promise<BiomeExecutionOutput>;
}

const biomeVersion = "2.5.8";
const biomeExecutable = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

export function createBiomeExecutionAdapter(): BiomeExecutionAdapter {
  return {
    async execute(input) {
      if (input.profile !== EXTENSION_BIOME_PROFILE) {
        throw new TypeError("The Biome profile is unsupported.");
      }
      const snapshotRoot = await mkdtemp(join(tmpdir(), "adam-agent-biome-"));
      try {
        const filesRoot = join(snapshotRoot, "snapshot");
        const isolatedHome = join(snapshotRoot, "home");
        await mkdir(filesRoot, { mode: 0o700 });
        await mkdir(isolatedHome, { mode: 0o700 });
        for (const file of input.files) {
          const path = resolveSnapshotPath(filesRoot, file);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
        const configurationPath = join(snapshotRoot, "adam-biome.json");
        await writeFile(
          configurationPath,
          JSON.stringify({
            assist: { enabled: false },
            formatter: { enabled: false },
            linter: { enabled: true, rules: { recommended: true } },
          }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        const processOutput = await runBiomeProcess({
          configurationPath,
          deadlineAt: input.deadlineAt,
          isolatedHome,
          signal: input.signal,
          snapshotRoot: filesRoot,
        });
        return {
          analyzerVersion: biomeVersion,
          exitCode: processOutput.exitCode,
          report: processOutput.stdout,
          stderr: processOutput.stderr,
          stdout: processOutput.stdout,
        };
      } finally {
        await rm(snapshotRoot, { recursive: true, force: true });
      }
    },
  };
}

function resolveSnapshotPath(root: string, file: ExtensionBiomeFileSnapshot): string {
  const path = resolve(root, file.path);
  if (path === root || !path.startsWith(`${root}/`)) {
    throw new TypeError("The Biome snapshot path is invalid.");
  }
  return path;
}

async function runBiomeProcess(options: {
  readonly configurationPath: string;
  readonly deadlineAt: string;
  readonly isolatedHome: string;
  readonly signal: AbortSignal;
  readonly snapshotRoot: string;
}): Promise<{
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}> {
  const timeoutMs = Date.parse(options.deadlineAt) - Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || options.signal.aborted) {
    throw new Error("The Biome execution was cancelled before it started.");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        biomeExecutable,
        [
          "check",
          "--reporter=json",
          "--max-diagnostics=none",
          "--no-errors-on-unmatched",
          "--config-path",
          options.configurationPath,
          ".",
        ],
        {
          cwd: options.snapshotRoot,
          detached: true,
          env: createBiomeEnvironment(options.isolatedHome),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.end();
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let closed = false;
    const terminate = () => signalProcessGroup(child.pid, "SIGKILL");
    const fail = (error: Error) => {
      failure ??= error;
      terminate();
    };
    const timeout = setTimeout(
      () => fail(new Error("The Biome execution exceeded its deadline.")),
      timeoutMs,
    );
    timeout.unref();
    const abort = () => fail(new Error("The Biome execution was cancelled."));
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > EXTENSION_BIOME_MAX_STDOUT_BYTES) {
        fail(new Error("The Biome stdout limit was exceeded."));
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > EXTENSION_BIOME_MAX_STDERR_BYTES) {
        fail(new Error("The Biome stderr limit was exceeded."));
      } else {
        stderr.push(Buffer.from(chunk));
      }
    });
    child.once("error", (error) => fail(error));
    child.once("close", (exitCode) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      if (exitCode === null) {
        rejectPromise(new Error("The Biome process did not report an exit code."));
        return;
      }
      resolvePromise({
        exitCode,
        stderr: Buffer.concat(stderr, stderrBytes),
        stdout: Buffer.concat(stdout, stdoutBytes),
      });
    });
  });
}

function createBiomeEnvironment(isolatedHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tmpdir(),
  };
  for (const name of ["LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
