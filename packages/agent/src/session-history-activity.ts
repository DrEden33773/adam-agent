import { join } from "node:path";
import { managedAgentSnapshotWithChildHistories } from "./managed-agent.js";
import { foldManagedControl } from "./managed-agent-folds.js";
import { inspectManagedChildReceipt } from "./managed-agent-recovery.js";
import { createJsonlManagedAgentControlStore } from "./managed-agent-store.js";
import { readUnfinishedSessionOperations } from "./operation-store.js";
import type { ManagedControlComposition } from "./session-lifecycle.js";
import { createJsonlSessionStoreDirectory } from "./session-store.js";

/** Read persisted owners without constructing a provider or admitting recovery work. */
export async function sessionHistoryActivityBlocker(input: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly sessionId: string;
  readonly composition?: ManagedControlComposition;
}): Promise<string | undefined> {
  const store = input.composition?.store ?? (await createJsonlManagedAgentControlStore(input));
  const records = await store.forParent(input.sessionId).read();
  const control = foldManagedControl(records, input.sessionId);
  const childStores =
    input.composition?.childSessionStores ??
    createJsonlSessionStoreDirectory({
      workspaceRoot: input.workspaceRoot,
      stateRoot: join(input.stateRoot, "managed-agent-sessions"),
    });
  for (const candidate of control.threads) {
    const admission = records.findLast(
      (record) => record.turnId === candidate.turn.turnId && record.event.type === "admitted",
    );
    const thread = await inspectManagedChildReceipt(candidate, childStores, admission, records);
    if (thread.turn.phase !== "idle" || thread.turn.recovery !== "none")
      return `Child ${thread.threadId} has ${thread.turn.recovery === "required" ? "unfinished recovery" : thread.turn.phase} work (${thread.turn.waitReason}). Close this list, open Agents and use Stop, or complete recovery.`;
  }
  const legacy = await managedAgentSnapshotWithChildHistories({
    records: await store.readLegacy(),
    parentSessionId: input.sessionId,
    childSessionStores: createJsonlSessionStoreDirectory({
      workspaceRoot: input.workspaceRoot,
      stateRoot: join(input.stateRoot, "managed-child-sessions"),
    }),
  });
  for (const agent of legacy.agents) {
    if (
      [agent, ...agent.attemptHistory].some(
        (attempt) => !["completed", "failed", "cancelled"].includes(attempt.status),
      )
    )
      return `Agent ${agent.agentId} has unfinished work or recovery. Close this list and open Agents to inspect or stop it.`;
  }
  const operations = await readUnfinishedSessionOperations(input);
  if (operations.length > 0)
    return `Operation ${operations[0]} has unfinished work or recovery. Close this list and open its Operation to inspect or stop it.`;
  return undefined;
}
