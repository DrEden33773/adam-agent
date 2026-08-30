import { describe, expect, test } from "vitest";

import type { SessionRecord } from "./session-store.js";

import {
  createTodoMutationV1,
  listTodosV1,
  type TodoStoreSnapshotV1,
  todoLimitsV1,
  todoPolicyVersionV1,
  todoStoreSnapshotFromRecordsV1,
  todoSummaryV1,
  updateTodoMutationV1,
} from "./todo.js";

describe("Todo v1", () => {
  test("create rejects the 4,097th live entity without changing folded state", () => {
    const items = Array.from({ length: todoLimitsV1.maximumEntities }, (_, index) => ({
      id: todoId(index),
      createdOrdinal: index + 1,
      itemRevision: 1,
      status: "pending" as const,
      title: `Todo ${index + 1}`,
      dependencyIds: [],
    }));
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: items.length,
      items,
    };

    expect(createTodoMutationV1(snapshot, { title: "One too many" }, todoId(items.length))).toEqual(
      {
        status: "failed",
        error: {
          code: "todo_entity_limit_exceeded",
          message: "The Todo store already contains the maximum 4,096 live entities.",
        },
      },
    );
    expect(snapshot.items).toBe(items);
    expect(snapshot.storeRevision).toBe(todoLimitsV1.maximumEntities);
  });

  test("create rejects a folded live-state overflow without changing the store revision", () => {
    const details = "x".repeat(todoLimitsV1.maximumDetailsBytes);
    const items = Array.from({ length: 1_005 }, (_, index) => ({
      id: todoId(index),
      createdOrdinal: index + 1,
      itemRevision: 1,
      status: "pending" as const,
      title: "T",
      details,
      dependencyIds: [],
    }));
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: items.length,
      items,
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      todoLimitsV1.maximumFoldedStateBytes,
    );

    expect(
      createTodoMutationV1(snapshot, { title: "Overflow", details }, todoId(items.length)),
    ).toEqual({
      status: "failed",
      error: {
        code: "todo_aggregate_limit_exceeded",
        message: "The mutation would exceed the 8 MiB folded live Todo-state limit.",
      },
    });
    expect(snapshot.storeRevision).toBe(items.length);
  });

  test("update rejects a folded live-state overflow without changing either revision", () => {
    const details = "x".repeat(todoLimitsV1.maximumDetailsBytes);
    const items = [
      ...Array.from({ length: 1_005 }, (_, index) => ({
        id: todoId(index),
        createdOrdinal: index + 1,
        itemRevision: 1,
        status: "pending" as const,
        title: "T",
        details,
        dependencyIds: [],
      })),
      {
        id: todoId(1_005),
        createdOrdinal: 1_006,
        itemRevision: 1,
        status: "pending" as const,
        title: "T",
        details: "x".repeat(7_600),
        dependencyIds: [],
      },
    ];
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: items.length,
      items,
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      todoLimitsV1.maximumFoldedStateBytes,
    );

    expect(
      updateTodoMutationV1(snapshot, {
        id: todoId(1_005),
        expectedItemRevision: 1,
        expectedStoreRevision: items.length,
        title: "y".repeat(todoLimitsV1.maximumTitleBytes),
      }),
    ).toEqual({
      status: "failed",
      error: {
        code: "todo_aggregate_limit_exceeded",
        message: "The mutation would exceed the 8 MiB folded live Todo-state limit.",
      },
    });
    expect(snapshot.storeRevision).toBe(items.length);
    expect(snapshot.items.at(-1)?.itemRevision).toBe(1);
  });

  test.each([
    ["pending", "in_progress"],
    ["in_progress", "pending"],
    ["pending", "completed"],
    ["in_progress", "completed"],
    ["completed", "pending"],
    ["completed", "in_progress"],
  ] as const)("update permits the explicit %s to %s transition", (from, to) => {
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: 7,
      items: [
        {
          id: todoId(0),
          createdOrdinal: 1,
          itemRevision: 3,
          status: from,
          title: "Transition",
          dependencyIds: [],
        },
      ],
    };

    expect(
      updateTodoMutationV1(snapshot, {
        id: todoId(0),
        expectedItemRevision: 3,
        expectedStoreRevision: 7,
        status: to,
      }),
    ).toMatchObject({
      status: "completed",
      snapshot: { storeRevision: 8 },
      item: { itemRevision: 4, status: to },
    });
  });

  test("update rejects an explicit no-op without advancing revisions", () => {
    const item = {
      id: todoId(0),
      createdOrdinal: 1,
      itemRevision: 3,
      status: "pending" as const,
      title: "Unchanged",
      dependencyIds: [],
    };
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: 7,
      items: [item],
    };

    expect(
      updateTodoMutationV1(snapshot, {
        id: item.id,
        expectedItemRevision: item.itemRevision,
        expectedStoreRevision: snapshot.storeRevision,
        status: item.status,
      }),
    ).toEqual({
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "update_todo requires a state-changing mutation.",
      },
    });
    expect(snapshot).toEqual({ ...snapshot, storeRevision: 7, items: [item] });
  });

  test("list enforces the 16 KiB page bound and resumes from a stateless cursor", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: todoId(index),
      createdOrdinal: index + 1,
      itemRevision: 1,
      status: "pending" as const,
      title: `${index.toString().padStart(2, "0")}-${"x".repeat(
        todoLimitsV1.maximumTitleBytes - 3,
      )}`,
      dependencyIds: [],
    }));
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: 50,
      items,
    };

    const first = listTodosV1(snapshot, { limit: 50 }, "session-a");
    expect(first.status).toBe("completed");
    if (first.status !== "completed") {
      throw new Error("Expected the first Todo page.");
    }
    expect(Buffer.byteLength(JSON.stringify(first.output), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(first.output.items.length).toBeGreaterThan(0);
    expect(first.output.items.length).toBeLessThan(50);
    expect(first.output.nextCursor).toEqual(expect.any(String));

    const second = listTodosV1(
      snapshot,
      { limit: 50, cursor: first.output.nextCursor },
      "session-a",
    );
    expect(second.status).toBe("completed");
    if (second.status !== "completed") {
      throw new Error("Expected the second Todo page.");
    }
    expect(Buffer.byteLength(JSON.stringify(second.output), "utf8")).toBeLessThanOrEqual(16 * 1024);
    const lastFirstOrdinal = first.output.items.at(-1)?.createdOrdinal;
    expect(second.output.items[0]?.createdOrdinal).toBe(
      lastFirstOrdinal === undefined ? undefined : lastFirstOrdinal + 1,
    );
    expect(
      new Set([...first.output.items, ...second.output.items].map((item) => item.id)).size,
    ).toBe(first.output.items.length + second.output.items.length);
  });

  test("list returns typed stale after a mutation or across a session boundary", () => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      id: todoId(index),
      createdOrdinal: index + 1,
      itemRevision: 1,
      status: "pending" as const,
      title: `Todo ${index + 1}`,
      dependencyIds: [],
    }));
    const snapshot: TodoStoreSnapshotV1 = {
      policyVersion: todoPolicyVersionV1,
      storeRevision: 21,
      items,
    };
    const first = listTodosV1(snapshot, {}, "parent-session");
    expect(first.status).toBe("completed");
    if (first.status !== "completed" || first.output.nextCursor === null) {
      throw new Error("Expected a Todo continuation cursor.");
    }

    expect(
      listTodosV1(
        { ...snapshot, storeRevision: snapshot.storeRevision + 1 },
        { cursor: first.output.nextCursor },
        "parent-session",
      ),
    ).toEqual({
      status: "failed",
      error: {
        code: "todo_cursor_stale",
        message: "The Todo cursor is stale for this session or store revision.",
      },
    });
    expect(listTodosV1(snapshot, { cursor: first.output.nextCursor }, "child-session")).toEqual({
      status: "failed",
      error: {
        code: "todo_cursor_stale",
        message: "The Todo cursor is stale for this session or store revision.",
      },
    });
  });

  test("fold reconstructs exact create and update records without summary authority", () => {
    const created = {
      id: todoId(0),
      createdOrdinal: 1,
      itemRevision: 1,
      status: "pending" as const,
      title: "Durable Todo",
      dependencyIds: [],
    };
    const updated = { ...created, itemRevision: 2, status: "completed" as const };
    const records: SessionRecord[] = [
      {
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "todo_created",
          recordVersion: 1,
          policyVersion: todoPolicyVersionV1,
          runId: todoId(10),
          callId: "create-fold",
          storeRevision: 1,
          item: created,
        },
      },
      {
        schemaVersion: 3,
        sequence: 2,
        record: {
          type: "todo_updated",
          recordVersion: 1,
          policyVersion: todoPolicyVersionV1,
          runId: todoId(11),
          callId: "update-fold",
          expectedStoreRevision: 1,
          expectedItemRevision: 1,
          storeRevision: 2,
          item: updated,
        },
      },
    ];

    expect(todoStoreSnapshotFromRecordsV1(records)).toEqual({
      policyVersion: todoPolicyVersionV1,
      storeRevision: 2,
      items: [updated],
    });
  });

  test("runtime-produced snapshots project their cached summary without rescanning entities", () => {
    const snapshot = todoStoreSnapshotFromRecordsV1([
      {
        schemaVersion: 3,
        sequence: 1,
        record: {
          type: "todo_created",
          recordVersion: 1,
          policyVersion: todoPolicyVersionV1,
          runId: todoId(10),
          callId: "create-summary-cache",
          storeRevision: 1,
          item: {
            id: todoId(0),
            createdOrdinal: 1,
            itemRevision: 1,
            status: "pending",
            title: "Cached summary",
            dependencyIds: [],
          },
        },
      },
    ]);
    Object.defineProperty(snapshot, "items", {
      get() {
        throw new Error("Todo summary rescanned the folded entity collection.");
      },
    });

    expect(todoSummaryV1(snapshot)).toEqual({
      policyVersion: todoPolicyVersionV1,
      storeRevision: 1,
      counts: { pending: 1, inProgress: 0, completed: 0 },
      blockedCount: 0,
    });
  });
});

function todoId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
