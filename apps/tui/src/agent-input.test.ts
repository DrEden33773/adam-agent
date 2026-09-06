import type { ModelRequest } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("actual child Enter accepts one exact input, delivers at the read boundary, and starts a settled continuation", async () => {
  const started = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  let mainCalls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        mainCalls += 1;
        yield { type: "text_delta", text: "Main after child completed." };
      } else {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", text: "Reading before the safe boundary." };
          started.resolve();
          await releaseRead.promise;
          yield { type: "tool_call_start", id: "child-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "child-read", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "child-read" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield {
          type: "text_delta",
          text: requests.length === 2 ? "Child input delivered." : "Continuation completed.",
        };
      }
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "enter-delivery",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect repository.",
              description: "Delivery evidence",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\r", "To @explore-1");
    await h.press("Use this exact later evidence.", "Use this exact later evidence.");
    await h.press("\r", "Accepted");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(first?.inputs).toMatchObject([{ status: "accepted", turnId: first?.turn.turnId }]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("Use this exact later evidence.");
    const beforeRead = h.terminal.output().length;
    releaseRead.resolve();
    await h.terminal.waitForFrameAfter("Child input delivered.", beforeRead);
    await h.terminal.waitForFrameAfter("Completed", beforeRead);
    expect(h.conversationText()).toContain("Delivered");
    expect(JSON.stringify(requests[1]?.messages)).toContain("Use this exact later evidence.");
    expect(
      h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs,
    ).toMatchObject([{ status: "delivered", turnId: first?.turn.turnId }]);
    expect(mainCalls).toBe(0);
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\r", "New turn");
    await h.press("Continue this exact thread.", "Continue this exact thread.");
    await h.press("\r", "Continuation completed.");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages)).toContain("Continue this exact thread.");
    const next = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(next?.threadId).toBe(first?.threadId);
    expect(next?.turn.turnId).not.toBe(first?.turn.turnId);
    expect(mainCalls).toBe(0);
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\u001b", "Esc Main");
    await h.press("\u001b", "Fleet · ↓ navigate");
    await h.press("Main prompt.\r", "Main after child completed.");
    expect(mainCalls).toBe(1);
  } finally {
    releaseRead.resolve();
    await h.close();
  }
});

test.each(["cooperative", "interrupt"] as const)(
  "%s composer Enter reports the exact finishing-provider delivery outcome",
  async (mode) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const h = await startManagedTui({
      async *stream() {
        if (++calls === 1) {
          started.resolve();
          await release.promise;
        }
        yield { type: "text_delta", text: "Finishing provider evidence." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    });
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: `finishing-${mode}`,
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              {
                role: "builtin:explore",
                task: "Inspect evidence.",
                description: "Finishing boundary",
              },
            ],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await started.promise;
      await h.terminal.waitForScreen("@explore-1 · Explore · Running");
      await h.openFirstAgent();
      await h.press("\r", "Cooperative");
      if (mode === "interrupt") await h.press("\t", "Interrupt after current effect");
      await h.press("Additional evidence.", "Additional evidence.");
      await h.press("\r", "Accepted");
      const before = h.terminal.output().length;
      release.resolve();
      await h.terminal.waitForFrameAfter("Completed", before);
      expect(h.conversationText()).toContain(
        mode === "interrupt" ? "Delivered" : "Undelivered · settled",
      );
      expect(
        h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs,
      ).toMatchObject([{ status: mode === "interrupt" ? "delivered" : "undelivered" }]);
      expect(calls).toBe(mode === "interrupt" ? 2 : 1);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

test("child composer answers the exact Parent input request without a Main turn", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "tool_call_start", id: "question", name: "request_parent_input" };
        yield {
          type: "tool_call_delta",
          id: "question",
          json: '{"question":"Which scope should I inspect?"}',
        };
        yield { type: "tool_call_end", id: "question" };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "Exact parent reply received." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "parent-input",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Ask for a scope.", description: "Exact question" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Waiting for you");
    await h.terminal.waitForScreen("Attention Center");
    await h.press("\u001b[27u", "Attention pending");
    await h.openFirstAgent();
    expect(h.conversationText()).toContain("Which scope should I inspect?");
    await h.press("\r", "Reply to parent input");
    await h.press("Inspect the public interface.", "Inspect the public interface.");
    await h.press("\r", "Exact parent reply received.");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("Inspect the public interface.");
    expect(
      h.presentation
        .getState()
        .authoritative.active?.transcript.items.some((item) => item.type === "user_message"),
    ).toBe(false);
    expect(
      h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs,
    ).toMatchObject([{ status: "delivered" }]);
  } finally {
    await h.close();
  }
});

