import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

export const minimumTerminalColumns = 40;
export const minimumTerminalRows = 12;

export function terminalSizeIsSupported(columns: number, rows: number): boolean {
  return columns >= minimumTerminalColumns && rows >= minimumTerminalRows;
}

export class ResponsiveRoot extends Container {
  readonly #rows: () => number;

  constructor(rows: () => number) {
    super();
    this.#rows = rows;
  }

  override render(width: number): string[] {
    const rows = this.#rows();
    if (terminalSizeIsSupported(width, rows)) {
      return super.render(width);
    }
    return [
      "Terminal too small",
      `${width}×${rows} · resize to ${minimumTerminalColumns}×${minimumTerminalRows} or larger`,
      "Ctrl+C abort/exit · Esc deny/close · Ctrl+Q exit",
    ].map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

export type ResponsiveTextContent = {
  readonly narrow: string;
  readonly standard: string;
  readonly wide: string;
};

export class ResponsiveText implements Component {
  #content: ResponsiveTextContent = { narrow: "", standard: "", wide: "" };

  invalidate(): void {}

  setText(content: string | ResponsiveTextContent): void {
    this.#content =
      typeof content === "string" ? { narrow: content, standard: content, wide: content } : content;
  }

  render(width: number): string[] {
    const content =
      width >= 120
        ? this.#content.wide
        : width >= 80
          ? this.#content.standard
          : this.#content.narrow;
    return new Text(content).render(width);
  }
}

export class ResponsiveLine implements Component {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const maximumWidth = width >= 112 ? width : Math.min(width, 52);
    return [truncateToWidth(this.#text, Math.max(0, maximumWidth))];
  }
}
