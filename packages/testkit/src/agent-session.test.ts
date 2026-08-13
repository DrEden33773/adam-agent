import { AgentSession, type RuntimeEvent } from "@adam-agent/agent";
import { describe, expect, test } from "vitest";

import { FakeModelDriver } from "./index.js";

describe("AgentSession", () => {
  test("an answer-only turn emits ordered events and returns its terminal result", async () => {
    const model = new FakeModelDriver([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "Adam." },
      { type: "finish", reason: "stop" },
    ]);
    const session = new AgentSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Introduce yourself" });

    expect(result).toEqual({ status: "completed", answer: "Hello, Adam." });
    expect(events).toEqual([
      { type: "user_message", text: "Introduce yourself" },
      { type: "model_message_started" },
      { type: "model_message_delta", text: "Hello, " },
      { type: "model_message_delta", text: "Adam." },
      { type: "model_message_completed", text: "Hello, Adam." },
      {
        type: "session_settled",
        result: { status: "completed", answer: "Hello, Adam." },
      },
    ]);
  });

  test("sends the user input to the model driver", async () => {
    const model = new FakeModelDriver((request) => [
      {
        type: "text_delta",
        text: request.messages[0]?.content ?? "missing user input",
      },
      { type: "finish", reason: "stop" },
    ]);
    const session = new AgentSession({ model });

    const result = await session.run({ text: "Explain this repository" });

    expect(result).toEqual({
      status: "completed",
      answer: "Explain this repository",
    });
  });

  test("reports a failed terminal result when the model stream ends without finishing", async () => {
    const model = new FakeModelDriver([{ type: "text_delta", text: "Partial answer" }]);
    const session = new AgentSession({ model });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.run({ text: "Answer completely" });

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "model_stream_incomplete",
        message: "The model stream ended without a finish event.",
      },
    });
    expect(events.at(-1)).toEqual({ type: "session_settled", result });
  });
});
