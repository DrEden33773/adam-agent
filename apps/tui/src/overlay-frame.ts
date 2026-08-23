import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AdamTuiTheme } from "./theme.js";

export class OverlayFrame implements Component {
  readonly #content: Component;
  readonly #maximumHeight: (() => number | undefined) | undefined;
  readonly #theme: AdamTuiTheme;
  #focused = false;

  constructor(content: Component, theme: AdamTuiTheme, maximumHeight?: () => number | undefined) {
    this.#content = content;
    this.#theme = theme;
    this.#maximumHeight = maximumHeight;
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    if ("focused" in this.#content) {
      (this.#content as Component & { focused: boolean }).focused = value;
    }
  }

  get wantsKeyRelease(): boolean {
    return this.#content.wantsKeyRelease === true;
  }

  handleInput(data: string): void {
    this.#content.handleInput?.(data);
  }

  invalidate(): void {
    this.#content.invalidate();
  }

  render(width: number): string[] {
    if (width < 4) {
      return this.#content.render(width).map((line) => truncateToWidth(line, Math.max(0, width)));
    }
    const innerWidth = width - 4;
    const maximumHeight = this.#maximumHeight?.();
    const maximumContentHeight =
      maximumHeight === undefined ? undefined : Math.max(0, Math.floor(maximumHeight) - 2);
    const rendered = this.#content
      .render(innerWidth)
      .slice(0, maximumContentHeight ?? Number.POSITIVE_INFINITY);
    const content = rendered.map((line) =>
      padLine(
        visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth) : line,
        innerWidth,
      ),
    );
    return [
      this.#theme.editor.borderColor(`┌${"─".repeat(Math.max(0, width - 2))}┐`),
      ...content.map(
        (line) =>
          `${this.#theme.editor.borderColor("│")} ${line} ${this.#theme.editor.borderColor("│")}`,
      ),
      this.#theme.editor.borderColor(`└${"─".repeat(Math.max(0, width - 2))}┘`),
    ];
  }
}

function padLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}
