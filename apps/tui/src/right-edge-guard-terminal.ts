import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Keeps Pi's renderer away from the terminal's autowrap-sensitive final cell.
 *
 * Pi composes overlays to the full reported width. If the terminal and Pi
 * disagree about even one grapheme cell, writing that final cell can wrap the
 * hardware cursor without advancing Pi's logical cursor. Reserving one cell at
 * the public Terminal boundary keeps both cursor models aligned.
 */
export class RightEdgeGuardTerminal implements Terminal {
  readonly #terminal: Terminal;

  constructor(terminal: Terminal) {
    this.#terminal = terminal;
  }

  get columns(): number {
    return Math.max(1, this.#terminal.columns - 1);
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.#terminal.kittyProtocolActive;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#terminal.start(onInput, onResize);
  }

  stop(): void {
    this.#terminal.stop();
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.#terminal.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.#terminal.write(data);
  }

  moveBy(lines: number): void {
    this.#terminal.moveBy(lines);
  }

  hideCursor(): void {
    this.#terminal.hideCursor();
  }

  showCursor(): void {
    this.#terminal.showCursor();
  }

  clearLine(): void {
    this.#terminal.clearLine();
  }

  clearFromCursor(): void {
    this.#terminal.clearFromCursor();
  }

  clearScreen(): void {
    this.#terminal.clearScreen();
  }

  setTitle(title: string): void {
    this.#terminal.setTitle(title);
  }

  setProgress(active: boolean): void {
    this.#terminal.setProgress(active);
  }
}
