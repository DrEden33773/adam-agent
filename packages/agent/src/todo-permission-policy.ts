import type { SessionRecord } from "./session-store.js";

export type TodoPermissionPolicy = "todo-permission.legacy-v1" | "todo-permission.session-v1";

export function todoPermissionPolicyFromRecords(
  records: readonly SessionRecord[],
): TodoPermissionPolicy {
  let policy: TodoPermissionPolicy = "todo-permission.legacy-v1";
  for (const entry of records) {
    if (entry.schemaVersion !== 3) continue;
    if (entry.record.type === "session_genesis")
      policy = entry.record.todoPermissionPolicyVersion ?? "todo-permission.legacy-v1";
    if (entry.record.type === "session_todo_permission_policy_changed")
      policy = entry.record.policyVersion;
  }
  return policy;
}
