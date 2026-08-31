import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { imageInputLimitsV1 } from "@adam-agent/agent";
import {
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";

export type ClipboardImageReadResult =
  | {
      readonly status: "read";
      readonly bytes: Uint8Array;
      readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
    }
  | {
      readonly status: "empty" | "failed" | "unsupported";
      readonly message: string;
    };

export type ClipboardImageReader = {
  readImage(): Promise<ClipboardImageReadResult>;
  close(): Promise<void>;
};

export type LinuxClipboardImageChild = {
  readonly stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): LinuxClipboardImageChild;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): LinuxClipboardImageChild;
};

type LinuxClipboardImageSpawn = (
  command: string,
  arguments_: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: ["ignore", "pipe", "ignore"] },
) => LinuxClipboardImageChild;

export const linuxClipboardImageSpawn = Symbol("adam-agent.linux-clipboard-image-spawn");

type ActiveImageHelper = {
  beginTermination(): void;
  readonly settlement: Promise<ClipboardImageReadResult>;
};

const powershellImageScript =
  "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image=[System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 3 }; $stream=[Console]::OpenStandardOutput(); try { $image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose(); $image.Dispose() }";

export function createLinuxClipboardImageReader({
  deadlineMilliseconds = 2_000,
  environment = process.env,
  reclamationMilliseconds = 100,
  scheduler = nodeDeadlineScheduler,
  terminationGraceMilliseconds = 50,
  [linuxClipboardImageSpawn]: spawnProcess = nodeImageSpawn,
}: {
  readonly deadlineMilliseconds?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly reclamationMilliseconds?: number;
  readonly scheduler?: DeadlineScheduler;
  readonly terminationGraceMilliseconds?: number;
  readonly [linuxClipboardImageSpawn]?: LinuxClipboardImageSpawn;
} = {}): ClipboardImageReader {
  const active = new Set<ActiveImageHelper>();
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
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Clipboard image helper reclamation was not confirmed.");
      }
    },
    async readImage() {
      if (closing) {
        return { status: "failed", message: "Clipboard image reader is closing." };
      }
      const candidates = imageReaderCandidates(environment);
      if (candidates.length === 0) {
        return {
          status: "unsupported",
          message: "No supported Linux, Wayland, X11, or WSL clipboard image reader is available.",
        };
      }
      let deadlineExpired = false;
      let current: ActiveImageHelper | undefined;
      const deadline = scheduler.schedule(deadlineMilliseconds, () => {
        deadlineExpired = true;
        current?.beginTermination();
      });
      let sawEmpty = false;
      let sawFailure = false;
      try {
        for (const candidate of candidates) {
          if (closing || deadlineExpired) {
            return {
              status: "failed",
              message: "Clipboard image acquisition reached its deadline.",
            };
          }
          current = startImageHelper({
            active,
            candidate,
            environment,
            reclamationMilliseconds,
            scheduler,
            spawnProcess,
            terminationGraceMilliseconds,
          });
          active.add(current);
          const result = await current.settlement;
          current = undefined;
          if (result.status === "read") {
            return result;
          }
          sawEmpty ||= result.status === "empty";
          sawFailure ||= result.status === "failed";
        }
        return sawFailure
          ? { status: "failed", message: "Clipboard image acquisition failed." }
          : sawEmpty
            ? { status: "empty", message: "The clipboard does not contain image bytes." }
            : {
                status: "unsupported",
                message: "The clipboard does not expose PNG or JPEG image bytes.",
              };
      } finally {
        deadline.cancel();
      }
    },
  };
}

type ImageReaderCandidate = {
  readonly command: string;
  readonly arguments_: readonly string[];
  readonly platform: "linux_wayland" | "linux_x11" | "wsl_bridge";
};

