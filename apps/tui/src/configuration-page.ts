import type { TargetDisplay, UserModelPolicyDisplay } from "@adam-agent/presentation";
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
  readonly #webNotice: string | null;

  constructor(options: {
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
    readonly modelPolicy: UserModelPolicyDisplay;
    readonly onClose: () => void;
    readonly onEditWebSearch: () => void;
    readonly onReset: (field: ConfigurationField) => void;
    readonly target: TargetDisplay | undefined;
    readonly theme: AdamTuiTheme;
    readonly webSearch:
      | {
          readonly status: "Configured" | "Invalid" | "Unconfigured" | "Unsafe";
          readonly endpoint: string | null;
          readonly syntheticDnsRange: string | null;
          readonly diagnostic: { readonly code: string; readonly message: string } | null;
        }
      | undefined;
  }) {
    this.#theme = options.theme;
    const syntheticDnsNotice =
      options.webSearch?.syntheticDnsRange === null ||
      options.webSearch?.syntheticDnsRange === undefined
        ? "Synthetic DNS: strict public addresses"
        : `Synthetic DNS: Owner-trusted TUN/proxy ${safeTerminalText(options.webSearch.syntheticDnsRange)} for HTTPS hostnames; final upstream IP is proxy-enforced`;
    this.#webNotice =
      options.webSearch === undefined
        ? null
        : options.webSearch.status === "Unconfigured"
          ? `Web Search is not configured. Fetch, open, and find remain available; configure an Owner-selected SearXNG endpoint to enable search for new sessions. ${syntheticDnsNotice}.`
          : (options.webSearch.diagnostic?.message ??
            (options.webSearch.endpoint === null
              ? `Web Search is ${options.webSearch.status}. ${syntheticDnsNotice}.`
              : `Web Search ${options.webSearch.status}: ${safeTerminalText(options.webSearch.endpoint)}. ${syntheticDnsNotice}.`));
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
    if (options.webSearch !== undefined) {
      items.push({
        value: "webSearch",
        label: "Web Search",
        description:
          options.webSearch.endpoint === null
            ? `${options.webSearch.status} · Fetch, open, and find remain available`
            : `${options.webSearch.status} · ${safeTerminalText(options.webSearch.endpoint)}`,
      });
    }
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText: `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
      })),
      maxVisible: 4,
      onCancel: options.onClose,
      onSelect: (item) => {
        const field = this.#fields.get(item.value);
        if (field !== undefined) {
          options.onReset(field);
        } else if (item.value === "webSearch") {
          options.onEditWebSearch();
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
      ...(this.#webNotice === null
        ? []
        : ["", ...wrapTextWithAnsi(this.#theme.muted(this.#webNotice), Math.max(1, width))]),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("Enter reset selected or edit Web Search · Esc close · Ctrl+Q exit"),
      this.#theme.muted(
        "Set model values with /config context|output|compaction; Web uses /config web or /config web-fake-ip.",
      ),
    ];
  }
}

function tokenValue(value: number | null | undefined): string {
  return value === null ? "default" : value === undefined ? "unavailable" : `${value} tokens`;
}
