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
  if (options.status === "active") {
    return `${marker} Thinking · provider reasoning · ${provider} · Ctrl+T ${options.expanded ? "collapse" : "expand"}`;
  }
  if (options.status === "completed") {
    return options.theme.allow(`✓ ${marker} Thinking done · ${provider}`);
  }
  if (options.status === "interrupted") {
    return options.theme.muted(`◇ ${marker} Thinking interrupted · ${provider}`);
  }
  return options.theme.danger(`× ${marker} Thinking failed · ${provider}`);
}
