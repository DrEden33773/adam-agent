import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";
import type { TodoCompactViewModel } from "./todo-compact-view-model.js";

export class TodoCompactOverlay implements Component {
  readonly #theme: AdamTuiTheme;
  readonly #viewModel: TodoCompactViewModel;

  constructor(viewModel: TodoCompactViewModel, theme: AdamTuiTheme) {
    this.#viewModel = viewModel;
    this.#theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = this.#viewModel.snapshot();
    if (!snapshot.visible) {
      return [];
    }
    if (snapshot.collapsed) {
      return [
        boundedTodoLine(
          `Todos · ${snapshot.unfinishedCount} unfinished · collapsed · ${snapshot.blockedCount} blocked · /todos to expand`,
          width,
        ),
      ];
    }
    const hidden = [
      ...(snapshot.hiddenUnfinished === 0 ? [] : [`${snapshot.hiddenUnfinished} unfinished`]),
      ...(snapshot.hiddenCompleted === 0 ? [] : [`${snapshot.hiddenCompleted} completed`]),
    ];
    return [
      this.#theme.toolTitle(
        `Todos · ${snapshot.unfinishedCount} unfinished · ${snapshot.blockedCount} blocked`,
      ),
      ...snapshot.rows.map(
        (row) =>
          `${this.#theme.text(row.glyph)} ${safeTerminalText(row.title)}${row.blocked ? " · blocked" : ""}`,
      ),
      ...(hidden.length === 0 ? [] : [`+${hidden.join(" · ")} hidden · /todos for full list`]),
    ].map((line) => boundedTodoLine(line, width));
  }
}

function boundedTodoLine(line: string, width: number): string {
  const bounded = truncateToWidth(line, Math.max(1, width), "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove formatter resets only from an originally plain NO_COLOR line.
  return line.includes("\u001b[") ? bounded : bounded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}