test("a retained child draft rejects after another turn starts without rebinding its target", async () => {
  const started = Promise.withResolvers<void>();
  const firstFinish = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      if (++calls === 1) {
        started.resolve();
        await firstFinish.promise;
      } else {
        secondStarted.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield { type: "text_delta", text: "Exact turn finished." };
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "stale-draft-start",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "First task.", description: "Stable thread" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\r", "Cooperative");
    await h.press("Draft for the first turn only.", "Draft for the first turn only.");
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\u001b", "Esc Main");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (first === undefined) throw new Error("Missing first thread");
    const before = h.terminal.output().length;
    firstFinish.resolve();
    await h.terminal.waitForFrameAfter("Completed", before);
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "independent-next-turn",
        command: {
          type: "next_turn",
          parentSessionId: first.parentSessionId,
          threadId: first.threadId,
          expectedTurnId: first.turn.turnId,
          task: "A separately admitted next task.",
        },
      }),
    ).toMatchObject({ status: "admitted", control: { status: "accepted" } });
    await secondStarted.promise;
    await h.terminal.waitForFrameAfter("@explore-1 · Explore · Running", before);
    await h.press("\u001b[B\r", "Conversation");
    await h.press("\r", "Draft for the first turn only.");
    await h.press("\r", "The selected turn changed.");
    expect(h.conversationText()).toContain("Draft for the first turn only.");
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs).toHaveLength(
      0,
    );
    expect(calls).toBe(2);
  } finally {
    firstFinish.resolve();
    await h.close();
  }
});

