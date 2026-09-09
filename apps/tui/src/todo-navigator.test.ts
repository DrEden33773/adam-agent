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
      details: "# Todo heading\n\n**Exact detail**",
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
  expect(detailed).not.toContain("**Exact detail**");
  expect(detailed).toContain("\u001b[1m");
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

test("TodoNavigator groups status headings without selecting them and filters exact items", () => {
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 3,
    nextCursor: null,
    items: [
      {
        id: "done",
        createdOrdinal: 1,
        itemRevision: 1,
        status: "completed",
        title: "Shipped",
        dependencyCount: 0,
        blocked: false,
      },
      {
        id: "active",
        createdOrdinal: 2,
        itemRevision: 1,
        status: "in_progress",
        title: "Implement",
        activeForm: "Implementing",
        dependencyCount: 1,
        blocked: false,
      },
      {
        id: "pending",
        createdOrdinal: 3,
        itemRevision: 1,
        status: "pending",
        title: "Investigate",
        dependencyCount: 0,
        blocked: false,
      },
    ],
  };
  const onGet = vi.fn(() => new Promise<TodoEntityResource>(() => {}));
  const navigator = new TodoNavigator({
    initialPage: page,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onGet,
    onList: vi.fn(async () => page),
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 3,
      counts: { pending: 1, inProgress: 1, completed: 1 },
      blockedCount: 0,
    },
    theme: createAdamTuiTheme(true),
  });
  const lines = navigator.render(120);
  expect(lines.filter((line) => /^(Pending|In Progress|Completed)$/.test(line))).toEqual([
    "Pending",
    "In Progress",
    "Completed",
  ]);
  navigator.handleInput("\r");
  expect(onGet).toHaveBeenLastCalledWith("pending");
  navigator.handleInput("\u001b[B");
  navigator.handleInput("\r");
  expect(onGet).toHaveBeenLastCalledWith("active");
  expect(navigator.render(120).join("\n")).toContain("Implementing");
  navigator.handleInput("\u001b[B");
  navigator.handleInput("\r");
  expect(onGet).toHaveBeenLastCalledWith("done");
  navigator.handleInput("Investigate");
  const filtered = navigator.render(120).join("\n");
  expect(filtered).toContain("Pending");
  expect(filtered).not.toContain("In Progress");
  expect(filtered).not.toContain("Shipped");
  navigator.handleInput("\r");
  expect(onGet).toHaveBeenLastCalledWith("pending");
});

test("TodoNavigator keeps grouped page navigation and stale/cancelled reads authoritative", async () => {
  const item = {
    id: "pending",
    createdOrdinal: 1,
    itemRevision: 1,
    status: "pending" as const,
    title: "Pending task",
    dependencyCount: 0,
    blocked: false,
  };
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 2,
    items: [item],
    nextCursor: "page-two",
  };
  const nextPage: TodoPageResource = {
    ...page,
    items: [{ ...item, id: "done", status: "completed", title: "Completed task" }],
    nextCursor: null,
  };
  const reads: ReturnType<typeof Promise.withResolvers<TodoPageResource>>[] = [];
  const onList = vi.fn(() => {
    const read = Promise.withResolvers<TodoPageResource>();
    reads.push(read);
    return read.promise;
  });
  const lateDetail = Promise.withResolvers<TodoEntityResource>();
  const onClose = vi.fn();
  const navigator = new TodoNavigator({
    initialPage: page,
    maximumContentHeight: () => 10,
    onChange: vi.fn(),
    onClose,
    onGet: () => lateDetail.promise,
    onList,
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 2,
      counts: { pending: 1, inProgress: 0, completed: 1 },
      blockedCount: 0,
    },
    theme: createAdamTuiTheme(true),
  });
  navigator.handleInput("\u001b[6~");
  expect(onList).toHaveBeenLastCalledWith("page-two");
  reads[0]?.resolve(nextPage);
  await reads[0]?.promise;
  expect(navigator.render(80).join("\n")).toContain("Completed task");
  navigator.handleInput("\u001b[5~");
  expect(onList).toHaveBeenLastCalledWith(null);
  reads[1]?.reject(new Error("stale cursor"));
  await reads[1]?.promise.catch(() => {});
  expect(navigator.render(80).join("\n")).toContain("Todo data changed or became unavailable.");
  navigator.handleInput("\u001b[5~");
  reads[2]?.resolve(page);
  await reads[2]?.promise;
  expect(navigator.render(80).join("\n")).toContain("Pending task");
  navigator.handleInput("\r");
  navigator.handleInput("\u001b[6~");
  reads[3]?.resolve(nextPage);
  await reads[3]?.promise;
  lateDetail.resolve({
    type: "todo_entity",
    policyVersion: "todo-policy.v1",
    storeRevision: 2,
    item: {
      id: "pending",
      title: "Stale detail",
      status: "pending",
      itemRevision: 1,
      createdOrdinal: 1,
      dependencyIds: [],
    },
  });
  await lateDetail.promise;
  expect(navigator.render(80).join("\n")).not.toContain("Stale detail");
  navigator.handleInput("\u001b[5~");
  navigator.handleInput("\u001b");
  expect(onClose).toHaveBeenCalledOnce();
  reads[4]?.resolve(page);
  await reads[4]?.promise;
  expect(navigator.render(80).join("\n")).toContain("Completed task");
});

