import type { PendingInteraction } from "@adam-agent/presentation";
import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class PermissionOverlay implements Component, Focusable {
  focused = false;
  readonly #interaction: PendingInteraction;
  readonly #onDecision: (decision: "allow" | "deny") => void;
  readonly #theme: AdamTuiTheme;
  #allowEnabled: boolean;
  #preview = "Loading canonical preview…";
  #selection: "allow" | "deny";

  constructor(options: {
    readonly interaction: PendingInteraction;
    readonly onDecision: (decision: "allow" | "deny") => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#interaction = options.interaction;
    this.#onDecision = options.onDecision;
    this.#theme = options.theme;
    this.#allowEnabled = false;
    this.#selection = "deny";
  }

  setPreview(input: { readonly readable: boolean; readonly text: string }): void {
    this.#preview = safeTerminalText(input.text);
    this.#allowEnabled = this.#interaction.canAllow && input.readable;
    this.#selection = this.#allowEnabled ? "allow" : "deny";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.#allowEnabled) {
        this.#selection = this.#selection === "allow" ? "deny" : "allow";
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.#onDecision("deny");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.#onDecision(this.#selection);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 4) {
      return [truncateToWidth("Permission required", Math.max(0, width))];
    }
    const innerWidth = width - 4;
    const subject = truncateToWidth(safeTerminalText(this.#interaction.subject.value), innerWidth);
    const options = this.#allowEnabled
      ? `${this.#selection === "allow" ? ">" : " "} Allow    ${
          this.#selection === "deny" ? ">" : " "
        } Deny`
      : "  Allow unavailable    > Deny";
    const content = [
      this.#theme.toolTitle("Permission required"),
      `${this.#interaction.effect} · ${subject}`,
      "",
      ...this.#preview.split("\n"),
      "",
      options,
      "Enter confirm · ←/→ select · Esc deny · Ctrl+C abort",
    ].map((line) => padLine(truncateToWidth(line, innerWidth), innerWidth));
    return [
      `┌${"─".repeat(Math.max(0, width - 2))}┐`,
      ...content.map((line) => `│ ${line} │`),
      `└${"─".repeat(Math.max(0, width - 2))}┘`,
    ];
  }
}

function padLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}
