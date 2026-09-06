import type { CommandReceipt } from "@adam-agent/presentation";
import { type Component, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type Recovery = NonNullable<Extract<CommandReceipt, { status: "admitted" }>["roleTarget"]>;
export class RoleTargetSelector implements Component {
  #list: SelectList;
  #updating = false;
  constructor(
    private readonly options: {
      readonly recovery: Recovery;
      readonly theme: AdamTuiTheme;
      readonly onChoose: (model: string | null) => void;
      readonly onCancel: () => void;
      readonly onChange: () => void;
    },
  ) {
    this.#list = this.#choices();
  }
  #choices(): SelectList {
    const list = new SelectList(
      this.#updating
        ? this.options.recovery.targets.map((target) => ({
            value: target.targetId,
            label: safeTerminalText(target.label),
            description: "Save this certified target for future threads.",
          }))
        : [
            {
              value: "inherit",
              label: "Use inherited",
              description:
                "Remove this role's target and thinking settings; future threads inherit Main.",
            },
            {
              value: "update",
              label: "Update",
              description: "Choose and save an available certified target.",
            },
            { value: "cancel", label: "Cancel", description: "Keep the definition and draft." },
          ],
      8,
      this.options.theme.editor.selectList,
    );
    list.onSelect = (item) => {
      if (this.#updating) this.options.onChoose(item.value);
      else if (item.value === "inherit") this.options.onChoose(null);
      else if (item.value === "cancel") this.options.onCancel();
      else {
        this.#updating = true;
        this.#list = this.#choices();
        this.options.onChange();
      }
    };
    list.onCancel = this.options.onCancel;
    return list;
  }
  handleInput(data: string): void {
    this.#list.handleInput(data);
  }
  invalidate(): void {
    this.#list.invalidate();
  }
  render(width: number): string[] {
    return [
      this.options.theme.toolTitle("Role target unavailable"),
      truncateToWidth(safeTerminalText(this.options.recovery.message), width),
      truncateToWidth(`Save changes to ${safeTerminalText(this.options.recovery.source)}`, width),
      "",
      ...this.#list.render(width),
      this.options.theme.muted("Enter choose and save · Esc cancel"),
    ];
  }
}
