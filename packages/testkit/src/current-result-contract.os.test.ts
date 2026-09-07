import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  createCodingToolRegistry,
  createJsonlSessionStore,
  createPermissionPolicy,
} from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
} from "./session-lifecycle.test-support.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";

test("JSONL preserves historical v1/v2/v3 bytes while refusing incomplete current writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-tool-errors-history-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const options = { workspaceRoot, stateRoot, sessionId: "123e4567-e89b-42d3-a456-426614174001" };
  try {
    const store = await createJsonlSessionStore<SessionRecord>(options);
    const path = (await readdir(stateRoot, { recursive: true })).find((path) =>
      path.endsWith(".jsonl"),
    );
    if (path === undefined) throw new Error("Expected the store's JSONL file.");
    const logPath = join(stateRoot, path);
    const historic = [
      {
        schemaVersion: 1,
        sequence: 1,
        runId,
        event: {
          type: "tool_failed",
          callId: "v1",
          name: "read_file",
          error: { code: "not_found", message: "Absent file." },
        },
      },
      {
        schemaVersion: 2,
        sequence: 2,
        runId,
        event: {
          type: "tool_failed",
          callId: "v2",
          name: "run_shell",
          error: { code: "tool_effect_indeterminate", message: "Inspect historical effect." },
        },
      },
      {
        schemaVersion: 3,
        sequence: 3,
        record: {
          type: "runtime_event",
          runId,
          event: {
            type: "tool_failed",
            callId: "v3",
            name: "run_shell",
            error: {
              code: "tool_effect_indeterminate",
              message: "Inspect historical current-format effect.",
            },
          },
        },
      },
    ];
    // External persisted input from the formerly supported decoder, not a new write.
    const bytes = `${historic.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(logPath, bytes);
    const reopened = await openJsonlSessionStore<SessionRecord>(options);
    expect(await reopened.read()).toEqual(historic);
    const invalidCurrent = { ...historic[2], sequence: 4 } as unknown as SessionRecord;
    await expect(reopened.append(invalidCurrent)).rejects.toMatchObject({
      code: "session_log_invalid",
    });
    expect(await readFile(logPath, "utf8")).toBe(bytes);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(historic);

    for (const schemaVersion of [1, 2] as const) {
      for (const code of [
        "search_cursor_invalid",
        "search_cursor_stale",
        "search_quota_exceeded",
        "managed_agent_stalled",
      ]) {
        const unsupported = {
          schemaVersion,
          sequence: 4,
          runId,
          event: {
            type: "tool_failed",
            callId: "historical-contract",
            name: "search_repository",
            error: { code, message: "Not supported by the historical format." },
          },
        } as unknown as SessionRecord;
        await expect(reopened.append(unsupported)).rejects.toMatchObject({
          code: "session_log_invalid",
        });
      }
    }
    expect(await readFile(logPath, "utf8")).toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone current JSONL events reopen without being admitted as a Lifecycle session", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-standalone-current-events-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const options = { workspaceRoot, stateRoot, sessionId: "123e4567-e89b-42d3-a456-426614174002" };
  const store = await createJsonlSessionStore(options);
  let providerCalls = 0;
  const model = new FakeModelDriver((request) => {
    providerCalls += 1;
    if (providerCalls === 1)
      return [
        { type: "tool_call_start", id: "standalone-search", name: "search_repository" },
        {
          type: "tool_call_delta",
          id: "standalone-search",
          json: '{"kind":"path","query":"needle","cursor":"not-a-cursor"}',
        },
        { type: "tool_call_end", id: "standalone-search" },
        { type: "finish", reason: "tool_calls" },
      ];
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      result: { status: "failed", error: { code: "search_cursor_invalid" } },
    });
    return [
      { type: "text_delta", text: "Standalone search handled." },
      { type: "finish", reason: "stop" },
    ];
  });
  const session = new AgentSession({
    store,
    model,
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    maximumOutputTokens: 4096,
  });
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(model),
  });
  try {
    await expect(session.run({ text: "Search directly." })).resolves.toEqual({
      status: "completed",
      answer: "Standalone search handled.",
    });
    const before = await store.read();
    expect(
      before.every((entry) => entry.schemaVersion === 3 && entry.record.type === "runtime_event"),
    ).toBe(true);
    const reopened = await openJsonlSessionStore(options);
    expect(await reopened.read()).toEqual(before);
    await expect(lifecycle.inspect({ sessionId: options.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(lifecycle.resume({ sessionId: options.sessionId })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(
      lifecycle.continue({
        sessionId: options.sessionId,
        input: { text: "Do not guess identity." },
      }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    await expect(
      lifecycle.branch({ parentSessionId: options.sessionId, atSequence: before.length }),
    ).rejects.toMatchObject({ code: "session_invalid" });
    expect(providerCalls).toBe(2);
    expect(await reopened.read()).toEqual(before);
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
