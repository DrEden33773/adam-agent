import type { PendingInteraction } from "@adam-agent/presentation";
import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
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
  #previewOffset = 0;
  #previewPageSize = 8;
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
    this.#previewOffset = 0;
    this.#allowEnabled = this.#interaction.canAllow && input.readable;
    this.#selection = this.#allowEnabled ? "allow" : "deny";
  }

  handleInput(data: string): void {
    const wheel = data.codePointAt(0) === 27 ? data.slice(1).match(/^\[<(64|65);\d+;\d+M$/u) : null;
    if (wheel !== null) {
      this.#scrollPreview(wheel[1] === "64" ? -3 : 3);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.#scrollPreview(
        matchesKey(data, Key.pageUp) ? -this.#previewPageSize : this.#previewPageSize,
      );
      return;
    }
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
    const subject = truncateToWidth(safeTerminalText(this.#interaction.subject.value), width);
    const effect =
      this.#interaction.effect === "read"
        ? this.#theme.keyword(this.#interaction.effect)
        : this.#theme.danger(this.#interaction.effect);
    const actionLine = `${this.#theme.keyword("Action")} ${effect} · ${this.#theme.keyword(
      "Subject",
    )} ${this.#theme.subject(subject)}`;
    const options = this.#allowEnabled
      ? `${this.#selection === "allow" ? ">" : " "} ${this.#theme.allow("Allow")}    ${
          this.#selection === "deny" ? ">" : " "
        } ${this.#theme.deny("Deny")}`
      : `  ${this.#theme.allow("Allow")} unavailable    > ${this.#theme.deny("Deny")}`;
    const previewLines = this.#preview.split("\n");
    this.#previewPageSize = width < 60 ? 2 : 8;
    this.#previewOffset = Math.min(
      this.#previewOffset,
      Math.max(0, previewLines.length - this.#previewPageSize),
    );
    const preview = previewLines.slice(
      this.#previewOffset,
      this.#previewOffset + this.#previewPageSize,
    );
    const previewPosition = `Preview ${this.#previewOffset + 1}-${Math.min(
      previewLines.length,
      this.#previewOffset + this.#previewPageSize,
    )} of ${previewLines.length} · Wheel/PageUp/PageDown`;
    return (
      width < 60
        ? [
            this.#theme.toolTitle("Permission required"),
            actionLine,
            options,
            "Enter · Esc deny · Ctrl+C abort",
            previewPosition,
            ...preview,
          ]
        : [
            this.#theme.toolTitle("Permission required"),
            actionLine,
            "",
            ...preview,
            "",
            options,
            "Enter confirm · ←/→ select · Esc deny · Ctrl+C abort",
            previewPosition,
          ]
    ).map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  #scrollPreview(lines: number): void {
    const maximum = Math.max(0, this.#preview.split("\n").length - this.#previewPageSize);
    this.#previewOffset = Math.max(0, Math.min(maximum, this.#previewOffset + lines));
  }
}
