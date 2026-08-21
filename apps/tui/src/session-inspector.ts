import type { ActiveSessionDisplay, ContextUsageDisplay } from "@adam-agent/presentation";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export type SessionRunStatus =
  | "cancelling"
  | "idle"
  | "permission required"
  | "replying"
  | "using tool"
  | "working";

export class SessionInspector implements Component {
  #active: ActiveSessionDisplay;
  readonly #onClose: () => void;
  #runStatus: SessionRunStatus;
  readonly #theme: AdamTuiTheme;
  #throughSequence: number | null;

  constructor(options: {
    readonly active: ActiveSessionDisplay;
    readonly onClose: () => void;
    readonly runStatus: SessionRunStatus;
    readonly theme: AdamTuiTheme;
    readonly throughSequence: number | null;
  }) {
    this.#active = options.active;
    this.#onClose = options.onClose;
    this.#runStatus = options.runStatus;
    this.#theme = options.theme;
    this.#throughSequence = options.throughSequence;
  }

  setState(options: {
    readonly active: ActiveSessionDisplay;
    readonly runStatus: SessionRunStatus;
    readonly throughSequence: number | null;
  }): void {
    this.#active = options.active;
    this.#runStatus = options.runStatus;
    this.#throughSequence = options.throughSequence;
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.#onClose();
    }
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const { context, session, transcript } = this.#active;
    const userMessages = transcript.items.filter((item) => item.type === "user_message").length;
    const assistantMessages = transcript.items.filter(
      (item) => item.type === "assistant_message",
    ).length;
    const toolCalls = transcript.items.filter((item) => item.type === "tool_call").length;
    const chronology = `${transcript.items.length} loaded · ${userMessages} user · ${assistantMessages} assistant · ${toolCalls} tools${
      this.#throughSequence === null ? "" : ` · through ${this.#throughSequence}`
    }${transcript.olderCursor === null ? "" : " · older available"}`;
    const contextText =
      context === null
        ? "unavailable"
        : context.active.source === "unknown"
          ? `unknown / ${context.profile.contextWindowTokens}`
          : `${context.active.tokens} / ${context.profile.contextWindowTokens} tokens · ${context.active.source}`;
    return [
      this.#theme.toolTitle("Session facts"),
      "",
      `ID      ${safeTerminalText(session.id)}`,
      `Name    ${safeTerminalText(session.naming.displayLabel)}`,
      `Target  ${safeTerminalText(session.targetId)}`,
      `Status  ${session.status}`,
      `Run     ${this.#runStatus}`,
      `Chronology  ${chronology}`,
      `Context  ${contextText}`,
      `Usage    ${context === null ? "unavailable" : usageText(context.ordinaryUsage)}`,
      `Compaction  ${context === null ? "unavailable" : usageText(context.compactionUsage)}`,
      "",
      this.#theme.muted("Esc close · Ctrl+Q exit"),
    ];
  }
}

function usageText(usage: ContextUsageDisplay): string {
  return `${usage.inputTokens} input · ${usage.outputTokens} output · ${usage.reasoningTokens} reasoning · ${usage.cachedInputTokens} cached · ${usage.cacheMissInputTokens} cache miss · ${usage.unknownCalls} unknown calls`;
}
