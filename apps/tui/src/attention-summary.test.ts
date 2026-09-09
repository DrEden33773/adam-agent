import type { ManagedAttentionItem, ManagedWorkspaceSnapshot } from "@adam-agent/presentation";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { attentionSummary, blockingAttention, uniqueAttention } from "./attention-summary.js";
import { createAdamTuiTheme } from "./theme.js";

const permission: ManagedAttentionItem = {
  parentSessionId: "main",
  threadId: "one",
  turnId: "turn-one",
  id: "permission-one",
  handle: "@explore-1",
  displayName: "核查 é",
  description: "Read evidence",
  kind: "permission",
  available: true,
  interaction: null,
};
const reply: ManagedAttentionItem = {
  ...permission,
  id: "reply-one",
  kind: "parent_input",
  question: "Which file?",
};
const snapshot: ManagedWorkspaceSnapshot = {
  parentSessionId: "main",
  revision: 1,
  status: "ready",
  threads: [],
  completions: [],
};
const targets = [
  { threadId: "one", expectedTurnId: "turn-one" },
  { threadId: "two", expectedTurnId: "turn-two" },
];

test.each([40, 80, 120])(
  "pending summary preserves exact counts and its action at %i columns",
  (width) => {
    for (const noColor of [true, false]) {
      const text = attentionSummary(
        [permission, { ...permission, diagnostic: "Updated" }, reply],
        width,
        "Alt+A",
        createAdamTuiTheme(noColor),
      );
      expect(text).toBeDefined();
      expect(visibleWidth(text ?? "")).toBeLessThanOrEqual(width);
      const plain = stripTerminalSequences(text ?? "");
      expect(plain).toContain("2 pending");
      expect(plain).toContain("Alt+A open");
      if (width === 120)
        expect(plain).toBe(
          "2 pending · 1 permission / 1 reply · @explore-1: permission · Alt+A open · /agents attention",
        );
      if (noColor) expect(text).not.toContain("\u001b");
    }
    expect(uniqueAttention([permission, permission, reply])).toHaveLength(2);
    expect(attentionSummary([], width, "Alt+A", createAdamTuiTheme())).toBeUndefined();
  },
);

test("only exact necessary waits and the selected conversation upgrade attention", () => {
  expect(blockingAttention([permission], snapshot)).toEqual([]);
  expect(blockingAttention([permission], snapshot, "one")).toEqual([permission]);
  expect(
    blockingAttention([permission], { ...snapshot, waits: [{ mode: "all", targets }] }),
  ).toEqual([permission]);
  expect(
    blockingAttention([permission], { ...snapshot, waits: [{ mode: "any", targets }] }),
  ).toEqual([]);
  const second = { ...permission, threadId: "two", turnId: "turn-two", id: "second" };
  expect(
    blockingAttention([permission, second], { ...snapshot, waits: [{ mode: "any", targets }] }),
  ).toEqual([permission, second]);
  expect(
    blockingAttention([{ ...permission, turnId: "old" }], {
      ...snapshot,
      waits: [{ mode: "all", targets }],
    }),
  ).toEqual([]);
});
