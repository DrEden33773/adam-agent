import {
  AgentSession,
  type AgentSessionDependencies,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createPermissionPolicy,
  type RunResult,
  type SessionEventRecord,
  type SessionStore,
  type ToolResult,
} from "@adam-agent/agent";
import type { SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, expectTypeOf, test } from "vitest";
import { FakeModelDriver } from "./index.js";

type ToolError = Extract<ToolResult, { status: "failed" }>["error"];
type RunError = Extract<RunResult, { status: "failed" | "cancelled" }>["error"];

// Independent examples: do not derive these from production schemas or enum lists.
const toolErrors = [
  { code: "unknown_tool", message: "No registered tool." },
  { code: "invalid_tool_input", message: "Input was invalid." },
  { code: "permission_denied", message: "Read denied." },
  { code: "outside_workspace", message: "Path escapes the workspace." },
  { code: "not_found", message: "File is absent." },
  { code: "already_exists", message: "File exists." },
  { code: "ambiguous_match", message: "More than one match." },
  { code: "binary_file", message: "Binary file." },
  { code: "file_too_large", message: "File exceeds limit." },
  { code: "no_match", message: "No replacement match." },
  { code: "overlapping_edits", message: "Edits overlap." },
  { code: "path_conflict", message: "Patch paths conflict." },
  { code: "repository_context_changed", message: "Instructions changed." },
  { code: "repository_instructions_unavailable", message: "Instructions unavailable." },
  { code: "project_context_changed", message: "Project changed." },
  { code: "project_context_unavailable", message: "Project unavailable." },
  { code: "skill_unavailable", message: "Skill unavailable." },
  { code: "skill_resource_unavailable", message: "Resource unavailable." },
  { code: "skill_resource_changed", message: "Resource changed." },
  { code: "unsupported_binary_resource", message: "Unsupported resource." },
  { code: "resource_page_too_small", message: "Page too small." },
  { code: "skill_resource_quota_exceeded", message: "Skill quota exceeded." },
  { code: "input_resource_corrupt", message: "Input corrupted." },
  { code: "input_resource_cursor_invalid", message: "Input cursor invalid." },
  { code: "input_resource_not_visible", message: "Input not visible." },
  { code: "input_resource_quota_exceeded", message: "Input quota exceeded." },
  { code: "input_resource_unsupported", message: "Input unsupported." },
  { code: "search_cursor_invalid", message: "Search cursor invalid." },
  { code: "search_cursor_stale", message: "Search cursor expired." },
  { code: "search_quota_exceeded", message: "Search budget exceeded." },
  { code: "todo_aggregate_limit_exceeded", message: "Todo aggregate limit." },
  { code: "todo_completed_dependent", message: "Completed dependent exists." },
  { code: "todo_cursor_invalid", message: "Todo cursor invalid." },
  { code: "todo_cursor_stale", message: "Todo cursor expired." },
  { code: "todo_dependency_cycle", message: "Todo dependency cycle." },
  { code: "todo_dependency_incomplete", message: "Todo dependency incomplete." },
  { code: "todo_entity_limit_exceeded", message: "Todo entity limit." },
  { code: "todo_revision_stale", message: "Todo revision stale." },
  { code: "artifact_store_failed", message: "Artifact unavailable." },
  { code: "mcp_protocol_error", message: "MCP protocol error." },
  { code: "mcp_output_invalid", message: "MCP output invalid." },
  { code: "mcp_output_unsupported", message: "MCP output unsupported." },
  { code: "mcp_result_too_large", message: "MCP output too large." },
  { code: "managed_agent_cancelled", message: "Child cancelled." },
  { code: "managed_agent_capacity_exceeded", message: "Child capacity exceeded." },
  { code: "managed_agent_deadline_exceeded", message: "Child deadline exceeded." },
  { code: "managed_agent_failed", message: "Child failed." },
  { code: "managed_agent_result_too_large", message: "Child result too large." },
  { code: "managed_agent_stalled", message: "Child stalled." },
  { code: "managed_agent_unavailable", message: "Child unavailable." },
  { code: "web_cancelled", message: "Web cancelled." },
  { code: "web_deadline_exceeded", message: "Web deadline exceeded." },
  { code: "web_provider_invalid", message: "Web provider invalid." },
  { code: "web_provider_unavailable", message: "Web provider unavailable." },
  { code: "web_response_invalid", message: "Web response invalid." },
  { code: "web_response_too_large", message: "Web response too large." },
  { code: "web_source_unavailable", message: "Web source unavailable." },
  { code: "shell_start_failed", message: "Process failed to start." },
  { code: "tool_io_failed", message: "Tool I/O failed." },
  {
    code: "tool_effect_indeterminate",
    message: "Inspect before retrying.",
    reason: "process_restart",
  },
  {
    code: "mcp_catalog_stale",
    message: "Catalog changed.",
    generationId: "123e4567-e89b-42d3-a456-426614174001",
    serverId: "docs",
    catalogDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  {
    code: "patch_recovery_cleanup_failed",
    message: "Cleanup required.",
    settlement: "committed",
    recoveryReference: { id: "123e4567-e89b-42d3-a456-426614174002" },
  },
  {
    code: "patch_state_uncertain",
    message: "Inspect patch paths.",
    affectedPaths: ["a.ts", "src/b.ts"],
    recoveryReference: { id: "123e4567-e89b-42d3-a456-426614174003" },
  },
] as const satisfies readonly ToolError[];

const runErrors = [
  { code: "model_stream_incomplete", message: "Stream incomplete." },
  { code: "model_protocol_invalid", message: "Protocol invalid." },
  { code: "model_output_truncated", message: "Output truncated." },
  { code: "model_content_filtered", message: "Content filtered." },
  { code: "model_response_artifact_quota_exceeded", message: "Artifact quota exceeded." },
  { code: "model_response_too_large", message: "Response too large." },
  { code: "replay_envelope_too_large", message: "Replay too large." },
  { code: "invalid_run_limits", message: "Invalid limits." },
  { code: "input_resource_invalid", message: "Input invalid." },
  { code: "input_resource_limit_exceeded", message: "Input limit exceeded." },
  { code: "input_resource_unsupported", message: "Input unsupported." },
  { code: "run_already_active", message: "Run active." },
  { code: "session_persistence_failed", message: "Persistence failed." },
  { code: "session_quota_exceeded", message: "Session quota exceeded." },
  { code: "turn_limit_exceeded", message: "Turn limit exceeded." },
  { code: "token_limit_exceeded", message: "Token limit exceeded." },
  { code: "token_usage_missing", message: "Usage missing." },
  { code: "context_compaction_input_unrecoverable", message: "Compaction input lost." },
  { code: "context_compaction_invalid", message: "Compaction invalid." },
  { code: "context_window_unrecoverable", message: "Window unrecoverable." },
  {
    code: "tool_effect_indeterminate",
    message: "Inspect effect.",
    reason: "mcp_connection_closed",
  },
  {
    code: "skill_activation_failed",
    message: "Choose exact Skill.",
    ambiguity: {
      selection: "review",
      candidates: ["project/review", "user/review"],
      omittedCount: 0,
    },
  },
  { code: "model_resource_exhausted", message: "Resources exhausted.", providerReason: "capacity" },
  { code: "model_finish_unknown", message: "Unknown finish.", providerReason: "other" },
  {
    code: "model_request_failed",
    message: "Invalid provider request.",
    category: "invalid_request",
    diagnosticCode: "tool_schema_root_not_object",
    status: 400,
    providerCode: "invalid_schema",
    requestId: "request-1",
  },
  {
    code: "context_compaction_failed",
    message: "Compaction provider unavailable.",
    category: "transport",
    status: 503,
    requestId: "request-2",
  },
  { code: "session_cancelled", message: "User cancelled." },
] as const satisfies readonly RunError[];

const runId = "123e4567-e89b-42d3-a456-426614174000";
function toolRecord(error: ToolError): SessionRecord {
  return {
    schemaVersion: 3,
    sequence: 1,
    record: {
      type: "runtime_event",
      runId,
      event: { type: "tool_failed", callId: "contract-call", name: "contract-tool", error },
    },
  };
}

test("current ToolResult and RunResult samples cover every supported error code", () => {
  expectTypeOf<SessionStore<SessionEventRecord>>().not.toMatchTypeOf<
    AgentSessionDependencies["store"]
  >();
  expectTypeOf<SessionStore<SessionRecord>>().toMatchTypeOf<AgentSessionDependencies["store"]>();
  expectTypeOf<
    Exclude<ToolError["code"], (typeof toolErrors)[number]["code"]>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Exclude<RunError["code"], (typeof runErrors)[number]["code"]>
  >().toEqualTypeOf<never>();
});

test.each(toolErrors)(
  "current ToolResult $code survives canonical append and read",
  async (error) => {
    const store = createInMemorySessionStore<SessionRecord>();
    const record = toolRecord(error);
    await store.append(record);
    expect(await store.read()).toEqual([record]);
  },
);

test.each(runErrors)("RunResult $code survives canonical append and read", async (error) => {
  const store = createInMemorySessionStore<SessionRecord>();
  const result: RunResult =
    error.code === "session_cancelled"
      ? { status: "cancelled", error }
      : { status: "failed", error };
  const record: SessionRecord = {
    schemaVersion: 3,
    sequence: 1,
    record: { type: "runtime_event", runId, event: { type: "session_settled", result } },
  };
  await store.append(record);
  expect(await store.read()).toEqual([record]);
});

test.each([
  { code: "unknown_error", message: "Unknown." },
  { code: "search_cursor_stale" },
  { code: "search_cursor_invalid", message: 42 },
  { code: "search_quota_exceeded", message: "Quota.", unexpected: true },
  { code: "tool_effect_indeterminate", message: "Missing reason." },
  { code: "tool_effect_indeterminate", message: "Invalid reason.", reason: "retry" },
  { code: "mcp_catalog_stale", message: "Missing identity." },
  {
    code: "mcp_catalog_stale",
    message: "Invalid identity.",
    generationId: runId,
    serverId: "docs",
    catalogDigest: "sha256:no",
  },
  { code: "patch_recovery_cleanup_failed", message: "Missing reference.", settlement: "committed" },
  {
    code: "patch_recovery_cleanup_failed",
    message: "Invalid settlement.",
    settlement: "uncertain",
    recoveryReference: { id: runId },
  },
  { code: "patch_state_uncertain", message: "Missing paths.", recoveryReference: { id: runId } },
  {
    code: "patch_state_uncertain",
    message: "Unordered paths.",
    affectedPaths: ["b.ts", "a.ts"],
    recoveryReference: { id: runId },
  },
  {
    code: "patch_state_uncertain",
    message: "Escaping path.",
    affectedPaths: ["../a.ts"],
    recoveryReference: { id: runId },
  },
])("new current errors reject malformed payload $code/$message before append", async (error) => {
  const store = createInMemorySessionStore<SessionRecord>();
  await expect(store.append(toolRecord(error as unknown as ToolError))).rejects.toMatchObject({
    code: "session_log_invalid",
  });
  expect(await store.read()).toEqual([]);
});

test("bare public AgentSession persists a real current search failure and feeds it back", async () => {
  const store = createInMemorySessionStore();
  let modelCalls = 0;
  const session = new AgentSession({
    store,
    maximumOutputTokens: 4096,
    tools: createCodingToolRegistry({ workspaceRoot: process.cwd() }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    model: new FakeModelDriver((request) => {
      modelCalls += 1;
      if (request.messages.at(-1)?.role === "user" && modelCalls > 1)
        return [
          { type: "text_delta", text: "The next direct run completed." },
          { type: "finish", reason: "stop" },
        ];
      if (modelCalls === 1)
        return [
          { type: "tool_call_start", id: "bare-search", name: "search_repository" },
          {
            type: "tool_call_delta",
            id: "bare-search",
            json: '{"kind":"path","query":"needle","cursor":"not-a-cursor"}',
          },
          { type: "tool_call_end", id: "bare-search" },
          { type: "finish", reason: "tool_calls" },
        ];
      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        result: { status: "failed", error: { code: "search_cursor_invalid" } },
      });
      return [
        { type: "text_delta", text: "The search failure was handled." },
        { type: "finish", reason: "stop" },
      ];
    }),
  });
  const result = await session.run({ text: "Search with this cursor." });
  expect(result, JSON.stringify(result)).toEqual({
    status: "completed",
    answer: "The search failure was handled.",
  });
  expect(modelCalls).toBe(2);
  expectTypeOf<Awaited<ReturnType<typeof store.read>>>().toEqualTypeOf<readonly SessionRecord[]>();
  const records = await store.read();
  expect(
    records.every((entry) => entry.schemaVersion === 3 && entry.record.type === "runtime_event"),
  ).toBe(true);
  const events = records.flatMap((entry) =>
    entry.schemaVersion === 3
      ? entry.record.type === "runtime_event"
        ? [entry.record.event]
        : []
      : [entry.event],
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool_failed",
      callId: "bare-search",
      error: expect.objectContaining({ code: "search_cursor_invalid" }),
    }),
  );
  expect(events.at(-1)).toEqual({ type: "session_settled", result });
  await expect(session.run({ text: "Continue directly." })).resolves.toEqual({
    status: "completed",
    answer: "The next direct run completed.",
  });
  expect(modelCalls).toBe(3);
  const nextRecords = (await store.read()).slice(records.length);
  expect(nextRecords[0]).toMatchObject({
    schemaVersion: 3,
    record: { type: "runtime_event", event: { type: "user_message", text: "Continue directly." } },
  });
  expect(nextRecords.at(-1)).toMatchObject({
    schemaVersion: 3,
    record: {
      type: "runtime_event",
      event: {
        type: "session_settled",
        result: { status: "completed", answer: "The next direct run completed." },
      },
    },
  });
});
