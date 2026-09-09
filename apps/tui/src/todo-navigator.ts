import type {
  ActiveSessionDisplay,
  TodoEntityResource,
  TodoPageResource,
} from "@adam-agent/presentation";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { textKeyInput } from "./text-key-input.js";
import type { AdamTuiTheme } from "./theme.js";

type TodoSummary = NonNullable<ActiveSessionDisplay["todo"]>;

export class TodoNavigator implements Component {
  #detailMaximumScroll = 0;
  #detailPageSize = 1;
  #detailScrollTop = 0;
  readonly #onChange: () => void;
  readonly #onClose: () => void;
  readonly #onGet: (id: string) => Promise<TodoEntityResource>;
  readonly #onList: (cursor: string | null) => Promise<TodoPageResource>;
  readonly #maximumContentHeight: () => number;
  readonly #onCompactCollapseChange: ((collapsed: boolean) => void) | undefined;
  readonly #toggleHint: string;
  readonly #isToggleInput: (data: string) => boolean;
  readonly #summary: TodoSummary;
  readonly #theme: AdamTuiTheme;
  #cursor: string | null = null;
  #compactCollapsed: boolean;
  #detail: TodoEntityResource | null = null;
  #detailMarkdown: { text: string; component: Markdown } | undefined;
  #generation = 0;
  #list: GroupedTodoList;
  #notice: string | null = null;
  #page: TodoPageResource;
  #previousCursors: readonly (string | null)[] = [];

  constructor(options: {
    readonly initialPage: TodoPageResource;
    readonly maximumContentHeight?: () => number;
    readonly compactCollapsed?: boolean;
    readonly toggleHint?: string;
    readonly isToggleInput?: (data: string) => boolean;
    readonly onChange: () => void;
    readonly onClose: () => void;
    readonly onGet: (id: string) => Promise<TodoEntityResource>;
    readonly onList: (cursor: string | null) => Promise<TodoPageResource>;
    readonly onCompactCollapseChange?: (collapsed: boolean) => void;
    readonly summary: TodoSummary;
    readonly theme: AdamTuiTheme;
  }) {
    this.#maximumContentHeight = options.maximumContentHeight ?? (() => 22);
    this.#onChange = options.onChange;
    this.#onClose = options.onClose;
    this.#onGet = options.onGet;
    this.#onList = options.onList;
    this.#onCompactCollapseChange = options.onCompactCollapseChange;
    this.#page = options.initialPage;
    this.#summary = options.summary;
    this.#theme = options.theme;
    this.#compactCollapsed = options.compactCollapsed ?? false;
    this.#toggleHint = options.toggleHint ?? "Alt+T";
    this.#isToggleInput = options.isToggleInput ?? ((data) => matchesKey(data, "alt+t"));
    this.#list = this.#createList(options.initialPage);
  }

