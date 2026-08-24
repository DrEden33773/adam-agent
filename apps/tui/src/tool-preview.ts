import type {
  ToolDiffPreviewLine,
  ToolPreviewDisplay,
  ToolStreamPreview,
  ToolTextPreviewLine,
} from "@adam-agent/presentation";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { highlightCodeLines } from "./syntax-highlight.js";
import type { AdamTuiTheme } from "./theme.js";

const collapsedCodeLineCount = 10;
const collapsedDiffLineCount = 12;
const collapsedShellVisualLineCount = 5;
const expandedShellVisualLineCount = 200;

export class ToolPreview implements Component {
  readonly #expanded: boolean;
  readonly #preview: ToolPreviewDisplay;
  readonly #theme: AdamTuiTheme;

  constructor(preview: ToolPreviewDisplay, expanded: boolean, theme: AdamTuiTheme) {
    this.#preview = preview;
    this.#expanded = expanded;
    this.#theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) {
      return [];
    }
    if (this.#preview.kind === "read_text" || this.#preview.kind === "write_text") {
      return this.#renderText(this.#preview, width);
    }
    if (this.#preview.kind === "diff") {
      return this.#renderDiff(this.#preview, width);
    }
    return [
      ...(streamHasContent(this.#preview.stdout)
        ? this.#renderShellStream("stdout", this.#preview.stdout, width)
        : []),
      ...(streamHasContent(this.#preview.stderr)
        ? this.#renderShellStream("stderr", this.#preview.stderr, width)
        : []),
    ];
  }

  #renderText(
    preview: Extract<ToolPreviewDisplay, { readonly kind: "read_text" | "write_text" }>,
    width: number,
  ): string[] {
    const visible = this.#expanded ? preview.lines : preview.lines.slice(0, collapsedCodeLineCount);
    const rendered = renderNumberedCode(visible, preview.language, width, this.#theme);
    const hiddenLines = preview.lines.length - visible.length;
    const notices = [
      ...(hiddenLines > 0
        ? [
            this.#expanded
              ? `${hiddenLines} projected lines omitted`
              : `${hiddenLines} more projected lines · Ctrl+O expand`,
          ]
        : []),
      ...(preview.omittedBytes > 0
        ? [`${preview.omittedBytes} bytes omitted from bounded preview`]
        : []),
      ...(preview.kind === "read_text" && preview.sourceTruncated
        ? ["tool output truncated at source"]
        : []),
    ];
    return [
      ...rendered,
      ...notices.map((notice) => boundedLine(this.#theme.muted(`… ${notice}`), width)),
    ];
  }

  #renderDiff(
    preview: Extract<ToolPreviewDisplay, { readonly kind: "diff" }>,
    width: number,
  ): string[] {
    const visible = this.#expanded ? preview.lines : preview.lines.slice(0, collapsedDiffLineCount);
    const highlighted = highlightCodeLines(
      visible.map((line) => line.text),
      preview.language,
      this.#theme,
    );
    const numberWidth = Math.max(
      1,
      ...visible.map((line) => String(diffLineNumber(line) ?? "").length),
    );
    const rendered = visible.map((line, index) => {
      const number = diffLineNumber(line);
      const numberText =
        number === null ? " ".repeat(numberWidth) : String(number).padStart(numberWidth);
      const marker =
        line.kind === "addition"
          ? this.#theme.diffAddition("+")
          : line.kind === "deletion"
            ? this.#theme.diffDeletion("-")
            : this.#theme.lineNumber(line.kind === "meta" ? "@" : " ");
      const gutter = `${this.#theme.lineNumber(numberText)} ${marker} │ `;
      const contentWidth = Math.max(0, width - visibleWidth(gutter));
      return `${gutter}${truncateToWidth(highlighted[index] ?? "", contentWidth)}`;
    });
    const hiddenLines = preview.lines.length - visible.length;
    return [
      ...rendered,
      ...(hiddenLines > 0
        ? [
            boundedLine(
              this.#theme.muted(
                `… ${hiddenLines} more diff lines${this.#expanded ? " omitted" : " · Ctrl+O expand"}`,
              ),
              width,
            ),
          ]
        : []),
      ...(preview.omittedBytes > 0
        ? [
            boundedLine(
              this.#theme.muted(`… ${preview.omittedBytes} diff bytes omitted from preview`),
              width,
            ),
          ]
        : []),
    ];
  }

  #renderShellStream(
    label: "stdout" | "stderr",
    stream: ToolStreamPreview,
    width: number,
  ): string[] {
    const safeText = safeTerminalText(stream.text);
    const visualLines = safeText.length === 0 ? [] : wrapTextWithAnsi(safeText, width);
    const limit = this.#expanded ? expandedShellVisualLineCount : collapsedShellVisualLineCount;
    const visible = this.#expanded ? visualLines.slice(0, limit) : visualLines.slice(-limit);
    const hiddenVisualLines = visualLines.length - visible.length;
    const facts = [
      ...(stream.omittedBytes > 0 ? [`${stream.omittedBytes} earlier bytes omitted`] : []),
      ...(hiddenVisualLines > 0
        ? [
            this.#expanded
              ? `${hiddenVisualLines} visual lines omitted`
              : `${hiddenVisualLines} earlier visual lines hidden`,
          ]
        : []),
    ];
    return [
      boundedLine(
        this.#theme.muted(`${label}${facts.length === 0 ? "" : ` · ${facts.join(" · ")}`}`),
        width,
      ),
      ...visible.map((line) => boundedLine(this.#theme.toolOutput(line), width)),
    ];
  }
}

function renderNumberedCode(
  lines: readonly ToolTextPreviewLine[],
  language: string | null,
  width: number,
  theme: AdamTuiTheme,
): readonly string[] {
  const highlighted = highlightCodeLines(
    lines.map((line) => line.text),
    language,
    theme,
  );
  const numberWidth = Math.max(1, ...lines.map((line) => String(line.number).length));
  return lines.map((line, index) => {
    const gutter = theme.lineNumber(`${String(line.number).padStart(numberWidth)} │ `);
    return `${gutter}${truncateToWidth(
      highlighted[index] ?? "",
      Math.max(0, width - visibleWidth(gutter)),
    )}`;
  });
}

function diffLineNumber(line: ToolDiffPreviewLine): number | null {
  return line.kind === "deletion"
    ? line.oldLineNumber
    : line.kind === "addition"
      ? line.newLineNumber
      : (line.newLineNumber ?? line.oldLineNumber);
}

function boundedLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width));
}

function streamHasContent(stream: ToolStreamPreview): boolean {
  return stream.totalBytes > 0 || stream.text.length > 0;
}
