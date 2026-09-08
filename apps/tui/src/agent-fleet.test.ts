import { createPermissionPolicy, type ModelRequest } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";
import type { DeadlineScheduler } from "./tui-app.js";

test("running Explore has Widget and Fleet, layered Enter and Esc preserve independent drafts and Main", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let mainCalls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      if (
        request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Inspect U0 evidence."),
        )
      ) {
        yield { type: "text_delta", text: "Inspecting the repository." };
        started.resolve();
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      } else {
        mainCalls += 1;
        yield { type: "text_delta", text: "Ordinary Main completed." };
      }
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  const unsubscribe = h.presentation.subscribe(() => {
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread?.turn.phase === "idle")
      started.reject(new Error(JSON.stringify(thread.turn.outcome)));
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "u0-start",
        command: {
          type: "start_thread",
          parentSessionId: h.parent.sessionId,
          role: "builtin:explore",
          task: "Inspect U0 evidence.",
          description: "Map public API",
        },
      }),
    ).toMatchObject({ status: "admitted", control: { status: "accepted" } });
    await started.promise;
    h.terminal.input("Main draft");
    await h.terminal.waitForScreen("Main draft");
    const screen = h.terminal.lines().join("\n");
    expect(screen).toContain("Map public API");
    expect(screen).toContain("Agents");
    expect(screen).toContain("Fleet ·");
    expect(screen).toContain("Main");
    expect(screen.indexOf("Agents")).toBeLessThan(screen.indexOf("Main draft"));
    expect(screen.indexOf("Main draft")).toBeLessThan(screen.indexOf("Fleet ·"));
    h.terminal.input("\u001b[D");
    expect(h.presentation.getState().composer.renderedText).not.toContain("Draft to");
    h.terminal.input("\u0001\u000b");
    // Pi Fleet first activates Main, then moves down to the openable child.
    await h.openFirstAgent();
    await h.press("\r", "To @explore-1");
    await h.press("Child draft", "Child draft");
    await h.press("\u001b", "Enter compose · Esc back");
    expect(h.terminal.lines().join("\n")).toContain("Draft to @explore-1");
    // The Fleet hint is visible behind the viewer; observe its closure in the same frame.
    await h.press("\u001b", "Esc Main", "Conversation ·");
    expect(h.terminal.lines().join("\n")).not.toContain("Conversation ·");
    await h.press("\u001b", "Fleet · ↓ navigate");
    await h.press("Ordinary Main input.\r", "Ordinary Main completed.");
    expect(mainCalls).toBe(1);
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.phase).toBe(
      "executing",
    );
  } finally {
    unsubscribe();
    release.resolve();
    await h.close();
  }
});

test.each([40, 80, 120])(
  "%i-column background cards retain exact Started and Queued identities while Main returns",
  async (columns) => {
    let mainCalls = 0;
    let preparedCount = 0;
    let childCalls = 0;
    const prepared = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    const eightStarted = Promise.withResolvers<void>();
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (!request.tools.some((tool) => tool.name === "spawn_agents")) {
            yield { type: "text_delta", text: "Reading batch evidence." };
            if (++childCalls === 8) eightStarted.resolve();
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          } else if (++mainCalls === 1) {
            yield { type: "tool_call_start", id: "batch", name: "spawn_agents" };
            yield {
              type: "tool_call_delta",
              id: "batch",
              json: JSON.stringify({
                entries: Array.from({ length: 9 }, (_, index) => ({
                  role: "builtin:explore",
                  task: `Read evidence ${index + 1}`,
                  description: `核查 e\u0301 证据 ${index + 1}`,
                })),
              }),
            };
            yield { type: "tool_call_end", id: "batch" };
            yield { type: "usage", inputTokens: 20, outputTokens: 10 };
            yield { type: "finish", reason: "tool_calls" };
            return;
          } else yield { type: "text_delta", text: "Batch admitted; Main ready." };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        columns,
        rows: 64,
        childRecordBarrier: async (record) => {
          if (record.schemaVersion === 3 && record.record.type === "session_genesis") {
            if (++preparedCount === 8) prepared.resolve();
            await releaseStart.promise;
          }
        },
      },
    );
    try {
      await h.press("Inspect these nine items.\r", "Confirm delegation");
      expect(h.terminal.lines().join("\n")).not.toMatch(/Started @|Queued @/u);
      expect(childCalls).toBe(0);
      await h.press("\r", "Batch admitted; Main ready.");
      await prepared.promise;
      await h.terminal.waitForScreen("⎿ Starting");
      const screen = h.terminal.lines().join("\n");
      const lines = h.terminal.lines().map((line) => line.trim());
      // The physical terminal exposes the continuation cell after each wide character.
      const cardStart = lines.indexOf("Explore · 核 查  e\u0301 证 据  1");
      expect(cardStart).toBeGreaterThanOrEqual(0);
      expect(lines.slice(cardStart, cardStart + 18)).toEqual(
        Array.from({ length: 9 }, (_, index) => [
          `Explore · 核 查  e\u0301 证 据  ${index + 1}`,
          index === 8 ? "Queued @explore-9 · Ctrl+O expand" : `Started @explore-${index + 1}`,
        ]).flat(),
      );
      expect(lines).not.toContain("Completed");
      expect(screen).not.toContain("managed_agent_batch");
      expect(
        h.presentation
          .getState()
          .authoritative.managedControl?.threads.filter(
            (thread) => thread.turn.phase === "starting",
          ),
      ).toHaveLength(8);
      expect(
        h.presentation
          .getState()
          .authoritative.managedControl?.threads.filter((thread) => thread.turn.phase === "queued"),
      ).toHaveLength(1);
      releaseStart.resolve();
      await eightStarted.promise;
      await h.terminal.waitForScreen("● Agents · 8 running · 1 queued");
      const state = h.presentation.getState();
      expect(
        state.authoritative.managedControl?.threads.filter(
          (thread) => thread.turn.phase === "executing",
        ),
      ).toHaveLength(8);
      expect(
        state.authoritative.managedControl?.threads.filter(
          (thread) => thread.turn.phase === "queued",
        ),
      ).toHaveLength(1);
      expect(
        state.authoritative.active?.transcript.items.find(
          (item) => item.type === "tool_call" && item.qualifiedName === "spawn_agents",
        ),
      ).toMatchObject({ status: "completed" });
      expect(screen.slice(screen.indexOf("Fleet ·"))).not.toContain("@explore-9");
      expect(mainCalls).toBe(2);
    } finally {
      releaseStart.resolve();
      await h.close();
    }
  },
);

