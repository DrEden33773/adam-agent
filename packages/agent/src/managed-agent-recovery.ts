import type { ManagedControlOutcome, ManagedControlThread } from "@adam-agent/presentation";
import type { RunResult } from "./agent-session-contracts.js";
import { type ManagedControlRecord, managedTranscriptLink } from "./managed-agent-folds.js";
import {
  contextUsageSnapshotFromRecords,
  isGenesisRecord,
  snapshotFromRecords,
} from "./session-history-folds.js";
import { validateCurrentSessionHistory } from "./session-history-validation.js";
import { createAgentResumeState } from "./session-lifecycle.js";
import {
  type SessionRecord,
  type SessionStoreDirectory,
  SessionStoreError,
} from "./session-store.js";
import type { ToolRegistry } from "./tool-runtime.js";

/** Cross-store verification belongs to Control; child transcript bytes remain SessionStore-owned. */
export async function inspectManagedChildReceipt(
  thread: ManagedControlThread,
  stores: SessionStoreDirectory<SessionRecord>,
): Promise<ManagedControlThread> {
  const outcome = thread.turn.outcome;
  const receipt = outcome?.transcript ?? thread.turn.watchdog?.transcript;
  if (receipt === undefined) return thread;
  try {
    const records = await (await stores.open(thread.turn.childSessionId))?.read();
    if (
      records === undefined &&
      outcome?.status === "cancelled" &&
      outcome.transcript.sequence === 0 &&
      outcome.transcript.digest === managedTranscriptLink([]).digest
    )
      return thread;
    const genesis = records?.[0];
    if (
      records === undefined ||
      genesis?.schemaVersion !== 3 ||
      genesis.record.type !== "session_genesis" ||
      genesis.record.sessionId !== thread.turn.childSessionId ||
      managedTranscriptLink(records.filter((record) => record.sequence <= receipt.sequence))
        .digest !== receipt.digest ||
      (outcome !== undefined && (records.at(-1)?.sequence ?? 0) !== receipt.sequence)
    )
      throw new SessionStoreError();
    return thread;
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;
    return {
      ...thread,
      turn: {
        ...thread.turn,
        recovery: "required",
        diagnostic: "Child history is unavailable. Inspect durable state.",
      },
    };
  }
}

export function prepareManagedChildResume(
  records: readonly SessionRecord[],
  tools: ToolRegistry,
  workspaceRoot: string,
): ReturnType<typeof createAgentResumeState> | undefined {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) return undefined;
  validateCurrentSessionHistory(genesis, records, workspaceRoot);
  const snapshot = snapshotFromRecords(genesis, records);
  // An acknowledged provider request is never resent, even when no response bytes were observed.
  if (
    (snapshot.run?.lastAttempt !== undefined && snapshot.run.lastAttempt.status !== "completed") ||
    snapshot.run?.result !== undefined
  )
    return undefined;
  return createAgentResumeState(records, tools, snapshot);
}

export function managedChildTerminalResult(
  records: readonly SessionRecord[],
  workspaceRoot: string,
): RunResult | undefined {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) return undefined;
  validateCurrentSessionHistory(genesis, records, workspaceRoot);
  return snapshotFromRecords(genesis, records).run?.result;
}

export function validateManagedParentHistory(
  records: readonly SessionRecord[],
  parentSessionId: string,
  projectId: string,
  workspaceRoot: string,
): void {
  const genesis = records[0];
  if (
    genesis === undefined ||
    !isGenesisRecord(genesis) ||
    genesis.record.sessionId !== parentSessionId ||
    genesis.record.projectId !== projectId
  )
    throw new SessionStoreError();
  validateCurrentSessionHistory(genesis, records, workspaceRoot);
}

/** One outcome projection serves live settlement and cold terminal materialization. */
export function managedOutcomeFromChild(
  result: RunResult,
  records: readonly SessionRecord[],
  turnRecords: readonly ManagedControlRecord[],
): ManagedControlOutcome {
  const stalled = turnRecords.some((record) => record.event.type === "stalled");
  const provider = records.findLast(
    (record) => record.schemaVersion === 3 && record.record.type === "provider_attempt_started",
  );
  const partial = records.findLast(
    (record) =>
      record.sequence > (provider?.sequence ?? 0) &&
      record.schemaVersion === 3 &&
      ((record.record.type === "provider_attempt_interrupted" &&
        record.record.reason === "run_terminal" &&
        record.record.partialOutput !== undefined) ||
        (record.record.type === "runtime_event" &&
          record.record.event.type === "model_message_completed")),
  );
  const partialText =
    partial?.schemaVersion !== 3
      ? ""
      : partial.record.type === "provider_attempt_interrupted" &&
          partial.record.reason === "run_terminal"
        ? (partial.record.partialOutput?.text ?? "")
        : partial.record.type === "runtime_event" &&
            partial.record.event.type === "model_message_completed"
          ? partial.record.event.text
          : "";
  const bytes = Buffer.from(result.status === "completed" ? result.answer : partialText, "utf8");
  let end = Math.min(bytes.length, 16 * 1024);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const usage = contextUsageSnapshotFromRecords(records);
  const ordinary = usage?.ordinaryUsage;
  const compaction = usage?.compactionUsage;
  return {
    type: "outcome",
    status: stalled
      ? "failed"
      : result.status === "completed"
        ? "completed"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed",
    summary: bytes.subarray(0, end).toString("utf8"),
    transcript: managedTranscriptLink(records),
    usage: {
      inputTokens: (ordinary?.inputTokens ?? 0) + (compaction?.inputTokens ?? 0),
      outputTokens: (ordinary?.outputTokens ?? 0) + (compaction?.outputTokens ?? 0),
      reasoningTokens: (ordinary?.reasoningTokens ?? 0) + (compaction?.reasoningTokens ?? 0),
      unknownCalls: (ordinary?.unknownCalls ?? 0) + (compaction?.unknownCalls ?? 0),
      providerCalls: records.filter(
        (record) =>
          record.schemaVersion === 3 &&
          (record.record.type === "provider_attempt_started" ||
            record.record.type === "context_compaction_started"),
      ).length,
    },
    ...(stalled
      ? {
          error: {
            code: "managed_agent_stalled",
            message: "The managed turn stalled without causal progress.",
          },
        }
      : result.status === "failed"
        ? { error: { code: result.error.code, message: result.error.message } }
        : result.status === "incomplete"
          ? {
              error: {
                code: result.reason,
                message: "The managed turn did not produce a complete response.",
              },
            }
          : {}),
  };
}
