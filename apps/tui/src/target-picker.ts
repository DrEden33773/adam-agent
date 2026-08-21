import type { TargetDisplay } from "@adam-agent/presentation";
import type { Component, SelectItem } from "@earendil-works/pi-tui";

import { adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

export class TargetPicker implements Component {
  readonly #list: SearchableSelectList;
  readonly #mode: "create" | "transition";
  readonly #onCreate: ((target: TargetDisplay) => void) | undefined;
  readonly #onFork: ((target: TargetDisplay) => void) | undefined;
  readonly #onSaveDefault: (target: TargetDisplay) => void;
  readonly #targets: ReadonlyMap<string, TargetDisplay>;
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly targets: readonly TargetDisplay[];
    readonly theme: AdamTuiTheme;
    readonly initialNotice?: string;
    readonly currentTargetId?: string;
    readonly mode?: "create" | "transition";
    readonly onClose: () => void;
    readonly onCreate?: (target: TargetDisplay) => void;
    readonly onFork?: (target: TargetDisplay) => void;
    readonly onSelect: (target: TargetDisplay) => void;
    readonly onSaveDefault: (target: TargetDisplay) => void;
  }) {
    this.#theme = options.theme;
    this.#mode = options.mode ?? "create";
    this.#onCreate = options.onCreate;
    this.#onFork = options.onFork;
    this.#notice =
      options.initialNotice === undefined
        ? options.currentTargetId === undefined
          ? null
          : safeTerminalText(
              `Current target ${options.currentTargetId} · existing session target is immutable`,
            )
        : safeTerminalText(options.initialNotice);
    this.#onSaveDefault = options.onSaveDefault;
    this.#targets = new Map(options.targets.map((target) => [target.targetId, target]));
    const items: SelectItem[] = options.targets.map((target) => ({
      value: target.targetId,
      label: safeTerminalText(target.targetId),
      description: safeTerminalText(
        `${target.label} · ${target.route} · ${target.certification} · ${target.readiness.status} (${target.readiness.credentialSource})`,
      ),
    }));
    this.#list = new SearchableSelectList({
      items: items.map((item) => ({
        item,
        searchText: `${item.label ?? ""} ${item.description ?? ""} ${item.value}`,
      })),
      maxVisible: 8,
      onCancel: options.onClose,
      onSelect: (item) => {
        const target = this.#targets.get(item.value);
        if (target !== undefined) {
          options.onSelect(target);
        }
      },
      theme: options.theme.editor.selectList,
    });
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (
      this.#mode === "transition" &&
      (adamCommandRegistry.matchesInput(data, "new_session_from_target") ||
        adamCommandRegistry.matchesInput(data, "fork_from_target"))
    ) {
      const selected = this.#list.getSelectedItem();
      const target = selected === null ? undefined : this.#targets.get(selected.value);
      if (target !== undefined) {
        if (adamCommandRegistry.matchesInput(data, "new_session_from_target")) {
          this.#onCreate?.(target);
        } else {
          this.#onFork?.(target);
        }
      }
      return;
    }
    if (adamCommandRegistry.matchesInput(data, "save_default_target")) {
      const selected = this.#list.getSelectedItem();
      const target = selected === null ? undefined : this.#targets.get(selected.value);
      if (target !== undefined) {
        this.#notice = null;
        this.#list.invalidate();
        // Saving is deliberately distinct from SelectList's Enter action.
        this.#onSaveDefault(target);
      }
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Select an exact model target"),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted(
        this.#mode === "transition"
          ? `${adamCommandRegistry.keybinding("new_session_from_target").keys} new session · ${adamCommandRegistry.keybinding("fork_from_target").keys} fork current boundary · ${adamCommandRegistry.keybinding("save_default_target").keys} save default · type search · ↑/↓ move · Esc close · Ctrl+Q exit`
          : `Enter create · ${adamCommandRegistry.keybinding("save_default_target").keys} save default · type search · ↑/↓ move · Esc close · Ctrl+Q exit`,
      ),
    ];
  }
}
