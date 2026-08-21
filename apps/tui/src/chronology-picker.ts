import type { BranchSourceBoundary, TranscriptItem } from "@adam-agent/presentation";
import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

const loadOlderValue = "load-older-chronology";

export type ChronologyBoundary = {
  readonly boundary: BranchSourceBoundary;
  readonly prompt: string | null;
};

export function completeChronologyBoundaries(
  items: readonly TranscriptItem[],
): readonly ChronologyBoundary[] {
  const boundaries: ChronologyBoundary[] = [];
  const seen = new Set<string>();
  let prompt: string | null = null;
  for (const item of items) {
    if (item.type === "user_message") {
      prompt = item.text;
    }
    if (item.branchBoundary === null) {
      continue;
    }
    const key = `${item.branchBoundary.sessionId}:${item.branchBoundary.sequence}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    boundaries.push({ boundary: item.branchBoundary, prompt });
  }
  return boundaries;
}

export class ChronologyPicker implements Component {
  readonly #boundaries: ReadonlyMap<string, ChronologyBoundary>;
  readonly #list: SearchableSelectList;
  readonly #mode: "fork" | "read_only";
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly boundaries: readonly ChronologyBoundary[];
    readonly hasOlder: boolean;
    readonly mode: "fork" | "read_only";
    readonly onClose: () => void;
    readonly onLoadOlder: () => void;
    readonly onSelect: (boundary: ChronologyBoundary) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#mode = options.mode;
    this.#theme = options.theme;
    this.#boundaries = new Map(
      options.boundaries.map((boundary) => [boundaryKey(boundary.boundary), boundary]),
    );
    const items: SelectItem[] = [
      ...options.boundaries.map((boundary) => ({
        value: boundaryKey(boundary.boundary),
        label: safeTerminalText(boundary.prompt ?? "Complete run boundary"),
        description: safeTerminalText(
          `${boundary.boundary.sessionId.slice(0, 8)}:${boundary.boundary.sequence} · complete boundary`,
        ),
      })),
      ...(options.hasOlder
        ? [
            {
              value: loadOlderValue,
              label: "Load Older",
              description: "Use the opaque active-chronology cursor",
            },
          ]
        : []),
    ];
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText:
          item.value === loadOlderValue
            ? ""
            : `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
        alwaysVisible: item.value === loadOlderValue,
      })),
      maxVisible: 8,
      onCancel: options.onClose,
      onSelect: (item) => {
        if (item.value === loadOlderValue) {
          options.onLoadOlder();
          return;
        }
        const boundary = this.#boundaries.get(item.value);
        if (boundary !== undefined && this.#mode === "fork") {
          options.onSelect(boundary);
        }
      },
      theme: options.theme.editor.selectList,
    });
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle(
        this.#mode === "read_only" ? "Active chronology · read only" : "Fork from a boundary",
      ),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted(
        this.#mode === "read_only"
          ? "type search · ↑/↓ inspect complete boundary · Enter load older · Esc close · Ctrl+Q exit"
          : "type search · Enter fork or load older · ↑/↓ move · Esc close · Ctrl+Q exit",
      ),
    ];
  }
}

function boundaryKey(boundary: BranchSourceBoundary): string {
  return `${boundary.sessionId}:${boundary.sequence}`;
}