test("Widget projects live child activity and queued details expose frozen configuration and budget", async () => {
  const eightStarted = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        yield { type: "text_delta", text: "Inspecting exact repository evidence." };
        if (++calls === 8) eightStarted.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { columns: 120, rows: 48 },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "visible-nine",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: Array.from({ length: 9 }, (_, index) => ({
            role: "builtin:explore",
            task: `Read item ${index + 1}`,
            description: `Evidence ${index + 1}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await eightStarted.promise;
    await h.press("Independent Main draft", "Independent Main draft");
    const screen = h.terminal.lines().join("\n");
    expect(screen).toContain("Inspecting exact repository evidence.");
    expect(screen).toContain("● Agents · 8 running · 1 queued");
    await h.press("\u0001\u000b/agents\r", "Agents workspace");
    await h.press("\u001b[F", "@explore-9");
    await h.press("\r", "Queued tasks are immutable.");
    const detail = h.terminal.lines().join("\n");
    expect(detail).toContain("Evidence 9");
    expect(detail).toContain("deepseek-v4-flash.direct");
    expect(detail).toContain("thinking default");
    expect(detail).toContain("0 used");
    expect(detail).toContain("0 reserved");
    const queued = h.presentation.getState().authoritative.managedControl?.threads[8];
    expect(queued?.turn.configuration).toMatchObject({
      targetId: "deepseek-v4-flash.direct",
      thinking: "default",
      contextWindowTokens: 128000,
    });
    expect(queued?.budget).toMatchObject({
      knownUsed: 0,
      outstandingReserved: 0,
      unknownReserved: 0,
      ceiling: null,
      available: null,
    });
    expect(calls).toBe(8);
  } finally {
    await h.close();
  }
});

test("thirty-two admitted agents compress truthfully without hiding the Main editor", async () => {
  const eightStarted = Promise.withResolvers<void>();
  const firstFinish = Promise.withResolvers<void>();
  const ninthStarted = Promise.withResolvers<void>();
  let calls = 0;
  let ninthRequest = "";
  const h = await startManagedTui(
    {
      async *stream(request) {
        const call = ++calls;
        if (call === 8) eightStarted.resolve();
        if (call === 9) {
          ninthRequest = JSON.stringify(request.messages);
          ninthStarted.resolve();
        }
        await Promise.race([
          call === 1 ? firstFinish.promise : new Promise<void>(() => {}),
          new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        yield { type: "text_delta", text: "Finished this evidence item." };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      columns: 40,
      rows: 16,
      deadlineScheduler: {
        schedule() {
          return { cancel() {} };
        },
      },
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "visible-thirty-two",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: Array.from({ length: 32 }, (_, index) => ({
            role: "builtin:explore",
            task: `Read item ${index + 1}`,
            description: `Evidence ${index + 1}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await eightStarted.promise;
    await h.press("Main draft", "Main draft");
    const screen = h.terminal.lines().join("\n");
    expect(screen).toContain("Main draft");
    expect(screen).toContain("● Agents · 8 running · 24 queued");
    expect(screen).toContain("… hidden 7 run/24 queued/1 line");
    expect(screen).toContain("Fleet");
    const admitted = h.presentation.getState().authoritative.managedControl?.threads ?? [];
    expect(admitted).toHaveLength(32);
    expect(admitted.filter((thread) => thread.turn.phase === "executing")).toHaveLength(8);
    expect(admitted.filter((thread) => thread.turn.phase === "queued")).toHaveLength(24);
    expect(calls).toBe(8);
    const beforeFinish = h.terminal.output().length;
    firstFinish.resolve();
    await ninthStarted.promise;
    await h.terminal.waitForFrameAfter("… hidden 7 run/23 queued/1 done/1 line", beforeFinish);
    expect(calls).toBe(9);
    expect(ninthRequest).toContain("Read item 9");
    const advanced = h.presentation.getState().authoritative.managedControl?.threads ?? [];
    expect(advanced[8]?.turn.phase).toBe("executing");
    expect(advanced.filter((thread) => thread.turn.phase === "queued")).toHaveLength(23);
    const mixed = h.terminal.lines().join("\n");
    expect(mixed).toContain("Main draft");
    expect(mixed).toContain("Fleet");
  } finally {
    firstFinish.resolve();
    await h.close();
  }
});

test("queued agents stay individually inspectable and exact cancellation never opens a dead Fleet row", async () => {
  const eightStarted = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      if (++calls === 8) eightStarted.resolve();
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
        commandId: "queued-inspection",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: Array.from({ length: 9 }, (_, index) => ({
            role: "builtin:explore",
            task: `Private task ${index + 1}`,
            description: `Queued evidence ${index + 1}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await eightStarted.promise;
    await h.press("/agents\r", "Agents workspace");
    await h.press("\u001b[F", "@explore-9");
    await h.press("\r", "Queued tasks are immutable.");
    const detail = h.terminal.lines().join("\n");
    expect(detail).toContain("deepseek-v4-flash.direct");
    expect(detail).toContain("thinking default");
    expect(detail).toContain("no cumulative budget");
    expect(detail).not.toContain("Private task 9");
    await h.press("x", "x again to cancel");
    await h.press("x", "Cancelled");
    expect(h.presentation.getState().authoritative.managedControl?.threads[8]?.turn).toMatchObject({
      phase: "idle",
      lastOutcome: "cancelled",
    });
    expect(calls).toBe(8);
    await h.press("\u001b[27;1;27~", "Agents workspace", "Esc list");
    await h.press("\u001b[27;1;27~", "Fleet", "Agents workspace");
    expect(
      h.terminal.lines().join("\n").slice(h.terminal.lines().join("\n").indexOf("Fleet ·")),
    ).not.toContain("@explore-9");
  } finally {
    await h.close();
  }
});

test("terminal Widget and Fleet linger expires without removing the full agent history", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deadlines = new Map<object, { readonly milliseconds: number; readonly fire: () => void }>();
  const scheduler: DeadlineScheduler = {
    schedule(milliseconds, fire) {
      const key = {};
      deadlines.set(key, { milliseconds, fire });
      return {
        cancel() {
          deadlines.delete(key);
        },
      };
    },
  };
  const h = await startManagedTui(
    {
      async *stream() {
        started.resolve();
        await release.promise;
        yield { type: "text_delta", text: "Retained history evidence." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { deadlineScheduler: scheduler },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "linger",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Inspect evidence.", description: "Linger evidence" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("Linger evidence");
    const before = h.terminal.output().length;
    release.resolve();
    await h.terminal.waitForFrameAfter("Completed", before);
    expect(h.terminal.lines().join("\n")).toContain("Linger evidence");
    const timers = [...deadlines.values()].filter((entry) => entry.milliseconds === 4000);
    expect(timers).toHaveLength(1);
    const beforeExpiry = h.terminal.output().length;
    for (const timer of timers) timer.fire();
    await h.terminal.waitForFrameAfter("Adam · Fleet fixture", beforeExpiry);
    expect(h.terminal.lines().join("\n")).not.toContain("Linger evidence");
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(1);
    await h.press("/agents\r", "Agents workspace");
    expect(h.terminal.lines().join("\n")).toContain("Linger evidence");
  } finally {
    release.resolve();
    await h.close();
  }
  expect(deadlines.size).toBe(0);
});

test("ConversationViewer follows live output, preserves manual scroll, and survives settlement", async () => {
  const started = Promise.withResolvers<void>();
  const releaseLines = Promise.withResolvers<void>();
  const releaseNewest = Promise.withResolvers<void>();
  const newestEmitted = Promise.withResolvers<void>();
  const releaseFinish = Promise.withResolvers<void>();
  const h = await startManagedTui({
    async *stream() {
      yield { type: "text_delta", text: "First live line.\n" };
      started.resolve();
      await releaseLines.promise;
      yield {
        type: "text_delta",
        text: `${Array.from({ length: 50 }, (_, index) => `Live line ${index + 1}`).join("\n")}\n`,
      };
      await releaseNewest.promise;
      yield { type: "text_delta", text: "Newest live tail." };
      newestEmitted.resolve();
      await releaseFinish.promise;
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "live-viewer",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Read viewer evidence.",
              description: "Live viewer evidence",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    expect(h.conversationText()).toContain("First live line.");
    await h.press("d", "Conversation details");
    expect(h.terminal.lines().join("\n")).toContain("deepseek-v4-flash.direct · thinking default");
    expect(h.terminal.lines().join("\n")).toContain("128000 context");
    await h.press("\u001b", "First live line.", "Conversation details");
    const beforeLines = h.terminal.output().length;
    releaseLines.resolve();
    await h.terminal.waitForFrameAfter("Live line 50", beforeLines);
    await h.press("k", "Manual scroll");
    await h.press("j", "Following tail");
    await h.press("\u001b[1;2A", "Manual scroll");
    await h.press("\u001b[1;2B", "Following tail");
    const previousKeys = getKeybindings();
    try {
      setKeybindings(
        new KeybindingsManager(TUI_KEYBINDINGS, {
          "tui.select.up": "ctrl+p",
          "tui.select.down": "ctrl+n",
          "tui.select.pageUp": "ctrl+b",
          "tui.select.pageDown": "ctrl+f",
        }),
      );
      await h.press("\u0010", "Manual scroll");
      await h.press("\u000e", "Following tail");
      await h.press("\u0002", "Manual scroll");
      await h.press("\u0006", "Following tail");
      await h.press("k", "Manual scroll");
      await h.press("j", "Following tail");
    } finally {
      setKeybindings(previousKeys);
    }
    await h.press("\u001b[H", "First live line.");
    releaseNewest.resolve();
    await newestEmitted.promise;
    await h.press("\u001b[A", "First live line.");
    expect(h.conversationText()).toContain("First live line.");
    expect(h.conversationText()).not.toContain("Newest live tail.");
    await h.press("\u001b[F", "Newest live tail.");
    const beforeFinish = h.terminal.output().length;
    releaseFinish.resolve();
    await h.terminal.waitForFrameAfter("Completed", beforeFinish);
    expect(h.terminal.lines().join("\n")).toContain("Conversation · @explore-1");
    expect(h.conversationText()).toContain("Newest live tail.");
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.phase).toBe(
      "idle",
    );
  } finally {
    releaseLines.resolve();
    releaseNewest.resolve();
    releaseFinish.resolve();
    await h.close();
  }
});

test("viewer cycles assistant Markdown, full Markdown and raw without rewriting literal markers", async () => {
  const text = "# Evidence\n\n**Bold proof**\n\n3) first\n7) seventh\n\n\\*literal\\*";
  const h = await startManagedTui({
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "markdown-viewer",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Read evidence.", description: "Markdown evidence" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    expect(h.conversationText()).toContain("Bold proof");
    expect(h.conversationText()).not.toContain("**Bold proof**");
    expect(h.conversationText()).toContain("m assistant Markdown");
    await h.press("m", "m full Markdown");
    await h.press("m", "m raw");
    expect(h.conversationText()).toContain("**Bold proof**");
    expect(h.conversationText()).toContain("3) first");
    expect(h.conversationText()).toContain("7) seventh");
    expect(h.conversationText()).toContain("\\*literal\\*");
    await h.press("m", "m assistant Markdown");
    expect(h.conversationText()).toContain("3) first");
    expect(h.conversationText()).toContain("7) seventh");
  } finally {
    await h.close();
  }
});

test("viewer loads bounded older transcript pages and returns to the current tail without consumption", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      const number = ++calls;
      yield {
        type: "text_delta",
        text: number === 13 ? "Newest evidence page." : `Page evidence ${number}.`,
      };
      if (number < 13) {
        yield { type: "tool_call_start", id: `page-read-${number}`, name: "read_file" };
        yield {
          type: "tool_call_delta",
          id: `page-read-${number}`,
          json: '{"path":"package.json"}',
        };
        yield { type: "tool_call_end", id: `page-read-${number}` };
      }
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: number < 13 ? "tool_calls" : "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "paged-transcript",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Read the evidence boundaries.",
              description: "Paged evidence",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing thread");
    await new Promise<void>((resolve) => {
      const check = () => {
        if (
          h.presentation
            .getState()
            .authoritative.managedControl?.completions.some(
              (completion) => completion.turnId === thread.turn.turnId,
            )
        ) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = h.presentation.subscribe(check);
      check();
    });
    const command = {
      type: "read_agent_conversation" as const,
      sessionId: thread.parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      cursor: null,
    };
    const receipt = await h.presentation.dispatch(command);
    if (receipt.status !== "admitted" || receipt.managedAgentTranscript === undefined)
      throw new Error("Missing bounded page");
    expect(receipt.managedAgentTranscript.items.length).toBeLessThanOrEqual(20);
    expect(receipt.managedAgentTranscript.olderCursor).not.toBeNull();
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Newest evidence page.");
    expect(h.conversationText()).not.toContain("Page evidence 1.");
    await h.press("\u001b[H", "Manual scroll");
    await h.press("\u001b[5~", "Page evidence 1.");
    await h.press("\u001b[F", "Newest evidence page.");
    expect(
      h.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
    ).toBe("pending");
    expect(
      await h.presentation.dispatch({
        ...command,
        cursor:
          receipt.managedAgentTranscript.olderCursor?.replace(
            thread.threadId,
            "00000000-0000-4000-8000-000000000001",
          ) ?? "invalid",
      }),
    ).toMatchObject({ status: "rejected", code: "invalid_command" });
    expect(calls).toBe(13);
  } finally {
    await h.close();
  }
});

test("live transcript elision is counted separately from the bounded Markdown content", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const text = `\x60\x60\x60text\n${"x".repeat(19992)}`;
  const h = await startManagedTui({
    async *stream() {
      yield { type: "text_delta", text };
      started.resolve();
      await finish.promise;
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "live-elision",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect evidence.",
              description: "Bounded live preview",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    expect(h.presentation.getState().managedAgentActivity?.[0]?.assistant).toMatchObject({
      totalByteCount: 20000,
      omittedBytes: 3616,
    });
    expect(h.presentation.getState().managedAgentActivity?.[0]?.assistant?.text).not.toContain(
      "bytes omitted",
    );
    expect(h.conversationText()).toContain("Live preview · 3616 bytes omitted");
  } finally {
    finish.resolve();
    await h.close();
  }
});

test("child permission preempts and restores the exact independent composer without capturing Main", async () => {
  const started = Promise.withResolvers<void>();
  const ask = Promise.withResolvers<void>();
  let childCalls = 0;
  let mainCalls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          mainCalls += 1;
          yield { type: "text_delta", text: "Main after permission." };
        } else if (++childCalls === 1) {
          yield { type: "text_delta", text: "Child preparing an exact read." };
          started.resolve();
          await ask.promise;
          yield { type: "tool_call_start", id: "permission-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "permission-read", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "permission-read" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        } else yield { type: "text_delta", text: "Child permission completed." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
    },
  );
  let sawAttention = false;
  const restored = Promise.withResolvers<number>();
  const unsubscribe = h.presentation.subscribe(() => {
    const attention = h.presentation.getState().managedAttention ?? [];
    if (attention.length > 0) sawAttention = true;
    else if (sawAttention) restored.resolve(h.terminal.output().length);
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "permission-focus",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Read only after permission.",
              description: "Permission focus",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\r", "Cooperative");
    await h.press("Kept child draft", "Kept child draft");
    const beforeAsk = h.terminal.output().length;
    ask.resolve();
    await h.terminal.waitForFrameAfter("Attention Center", beforeAsk);
    await h.terminal.waitForFrameAfter("package.json", beforeAsk);
    expect(h.terminal.lines().join("\n")).toContain("Permissions");
    expect(h.terminal.lines().join("\n")).toContain("Parent input");
    h.terminal.input("a");
    const restoreOffset = await restored.promise;
    await h.terminal.waitForFrameAfter("To @explore-1", restoreOffset);
    await h.press(" remains", "Kept child draft remains");
    expect(h.presentation.getState().composer.renderedText).toBe("");
    expect(mainCalls).toBe(0);
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\u001b", "Esc Main", "Conversation ·");
    await h.press("\u001b", "Fleet · ↓ navigate");
    await h.press("Main prompt.\r", "Main after permission.");
    expect(mainCalls).toBe(1);
  } finally {
    unsubscribe();
    ask.resolve();
    await h.close();
  }
});

test("viewer x x cancels the exact turn only on two presses and retains unknown usage", async () => {
  const started = Promise.withResolvers<void>();
  let aborts = 0;
  const h = await startManagedTui({
    async *stream(request) {
      started.resolve();
      await new Promise<void>((resolve) => {
        const abort = () => {
          aborts += 1;
          resolve();
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "kitty-cancel",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect evidence.",
              description: "Exact cancellation",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Explore · Running");
    await h.openFirstAgent();
    await h.press("\u001b[120;1:1u", "x again to cancel");
    h.terminal.input("\u001b[120;1:2u\u001b[120;1:3u");
    await h.press("m", "m full Markdown");
    expect(aborts).toBe(0);
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.phase).toBe(
      "executing",
    );
    await h.press("\u001b[120;1:1u", "x again to cancel");
    await h.press("\u001b[120;1:1u", "Cancelled");
    expect(aborts).toBe(1);
    expect(
      h.presentation.getState().authoritative.managedControl?.threads[0]?.budget?.unknownReserved,
    ).toBeGreaterThan(0);
    await h.press("d", "Conversation details");
    expect(h.terminal.lines().join("\n")).toContain("unknown reserved");
  } finally {
    await h.close();
  }
});

test("Attention defaults to one exact permission and explicit multi-selection decides only selected calls", async () => {
  const feedback: string[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        const result = request.messages.findLast((message) => message.role === "tool");
        if (result?.role === "tool") {
          feedback.push(result.result.status);
          yield { type: "text_delta", text: "Permission result handled." };
        } else {
          yield { type: "tool_call_start", id: "same-call-id", name: "read_file" };
          yield { type: "tool_call_delta", id: "same-call-id", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "same-call-id" };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: result === undefined ? "tool_calls" : "stop" };
      },
    },
    {
      permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
    },
  );
  const spawn = () =>
    h.presentation.dispatch({
      type: "managed_control",
      commandId: "two-permissions",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [
          { role: "builtin:explore", task: "Permission A", description: "Permission A" },
          { role: "builtin:explore", task: "Permission B", description: "Permission B" },
        ],
      },
    });
  try {
    expect(await spawn()).toMatchObject({ status: "admitted" });
    const first = await h.waitForAttention(
      (items) =>
        items.length === 2 &&
        items.every(
          (item) => item.kind === "permission" && item.interaction !== null && item.available,
        ),
    );
    await h.terminal.waitForScreen("read · package.json");
    const checked = first.filter((item) =>
      h.terminal.lines().join("\n").includes(`[x] ${item.handle}`),
    );
    expect(checked).toHaveLength(1);
    h.terminal.input("a");
    const remaining = await h.waitForAttention((items) => items.length === 1);
    expect(remaining[0]?.id).not.toBe(checked[0]?.id);
    await h.terminal.waitForScreen("Permissions · 1");
    h.terminal.input("d");
    await h.waitForAttention((items) => items.length === 0);
    const denied = h.presentation
      .getState()
      .authoritative.managedControl?.threads.find(
        (thread) => thread.threadId === remaining[0]?.threadId,
      );
    if (denied === undefined) throw new Error("Missing denied child");
    const deniedRecords = await (await h.children.open(denied.turn.childSessionId))?.read();
    expect(
      deniedRecords?.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_started",
      ),
    ).toBe(false);
    const before = h.terminal.output().length;
    expect(await spawn()).toMatchObject({ status: "admitted" });
    const next = await h.waitForAttention(
      (items) =>
        items.length === 2 &&
        items.every(
          (item) => item.kind === "permission" && item.interaction !== null && item.available,
        ),
    );
    await h.terminal.waitForFrameAfter("Permissions · 2", before);
    const selectedIndex = next.findIndex((item) =>
      h.terminal.lines().join("\n").includes(`[x] ${item.handle}`),
    );
    const other = next[selectedIndex === 0 ? 1 : 0];
    if (other === undefined) throw new Error("Missing second permission");
    await h.press(" ", "Space toggle");
    await h.press(`${selectedIndex === 0 ? "\u001b[B" : "\u001b[A"} `, `[x] ${other.handle}`);
    h.terminal.input("a");
    await h.waitForAttention((items) => items.length === 0);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(4);
    const targets =
      h.presentation.getState().authoritative.managedControl?.threads.map((thread) => ({
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
      })) ?? [];
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "joined-permissions",
        command: { type: "wait_agents", parentSessionId: h.parent.sessionId, mode: "all", targets },
      }),
    ).toMatchObject({ status: "admitted", control: { status: "completed" } });
    expect(feedback.toSorted()).toEqual(["completed", "completed", "completed", "failed"]);
  } finally {
    await h.close();
  }
});

test("Parent input in Attention cannot grant a separate child permission", async () => {
  const replied = Promise.withResolvers<void>();
  let mainCalls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (request.tools.some((tool) => tool.name === "spawn_agents")) mainCalls += 1;
        const questionChild = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Ask the parent"),
        );
        const result = request.messages.findLast((message) => message.role === "tool");
        if (result === undefined) {
          const name = questionChild ? "request_parent_input" : "read_file";
          yield { type: "tool_call_start", id: "exact-question-or-permission", name };
          yield {
            type: "tool_call_delta",
            id: "exact-question-or-permission",
            json: questionChild
              ? '{"question":"Which response should I use?"}'
              : '{"path":"package.json"}',
          };
          yield { type: "tool_call_end", id: "exact-question-or-permission" };
        } else {
          if (questionChild) {
            expect(JSON.stringify(request.messages)).toContain("allow");
            replied.resolve();
          }
          yield { type: "text_delta", text: "Exact attention result." };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: result === undefined ? "tool_calls" : "stop" };
      },
    },
    {
      permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "mixed-attention",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Read with permission.",
              description: "Read approval",
            },
            {
              role: "builtin:explore",
              task: "Ask the parent for text.",
              description: "Parent question",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    const items = await h.waitForAttention(
      (attention) => attention.length === 2 && attention.every((item) => item.available),
    );
    const permission = items.find((item) => item.kind === "permission");
    await h.terminal.waitForScreen("Parent input · 1");
    await h.press("\u001b[F\r", "Which response should I use?");
    await h.press("allow", "> allow");
    h.terminal.input("\r");
    await replied.promise;
    const remaining = await h.waitForAttention((attention) => attention.length === 1);
    expect(remaining[0]).toMatchObject({ kind: "permission", id: permission?.id });
    expect(mainCalls).toBe(0);
    await h.terminal.waitForScreen("Permissions · 1");
    h.terminal.input("d");
    await h.waitForAttention((attention) => attention.length === 0);
  } finally {
    await h.close();
  }
});

test("Agents history opens each exact turn and keeps closed threads inspectable without input actions", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      yield {
        type: "text_delta",
        text: ++calls === 1 ? "FIRST_TURN_EVIDENCE" : "SECOND_TURN_EVIDENCE",
      };
      yield { type: "usage", inputTokens: 10, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "history-start",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [{ role: "builtin:explore", task: "First task", description: "History subject" }],
      },
    });
    await h.terminal.waitForScreen("Completed");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (first === undefined) throw new Error("Missing thread");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "FIRST_TURN_EVIDENCE");
    await h.press("\r", "New turn");
    await h.press("Second task\r", "SECOND_TURN_EVIDENCE");
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\u001b", "Agents workspace");
    await h.press("h", "Agents history");
    await h.press("\u001b[H\r", "FIRST_TURN_EVIDENCE");
    expect(h.conversationText()).not.toContain("SECOND_TURN_EVIDENCE");
    await h.press("\r", "Input is unavailable");
    expect(h.conversationText()).not.toContain("New turn");
    await h.press("\u001b", "Agents history");
    await h.press("h", "Agents workspace");
    await h.press("c", "c again to close");
    await h.press("c", "Closed");
    await h.press("h", "Agents history");
    await h.press("\u001b[F\r", "SECOND_TURN_EVIDENCE");
    await h.press("\r", "Input is unavailable");
    expect(calls).toBe(2);
    expect(
      h.presentation
        .getState()
        .authoritative.managedControl?.completions.map((entry) => entry.consumption),
    ).toEqual(["pending", "pending"]);
  } finally {
    await h.close();
  }
});

test.each([
  [40, 12],
  [67, 18],
  [80, 24],
  [120, 40],
])(
  "%i×%i keeps the focused child editor and layered return usable with grapheme input",
  async (columns, rows) => {
    const started = Promise.withResolvers<void>();
    let mainCalls = 0;
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (request.tools.some((tool) => tool.name === "spawn_agents")) {
            mainCalls += 1;
            yield { type: "text_delta", text: "MAIN_RESPONDED" };
          } else {
            started.resolve();
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { columns, rows },
    );
    try {
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "viewport-spawn",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Inspect", description: "视图 é 👩‍💻" }],
        },
      });
      await started.promise;
      await h.openFirstAgent();
      await h.press("\r", "To @explore-1");
      await h.press("界é👩‍💻", "é👩‍💻");
      const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
      if (thread === undefined) throw new Error("Missing viewport child");
      expect(
        await h.presentation.dispatch({
          type: "read_agent_draft",
          sessionId: thread.parentSessionId,
          threadId: thread.threadId,
        }),
      ).toMatchObject({ managedDraft: { text: "界é👩‍💻" } });
      expect(h.terminal.lines().join("\n")).not.toContain("�");
      await h.press("\u001b[27u", "Draft");
      await h.press("d", "Conversation details");
      expect(h.terminal.lines().join("\n")).toContain("deepseek-v4-flash.direct");
      await h.press("\u001b[27u", "Draft");
      await h.press("\u001b[27u", "Fleet");
      await h.press("\u001b[27u", "Fleet");
      await h.press("Main remains usable\r", "MAIN_RESPONDED");
      expect(mainCalls).toBe(1);
      expect(h.presentation.getState().managedDrafts).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
);

test("Widget retains elapsed and optional model while details expose current usage", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const usageRendered = Promise.withResolvers<void>();
  const h = await startManagedTui(
    {
      async *stream() {
        started.resolve();
        await finish.promise;
        yield { type: "text_delta", text: "Timed evidence" };
        yield { type: "usage", inputTokens: 23, outputTokens: 17 };
        await usageRendered.promise;
        yield { type: "finish", reason: "stop" };
      },
    },
    { columns: 120, rows: 40 },
  );
  try {
    const beforeStart = Date.now();
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "timed-widget",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [{ role: "builtin:explore", task: "Inspect", description: "Timed child" }],
      },
    });
    await started.promise;
    await h.terminal.waitForScreen("elapsed");
    await h.press("/agents settings\r", "Agent settings");
    await h.press("\u001b[B\u001b[B\r", "Model/thinking · shown");
    await h.press("\u001b", "thinking default");
    expect(h.terminal.lines().join("\n")).not.toMatch(/\d+ used|\d+ reserved/u);
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation ·");
    await h.press("d", "Conversation details");
    expect(h.terminal.lines().join("\n")).toContain("0 used");
    const offset = h.terminal.output().length;
    finish.resolve();
    await h.terminal.waitForFrameAfter("40 used", offset);
    usageRendered.resolve();
    await h.terminal.waitForFrameAfter("Completed", offset);
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(thread?.turn.startedAtUnixMilliseconds).toBeGreaterThanOrEqual(beforeStart);
    expect(thread?.turn.outcome?.atUnixMilliseconds).toBeGreaterThanOrEqual(
      thread?.turn.startedAtUnixMilliseconds ?? Infinity,
    );
    expect(h.terminal.lines().join("\n")).toContain("40 used");
  } finally {
    finish.resolve();
    usageRendered.resolve();
    await h.close();
  }
});

test("40×12 Attention default selection follows the visible exact request and preserves the other pending call", async () => {
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield { type: "tool_call_start", id: "narrow-permission", name: "read_file" };
          yield {
            type: "tool_call_delta",
            id: "narrow-permission",
            json: '{"path":"package.json"}',
          };
          yield { type: "tool_call_end", id: "narrow-permission" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "NARROW_ALLOWED" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    {
      columns: 40,
      rows: 12,
      permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "narrow-permissions",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [1, 2].map((index) => ({
            role: "builtin:explore" as const,
            task: "Read package.json",
            description: `Permit ${index}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.waitForAttention(
      (items) =>
        items.length === 2 &&
        items.every((item) => item.kind === "permission" && item.interaction?.canAllow === true),
    );
    await h.terminal.waitForScreen("Attention Center");
    await h.press("\u001b[B", "@explore-2");
    expect(h.terminal.lines().join("\n")).toContain("● [x] @explore-2");
    await h.press("a", "@explore-1");
    await h.waitForAttention((items) => items.length === 1 && items[0]?.handle === "@explore-1");
    const threads = h.presentation.getState().authoritative.managedControl?.threads ?? [];
    const first = threads.find((thread) => thread.handle === "@explore-1");
    const second = threads.find((thread) => thread.handle === "@explore-2");
    if (first === undefined || second === undefined) throw new Error("Missing exact children");
    expect(
      (await (await h.children.open(first.turn.childSessionId))?.read())?.some(
        (record) =>
          record.schemaVersion === 3 &&
          record.record.type === "runtime_event" &&
          record.record.event.type === "tool_started",
      ),
    ).toBe(false);
    await h.press("\u001b[27u", "Fleet");
    await h.press("/agents attention\r", "Attention Center");
    await h.press("d", "Fleet");
  } finally {
    await h.close();
  }
});

test("minimum-height Settings cannot activate an off-screen Reset before its selected row is rendered", async () => {
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        calls += 1;
        yield { type: "finish", reason: "stop" };
      },
    },
    { columns: 40, rows: 12 },
  );
  try {
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "settings-visible",
      command: { type: "list_agents", parentSessionId: h.parent.sessionId },
    });
    await h.press("/agents settings\r", "Agent settings");
    await h.press("\r", "Widget · all");
    await h.press("\u001b[F\r", "Reset defaults");
    expect(h.presentation.getState().agentUiSettings?.widgetMode).toBe("all");
    await h.press("\r", "Defaults restored");
    expect(h.presentation.getState().agentUiSettings?.widgetMode).toBe("background");
    expect(calls).toBe(0);
  } finally {
    await h.close();
  }
});

