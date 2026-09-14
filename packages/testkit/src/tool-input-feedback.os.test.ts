import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createPermissionPolicy,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";

test.each(["allow", "deny"] as const)(
  "field feedback permits a corrected call while retaining %s permission",
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), "adam-input-feedback-"));
    const file = join(root, "demo.txt");
    await writeFile(file, "before\n");
    const secret = "PRIVATE_ARGUMENT_MUST_NOT_APPEAR";
    const inputs = [
      '{"operations":[}',
      JSON.stringify({ operations: [{ path: "demo.txt", content: secret }] }),
      JSON.stringify({
        operations: [
          { kind: "update", path: "demo.txt", edits: [{ oldText: "before", newText: secret }] },
          { kind: "delete" },
        ],
      }),
      JSON.stringify({
        operations: [
          { kind: "update", path: "demo.txt", edits: [{ oldText: "before", newText: "after" }] },
        ],
      }),
    ];
    const messages: string[] = [];
    const events: RuntimeEvent[] = [];
    let call = 0;
    const model = new FakeModelDriver((request) => {
      const latest = request.messages.at(-1);
      if (call > 0 && call < 4) {
        expect(readFileSync(file, "utf8")).toBe("before\n");
        if (latest?.role !== "tool" || latest.result.status !== "failed") {
          throw new Error("Expected invalid input feedback before correction");
        }
        expect(latest.result.error.code).toBe("invalid_tool_input");
        const message = latest.result.error.message;
        messages.push(message);
        if (call === 1) expect(message).toMatch(/JSON/);
        if (call === 2) {
          expect(message).toMatch(/operations.*0.*kind/);
          for (const kind of ["create", "update", "delete", "move"])
            expect(message).toContain(kind);
        }
        if (call === 3) expect(message).toMatch(/operations.*1.*path/);
      }
      const input = inputs[call++];
      if (input === undefined) {
        return [
          {
            type: "text_delta",
            text: decision === "allow" ? "Changed the file." : "The change was denied.",
          },
          { type: "finish", reason: "stop" },
        ];
      }
      const id = `edit-${call}`;
      return [
        { type: "tool_call_start", id, name: "edit_file" },
        { type: "tool_call_delta", id, json: input },
        { type: "tool_call_end", id },
        { type: "finish", reason: "tool_calls" },
      ];
    });
    const session = new AgentSession({
      model,
      maximumOutputTokens: 4096,
      tools: createCodingToolRegistry({ workspaceRoot: root }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["write"] }),
      store: createInMemorySessionStore(),
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_permission_requested")
        session.decidePermission({ requestId: event.requestId, decision });
    });
    try {
      expect(
        (await session.run({ text: "Update demo.txt" }, { limits: { maxTurns: 8 } })).status,
      ).toBe("completed");
      expect(await readFile(file, "utf8")).toBe(decision === "allow" ? "after\n" : "before\n");
      expect(events.filter((event) => event.type === "tool_permission_requested")).toHaveLength(1);
      expect(events.filter((event) => event.type === "tool_started")).toHaveLength(
        decision === "allow" ? 1 : 0,
      );
      expect(messages).toHaveLength(3);
      expect(messages.join(" ")).not.toContain(secret);
      expect(messages.every((message) => message.length <= 768)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("search schema feedback identifies invalid fields without reflecting values or unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-feedback-"));
  try {
    const registry = createCodingToolRegistry({ workspaceRoot: root });
    const adapter = registry.resolve("search_repository");
    if (adapter === undefined) throw new Error("Missing ordinary search tool");
    for (const input of [
      { kind: "content", query: "PRIVATE_QUERY", mode: "PRIVATE_MODE" },
      { kind: "content", query: "PRIVATE_QUERY", PRIVATE_KEY: "PRIVATE_VALUE" },
    ]) {
      const result = await adapter.prepare(JSON.stringify(input));
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("Invalid call became executable");
      expect(result.error.code).toBe("invalid_tool_input");
      expect(result.error.message).not.toMatch(/PRIVATE_/);
      expect(result.error.message.length).toBeLessThanOrEqual(768);
      if ("mode" in input) expect(result.error.message).toMatch(/mode.*literal.*regex/);
    }
    for (const digits of ["1234567890", "7"]) {
      const malformed = await adapter.prepare(`position ${digits}`);
      expect(malformed.status).toBe("failed");
      if (malformed.status !== "failed") throw new Error("Malformed JSON became executable");
      expect(malformed.error.message).toContain("JSON");
      expect(malformed.error.message).not.toContain(digits);
    }
    const misplaced = await adapter.prepare('{"query" 1}');
    if (misplaced.status !== "failed") throw new Error("Malformed JSON became executable");
    expect(misplaced.error.message).toMatch(/position \d+/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
