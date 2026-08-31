import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { pastedTextLimitsV1 } from "@adam-agent/agent";
import type { ClipboardTextReader, ClipboardTextReadResult } from "./clipboard-reader.js";
import {
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";

export type LinuxClipboardTextChild = {
  readonly stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): LinuxClipboardTextChild;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): LinuxClipboardTextChild;
};

type LinuxClipboardTextSpawn = (
  command: string,
  arguments_: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: ["ignore", "pipe", "ignore"] },
) => LinuxClipboardTextChild;

export const linuxClipboardTextSpawn = Symbol("adam-agent.linux-clipboard-text-spawn");

type ActiveTextHelper = {
  beginTermination(): void;
  readonly settlement: Promise<ClipboardTextReadResult>;
};

const powershellTextScript = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { exit 3 }",
  "$text=[System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)",
  "if ([string]::IsNullOrEmpty($text)) { exit 3 }",
  "$bytes=[System.Text.Encoding]::UTF8.GetBytes($text)",
  "$stream=[Console]::OpenStandardOutput()",
  "$stream.Write($bytes,0,$bytes.Length)",
  "$stream.Dispose()",
].join("; ");

export function createLinuxClipboardTextReader({
  candidateDeadlineMilliseconds = 2_000,
  environment = process.env,
  reclamationMilliseconds = 100,
  scheduler = nodeDeadlineScheduler,
  terminationGraceMilliseconds = 50,
  [linuxClipboardTextSpawn]: spawnProcess = nodeTextSpawn,
}: {
  readonly candidateDeadlineMilliseconds?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly reclamationMilliseconds?: number;
  readonly scheduler?: DeadlineScheduler;
  readonly terminationGraceMilliseconds?: number;
  readonly [linuxClipboardTextSpawn]?: LinuxClipboardTextSpawn;
} = {}): ClipboardTextReader {
  const active = new Set<ActiveTextHelper>();
  let closing = false;
  return {
    async close() {
      closing = true;
      const helpers = [...active];
      for (const helper of helpers) {
        helper.beginTermination();
      }
      const outcomes = await Promise.allSettled(helpers.map((helper) => helper.settlement));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Clipboard text helper reclamation was not confirmed.");
      }
    },
    async readText(signal) {
      if (closing) return { status: "failed", message: "Clipboard text reader is closing." };
      const candidates = textReaderCandidates(environment);
      if (candidates.length === 0) {
        return {
          status: "unsupported",
          message: "No supported clipboard text reader is available.",
        };
      }
      let sawEmpty = false;
      for (const candidate of candidates) {
        if (signal.aborted || closing) {
          return { status: "failed", message: "Clipboard acquisition cancelled." };
        }
        const helper = startTextHelper({
          active,
          candidate,
          environment,
          reclamationMilliseconds,
          scheduler,
          spawnProcess,
          terminationGraceMilliseconds,
        });
        active.add(helper);
        let deadlineExpired = false;
        const onAbort = () => helper.beginTermination();
        signal.addEventListener("abort", onAbort, { once: true });
        const deadline = scheduler.schedule(candidateDeadlineMilliseconds, () => {
          deadlineExpired = true;
          helper.beginTermination();
        });
        let result: ClipboardTextReadResult;
        try {
          result = await helper.settlement;
        } finally {
          deadline.cancel();
          signal.removeEventListener("abort", onAbort);
        }
        if (signal.aborted || closing) {
          return { status: "failed", message: "Clipboard acquisition cancelled." };
        }
        if (result.status === "read") return result;
        if (result.status === "failed") {
          return deadlineExpired
            ? { status: "failed", message: "Clipboard text acquisition reached its deadline." }
            : result;
        }
        sawEmpty ||= result.status === "empty";
      }
      return sawEmpty
        ? { status: "empty", message: "The clipboard does not contain text." }
        : { status: "unsupported", message: "The clipboard does not expose Unicode text." };
    },
  };
}

type TextReaderCandidate = {
  readonly command: string;
  readonly arguments_: readonly string[];
  readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
};