test("a cold acknowledged provider attempt offers inspection and cancellation without advertising safe replay", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const driver = {
    async *stream(request: ModelRequest) {
      calls += 1;
      started.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const h = await startManagedTui(driver);
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "unsafe-cold",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Inspect", description: "Acknowledged provider" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing source thread");
    const controlPrefix = await h.store.read();
    const childPrefix = await (await h.children.open(thread.turn.childSessionId))?.read();
    if (childPrefix === undefined) throw new Error("Missing committed child prefix");
    await h.stop();
    const store = createInMemoryManagedAgentControlStore();
    for (const record of controlPrefix) await store.append(record);
    const children = createInMemorySessionStoreDirectory<SessionRecord>();
    const child = await children.create(thread.turn.childSessionId);
    for (const record of childPrefix) await child.append(record);
    cold = await startManagedTui(driver, { restore: { ...h.storage, store, children } });
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Conversation");
    expect(cold.conversationText()).toContain("This interrupted effect cannot be replayed safely.");
    expect(cold.conversationText()).not.toContain("Resume or cancel");
    expect(
      cold.presentation.getState().authoritative.managedControl?.threads[0]?.actions,
    ).not.toContain("resume");
    expect(calls).toBe(1);
    await cold.press("x", "x again to cancel");
    await cold.press("x", "Cancelled");
    expect(calls).toBe(1);
  } finally {
    await (cold ?? h).close();
  }
});

