import {
  ExtensionConfigurationError,
  ModelTargetError,
  SessionLifecycleError,
  SessionStoreError,
} from "@adam-agent/agent";
import { findMcpShutdownUnconfirmedError } from "./lifecycle-close.js";

export class TuiConfigurationError extends Error {}

export function tuiExplicitResumeFailureMessage(
  sessionId: string,
  error: unknown,
): string | undefined {
  const reason =
    error instanceof SessionLifecycleError && error.code === "session_invalid"
      ? "its history is invalid"
      : error instanceof SessionStoreError && error.code === "session_log_invalid"
        ? "its log contains an invalid record"
        : error instanceof SessionStoreError && error.code === "session_log_too_large"
          ? "its log exceeds the read limit"
          : undefined;
  return reason === undefined
    ? undefined
    : `Session ${sessionId} could not be opened because ${reason}. The original local session was retained. Start without --resume and open /resume to review it.`;
}

export function tuiProcessFailureMessage(error: unknown): string {
  if (
    error instanceof TuiConfigurationError ||
    error instanceof ExtensionConfigurationError ||
    error instanceof ModelTargetError ||
    error instanceof SessionLifecycleError
  ) {
    return error.message;
  }
  return findMcpShutdownUnconfirmedError(error)?.message ?? "The Adam TUI could not start safely.";
}
