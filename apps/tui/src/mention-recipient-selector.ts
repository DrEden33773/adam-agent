import { type Component, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { AdamTuiTheme } from "./theme.js";

export class MentionRecipientSelector implements Component {
  readonly #list: SelectList;
  constructor(
    private readonly options: {
      readonly title: string;
      readonly choices: readonly {
        readonly value: string;
        readonly label: string;
        readonly description: string;
      }[];
      readonly theme: AdamTuiTheme;
      readonly onChoose: (value: string) => void;
      readonly onCancel: () => void;
    },
  ) {
    this.#list = new SelectList([...options.choices], 8, options.theme.editor.selectList);
    this.#list.onSelect = (item) => options.onChoose(item.value);
    this.#list.onCancel = options.onCancel;
  }
  handleInput(data: string): void {
    this.#list.handleInput(data);
  }
  invalidate(): void {
    this.#list.invalidate();
  }
  render(width: number): string[] {
    return [
      truncateToWidth(this.options.theme.toolTitle(this.options.title), width),
      "",
      ...this.#list.render(width),
      this.options.theme.muted("Enter choose · Esc retain draft"),
    ];
  }
}
