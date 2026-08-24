import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { RoundedFrame } from "./rounded-frame.js";

class MutableLines implements Component {
  lines: string[] = [];

  invalidate(): void {}

  render(): string[] {
    return this.lines;
  }
}

test("RoundedFrame grows with streaming content while preserving exact rounded bounds", () => {
  const content = new MutableLines();
  content.lines = ["alpha"];
  const frame = new RoundedFrame(content, (text) => text);

  expect(frame.render(12)).toEqual(["╭──────────╮", "│ alpha    │", "╰──────────╯"]);

  content.lines = ["alpha", "beta", "gamma"];
  const grown = frame.render(12);
  expect(grown).toEqual([
    "╭──────────╮",
    "│ alpha    │",
    "│ beta     │",
    "│ gamma    │",
    "╰──────────╯",
  ]);
  expect(grown.every((line) => visibleWidth(line) === 12)).toBe(true);
});
