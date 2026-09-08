/**
 * Tree rows, state grammar and line budget adapt @juicesharp/rpiv-todo 2.9.0,
 * f3291e1ea14729d42aafd5f0f713e63c813e1f2e (MIT), todo-overlay.ts and view/format.ts.
 * Adam retains its canonical domain and permissions. See THIRD_PARTY_NOTICES.md.
 */
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";
import type { TodoCompactViewModel } from "./todo-compact-view-model.js";

export class TodoCompactOverlay implements Component {
  readonly #theme: AdamTuiTheme;
  readonly #viewModel: TodoCompactViewModel;
  readonly #maximumLines: (width: number) => number;
  readonly #toggleHint: () => string;

  constructor(
    viewModel: TodoCompactViewModel,
    theme: AdamTuiTheme,
    options: {
      readonly maximumLines?: (width: number) => number;
      readonly toggleHint?: () => string;
    } = {},
  ) {
    this.#maximumLines = options.maximumLines ?? (() => 12);
    this.#toggleHint = options.toggleHint ?? (() => "Alt+T");
    this.#viewModel = viewModel;
    this.#theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maximumLines = this.#maximumLines(width);
    const snapshot = this.#viewModel.snapshot(maximumLines);
    if (!snapshot.visible) {
      return [];
    }
    const heading = this.#theme.toolTitle(
      `${snapshot.unfinishedCount > 0 ? "●" : "○"} Todos (${snapshot.completedCount}/${snapshot.totalCount})`,
    );
    if (maximumLines < 3)
      return [
        boundedTodoLine(
          `${snapshot.unfinishedCount > 0 ? "●" : "○"} Todos (${snapshot.completedCount}/${snapshot.totalCount}) · ${snapshot.totalCount} hidden`,
          width,
        ),
      ];
    if (snapshot.collapsed)
      return [
        boundedTodoLine(heading, width),
        boundedTodoLine(`└─ ${this.#toggleHint()} or /todos toggle to expand`, width),
        "",
      ];
    const hidden = [
      ...(snapshot.hiddenCompleted === 0 ? [] : [`${snapshot.hiddenCompleted} completed`]),
      ...(snapshot.hiddenUnfinished === 0 ? [] : [`${snapshot.hiddenUnfinished} unfinished`]),
    ];
    const showIds = snapshot.rows.some((row) => row.dependencies.length > 0);
    const rows = snapshot.rows.map((row, index) => {
      const connector = index === snapshot.rows.length - 1 && hidden.length === 0 ? "└─" : "├─";
      const title = safeTerminalText(row.title);
      const subject =
        row.glyph === "✓"
          ? this.#theme.markdown.strikethrough(this.#theme.muted(title))
          : row.glyph === "◐"
            ? this.#theme.subject(title)
            : this.#theme.text(title);
      const glyph =
        row.glyph === "✓"
          ? this.#theme.statusSuccess(row.glyph)
          : row.glyph === "◐"
            ? this.#theme.statusWarning(row.glyph)
            : this.#theme.muted(row.glyph);
      return `${this.#theme.muted(connector)} ${glyph}${showIds ? ` #${row.label}` : ""} ${subject}${row.activeForm === undefined ? "" : ` (${safeTerminalText(row.activeForm)})`}${row.dependencies.length === 0 ? "" : ` ⛓ ${row.dependencyLabels.map((label) => `#${label}`).join(",")}`}${row.blocked ? " · blocked" : ""}`;
    });
    return [
      heading,
      ...rows,
      ...(hidden.length === 0
        ? []
        : [
            `└─ +${snapshot.hiddenCompleted + snapshot.hiddenUnfinished} more (${hidden.join(", ")})`,
          ]),
    ]
      .map((line) => boundedTodoLine(line, width))
      .concat("");
  }
}

function boundedTodoLine(line: string, width: number): string {
  const bounded = truncateToWidth(line, Math.max(1, width), "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove formatter resets only from an originally plain NO_COLOR line.
  return line.includes("\u001b[") ? bounded : bounded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}