function imageReaderCandidates(environment: NodeJS.ProcessEnv): readonly ImageReaderCandidate[] {
  const candidates: ImageReaderCandidate[] = [];
  if (hasEnvironmentValue(environment, "WAYLAND_DISPLAY")) {
    candidates.push(
      {
        command: "wl-paste",
        arguments_: ["--no-newline", "--type", "image/png"],
        platform: "linux_wayland",
      },
      {
        command: "wl-paste",
        arguments_: ["--no-newline", "--type", "image/jpeg"],
        platform: "linux_wayland",
      },
    );
  }
  if (hasEnvironmentValue(environment, "DISPLAY")) {
    candidates.push(
      {
        command: "xclip",
        arguments_: ["-selection", "clipboard", "-t", "image/png", "-o"],
        platform: "linux_x11",
      },
      {
        command: "xclip",
        arguments_: ["-selection", "clipboard", "-t", "image/jpeg", "-o"],
        platform: "linux_x11",
      },
    );
  }
  if (
    hasEnvironmentValue(environment, "WSL_DISTRO_NAME") ||
    hasEnvironmentValue(environment, "WSL_INTEROP")
  ) {
    candidates.push({
      command: "powershell.exe",
      arguments_: ["-NoProfile", "-NonInteractive", "-Command", powershellImageScript],
      platform: "wsl_bridge",
    });
  }
  return candidates;
}

function hasEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  return (environment[name] ?? "").length > 0;
}

function startImageHelper(options: {
  readonly active: Set<ActiveImageHelper>;
  readonly candidate: ImageReaderCandidate;
  readonly environment: NodeJS.ProcessEnv;
  readonly reclamationMilliseconds: number;
  readonly scheduler: DeadlineScheduler;
  readonly spawnProcess: LinuxClipboardImageSpawn;
  readonly terminationGraceMilliseconds: number;
}): ActiveImageHelper {
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
  let rejectSettlement: ((error: Error) => void) | undefined;
  let resolveSettlement: ((result: ClipboardImageReadResult) => void) | undefined;
  const settlement = new Promise<ClipboardImageReadResult>((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  let beginTermination = () => undefined;
  const helper: ActiveImageHelper = {
    beginTermination: () => beginTermination(),
    settlement,
  };
  const armReclamationGuard = () => {
    guard ??= options.scheduler.schedule(options.reclamationMilliseconds, () => {
      guard = undefined;
      if (!closeObserved && !settled) {
        settled = true;
        rejectSettlement?.(new Error("Clipboard image helper reclamation was not confirmed."));
      }
    });
  };
  beginTermination = () => {
    if (closeObserved || terminationStarted) {
      return;
    }
    terminationStarted = true;
    failure = "failed";
    child.stdout.destroy();
    child.kill("SIGTERM");
    kill = options.scheduler.schedule(options.terminationGraceMilliseconds, () => {
      kill = undefined;
      if (!closeObserved) {
        child.kill("SIGKILL");
      }
    });
    armReclamationGuard();
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > imageInputLimitsV1.maximumBytesPerImage) {
      failure = "failed";
      beginTermination();
      return;
    }
    chunks.push(bytes);
  });
  child.stdout.once("error", () => {
    failure = "failed";
    armReclamationGuard();
  });
  child.once("error", (error) => {
    failure = error.code === "ENOENT" ? "unsupported" : "failed";
    child.stdout.destroy();
    armReclamationGuard();
  });
  child.once("close", (code) => {
    closeObserved = true;
    guard?.cancel();
    kill?.cancel();
    options.active.delete(helper);
    if (settled) {
      return;
    }
    settled = true;
    if (failure !== undefined) {
      resolveSettlement?.({
        status: failure,
        message:
          failure === "unsupported"
            ? "Clipboard image helper is unavailable."
            : "Clipboard image helper failed.",
      });
      return;
    }
    if (code !== 0) {
      resolveSettlement?.({
        status: "unsupported",
        message: "Clipboard image MIME is unavailable.",
      });
      return;
    }
    if (byteCount === 0) {
      resolveSettlement?.({ status: "empty", message: "The clipboard image is empty." });
      return;
    }
    resolveSettlement?.({
      status: "read",
      bytes: Buffer.concat(chunks, byteCount),
      platform: options.candidate.platform,
    });
  });
  return helper;
}

const nodeImageSpawn: LinuxClipboardImageSpawn = (command, arguments_, options) =>
  spawn(command, [...arguments_], options) as LinuxClipboardImageChild;
