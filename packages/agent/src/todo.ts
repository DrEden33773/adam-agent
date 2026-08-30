import { createHash } from "node:crypto";

import { z } from "zod";

import type { ModelMessage } from "./agent-session-contracts.js";
import type { SessionRecord } from "./session-store.js";
import type { ModelToolDefinition } from "./tool-runtime.js";

export const todoPolicyVersionV1 = "todo-policy.v1" as const;

export const todoToolNamesV1 = ["create_todo", "get_todo", "list_todos", "update_todo"] as const;

export const todoLimitsV1 = {
  maximumEntities: 4_096,
  maximumFoldedStateBytes: 8 * 1024 * 1024,
  maximumListPageBytes: 16 * 1024,
  maximumTitleBytes: 512,
  maximumDetailsBytes: 8 * 1024,
  maximumDirectDependencies: 64,
} as const;

const boundedUtf8String = (maximumBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);

export const createTodoInputV1Schema = z.strictObject({
  title: boundedUtf8String(todoLimitsV1.maximumTitleBytes).refine((value) => value.length > 0),
  details: boundedUtf8String(todoLimitsV1.maximumDetailsBytes).optional(),
  dependencyIds: z.array(z.uuid()).max(todoLimitsV1.maximumDirectDependencies).optional(),
});

export const createTodoToolDefinitionV1: ModelToolDefinition = {
  name: "create_todo",
  description:
    "Create one durable pending Todo with a bounded title, optional details, and exact dependency IDs.",
  inputSchema: z.toJSONSchema(createTodoInputV1Schema),
};

export const getTodoInputV1Schema = z.strictObject({ id: z.uuid() });

export const getTodoToolDefinitionV1: ModelToolDefinition = {
  name: "get_todo",
  description: "Read one exact full Todo entity by its stable runtime ID.",
  inputSchema: z.toJSONSchema(getTodoInputV1Schema),
};

export const listTodoInputV1Schema = z.strictObject({
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  titleContains: boundedUtf8String(todoLimitsV1.maximumTitleBytes).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(4_096).optional(),
});

export const listTodoToolDefinitionV1: ModelToolDefinition = {
  name: "list_todos",
  description:
    "List bounded Todo summaries in stable creation order with optional exact status and literal title filters.",
  inputSchema: z.toJSONSchema(listTodoInputV1Schema),
};

export const updateTodoInputV1Schema = z
  .strictObject({
    id: z.uuid(),
    expectedItemRevision: z.number().int().positive(),
    expectedStoreRevision: z.number().int().nonnegative(),
    title: boundedUtf8String(todoLimitsV1.maximumTitleBytes)
      .refine((value) => value.length > 0)
      .optional(),
    details: boundedUtf8String(todoLimitsV1.maximumDetailsBytes).nullable().optional(),
    dependencyIds: z.array(z.uuid()).max(todoLimitsV1.maximumDirectDependencies).optional(),
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.details !== undefined ||
      input.dependencyIds !== undefined ||
      input.status !== undefined,
  );

export const updateTodoToolDefinitionV1: ModelToolDefinition = {
  name: "update_todo",
  description:
    "Update one exact Todo using both expected item revision and expected store revision CAS.",
  inputSchema: z.toJSONSchema(updateTodoInputV1Schema),
};

export const todoItemV1Schema = z.strictObject({
  id: z.uuid(),
  createdOrdinal: z.number().int().positive(),
  itemRevision: z.number().int().positive(),
  status: z.enum(["pending", "in_progress", "completed"]),
  title: boundedUtf8String(todoLimitsV1.maximumTitleBytes).refine((value) => value.length > 0),
  details: boundedUtf8String(todoLimitsV1.maximumDetailsBytes).optional(),
  dependencyIds: z.array(z.uuid()).max(todoLimitsV1.maximumDirectDependencies),
});

export type TodoItemV1 = z.infer<typeof todoItemV1Schema>;

export type TodoStoreSnapshotV1 = {
  readonly policyVersion: typeof todoPolicyVersionV1;
  readonly storeRevision: number;
  readonly items: readonly TodoItemV1[];
};

export type TodoMutationFailureV1 = {
  readonly status: "failed";
  readonly error: {
    readonly code:
      | "invalid_tool_input"
      | "todo_aggregate_limit_exceeded"
      | "todo_completed_dependent"
      | "todo_dependency_cycle"
      | "todo_dependency_incomplete"
      | "todo_entity_limit_exceeded"
      | "todo_revision_stale";
    readonly message: string;
  };
};

export type TodoMutationSuccessV1 = {
  readonly status: "completed";
  readonly snapshot: TodoStoreSnapshotV1;
  readonly item: TodoItemV1;
};

export type TodoListSummaryV1 = {
  readonly id: string;
  readonly createdOrdinal: number;
  readonly itemRevision: number;
  readonly status: TodoItemV1["status"];
  readonly title: string;
  readonly dependencyCount: number;
  readonly blocked: boolean;
};

export type TodoListResultV1 =
  | {
      readonly status: "completed";
      readonly output: {
        readonly policyVersion: typeof todoPolicyVersionV1;
        readonly storeRevision: number;
        readonly items: readonly TodoListSummaryV1[];
        readonly nextCursor: string | null;
      };
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code: "invalid_tool_input" | "todo_cursor_invalid" | "todo_cursor_stale";
        readonly message: string;
      };
    };

