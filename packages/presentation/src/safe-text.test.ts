import { expect, test } from "vitest";

import { stripTerminalSequences } from "./index.js";

test("stripTerminalSequences removes complete Pi terminal strings", () => {
  expect(
    stripTerminalSequences("a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u001b_private\u001b\\c"),
  ).toBe("aredbc");
});

test("stripTerminalSequences preserves visible bytes after unknown or incomplete ESC", () => {
  expect(stripTerminalSequences("A\u001bXB\u001b[31")).toBe("A\u001bXB\u001b[31");
});
