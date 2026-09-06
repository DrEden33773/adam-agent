import { createHash } from "node:crypto";
import type { ManagedControlOutcome, ManagedControlThread } from "@adam-agent/presentation";
import type { RunResult } from "./agent-session-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  type ManagedControlRecord,
  managedControlDigest,
  managedTranscriptLink,
} from "./managed-agent-folds.js";
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
  admission?: ManagedControlRecord,
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
    if (admission !== undefined && genesis !== undefined)
      validateManagedChildGenesis(admission, genesis);
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

export async function managedChildTerminalResult(
  records: readonly SessionRecord[],
  workspaceRoot: string,
  artifactStore?: ArtifactStore,
): Promise<RunResult | undefined> {
  const genesis = records[0];
  if (genesis === undefined || !isGenesisRecord(genesis)) return undefined;
  validateCurrentSessionHistory(genesis, records, workspaceRoot);
  const result = snapshotFromRecords(genesis, records).run?.result;
  if (result !== undefined) return result;
  const settlement = records.findLast(
    (record) => record.schemaVersion === 3 && record.record.type === "run_settled",
  );
  if (settlement?.schemaVersion !== 3 || settlement.record.type !== "run_settled") return undefined;
  const linked = settlement.record;
  const response = records.find((record) => record.sequence === linked.responseSequence);
  if (
    response?.schemaVersion !== 3 ||
    response.record.type !== "model_response_completed" ||
    response.record.response.recordVersion !== 2
  )
    throw new SessionStoreError();
  const field = response.record.response.text;
  let answer: string;
  if (field.storage === "inline") answer = field.text;
  else {
    if (field.reference.byteCount > 64 * 1024 * 1024) throw new SessionStoreError();
    const bytes = await artifactStore?.read(field.reference.id, {
      maximumBytes: field.reference.byteCount,
    });
    if (
      bytes === undefined ||
      bytes.byteLength !== field.reference.byteCount ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== field.reference.id
    )
      throw new SessionStoreError();
    try {
      answer = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SessionStoreError();
    }
  }
  return linked.status === "completed"
    ? { status: "completed", answer }
    : { status: "incomplete", reason: linked.reason, answer };
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
  const blocked = turnRecords.findLast((record) => record.event.type === "budget_blocked");
  const budgetError =
    blocked?.event.type === "budget_blocked"
      ? { code: blocked.event.code, message: blocked.event.message }
      : undefined;
  const suspended =
    turnRecords.some((record) => record.event.type === "suspend_requested") &&
    turnRecords.some((record) => record.event.type === "started");
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
  const bytes = Buffer.from(
    result.status === "completed" || result.status === "incomplete" ? result.answer : partialText,
    "utf8",
  );
  let end = Math.min(bytes.length, 16 * 1024);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const usage = contextUsageSnapshotFromRecords(records);
  const ordinary = usage?.ordinaryUsage;
  const compaction = usage?.compactionUsage;
  const reservations = turnRecords.flatMap((record) =>
    record.event.type === "provider_reserved" ? [record.event] : [],
  );
  const settlements = turnRecords.flatMap((record) =>
    record.event.type === "provider_usage" ? [record.event] : [],
  );
  const fleetUsage = turnRecords.some(
    (record) => record.event.type === "admitted" && record.event.envelope !== undefined,
  )
    ? {
        inputTokens: settlements.reduce((sum, event) => sum + event.inputTokens, 0),
        outputTokens: settlements.reduce((sum, event) => sum + event.outputTokens, 0),
        reasoningTokens: settlements.reduce((sum, event) => sum + event.reasoningTokens, 0),
        providerCalls: reservations.length,
        unknownCalls: reservations.filter(
          (reservation) => !settlements.some((event) => event.requestId === reservation.requestId),
        ).length,
      }
    : undefined;
  return {
    type: "outcome",
    status: suspended
      ? "interrupted"
      : stalled
        ? "failed"
        : result.status === "completed"
          ? "completed"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed",
    summary: bytes.subarray(0, end).toString("utf8"),
    transcript: managedTranscriptLink(records),
    usage: fleetUsage ?? {
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
    ...(suspended
      ? {
          error: {
            code: "managed_agent_interrupted",
            message:
              "Execution was interrupted by explicit suspension or exit. Continue only from a settled boundary.",
          },
        }
      : budgetError !== undefined
        ? { error: budgetError }
        : stalled
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

/** Large result materialization uses the existing immutable model-response artifact owner. */
export async function materializeManagedOutcome(
  result: RunResult,
  records: readonly SessionRecord[],
  turnRecords: readonly ManagedControlRecord[],
  artifactStore?: ArtifactStore,
): Promise<ManagedControlOutcome> {
  const outcome = managedOutcomeFromChild(result, records, turnRecords);
  if (
    (result.status !== "completed" && result.status !== "incomplete") ||
    Buffer.byteLength(result.answer, "utf8") <= 16 * 1024
  )
    return outcome;
  const response = records.findLast(
    (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
  );
  const genesis = records[0];
  if (
    artifactStore === undefined ||
    response?.schemaVersion !== 3 ||
    response.record.type !== "model_response_completed" ||
    genesis?.schemaVersion !== 3 ||
    genesis.record.type !== "session_genesis"
  )
    throw new SessionStoreError();
  const bytes = Buffer.from(result.answer, "utf8");
  const reference = await artifactStore.write({
    bytes,
    mediaType: "text/plain; charset=utf-8",
    source: {
      type: "model_response",
      schemaVersion: 1,
      field: "text",
      projectId: genesis.record.projectId,
      sessionId: genesis.record.sessionId,
      runId: response.record.runId,
      turn: response.record.turn,
      attempt: response.record.attempt,
      targetIdentity: response.record.targetIdentity,
      provenance: "provider_model_response",
    },
  });
  const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  if (reference.id !== id || reference.byteCount !== bytes.byteLength)
    throw new SessionStoreError();
  return {
    ...outcome,
    artifact: { id, byteCount: bytes.byteLength, mediaType: "text/plain; charset=utf-8" },
  };
}

export function validateManagedChildGenesis(
  admission: ManagedControlRecord,
  genesis: SessionRecord,
): void {
  if (
    genesis.schemaVersion !== 3 ||
    genesis.record.type !== "session_genesis" ||
    genesis.record.sessionId !== admission.childSessionId
  )
    throw new SessionStoreError();
  if (admission.event.type !== "admitted" || admission.event.frozen === undefined) return;
  const parent = genesis.record.managedParent;
  if (
    parent?.version !== 3 ||
    parent.parentSessionId !== admission.parentSessionId ||
    parent.threadId !== admission.threadId ||
    parent.turnId !== admission.turnId ||
    parent.attemptId !== admission.attemptId ||
    parent.admission.sequence !== admission.sequence ||
    parent.admission.digest !== managedControlDigest(admission)
  )
    throw new SessionStoreError();
}
