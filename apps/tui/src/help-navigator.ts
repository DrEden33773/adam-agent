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

export type HelpPage = "commands" | "editor" | "hotkeys" | "root";

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
          `${index === selectedTopicIndex ? ">" : " "} ${topic.label}  ${topic.summary}`,
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
        .map((binding) => `${theme.toolTitle(binding.keys)}  ${binding.description}`),
      "",
      theme.muted("Esc back"),
    ];
  }
  return [
    theme.toolTitle("Effective Hotkeys"),
    "",
    ...keybindings
      .filter((binding) => binding.section === "application")
      .map((binding) => `${theme.toolTitle(binding.keys)}  ${binding.description}`),
    "",
    "Editor bindings  /help editor",
    "",
    theme.muted("Esc back"),
  ];
}
