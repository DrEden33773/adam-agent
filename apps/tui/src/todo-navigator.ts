import type {
  ActiveSessionDisplay,
  TodoEntityResource,
  TodoPageResource,
} from "@adam-agent/presentation";
import {
  type Component,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { type SearchableSelectItem, SearchableSelectList } from "./searchable-select-list.js";
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
  readonly #summary: TodoSummary;
  readonly #theme: AdamTuiTheme;
  #cursor: string | null = null;
  #compactCollapsed: boolean;
  #detail: TodoEntityResource | null = null;
  #generation = 0;
  #list: SearchableSelectList;
  #notice: string | null = null;
  #page: TodoPageResource;
  #previousCursors: readonly (string | null)[] = [];

  constructor(options: {
    readonly initialPage: TodoPageResource;
    readonly maximumContentHeight?: () => number;
    readonly compactCollapsed?: boolean;
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
    if (matchesKey(data, "c") && this.#onCompactCollapseChange !== undefined) {
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
        safeTerminalText(item.title),
        `${item.status} · item revision ${item.itemRevision} · created ${item.createdOrdinal}`,
        `ID ${item.id}`,
        "",
        ...(item.details === undefined
          ? [this.#theme.muted("No details.")]
          : safeTerminalText(item.details).split("\n")),
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
    this.#list.setMaximumVisible(Math.min(8, Math.max(1, listHeight - 3)));
    const listLines = this.#list.render(width, listHeight);
    return [
      this.#theme.toolTitle(`Todos · revision ${this.#summary.storeRevision}`),
      `${counts.pending} pending · ${counts.inProgress} in progress · ${counts.completed} completed · ${this.#summary.blockedCount} blocked`,
      this.#theme.muted("Enter detail · type filter"),
      this.#theme.muted(
        `Esc close · c ${this.#compactCollapsed ? "expand" : "collapse"} compact · PgUp/PgDn · Ctrl+Q`,
      ),
      ...listLines,
      ...noticeLines,
    ]
      .slice(0, maximumContentHeight)
      .map((line) => truncateToWidth(line, width));
  }

  #createList(page: TodoPageResource): SearchableSelectList {
    const items: SearchableSelectItem[] = page.items.map((item) => ({
      item: {
        value: item.id,
        label: safeTerminalText(item.title),
        description: `${item.status} · ${item.blocked ? "blocked" : "ready"} · revision ${item.itemRevision}`,
      },
      searchText: `${item.title} ${item.status} ${item.id}`,
    }));
    return new SearchableSelectList({
      items,
      maxVisible: 8,
      onCancel: () => {
        this.cancelPendingRead();
        this.#onClose();
      },
      onSelect: (selected) => this.#loadDetail(selected.value),
      theme: this.#theme.editor.selectList,
    });
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