test.each(["wait", "suspend"] as const)(
  "Session picker offers Stay and %s before switching and preserves child draft scope",
  async (decision) => {
    const fourStarted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (request.tools.some((tool) => tool.name === "spawn_agents")) {
            yield { type: "text_delta", text: "Destination is ready." };
            yield { type: "usage", inputTokens: 20, outputTokens: 10 };
            yield { type: "finish", reason: "stop" };
            return;
          }
          if (++calls === 4) fourStarted.resolve();
          await Promise.race([
            finish.promise,
            new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
          yield { type: "text_delta", text: "Source evidence settled." };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { withDestination: true },
    );
    try {
      expect(
        h.presentation
          .getState()
          .authoritative.sessions.items.some((session) => session.id === h.destination?.sessionId),
      ).toBe(true);
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "switch-source",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: Array.from({ length: 5 }, (_, index) => ({
              role: "builtin:explore",
              task: `Source ${index + 1}.`,
              description: `Source item ${index + 1}`,
            })),
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await fourStarted.promise;
      await h.terminal.waitForScreen("@explore-1 · Explore · Running");
      await h.openFirstAgent();
      await h.press("\r", "Cooperative");
      await h.press("Only the source child draft.", "Only the source child draft.");
      await h.press("\u001b", "Enter compose · Esc back");
      await h.press("\u001b", "Esc Main");
      await h.press("\u001b", "Fleet · ↓ navigate");
      await h.press("/resume\r", "Select a project session");
      await h.press("Destination", "Search: Destination");
      await h.press("\r", "Switch Session");
      expect(h.presentation.getState().authoritative.active?.session.id).toBe(h.parent.sessionId);
      const stayed = Promise.withResolvers<void>();
      const unsubscribeStay = h.presentation.subscribe(() => {
        if (h.presentation.getState().authoritative.managedTransition === undefined)
          stayed.resolve();
      });
      await h.press("\u001b[27u", "Select a project session");
      await stayed.promise;
      unsubscribeStay();
      expect(h.presentation.getState().authoritative.active?.session.id).toBe(h.parent.sessionId);
      await h.press("\r", "Switch Session");
      const beforeSwitch = h.terminal.output().length;
      if (decision === "wait") {
        await h.press("\u001b[B\r", "Waiting for agent work");
        finish.resolve();
      } else h.terminal.input("\u001b[B\u001b[B\r");
      await h.terminal.waitForFrameAfter("Adam · Destination fixture", beforeSwitch);
      expect(h.presentation.getState().authoritative.active?.session.id).toBe(
        h.destination?.sessionId,
      );
      expect(h.presentation.getState().managedDrafts).toHaveLength(0);
      expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
      expect(calls).toBe(decision === "wait" ? 5 : 4);
      await h.press("/resume\r", "Select a project session");
      await h.press("Fleet fixture", "Search: Fleet fixture");
      await h.press("\r", "Adam · Fleet fixture");
      await h.press("/agents\r", "Agents workspace");
      await h.press("\r", "Conversation");
      await h.press("\r", "Only the source child draft.");
      expect(h.conversationText()).toContain("Only the source child draft.");
      expect(h.presentation.getState().composer.renderedText).not.toContain("source child");
    } finally {
      finish.resolve();
      await h.close();
    }
  },
);

test("two deliberate Enter submissions with identical text admit two distinct child inputs", async () => {
  const started = Promise.withResolvers<void>();
  const h = await startManagedTui({
    async *stream(request) {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "distinct-enter",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Inspect evidence.", description: "Repeated input" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\r", "Cooperative");
    await h.press("Check again.", "Check again.");
    await h.press("\r", "Accepted");
    await h.press("Check again.", "Check again.");
    await h.press("\r", "Accepted");
    const inputs = h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs?.[0]?.id).not.toBe(inputs?.[1]?.id);
    expect(inputs?.map((input) => input.status)).toEqual(["accepted", "accepted"]);
  } finally {
    await h.close();
  }
});

test("late durable acceptance cannot clear a draft explicitly retargeted to a newer turn", async () => {
  const started = Promise.withResolvers<void>();
  const firstFinish = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const receiptReady = Promise.withResolvers<void>();
  const returnReceipt = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (++calls === 1) {
          started.resolve();
          await firstFinish.promise;
        } else {
          secondStarted.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yield { type: "text_delta", text: "Original work completed." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      controlReceiptBarrier: async (command) => {
        if (command.type === "post_agent") {
          receiptReady.resolve();
          await returnReceipt.promise;
        }
      },
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "late-acceptance",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "First work.", description: "Retargeted draft" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\r", "Cooperative");
    await h.press("Still the intended draft.", "Still the intended draft.");
    h.terminal.input("\r");
    await receiptReady.promise;
    await h.press("\u001b", "Enter compose · Esc back");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (first === undefined) throw new Error("Missing first turn");
    const beforeFinish = h.terminal.output().length;
    firstFinish.resolve();
    await h.terminal.waitForFrameAfter("Completed", beforeFinish);
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "retarget-next",
        command: {
          type: "next_turn",
          parentSessionId: first.parentSessionId,
          threadId: first.threadId,
          expectedTurnId: first.turn.turnId,
          task: "The current work.",
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await secondStarted.promise;
    await h.press("t", "Retarget draft to the current turn?");
    await h.press("\r", "Draft retargeted to the current turn.");
    const next = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(next?.turn.turnId).not.toBe(first.turn.turnId);
    const beforeReceipt = h.terminal.output().length;
    returnReceipt.resolve();
    await h.terminal.waitForFrameAfter("Undelivered · settled", beforeReceipt);
    await h.press("\r", "To @explore-1");
    expect(h.conversationText()).toContain("Still the intended draft.");
    expect(
      await h.presentation.dispatch({
        type: "read_agent_draft",
        sessionId: first.parentSessionId,
        threadId: first.threadId,
      }),
    ).toMatchObject({
      status: "admitted",
      managedDraft: { expectedTurnId: next?.turn.turnId, text: "Still the intended draft." },
    });
    expect(calls).toBe(2);
  } finally {
    firstFinish.resolve();
    returnReceipt.resolve();
    await h.close();
  }
});

test("Settling exposes no input action until cleanup releases the exact turn", async () => {
  const settling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        yield { type: "text_delta", text: `Settled evidence ${++calls}.` };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      settlementBarrier: async () => {
        settling.resolve();
        await release.promise;
      },
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "settling-input",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Inspect evidence.", description: "Cleanup boundary" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await settling.promise;
    await h.terminal.waitForScreen("Settling");
    await h.openFirstAgent();
    expect(h.conversationText()).not.toContain("Enter compose");
    await h.press("\r", "Settling");
    expect(h.conversationText()).not.toContain("To @explore-1");
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs).toHaveLength(
      0,
    );
    const before = h.terminal.output().length;
    release.resolve();
    await h.terminal.waitForFrameAfter("Completed", before);
    await h.press("\r", "New turn");
    await h.press("Continue after cleanup.", "Continue after cleanup.");
    await h.press("\r", "Settled evidence 2.");
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("ordinary Main Enter completes while a real child read remains durably started", async () => {
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  let mainCalls = 0;
  let childCalls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          mainCalls += 1;
          yield { type: "text_delta", text: "Main completed while child read is active." };
        } else if (++childCalls === 1) {
          yield { type: "tool_call_start", id: "held-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "held-read", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "held-read" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        } else {
          expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
            role: "tool",
            name: "read_file",
            result: { status: "completed" },
          });
          yield { type: "text_delta", text: "Child read complete." };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      childRecordBarrier: async (record) => {
        if (
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_started" &&
          record.record.event.name === "read_file"
        ) {
          readStarted.resolve();
          await releaseRead.promise;
        }
      },
    },
  );
  const mainReady = Promise.withResolvers<number>();
  const unsubscribe = h.presentation.subscribe(() => {
    const state = h.presentation.getState();
    if (
      mainCalls === 1 &&
      state.authoritative.active?.parentRun?.phase === "ready" &&
      state.authoritative.active.transcript.items.some(
        (item) =>
          item.type === "assistant_message" &&
          item.text === "Main completed while child read is active.",
      )
    )
      mainReady.resolve(h.terminal.output().length);
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "main-during-read",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Read the package manifest.",
              description: "Actual child read",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await readStarted.promise;
    await h.press("Main while child reads.\r", "Main completed while child read is active.");
    const readyOffset = await mainReady.promise;
    await h.terminal.waitForFrameAfter(" · idle", readyOffset);
    const child = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (child === undefined) throw new Error("Missing child");
    const records = await (await h.children.open(child.turn.childSessionId))?.read();
    expect(
      records?.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_started" &&
          record.record.event.name === "read_file",
      ),
    ).toBe(true);
    expect(
      records?.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_completed",
      ),
    ).toBe(false);
    expect(mainCalls).toBe(1);
    expect(childCalls).toBe(1);
    const before = h.terminal.output().length;
    releaseRead.resolve();
    await h.terminal.waitForFrameAfter("Completed", before);
    expect(childCalls).toBe(2);
  } finally {
    unsubscribe();
    releaseRead.resolve();
    await h.close();
  }
});
