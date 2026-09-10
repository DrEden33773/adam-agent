import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createJsonlManagedAgentControlStore } from "./managed-agent-store.js";
import { sessionHistoryActivityBlocker } from "./session-history-activity.js";
import type {
  SessionHistoryInspectionWorkerData,
  SessionHistoryInspectionWorkerEvent,
  SessionHistoryInspectionWorkerRequest,
} from "./session-history-inspection-protocol.js";
import { createWorkerSessionInspectionAuthority } from "./session-inspection-authority.js";
import { createReadOnlySessionHistoryInspector } from "./session-lifecycle.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { createJsonlSessionStoreDirectory } from "./session-store.js";
import { createSessionTrashRepository, SessionTrashError } from "./session-trash.js";
import { createSessionTrashAccess } from "./session-trash-guards.js";
import { readSessionTrashRecords } from "./session-trash-inventory.js";
import { createSessionVisibilityRepository } from "./session-visibility.js";

const port = parentPort;
if (port === null) throw new Error("History inspection requires a worker message port.");
const input = workerData as SessionHistoryInspectionWorkerData;
const post = (message: SessionHistoryInspectionWorkerEvent) => port.postMessage(message);
const authority = createWorkerSessionInspectionAuthority(post);
const mainDirectory = createJsonlSessionStoreDirectory(input);
const childDirectory = createJsonlSessionStoreDirectory({
  ...input,
  stateRoot: join(input.stateRoot, "managed-agent-sessions"),
});
const trashRepository = createSessionTrashRepository(input);
const accessible = createSessionTrashAccess(trashRepository).wrapDirectory(mainDirectory);
const readRecords = (sessionId: string) => readSessionTrashRecords(accessible, sessionId);
const inspector = createReadOnlySessionHistoryInspector({
  options: input,
  mainDirectory,
  childDirectory,
  controlStore: () => createJsonlManagedAgentControlStore(input),
  readRecords,
  inspectMcpInputs: authority.inspectMcpInputs,
  resolvePlanProfile: authority.resolvePlanProfile,
  activityBlocker: (sessionId) => sessionHistoryActivityBlocker({ ...input, sessionId }),
  trashRepository,
  visibilityRepository: createSessionVisibilityRepository(input),
});

let started = false;
async function inspect(): Promise<void> {
  const request = input.request;
  if (request.type === "idle") {
    await inspector.requireIdleHistory(request.sessionId);
    post({ type: "result", result: { type: "idle" } });
  } else if (request.type === "trash") {
    const candidate = await inspector.inspectTrashCandidate(request.sessionId);
    post({ type: "result", result: { type: "trash", candidate } });
  } else {
    await inspector.validateRestoredUnit(request.manifest);
    post({ type: "result", result: { type: "restore" } });
  }
}
port.on("message", (message: SessionHistoryInspectionWorkerRequest) => {
  if (message.type === "authority_result") {
    authority.receive(message.id, message.result);
  } else if (!started) {
    started = true;
    void inspect().catch((error: unknown) =>
      post({
        type: "error",
        error:
          error instanceof SessionTrashError
            ? { type: "trash", code: error.code, message: error.message }
            : error instanceof SessionLifecycleError
              ? { type: "lifecycle", code: error.code }
              : { type: "unavailable" },
      }),
    );
  }
});
