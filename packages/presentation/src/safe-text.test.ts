import { expect, test } from "vitest";

import { isUnsafePresentationControl, stripTerminalSequences } from "./index.js";

test("stripTerminalSequences removes complete Pi terminal strings", () => {
  expect(
    stripTerminalSequences("a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u001b_private\u001b\\c"),
  ).toBe("aredbc");
});

test("isUnsafePresentationControl centralizes C0, C1, and bidi controls", () => {
  expect([0x1b, 0x7f, 0x061c, 0x202e, 0x2069].every(isUnsafePresentationControl)).toBe(true);
  expect([0x20, 0x41, 0x4e2d].some(isUnsafePresentationControl)).toBe(false);
});

test("stripTerminalSequences preserves visible bytes after unknown or incomplete ESC", () => {
  expect(stripTerminalSequences("A\u001bXB\u001b[31")).toBe("A\u001bXB\u001b[31");
});
