/**
 * The compact glyph, completed-linger, and completed-first overflow hierarchy selectively adapt
 * @juicesharp/rpiv-todo 2.9.0 at f3291e1ea14729d42aafd5f0f713e63c813e1f2e (MIT).
 * Adam Todo identity, state, revision, dependency, persistence, and mutation semantics are not adapted.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type TodoSummary = NonNullable<ActiveSessionDisplay["todo"]>;
type TodoItem = TodoPageResource["items"][number];

export class TodoCompactOverlay implements Component {
  #collapsed = false;
  #items: readonly TodoItem[] = [];
  readonly #lingeringCompleted = new Map<string, TodoItem>();
  #previousUnfinished = new Map<string, TodoItem>();
  #sessionId: string | null = null;
  #summary: TodoSummary | null = null;
  readonly #theme: AdamTuiTheme;
  #turnKey: string | null = null;

  constructor(theme: AdamTuiTheme) {
    this.#theme = theme;
  }

  get collapsed(): boolean {
    return this.#collapsed;
  }

  invalidate(): void {}

  advanceTurn(sessionId: string, turnKey: string): void {
    if (this.#sessionId !== sessionId) {
      this.#sessionId = sessionId;
      this.#turnKey = turnKey;
      this.#collapsed = false;
      this.#items = [];
      this.#summary = null;
      this.#lingeringCompleted.clear();
      this.#previousUnfinished.clear();
    } else if (this.#turnKey !== turnKey) {
      this.#turnKey = turnKey;
      this.#lingeringCompleted.clear();
    }
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
  }

  setUnavailable(input: {
    readonly sessionId: string;
    readonly summary: TodoSummary;
    readonly turnKey: string;
  }): void {
    this.advanceTurn(input.sessionId, input.turnKey);
    this.#items = [];
    this.#summary = input.summary;
    this.#lingeringCompleted.clear();
    this.#previousUnfinished.clear();
  }

  setState(input: {
    readonly items: readonly TodoItem[];
    readonly sessionId: string;
    readonly summary: TodoSummary;
    readonly turnKey: string;
  }): void {
    this.advanceTurn(input.sessionId, input.turnKey);
    const currentIds = new Set(input.items.map((item) => item.id));
    for (const [id, item] of this.#previousUnfinished) {
      if (!currentIds.has(id)) {
        this.#lingeringCompleted.set(id, { ...item, status: "completed" });
      }
    }
    for (const id of currentIds) {
      this.#lingeringCompleted.delete(id);
    }
    this.#items = [...input.items].sort(todoRowOrder);
    this.#previousUnfinished = new Map(this.#items.map((item) => [item.id, item]));
    this.#summary = input.summary;
  }

  render(width: number): string[] {
    const summary = this.#summary;
    if (summary === null) {
      return [];
    }
    const unfinishedCount = summary.counts.pending + summary.counts.inProgress;
    if (unfinishedCount === 0) {
      return [];
    }
    const heading = `Todos · ${unfinishedCount} unfinished · ${summary.blockedCount} blocked`;
    if (this.#collapsed) {
      return [
        boundedTodoLine(
          `Todos · ${unfinishedCount} unfinished · collapsed · ${summary.blockedCount} blocked · /todos to expand`,
          width,
        ),
      ];
    }
    const unfinished = this.#items.filter((item) => item.status !== "completed");
    const completed = [...this.#lingeringCompleted.values()].sort(todoRowOrder);
    const visibleUnfinished = unfinished.slice(0, 3);
    const remainingRows = 3 - visibleUnfinished.length;
    const visibleCompleted = completed.slice(0, remainingRows);
    const hiddenUnfinished = Math.max(0, unfinishedCount - visibleUnfinished.length);
    const hiddenCompleted = Math.max(0, completed.length - visibleCompleted.length);
    const hidden = [
      ...(hiddenUnfinished === 0 ? [] : [`${hiddenUnfinished} unfinished`]),
      ...(hiddenCompleted === 0 ? [] : [`${hiddenCompleted} completed`]),
    ];
    return [
      this.#theme.toolTitle(heading),
      ...visibleUnfinished.map((item) => todoRow(item, this.#theme)),
      ...visibleCompleted.map((item) => todoRow(item, this.#theme)),
      ...(hidden.length === 0 ? [] : [`+${hidden.join(" · ")} hidden · /todos for full list`]),
    ].map((line) => boundedTodoLine(line, width));
  }
}

function todoRow(item: TodoItem, theme: AdamTuiTheme): string {
  const glyph = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○";
  const blocked = item.blocked ? " · blocked" : "";
  return `${theme.text(glyph)} ${safeTerminalText(item.title)}${blocked}`;
}

function todoRowOrder(left: TodoItem, right: TodoItem): number {
  const leftRank = left.status === "in_progress" ? 0 : left.status === "pending" ? 1 : 2;
  const rightRank = right.status === "in_progress" ? 0 : right.status === "pending" ? 1 : 2;
  return (
    leftRank - rightRank ||
    left.createdOrdinal - right.createdOrdinal ||
    left.id.localeCompare(right.id)
  );
}

function boundedTodoLine(line: string, width: number): string {
  const bounded = truncateToWidth(line, Math.max(1, width), "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove formatter resets only from an originally plain NO_COLOR line.
  return line.includes("\u001b[") ? bounded : bounded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}
