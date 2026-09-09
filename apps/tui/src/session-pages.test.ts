import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test.each([
  { mode: "all", editing: false },
  { mode: "all", editing: true },
  { mode: "any", editing: false },
] as const)(
  "$mode wait projects necessary attention without stealing editing=$editing",
  async ({ mode, editing }) => {
    const release = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    let mainCalls = 0;
    const h = await startManagedTui({
      async *stream(request) {
        if (request.tools.some((tool) => tool.name === "spawn_agents")) mainCalls += 1;
        const asking = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Ask for the scope"),
        );
        const result = request.messages.findLast((message) => message.role === "tool");
        if (asking && result === undefined) {
          yield { type: "tool_call_start", id: "scope", name: "request_parent_input" };
          yield { type: "tool_call_delta", id: "scope", json: '{"question":"Which scope?"}' };
          yield { type: "tool_call_end", id: "scope" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (!asking) {
          yield { type: "text_delta", text: "Other child is still working." };
          running.resolve();
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        }
        yield {
          type: "text_delta",
          text: asking ? "Exact scope received." : "Other child completed.",
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    });
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "page-wait-spawn",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              { role: "builtin:explore", task: "Ask for the scope", description: "Scope question" },
              { role: "builtin:explore", task: "Keep reading", description: "Independent reader" },
            ],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await running.promise;
      await h.waitForAttention((items) => items.length === 1 && items[0]?.available === true);
      await h.terminal.waitForScreen("1 pending");
      expect(h.terminal.lines().join("\n")).not.toContain("Attention Center");
      if (editing) await h.press("Retained main é draft", "Retained main é draft");
      const targets = (h.presentation.getState().authoritative.managedControl?.threads ?? []).map(
        (thread) => ({
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
        }),
      );
      const beforeWait = h.terminal.output().length;
      const waiting = h.presentation.dispatch({
        type: "managed_control",
        commandId: "page-wait",
        command: { type: "wait_agents", parentSessionId: h.parent.sessionId, mode, targets },
      });
      await h.waitForAttention(
        () => h.presentation.getState().authoritative.managedControl?.waits?.length === 1,
      );
      if (mode === "all" && !editing) {
        await h.terminal.waitForFrameAfter("Attention Center", beforeWait);
        await h.press("\u001b[27u", "Main waiting", "Attention Center");
        await h.press("kept", "kept");
        expect(h.terminal.lines().join("\n")).not.toContain("Attention Center");
      } else {
        if (mode === "all") await h.terminal.waitForFrameAfter("Main waiting", beforeWait);
        await h.press("x", editing ? "Retained main é draftx" : "x");
        expect(h.terminal.lines().join("\n")).not.toContain("Attention Center");
        if (mode === "any") expect(h.terminal.lines().join("\n")).not.toContain("Main waiting");
      }
      const draft = h.presentation.getState().composer.renderedText;
      await h.press("\u001ba", "Attention Center");
      await h.press("\r", "Which scope?");
      await h.press("The public interface", "> The public interface");
      const beforeReply = h.terminal.output().length;
      h.terminal.input("\r");
      await h.waitForAttention((items) => items.length === 0);
      await h.terminal.waitForFrameAfter(draft, beforeReply, "Attention Center");
      release.resolve();
      expect(await waiting).toMatchObject({ status: "admitted", control: { status: "completed" } });
      await h.terminal.waitForScreen(draft);
      expect(h.presentation.getState().composer.renderedText).toBe(draft);
      expect(h.terminal.lines().join("\n")).not.toContain("0 pending");
      expect(mainCalls).toBe(0);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

test("Child completes its attention command locally while preserving Main input", async () => {
  const ask = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      calls += 1;
      if (calls === 1) {
        yield { type: "text_delta", text: "Preparing a scope question." };
        started.resolve();
        await Promise.race([
          ask.promise,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        yield { type: "tool_call_start", id: "question", name: "request_parent_input" };
        yield { type: "tool_call_delta", id: "question", json: '{"question":"Which source?"}' };
        yield { type: "tool_call_end", id: "question" };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "child-command",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Ask for a source", description: "Exact source" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.openFirstAgent();
    await h.press("\r", "To @explore-1");
    ask.resolve();
    await h.waitForAttention((items) => items.length === 1 && items[0]?.available === true);
    await h.press("/agents att\t", "> /agents attention");
    expect(h.terminal.lines().join("\n")).not.toContain("Attention Center");
    await h.press("\r", "Attention Center");
    expect(calls).toBe(1);
    expect(h.presentation.getState().composer.renderedText).toBe("");
    await h.press("\u001b[27u", "> /agents attention", "Attention Center");
    await h.press("\u001b[27u", "Enter compose");
    await h.press("\u001ba", "Attention Center");
    await h.press("\u001b[27u", "Enter compose", "Attention Center");
    expect(calls).toBe(1);
  } finally {
    ask.resolve();
    await h.close();
  }
});

test("a pending Child cancellation protects focus from necessary attention and Alt+A", async () => {
  const ask = Promise.withResolvers<void>();
  const receiptReady = Promise.withResolvers<void>();
  const releaseReceipt = Promise.withResolvers<void>();
  const h = await startManagedTui(
    {
      async *stream(request) {
        const asking = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Ask later"),
        );
        yield { type: "text_delta", text: asking ? "Preparing question." : "Cancellation target." };
        const aborted = new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (asking) {
          await Promise.race([ask.promise, aborted]);
          yield { type: "tool_call_start", id: "later-question", name: "request_parent_input" };
          yield {
            type: "tool_call_delta",
            id: "later-question",
            json: '{"question":"Which boundary?"}',
          };
          yield { type: "tool_call_end", id: "later-question" };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          await aborted;
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    {
      controlReceiptBarrier: async (command) => {
        if (command.type === "cancel_turn") {
          receiptReady.resolve();
          await releaseReceipt.promise;
        }
      },
    },
  );
  let waiting: ReturnType<typeof h.presentation.dispatch> | undefined;
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "cancel-focus-spawn",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Keep reading", description: "Cancellation target" },
            { role: "builtin:explore", task: "Ask later", description: "Necessary question" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("@explore-1 · Running · Explore");
    await h.openFirstAgent();
    const targets = (h.presentation.getState().authoritative.managedControl?.threads ?? []).map(
      (thread) => ({
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
      }),
    );
    waiting = h.presentation.dispatch({
      type: "managed_control",
      commandId: "cancel-focus-wait",
      command: { type: "wait_agents", parentSessionId: h.parent.sessionId, mode: "all", targets },
    });
    await h.waitForAttention(
      () => h.presentation.getState().authoritative.managedControl?.waits?.length === 1,
    );
    await h.press("x", "x again to cancel");
    await h.press("x", "Cancelled");
    await receiptReady.promise;
    const before = h.terminal.output().length;
    ask.resolve();
    await h.waitForAttention((items) => items.length === 1 && items[0]?.available === true);
    await h.terminal.waitForFrameAfter("Main waiting", before, "Attention Center");
    h.terminal.input("\u001ba");
    await h.press("m", "m full Markdown", "Attention Center");
    expect(h.conversationText()).toContain("Conversation · @explore-1");
    expect(h.presentation.getState().managedAttention).toHaveLength(1);
  } finally {
    ask.resolve();
    releaseReceipt.resolve();
    await h.close();
    await waiting;
  }
});
