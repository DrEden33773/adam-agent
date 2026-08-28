import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";
import { AppliedViewportTerminal } from "./applied-viewport-terminal.test-support.js";

const missingOutputFailureMilliseconds = 30_000;

type OutputWaiter = {
  readonly guard: ReturnType<typeof setTimeout>;
  readonly offset: number;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly text: string;
};

type FrameWaiter = {
  readonly guard: ReturnType<typeof setTimeout>;
  readonly offset: number;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly text: string;
};

export class VirtualTerminal implements Terminal {
  readonly #events: Array<"started" | "stopped"> = [];
  readonly #input = new StdinBuffer();
  readonly #frames: Array<{ readonly endOffset: number; readonly text: string }> = [];
  readonly #frameWaiters = new Set<FrameWaiter>();
  readonly #started = Promise.withResolvers<void>();
  readonly #waiters = new Set<OutputWaiter>();
  readonly #viewport: AppliedViewportTerminal;
  #columns: number;
  #inputHandler: ((data: string) => void) | undefined;
  #output = "";
  #resizeHandler: (() => void) | undefined;
  #rows: number;
  #state: "new" | "started" | "stopped" = "new";
  readonly #throwAfterStart: boolean;
  readonly #throwAfterStop: boolean;
  readonly #throwOnHideCursorAfterInput: string | undefined;
  #throwOnNextHideCursor = false;

  constructor(
    options: {
      readonly columns?: number;
      readonly rows?: number;
      readonly throwAfterStart?: boolean;
      readonly throwAfterStop?: boolean;
      readonly throwOnHideCursorAfterInput?: string;
    } = {},
  ) {
    this.#columns = options.columns ?? 80;
    this.#rows = options.rows ?? 24;
    this.#viewport = new AppliedViewportTerminal({ columns: this.#columns, rows: this.#rows });
    this.#throwAfterStart = options.throwAfterStart ?? false;
    this.#throwAfterStop = options.throwAfterStop ?? false;
    this.#throwOnHideCursorAfterInput = options.throwOnHideCursorAfterInput;
    this.#input.on("data", (sequence) => this.#inputHandler?.(sequence));
    this.#input.on("paste", (content) => this.#inputHandler?.(`\u001b[200~${content}\u001b[201~`));
  }

