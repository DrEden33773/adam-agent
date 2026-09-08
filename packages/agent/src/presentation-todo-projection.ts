import type { ActiveSessionDisplay } from "@adam-agent/presentation";
import type { SessionRecord } from "./session-store.js";
import {
  type TodoItemV1,
  todoStoreSnapshotFromRecordsV1,
  todoSummaryV1,
  updateTodosOutputV1Schema,
} from "./todo.js";

/** Completion visibility derives from canonical Main runs, including cold reads and branches. */
export function projectTodoSummary(
  records: readonly SessionRecord[],
): NonNullable<ActiveSessionDisplay["todo"]> {
  const snapshot = todoStoreSnapshotFromRecordsV1(records);
  const statuses = new Map<string, TodoItemV1["status"]>();
  const completedIn = new Map<string, string>();
  let turnId: string | null = null;
  const changed = (item: TodoItemV1, runId: string | null) => {
    if (item.status === "completed" && statuses.get(item.id) !== "completed" && runId !== null)
      completedIn.set(item.id, runId);
    if (item.status !== "completed") completedIn.delete(item.id);
    statuses.set(item.id, item.status);
  };
  for (const entry of records) {
    if (entry.schemaVersion !== 3) continue;
    const record = entry.record;
    if (record.type === "logical_run_started") turnId = record.runId;
    else if (record.type === "todo_store_inherited") {
      if (record.chunkIndex === 0) {
        statuses.clear();
        completedIn.clear();
      }
      for (const item of record.items) changed(item, null);
    } else if (record.type === "todo_created" || record.type === "todo_updated")
      changed(record.item, record.runId);
    else if (
      record.type === "runtime_event" &&
      record.event.type === "tool_completed" &&
      record.event.name === "update_todos"
    )
      for (const item of updateTodosOutputV1Schema.parse(record.event.output).items)
        changed(item, record.runId);
  }
  const visible = snapshot.items.filter(
    (item) =>
      item.status !== "completed" || (turnId !== null && completedIn.get(item.id) === turnId),
  );
  // Twelve content lines need at most eleven items of either retention class.
  // Include both prefixes so responsive compression can discard completed items first.
  const completed = visible.filter((item) => item.status === "completed");
  const unfinished = visible.filter((item) => item.status !== "completed");
  const kept = new Set([...completed.slice(0, 11), ...unfinished.slice(0, 11)]);
  const completeIds = new Set(
    snapshot.items.filter((item) => item.status === "completed").map((item) => item.id),
  );
  const ids = snapshot.items.map((item) => item.id).sort();
  const labels = new Map(
    ids.map((id, index) => {
      const shared = (other: string | undefined) => {
        let count = 0;
        while (other !== undefined && count < id.length && id[count] === other[count]) count++;
        return count;
      };
      return [id, id.slice(0, Math.max(8, shared(ids[index - 1]) + 1, shared(ids[index + 1]) + 1))];
    }),
  );
  return {
    ...todoSummaryV1(snapshot),
    overlay: {
      turnId,
      completedCount: completed.length,
      items: visible
        .filter((item) => kept.has(item))
        .map((item) => ({
          id: item.id,
          label: labels.get(item.id) ?? item.id,
          createdOrdinal: item.createdOrdinal,
          itemRevision: item.itemRevision,
          status: item.status,
          title: item.title,
          ...("activeForm" in item && typeof item.activeForm === "string"
            ? { activeForm: item.activeForm }
            : {}),
          dependencyCount: item.dependencyIds.length,
          blocked: item.dependencyIds.some((id) => !completeIds.has(id)),
          dependencies: [...item.dependencyIds],
          dependencyLabels: item.dependencyIds.map((id) => labels.get(id) ?? id),
        })),
    },
  };
}
