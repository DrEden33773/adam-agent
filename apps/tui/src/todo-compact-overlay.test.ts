import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { createAdamTuiTheme } from "./theme.js";
import { TodoCompactOverlay } from "./todo-compact-overlay.js";
import { TodoCompactViewModel } from "./todo-compact-view-model.js";

test("TodoCompactOverlay renders bounded rows and collapse truth from its view model", () => {
  const viewModel = new TodoCompactViewModel();
  const overlay = new TodoCompactOverlay(viewModel, createAdamTuiTheme(true));
  const summary = todoSummary({ pending: 3, inProgress: 1, completed: 0 }, 1);
  const items = [
    todoItem("10000000-0000-4000-8000-000000000001", "Implement owner", "in_progress"),
    todoItem("10000000-0000-4000-8000-000000000002", "Add tracer", "pending"),
    todoItem("10000000-0000-4000-8000-000000000003", "Run Quality", "pending"),
    todoItem("10000000-0000-4000-8000-000000000004", "Close evidence", "pending"),
  ];
  viewModel.setState({ items, sessionId: "session-a", summary, turnKey: "turn-a" });
  const bounded = overlay.render(80).join("\n");
  expect(bounded).toContain("Todos · 4 unfinished · 1 blocked");
  expect(bounded).toContain("◐ Implement owner");
  expect(bounded).toContain("○ Add tracer");
  expect(bounded).toContain("+1 unfinished hidden");
  expect(overlay.render(80)).toHaveLength(5);
  for (const width of [40, 80, 120]) {
    expect(overlay.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(overlay.render(width).join("\n")).not.toContain("\u001b[");
  }

  viewModel.setState({
    items: items.slice(1, 2),
    sessionId: "session-a",
    summary: todoSummary({ pending: 1, inProgress: 0, completed: 3 }, 2),
    turnKey: "turn-a",
  });
  expect(overlay.render(80).join("\n")).toContain("✓ Implement owner");
  viewModel.setState({
    items: items.slice(1, 2),
    sessionId: "session-a",
    summary: todoSummary({ pending: 1, inProgress: 0, completed: 3 }, 2),
    turnKey: "turn-b",
  });
  expect(overlay.render(80).join("\n")).not.toContain("✓ Implement owner");

  viewModel.setCollapsed(true);
  expect(overlay.render(40)).toHaveLength(1);
  expect(overlay.render(40).join("\n")).toContain("Todos · 1 unfinished · collapsed");
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