test("opening and cold-reopening a completed viewer marks Seen independently of one canonical Main consumption", async () => {
  const requests: ModelRequest[] = [];
  const driver = {
    async *stream(request: ModelRequest) {
      const main = request.tools.some((tool) => tool.name === "spawn_agents");
      if (main) requests.push(request);
      yield {
        type: "text_delta" as const,
        text: main ? `MAIN_SEEN_${requests.length}` : "SEEN_RESULT",
      };
      yield { type: "usage" as const, inputTokens: 10, outputTokens: 10 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const h = await startManagedTui(driver);
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "seen-start",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Inspect", description: "Seen subject" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Seen · Main pending");
    expect(h.presentation.getState().authoritative.managedControl?.completions[0]).toMatchObject({
      userSeen: true,
      consumption: "pending",
    });
    expect(requests).toHaveLength(0);
    await h.stop();
    cold = await startManagedTui(driver, { restore: h.storage });
    expect(cold.presentation.getState().authoritative.managedControl?.completions[0]).toMatchObject(
      { userSeen: true, consumption: "pending" },
    );
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Seen · Main pending");
    await cold.press("\u001b", "Agents workspace");
    await cold.press("\u001b", "Fleet fixture");
    await cold.press("Consume seen completion.\r", "MAIN_SEEN_1");
    const restarted = cold;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (restarted.presentation.getState().authoritative.active?.parentRun?.phase === "ready") {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = restarted.presentation.subscribe(check);
      check();
    });
    await cold.press("Next Main input.\r", "MAIN_SEEN_2");
    expect(requests).toHaveLength(2);
    expect(cold.presentation.getState().authoritative.managedControl?.completions[0]).toMatchObject(
      { userSeen: true, consumption: "consumed" },
    );
    const parentRecords = await (await cold.sessions.open(h.parent.sessionId))?.read();
    expect(
      parentRecords?.flatMap((record) =>
        record.schemaVersion === 3 && record.record.type === "provider_attempt_started"
          ? [record.record.managedAgentDeliveries?.length ?? 0]
          : [],
      ),
    ).toEqual([1, 0]);
    expect(
      (await cold.store.read()).filter((record) => record.event.type === "consumed"),
    ).toHaveLength(1);
  } finally {
    await (cold ?? h).close();
  }
});

