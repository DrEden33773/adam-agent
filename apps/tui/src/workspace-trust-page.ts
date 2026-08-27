import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

export class WorkspaceTrustPage implements Component {
  readonly #diagnostic: string | null;
  readonly #list: SearchableSelectList;
  readonly #projectId: string;
  readonly #projectLabel: string;
  readonly #status: "trusted" | "unavailable" | "untrusted";
  readonly #theme: AdamTuiTheme;

  constructor(options: {
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
    readonly onChange: (trusted: boolean) => void;
    readonly onClose: () => void;
    readonly projectId: string;
    readonly projectLabel: string;
    readonly status: "trusted" | "unavailable" | "untrusted";
    readonly theme: AdamTuiTheme;
  }) {
    this.#diagnostic =
      options.diagnostic === null ? null : safeTerminalText(options.diagnostic.message);
    this.#projectId = safeTerminalText(options.projectId);
    this.#projectLabel = safeTerminalText(options.projectLabel);
    this.#status = options.status;
    this.#theme = options.theme;
    const action = options.status === "trusted" ? "revoke" : "grant";
    const items: SelectItem[] = [
      {
        value: "cancel",
        label: "Cancel",
        description: "Keep the current owner-local trust decision unchanged",
      },
      ...(options.status === "unavailable"
        ? []
        : [
            {
              value: action,
              label: action === "grant" ? "Trust this exact project" : "Revoke project trust",
              description:
                action === "grant"
                  ? "Permit new mutable project context to be considered"
                  : "Block later project reload and MCP use after causal shutdown",
            },
          ]),
    ];
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText: `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
      })),
      maxVisible: 2,
      onCancel: options.onClose,
      onSelect(item) {
        if (item.value === "cancel") {
          options.onClose();
        } else {
          options.onChange(item.value === "grant");
        }
      },
      theme: options.theme.editor.selectList,
    });
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Workspace trust"),
      this.#theme.muted(`${this.#projectLabel} · ${this.#status}`),
      this.#theme.muted(this.#projectId),
      "",
      ...this.#list.render(width),
      ...(this.#diagnostic === null ? [] : ["", this.#theme.muted(this.#diagnostic)]),
      "",
      this.#theme.muted("Enter confirm selected · Esc cancel · Ctrl+Q exit"),
    ];
  }
}
