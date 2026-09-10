import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { notifyObserver } from "./observer-notification.js";
import type {
  SessionCatalogWorkerEvent,
  SessionCatalogWorkerRequest,
} from "./session-catalog-protocol.js";
import {
  resolveSessionInspectionAuthority,
  type SessionInspectionAuthority,
} from "./session-inspection-authority.js";
import type { ProjectSessionSummaryPage } from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";

/** One enumeration generation. Running diagnostics are partial; complete means every entry was inspected. */
export type ProjectSessionCatalogSnapshot = ProjectSessionSummaryPage & {
  readonly phase: "loading" | "ready" | "failed";
  readonly health: {
    readonly status: "not_started" | "running" | "complete" | "failed";
    readonly checked: number;
    readonly total: number | null;
  };
  readonly error?: {
    readonly code: "catalog_unavailable" | "catalog_scan_failed";
    readonly message: string;
  };
};

export type ProjectSessionCatalogController = {
  /** Continue this generation's compact observations; a new job refreshes external changes. */
  readonly loadMore: (cursor: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type ProjectSessionCatalogStartOptions = {
  readonly view?: import("./session-visibility.js").SessionVisibility;
  readonly limit?: number;
  readonly onUpdate: (snapshot: ProjectSessionCatalogSnapshot) => void;
};

/** Tests may hold the native worker transport's start message without replacing catalog behavior. */
export const sessionCatalogWorkerFactory = Symbol("adam-agent.session-catalog-worker-factory");
export type SessionCatalogWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

/** One native read-only worker; the owning Lifecycle supplies live authority without tool execution. */
export function startNativeSessionCatalog(
  input: ProjectSessionCatalogStartOptions &
    SessionInspectionAuthority & {
      readonly workspaceRoot: string;
      readonly stateRoot: string;
      readonly supported: boolean;
      readonly beforeStart?: Promise<void>;
      readonly workerFactory?: SessionCatalogWorkerFactory;
    },
): ProjectSessionCatalogController {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SessionLifecycleError("session_invalid");
  }
  let closed = false;
  let failed = false;
  let worker: Worker | undefined;
  let latest: ProjectSessionCatalogSnapshot = {
    projectId: "",
    items: [],
    nextCursor: null,
    diagnostics: { items: [], totalCount: 0, truncated: false },
    phase: "loading",
    health: { status: "not_started", checked: 0, total: null },
  };
  let workerSnapshot: ProjectSessionCatalogSnapshot | undefined;
  let closePromise: Promise<void> | undefined;
  let termination: Promise<void> | undefined;
  const exited = Promise.withResolvers<void>();
  const pages = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  let nextPageId = 0;
  const stopWorker = (): Promise<void> => {
    const current = worker;
    if (current === undefined) return Promise.resolve();
    termination ??= (async () => {
      await current.terminate();
      await exited.promise;
    })();
    return termination;
  };
  const publish = (snapshot: ProjectSessionCatalogSnapshot) => {
    latest = snapshot;
    if (!closed) notifyObserver(() => input.onUpdate(snapshot));
  };
  const fail = (code: "catalog_unavailable" | "catalog_scan_failed") => {
    if (closed || failed) return;
    failed = true;
    for (const page of pages.values()) page.reject(new Error("The history scan is unavailable."));
    pages.clear();
    if (latest !== undefined) {
      publish({
        ...latest,
        phase: "failed",
        health: { ...latest.health, status: "failed" },
        error: {
          code,
          message:
            code === "catalog_unavailable"
              ? "Background history loading is unavailable for this session store."
              : "The history scan could not be completed. Existing local sessions were retained.",
        },
      });
    }
    // A failed scan has no further work. Its owner still observes termination again during close.
    void stopWorker().catch(() => {});
  };
  const handleMessage = (message: SessionCatalogWorkerEvent) => {
    if (closed || failed) return;
    if (message.type === "update") {
      workerSnapshot = message.snapshot;
      if (message.snapshot.phase === "failed") {
        latest = message.snapshot;
        fail(message.snapshot.error?.code ?? "catalog_scan_failed");
        return;
      }
      publish(pages.size > 0 ? { ...message.snapshot, phase: "loading" } : message.snapshot);
      return;
    }
    if (message.type === "page_settled") {
      const page = pages.get(message.id);
      pages.delete(message.id);
      if (pages.size === 0 && workerSnapshot !== undefined) publish(workerSnapshot);
      if (message.ok) page?.resolve();
      else page?.reject(new SessionLifecycleError("session_invalid"));
      return;
    }
    // The worker sends only already-parsed profile identities, never tool calls or full histories.
    void resolveSessionInspectionAuthority(input, message.request)
      .then((result) => {
        if (closed || failed) return;
        worker?.postMessage({
          type: "authority_result",
          id: message.id,
          result,
        } satisfies SessionCatalogWorkerRequest);
      })
      .catch(() => fail("catalog_scan_failed"));
  };
  const started = (async () => {
    await input.beforeStart;
    if (closed) return;
    const canonicalRoot = await realpath(input.workspaceRoot);
    if (closed) return;
    publish({
      projectId: `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`,
      items: [],
      nextCursor: null,
      diagnostics: { items: [], totalCount: 0, truncated: false },
      phase: "loading",
      health: { status: "not_started", checked: 0, total: null },
    });
    if (!input.supported) {
      fail("catalog_unavailable");
      return;
    }
    if (closed) return;
    const createWorker = input.workerFactory ?? ((url, options) => new Worker(url, options));
    worker = createWorker(new URL("./session-catalog-worker.js", import.meta.url), {
      workerData: {
        workspaceRoot: input.workspaceRoot,
        stateRoot: input.stateRoot,
        limit,
        generation: randomUUID(),
        view: input.view ?? "active",
      },
    });
    worker.on("message", handleMessage);
    worker.on("error", () => fail("catalog_scan_failed"));
    worker.once("exit", () => {
      exited.resolve();
      if (!closed) fail("catalog_scan_failed");
    });
    worker.postMessage({ type: "start" } satisfies SessionCatalogWorkerRequest);
  })().catch(() => fail("catalog_scan_failed"));

  return {
    async loadMore(cursor) {
      await started;
      if (closed) throw new DOMException("The history catalog was closed.", "AbortError");
      if (
        failed ||
        worker === undefined ||
        latest.phase !== "ready" ||
        latest.nextCursor !== cursor
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const id = ++nextPageId;
      const page = Promise.withResolvers<void>();
      pages.set(id, page);
      publish({ ...latest, phase: "loading" });
      worker.postMessage({ type: "load_more", id, cursor } satisfies SessionCatalogWorkerRequest);
      return page.promise;
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      for (const page of pages.values()) {
        page.reject(new DOMException("The history catalog was closed.", "AbortError"));
      }
      pages.clear();
      closePromise = (async () => {
        await started;
        await stopWorker();
      })();
      return closePromise;
    },
  };
}
