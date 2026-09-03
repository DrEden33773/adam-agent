import {
  fuzzyFilter,
  getKeybindings,
  type SelectItem,
  SelectList,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { textKeyInput } from "./text-key-input.js";

export type SearchableSelectItem = {
  readonly item: SelectItem;
  readonly searchText: string;
  readonly alwaysVisible?: boolean;
};

export class SearchableSelectList {
  #items: readonly SearchableSelectItem[];
  #maxVisible: number;
  readonly #onCancel: () => void;
  readonly #onSelect: (item: SelectItem) => void;
  readonly #theme: SelectListTheme;
  #list: SelectList;
  #query = "";

  constructor(options: {
    readonly items: readonly SearchableSelectItem[];
    readonly maxVisible: number;
    readonly onCancel: () => void;
    readonly onSelect: (item: SelectItem) => void;
    readonly theme: SelectListTheme;
  }) {
    this.#items = options.items;
    this.#maxVisible = options.maxVisible;
    this.#onCancel = options.onCancel;
    this.#onSelect = options.onSelect;
    this.#theme = options.theme;
    this.#list = this.#createList();
  }

  getSelectedItem(): SelectItem | null {
    return this.#list.getSelectedItem();
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.editor.deleteCharBackward") && this.#query.length > 0) {
      this.#query = Array.from(this.#query).slice(0, -1).join("");
      this.#list = this.#createList();
      return;
    }
    const text = textKeyInput(data);
    if (text !== undefined) {
      this.#query += safeTerminalText(text);
      this.#list = this.#createList();
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  setItems(items: readonly SearchableSelectItem[]): void {
    const selectedValue = this.#list.getSelectedItem()?.value;
    this.#items = items;
    this.#rebuildList(selectedValue);
  }

  setMaximumVisible(maxVisible: number): void {
    const normalized = Math.max(1, Math.floor(maxVisible));
    if (normalized === this.#maxVisible) {
      return;
    }
    const selectedValue = this.#list.getSelectedItem()?.value;
    this.#maxVisible = normalized;
    this.#rebuildList(selectedValue);
  }

  render(width: number, maximumLines = Number.POSITIVE_INFINITY): string[] {
    const prefix =
      maximumLines <= 3
        ? [`Search: ${safeTerminalText(this.#query)}`]
        : [`Search: ${safeTerminalText(this.#query)}`, ""];
    return [...prefix, ...this.#list.render(width)].slice(0, maximumLines);
  }

  #createList(): SelectList {
    const items = this.#visibleItems();
    const list = new SelectList(items, this.#maxVisible, this.#theme);
    list.onCancel = this.#onCancel;
    list.onSelect = this.#onSelect;
    return list;
  }

  #rebuildList(selectedValue: string | undefined): void {
    this.#list = this.#createList();
    if (selectedValue === undefined) {
      return;
    }
    const selectedIndex = this.#visibleItems().findIndex(
      (candidate) => candidate.value === selectedValue,
    );
    if (selectedIndex >= 0) {
      this.#list.setSelectedIndex(selectedIndex);
    }
  }

  #visibleItems(): SelectItem[] {
    const searchable = this.#items.filter((item) => item.alwaysVisible !== true);
    const filtered = fuzzyFilter([...searchable], this.#query, (item) => item.searchText);
    return [
      ...filtered.map((candidate) => candidate.item),
      ...this.#items.filter((item) => item.alwaysVisible === true).map((item) => item.item),
    ];
  }
}
