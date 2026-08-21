import type { TargetDisplay } from "@adam-agent/presentation";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class TargetPicker implements Component {
  readonly #list: SelectList;
  readonly #onSaveDefault: (target: TargetDisplay) => void;
  readonly #targets: ReadonlyMap<string, TargetDisplay>;
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly targets: readonly TargetDisplay[];
    readonly theme: AdamTuiTheme;
    readonly initialNotice?: string;
    readonly onSelect: (target: TargetDisplay) => void;
    readonly onSaveDefault: (target: TargetDisplay) => void;
  }) {
    this.#theme = options.theme;
    this.#notice =
      options.initialNotice === undefined ? null : safeTerminalText(options.initialNotice);
    this.#onSaveDefault = options.onSaveDefault;
    this.#targets = new Map(options.targets.map((target) => [target.targetId, target]));
    const items: SelectItem[] = options.targets.map((target) => ({
      value: target.targetId,
      label: safeTerminalText(target.targetId),
      description: safeTerminalText(
        `${target.label} · ${target.route} · ${target.certification} · ${target.readiness.status} (${target.readiness.credentialSource})`,
      ),
    }));
    this.#list = new SelectList(items, 8, options.theme.editor.selectList);
    this.#list.setSelectedIndex(
      Math.max(
        0,
        options.targets.findIndex((target) => target.readiness.status === "available"),
      ),
    );
    this.#list.onSelect = (item) => {
      const target = this.#targets.get(item.value);
      if (target !== undefined) {
        options.onSelect(target);
      }
    };
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (data === "d") {
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
      this.#theme.toolTitle("Select a model target"),
      "",
      ...this.#list.render(width),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("Enter select · d save default · ↑/↓ move · Ctrl+Q exit"),
    ];
  }
}
