import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import {
  type AdamCommandDefinition,
  type AdamHelpTopicDefinition,
  type AdamKeybindingDefinition,
  adamCommandRegistry,
} from "./command-registry.js";
import type { AdamTuiTheme } from "./theme.js";

export type HelpPage = "commands" | "editor" | "hotkeys" | "root" | "safety";

export class HelpNavigator implements Component, Focusable {
  focused = false;
  readonly #commands: readonly AdamCommandDefinition[];
  readonly #keybindings: readonly AdamKeybindingDefinition[];
  readonly #topics: readonly AdamHelpTopicDefinition[];
  readonly #onClose: () => void;
  readonly #theme: AdamTuiTheme;
  #page: HelpPage;
  #selectedTopicIndex = 0;

  constructor(options: {
    readonly commands: readonly AdamCommandDefinition[];
    readonly initialPage: HelpPage;
    readonly keybindings: readonly AdamKeybindingDefinition[];
    readonly onClose: () => void;
    readonly theme: AdamTuiTheme;
    readonly topics: readonly AdamHelpTopicDefinition[];
  }) {
    this.#commands = options.commands;
    this.#keybindings = options.keybindings;
    this.#onClose = options.onClose;
    this.#page = options.initialPage;
    this.#selectedTopicIndex = Math.max(
      0,
      options.topics.findIndex((topic) => topic.id === options.initialPage),
    );
    this.#theme = options.theme;
    this.#topics = options.topics;
  }

  handleInput(data: string): void {
    if (adamCommandRegistry.matchesInput(data, "back")) {
      if (this.#page === "root") {
        this.#onClose();
      } else {
        this.#page = "root";
      }
      return;
    }
    if (this.#page !== "root") {
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#selectedTopicIndex = Math.max(0, this.#selectedTopicIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#selectedTopicIndex = Math.min(
        Math.max(0, this.#topics.length - 1),
        this.#selectedTopicIndex + 1,
      );
      return;
    }
    if (adamCommandRegistry.matchesInput(data, "submit")) {
      const topic = this.#topics[this.#selectedTopicIndex];
      if (topic !== undefined) {
        this.#page = topic.id;
      }
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return helpContent(
      this.#page,
      this.#commands,
      this.#keybindings,
      this.#topics,
      this.#selectedTopicIndex,
      this.#theme,
    ).map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

function helpContent(
  page: HelpPage,
  commands: readonly AdamCommandDefinition[],
  keybindings: readonly AdamKeybindingDefinition[],
  topics: readonly AdamHelpTopicDefinition[],
  selectedTopicIndex: number,
  theme: AdamTuiTheme,
): string[] {
  if (page === "root") {
    return [
      theme.toolTitle("Adam Help"),
      "",
      ...topics.map(
        (topic, index) =>
          `${index === selectedTopicIndex ? ">" : " "} ${theme.keyword(topic.label)}  ${topic.summary}`,
      ),
      "",
      theme.muted("Esc close"),
    ];
  }
  if (page === "commands") {
    return [
      theme.toolTitle("Command Reference"),
      "",
      ...commands.map(
        (command) =>
          `${theme.keyword(command.usage)}${
            command.aliases.length === 0
              ? ""
              : ` · alias ${command.aliases.map((alias) => `/${alias}`).join(", ")}`
          } · ${command.availability === "always" ? "available during runs" : "idle only"} · ${command.summary}`,
      ),
      "",
      theme.muted("Esc back"),
    ];
  }
  if (page === "editor") {
    return [
      theme.toolTitle("Editor Hotkeys"),
      "",
      ...keybindings
        .filter((binding) => binding.section === "editor")
        .map((binding) => formatKeybinding(binding, theme)),
      "",
      theme.muted("Esc back"),
    ];
  }
  if (page === "safety") {
    return [
      theme.toolTitle("Safety and Trust"),
      "",
      "Default built-in policy:",
      "  Write/execute: exact-call approval.",
      "Built-in file tools:",
      "  Reject traversal/symlink escape.",
      "Shell/MCP: same-user authority.",
      "Extensions: trusted in-process code.",
      "Credentials: external plaintext.",
      "State/artifacts: owner-only local.",
      "No OS/process/network sandbox.",
      "",
      theme.muted("Esc back"),
    ];
  }
  return [
    theme.toolTitle("Effective Hotkeys"),
    "",
    ...keybindings
      .filter(
        (binding) => binding.section === "application" || binding.action === "paste_clipboard",
      )
      .map((binding) => formatKeybinding(binding, theme)),
    "",
    "Editor bindings  /help editor",
    "",
    theme.muted("Esc back"),
  ];
}

function formatKeybinding(binding: AdamKeybindingDefinition, theme: AdamTuiTheme): string {
  return binding.action === "paste_clipboard"
    ? `${theme.toolTitle(binding.keys)} — ${binding.description}`
    : `${theme.toolTitle(binding.keys)}  ${binding.description}`;
}
