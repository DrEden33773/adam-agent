import type { ProjectPathCatalogDisplay } from "@adam-agent/presentation";
import { type Component, Key, matchesKey, SelectList } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class ProjectPathPicker implements Component {
  readonly #catalog: ProjectPathCatalogDisplay;
  readonly #onClose: () => void;
  readonly #onSelect: (path: string) => void;
  readonly #theme: AdamTuiTheme;
  #filter = "";
  #list: SelectList;

  constructor(options: {
    readonly catalog: ProjectPathCatalogDisplay;
    readonly onClose: () => void;
    readonly onSelect: (path: string) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#catalog = options.catalog;
    this.#onClose = options.onClose;
    this.#onSelect = options.onSelect;
    this.#theme = options.theme;
    this.#list = this.#createList();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#onClose();
      return;
    }
    if (data === "\u007f" || data === "\b") {
      this.#filter = this.#filter.slice(0, -1);
      this.#list = this.#createList();
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\u007f") {
      this.#filter += data;
      this.#list = this.#createList();
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Select a project path"),
      this.#theme.muted(`Filter: ${safeTerminalText(this.#filter)}`),
      "",
      ...this.#list.render(width),
      "",
      this.#theme.muted(
        `${this.#catalog.omittedCount} omitted · Enter insert · type to fuzzy-filter · Esc close`,
      ),
    ];
  }

  #createList(): SelectList {
    const items = this.#catalog.items
      .filter((path) => fuzzyMatch(path, this.#filter))
      .map((path) => ({ value: path, label: safeTerminalText(path) }));
    const list = new SelectList(items, 10, this.#theme.editor.selectList, {
      maxPrimaryColumnWidth: 64,
    });
    list.onSelect = (item) => this.#onSelect(item.value);
    list.onCancel = this.#onClose;
    return list;
  }
}

function fuzzyMatch(candidate: string, query: string): boolean {
  const normalizedCandidate = candidate.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  let position = 0;
  for (const character of normalizedQuery) {
    position = normalizedCandidate.indexOf(character, position);
    if (position < 0) {
      return false;
    }
    position += character.length;
  }
  return true;
}
