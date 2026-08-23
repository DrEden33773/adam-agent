import type { ThinkingCapabilityDisplay } from "@adam-agent/presentation";
import {
  type Component,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class ThinkingPicker implements Component {
  readonly #capability: ThinkingCapabilityDisplay;
  readonly #onClose: () => void;
  readonly #onSelect: (levelId: string) => void;
  readonly #theme: AdamTuiTheme;
  #selectedIndex: number;

  constructor(options: {
    readonly capability: ThinkingCapabilityDisplay;
    readonly selectedLevelId: string;
    readonly onClose: () => void;
    readonly onSelect: (levelId: string) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#capability = options.capability;
    this.#onClose = options.onClose;
    this.#onSelect = options.onSelect;
    this.#theme = options.theme;
    this.#selectedIndex = Math.max(
      0,
      options.capability.levels.findIndex((level) => level.id === options.selectedLevelId),
    );
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up")) {
      this.#selectedIndex =
        this.#selectedIndex === 0 ? this.#capability.levels.length - 1 : this.#selectedIndex - 1;
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.#selectedIndex =
        this.#selectedIndex === this.#capability.levels.length - 1 ? 0 : this.#selectedIndex + 1;
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.#capability.levels[this.#selectedIndex];
      if (selected !== undefined) {
        this.#onSelect(selected.id);
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.#onClose();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maximumLabelWidth = Math.max(
      0,
      ...this.#capability.levels.map((level) => visibleWidth(level.label)),
    );
    const rows = this.#capability.levels.map((level, index) => {
      const label = safeTerminalText(level.label);
      const prefix = index === this.#selectedIndex ? "> " : "  ";
      const description =
        level.id === level.effectiveLevelId
          ? "exact provider level"
          : `maps to ${safeTerminalText(level.effectiveLevelId)}`;
      const plain = `${prefix}${label}${" ".repeat(Math.max(0, maximumLabelWidth - visibleWidth(label)))}  ${description}`;
      if (index === this.#selectedIndex) {
        return this.#theme.inverseSelection(truncateToWidth(plain.padEnd(width), width, ""));
      }
      return truncateToWidth(
        `${prefix}${this.#theme.keyword(label)}${" ".repeat(Math.max(0, maximumLabelWidth - visibleWidth(label)))}  ${this.#theme.muted(description)}`,
        width,
        "",
      );
    });
    return [
      this.#theme.toolTitle("Thinking level for the next prompt"),
      "",
      ...rows,
      "",
      this.#theme.muted("Enter select · ↑/↓ move · Esc close · changes never mutate an active run"),
    ];
  }
}
