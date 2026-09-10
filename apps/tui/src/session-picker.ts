import type {
  SessionHistoryDiagnosticsDisplay,
  SessionSummary,
  SessionSummaryPage,
} from "@adam-agent/presentation";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { textKeyInput } from "./text-key-input.js";
import type { AdamTuiTheme } from "./theme.js";

type SessionPickerItem =
  | { readonly kind: "new_session" }
  | { readonly kind: "session"; readonly session: SessionSummary }
  | { readonly kind: "invalid_sessions" }
  | { readonly kind: "load_more" };

export type SessionPickerCatalog = {
  readonly sessions: readonly SessionSummary[];
  readonly hasMore: boolean;
  readonly diagnostics?: SessionHistoryDiagnosticsDisplay;
} & Pick<SessionSummaryPage, "loading" | "health" | "error" | "view" | "visibility">;

export class SessionPicker implements Component {
  #catalogView: "active" | "archived";
  readonly #viewSelections = new Map<"active" | "archived", string>();
  #visibility: SessionSummaryPage["visibility"];
  readonly #onView: ((view: "active" | "archived") => void) | undefined;
  readonly #onArchive:
    | ((session: SessionSummary, visibility: "active" | "archived", revision: number) => void)
    | undefined;
  readonly #onUndo: (() => void) | undefined;
  #hasMore: boolean;
  #diagnostics: SessionHistoryDiagnosticsDisplay;
  readonly #onClose: () => void;
  readonly #onLoadMore: () => void;
  readonly #onNewSession: () => void;
  readonly #onRename: (session: SessionSummary) => void;
  readonly #onSelect: (session: SessionSummary) => void;
  #sessions: readonly SessionSummary[];
  readonly #theme: AdamTuiTheme;
  #loading: SessionSummaryPage["loading"];
  #health: SessionSummaryPage["health"];
  #error: SessionSummaryPage["error"];
  #interacted = false;
  #notice: string | null = null;
  #query = "";
  #selectedIndex = 0;
  #diagnosticIndex = 0;
  #view: "sessions" | "diagnostics" = "sessions";