export type TodoGetResultV1 =
  | {
      readonly status: "completed";
      readonly output: {
        readonly policyVersion: typeof todoPolicyVersionV1;
        readonly storeRevision: number;
        readonly item: Omit<TodoItemV1, "details"> & { readonly details?: string };
      };
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code: "invalid_tool_input" | "not_found";
        readonly message: string;
      };
    };

export type TodoSummaryV1 = {
  readonly policyVersion: typeof todoPolicyVersionV1;
  readonly storeRevision: number;
  readonly counts: {
    readonly pending: number;
    readonly inProgress: number;
    readonly completed: number;
  };
  readonly blockedCount: number;
};

const todoFoldedStateBytesCache = new WeakMap<TodoStoreSnapshotV1, number>();
const todoSummaryCache = new WeakMap<TodoStoreSnapshotV1, TodoSummaryV1>();

export function emptyTodoStoreSnapshotV1(): TodoStoreSnapshotV1 {
  const snapshot: TodoStoreSnapshotV1 = {
    policyVersion: todoPolicyVersionV1,
    storeRevision: 0,
    items: [],
  };
  todoFoldedStateBytesCache.set(snapshot, todoFoldedStateBytesV1(snapshot));
  todoSummaryCache.set(snapshot, computeTodoSummaryV1(snapshot));
  return snapshot;
}

export function hasTodoToolProfileV1(definitions: readonly { readonly name: string }[]): boolean {
  const names = new Set(definitions.map((definition) => definition.name));
  return todoToolNamesV1.every((name) => names.has(name));
}

export function todoStoreSnapshotFromRecordsV1(
  records: readonly SessionRecord[],
): TodoStoreSnapshotV1 {
  let storeRevision = 0;
  const items = new Map<string, TodoItemV1>();
  for (const entry of records) {
    if (entry.schemaVersion === 3 && entry.record.type === "todo_store_inherited") {
      if (entry.record.chunkIndex === 0) {
        items.clear();
      }
      storeRevision = entry.record.storeRevision;
      for (const item of entry.record.items) {
        items.set(item.id, item);
      }
      continue;
    }
    if (
      entry.schemaVersion !== 3 ||
      (entry.record.type !== "todo_created" && entry.record.type !== "todo_updated")
    ) {
      continue;
    }
    storeRevision = entry.record.storeRevision;
    items.set(entry.record.item.id, entry.record.item);
  }
  const snapshot: TodoStoreSnapshotV1 = {
    policyVersion: todoPolicyVersionV1,
    storeRevision,
    items: [...items.values()].toSorted(
      (left, right) =>
        left.createdOrdinal - right.createdOrdinal || left.id.localeCompare(right.id),
    ),
  };
  todoSummaryCache.set(snapshot, computeTodoSummaryV1(snapshot));
  return snapshot;
}