function textReaderCandidates(environment: NodeJS.ProcessEnv): readonly TextReaderCandidate[] {
  const candidates: TextReaderCandidate[] = [];
  if (
    hasEnvironmentValue(environment, "WSL_DISTRO_NAME") ||
    hasEnvironmentValue(environment, "WSL_INTEROP")
  ) {
    candidates.push({
      command: "powershell.exe",
      arguments_: ["-NoProfile", "-NonInteractive", "-STA", "-Command", powershellTextScript],
      platform: "wsl_bridge",
    });
  }
  if (hasEnvironmentValue(environment, "WAYLAND_DISPLAY")) {
    candidates.push(
      {
        command: "wl-paste",
        arguments_: ["--no-newline", "--type", "text/plain;charset=utf-8"],
        platform: "linux_wayland",
      },
      {
        command: "wl-paste",
        arguments_: ["--no-newline", "--type", "text/plain"],
        platform: "linux_wayland",
      },
    );
  }
  if (hasEnvironmentValue(environment, "DISPLAY")) {
    candidates.push({
      command: "xclip",
      arguments_: ["-selection", "clipboard", "-t", "UTF8_STRING", "-o"],
      platform: "linux_x11",
    });
  }
  return candidates;
}

function hasEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = Reflect.get(environment, name);
  return typeof value === "string" && value.length > 0;
}

function startTextHelper(options: {
  readonly active: Set<ActiveTextHelper>;
  readonly candidate: TextReaderCandidate;
  readonly environment: NodeJS.ProcessEnv;
  readonly reclamationMilliseconds: number;
  readonly scheduler: DeadlineScheduler;
  readonly spawnProcess: LinuxClipboardTextSpawn;
  readonly terminationGraceMilliseconds: number;
}): ActiveTextHelper {
  const child = options.spawnProcess(options.candidate.command, options.candidate.arguments_, {
    env: options.environment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let closeObserved = false;
  let failure: "failed" | "unsupported" | undefined;
  let guard: DeadlineHandle | undefined;
  let kill: DeadlineHandle | undefined;
  let settled = false;
  let terminationStarted = false;
  const deferred = Promise.withResolvers<ClipboardTextReadResult>();
  let beginTermination = () => undefined;
  const helper: ActiveTextHelper = {
    beginTermination: () => beginTermination(),
    settlement: deferred.promise,
  };
  const armGuard = () => {
    guard ??= options.scheduler.schedule(options.reclamationMilliseconds, () => {
      guard = undefined;
      if (!closeObserved && !settled) {
        settled = true;
        deferred.reject(new Error("Clipboard text helper reclamation was not confirmed."));
      }
    });
  };
  beginTermination = () => {
    if (closeObserved || terminationStarted) return;
    terminationStarted = true;
    failure = "failed";
    child.stdout.destroy();
    child.kill("SIGTERM");
    kill = options.scheduler.schedule(options.terminationGraceMilliseconds, () => {
      kill = undefined;
      if (!closeObserved) child.kill("SIGKILL");
    });
    armGuard();
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > pastedTextLimitsV1.maximumTextBytesPerTurn) {
      failure = "failed";
      beginTermination();
      return;
    }
    chunks.push(bytes);
  });
  child.stdout.once("error", () => {
    failure = "failed";
    armGuard();
  });
  child.once("error", (error) => {
    failure = error.code === "ENOENT" ? "unsupported" : "failed";
    child.stdout.destroy();
    armGuard();
  });
  child.once("close", (code) => {
    closeObserved = true;
    guard?.cancel();
    kill?.cancel();
    options.active.delete(helper);
    if (settled) return;
    settled = true;
    if (failure !== undefined) {
      deferred.resolve({ status: failure, message: "Clipboard text helper failed." });
      return;
    }
    if (options.candidate.platform === "wsl_bridge" && code === 3) {
      deferred.resolve({ status: "empty", message: "The clipboard text is empty." });
      return;
    }
    if (code !== 0) {
      deferred.resolve({ status: "unsupported", message: "Clipboard text MIME is unavailable." });
      return;
    }
    if (byteCount === 0) {
      deferred.resolve({ status: "empty", message: "The clipboard text is empty." });
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, byteCount),
      );
      deferred.resolve({ status: "read", platform: options.candidate.platform, text });
    } catch {
      deferred.resolve({ status: "failed", message: "Clipboard text is not valid UTF-8." });
    }
  });
  return helper;
}

const nodeTextSpawn: LinuxClipboardTextSpawn = (command, arguments_, options) =>
  spawn(command, [...arguments_], options) as LinuxClipboardTextChild;
