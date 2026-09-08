import { ModelDriverError } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test.each([
  ["Main", "cancel"],
  ["Child", "cancel"],
  ["Main", "failure"],
  ["Child", "failure"],
] as const)(
  "%s tracks each argument call across commentary, SDK end and %s",
  async (surface, outcome) => {
    const endFirst = Promise.withResolvers<void>();
    const endSecond = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const h = await startManagedTui({
      async *stream(request) {
        yield { type: "tool_call_start", id: "a", name: "read_file" };
        yield { type: "tool_call_delta", id: "a", json: '{"path":"AGENTS.md"}' };
        yield { type: "tool_call_start", id: "b", name: "list_directory" };
        yield { type: "text_delta", text: "Both arguments are in progress." };
        await endFirst.promise;
        yield { type: "tool_call_end", id: "a" };
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "Checking the remaining arguments.",
        };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "text_delta", text: "First call complete." };
        await endSecond.promise;
        yield { type: "tool_call_delta", id: "b", json: '{"path":"."}' };
        yield { type: "tool_call_end", id: "b" };
        yield { type: "text_delta", text: "Arguments complete; provider still open." };
        await Promise.race([
          finish.promise,
          new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        if (outcome === "failure")
          throw new ModelDriverError("transport", "Provider interrupted", { cause: undefined });
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    try {
      if (surface === "Main")
        await h.press("Inspect arguments\r", "Generating arguments · read_file");
      else {
        await h.press("@Explore", "New agent · Explore");
        await h.press("\t", "@Explore");
        await h.press(" Inspect arguments\r", "Delegation");
        await h.press("\r", "Generating arguments · read_file");
      }
      const calls = () =>
        surface === "Main"
          ? h.presentation.getState().transient?.argumentCalls
          : h.presentation.getState().managedAgentActivity?.[0]?.argumentCalls;
      expect(calls()).toEqual([
        { callId: "a", name: "read_file", status: "generating_arguments" },
        { callId: "b", name: "list_directory", status: "generating_arguments" },
      ]);
      let checkpoint = h.terminal.output().length;
      endFirst.resolve();
      await h.terminal.waitForFrameAfter("Generating arguments · list_directory", checkpoint);
      expect(calls()).toEqual([
        { callId: "a", name: "read_file", status: "awaiting_model_completion" },
        { callId: "b", name: "list_directory", status: "generating_arguments" },
      ]);
      checkpoint = h.terminal.output().length;
      endSecond.resolve();
      await h.terminal.waitForFrameAfter(
        "waiting for model completion",
        checkpoint,
        "Generating arguments",
      );
      expect(calls()?.map((call) => call.status)).toEqual([
        "awaiting_model_completion",
        "awaiting_model_completion",
      ]);
      const records =
        surface === "Main"
          ? await (await h.sessions.open(h.parent.sessionId))?.read()
          : await (
              await h.children.open(
                h.presentation.getState().managedAgentActivity?.[0]?.childSessionId ?? "",
              )
            )?.read();
      expect(
        records?.some(
          (record) =>
            record.schemaVersion === 3 &&
            record.record.type === "runtime_event" &&
            record.record.event.type === "tool_requested",
        ),
      ).toBe(false);
      if (outcome === "failure") {
        checkpoint = h.terminal.output().length;
        finish.resolve();
        await h.terminal.waitForFrameAfter(
          surface === "Main" ? "model_request_failed" : "Failed",
          checkpoint,
          "waiting for model completion",
        );
        expect(calls() ?? []).toEqual([]);
      } else if (surface === "Main") {
        await h.press("\u0003", "cancelled");
        expect(h.presentation.getState().transient?.argumentCalls ?? []).toEqual([]);
      } else {
        await h.openFirstAgent();
        await h.press("x", "x again to cancel");
        await h.press("x", "Cancelled");
        expect(
          h.presentation
            .getState()
            .managedAgentActivity?.flatMap((activity) => activity.argumentCalls ?? []) ?? [],
        ).toEqual([]);
      }
    } finally {
      endFirst.resolve();
      endSecond.resolve();
      finish.resolve();
      await h.close();
    }
  },
);

test("Child processing response remains distinct from completed arguments and tool request", async () => {
  const responseCommitted = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  let blocked = false;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "text_delta", text: "Inspection complete." };
          yield { type: "usage", inputTokens: 100, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool_call_start", id: "read", name: "read_file" };
        yield { type: "tool_call_delta", id: "read", json: '{"path":"AGENTS.md"}' };
        yield { type: "tool_call_end", id: "read" };
        yield { type: "usage", inputTokens: 100, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      },
    },
    {
      async childRecordBarrier(record) {
        if (
          !blocked &&
          record.schemaVersion === 3 &&
          record.record.type === "model_response_completed"
        ) {
          blocked = true;
          responseCommitted.resolve();
          await releaseResponse.promise;
        }
      },
    },
  );
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect instructions\r", "Delegation");
    await h.press("\r", "Processing model response");
    await responseCommitted.promise;
    expect(h.presentation.getState().managedAgentActivity?.[0]?.argumentCalls).toEqual([
      { callId: "read", name: "read_file", status: "processing_response" },
    ]);
    const sessionId = h.presentation.getState().managedAgentActivity?.[0]?.childSessionId;
    expect(sessionId).toBeDefined();
    const records = await (await h.children.open(sessionId ?? ""))?.read();
    expect(
      records?.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_requested",
      ),
    ).toBe(false);
    const checkpoint = h.terminal.output().length;
    releaseResponse.resolve();
    await h.terminal.waitForFrameAfter("Completed", checkpoint, "Processing model response");
  } finally {
    releaseResponse.resolve();
    await h.close();
  }
});