export function isTodoStoreSnapshotV1Valid(snapshot: TodoStoreSnapshotV1): boolean {
  if (
    snapshot.policyVersion !== todoPolicyVersionV1 ||
    !Number.isSafeInteger(snapshot.storeRevision) ||
    snapshot.storeRevision < snapshot.items.length ||
    snapshot.items.length > todoLimitsV1.maximumEntities ||
    todoFoldedStateBytesV1(snapshot) > todoLimitsV1.maximumFoldedStateBytes
  ) {
    return false;
  }
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  if (byId.size !== snapshot.items.length) {
    return false;
  }
  return snapshot.items.every(
    (item, index) =>
      todoItemV1Schema.safeParse(item).success &&
      item.createdOrdinal === index + 1 &&
      new Set(item.dependencyIds).size === item.dependencyIds.length &&
      item.dependencyIds.every(
        (dependencyId) => dependencyId !== item.id && byId.has(dependencyId),
      ) &&
      !wouldCreateTodoDependencyCycleV1(snapshot, item.id, item.dependencyIds) &&
      ((item.status !== "in_progress" && item.status !== "completed") ||
        item.dependencyIds.every((dependencyId) => byId.get(dependencyId)?.status === "completed")),
  );
}

export function todoStoreSnapshotDigestV1(snapshot: TodoStoreSnapshotV1): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

export function createTodoMutationV1(
  snapshot: TodoStoreSnapshotV1,
  input: unknown,
  id: string,
): TodoMutationSuccessV1 | TodoMutationFailureV1 {
  const parsed = createTodoInputV1Schema.safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(id).success) {
    return {
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "create_todo requires a bounded title, optional details, and dependency IDs.",
      },
    };
  }
  if (snapshot.items.length >= todoLimitsV1.maximumEntities) {
    return {
      status: "failed",
      error: {
        code: "todo_entity_limit_exceeded",
        message: "The Todo store already contains the maximum 4,096 live entities.",
      },
    };
  }
  const dependencyIds = parsed.data.dependencyIds ?? [];
  if (
    new Set(dependencyIds).size !== dependencyIds.length ||
    dependencyIds.some((dependencyId) => snapshot.items.every((item) => item.id !== dependencyId))
  ) {
    return {
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "create_todo requires unique existing dependency IDs.",
      },
    };
  }
  const item: TodoItemV1 = {
    id,
    createdOrdinal: snapshot.items.length + 1,
    itemRevision: 1,
    status: "pending",
    title: parsed.data.title,
    ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
    dependencyIds,
  };
  const nextSnapshot: TodoStoreSnapshotV1 = {
    policyVersion: todoPolicyVersionV1,
    storeRevision: snapshot.storeRevision + 1,
    items: [...snapshot.items, item],
  };
  const nextFoldedStateBytes =
    todoFoldedStateBytesV1(snapshot) +
    Buffer.byteLength(JSON.stringify(item), "utf8") +
    (snapshot.items.length === 0 ? 0 : 1) +
    todoStoreRevisionByteDelta(snapshot.storeRevision, nextSnapshot.storeRevision);
  if (nextFoldedStateBytes > todoLimitsV1.maximumFoldedStateBytes) {
    return {
      status: "failed",
      error: {
        code: "todo_aggregate_limit_exceeded",
        message: "The mutation would exceed the 8 MiB folded live Todo-state limit.",
      },
    };
  }
  todoFoldedStateBytesCache.set(nextSnapshot, nextFoldedStateBytes);
  todoSummaryCache.set(nextSnapshot, computeTodoSummaryV1(nextSnapshot));
  return { status: "completed", snapshot: nextSnapshot, item };
}

