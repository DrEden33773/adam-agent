import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AppliedViewportTerminal } from "./applied-viewport-terminal.test-support.js";
import { RightEdgeGuardTerminal } from "./right-edge-guard-terminal.js";

class MutableLines implements Component {
  lines: string[];

  constructor(lines: readonly string[]) {
    this.lines = [...lines];
  }

  invalidate(): void {}

  render(): string[] {
    return [...this.lines];
  }
}

test("main-screen viewport rewinds when transient rows disappear", () => {
  const physicalTerminal = new AppliedViewportTerminal({ columns: 120, rows: 30 });
  const terminal = new RightEdgeGuardTerminal(physicalTerminal);
  const baseLines = Array.from({ length: 56 }, (_, index) => `base-${index}`);
  const content = new MutableLines(baseLines);
  const tui = new TuiMainScreen(terminal, false);
  tui.addChild(content);
  tui.start();

  try {
    for (const transientRows of [6, 3, 1, 0]) {
      content.lines = [
        ...baseLines.slice(0, 36),
        ...Array.from({ length: transientRows }, (_, index) => `completion-${index}`),
        ...baseLines.slice(36),
      ];
      tui.renderNow();
    }
    content.lines = baseLines.with(37, "TREE TITLE");
    tui.renderNow();

    expect(physicalTerminal.lines().findIndex((line) => line.includes("TREE TITLE"))).toBe(11);
  } finally {
    tui.stop();
  }
});

test("main-screen changes above the viewport preserve scrollback", () => {
  const physicalTerminal = new AppliedViewportTerminal({ columns: 120, rows: 30 });
  const terminal = new RightEdgeGuardTerminal(physicalTerminal);
  const baseLines = Array.from({ length: 56 }, (_, index) => `base-${index}`);
  const content = new MutableLines(baseLines);
  const tui = new TuiMainScreen(terminal, false);
  tui.addChild(content);
  tui.start();

  try {
    const interactionOutputOffset = physicalTerminal.output().length;
    content.lines = baseLines.with(0, "updated-above-viewport");
    tui.renderNow();

    const visibleLines = physicalTerminal.lines();
    expect(visibleLines.at(0)).toContain("base-26");
    expect(visibleLines.at(-1)).toContain("base-55");
    expect(physicalTerminal.output().slice(interactionOutputOffset)).not.toContain("\u001b[3J");
  } finally {
    tui.stop();
  }
});
