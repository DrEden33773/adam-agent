import type { ManagedAdmissionDisplay } from "@adam-agent/presentation";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

/** A recorded admission acknowledges startup or queueing, never task completion. */
export class AgentAdmissionCard implements Component {
  constructor(
    private readonly admission: ManagedAdmissionDisplay,
    private readonly theme: AdamTuiTheme,
    private readonly showExpandHint = false,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [
      this.theme.toolTitle(
        safeTerminalText(`${this.admission.displayName} · ${this.admission.description}`),
      ),
      this.theme.toolOutput(
        safeTerminalText(
          `${this.admission.status === "started" ? "Started" : "Queued"} ${this.admission.handle}${this.showExpandHint ? " · Ctrl+O expand" : ""}`,
        ),
      ),
    ].map((line) => truncateToWidth(line, width));
  }
}