test("Suppress from Main requires exact confirmation, refuses active Main, and leaves the other completion deliverable", async () => {
  const finishChildren = Promise.withResolvers<void>();
  const finishMain = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  let childCalls = 0;
  const h = await startManagedTui({
    async *stream(request) {
      if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", text: "MAIN_ACTIVE" };
          await finishMain.promise;
        }
        yield { type: "text_delta", text: `MAIN_FINISHED_${requests.length}` };
      } else {
        childCalls += 1;
        const continuation = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Continue after suppression"),
        );
        if (!continuation) await finishChildren.promise;
        const suppress = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Suppress task"),
        );
        yield {
          type: "text_delta",
          text: continuation
            ? "CONTINUED_SUPPRESSED"
            : suppress
              ? "SUPPRESS_RESULT"
              : "KEEP_RESULT",
        };
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "suppress-pair",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Suppress task", description: "Suppress target" },
            { role: "builtin:explore", task: "Keep task", description: "Keep target" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.press("Main remains active.\r", "MAIN_ACTIVE");
    const offset = h.terminal.output().length;
    finishChildren.resolve();
    await h.terminal.waitForFrameAfter("Completed", offset);
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Seen · Main pending");
    await h.press("s", "Suppress from Main");
    await h.press("\u001b", "Seen · Main pending");
    expect((await h.store.read()).some((record) => record.event.type === "suppressed")).toBe(false);
    await h.press("s", "Suppress from Main");
    await h.press("s", "Main is active");
    finishMain.resolve();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (h.presentation.getState().authoritative.active?.parentRun?.phase === "ready") {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = h.presentation.subscribe(check);
      check();
    });
    await h.press("s", "Suppress from Main");
    await h.press("s", "Seen · Main suppressed");
    const suppressed = h.presentation
      .getState()
      .authoritative.managedControl?.completions.find(
        (entry) => entry.outcome.summary === "SUPPRESS_RESULT",
      );
    expect(suppressed).toMatchObject({ userSeen: true, consumption: "suppressed" });
    await h.press("\u001b", "Agents workspace");
    await h.press("\u001b", "Fleet fixture");
    await h.press("Next Main input.\r", "MAIN_FINISHED_2");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("SUPPRESS_RESULT");
    expect(JSON.stringify(requests[1]?.messages)).toContain("KEEP_RESULT");
    await new Promise<void>((resolve) => {
      const check = () => {
        if (h.presentation.getState().authoritative.active?.parentRun?.phase === "ready") {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = h.presentation.subscribe(check);
      check();
    });
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Seen · Main suppressed");
    await h.press("\r", "New turn");
    await h.press("Continue after suppression.\r", "CONTINUED_SUPPRESSED");
    expect(childCalls).toBe(3);
    expect(requests).toHaveLength(2);
  } finally {
    finishChildren.resolve();
    finishMain.resolve();
    await h.close();
  }
});

test("a committed suppression holds the existing family admission until the concurrent Main request can exclude it", async () => {
  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        const main = request.tools.some((tool) => tool.name === "spawn_agents");
        if (main) requests.push(request);
        yield { type: "text_delta", text: main ? "RACE_MAIN_READY" : "RACE_SUPPRESSED_RESULT" };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      controlRecordBarrier: async (record) => {
        if (record.event.type === "suppressed") {
          committed.resolve();
          await release.promise;
        }
      },
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "suppression-race",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Inspect", description: "Suppression race" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Seen · Main pending");
    await h.press("s", "Suppress from Main");
    h.terminal.input("s");
    await committed.promise;
    await h.press("\u001b", "Agents workspace");
    await h.press("\u001b", "Fleet fixture");
    const parentBefore = await (await h.sessions.open(h.parent.sessionId))?.read();
    await h.press("Main after suppressed record.\r", "Working");
    expect(requests).toHaveLength(0);
    expect(await (await h.sessions.open(h.parent.sessionId))?.read()).toEqual(parentBefore);
    const offset = h.terminal.output().length;
    release.resolve();
    await h.terminal.waitForFrameAfter("RACE_MAIN_READY", offset);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("RACE_SUPPRESSED_RESULT");
    expect(
      h.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
    ).toBe("suppressed");
  } finally {
    release.resolve();
    await h.close();
  }
});

