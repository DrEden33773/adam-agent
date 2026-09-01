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
  #previewOffset = 0;
  #previewPageSize = 8;
  #selection: "allow" | "deny";
  #subjectLineCount = 0;
  #subjectOffset = 0;
  #subjectPageSize = 4;

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
      this.#scrollAuthorityOrPreview(wheel[1] === "64" ? -3 : 3);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const direction = matchesKey(data, Key.pageUp) ? -1 : 1;
      const subjectMaximum = Math.max(0, this.#subjectLineCount - this.#subjectPageSize);
      if (
        (direction > 0 && this.#subjectOffset < subjectMaximum) ||
        (direction < 0 && this.#previewOffset === 0 && this.#subjectOffset > 0)
      ) {
        this.#scrollSubject(direction * this.#subjectPageSize);
      } else {
        this.#scrollPreview(direction * this.#previewPageSize);
      }
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
    const subject = exactTerminalSubject(this.#interaction.subject.value);
    const effect =
      this.#interaction.effect === "read"
        ? this.#theme.keyword(this.#interaction.effect)
        : this.#theme.danger(this.#interaction.effect);
    const actionPrefix = `${this.#theme.keyword("Action")} ${effect} · ${this.#theme.keyword(
      "Subject",
    )} `;
    const actionPrefixWidth = visibleWidth(actionPrefix);
    const allActionLines =
      width > actionPrefixWidth
        ? wrapExactText(subject, width - actionPrefixWidth).map((line, index) =>
            index === 0 ? `${actionPrefix}${this.#theme.subject(line)}` : this.#theme.subject(line),
          )
        : [
            ...wrapExactText(
              `Action ${this.#interaction.effect} · Subject `,
              Math.max(1, width),
            ).map((line) => this.#theme.keyword(line)),
            ...wrapExactText(subject, Math.max(1, width)).map((line) => this.#theme.subject(line)),
          ];
    this.#subjectPageSize = width < 60 ? 2 : 4;
    this.#subjectLineCount = allActionLines.length;
    this.#subjectOffset = Math.min(
      this.#subjectOffset,
      Math.max(0, this.#subjectLineCount - this.#subjectPageSize),
    );
    const actionLines = allActionLines.slice(
      this.#subjectOffset,
      this.#subjectOffset + this.#subjectPageSize,
    );
    const subjectPosition =
      this.#subjectLineCount <= this.#subjectPageSize
        ? []
        : [
            this.#theme.muted(
              `Subject ${this.#subjectOffset + 1}-${Math.min(
                this.#subjectLineCount,
                this.#subjectOffset + this.#subjectPageSize,
              )} of ${this.#subjectLineCount} · Wheel/PageUp/PageDown`,
            ),
          ];
    const warningLine =
      this.#interaction.warning === undefined
        ? []
        : wrapExactText(safeTerminalText(this.#interaction.warning), Math.max(1, width)).map(
            (line) => this.#theme.danger(line),
          );
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
            ...actionLines,
            ...subjectPosition,
            ...warningLine,
            options,
            "Enter · Esc deny · Ctrl+C abort",
            previewPosition,
            ...preview,
          ]
        : [
            this.#theme.toolTitle("Permission required"),
            ...actionLines,
            ...subjectPosition,
            ...warningLine,
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

  #scrollSubject(lines: number): void {
    const maximum = Math.max(0, this.#subjectLineCount - this.#subjectPageSize);
    this.#subjectOffset = Math.max(0, Math.min(maximum, this.#subjectOffset + lines));
  }

  #scrollAuthorityOrPreview(lines: number): void {
    const subjectMaximum = Math.max(0, this.#subjectLineCount - this.#subjectPageSize);
    if (lines > 0) {
      if (this.#subjectOffset < subjectMaximum) {
        this.#scrollSubject(lines);
      } else {
        this.#scrollPreview(lines);
      }
      return;
    }
    if (this.#previewOffset > 0) {
      this.#scrollPreview(lines);
    } else {
      this.#scrollSubject(lines);
    }
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapExactText(value: string, maximumWidth: number): string[] {
  if (value.length === 0) {
    return [""];
  }
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    const segmentWidth = visibleWidth(segment);
    if (line.length > 0 && lineWidth + segmentWidth > maximumWidth) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += segment;
    lineWidth += segmentWidth;
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

function exactTerminalSubject(value: string): string {
  const safe = safeTerminalText(value);
  if (safe === value) {
    return value;
  }
  return [...JSON.stringify(value)]
    .map((character) => {
      if (safeTerminalText(character) === character) {
        return character;
      }
      return `\\u${(character.codePointAt(0) as number).toString(16).padStart(4, "0")}`;
    })
    .join("");
}
