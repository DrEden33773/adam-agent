import type { SessionSummary } from "@adam-agent/presentation";
import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

const newSessionValue = "new-session";
const loadMoreValue = "load-more";

export class SessionPicker implements Component {
  readonly #list: SearchableSelectList;
  readonly #onNewSession: () => void;
  readonly #onRename: (session: SessionSummary) => void;
  readonly #onSelect: (session: SessionSummary) => void;
  readonly #sessions: ReadonlyMap<string, SessionSummary>;
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

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
    this.#onRename = options.onRename;
    this.#onSelect = options.onSelect;
    this.#sessions = new Map(options.sessions.map((session) => [session.id, session]));
    this.#theme = options.theme;
    const sessionItems: SelectItem[] = options.sessions.map((session) => ({
      value: session.id,
      label: safeTerminalText(session.naming.displayLabel),
      description: safeTerminalText(`${session.targetId} · ${session.status}`),
    }));
    const items: SelectItem[] = [
      ...sessionItems,
      ...(options.hasMore
        ? [
            {
              value: loadMoreValue,
              label: "Load More",
              description: "Use the opaque catalog cursor",
            },
          ]
        : []),
      { value: newSessionValue, label: "New Session", description: "Choose an exact target" },
    ];
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText:
          item.value === newSessionValue || item.value === loadMoreValue
            ? ""
            : `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
        alwaysVisible: item.value === newSessionValue || item.value === loadMoreValue,
      })),
      maxVisible: 8,
      onCancel: options.onClose,
      onSelect: (item) => {
        if (item.value === newSessionValue) {
          this.#onNewSession();
          return;
        }
        if (item.value === loadMoreValue) {
          options.onLoadMore();
          return;
        }
        const session = this.#sessions.get(item.value);
        if (session !== undefined) {
          this.#onSelect(session);
        }
      },
      theme: options.theme.editor.selectList,
    });
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (adamCommandRegistry.matchesInput(data, "rename_session")) {
      const selected = this.#list.getSelectedItem();
      const session = selected === null ? undefined : this.#sessions.get(selected.value);
      if (session !== undefined) {
        this.#onRename(session);
      }
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Select a project session"),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted(
        `Enter open · ${adamCommandRegistry.keybinding("rename_session").keys} rename · type search · ↑/↓ move · Esc close · Ctrl+Q exit`,
      ),
    ];
  }
}
