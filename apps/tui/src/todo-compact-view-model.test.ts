import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { TodoCompactViewModel } from "./todo-compact-view-model.js";

function item(
  index: number,
  status: TodoPageResource["items"][number]["status"],
): TodoPageResource["items"][number] {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    createdOrdinal: index,
    itemRevision: 1,
    status,
    title: `Task ${index}`,
    dependencyCount: 0,
    blocked: false,
  };
}
function summary(pending: number, completed: number): NonNullable<ActiveSessionDisplay["todo"]> {
  return {
    policyVersion: "todo-policy.v1",
    storeRevision: pending + completed,
    counts: { pending, inProgress: 0, completed },
    blockedCount: 0,
  };
}

test("Todo layout preserves creation order and removes completed rows before unfinished tail", () => {
  const view = new TodoCompactViewModel();
  const items = Array.from({ length: 14 }, (_, index) =>
    item(index + 1, index < 3 ? "completed" : "pending"),
  );
  view.setState({ sessionId: "a", turnKey: "one", summary: summary(11, 3), items });
  expect(view.snapshot()).toMatchObject({
    completedCount: 3,
    totalCount: 14,
    hiddenCompleted: 3,
    hiddenUnfinished: 1,
    rows: Array.from({ length: 10 }, (_, index) => ({ title: `Task ${index + 4}` })),
  });
  view.setState({
    sessionId: "a",
    turnKey: "one",
    summary: summary(5, 8),
    items: Array.from({ length: 13 }, (_, index) =>
      item(index + 1, index % 2 === 0 || index > 9 ? "completed" : "pending"),
    ),
  });
  expect(view.snapshot()).toMatchObject({
    hiddenCompleted: 3,
    hiddenUnfinished: 0,
    rows: Array.from({ length: 10 }, (_, index) => ({ title: `Task ${index + 1}` })),
  });
});

test("bounded Todo candidates retain pre-clipping counts and configurable three-line minimum", () => {
  const view = new TodoCompactViewModel();
  view.setState({
    sessionId: "a",
    turnKey: "one",
    summary: { ...summary(100, 100), overlay: { turnId: "one", completedCount: 100, items: [] } },
    items: Array.from({ length: 22 }, (_, index) =>
      item(index + 1, index < 11 ? "completed" : "pending"),
    ),
  });
  expect(view.snapshot()).toMatchObject({
    totalCount: 200,
    completedCount: 100,
    hiddenCompleted: 100,
    hiddenUnfinished: 90,
  });
  expect(view.snapshot(3)).toMatchObject({
    hiddenCompleted: 100,
    hiddenUnfinished: 99,
    rows: [{ title: "Task 12" }],
  });
});

test("completed Todo visibility is supplied by canonical projection, never inferred from disappearing IDs", () => {
  const view = new TodoCompactViewModel();
  view.setState({
    sessionId: "a",
    turnKey: "one",
    summary: summary(1, 0),
    items: [item(1, "pending")],
  });
  view.setState({ sessionId: "a", turnKey: "one", summary: summary(0, 1), items: [] });
  expect(view.snapshot()).toEqual({ visible: false, collapsed: false });
  view.setState({
    sessionId: "a",
    turnKey: "one",
    summary: summary(0, 1),
    items: [item(1, "completed")],
  });
  expect(view.snapshot()).toMatchObject({
    visible: true,
    completedCount: 1,
    totalCount: 1,
    rows: [{ glyph: "✓" }],
  });
  view.setCollapsed(true);
  expect(view.snapshot()).toMatchObject({ collapsed: true, rows: [] });
  view.setState({
    sessionId: "b",
    turnKey: "two",
    summary: summary(1, 0),
    items: [item(1, "pending")],
  });
  expect(view.snapshot()).toMatchObject({ collapsed: false, completedCount: 0 });
});
