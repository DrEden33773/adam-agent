import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

export type ReloadResource = {
  readonly id: "instructions" | "mcp" | "skills";
  readonly label: string;
  readonly description: string;
};

export class ResourceReloadPicker implements Component {
  readonly #list: SearchableSelectList;
  readonly #resources: ReadonlyMap<string, ReloadResource>;
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly onClose: () => void;
    readonly onSelect: (resource: ReloadResource) => void;
    readonly resources: readonly ReloadResource[];
    readonly theme: AdamTuiTheme;
  }) {
    this.#theme = options.theme;
    this.#resources = new Map(options.resources.map((resource) => [resource.id, resource]));
    const items: SelectItem[] = options.resources.map((resource) => ({
      value: resource.id,
      label: resource.label,
      description: resource.description,
    }));
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText: `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
      })),
      maxVisible: 6,
      onCancel: options.onClose,
      onSelect: (item) => {
        const resource = this.#resources.get(item.value);
        if (resource !== undefined) {
          options.onSelect(resource);
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
      this.#theme.toolTitle("Reload project resources"),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("type search · Enter reload one authority · Esc close · Ctrl+Q exit"),
    ];
  }
}
