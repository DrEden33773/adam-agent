import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import type { PlanEligibleToolProfileV1 } from "./plan-mode.js";
import type { ProjectSessionCatalogSnapshot } from "./session-catalog-job.js";
import type {
  SessionCatalogAuthorityRequest,
  SessionCatalogAuthorityResult,
  SessionCatalogWorkerData,
  SessionCatalogWorkerEvent,
  SessionCatalogWorkerRequest,
} from "./session-catalog-protocol.js";
import {
  isGenesisRecord,
  sessionNamingStateFromRecords,
  sessionRunBoundaryFromRecords,
} from "./session-history-folds.js";
import {
  createReadOnlySessionInspector,
  type ProjectSessionSummary,
  type ReadOnlySessionMcpInputs,
  type SessionHistoryDiagnostic,
  sessionHistoryDiagnosticFromError,
} from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import {
  createJsonlSessionStoreDirectory,
  type SessionRecord,
  type SessionStoreDirectoryEntry,
  SessionStoreError,
} from "./session-store.js";

const port = parentPort;
if (port === null) throw new Error("The session catalog requires a worker message port.");
const input = workerData as SessionCatalogWorkerData;
const directory = createJsonlSessionStoreDirectory(input);
const readRecords = async (sessionId: string): Promise<readonly SessionRecord[]> =>
  (await directory.readRecords?.(sessionId)) ?? [];
const post = (message: SessionCatalogWorkerEvent) => port.postMessage(message);
const pendingAuthority = new Map<
  number,
  ReturnType<typeof Promise.withResolvers<SessionCatalogAuthorityResult>>
>();
let nextAuthorityId = 0;
const requestAuthority = async (request: SessionCatalogAuthorityRequest) => {
  const id = ++nextAuthorityId;
  const pending = Promise.withResolvers<SessionCatalogAuthorityResult>();
  pendingAuthority.set(id, pending);
  post({ type: "authority", id, request });
  const result = await pending.promise;
  if (!result.ok) {
    if (result.code === "session_log_invalid" || result.code === "session_log_too_large") {
      throw new SessionStoreError(result.code);
    }
    if (result.code !== null) throw new SessionLifecycleError(result.code);
    throw new Error("The current session inspection authority is unavailable.");
  }
  return result.value;
};
const inspect = createReadOnlySessionInspector({
  options: input,
  readRecords,
  resolvePlanProfile: async (query) =>
    (await requestAuthority({ type: "plan", input: query })) as PlanEligibleToolProfileV1,
  inspectMcpInputs: async (sessionId) =>
    (await requestAuthority({ type: "mcp", sessionId })) as ReadOnlySessionMcpInputs,
});
let projectId = "";
let entries: readonly SessionStoreDirectoryEntry[] = [];
let position = 0;
let wantedItems = input.limit;
let checked = 0;
let started = false;
let failed = false;
let health: ProjectSessionCatalogSnapshot["health"]["status"] = "not_started";
let phase: ProjectSessionCatalogSnapshot["phase"] = "loading";
// Compact observations live only for this generation. Full inspection replaces provisional metadata.
const summaries = new Map<string, ProjectSessionSummary>();
const diagnostics = new Map<string, SessionHistoryDiagnostic>();
const healthChecked = new Set<string>();
let pageWork = Promise.resolve();

function cursor(): string | null {
  const unread = entries.slice(position).some((entry) => !healthChecked.has(entry.sessionId));
  return summaries.size > wantedItems || unread
    ? `project-summaries:v1:${input.generation}:${wantedItems}`
    : null;
}

function publish(error?: ProjectSessionCatalogSnapshot["error"]): void {
  const knownDiagnostics = [...diagnostics.values()].sort((left, right) =>
    left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
  );
  post({
    type: "update",
    snapshot: {
      projectId,
      items: entries
        .flatMap((entry) => {
          const item = summaries.get(entry.sessionId);
          return item === undefined ? [] : [item];
        })
        .slice(0, wantedItems),
      nextCursor: cursor(),
      diagnostics: {
        items: knownDiagnostics.slice(0, 100),
        totalCount: knownDiagnostics.length,
        truncated: knownDiagnostics.length > 100,
      },
      phase,
      health: { status: health, checked, total: entries.length },
      ...(error === undefined ? {} : { error }),
    },
  });
}

function fail(): void {
  if (failed) return;
  failed = true;
  phase = "failed";
  health = "failed";
  publish({
    code: "catalog_scan_failed",
    message: "The history scan could not be completed. Existing local sessions were retained.",
  });
}

