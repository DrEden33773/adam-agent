import type { SessionExecutionFailure } from "@adam-agent/presentation";
import { z } from "zod";
import type { RunResult } from "./agent-session-contracts.js";
import { type SessionRecord, SessionStoreError } from "./session-store.js";

export type { SessionExecutionFailure } from "@adam-agent/presentation";

/** An execution failure can be returned even when no terminal record was written. */
export type AgentExecutionResult =
  | RunResult
  | {
      readonly status: "failed";
      readonly error: {
        readonly code: "session_persistence_failed" | "session_execution_failed";
        readonly message: string;
      };
      readonly executionFailure: SessionExecutionFailure;
    };

export type ExecutionFailureDetails = Pick<
  SessionExecutionFailure,
  "category" | "stage" | "writeOutcome" | "reason"
>;

export class ExecutionFailureSignal extends Error {
  constructor(
    readonly details: ExecutionFailureDetails,
    readonly record?: SessionRecord,
    readonly phase?: SessionExecutionFailure["phase"],
    readonly callId?: string,
  ) {
    super("The current execution could not continue safely.");
  }
}

/** Carries current diagnostics when a failed execution cannot also supply a fresh snapshot. */
export class SessionExecutionError extends Error {
  constructor(readonly executionFailure: SessionExecutionFailure) {
    super(executionFailure.message);
    this.name = "SessionExecutionError";
  }
}

export function persistenceFailure(
  error: unknown,
  record?: SessionRecord,
  phase?: SessionExecutionFailure["phase"],
): ExecutionFailureSignal {
  let details: ExecutionFailureDetails | undefined;
  try {
    if (error instanceof SessionStoreError) details = normalizeDetails(error.appendFailure);
  } catch {
    /* Opaque adapter metadata remains uncertain. */
  }
  return new ExecutionFailureSignal(
    details ?? {
      category: "append_outcome_uncertain",
      stage: "adapter",
      writeOutcome: "uncertain",
      reason: "unknown",
    },
    record,
    phase,
  );
}

export function executionFailureResult(
  error: unknown,
  sessionId: string | undefined,
  runId: string | undefined,
): Extract<AgentExecutionResult, { readonly executionFailure: SessionExecutionFailure }> {
  const signal = error instanceof ExecutionFailureSignal ? error : undefined;
  const details: ExecutionFailureDetails = normalizeDetails(signal?.details) ?? {
    category: "execution_failed",
    stage: "execution",
    writeOutcome: null,
    reason: "unknown",
  };
  const record = signal?.record;
  const event =
    record?.schemaVersion === 3
      ? record.record.type === "runtime_event"
        ? record.record.event
        : undefined
      : record?.event;
  const phase: SessionExecutionFailure["phase"] =
    signal?.phase ??
    (event?.type === "user_message" ||
    (record?.schemaVersion === 3 && record.record.type === "logical_run_started")
      ? "user_input"
      : event?.type === "tool_completed" || event?.type === "tool_failed"
        ? "tool_result"
        : event?.type.startsWith("tool_")
          ? "tool_execution"
          : event?.type === "session_settled" ||
              event?.type === "session_interrupted" ||
              (record?.schemaVersion === 3 && record.record.type === "run_settled")
            ? "run_settlement"
            : event?.type.startsWith("model_") ||
                (record?.schemaVersion === 3 &&
                  (record.record.type.startsWith("model_") ||
                    record.record.type.startsWith("provider_")))
              ? "model_response"
              : record === undefined
                ? "execution"
                : "session_metadata");
  const callId =
    signal?.callId ??
    (event !== undefined && "callId" in event
      ? event.callId
      : record?.schemaVersion === 3 && "callId" in record.record
        ? record.record.callId
        : undefined);
  const message =
    details.category === "encoding_rejected"
      ? "Session record rejected before writing."
      : details.category === "append_outcome_uncertain"
        ? "Session write outcome uncertain. Inspect durable state before retrying."
        : details.category === "storage_io_failed"
          ? details.writeOutcome === "committed"
            ? "Session record was saved, but storage cleanup failed."
            : "Session storage unavailable. The record was not written."
          : details.stage === "barrier"
            ? "Execution stopped at a required runtime barrier."
            : "Execution stopped unexpectedly.";
  return {
    status: "failed",
    error: {
      code:
        details.category === "execution_failed"
          ? "session_execution_failed"
          : "session_persistence_failed",
      message:
        details.category === "execution_failed"
          ? "The session execution stopped unexpectedly."
          : "The session event could not be persisted.",
    },
    executionFailure: {
      ...details,
      phase,
      sessionId: boundedIdentity(sessionId),
      runId: boundedIdentity(runId),
      callId:
        typeof callId === "string" && callId.length > 0 && callId.length <= 256 ? callId : null,
      attemptedSequence: record?.sequence ?? null,
      message,
    },
  };
}

function boundedIdentity(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null;
}

const detailsSchema = z
  .strictObject({
    category: z.enum([
      "encoding_rejected",
      "storage_io_failed",
      "append_outcome_uncertain",
      "execution_failed",
    ]),
    stage: z.enum([
      "admission",
      "open",
      "permissions",
      "write",
      "sync",
      "close",
      "adapter",
      "artifact",
      "execution",
      "barrier",
    ]),
    writeOutcome: z.enum(["not_written", "committed", "uncertain"]).nullable(),
    reason: z.enum([
      "invalid_record",
      "size_limit",
      "sequence_mismatch",
      "permission_denied",
      "storage_full",
      "read_only",
      "unavailable",
      "io_error",
      "unknown",
    ]),
  })
  .refine((value) => {
    switch (value.category) {
      case "encoding_rejected":
        return value.stage === "admission" && value.writeOutcome === "not_written";
      case "storage_io_failed":
        return (
          ((value.stage === "admission" ||
            value.stage === "open" ||
            value.stage === "permissions") &&
            value.writeOutcome === "not_written") ||
          (value.stage === "close" && value.writeOutcome === "committed")
        );
      case "append_outcome_uncertain":
        return (
          ["write", "sync", "adapter", "artifact"].includes(value.stage) &&
          value.writeOutcome === "uncertain"
        );
      case "execution_failed":
        return (
          (value.stage === "execution" && value.writeOutcome === null) ||
          (value.stage === "barrier" && value.writeOutcome === "committed")
        );
    }
  });

function normalizeDetails(value: unknown): ExecutionFailureDetails | undefined {
  try {
    const parsed = detailsSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