test("TodoNavigator uses the effective toggle binding while c remains searchable text", () => {
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 1,
    nextCursor: null,
    items: [
      {
        id: "code",
        createdOrdinal: 1,
        itemRevision: 1,
        status: "pending",
        title: "Code task",
        dependencyCount: 0,
        blocked: false,
      },
    ],
  };
  const onCompactCollapseChange = vi.fn();
  const navigator = new TodoNavigator({
    initialPage: page,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onGet: vi.fn(),
    onList: vi.fn(),
    onCompactCollapseChange,
    toggleHint: "Ctrl+Shift+T",
    isToggleInput: (data) => data === "toggle-event",
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 1,
      counts: { pending: 1, inProgress: 0, completed: 0 },
      blockedCount: 0,
    },
    theme: createAdamTuiTheme(true),
  });
  expect(navigator.render(120).join("\n")).toContain("Ctrl+Shift+T collapse compact");
  navigator.handleInput("c");
  expect(navigator.render(120).join("\n")).toContain("Search: c");
  expect(onCompactCollapseChange).not.toHaveBeenCalled();
  navigator.handleInput("toggle-event");
  expect(onCompactCollapseChange).toHaveBeenLastCalledWith(true);
  expect(navigator.render(120).join("\n")).toContain("Ctrl+Shift+T expand compact");
  navigator.handleInput("toggle-event");
  expect(onCompactCollapseChange).toHaveBeenLastCalledWith(false);
});

test("TodoNavigator preserves distinct titles when active tasks share an active form", async () => {
  const page: TodoPageResource = {
    type: "todo_page",
    policyVersion: "todo-policy.v1",
    storeRevision: 2,
    nextCursor: null,
    items: [
      {
        id: "parser",
        createdOrdinal: 1,
        itemRevision: 1,
        status: "in_progress",
        title: "Repair parser",
        activeForm: "Implementing",
        dependencyCount: 0,
        blocked: false,
      },
      {
        id: "renderer",
        createdOrdinal: 2,
        itemRevision: 1,
        status: "in_progress",
        title: "Repair renderer",
        activeForm: "Implementing",
        dependencyCount: 0,
        blocked: false,
      },
    ],
  };
  const onGet = vi.fn(
    async (id: string): Promise<TodoEntityResource> => ({
      type: "todo_entity",
      policyVersion: "todo-policy.v1",
      storeRevision: 2,
      item: {
        id,
        createdOrdinal: 2,
        itemRevision: 1,
        status: "in_progress",
        title: "Repair renderer",
        activeForm: "Implementing",
        details: "Exact renderer detail",
        dependencyIds: [],
      },
    }),
  );
  const navigator = new TodoNavigator({
    initialPage: page,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onGet,
    onList: vi.fn(async () => page),
    summary: {
      policyVersion: "todo-policy.v1",
      storeRevision: 2,
      counts: { pending: 0, inProgress: 2, completed: 0 },
      blockedCount: 0,
    },
    theme: createAdamTuiTheme(true),
  });
  const overview = navigator.render(120).join("\n");
  expect(overview).toContain("Repair parser (Implementing)");
  expect(overview).toContain("Repair renderer (Implementing)");
  navigator.handleInput("renderer");
  const filtered = navigator.render(120).join("\n");
  expect(filtered).toContain("Repair renderer (Implementing)");
  expect(filtered).not.toContain("Repair parser");
  navigator.handleInput("\r");
  await onGet.mock.results[0]?.value;
  expect(onGet).toHaveBeenCalledExactlyOnceWith("renderer");
  const detail = navigator.render(120).join("\n");
  expect(detail).toContain("Todo detail · read-only");
  expect(detail).toContain("Repair renderer");
  expect(detail).toContain("Exact renderer detail");
});
