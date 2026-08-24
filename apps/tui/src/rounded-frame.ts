import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export class RoundedFrame implements Component {
  readonly #content: Component;
  readonly #styleBorder: (text: string) => string;

  constructor(content: Component, styleBorder: (text: string) => string) {
    this.#content = content;
    this.#styleBorder = styleBorder;
  }

  invalidate(): void {
    this.#content.invalidate();
  }

  render(width: number): string[] {
    if (width < 4) {
      return this.#content.render(width).map((line) => truncateToWidth(line, Math.max(0, width)));
    }
    const innerWidth = width - 4;
    const lines = this.#content.render(innerWidth).map((line) => {
      const bounded = truncateToWidth(line, innerWidth);
      return `${this.#styleBorder("│")} ${bounded}${" ".repeat(
        Math.max(0, innerWidth - visibleWidth(bounded)),
      )} ${this.#styleBorder("│")}`;
    });
    const horizontal = "─".repeat(width - 2);
    return [this.#styleBorder(`╭${horizontal}╮`), ...lines, this.#styleBorder(`╰${horizontal}╯`)];
  }
}