test("cold Seen and Suppress reconcile an already durable wait tool result before any visibility mutation can hide consumption", async () => {
  const finish = Promise.withResolvers<void>();
  let target: { readonly threadId: string; readonly expectedTurnId: string } | undefined;
  let mainCalls = 0;
  const driver = {
    async *stream(request: ModelRequest) {
      if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        if (++mainCalls === 1) {
          yield { type: "tool_call_start" as const, id: "exact-wait", name: "wait_agents" };
          yield {
            type: "tool_call_delta" as const,
            id: "exact-wait",
            json: JSON.stringify({ targets: [target], mode: "all" }),
          };
          yield { type: "tool_call_end" as const, id: "exact-wait" };
          yield { type: "usage" as const, inputTokens: 10, outputTokens: 10 };
          yield { type: "finish" as const, reason: "tool_calls" as const };
          return;
        }
        yield { type: "text_delta" as const, text: "TOOL_ACK_DONE" };
      } else {
        await finish.promise;
        yield { type: "text_delta" as const, text: "DURABLE_WAIT_RESULT" };
      }
      yield { type: "usage" as const, inputTokens: 10, outputTokens: 10 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const h = await startManagedTui(driver);
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "cold-tool-ack",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Inspect", description: "Durable wait" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing wait target");
    target = { threadId: thread.threadId, expectedTurnId: thread.turn.turnId };
    await h.press("Wait for exact evidence.\r", "wait_agents");
    const offset = h.terminal.output().length;
    finish.resolve();
    await h.terminal.waitForFrameAfter("TOOL_ACK_DONE", offset);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (h.presentation.getState().authoritative.active?.parentRun?.phase === "ready") {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = h.presentation.subscribe(check);
      check();
    });
    const records = await h.store.read();
    expect(records.some((record) => record.event.type === "consumed")).toBe(true);
    await h.stop();
    const store = createInMemoryManagedAgentControlStore();
    for (const record of records) {
      if (record.event.type === "consumed") break;
      await store.append(record);
    }
    cold = await startManagedTui(driver, { restore: { ...h.storage, store } });
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Seen · Main pending");
    await cold.press("s", "Suppress from Main");
    await cold.press("s", "Main has already consumed");
    expect(cold.presentation.getState().authoritative.managedControl?.completions[0]).toMatchObject(
      { consumption: "consumed", userSeen: true },
    );
    expect((await store.read()).filter((record) => record.event.type === "consumed")).toHaveLength(
      1,
    );
    expect((await store.read()).some((record) => record.event.type === "suppressed")).toBe(false);
    expect(mainCalls).toBe(2);
  } finally {
    finish.resolve();
    await (cold ?? h).close();
  }
});

