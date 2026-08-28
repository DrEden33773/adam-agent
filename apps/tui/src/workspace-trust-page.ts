import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class WorkspaceTrustPage implements Component {
  readonly #diagnostic: string | null;
  readonly #list: SelectList;
  readonly #mode: "manage" | "startup";
  readonly #projectId: string;
  readonly #projectLabel: string;
  readonly #status: "trusted" | "unavailable" | "untrusted";
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly diagnostic: { readonly code: string; readonly message: string } | null;
    readonly mode?: "manage" | "startup";
    readonly onChange: (trusted: boolean) => void;
    readonly onClose: () => void;
    readonly projectId: string;
    readonly projectLabel: string;
    readonly status: "trusted" | "unavailable" | "untrusted";
    readonly theme: AdamTuiTheme;
  }) {
    this.#diagnostic =
      options.diagnostic === null ? null : safeTerminalText(options.diagnostic.message);
    this.#mode = options.mode ?? "manage";
    this.#projectId = safeTerminalText(options.projectId);
    this.#projectLabel = safeTerminalText(options.projectLabel);
    this.#status = options.status;
    this.#theme = options.theme;
    const action = options.status === "trusted" ? "revoke" : "grant";
    const items: SelectItem[] =
      this.#mode === "startup"
        ? [
            {
              value: "cancel",
              label: options.theme.deny("No — Exit Adam"),
              description: "Leave this exact project untrusted and close the TUI",
            },
            ...(options.status === "unavailable"
              ? []
              : [
                  {
                    value: "grant",
                    label: options.theme.allow("Yes — Trust and continue"),
                    description: "Persist owner-local trust for this exact project",
                  },
                ]),
          ]
        : [
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
    this.#list = new SelectList(items, 2, options.theme.editor.selectList);
    this.#list.onCancel = options.onClose;
    this.#list.onSelect = (item) => {
      if (item.value === "cancel") {
        options.onClose();
      } else {
        options.onChange(item.value === "grant");
      }
    };
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
    if (this.#mode === "startup") {
      if (width < 60) {
        return [
          this.#theme.danger("Workspace trust required"),
          this.#theme.muted(`${this.#projectLabel} · ${this.#status}`),
          "Trust this exact project?",
          ...this.#list.render(width),
          ...(this.#diagnostic === null ? [] : [this.#theme.muted(this.#diagnostic)]),
          ...(this.#notice === null ? [] : [this.#theme.muted(this.#notice)]),
          this.#theme.muted("Enter confirm · ↑/↓ select · Esc No"),
        ];
      }
      return [
        this.#theme.danger("Workspace trust required"),
        this.#theme.muted(`${this.#projectLabel} · ${this.#status}`),
        this.#theme.muted(this.#projectId),
        "",
        "Trust this exact project before starting Adam?",
        this.#theme.muted(
          "Trust admits mutable repository instructions, project Skills, and project MCP configuration.",
        ),
        this.#theme.muted(
          "It does not allow tools, MCP servers, extensions, credentials, model targets, or effects.",
        ),
        "",
        ...this.#list.render(width),
        ...(this.#diagnostic === null ? [] : ["", this.#theme.muted(this.#diagnostic)]),
        ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
        "",
        this.#theme.muted("Enter confirm · ↑/↓ select · Esc No · Ctrl+Q exit"),
      ];
    }
    return [
      this.#theme.toolTitle("Workspace trust"),
      this.#theme.muted(`${this.#projectLabel} · ${this.#status}`),
      this.#theme.muted(this.#projectId),
      "",
      ...this.#list.render(width),
      ...(this.#diagnostic === null ? [] : ["", this.#theme.muted(this.#diagnostic)]),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("Enter confirm selected · Esc cancel · Ctrl+Q exit"),
    ];
  }
}
