import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

import {
  type ClipboardAdapter,
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";

export type LinuxClipboardChild = {
  readonly stdin: Writable;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): LinuxClipboardChild;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): LinuxClipboardChild;
};

type LinuxClipboardSpawn = (
  command: string,
  arguments_: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: ["pipe", "ignore", "ignore"] },
) => LinuxClipboardChild;

/** Tests only. Production clipboard composition uses node:child_process spawn. */
export const linuxClipboardSpawn = Symbol("adam-agent.linux-clipboard-spawn");

type ActiveClipboardHelper = {
  beginTermination(): void;
  readonly settlement: Promise<"copied" | "failed" | "unsupported">;
};

export function createLinuxClipboardAdapter({
  deadlineMilliseconds = 150,
  environment = process.env,
  reclamationMilliseconds = 50,
  scheduler = nodeDeadlineScheduler,
  terminationGraceMilliseconds = 25,
  [linuxClipboardSpawn]: spawnProcess = nodeClipboardSpawn,
}: {
  readonly deadlineMilliseconds?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly reclamationMilliseconds?: number;
  readonly scheduler?: DeadlineScheduler;
  readonly terminationGraceMilliseconds?: number;
  readonly [linuxClipboardSpawn]?: LinuxClipboardSpawn;
} = {}): ClipboardAdapter {
  const active = new Set<ActiveClipboardHelper>();
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
        throw new AggregateError(failures, "Clipboard helper reclamation was not confirmed.");
      }
    },
    async writeText(text) {
      if (closing) {
        return "failed";
      }
      let deadlineExpired = false;
      let current: ActiveClipboardHelper | undefined;
      const deadline = scheduler.schedule(deadlineMilliseconds, () => {
        deadlineExpired = true;
        current?.beginTermination();
      });
      try {
        let sawFailure = false;
        for (const helper of [
          { command: "wl-copy", arguments_: [] },
          { command: "xclip", arguments_: ["-selection", "clipboard", "-in"] },
          { command: "xsel", arguments_: ["--clipboard", "--input"] },
        ]) {
          if (closing || deadlineExpired) {
            return "failed";
          }
          current = startClipboardHelper({
            active,
            environment,
            helper,
            reclamationMilliseconds,
            scheduler,
            spawnProcess,
            terminationGraceMilliseconds,
            text,
          });
          active.add(current);
          const result = await current.settlement;
          current = undefined;
          if (result === "copied") {
            return result;
          }
          sawFailure ||= result === "failed";
        }
        return sawFailure ? "failed" : "unsupported";
      } finally {
        deadline.cancel();
      }
    },
  };
}

function startClipboardHelper(options: {
  readonly active: Set<ActiveClipboardHelper>;
  readonly environment: NodeJS.ProcessEnv;
  readonly helper: { readonly arguments_: readonly string[]; readonly command: string };
  readonly reclamationMilliseconds: number;
  readonly scheduler: DeadlineScheduler;
  readonly spawnProcess: LinuxClipboardSpawn;
  readonly terminationGraceMilliseconds: number;
  readonly text: string;
}): ActiveClipboardHelper {
  const child = options.spawnProcess(options.helper.command, options.helper.arguments_, {
    env: options.environment,
    stdio: ["pipe", "ignore", "ignore"],
  });
  let closeObserved = false;
  let failure: "failed" | "unsupported" | undefined;
  let guard: DeadlineHandle | undefined;
  let kill: DeadlineHandle | undefined;
  let settled = false;
  let terminationStarted = false;
  let rejectSettlement: ((error: Error) => void) | undefined;
  let resolveSettlement: ((result: "copied" | "failed" | "unsupported") => void) | undefined;
  const settlement = new Promise<"copied" | "failed" | "unsupported">((resolve, reject) => {
    resolveSettlement = resolve;
    rejectSettlement = reject;
  });
  let beginTermination = () => undefined;
  const helper: ActiveClipboardHelper = {
    beginTermination: () => beginTermination(),
    settlement,
  };
  const armReclamationGuard = () => {
    guard ??= options.scheduler.schedule(options.reclamationMilliseconds, () => {
      guard = undefined;
      if (!closeObserved && !settled) {
        settled = true;
        rejectSettlement?.(new Error("Clipboard helper reclamation was not confirmed."));
      }
    });
  };
  beginTermination = () => {
    if (closeObserved || terminationStarted) {
      return;
    }
    terminationStarted = true;
    failure = "failed";
    child.stdin.destroy();
    child.kill("SIGTERM");
    kill = options.scheduler.schedule(options.terminationGraceMilliseconds, () => {
      kill = undefined;
      if (!closeObserved) {
        child.kill("SIGKILL");
      }
    });
    armReclamationGuard();
  };
  child.once("error", (error) => {
    failure = error.code === "ENOENT" ? "unsupported" : "failed";
    child.stdin.destroy();
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
    resolveSettlement?.(failure ?? (code === 0 ? "copied" : "failed"));
  });
  child.stdin.once("error", () => {
    // The child close event remains authoritative for success and reclamation.
  });
  child.stdin.write(options.text, "utf8");
  child.stdin.end();
  return helper;
}

const nodeClipboardSpawn: LinuxClipboardSpawn = (command, arguments_, options) =>
  spawn(command, [...arguments_], options) as LinuxClipboardChild;