  constructor(
    options: SessionPickerCatalog & {
      readonly theme: AdamTuiTheme;
      readonly onView?: (view: "active" | "archived") => void;
      readonly onArchive?: (
        session: SessionSummary,
        visibility: "active" | "archived",
        revision: number,
      ) => void;
      readonly onUndo?: () => void;
      readonly onNewSession: () => void;
      readonly onLoadMore: () => void;
      readonly onRename: (session: SessionSummary) => void;
      readonly onSelect: (session: SessionSummary) => void;
      readonly onClose: () => void;
    },
  ) {
    this.#catalogView = options.view ?? "active";
    this.#visibility = options.visibility;
    this.#onView = options.onView;
    this.#onArchive = options.onArchive;
    this.#onUndo = options.onUndo;
    this.#onNewSession = options.onNewSession;
    this.#onClose = options.onClose;
    this.#onLoadMore = options.onLoadMore;
    this.#onRename = options.onRename;
    this.#onSelect = options.onSelect;
    this.#sessions = options.sessions;
    this.#hasMore = options.hasMore;
    this.#diagnostics = options.diagnostics ?? {
      items: [],
      totalCount: 0,
      truncated: false,
    };
    this.#theme = options.theme;
    this.#loading = options.loading;
    this.#health = options.health;
    this.#error = options.error;
  }

  get hasInteracted(): boolean {
    return this.#interacted;
  }

  setCatalog(catalog: SessionPickerCatalog): void {
    let selectedKey = itemKey(this.#items()[this.#selectedIndex]);
    const destination = catalog.view ?? "active";
    if (destination !== this.#catalogView) {
      if (selectedKey !== undefined) this.#viewSelections.set(this.#catalogView, selectedKey);
      selectedKey = this.#viewSelections.get(destination) ?? selectedKey;
    }
    const diagnosticId = this.#diagnostics.items[this.#diagnosticIndex]?.sessionId;
    this.#catalogView = catalog.view ?? "active";
    this.#visibility = catalog.visibility;
    this.#sessions = catalog.sessions;
    this.#hasMore = catalog.hasMore;
    this.#diagnostics = catalog.diagnostics ?? { items: [], totalCount: 0, truncated: false };
    this.#loading = catalog.loading;
    this.#health = catalog.health;
    this.#error = catalog.error;
    const items = this.#items();
    const selectedIndex = items.findIndex((item) => itemKey(item) === selectedKey);
    this.#selectedIndex =
      selectedIndex < 0 ? Math.min(this.#selectedIndex, items.length - 1) : selectedIndex;
    const diagnosticIndex = this.#diagnostics.items.findIndex(
      (item) => item.sessionId === diagnosticId,
    );
    this.#diagnosticIndex =
      diagnosticIndex < 0
        ? Math.min(this.#diagnosticIndex, Math.max(0, this.#diagnostics.items.length - 1))
        : diagnosticIndex;
  }

  rememberSession(sessionId: string, view: "active" | "archived"): void {
    const key = `session:${sessionId}`;
    this.#viewSelections.set(view, key);
    if (view === this.#catalogView) {
      const index = this.#items().findIndex((item) => itemKey(item) === key);
      if (index >= 0) this.#selectedIndex = index;
    }
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    this.#interacted = true;
    const keybindings = getKeybindings();
    if (this.#view === "diagnostics") {
      if (keybindings.matches(data, "tui.select.up")) {
        this.#diagnosticIndex =
          this.#diagnosticIndex === 0
            ? Math.max(0, this.#diagnostics.items.length - 1)
            : this.#diagnosticIndex - 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.down")) {
        this.#diagnosticIndex =
          this.#diagnosticIndex === this.#diagnostics.items.length - 1
            ? 0
            : this.#diagnosticIndex + 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        this.#view = "sessions";
      }
      return;
    }
    if (matchesKey(data, "tab")) {
      this.#onView?.(this.#catalogView === "active" ? "archived" : "active");
      return;
    }
    if (matchesKey(data, "ctrl+a")) {
      const selected = this.#items()[this.#selectedIndex];
      if (selected?.kind === "session" && this.#visibility?.status === "ready")
        this.#onArchive?.(
          selected.session,
          this.#catalogView === "active" ? "archived" : "active",
          this.#visibility.revision,
        );
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.#onUndo?.();
      return;
    }
    if (adamCommandRegistry.matchesInput(data, "rename_session")) {
      const selected = this.#items()[this.#selectedIndex];
      if (selected?.kind === "session") {
        this.#onRename(selected.session);
      }
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward") && this.#query.length > 0) {
      this.#query = Array.from(this.#query).slice(0, -1).join("");
      this.#selectFirstSearchResult();
      return;
    }
    const text = textKeyInput(data);
    if (text !== undefined) {
      this.#query += safeTerminalText(text);
      this.#selectFirstSearchResult();
      return;
    }
    const items = this.#items();
    if (keybindings.matches(data, "tui.select.up")) {
      this.#selectedIndex = this.#selectedIndex === 0 ? items.length - 1 : this.#selectedIndex - 1;
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.#selectedIndex = this.#selectedIndex === items.length - 1 ? 0 : this.#selectedIndex + 1;
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = items[this.#selectedIndex];
      if (selected?.kind === "new_session") {
        this.#onNewSession();
      } else if (selected?.kind === "load_more" && !this.#loading) {
        this.#onLoadMore();
      } else if (selected?.kind === "invalid_sessions") {
        this.#diagnosticIndex = 0;
        this.#view = "diagnostics";
      } else if (selected?.kind === "session") {
        this.#onSelect(selected.session);
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.#onClose();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.#view === "diagnostics") {
      return this.#renderDiagnostics(width);
    }
    const items = this.#items();
    const resultItems = items.slice(1);
    const selectedResultIndex = this.#selectedIndex - 1;
    const startIndex = Math.max(
      0,
      Math.min(selectedResultIndex - 3, Math.max(0, resultItems.length - 8)),
    );
    const visibleItems = resultItems.slice(startIndex, startIndex + 8);
    return [
      this.#theme.toolTitle("Select a project session"),
      this.#theme.muted(
        this.#visibility?.status === "unknown"
          ? "Recovery view · archive state unknown"
          : this.#catalogView === "active"
            ? "[Active] · Archived"
            : "Active · [Archived]",
      ),
      ...(this.#visibility?.status === "unknown"
        ? wrapTextWithAnsi(this.#theme.muted(this.#visibility.message), Math.max(1, width))
        : []),
      this.#renderNewSession(width),
      `Search: ${safeTerminalText(this.#query)}`,
      ...this.#renderCatalogStatus(width),
      ...(this.#diagnostics.totalCount === 0
        ? []
        : [
            "",
            ...wrapTextWithAnsi(this.#theme.muted(this.#diagnosticSummary()), Math.max(1, width)),
          ]),
      "",
      ...(visibleItems.length === 0
        ? [
            this.#theme.editor.selectList.noMatch(
              this.#loading
                ? "  Loading sessions…"
                : this.#error === undefined
                  ? "  No matching sessions"
                  : "  Session list unavailable",
            ),
          ]
        : visibleItems.map((item, index) =>
            this.#renderResultItem(item, startIndex + index === selectedResultIndex, width),
          )),
      ...(startIndex > 0 || startIndex + visibleItems.length < resultItems.length
        ? [
            this.#theme.editor.selectList.scrollInfo(
              `  (${Math.max(1, selectedResultIndex + 1)}/${resultItems.length})`,
            ),
          ]
        : []),
      ...(this.#notice === null
        ? []
        : ["", ...wrapTextWithAnsi(this.#theme.muted(this.#notice), Math.max(1, width))]),
      "",
      ...wrapTextWithAnsi(
        this.#theme.muted(
          `Tab Active/Archived · Ctrl+A ${this.#catalogView === "active" ? "archive" : "unarchive"} · Ctrl+U undo`,
        ),
        Math.max(1, width),
      ),
      ...wrapTextWithAnsi(
        this.#theme.muted(
          `Enter open · ${adamCommandRegistry.keybinding("rename_session").keys} rename · type search · ↑/↓ move · Esc close · Ctrl+Q exit`,
        ),
        Math.max(1, width),
      ),
    ];
  }

  #items(): readonly SessionPickerItem[] {
    const sessions = fuzzyFilter(
      [...this.#sessions],
      this.#query,
      (session) =>
        `${session.naming.displayLabel} ${session.targetId} ${session.status} ${session.id}`,
    );
    return [
      { kind: "new_session" },
      ...sessions.map((session) => ({ kind: "session" as const, session })),
      ...(this.#diagnostics.totalCount === 0 ? [] : [{ kind: "invalid_sessions" as const }]),
      ...(this.#hasMore ? [{ kind: "load_more" as const }] : []),
    ];
  }

  #selectFirstSearchResult(): void {
    const items = this.#items();
    this.#selectedIndex = items[1]?.kind === "session" ? 1 : 0;
  }

  #renderNewSession(width: number): string {
    const selected = this.#selectedIndex === 0;
    const content = renderColumns("New Session", "Choose an exact target", selected, width);
    const padded = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
    return selected ? this.#theme.inverseSelection(padded) : padded;
  }

  #renderResultItem(item: SessionPickerItem, selected: boolean, width: number): string {
    const content =
      item.kind === "session"
        ? renderColumns(
            safeTerminalText(item.session.naming.displayLabel),
            safeTerminalText(`${item.session.targetId} · ${item.session.status}`),
            selected,
            width,
          )
        : item.kind === "invalid_sessions"
          ? renderColumns(
              "Invalid sessions",
              `${this.#diagnostics.totalCount} retained · Enter review`,
              selected,
              width,
            )
          : renderColumns(
              this.#loading ? "Loading more…" : "Load More",
              "Use the opaque catalog cursor",
              selected,
              width,
            );
    return selected ? this.#theme.editor.selectList.selectedText(content) : content;
  }

  #renderCatalogStatus(width: number): string[] {
    const health = this.#health;
    const progress =
      health === undefined
        ? undefined
        : health.status === "not_started"
          ? "History check not started."
          : health.status === "complete"
            ? `History check complete: ${health.checked} sessions.`
            : health.status === "failed"
              ? `History check failed after ${health.checked} sessions.`
              : `Checking history: ${health.checked}${health.total === null ? "" : ` / ${health.total}`} sessions.`;
    return [
      ...(this.#loading && this.#sessions.length > 0 ? ["Loading sessions…"] : []),
      ...(progress === undefined ? [] : [progress]),
      ...(this.#error === undefined ? [] : [safeTerminalText(this.#error.message)]),
    ].flatMap((line) => wrapTextWithAnsi(this.#theme.muted(line), Math.max(1, width)));
  }

  #diagnosticSummary(): string {
    return this.#diagnostics.totalCount === 1
      ? "Skipped 1 invalid session; its local data was retained. Open /resume to review it."
      : `Skipped ${this.#diagnostics.totalCount} invalid sessions; their local data was retained. Open /resume to review them.`;
  }

  #renderDiagnostics(width: number): string[] {
    const items = this.#diagnostics.items;
    const startIndex = Math.max(
      0,
      Math.min(this.#diagnosticIndex - 2, Math.max(0, items.length - 5)),
    );
    const visibleItems = items.slice(startIndex, startIndex + 5);
    return [
      this.#theme.toolTitle("Invalid sessions"),
      ...this.#renderCatalogStatus(width),
      `${this.#diagnostics.totalCount} retained${this.#diagnostics.truncated ? " · first 100 shown" : ""}`,
      "",
      ...visibleItems.flatMap((item, index) => {
        const selected = startIndex + index === this.#diagnosticIndex;
        const prefix = selected ? "> " : "  ";
        const id = prefix + truncateToWidth(item.sessionId, Math.max(0, width - 2), "");
        const message = wrapTextWithAnsi(
          this.#theme.muted(safeTerminalText(item.message)),
          Math.max(1, width - 2),
        ).map((line) => `  ${line}`);
        return [selected ? this.#theme.editor.selectList.selectedText(id) : id, ...message];
      }),
      ...(startIndex > 0 || startIndex + visibleItems.length < items.length
        ? [
            this.#theme.editor.selectList.scrollInfo(
              `  (${Math.max(1, this.#diagnosticIndex + 1)}/${items.length})`,
            ),
          ]
        : []),
      "",
      this.#theme.muted("↑/↓ move · Esc back · Ctrl+Q exit"),
    ];
  }
}

function itemKey(item: SessionPickerItem | undefined): string | undefined {
  return item?.kind === "session" ? `session:${item.session.id}` : item?.kind;
}

function renderColumns(
  label: string,
  description: string,
  selected: boolean,
  width: number,
): string {
  const prefix = selected ? "> " : "  ";
  const available = Math.max(0, width - visibleWidth(prefix));
  if (width <= 40) {
    return prefix + truncateToWidth(label, available, "");
  }
  const primaryWidth = Math.max(1, Math.min(32, available - 1));
  const labelText = truncateToWidth(label, Math.max(1, primaryWidth - 2), "");
  const spacing = " ".repeat(Math.max(1, primaryWidth - visibleWidth(labelText)));
  const descriptionText = truncateToWidth(
    description,
    Math.max(0, width - visibleWidth(prefix) - visibleWidth(labelText) - spacing.length),
    "",
  );
  return prefix + labelText + spacing + descriptionText;
}