  get columns(): number {
    return this.#columns;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  get rows(): number {
    return this.#rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.#state !== "new") {
      throw new Error(`VirtualTerminal cannot start from ${this.#state} state.`);
    }
    this.#state = "started";
    this.#events.push("started");
    this.#inputHandler = onInput;
    this.#resizeHandler = onResize;
    this.#started.resolve();
    if (this.#throwAfterStart) {
      throw new Error("Injected terminal start failure after acquisition.");
    }
  }

  stop(): void {
    if (this.#state !== "started") {
      throw new Error(`VirtualTerminal cannot stop from ${this.#state} state.`);
    }
    this.#state = "stopped";
    this.#events.push("stopped");
    this.#input.destroy();
    this.#inputHandler = undefined;
    this.#resizeHandler = undefined;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.guard);
      waiter.reject(
        new Error(
          `VirtualTerminal stopped before rendering ${JSON.stringify(waiter.text)} after offset ${waiter.offset}. Output tail: ${JSON.stringify(this.#output.slice(Math.max(waiter.offset, this.#output.length - 2_000)))}`,
        ),
      );
    }
    this.#waiters.clear();
    for (const waiter of this.#frameWaiters) {
      clearTimeout(waiter.guard);
      waiter.reject(
        new Error(
          `VirtualTerminal stopped before displaying ${JSON.stringify(waiter.text)} after offset ${waiter.offset}. Screen: ${JSON.stringify(this.#viewport.lines())}`,
        ),
      );
    }
    this.#frameWaiters.clear();
    if (this.#throwAfterStop) {
      throw new Error("Injected terminal stop failure after restoration.");
    }
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.#output += data;
    const beforeFrame = this.#viewport.frame;
    this.#viewport.write(data);
    for (const waiter of this.#waiters) {
      if (this.#output.indexOf(waiter.text, waiter.offset) >= 0) {
        clearTimeout(waiter.guard);
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (this.#viewport.frame > beforeFrame) {
      const frame = { endOffset: this.#output.length, text: this.#viewport.lines().join("\n") };
      this.#frames.push(frame);
      for (const waiter of this.#waiters) {
        if (frame.endOffset > waiter.offset && frame.text.includes(waiter.text)) {
          clearTimeout(waiter.guard);
          this.#waiters.delete(waiter);
          waiter.resolve();
        }
      }
      for (const waiter of this.#frameWaiters) {
        if (frame.endOffset > waiter.offset && frame.text.includes(waiter.text)) {
          clearTimeout(waiter.guard);
          this.#frameWaiters.delete(waiter);
          waiter.resolve();
        }
      }
    }
  }

  input(data: string): void {
    if (this.#state !== "started" || this.#inputHandler === undefined) {
      throw new Error("VirtualTerminal accepts input only while started.");
    }
    if (data === this.#throwOnHideCursorAfterInput) {
      this.#throwOnNextHideCursor = true;
    }
    this.#input.process(data);
  }

  resize(columns: number, rows: number): void {
    if (this.#state !== "started" || this.#resizeHandler === undefined) {
      throw new Error("VirtualTerminal can resize only while started.");
    }
    this.#columns = columns;
    this.#rows = rows;
    this.#viewport.resize(columns, rows);
    this.#resizeHandler();
  }

  output(): string {
    return this.#output;
  }

  lines(): readonly string[] {
    return this.#viewport.lines();
  }

  lifecycle(): readonly ("started" | "stopped")[] {
    return [...this.#events];
  }

  whenStarted(): Promise<void> {
    return this.#started.promise;
  }

  running(): boolean {
    return this.#state === "started";
  }

  nextOutputContaining(text: string, offset = 0): Promise<void> {
    if (
      this.#output.indexOf(text, offset) >= 0 ||
      this.#frames.some((frame) => frame.endOffset > offset && frame.text.includes(text))
    ) {
      return Promise.resolve();
    }
    if (this.#state === "stopped") {
      return Promise.reject(
        new Error(
          `VirtualTerminal already stopped without rendering ${JSON.stringify(text)} after offset ${offset}. Output tail: ${JSON.stringify(this.#output.slice(Math.max(offset, this.#output.length - 2_000)))}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: OutputWaiter = {
        guard: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(
            new Error(
              `VirtualTerminal did not render ${JSON.stringify(text)} after offset ${offset}. Screen: ${JSON.stringify(this.#viewport.lines())}. Output tail: ${JSON.stringify(this.#output.slice(Math.max(offset, this.#output.length - 2_000)))}`,
            ),
          );
        }, missingOutputFailureMilliseconds),
        offset,
        reject,
        resolve,
        text,
      };
      waiter.guard.unref();
      this.#waiters.add(waiter);
    });
  }

  async nextSynchronizedFrameContaining(text: string, offset = 0): Promise<void> {
    if (this.#frames.some((frame) => frame.endOffset > offset && frame.text.includes(text))) {
      return;
    }
    if (this.#state === "stopped") {
      throw new Error(
        `VirtualTerminal already stopped without displaying ${JSON.stringify(text)} after offset ${offset}. Screen: ${JSON.stringify(this.#viewport.lines())}`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: FrameWaiter = {
        guard: setTimeout(() => {
          this.#frameWaiters.delete(waiter);
          reject(
            new Error(
              `VirtualTerminal did not display ${JSON.stringify(text)} after offset ${offset}. Screen: ${JSON.stringify(this.#viewport.lines())}`,
            ),
          );
        }, missingOutputFailureMilliseconds),
        offset,
        reject,
        resolve,
        text,
      };
      waiter.guard.unref();
      this.#frameWaiters.add(waiter);
    });
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      this.write(`\u001b[${lines}B`);
    } else if (lines < 0) {
      this.write(`\u001b[${-lines}A`);
    }
  }

  hideCursor(): void {
    if (this.#throwOnNextHideCursor) {
      this.#throwOnNextHideCursor = false;
      throw new Error("Injected overlay cleanup failure before terminal restoration.");
    }
    this.write("\u001b[?25l");
  }

  showCursor(): void {
    this.write("\u001b[?25h");
  }

  clearLine(): void {
    this.write("\u001b[K");
  }

  clearFromCursor(): void {
    this.write("\u001b[J");
  }

  clearScreen(): void {
    this.write("\u001b[2J\u001b[H");
  }

  setTitle(title: string): void {
    this.write(`\u001b]0;${title}\u0007`);
  }

  setProgress(active: boolean): void {
    this.write(active ? "\u001b]9;4;3\u0007" : "\u001b]9;4;0\u0007");
  }
}
