import { type Component, ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

class InputDocument implements Component {
  prefix = "line";
  readonly inputs: string[] = [];
  render(): string[] {
    return Array.from({ length: 50 }, (_, index) => `${this.prefix}-${index}`);
  }
  handleInput(data: string): void {
    this.inputs.push(data);
    this.prefix = "edited";
  }
  invalidate(): void {}
}

const nextInputTurn = () => new Promise<void>((resolve) => process.nextTick(resolve));

// Pi defaults to one wheel line and a four-line PageUp/PageDown overlap.
test.each([
  { name: "wheel up", input: "\u001b[<64;5;5M", first: "line-19" },
  { name: "PageUp", input: "\u001b[5~", first: "line-14" },
  { name: "PageDown", input: "\u001b[6~", first: "line-26" },
])(
  "Pi $name produces a complete input frame without advancing the render timer",
  async ({ input, first }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const terminal = new VirtualTerminal({ columns: 40, rows: 10 });
    const document = new InputDocument();
    const scroll = new ScrollView(document, { primary: true, scrollbar: "hidden" });
    const tui = new TuiAltScreen(terminal);
    tui.setLayoutRoot(scroll);
    tui.setFocus(document);
    try {
      tui.start();
      tui.renderNow();
      scroll.scrollTo(20);
      tui.renderNow();
      const before = terminal.output().length;
      tui.requestRender(); // A streaming frame is already pending when the input arrives.
      terminal.input(input);
      await nextInputTurn();
      expect(terminal.completeFramesAfter(before)).toHaveLength(1);
      expect(terminal.lines()[0]).toBe(first);
      expect(document.inputs).toEqual([]);
    } finally {
      tui.stop();
      vi.useRealTimers();
    }
  },
);

test("Pi leaves overlay and focused input routing intact and coalesces streaming renders", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const terminal = new VirtualTerminal({ columns: 40, rows: 10 });
  const document = new InputDocument();
  const scroll = new ScrollView(document, { primary: true, scrollbar: "hidden" });
  const tui = new TuiAltScreen(terminal);
  tui.setLayoutRoot(scroll);
  tui.setFocus(document);
  try {
    tui.start();
    tui.renderNow();
    const overlay = new InputDocument();
    const handle = tui.showOverlay(overlay, { width: 20, maxHeight: 5 });
    tui.renderNow();
    const overlayBefore = terminal.output().length;
    terminal.input("\u001b[5~");
    await nextInputTurn();
    expect(overlay.inputs).toEqual(["\u001b[5~"]);
    expect(scroll.scrollTop).toBe(0);
    expect(terminal.completeFramesAfter(overlayBefore)).toHaveLength(1);
    handle.hide();
    tui.setFocus(document);
    tui.renderNow();
    const inputBefore = terminal.output().length;
    terminal.input("x");
    await nextInputTurn();
    expect(document.inputs).toEqual(["x"]);
    expect(terminal.completeFramesAfter(inputBefore)).toHaveLength(1);
    const streamBefore = terminal.output().length;
    for (const prefix of ["stream-a", "stream-b", "stream-final"]) {
      document.prefix = prefix;
      tui.requestRender();
    }
    await nextInputTurn();
    expect(terminal.completeFramesAfter(streamBefore)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(terminal.completeFramesAfter(streamBefore)).toHaveLength(1);
    expect(terminal.lines()[0]).toBe("stream-final-0");
  } finally {
    tui.stop();
    vi.useRealTimers();
  }
});
