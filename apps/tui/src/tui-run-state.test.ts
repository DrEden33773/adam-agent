import { expect, test } from "vitest";

import { isTuiRunActive } from "./tui-run-state.js";

test("the shared TUI run predicate includes transient work, pending interaction and cancel settlement", () => {
  expect(
    isTuiRunActive({ cancelSettling: false, pendingInteractionCount: 0, transient: null }),
  ).toBe(false);
  expect(
    isTuiRunActive({
      cancelSettling: false,
      pendingInteractionCount: 0,
      transient: { activity: "working", assistant: null, reasoning: null },
    }),
  ).toBe(true);
  expect(
    isTuiRunActive({ cancelSettling: false, pendingInteractionCount: 1, transient: null }),
  ).toBe(true);
  expect(
    isTuiRunActive({ cancelSettling: true, pendingInteractionCount: 0, transient: null }),
  ).toBe(true);
});
