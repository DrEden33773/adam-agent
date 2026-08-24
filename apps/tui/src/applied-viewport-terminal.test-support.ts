import { StdinBuffer, type Terminal, visibleWidth } from "@earendil-works/pi-tui";

const missingFrameFailureMilliseconds = 30_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type FrameWaiter = {
  readonly after: number;
  readonly guard: ReturnType<typeof setTimeout>;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
};

export class AppliedViewportTerminal implements Terminal {
  readonly #commitPendingWrapAtFrameEnd: boolean;
  readonly #graphemeWidths: ReadonlyMap<string, number>;
  readonly #input = new StdinBuffer();
  readonly #waiters = new Set<FrameWaiter>();
  #column = 0;
  #columns: number;
  #frame = 0;
  #inputHandler: ((data: string) => void) | undefined;
  #output = "";
  #row = 0;
  #rows: number;
  #screen: string[][];
  #started = false;

  constructor(options: {
    readonly columns: number;
    readonly commitPendingWrapAtFrameEnd?: boolean;
    readonly rows: number;
    readonly graphemeWidths?: ReadonlyMap<string, number>;
  }) {
    this.#columns = options.columns;
    this.#commitPendingWrapAtFrameEnd = options.commitPendingWrapAtFrameEnd ?? false;
    this.#rows = options.rows;
    this.#graphemeWidths = options.graphemeWidths ?? new Map();
    this.#screen = this.#createBlankScreen();
    this.#input.on("data", (sequence) => this.#inputHandler?.(sequence));
    this.#input.on("paste", (content) => this.#inputHandler?.(`\u001b[200~${content}\u001b[201~`));
  }

  get columns(): number {
    return this.#columns;
  }

  get frame(): number {
    return this.#frame;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  get rows(): number {
    return this.#rows;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.#inputHandler = onInput;
    this.#started = true;
  }

