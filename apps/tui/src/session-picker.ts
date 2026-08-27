import type { SessionSummary } from "@adam-agent/presentation";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type SessionPickerItem =
  | { readonly kind: "new_session" }
  | { readonly kind: "session"; readonly session: SessionSummary }
  | { readonly kind: "load_more" };

export class SessionPicker implements Component {
  readonly #hasMore: boolean;
  readonly #onClose: () => void;
  readonly #onLoadMore: () => void;
  readonly #onNewSession: () => void;
  readonly #onRename: (session: SessionSummary) => void;
  readonly #onSelect: (session: SessionSummary) => void;
  readonly #sessions: readonly SessionSummary[];
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;
  #query = "";
  #selectedIndex = 0;

  constructor(options: {
    readonly sessions: readonly SessionSummary[];
    readonly theme: AdamTuiTheme;
    readonly onNewSession: () => void;
    readonly onLoadMore: () => void;
    readonly onRename: (session: SessionSummary) => void;
    readonly onSelect: (session: SessionSummary) => void;
    readonly onClose: () => void;
    readonly hasMore: boolean;
  }) {
    this.#onNewSession = options.onNewSession;
    this.#onClose = options.onClose;
    this.#onLoadMore = options.onLoadMore;
    this.#onRename = options.onRename;
    this.#onSelect = options.onSelect;
    this.#sessions = options.sessions;
    this.#hasMore = options.hasMore;
    this.#theme = options.theme;
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (adamCommandRegistry.matchesInput(data, "rename_session")) {
      const selected = this.#items()[this.#selectedIndex];
      if (selected?.kind === "session") {
        this.#onRename(selected.session);
      }
      return;
    }
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.editor.deleteCharBackward") && this.#query.length > 0) {
      this.#query = Array.from(this.#query).slice(0, -1).join("");
      this.#selectFirstSearchResult();
      return;
    }
    if (isSearchText(data)) {
      this.#query += safeTerminalText(data);
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
      } else if (selected?.kind === "load_more") {
        this.#onLoadMore();
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
      this.#renderNewSession(width),
      `Search: ${safeTerminalText(this.#query)}`,
      "",
      ...(visibleItems.length === 0
        ? [this.#theme.editor.selectList.noMatch("  No matching sessions")]
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
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted(
        `Enter open · ${adamCommandRegistry.keybinding("rename_session").keys} rename · type search · ↑/↓ move · Esc close · Ctrl+Q exit`,
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
        : renderColumns("Load More", "Use the opaque catalog cursor", selected, width);
    return selected ? this.#theme.editor.selectList.selectedText(content) : content;
  }
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

function isSearchText(data: string): boolean {
  return data.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(data);
}
