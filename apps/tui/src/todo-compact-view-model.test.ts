import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";
import { expect, test } from "vitest";

import { TodoCompactViewModel } from "./todo-compact-view-model.js";

test("TodoCompactViewModel preserves three-row unfinished priority and one-turn completion linger", () => {
  const viewModel = new TodoCompactViewModel();
  const items = [
    todoItem("10000000-0000-4000-8000-000000000001", "Implement owner", "in_progress"),
    todoItem("10000000-0000-4000-8000-000000000002", "Add tracer", "pending"),
    todoItem("10000000-0000-4000-8000-000000000003", "Run Quality", "pending"),
    todoItem("10000000-0000-4000-8000-000000000004", "Close evidence", "pending"),
  ];
  viewModel.setState({
    items,
    sessionId: "session-a",
    summary: todoSummary({ pending: 3, inProgress: 1, completed: 0 }, 1),
    turnKey: "turn-a",
  });
  expect(viewModel.snapshot()).toMatchObject({
    visible: true,
    collapsed: false,
    hiddenCompleted: 0,
    hiddenUnfinished: 1,
    rows: [
      { glyph: "◐", title: "Implement owner" },
      { glyph: "○", title: "Add tracer" },
      { glyph: "○", title: "Run Quality" },
    ],
  });

  viewModel.setState({
    items: items.slice(1, 2),
    sessionId: "session-a",
    summary: todoSummary({ pending: 1, inProgress: 0, completed: 3 }, 2),
    turnKey: "turn-a",
  });
  expect(viewModel.snapshot()).toMatchObject({
    rows: [
      { glyph: "○", title: "Add tracer" },
      { glyph: "✓", title: "Implement owner" },
      { glyph: "✓", title: "Run Quality" },
    ],
    hiddenCompleted: 1,
    hiddenUnfinished: 0,
  });

  viewModel.setState({
    items: items.slice(1, 2),
    sessionId: "session-a",
    summary: todoSummary({ pending: 1, inProgress: 0, completed: 3 }, 2),
    turnKey: "turn-b",
  });
  expect(viewModel.snapshot()).toMatchObject({
    rows: [{ glyph: "○", title: "Add tracer" }],
    hiddenCompleted: 0,
  });

  viewModel.setCollapsed(true);
  expect(viewModel.snapshot()).toMatchObject({ visible: true, collapsed: true, rows: [] });
});

function todoSummary(
  counts: NonNullable<ActiveSessionDisplay["todo"]>["counts"],
  storeRevision: number,
): NonNullable<ActiveSessionDisplay["todo"]> {
  return { policyVersion: "todo-policy.v1", storeRevision, counts, blockedCount: 1 };
}

function todoItem(
  id: string,
  title: string,
  status: TodoPageResource["items"][number]["status"],
): TodoPageResource["items"][number] {
  return {
    id,
    createdOrdinal: Number(id.at(-1)),
    itemRevision: 1,
    status,
    title,
    dependencyCount: 0,
    blocked: title === "Run Quality",
  };
}
