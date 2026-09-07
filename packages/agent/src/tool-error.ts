import { z } from "zod";

// Current ToolResult errors and their durable admission share this schema.
// Historical session decoders stay in SessionStore with their original semantics.
export const toolErrorSchema = z.discriminatedUnion("code", [
  z
    .strictObject({
      code: z.enum([
        "unknown_tool",
        "invalid_tool_input",
        "permission_denied",
        "outside_workspace",
        "not_found",
        "already_exists",
        "ambiguous_match",
        "binary_file",
        "file_too_large",
        "no_match",
        "overlapping_edits",
        "path_conflict",
        "repository_context_changed",
        "repository_instructions_unavailable",
        "project_context_changed",
        "project_context_unavailable",
        "skill_unavailable",
        "skill_resource_unavailable",
        "skill_resource_changed",
        "unsupported_binary_resource",
        "resource_page_too_small",
        "skill_resource_quota_exceeded",
        "input_resource_corrupt",
        "input_resource_cursor_invalid",
        "input_resource_not_visible",
        "input_resource_quota_exceeded",
        "input_resource_unsupported",
        "search_cursor_invalid",
        "search_cursor_stale",
        "search_quota_exceeded",
        "todo_aggregate_limit_exceeded",
        "todo_completed_dependent",
        "todo_cursor_invalid",
        "todo_cursor_stale",
        "todo_dependency_cycle",
        "todo_dependency_incomplete",
        "todo_entity_limit_exceeded",
        "todo_revision_stale",
        "artifact_store_failed",
        "mcp_protocol_error",
        "mcp_output_invalid",
        "mcp_output_unsupported",
        "mcp_result_too_large",
        "managed_agent_cancelled",
        "managed_agent_capacity_exceeded",
        "managed_agent_deadline_exceeded",
        "managed_agent_failed",
        "managed_agent_result_too_large",
        "managed_agent_stalled",
        "managed_agent_unavailable",
        "web_cancelled",
        "web_deadline_exceeded",
        "web_provider_invalid",
        "web_provider_unavailable",
        "web_response_invalid",
        "web_response_too_large",
        "web_source_unavailable",
        "shell_start_failed",
        "tool_io_failed",
      ]),
      message: z.string(),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("tool_effect_indeterminate"),
      reason: z.enum([
        "mcp_request_timeout",
        "mcp_caller_cancelled",
        "mcp_connection_closed",
        "mcp_protocol_error",
        "process_restart",
      ]),
      message: z.string(),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("mcp_catalog_stale"),
      message: z.string(),
      generationId: z.uuid(),
      serverId: z.string().min(1).max(128),
      catalogDigest: z
        .templateLiteral(["sha256:", z.string()])
        .refine((value) => /^sha256:[0-9a-f]{64}$/u.test(value)),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("patch_recovery_cleanup_failed"),
      message: z.string(),
      settlement: z.enum(["committed", "rolled_back"]),
      recoveryReference: z.strictObject({ id: z.uuid() }).readonly(),
    })
    .readonly(),
  z
    .strictObject({
      code: z.literal("patch_state_uncertain"),
      message: z.string(),
      affectedPaths: z
        .array(z.string().refine(isCanonicalPatchPath))
        .min(1)
        .max(64)
        .refine((paths) =>
          paths.every((path, index) => {
            const previous = paths[index - 1];
            return index === 0 || (previous !== undefined && previous < path);
          }),
        )
        .readonly(),
      recoveryReference: z.strictObject({ id: z.uuid() }).readonly(),
    })
    .readonly(),
]);

export type ToolError = z.infer<typeof toolErrorSchema>;

export function isCanonicalPatchPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
