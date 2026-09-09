import type { ManagedControlThread } from "@adam-agent/presentation";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export function agentElapsedLabel(thread: ManagedControlThread, compact = false): string {
  const start = thread.turn.startedAtUnixMilliseconds;
  if (start === undefined) return "";
  const end =
    thread.turn.outcome === undefined
      ? thread.residency === "live"
        ? Date.now()
        : undefined
      : thread.turn.outcome.atUnixMilliseconds;
  if (compact)
    return end === undefined ? "?s" : `${Math.max(0, Math.floor((end - start) / 1000))}s`;
  return end === undefined
    ? " · elapsed unknown"
    : ` · elapsed ${Math.max(0, Math.floor((end - start) / 1000))}s`;
}

export function agentStatusStyle(
  theme: AdamTuiTheme,
  thread: ManagedControlThread,
): (text: string) => string {
  const turn = thread.turn;
  if (turn.outcome?.status === "failed" || (turn.phase === "idle" && turn.lastOutcome === "failed"))
    return theme.statusError;
  if (
    turn.phase === "waiting" ||
    turn.phase === "queued" ||
    turn.attention !== undefined ||
    turn.health === "stalled" ||
    turn.recovery === "required"
  )
    return theme.statusWarning;
  if (turn.phase === "idle")
    return turn.lastOutcome === "completed" ? theme.statusSuccess : theme.muted;
  return theme.reference;
}

export function agentStatus(theme: AdamTuiTheme, thread: ManagedControlThread): string {
  return agentStatusStyle(theme, thread)(safeTerminalText(thread.turn.label));
}

export function agentHeading(
  theme: AdamTuiTheme,
  title: string,
  thread: ManagedControlThread,
): string {
  return `${theme.toolTitle(title)} · ${theme.reference(safeTerminalText(thread.handle))}`;
}

/** Reserve a bounded time field after truncating the descriptive part by display cells. */
export function agentTimedLine(
  theme: AdamTuiTheme,
  content: string,
  thread: ManagedControlThread,
  width: number,
): string {
  const elapsed = agentElapsedLabel(thread, true);
  if (!elapsed || width < 24) return truncateToWidth(content, width);
  const available = Math.max(0, width - visibleWidth(elapsed) - 1);
  const body = truncateToWidth(content, available);
  return (
    body +
    " ".repeat(Math.max(1, width - visibleWidth(body) - visibleWidth(elapsed))) +
    theme.muted(elapsed)
  );
}

export function agentSelectionRow(
  theme: AdamTuiTheme,
  content: string,
  selected: boolean,
  width: number,
): string {
  const line = truncateToWidth(`${selected ? theme.toolTitle(">") : " "} ${content}`, width);
  return selected
    ? theme.selectionBackground(line + " ".repeat(Math.max(0, width - visibleWidth(line))))
    : line;
}
