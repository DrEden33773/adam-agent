import type { TodoEntityResource, TodoPageResource } from "@adam-agent/presentation";
import { expect, test, vi } from "vitest";

import { createAdamTuiTheme } from "./theme.js";
import { TodoNavigator } from "./todo-navigator.js";

test("TodoNavigator renders authoritative counts and opens exact read-only detail", async () => {
  const item = {
    id: "10000000-0000-4000-8000-000000000001",
    createdOrdinal: 1,
    itemRevision: 2,
    status: "pending" as const,
    title: "Blocked implementation",
    dependencyCount: 1,
    blocked: true,
  };
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 4,
    items: [item],
    nextCursor: null,
  };
  const entity: TodoEntityResource = {
    type: "todo_entity",
    policyVersion: "todo-policy.v1",
    storeRevision: 4,
    item: {
      id: item.id,
      createdOrdinal: 1,
      itemRevision: 2,
      status: "pending",
      title: item.title,
      details: "Exact detail",
      dependencyIds: ["10000000-0000-4000-8000-000000000002"],
    },
  };
  const changed = Promise.withResolvers<void>();
  const onGet = vi.fn(async () => entity);
  const navigator = new TodoNavigator({
    initialPage: page,
    onChange: () => changed.resolve(),
    onClose: vi.fn(),
    onGet,
    onList: vi.fn(async () => page),
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 4,
      counts: { pending: 2, inProgress: 1, completed: 1 },
      blockedCount: 1,
    },
    theme: createAdamTuiTheme(false),
  });

  const listed = navigator.render(80).join("\n");
  expect(listed).toContain("Todos · revision 4");
  expect(listed).toContain("2 pending · 1 in progress · 1 completed · 1 blocked");
  expect(listed).toContain("Blocked implementation");
  expect(listed).toContain("pending · blocked · revision 2");

  navigator.handleInput("\r");
  await changed.promise;
  expect(onGet).toHaveBeenCalledWith(item.id);
  const detailed = navigator.render(80).join("\n");
  expect(detailed).toContain("Todo detail · read-only");
  expect(detailed).toContain("Exact detail");
  expect(detailed).toContain("10000000-0000-4000-8000-000000000002");
  expect(detailed).toContain("Esc back");
});