  stop(): void {
    this.#started = false;
    this.#input.destroy();
    this.#inputHandler = undefined;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.guard);
      waiter.reject(new Error(`Terminal stopped before synchronized frame ${waiter.after + 1}.`));
    }
    this.#waiters.clear();
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.#output += data;
    let index = 0;
    while (index < data.length) {
      const codePoint = data.codePointAt(index);
      if (codePoint === undefined) {
        break;
      }
      const character = String.fromCodePoint(codePoint);
      if (character === "\u001b") {
        const parsedEscape = this.#consumeEscape(data, index);
        index = parsedEscape.nextIndex;
        if (parsedEscape.synchronizedFrameEnded) {
          if (this.#commitPendingWrapAtFrameEnd && this.#column >= this.#columns) {
            this.#column = 0;
            this.#lineFeed();
          }
          this.#completeFrame();
        }
        continue;
      }
      if (character === "\r") {
        this.#column = 0;
      } else if (character === "\n") {
        this.#lineFeed();
      } else if (character === "\b") {
        this.#column = Math.max(0, this.#column - 1);
      } else if (codePoint >= 0x20 && codePoint !== 0x7f) {
        const plainTextEnd = this.#nextControlIndex(data, index);
        for (const { segment } of graphemeSegmenter.segment(data.slice(index, plainTextEnd))) {
          this.#putGrapheme(segment);
        }
        index = plainTextEnd;
        continue;
      }
      index += character.length;
    }
  }

  input(data: string): void {
    if (!this.#started || this.#inputHandler === undefined) {
      throw new Error("AppliedViewportTerminal accepts input only while started.");
    }
    this.#input.process(data);
  }

  lines(): readonly string[] {
    return this.#screen.map((line) => line.join("").replace(/ +$/u, ""));
  }

  output(): string {
    return this.#output;
  }

  running(): boolean {
    return this.#started;
  }

  nextFrame(after = this.#frame): Promise<void> {
    if (this.#frame > after) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: FrameWaiter = {
        after,
        guard: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`No synchronized frame was rendered after frame ${after}.`));
        }, missingFrameFailureMilliseconds),
        reject,
        resolve,
      };
      waiter.guard.unref();
      this.#waiters.add(waiter);
    });
  }

  moveBy(lines: number): void {
    this.#row = clamp(this.#row + lines, 0, this.#rows - 1);
  }

  hideCursor(): void {}

  showCursor(): void {}

  clearLine(): void {
    this.#eraseLine(0);
  }

  clearFromCursor(): void {
    this.#eraseDisplay(0);
  }

  clearScreen(): void {
    this.#eraseDisplay(2);
    this.#row = 0;
    this.#column = 0;
  }

  setTitle(): void {}

  setProgress(): void {}

  #completeFrame(): void {
    this.#frame += 1;
    for (const waiter of this.#waiters) {
      if (this.#frame > waiter.after) {
        clearTimeout(waiter.guard);
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  #consumeEscape(
    data: string,
    startIndex: number,
  ): { readonly nextIndex: number; readonly synchronizedFrameEnded: boolean } {
    const kind = data[startIndex + 1];
    if (kind === "[") {
      let endIndex = startIndex + 2;
      while (endIndex < data.length && !/[\x40-\x7e]/u.test(data[endIndex] as string)) {
        endIndex += 1;
      }
      if (endIndex >= data.length) {
        throw new Error("AppliedViewportTerminal received a partial CSI sequence.");
      }
      const final = data[endIndex] as string;
      const rawParameters = data.slice(startIndex + 2, endIndex);
      const parameters = rawParameters
        .replace(/^[?>]/u, "")
        .split(";")
        .map((value) => (value === "" ? 0 : Number(value)));
      const amount = parameters[0] || 1;
      if (final === "A") {
        this.#row = clamp(this.#row - amount, 0, this.#rows - 1);
      } else if (final === "B") {
        this.#row = clamp(this.#row + amount, 0, this.#rows - 1);
      } else if (final === "C") {
        this.#column = clamp(this.#column + amount, 0, this.#columns - 1);
      } else if (final === "D") {
        this.#column = clamp(this.#column - amount, 0, this.#columns - 1);
      } else if (final === "G") {
        this.#column = clamp(amount - 1, 0, this.#columns - 1);
      } else if (final === "H" || final === "f") {
        this.#row = clamp((parameters[0] || 1) - 1, 0, this.#rows - 1);
        this.#column = clamp((parameters[1] || 1) - 1, 0, this.#columns - 1);
      } else if (final === "J") {
        this.#eraseDisplay(parameters[0] || 0);
      } else if (final === "K") {
        this.#eraseLine(parameters[0] || 0);
      }
      return {
        nextIndex: endIndex + 1,
        synchronizedFrameEnded: rawParameters === "?2026" && final === "l",
      };
    }
    if (kind === "]" || kind === "_") {
      let endIndex = startIndex + 2;
      while (
        endIndex < data.length &&
        data[endIndex] !== "\u0007" &&
        !(data[endIndex] === "\u001b" && data[endIndex + 1] === "\\")
      ) {
        endIndex += 1;
      }
      if (endIndex >= data.length) {
        throw new Error("AppliedViewportTerminal received a partial string escape sequence.");
      }
      return {
        nextIndex: data[endIndex] === "\u0007" ? endIndex + 1 : endIndex + 2,
        synchronizedFrameEnded: false,
      };
    }
    return { nextIndex: Math.min(data.length, startIndex + 2), synchronizedFrameEnded: false };
  }

  #createBlankScreen(): string[][] {
    return Array.from({ length: this.#rows }, () => Array<string>(this.#columns).fill(" "));
  }

  #nextControlIndex(data: string, startIndex: number): number {
    let index = startIndex;
    while (index < data.length) {
      const codePoint = data.codePointAt(index);
      if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
        break;
      }
      index += String.fromCodePoint(codePoint).length;
    }
    return index;
  }

  #putGrapheme(grapheme: string): void {
    const width = this.#graphemeWidths.get(grapheme) ?? visibleWidth(grapheme);
    if (width <= 0) {
      return;
    }
    if (this.#column >= this.#columns) {
      this.#column = 0;
      this.#lineFeed();
    }
    const line = this.#line(this.#row);
    line[this.#column] = grapheme;
    for (
      let continuation = 1;
      continuation < width && this.#column + continuation < this.#columns;
      continuation += 1
    ) {
      line[this.#column + continuation] = " ";
    }
    this.#column += width;
  }

  #lineFeed(): void {
    if (this.#row < this.#rows - 1) {
      this.#row += 1;
      return;
    }
    this.#screen.shift();
    this.#screen.push(Array<string>(this.#columns).fill(" "));
  }

  #eraseLine(mode: number): void {
    const line = this.#line(this.#row);
    if (mode === 2) {
      line.fill(" ");
    } else if (mode === 1) {
      line.fill(" ", 0, this.#column + 1);
    } else {
      line.fill(" ", this.#column);
    }
  }

  #eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      for (const line of this.#screen) {
        line.fill(" ");
      }
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.#row; row += 1) {
        this.#line(row).fill(" ");
      }
      this.#line(this.#row).fill(" ", 0, this.#column + 1);
      return;
    }
    this.#line(this.#row).fill(" ", this.#column);
    for (let row = this.#row + 1; row < this.#rows; row += 1) {
      this.#line(row).fill(" ");
    }
  }

  #line(row: number): string[] {
    const line = this.#screen[row];
    if (line === undefined) {
      throw new RangeError(`AppliedViewportTerminal row ${row} is outside the viewport.`);
    }
    return line;
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(value, upper));
}
