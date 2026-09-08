import {
  AgentSession,
  createInMemorySessionStore,
  type ModelDriver,
  ModelDriverError,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

test("argument completion precedes provider finish and no tool is requested early", async () => {
  const events: RuntimeEvent[] = [];
  const model: ModelDriver = {
    async *stream() {
      yield { type: "tool_call_start", id: "a", name: "first" };
      yield { type: "tool_call_delta", id: "a", json: "{}" };
      expect(events.filter((event) => event.type === "tool_requested")).toEqual([]);
      yield { type: "tool_call_start", id: "b", name: "second" };
      yield { type: "text_delta", text: "still working" };
      yield { type: "tool_call_end", id: "a" };
      expect(events).toContainEqual({
        type: "model_tool_arguments_completed",
        id: "a",
        name: "first",
      });
      expect(events.filter((event) => event.type === "tool_requested")).toEqual([]);
      yield {
        type: "reasoning_start",
        id: "provider-reasoning-0",
        artifactType: "provider_reasoning",
      };
      yield { type: "reasoning_delta", id: "provider-reasoning-0", text: "checking" };
      yield { type: "reasoning_end", id: "provider-reasoning-0" };
      yield { type: "tool_call_delta", id: "b", json: "{}" };
      yield { type: "tool_call_end", id: "b" };
      expect(events).toContainEqual({
        type: "model_tool_arguments_completed",
        id: "b",
        name: "second",
      });
      expect(events.filter((event) => event.type === "tool_requested")).toEqual([]);
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const session = new AgentSession({
    model,
    store: createInMemorySessionStore(),
    maximumOutputTokens: 4096,
  });
  session.subscribe((event) => events.push(event));
  await session.run({ text: "work" });
  expect(events).toContainEqual({ type: "model_response_processing", callIds: ["a", "b"] });
  expect(events.findIndex((event) => event.type === "model_response_processing")).toBeLessThan(
    events.findIndex((event) => event.type === "model_message_completed"),
  );
});

test.each(["cancelled", "failed"] as const)("pending arguments terminate on %s", async (status) => {
  const events: RuntimeEvent[] = [];
  const controller = new AbortController();
  const model: ModelDriver = {
    async *stream() {
      yield { type: "tool_call_start", id: "a", name: "first" };
      yield { type: "tool_call_delta", id: "a", json: "{}" };
      yield { type: "tool_call_end", id: "a" };
      yield { type: "tool_call_start", id: "b", name: "second" };
      if (status === "cancelled") controller.abort();
      else throw new ModelDriverError("transport", "Provider failed", { cause: undefined });
    },
  };
  const session = new AgentSession({
    model,
    store: createInMemorySessionStore(),
    maximumOutputTokens: 4096,
  });
  session.subscribe((event) => events.push(event));
  const result = await session.run({ text: "work" }, { signal: controller.signal });
  expect(result.status).toBe(status);
  expect(events.filter((event) => event.type === "model_tool_arguments_settled")).toEqual([
    { type: "model_tool_arguments_settled", id: "a", name: "first", status },
    { type: "model_tool_arguments_settled", id: "b", name: "second", status },
  ]);
  expect(events.filter((event) => event.type === "tool_requested")).toEqual([]);
});
