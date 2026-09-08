import {
  AgentSession,
  type AgentSessionDependencies,
  createInMemorySessionStore,
  type ModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { type SessionRecord, sessionDurableContext } from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";

const targetIdentity = {
  targetId: "test",
  vendor: "test",
  modelId: "test",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;

test.each([0, 1])(
  "serialized UTF-8 argument cap handles split surrogate pair with %i excess bytes",
  async (excess) => {
    const prefix = `{"value":"${"x".repeat(512 * 1024 - 16 + excess)}`;
    const chunks = [prefix, "\ud83d", "", '\ude00"}'];
    const expectedJson = `${prefix}😀"}`;
    expect(Buffer.byteLength(expectedJson)).toBe(512 * 1024 + excess);
    const model: ModelDriver = {
      async *stream(request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool_call_start", id: "a", name: "inspect" };
        for (const json of chunks) yield { type: "tool_call_delta", id: "a", json };
        yield { type: "tool_call_end", id: "a" };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    const store = createInMemorySessionStore<SessionRecord>();
    const session = new AgentSession({
      model,
      maximumOutputTokens: 4096,
      store: store as unknown as AgentSessionDependencies["store"],
      [sessionDurableContext]: { nextSequence: 1, targetIdentity },
    } as AgentSessionDependencies);
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const result = await session.run({ text: "Inspect" });
    if (excess === 0) {
      expect(events).toContainEqual({
        type: "model_tool_arguments_completed",
        id: "a",
        name: "inspect",
      });
      expect(events.some((event) => event.type === "tool_requested")).toBe(true);
      const records = await store.read();
      const response = records.find(
        (record) => record.schemaVersion === 3 && record.record.type === "model_response_completed",
      );
      if (response?.schemaVersion !== 3 || response.record.type !== "model_response_completed")
        throw new Error("Missing response");
      expect(response.record.response.toolCalls[0]?.argumentsJson === expectedJson).toBe(true);
    } else {
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "replay_envelope_too_large" },
      });
      expect(events.some((event) => event.type === "tool_requested")).toBe(false);
    }
  },
);

test("phase diagnostics retain exact reception times and UTF-8 counts without per-fragment notifications", async () => {
  const diagnostics: import("@adam-agent/agent").RuntimePhaseDiagnostic[] = [];
  let at = 10;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => at);
  const store = createInMemorySessionStore<SessionRecord>();
  const session = new AgentSession({
    maximumOutputTokens: 4096,
    store: store as unknown as AgentSessionDependencies["store"],
    onPhaseDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
      // Observation failures must not interrupt provider consumption or execution.
      if (diagnostic.stage === "last_argument") throw new Error("diagnostic sink unavailable");
    },
    [sessionDurableContext]: { nextSequence: 1, targetIdentity },
    model: {
      async *stream(request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool_call_start", id: "observed", name: "inspect" };
        at = 20;
        yield { type: "tool_call_delta", id: "observed", json: '{"value":"中\ud83d' };
        at = 35;
        yield { type: "tool_call_delta", id: "observed", json: '\ude00e\u0301"}' };
        expect(diagnostics).toEqual([]);
        at = 40;
        yield { type: "tool_call_end", id: "observed" };
        at = 50;
        yield { type: "finish", reason: "tool_calls" };
      },
    },
  } as AgentSessionDependencies);
  try {
    expect((await session.run({ text: "Inspect" })).status).toBe("completed");
    expect(diagnostics.map(({ stage, atMilliseconds }) => ({ stage, atMilliseconds }))).toEqual([
      { stage: "first_argument", atMilliseconds: 20 },
      { stage: "last_argument", atMilliseconds: 35 },
      { stage: "sdk_end", atMilliseconds: 40 },
      { stage: "provider_finish", atMilliseconds: 50 },
      { stage: "response_durable", atMilliseconds: 50 },
      { stage: "tool_requested", atMilliseconds: 50 },
    ]);
    for (const diagnostic of diagnostics)
      expect(diagnostic).toMatchObject({
        callId: "observed",
        toolName: "inspect",
        byteCount: 22,
        fragmentCount: 2,
        maxGapMilliseconds: 15,
      });
    const records = await store.read();
    expect(JSON.stringify(records)).not.toContain("atMilliseconds");
    expect(JSON.stringify(diagnostics)).not.toContain("value");
  } finally {
    clock.mockRestore();
  }
});