test("a queued cancellation keeps per-thread export available without creating a child session or continuation action", async () => {
  let calls = 0;
  const eightStarted = Promise.withResolvers<void>();
  const h = await startManagedTui({
    async *stream(request) {
      calls += 1;
      if (calls === 8) eightStarted.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "queued-export",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: Array.from({ length: 9 }, (_, index) => ({
            role: "builtin:explore" as const,
            task: "Inspect",
            description: `Export queue ${index}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await eightStarted.promise;
    await h.press("/agents\r", "Agents workspace");
    await h.press("\u001b[F", "@explore-9");
    await h.press("x", "x again to cancel");
    await h.press("x", "Cancelled");
    await h.press("\r", "Enter result / export");
    await h.press("\r", "e export");
    expect(h.terminal.lines().join("\n")).toContain("e export");
    await h.press("e", "Export agent");
    await h.press("\r", "Confirm export");
    await h.press("\r", "Export ready");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[8];
    if (thread === undefined) throw new Error("Missing cancelled queue entry");
    expect(thread.actions).not.toContain("new_turn");
    expect(await h.children.open(thread.turn.childSessionId)).toBeUndefined();
    expect(h.presentation.getState().authoritative.managedControl?.exports?.[0]?.turnId).toBe(
      thread.turn.turnId,
    );
    expect(calls).toBe(8);
  } finally {
    await h.close();
  }
});

test("viewer Help disarms an earlier x-x cancellation before returning to the same live turn", async () => {
  const started = Promise.withResolvers<void>();
  let aborts = 0;
  const h = await startManagedTui({
    async *stream(request) {
      started.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            aborts += 1;
            resolve();
          },
          { once: true },
        ),
      );
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "cancel-help",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Inspect", description: "Cancel target" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    await h.press("x", "x again to cancel");
    await h.press("?", "Conversation help");
    await h.press("\u001b", "Following tail");
    await h.press("x", "x again to cancel");
    expect(h.conversationText()).toContain("x again to cancel");
    expect(aborts).toBe(0);
    await h.press("x", "Cancelled");
    expect(aborts).toBe(1);
  } finally {
    await h.close();
  }
});

test("40×12 child composer visibly distinguishes Accepted from Delivered across the real read boundary", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<ModelRequest>();
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        if (++calls === 1) {
          started.resolve();
          await release.promise;
          yield { type: "tool_call_start", id: "compact-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "compact-read", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "compact-read" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          delivered.resolve(request);
          yield { type: "text_delta", text: "Read boundary done." };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    { columns: 40, rows: 12 },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "compact-delivery",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [{ role: "builtin:explore", task: "Read", description: "Compact input" }],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    await h.press("\r", "To @explore-1");
    await h.press("Exact input", "Exact input");
    await h.press("\r", "Accepted");
    expect(
      h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs?.[0]?.status,
    ).toBe("accepted");
    const offset = h.terminal.output().length;
    release.resolve();
    const request = await delivered.promise;
    await h.terminal.waitForFrameAfter("Delivered", offset);
    expect(JSON.stringify(request.messages)).toContain("Exact input");
    expect(h.conversationText()).not.toContain("Accepted");
    expect(
      h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs?.[0]?.status,
    ).toBe("delivered");
  } finally {
    release.resolve();
    await h.close();
  }
});

test.each([false, true])(
  "Fleet expires selection independently of the open viewer and mode refresh (viewer=%s)",
  async (openViewer) => {
    const firstFinish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const deadlines = new Map<object, { milliseconds: number; fire: () => void }>();
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (++calls === 2) started.resolve();
          const first = request.messages.some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("First linger"),
          );
          if (first) await firstFinish.promise;
          else
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          yield { type: "text_delta", text: "Linger selection evidence." };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        deadlineScheduler: {
          schedule(milliseconds, fire) {
            const key = {};
            deadlines.set(key, { milliseconds, fire });
            return {
              cancel() {
                deadlines.delete(key);
              },
            };
          },
        },
      },
    );
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "linger-selection",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              { role: "builtin:explore", task: "First linger", description: "First selection" },
              { role: "builtin:explore", task: "Second remains", description: "Second selection" },
            ],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await started.promise;
      await h.press("\u001b[B", "Fleet");
      const inputOffset = h.terminal.output().length;
      h.terminal.input("\u001b[B");
      // Pi's input frame must run on the next-tick path without waiting for a render timer.
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(h.terminal.output().slice(inputOffset)).toContain("@explore-1");
      expect(h.terminal.lines().join("\n")).toContain("● @explore-1");
      if (openViewer) await h.press("\r", "Conversation");
      const first = h.presentation.getState().authoritative.managedControl?.threads[0];
      if (first === undefined) throw new Error("Missing selected thread");
      firstFinish.resolve();
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "linger-first-settled",
        command: {
          type: "wait_agents",
          parentSessionId: h.parent.sessionId,
          mode: "all",
          targets: [{ threadId: first.threadId, expectedTurnId: first.turn.turnId }],
        },
      });
      const timers = [...deadlines.values()].filter((entry) => entry.milliseconds === 4000);
      expect(timers).toHaveLength(1);
      const offset = h.terminal.output().length;
      for (const timer of timers) timer.fire();
      await h.terminal.waitForFrameAfter("Fleet", offset);
      const fleet = () => {
        const lines = h.terminal.lines();
        return lines.slice(lines.findIndex((line) => line.startsWith("Fleet"))).join("\n");
      };
      if (openViewer) {
        expect(fleet()).not.toContain("@explore-1");
        await h.press("m", "Conversation");
        expect(fleet()).not.toContain("@explore-1");
        await h.press("\u001b[27u", "● Main");
      }
      expect(fleet()).toContain("● Main");
      expect(fleet()).not.toContain("@explore-1");
      expect(fleet()).toContain("@explore-2");
      await h.press("\r", "Fleet · ↓ navigate");
      expect(calls).toBe(2);
    } finally {
      firstFinish.resolve();
      await h.close();
    }
  },
);

test("workspace Attention navigation disarms an earlier exact cancellation", async () => {
  const started = Promise.withResolvers<void>();
  let aborts = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        const permission = request.messages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Permission partner"),
        );
        if (permission) {
          yield { type: "tool_call_start", id: "attention-partner", name: "read_file" };
          yield {
            type: "tool_call_delta",
            id: "attention-partner",
            json: '{"path":"package.json"}',
          };
          yield { type: "tool_call_end", id: "attention-partner" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          started.resolve();
          await new Promise<void>((resolve) =>
            request.signal.addEventListener(
              "abort",
              () => {
                aborts += 1;
                resolve();
              },
              { once: true },
            ),
          );
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    {
      permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
    },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "cancel-attention",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Running target", description: "Cancel target" },
            {
              role: "builtin:explore",
              task: "Permission partner",
              description: "Permission partner",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.waitForAttention(
      (items) =>
        items.length === 1 &&
        items[0]?.kind === "permission" &&
        items[0].interaction !== null &&
        items[0].available,
    );
    await h.terminal.waitForScreen("Attention Center");
    // Queue a fresh overlay frame before Pi has parsed the following standalone Escape.
    h.terminal.resize(81, 32);
    h.terminal.input("\u001b[A");
    await h.press("\u001b", "Fleet", "Attention Center");
    await h.press("/agents\r", "Agents workspace");
    await h.press("x", "x again to cancel");
    await h.press("a", "Attention Center");
    h.terminal.resize(80, 32);
    h.terminal.input("\u001b[A");
    await h.press("\u001b", "Agents workspace", "Attention Center");
    await h.press("x", "x again to cancel");
    expect(aborts).toBe(0);
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.phase).toBe(
      "executing",
    );
    await h.press("x", "Cancelled");
    expect(aborts).toBe(1);
  } finally {
    await h.close();
  }
});

test("declined admission keeps its reason visible without reporting a child start", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      if (++calls === 1) {
        yield { type: "tool_call_start", id: "declined-spawn", name: "spawn_agents" };
        yield {
          type: "tool_call_delta",
          id: "declined-spawn",
          json: JSON.stringify({
            entries: [
              {
                role: "builtin:explore",
                task: "Inspect requested evidence",
                description: "Requested evidence",
              },
            ],
          }),
        };
        yield { type: "tool_call_end", id: "declined-spawn" };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "Delegation declined; Main ready." };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    await h.press("Consider delegation.\r", "Confirm delegation");
    expect(h.terminal.lines().join("\n")).not.toMatch(/Started @|Queued @/u);
    await h.press("\u001b", "Delegation declined; Main ready.");
    const screen = h.terminal.lines().join("\n");
    expect(screen).toContain("permission_denied");
    expect(screen).not.toMatch(/Started @|Queued @|managed_agent_batch/u);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
    const admission = h.presentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "tool_call" && item.callId === "declined-spawn",
      );
    expect(admission).toMatchObject({
      status: "denied",
      outcome: { status: "failed", code: "permission_denied" },
    });
  } finally {
    await h.close();
  }
});
