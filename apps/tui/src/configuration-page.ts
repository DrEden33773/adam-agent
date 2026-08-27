import type { TargetDisplay, UserModelPolicyDisplay } from "@adam-agent/presentation";
import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

export type ConfigurationField =
  | "contextWindowTokens"
  | "maximumOutputTokens"
  | "automaticCompactionWindowTokens";

export class ConfigurationPage implements Component {
  readonly #fields: ReadonlyMap<string, ConfigurationField>;
  readonly #list: SearchableSelectList;
  readonly #notice: string | null;
  readonly #targetId: string;
  readonly #theme: AdamTuiTheme;

  constructor(options: {
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
    readonly modelPolicy: UserModelPolicyDisplay;
    readonly onClose: () => void;
    readonly onReset: (field: ConfigurationField) => void;
    readonly target: TargetDisplay | undefined;
    readonly theme: AdamTuiTheme;
  }) {
    this.#theme = options.theme;
    this.#targetId = safeTerminalText(options.target?.targetId ?? "no available target");
    this.#notice =
      options.diagnostic === null
        ? options.target?.context?.diagnostic === null || options.target?.context === undefined
          ? null
          : safeTerminalText(options.target.context.diagnostic.message)
        : safeTerminalText(options.diagnostic.message);
    const fields: readonly {
      readonly field: ConfigurationField;
      readonly label: string;
      readonly saved: number | null;
      readonly official: number | undefined;
      readonly effective: number | undefined;
      readonly source: "default" | "user" | undefined;
    }[] = [
      {
        field: "contextWindowTokens",
        label: "Context window",
        saved: options.modelPolicy.contextWindowTokens,
        official: options.target?.context?.official.contextWindowTokens,
        effective: options.target?.context?.effective?.contextWindowTokens,
        source: options.target?.context?.source.contextWindowTokens,
      },
      {
        field: "maximumOutputTokens",
        label: "Output limit",
        saved: options.modelPolicy.maximumOutputTokens,
        official: options.target?.context?.official.maximumOutputTokens,
        effective: options.target?.context?.effective?.maximumOutputTokens,
        source: options.target?.context?.source.maximumOutputTokens,
      },
      {
        field: "automaticCompactionWindowTokens",
        label: "Compaction window",
        saved: options.modelPolicy.automaticCompactionWindowTokens,
        official: options.target?.context?.official.compactAtTokens,
        effective: options.target?.context?.effective?.compactAtTokens,
        source: options.target?.context?.source.compactAtTokens,
      },
    ];
    this.#fields = new Map(fields.map((field) => [field.field, field.field]));
    const items: SelectItem[] = fields.map((field) => ({
      value: field.field,
      label: field.label,
      description: `saved ${tokenValue(field.saved)} · official ${tokenValue(field.official)} · effective ${tokenValue(field.effective)} · ${field.source ?? "unavailable"}`,
    }));
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText: `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
      })),
      maxVisible: 3,
      onCancel: options.onClose,
      onSelect: (item) => {
        const field = this.#fields.get(item.value);
        if (field !== undefined) {
          options.onReset(field);
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
      this.#theme.toolTitle("User model configuration"),
      this.#theme.muted(`New-session target · ${this.#targetId}`),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("Enter reset selected to default · Esc close · Ctrl+Q exit"),
      this.#theme.muted("Set values with /config context|output|compaction <tokens|default>"),
    ];
  }
}

function tokenValue(value: number | null | undefined): string {
  return value === null ? "default" : value === undefined ? "unavailable" : `${value} tokens`;
}
