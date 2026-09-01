import type { PresentationTransientState, ReasoningBlockDisplay } from "@adam-agent/presentation";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type ReasoningStatus =
  | ReasoningBlockDisplay["status"]
  | NonNullable<PresentationTransientState["reasoning"]>["status"];

export function reasoningFoldTitle(options: {
  readonly expanded: boolean;
  readonly provider: string;
  readonly status: ReasoningStatus;
  readonly theme: AdamTuiTheme;
}): string {
  const marker = options.expanded ? "▾" : "▸";
  const provider = safeTerminalText(options.provider);
  const action = `Ctrl+T ${options.expanded ? "fold" : "expand"}`;
  const hint = options.theme.text(` · ${action}`);
  if (options.status === "active") {
    return `${marker} Thinking · provider reasoning · ${provider}${hint}`;
  }
  if (options.status === "completed") {
    return `${options.theme.allow(`✓ ${marker} Thinking done · ${provider}`)}${hint}`;
  }
  if (options.status === "interrupted") {
    return `${options.theme.muted(`◇ ${marker} Thinking interrupted · ${provider}`)}${hint}`;
  }
  return `${options.theme.danger(`× ${marker} Thinking failed · ${provider}`)}${hint}`;
}