export function updateTodoMutationV1(
  snapshot: TodoStoreSnapshotV1,
  input: unknown,
): TodoMutationSuccessV1 | TodoMutationFailureV1 {
  const parsed = updateTodoInputV1Schema.safeParse(input);
  const current = parsed.success
    ? snapshot.items.find((item) => item.id === parsed.data.id)
    : undefined;
  if (!parsed.success || current === undefined) {
    return invalidTodoUpdate();
  }
  if (
    parsed.data.expectedStoreRevision !== snapshot.storeRevision ||
    parsed.data.expectedItemRevision !== current.itemRevision
  ) {
    return {
      status: "failed",
      error: {
        code: "todo_revision_stale",
        message: "The Todo item or store revision is stale. Read current Todo state and retry.",
      },
    };
  }
  const dependencyIds = parsed.data.dependencyIds ?? current.dependencyIds;
  const status = parsed.data.status ?? current.status;
  const transitionAllowed =
    status === current.status ||
    (current.status === "pending" && (status === "in_progress" || status === "completed")) ||
    (current.status === "in_progress" && (status === "pending" || status === "completed")) ||
    (current.status === "completed" && (status === "pending" || status === "in_progress"));
  const dependenciesValid =
    new Set(dependencyIds).size === dependencyIds.length &&
    dependencyIds.every(
      (dependencyId) =>
        dependencyId !== current.id && snapshot.items.some((item) => item.id === dependencyId),
    );
  if (!transitionAllowed || !dependenciesValid) {
    return invalidTodoUpdate();
  }
  if (wouldCreateTodoDependencyCycleV1(snapshot, current.id, dependencyIds)) {
    return {
      status: "failed",
      error: {
        code: "todo_dependency_cycle",
        message: "Todo dependencies must remain acyclic.",
      },
    };
  }
  if (
    current.status === "completed" &&
    status !== "completed" &&
    hasCompletedTodoDependentV1(snapshot, current.id)
  ) {
    return {
      status: "failed",
      error: {
        code: "todo_completed_dependent",
        message: "Completed dependent Todos must be reopened before this prerequisite.",
      },
    };
  }
  if (
    (status === "in_progress" || status === "completed") &&
    dependencyIds.some(
      (dependencyId) =>
        snapshot.items.find((item) => item.id === dependencyId)?.status !== "completed",
    )
  ) {
    return {
      status: "failed",
      error: {
        code: "todo_dependency_incomplete",
        message: "Todo dependencies must be completed before this status transition.",
      },
    };
  }
  const details =
    parsed.data.details === null ? undefined : (parsed.data.details ?? current.details);
  const title = parsed.data.title ?? current.title;
  if (
    title === current.title &&
    details === current.details &&
    status === current.status &&
    dependencyIds.length === current.dependencyIds.length &&
    dependencyIds.every((dependencyId, index) => dependencyId === current.dependencyIds[index])
  ) {
    return {
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "update_todo requires a state-changing mutation.",
      },
    };
  }
  const item: TodoItemV1 = {
    id: current.id,
    createdOrdinal: current.createdOrdinal,
    itemRevision: current.itemRevision + 1,
    status,
    title,
    ...(details === undefined ? {} : { details }),
    dependencyIds,
  };
  const nextSnapshot: TodoStoreSnapshotV1 = {
    policyVersion: todoPolicyVersionV1,
    storeRevision: snapshot.storeRevision + 1,
    items: snapshot.items.map((candidate) => (candidate.id === item.id ? item : candidate)),
  };
  const nextFoldedStateBytes =
    todoFoldedStateBytesV1(snapshot) -
    Buffer.byteLength(JSON.stringify(current), "utf8") +
    Buffer.byteLength(JSON.stringify(item), "utf8") +
    todoStoreRevisionByteDelta(snapshot.storeRevision, nextSnapshot.storeRevision);
  if (nextFoldedStateBytes > todoLimitsV1.maximumFoldedStateBytes) {
    return {
      status: "failed",
      error: {
        code: "todo_aggregate_limit_exceeded",
        message: "The mutation would exceed the 8 MiB folded live Todo-state limit.",
      },
    };
  }
  todoFoldedStateBytesCache.set(nextSnapshot, nextFoldedStateBytes);
  todoSummaryCache.set(nextSnapshot, computeTodoSummaryV1(nextSnapshot));
  return { status: "completed", snapshot: nextSnapshot, item };
}

