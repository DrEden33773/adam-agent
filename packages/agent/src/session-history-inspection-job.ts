import { Worker, type WorkerOptions } from "node:worker_threads";
import type {
  SessionHistoryInspectionRequest,
  SessionHistoryInspectionResult,
  SessionHistoryInspectionWorkerEvent,
  SessionHistoryInspectionWorkerRequest,
} from "./session-history-inspection-protocol.js";
import {
  resolveSessionInspectionAuthority,
  type SessionInspectionAuthority,
} from "./session-inspection-authority.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { SessionTrashError } from "./session-trash.js";

/** Tests may hold the native worker transport without substituting inspection logic. */
export const sessionHistoryWorkerFactory = Symbol("adam-agent.session-history-worker-factory");
export type SessionHistoryWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export type SessionHistoryInspectionJob = {
  readonly result: Promise<SessionHistoryInspectionResult>;
  readonly close: () => Promise<void>;
};

export function startSessionHistoryInspection(
  input: SessionInspectionAuthority & {
    readonly workspaceRoot: string;
    readonly stateRoot: string;
    readonly request: SessionHistoryInspectionRequest;
    readonly workerFactory?: SessionHistoryWorkerFactory;
    readonly signal?: AbortSignal;
  },
): SessionHistoryInspectionJob {
  input.signal?.throwIfAborted();
  const pending = Promise.withResolvers<SessionHistoryInspectionResult>();
  const exited = Promise.withResolvers<void>();
  let settled = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const worker = (input.workerFactory ?? ((url, options) => new Worker(url, options)))(
    new URL("./session-history-inspection-worker.js", import.meta.url),
    {
      workerData: {
        workspaceRoot: input.workspaceRoot,
        stateRoot: input.stateRoot,
        request: input.request,
      },
    },
  );
  const reject = (error: unknown) => {
    if (settled) return;
    settled = true;
    pending.reject(error);
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    reject(new DOMException("History inspection cancelled.", "AbortError"));
    input.signal?.removeEventListener("abort", abort);
    closing = (async () => {
      await worker.terminate();
      await exited.promise;
    })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  worker.on("message", (message: SessionHistoryInspectionWorkerEvent) => {
    if (closed || settled) return;
    if (message.type === "result") {
      if (message.result.type !== input.request.type) {
        reject(
          new SessionTrashError("unavailable", "History inspection returned an unexpected result."),
        );
      } else {
        settled = true;
        pending.resolve(message.result);
      }
    } else if (message.type === "error") {
      const error = message.error;
      reject(
        error.type === "trash"
          ? new SessionTrashError(error.code, error.message)
          : error.type === "lifecycle"
            ? new SessionLifecycleError(error.code)
            : new SessionTrashError(
                "unavailable",
                "Session history inspection could not be completed.",
              ),
      );
    } else {
      void resolveSessionInspectionAuthority(input, message.request)
        .then((result) => {
          if (!closed && !settled)
            worker.postMessage({
              type: "authority_result",
              id: message.id,
              result,
            } satisfies SessionHistoryInspectionWorkerRequest);
        })
        .catch(reject);
    }
  });
  worker.on("error", () =>
    reject(new SessionTrashError("unavailable", "The history inspection worker failed.")),
  );
  worker.once("exit", () => {
    exited.resolve();
    reject(
      new SessionTrashError(
        "unavailable",
        "The history inspection worker exited before completion.",
      ),
    );
  });
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  else worker.postMessage({ type: "start" } satisfies SessionHistoryInspectionWorkerRequest);
  return { result: pending.promise, close };
}
