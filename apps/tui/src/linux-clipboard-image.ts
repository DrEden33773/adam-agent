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
      readonly status: "empty" | "failed" | "file_drop" | "unsupported";
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

const wslClipboardExit = {
  empty: 3,
  fileDrop: 4,
  unsupported: 5,
} as const;

const powershellImageScript = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$data=[System.Windows.Forms.Clipboard]::GetDataObject()",
  `if ($null -eq $data) { exit ${wslClipboardExit.empty} }`,
  `if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { exit ${wslClipboardExit.fileDrop} }`,
  "$registered=$null",
  "foreach ($format in @('PNG','image/png','JFIF','image/jpeg')) { if ($data.GetDataPresent($format,$false)) { $registered=$data.GetData($format,$false); break } }",
  `if ($null -ne $registered) { $stream=[Console]::OpenStandardOutput(); try { if ($registered -is [byte[]]) { $stream.Write($registered,0,$registered.Length) } elseif ($registered -is [System.IO.Stream]) { $registered.CopyTo($stream) } else { exit ${wslClipboardExit.unsupported} } } finally { $stream.Dispose(); if ($registered -is [System.IDisposable]) { $registered.Dispose() } }; exit 0 }`,
  "$image=[System.Windows.Forms.Clipboard]::GetImage()",
  `if ($null -eq $image) { $formats=$data.GetFormats(); if ($null -eq $formats -or $formats.Length -eq 0) { exit ${wslClipboardExit.empty} }; exit ${wslClipboardExit.unsupported} }`,
  "$stream=[Console]::OpenStandardOutput()",
  "$image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)",
  "$stream.Dispose()",
  "$image.Dispose()",
].join("; ");

export function createLinuxClipboardImageReader({
  candidateDeadlineMilliseconds = 2_000,
  environment = process.env,
  reclamationMilliseconds = 100,
  scheduler = nodeDeadlineScheduler,
  terminationGraceMilliseconds = 50,
  [linuxClipboardImageSpawn]: spawnProcess = nodeImageSpawn,
}: {
  readonly candidateDeadlineMilliseconds?: number;
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
      let sawEmpty = false;
      let sawDeadline = false;
      let sawFailure = false;
      for (const candidate of candidates) {
        if (closing) {
          return { status: "failed", message: "Clipboard image reader is closing." };
        }
        const current = startImageHelper({
          active,
          candidate,
          environment,
          reclamationMilliseconds,
          scheduler,
          spawnProcess,
          terminationGraceMilliseconds,
        });
        active.add(current);
        let deadlineExpired = false;
        const deadline = scheduler.schedule(candidateDeadlineMilliseconds, () => {
          deadlineExpired = true;
          current.beginTermination();
        });
        let result: ClipboardImageReadResult;
        try {
          result = await current.settlement;
        } finally {
          deadline.cancel();
        }
        if (closing) {
          return { status: "failed", message: "Clipboard image reader is closing." };
        }
        if (result.status === "read") {
          return result;
        }
        if (result.status === "file_drop") {
          return result;
        }
        if (candidate.platform === "wsl_bridge" && result.status === "failed") {
          return deadlineExpired
            ? { status: "failed", message: "Clipboard image acquisition reached its deadline." }
            : result;
        }
        sawDeadline ||= deadlineExpired;
        sawEmpty ||= result.status === "empty";
        sawFailure ||= result.status === "failed";
      }
      return sawDeadline
        ? { status: "failed", message: "Clipboard image acquisition reached its deadline." }
        : sawFailure
          ? { status: "failed", message: "Clipboard image acquisition failed." }
          : sawEmpty
            ? { status: "empty", message: "The clipboard does not contain image bytes." }
            : {
                status: "unsupported",
                message: "The clipboard does not expose PNG or JPEG image bytes.",
              };
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
  if (
    hasEnvironmentValue(environment, "WSL_DISTRO_NAME") ||
    hasEnvironmentValue(environment, "WSL_INTEROP")
  ) {
    candidates.push({
      command: "powershell.exe",
      arguments_: ["-NoProfile", "-NonInteractive", "-STA", "-Command", powershellImageScript],
      platform: "wsl_bridge",
    });
  }
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
      if (options.candidate.platform === "wsl_bridge" && code === wslClipboardExit.empty) {
        resolveSettlement?.({ status: "empty", message: "The clipboard image is empty." });
        return;
      }
      if (options.candidate.platform === "wsl_bridge" && code === wslClipboardExit.fileDrop) {
        resolveSettlement?.({
          status: "file_drop",
          message: "Clipboard files are not supported; attach an admitted project file explicitly.",
        });
        return;
      }
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