function todoFoldedStateBytesV1(snapshot: TodoStoreSnapshotV1): number {
  const cached = todoFoldedStateBytesCache.get(snapshot);
  if (cached !== undefined) {
    return cached;
  }
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({
      policyVersion: snapshot.policyVersion,
      storeRevision: snapshot.storeRevision,
      items: [],
    }),
    "utf8",
  );
  const itemBytes = snapshot.items.reduce(
    (total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"),
    0,
  );
  const bytes = envelopeBytes + itemBytes + Math.max(0, snapshot.items.length - 1);
  todoFoldedStateBytesCache.set(snapshot, bytes);
  return bytes;
}

function todoStoreRevisionByteDelta(current: number, next: number): number {
  return Buffer.byteLength(String(next), "utf8") - Buffer.byteLength(String(current), "utf8");
}

function invalidTodoUpdate(): TodoMutationFailureV1 {
  return {
    status: "failed",
    error: {
      code: "invalid_tool_input",
      message: "update_todo requires an exact current Todo CAS and a valid explicit mutation.",
    },
  };
}

const todoCursorV1Schema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().min(1).max(512),
  policyVersion: z.literal(todoPolicyVersionV1),
  storeRevision: z.number().int().nonnegative(),
  status: z.enum(["pending", "in_progress", "completed"]).nullable(),
  titleContains: boundedUtf8String(todoLimitsV1.maximumTitleBytes).nullable(),
  order: z.literal("createdOrdinal,id"),
  offset: z.number().int().positive(),
});

type TodoCursorV1 = z.infer<typeof todoCursorV1Schema>;