function isolate(sessionId: string, error: unknown): boolean {
  if (error instanceof SessionLifecycleError && error.code === "session_not_found") {
    summaries.delete(sessionId);
    diagnostics.delete(sessionId);
    return true;
  }
  const diagnostic = sessionHistoryDiagnosticFromError(sessionId, error);
  if (diagnostic === undefined) return false;
  diagnostics.set(sessionId, diagnostic);
  summaries.delete(sessionId);
  return true;
}

function hasAcceptedInput(records: readonly SessionRecord[]): boolean {
  return records.some((entry) =>
    entry.schemaVersion === 3
      ? entry.record.type === "logical_run_started"
      : entry.event.type === "user_message",
  );
}

function summary(sessionId: string, records: readonly SessionRecord[]): ProjectSessionSummary {
  const first = records[0];
  if (first === undefined) throw new SessionLifecycleError("session_not_found");
  if (first.schemaVersion !== 3) {
    if (records.some((entry) => entry.schemaVersion === 3)) {
      throw new SessionLifecycleError("session_invalid");
    }
    return {
      schemaVersion: records.some((entry) => entry.schemaVersion === 2) ? 2 : 1,
      projectId,
      sessionId,
      lastSequence: records.length,
      status: "legacy",
    };
  }
  if (!isGenesisRecord(first) || first.record.sessionId !== sessionId) {
    throw new SessionLifecycleError("session_invalid");
  }
  if (first.record.projectId !== projectId) {
    throw new SessionLifecycleError("session_project_mismatch");
  }
  const current = records.filter((entry) => entry.schemaVersion === 3);
  if (current.length !== records.length) throw new SessionLifecycleError("session_invalid");
  return {
    schemaVersion: 3,
    projectId,
    sessionId,
    lastSequence: records.length,
    targetIdentity: first.record.targetIdentity,
    status: sessionRunBoundaryFromRecords(current).status,
    naming: sessionNamingStateFromRecords(records),
  };
}

async function fillPage(): Promise<void> {
  while (!failed && position < entries.length && summaries.size < wantedItems) {
    const entry = entries[position++];
    if (entry === undefined || healthChecked.has(entry.sessionId)) continue;
    try {
      const records = await readRecords(entry.sessionId);
      if (!healthChecked.has(entry.sessionId) && hasAcceptedInput(records)) {
        summaries.set(entry.sessionId, summary(entry.sessionId, records));
      }
    } catch (error) {
      // An earlier metadata read cannot overwrite the completed health observation for this generation.
      if (!healthChecked.has(entry.sessionId) && !isolate(entry.sessionId, error)) throw error;
    }
  }
}

async function scanHealth(): Promise<void> {
  health = "running";
  publish();
  for (const entry of entries) {
    if (failed) return;
    try {
      // A fresh native read is the authority for this health result; summary availability is not validation.
      const records = await readRecords(entry.sessionId);
      if (hasAcceptedInput(records)) {
        await inspect({ sessionId: entry.sessionId }, undefined, records);
        summaries.set(entry.sessionId, summary(entry.sessionId, records));
      } else {
        summaries.delete(entry.sessionId);
      }
      diagnostics.delete(entry.sessionId);
    } catch (error) {
      if (!isolate(entry.sessionId, error)) throw error;
    }
    healthChecked.add(entry.sessionId);
    checked += 1;
    publish();
  }
  pageWork = pageWork.then(async () => {
    if (failed) return;
    // Excluding an invalid visible row must not leave the first page artificially short.
    await fillPage();
    health = "complete";
    publish();
  });
  await pageWork;
}

async function start(): Promise<void> {
  const canonicalRoot = await realpath(input.workspaceRoot);
  projectId = `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
  entries = [...(await directory.listSessionEntries())].sort(
    (left, right) =>
      right.modifiedAtMilliseconds - left.modifiedAtMilliseconds ||
      (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0),
  );
  publish();
  await fillPage();
  phase = "ready";
  publish();
  await scanHealth();
}

port.on("message", (message: SessionCatalogWorkerRequest) => {
  if (message.type === "start") {
    if (started) return;
    started = true;
    void start().catch(fail);
    return;
  }
  if (message.type === "authority_result") {
    const pending = pendingAuthority.get(message.id);
    pendingAuthority.delete(message.id);
    pending?.resolve(message.result);
    return;
  }
  pageWork = pageWork.then(async () => {
    if (failed || phase !== "ready" || message.cursor !== cursor()) {
      post({ type: "page_settled", id: message.id, ok: false });
      return;
    }
    wantedItems += input.limit;
    try {
      await fillPage();
      publish();
      post({ type: "page_settled", id: message.id, ok: true });
    } catch {
      fail();
      post({ type: "page_settled", id: message.id, ok: false });
    }
  });
});
