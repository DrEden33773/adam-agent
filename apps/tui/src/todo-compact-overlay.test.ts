import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { createAdamTuiTheme } from "./theme.js";
import { TodoCompactOverlay } from "./todo-compact-overlay.js";
import { TodoCompactViewModel } from "./todo-compact-view-model.js";

test("the pinned Todo hierarchy shows 2 of 7 with explicit activeForm and a trailing spacer", () => {
  const viewModel = new TodoCompactViewModel();
  const overlay = new TodoCompactOverlay(viewModel, createAdamTuiTheme(true));
  const items = [
    todoItem("10000000-0000-4000-8000-000000000001", "Read contract", "completed"),
    todoItem("10000000-0000-4000-8000-000000000002", "Capture baseline", "completed"),
    {
      ...todoItem("10000000-0000-4000-8000-000000000003", "Implement owner", "in_progress"),
      activeForm: "Implementing owner",
    },
    ...["Add tracer", "Review change", "Run checks", "Close evidence"].map((title, index) =>
      todoItem(`10000000-0000-4000-8000-${String(index + 4).padStart(12, "0")}`, title, "pending"),
    ),
  ];
  viewModel.setState({
    items,
    sessionId: "session-a",
    summary: todoSummary({ pending: 4, inProgress: 1, completed: 2 }, 7),
    turnKey: "turn-a",
  });
  expect(overlay.render(80)).toEqual([
    "● Todos (2/7)",
    "├─ ✓ Read contract",
    "├─ ✓ Capture baseline",
    "├─ ◐ Implement owner (Implementing owner)",
    "├─ ○ Add tracer",
    "├─ ○ Review change",
    "├─ ○ Run checks",
    "└─ ○ Close evidence",
    "",
  ]);
});

test("Todo overlay uses at most twelve content lines plus spacer and preserves structural NO_COLOR at each width", () => {
  const view = new TodoCompactViewModel();
  const overlay = new TodoCompactOverlay(view, createAdamTuiTheme(true));
  const items = Array.from({ length: 15 }, (_, index) =>
    todoItem(
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      `Task ${index + 1} 中文 e\u0301 🧭`,
      index < 3 ? "completed" : "pending",
    ),
  );
  view.setState({
    items,
    sessionId: "a",
    turnKey: "one",
    summary: todoSummary({ pending: 12, inProgress: 0, completed: 3 }, 15),
  });
  for (const width of [40, 80, 120]) {
    const lines = overlay.render(width);
    expect(lines).toHaveLength(13);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("\u001b[");
    expect(lines[0]).toBe("● Todos (3/15)");
    expect(lines.at(-2)).toContain("+5 more");
    expect(lines.at(-1)).toBe("");
  }
  view.setCollapsed(true);
  expect(overlay.render(80)).toEqual(["● Todos (3/15)", "└─ Alt+T or /todos toggle to expand", ""]);
});

test("Todo overlay colors and strikes completed rows while retaining exact dependency labels", () => {
  const view = new TodoCompactViewModel();
  const first = todoItem("10000000-0000-4000-8000-000000000001", "Read source", "completed");
  const second = {
    ...todoItem("20000000-0000-4000-8000-000000000002", "Verify", "in_progress"),
    activeForm: "Verifying",
    dependencies: [first.id],
    dependencyLabels: ["10000000"],
    label: "20000000",
  };
  view.setState({
    sessionId: "a",
    turnKey: "one",
    summary: todoSummary({ pending: 0, inProgress: 1, completed: 1 }, 2),
    items: [first, second],
  });
  const colored = new TodoCompactOverlay(view, createAdamTuiTheme(false)).render(120).join("\n");
  expect(colored).toContain("\u001b[9m");
  const plain = new TodoCompactOverlay(view, createAdamTuiTheme(true)).render(120).join("\n");
  expect(plain).toContain("◐ #20000000 Verify (Verifying) ⛓ #10000000");
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
    createdOrdinal: Number(id.slice(-12)),
    itemRevision: 1,
    status,
    title,
    dependencyCount: 0,
    blocked: title === "Run Quality",
  };
}