  handleInput(data: string): void {
    if (this.#detail !== null && getKeybindings().matches(data, "tui.select.cancel")) {
      this.#generation += 1;
      this.#detail = null;
      this.#detailScrollTop = 0;
      this.#notice = null;
      this.#onChange();
      return;
    }
    if (this.#detail !== null) {
      if (getKeybindings().matches(data, "tui.select.pageUp")) {
        this.#detailScrollTop = Math.max(0, this.#detailScrollTop - this.#detailPageSize);
        this.#onChange();
        return;
      }
      if (getKeybindings().matches(data, "tui.select.pageDown")) {
        this.#detailScrollTop = Math.min(
          this.#detailMaximumScroll,
          this.#detailScrollTop + this.#detailPageSize,
        );
        this.#onChange();
        return;
      }
      return;
    }
    if (this.#isToggleInput(data) && this.#onCompactCollapseChange !== undefined) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return;
      }
      this.#compactCollapsed = !this.#compactCollapsed;
      this.#onCompactCollapseChange(this.#compactCollapsed);
      this.#onChange();
      return;
    }
    if (this.#page.nextCursor !== null && getKeybindings().matches(data, "tui.select.pageDown")) {
      this.#loadPage(this.#page.nextCursor, [...this.#previousCursors, this.#cursor]);
      return;
    }
    if (this.#previousCursors.length > 0 && getKeybindings().matches(data, "tui.select.pageUp")) {
      const previous = this.#previousCursors.at(-1);
      if (previous !== undefined) {
        this.#loadPage(previous, this.#previousCursors.slice(0, -1));
      }
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  cancelPendingRead(): void {
    this.#generation += 1;
  }

  render(width: number): string[] {
    const maximumContentHeight = Math.max(8, Math.floor(this.#maximumContentHeight()));
    if (this.#detail !== null) {
      const { item } = this.#detail;
      const bodyLines = [
        this.#theme.text(safeTerminalText(item.title)),
        `${(item.status === "completed" ? this.#theme.statusSuccess : item.status === "in_progress" ? this.#theme.reference : this.#theme.statusWarning)(item.status)}${this.#theme.muted(` · item revision ${item.itemRevision} · created ${item.createdOrdinal}`)}`,
        this.#theme.muted(`ID ${item.id}`),
        ...(item.activeForm === undefined ? [] : [`Active: ${safeTerminalText(item.activeForm)}`]),
        "",
        ...(item.details === undefined
          ? [this.#theme.muted("No details.")]
          : this.#renderDetails(item.details, width)),
        "",
        item.dependencyIds.length === 0
          ? this.#theme.muted("Dependencies: none")
          : `Dependencies: ${item.dependencyIds.join(", ")}`,
      ].flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width))));
      this.#detailPageSize = Math.max(1, maximumContentHeight - 2);
      this.#detailMaximumScroll = Math.max(0, bodyLines.length - this.#detailPageSize);
      this.#detailScrollTop = Math.min(this.#detailScrollTop, this.#detailMaximumScroll);
      const pageCount = Math.max(1, Math.ceil(bodyLines.length / this.#detailPageSize));
      const page = Math.min(pageCount, Math.ceil(this.#detailScrollTop / this.#detailPageSize) + 1);
      return [
        this.#theme.toolTitle("Todo detail · read-only"),
        ...bodyLines.slice(this.#detailScrollTop, this.#detailScrollTop + this.#detailPageSize),
        this.#theme.muted(`${page}/${pageCount} · PgUp/PgDn · Esc back`),
      ].map((line) => truncateToWidth(line, width));
    }
    const counts = this.#summary.counts;
    const noticeLines = this.#notice === null ? [] : [this.#theme.muted(this.#notice)];
    const listHeight = Math.max(1, maximumContentHeight - 4 - noticeLines.length);
    const listLines = this.#list.render(width, listHeight);
    return [
      this.#theme.toolTitle(`Todos · revision ${this.#summary.storeRevision}`),
      `${counts.pending} pending · ${counts.inProgress} in progress · ${counts.completed} completed · ${this.#summary.blockedCount} blocked`,
      this.#theme.muted("Enter detail · type filter"),
      this.#theme.muted(
        `Esc close · ${this.#toggleHint} ${this.#compactCollapsed ? "expand" : "collapse"} compact · PgUp/PgDn · Ctrl+Q`,
      ),
      ...listLines,
      ...noticeLines,
    ]
      .slice(0, maximumContentHeight)
      .map((line) => truncateToWidth(line, width));
  }

  #renderDetails(text: string, width: number): string[] {
    const safe = safeTerminalText(text);
    if (this.#detailMarkdown?.text !== safe)
      this.#detailMarkdown = {
        text: safe,
        component: new Markdown(safe, 0, 0, this.#theme.markdown, undefined, {
          preserveOrderedListMarkers: true,
          preserveBackslashEscapes: true,
        }),
      };
    try {
      return this.#detailMarkdown.component.render(Math.max(1, width));
    } catch {
      return wrapTextWithAnsi(safe, Math.max(1, width));
    }
  }

  #createList(page: TodoPageResource): GroupedTodoList {
    return new GroupedTodoList(
      page.items,
      this.#theme,
      () => {
        this.cancelPendingRead();
        this.#onClose();
      },
      (id) => this.#loadDetail(id),
    );
  }

  #loadDetail(id: string): void {
    const generation = ++this.#generation;
    this.#notice = "Loading exact Todo detail…";
    this.#onChange();
    void this.#onGet(id).then(
      (detail) => {
        if (generation !== this.#generation) {
          return;
        }
        this.#detail = detail;
        this.#detailScrollTop = 0;
        this.#notice = null;
        this.#onChange();
      },
      () => {
        if (generation !== this.#generation) {
          return;
        }
        this.#notice = "Todo data changed or became unavailable. Close and reopen /todos.";
        this.#onChange();
      },
    );
  }

  #loadPage(cursor: string | null, previousCursors: readonly (string | null)[]): void {
    const generation = ++this.#generation;
    this.#notice = "Loading authoritative Todo page…";
    this.#onChange();
    void this.#onList(cursor).then(
      (page) => {
        if (generation !== this.#generation) {
          return;
        }
        this.#cursor = cursor;
        this.#page = page;
        this.#previousCursors = previousCursors;
        this.#list = this.#createList(page);
        this.#notice = null;
        this.#onChange();
      },
      () => {
        if (generation !== this.#generation) {
          return;
        }
        this.#notice = "Todo data changed or became unavailable. Close and reopen /todos.";
        this.#onChange();
      },
    );
  }
}

