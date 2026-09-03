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

test("TodoNavigator keeps selection visible and pages every exact detail line at minimum height", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdOrdinal: index + 1,
    itemRevision: 1,
    status: "pending" as const,
    title: `Todo item ${index + 1}`,
    dependencyCount: index === 4 ? 1 : 0,
    blocked: false,
  }));
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 5,
    items,
    nextCursor: "next-page",
  };
  const detailLoaded = Promise.withResolvers<void>();
  const pageRead = Promise.withResolvers<TodoPageResource>();
  const onGet = vi.fn(async (id: string): Promise<TodoEntityResource> => {
    detailLoaded.resolve();
    return {
      type: "todo_entity",
      policyVersion: "todo-policy.v1",
      storeRevision: 5,
      item: {
        id,
        createdOrdinal: 5,
        itemRevision: 1,
        status: "pending",
        title: "Todo item 5",
        details: Array.from({ length: 8 }, (_, index) => `Exact detail ${index + 1}`).join("\n"),
        dependencyIds: ["10000000-0000-4000-8000-000000000001"],
      },
    };
  });
  const navigator = new TodoNavigator({
    initialPage: page,
    maximumContentHeight: () => 8,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onGet,
    onList: vi.fn(() => pageRead.promise),
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 5,
      counts: { pending: 5, inProgress: 0, completed: 0 },
      blockedCount: 0,
    },
    theme: createAdamTuiTheme(true),
  });

  for (let index = 0; index < 4; index += 1) {
    navigator.handleInput("\u001b[B");
  }
  const selected = navigator.render(40);
  expect(selected.length).toBeLessThanOrEqual(8);
  expect(selected.join("\n")).toContain("Todo item 5");
  expect(selected.some((line) => line.startsWith("> "))).toBe(true);

  navigator.handleInput("\r");
  await detailLoaded.promise;
  await vi.waitFor(() => expect(onGet).toHaveBeenCalledWith(items[4]?.id));
  const firstDetailPage = navigator.render(40);
  expect(firstDetailPage.length).toBeLessThanOrEqual(8);
  expect(firstDetailPage.join("\n")).toContain("PgUp/PgDn");
  expect(firstDetailPage.join("\n")).not.toContain("Dependencies:");

  navigator.handleInput("\u001b[6~");
  navigator.handleInput("\u001b[6~");
  const lastDetailPage = navigator.render(40).join("\n");
  expect(lastDetailPage).toContain("Dependencies:");
  expect(lastDetailPage).toContain("10000000-0000-4000-8000-000000000001");

  navigator.handleInput("\u001b");
  navigator.handleInput("\u001b[6~");
  const loadingPage = navigator.render(40);
  expect(loadingPage.length).toBeLessThanOrEqual(8);
  expect(loadingPage.join("\n")).toContain("Loading authoritative Todo page…");
  pageRead.resolve({ ...page, nextCursor: null });
});
