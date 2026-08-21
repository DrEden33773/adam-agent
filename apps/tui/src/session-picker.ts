import type { SessionSummary } from "@adam-agent/presentation";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

const newSessionValue = "new-session";
const loadMoreValue = "load-more";

export class SessionPicker implements Component {
  readonly #list: SelectList;
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
    readonly hasMore: boolean;
  }) {
    this.#onNewSession = options.onNewSession;
    this.#onRename = options.onRename;
    this.#onSelect = options.onSelect;
    this.#sessions = new Map(options.sessions.map((session) => [session.id, session]));
    this.#theme = options.theme;
    const items: SelectItem[] = [
      ...options.sessions.map((session) => ({
        value: session.id,
        label: safeTerminalText(session.naming.displayLabel),
        description: safeTerminalText(`${session.targetId} · ${session.status}`),
      })),
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
    this.#list = new SelectList(items, 8, options.theme.editor.selectList);
    this.#list.onSelect = (item) => {
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
    };
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (data === "r") {
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
      this.#theme.muted("Enter open · r rename · ↑/↓ move · Ctrl+Q exit"),
    ];
  }
}