// Todo-specific grouping is display state over the authoritative bounded page.
// Pi owns selection/keybindings; headings never enter its selectable items.
class GroupedTodoList {
  readonly #items: TodoPageResource["items"];
  readonly #theme: AdamTuiTheme;
  readonly #onCancel: () => void;
  readonly #onSelect: (id: string) => void;
  #query = "";
  #visible: TodoPageResource["items"] = [];
  #selection: SelectList;

  constructor(
    items: TodoPageResource["items"],
    theme: AdamTuiTheme,
    onCancel: () => void,
    onSelect: (id: string) => void,
  ) {
    this.#items = items;
    this.#theme = theme;
    this.#onCancel = onCancel;
    this.#onSelect = onSelect;
    this.#selection = this.#createSelection();
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.editor.deleteCharBackward") && this.#query.length > 0) {
      this.#query = Array.from(this.#query).slice(0, -1).join("");
      this.#selection = this.#createSelection();
      return;
    }
    const text = textKeyInput(data);
    if (text !== undefined) {
      this.#query += safeTerminalText(text);
      this.#selection = this.#createSelection();
      return;
    }
    this.#selection.handleInput(data);
  }

  invalidate(): void {
    this.#selection.invalidate();
  }

  render(width: number, maximumLines: number): string[] {
    const lines = [`Search: ${this.#query}`];
    if (this.#visible.length === 0) {
      return [...lines, this.#theme.muted("No matching Todos.")].slice(0, maximumLines);
    }
    const selectedId = this.#selection.getSelectedItem()?.value;
    const selectedIndex = Math.max(
      0,
      this.#visible.findIndex((item) => item.id === selectedId),
    );
    const budget = Math.max(1, maximumLines - 1);
    let start = selectedIndex;
    let used = 2;
    while (start > 0) {
      const cost = this.#visible[start - 1]?.status === this.#visible[start]?.status ? 1 : 2;
      if (used + cost > budget) break;
      used += cost;
      start -= 1;
    }
    let status: string | undefined;
    for (const item of this.#visible.slice(start)) {
      if (lines.length >= maximumLines) break;
      if (item.status !== status && budget > 1) {
        // Do not leave a heading at the bottom without its first visible item.
        if (lines.length + 2 > maximumLines) break;
        lines.push(
          this.#theme.toolTitle(
            item.status === "pending"
              ? "Pending"
              : item.status === "in_progress"
                ? "In Progress"
                : "Completed",
          ),
        );
        status = item.status;
      }
      const selected = item.id === selectedId;
      const title = safeTerminalText(
        item.status === "in_progress" && item.activeForm !== undefined
          ? `${item.title} (${item.activeForm})`
          : item.title,
      );
      const description = `${item.status} · ${item.blocked ? "blocked" : "ready"} · revision ${item.itemRevision} · ${item.dependencyCount} dependencies`;
      const label = `${selected ? "> " : "  "}${title}`;
      lines.push(
        `${selected ? this.#theme.editor.selectList.selectedText(label) : label} ${this.#theme.muted(description)}`,
      );
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  #createSelection(): SelectList {
    const matching = fuzzyFilter(
      [...this.#items],
      this.#query,
      (item) => `${item.title} ${item.activeForm ?? ""} ${item.status} ${item.id}`,
    );
    this.#visible = ["pending", "in_progress", "completed"].flatMap((status) =>
      matching.filter((item) => item.status === status),
    );
    const selection = new SelectList(
      this.#visible.map((item) => ({ value: item.id, label: item.title })),
      8,
      this.#theme.editor.selectList,
    );
    selection.onCancel = this.#onCancel;
    selection.onSelect = (item) => this.#onSelect(item.value);
    return selection;
  }
}