export function listTodosV1(
  snapshot: TodoStoreSnapshotV1,
  input: unknown,
  sessionId: string,
): TodoListResultV1 {
  const parsed = listTodoInputV1Schema.safeParse(input);
  if (!parsed.success || sessionId.length === 0 || Buffer.byteLength(sessionId, "utf8") > 512) {
    return {
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "list_todos requires bounded filters, limit, and a valid cursor.",
      },
    };
  }
  let offset = 0;
  if (parsed.data.cursor !== undefined) {
    const cursor = decodeTodoCursorV1(parsed.data.cursor);
    if (cursor === undefined) {
      return todoCursorFailure("todo_cursor_invalid", "The Todo cursor is invalid.");
    }
    if (
      cursor.sessionId !== sessionId ||
      cursor.policyVersion !== snapshot.policyVersion ||
      cursor.storeRevision !== snapshot.storeRevision
    ) {
      return todoCursorFailure(
        "todo_cursor_stale",
        "The Todo cursor is stale for this session or store revision.",
      );
    }
    if (
      cursor.status !== (parsed.data.status ?? null) ||
      cursor.titleContains !== (parsed.data.titleContains ?? null) ||
      cursor.order !== "createdOrdinal,id"
    ) {
      return todoCursorFailure(
        "todo_cursor_invalid",
        "The Todo cursor does not match the requested filters and order.",
      );
    }
    offset = cursor.offset;
  }
  const completedIds = new Set(
    snapshot.items.filter((item) => item.status === "completed").map((item) => item.id),
  );
  const candidates = snapshot.items
    .filter(
      (item) =>
        (parsed.data.status === undefined || item.status === parsed.data.status) &&
        (parsed.data.titleContains === undefined || item.title.includes(parsed.data.titleContains)),
    )
    .toSorted(
      (left, right) =>
        left.createdOrdinal - right.createdOrdinal || left.id.localeCompare(right.id),
    );
  if (offset > candidates.length) {
    return todoCursorFailure("todo_cursor_invalid", "The Todo cursor offset is invalid.");
  }
  const limit = parsed.data.limit ?? 20;
  const items: TodoListSummaryV1[] = [];
  let output = todoListOutput(snapshot, items, null);
  for (const candidate of candidates.slice(offset, offset + limit)) {
    const nextItems = [
      ...items,
      {
        id: candidate.id,
        createdOrdinal: candidate.createdOrdinal,
        itemRevision: candidate.itemRevision,
        status: candidate.status,
        title: candidate.title,
        dependencyCount: candidate.dependencyIds.length,
        blocked: candidate.dependencyIds.some((dependencyId) => !completedIds.has(dependencyId)),
      },
    ];
    const nextOffset = offset + nextItems.length;
    const nextCursor =
      nextOffset < candidates.length
        ? encodeTodoCursorV1({
            version: 1,
            sessionId,
            policyVersion: todoPolicyVersionV1,
            storeRevision: snapshot.storeRevision,
            status: parsed.data.status ?? null,
            titleContains: parsed.data.titleContains ?? null,
            order: "createdOrdinal,id",
            offset: nextOffset,
          })
        : null;
    const nextOutput = todoListOutput(snapshot, nextItems, nextCursor);
    if (Buffer.byteLength(JSON.stringify(nextOutput), "utf8") > todoLimitsV1.maximumListPageBytes) {
      break;
    }
    items.push(nextItems.at(-1) as TodoListSummaryV1);
    output = nextOutput;
  }
  if (items.length === 0 && offset < candidates.length) {
    return {
      status: "failed",
      error: {
        code: "invalid_tool_input",
        message: "One Todo summary exceeds the v1 list page bound.",
      },
    };
  }
  return { status: "completed", output };
}

export function getTodoV1(snapshot: TodoStoreSnapshotV1, input: unknown): TodoGetResultV1 {
  const parsed = getTodoInputV1Schema.safeParse(input);
  const found = parsed.success
    ? snapshot.items.find((item) => item.id === parsed.data.id)
    : undefined;
  if (!parsed.success || found === undefined) {
    return {
      status: "failed",
      error: {
        code: parsed.success ? "not_found" : "invalid_tool_input",
        message: parsed.success
          ? "The requested Todo does not exist in this session."
          : "get_todo requires one exact Todo ID.",
      },
    };
  }
  const item: Extract<TodoGetResultV1, { readonly status: "completed" }>["output"]["item"] = {
    id: found.id,
    createdOrdinal: found.createdOrdinal,
    itemRevision: found.itemRevision,
    status: found.status,
    title: found.title,
    ...(found.details === undefined ? {} : { details: found.details }),
    dependencyIds: found.dependencyIds,
  };
  return {
    status: "completed",
    output: { policyVersion: todoPolicyVersionV1, storeRevision: snapshot.storeRevision, item },
  };
}

function todoListOutput(
  snapshot: TodoStoreSnapshotV1,
  items: readonly TodoListSummaryV1[],
  nextCursor: string | null,
): Extract<TodoListResultV1, { readonly status: "completed" }>["output"] {
  return {
    policyVersion: todoPolicyVersionV1,
    storeRevision: snapshot.storeRevision,
    items,
    nextCursor,
  };
}

function todoCursorFailure(
  code: "todo_cursor_invalid" | "todo_cursor_stale",
  message: string,
): Extract<TodoListResultV1, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
}

