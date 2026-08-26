import {
  ExtensionConfigurationError,
  ModelTargetError,
  SessionLifecycleError,
} from "@adam-agent/agent";
import { findMcpShutdownUnconfirmedError } from "./lifecycle-close.js";

export class TuiConfigurationError extends Error {}

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