function encodeTodoCursorV1(cursor: TodoCursorV1): string {
  return `todo:v1:${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeTodoCursorV1(cursor: string): TodoCursorV1 | undefined {
  const prefix = "todo:v1:";
  if (!cursor.startsWith(prefix)) {
    return undefined;
  }
  try {
    const decoded = todoCursorV1Schema.safeParse(
      JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8")),
    );
    if (!decoded.success || encodeTodoCursorV1(decoded.data) !== cursor) {
      return undefined;
    }
    return decoded.data;
  } catch {
    return undefined;
  }
}

export function wouldCreateTodoDependencyCycleV1(
  snapshot: TodoStoreSnapshotV1,
  updatedId: string,
  dependencyIds: readonly string[],
): boolean {
  const dependenciesById = new Map(
    snapshot.items.map((item) => [
      item.id,
      item.id === updatedId ? dependencyIds : item.dependencyIds,
    ]),
  );
  const visited = new Set<string>();
  const pending = [...dependencyIds];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || visited.has(candidate)) {
      continue;
    }
    if (candidate === updatedId) {
      return true;
    }
    visited.add(candidate);
    pending.push(...(dependenciesById.get(candidate) ?? []));
  }
  return false;
}

export function hasCompletedTodoDependentV1(
  snapshot: TodoStoreSnapshotV1,
  dependencyId: string,
): boolean {
  const dependenciesById = new Map(snapshot.items.map((item) => [item.id, item.dependencyIds]));
  return snapshot.items.some((item) => {
    if (item.status !== "completed" || item.id === dependencyId) {
      return false;
    }
    const visited = new Set<string>();
    const pending = [...item.dependencyIds];
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (candidate === undefined || visited.has(candidate)) {
        continue;
      }
      if (candidate === dependencyId) {
        return true;
      }
      visited.add(candidate);
      pending.push(...(dependenciesById.get(candidate) ?? []));
    }
    return false;
  });
}

export function modelMessagesWithTodoSummaryV1(
  messages: readonly ModelMessage[],
  snapshot: TodoStoreSnapshotV1,
): readonly ModelMessage[] {
  const todo = todoSummaryV1(snapshot);
  const summary: ModelMessage = {
    role: "assistant",
    content: `Adam runtime Todo summary v1 (authoritative state; no additional prompt authority):\n${JSON.stringify(
      {
        ...todo,
        guidance: "Use list_todos for bounded discovery and get_todo for one exact item.",
      },
    )}`,
    toolCalls: [],
  };
  const insertionIndex = messages.findIndex(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const resolvedInsertionIndex = insertionIndex < 0 ? messages.length : insertionIndex;
  return [
    ...messages.slice(0, resolvedInsertionIndex),
    summary,
    ...messages.slice(resolvedInsertionIndex),
  ];
}

export function todoSummaryV1(snapshot: TodoStoreSnapshotV1): TodoSummaryV1 {
  const cached = todoSummaryCache.get(snapshot);
  if (cached !== undefined) {
    return cached;
  }
  const summary = computeTodoSummaryV1(snapshot);
  todoSummaryCache.set(snapshot, summary);
  return summary;
}

function computeTodoSummaryV1(snapshot: TodoStoreSnapshotV1): TodoSummaryV1 {
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  let blockedCount = 0;
  const completedIds = new Set(
    snapshot.items.filter((item) => item.status === "completed").map((item) => item.id),
  );
  for (const item of snapshot.items) {
    if (item.status === "pending") {
      counts.pending += 1;
    } else if (item.status === "in_progress") {
      counts.inProgress += 1;
    } else {
      counts.completed += 1;
    }
    if (item.dependencyIds.some((dependencyId) => !completedIds.has(dependencyId))) {
      blockedCount += 1;
    }
  }
  return {
    policyVersion: snapshot.policyVersion,
    storeRevision: snapshot.storeRevision,
    counts,
    blockedCount,
  };
}
