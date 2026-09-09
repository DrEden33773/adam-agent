import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDriver } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { type ManagedTuiFixture, startManagedTui } from "./agent-fleet.test-support.js";

async function startThreads(h: ManagedTuiFixture, count: number) {
  expect(
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "handle-navigation-admission",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: Array.from({ length: count }, (_, index) => ({
          role: "builtin:explore" as const,
          task: `Inspect evidence ${index + 1} · 中文 e\u0301 🧭`,
          description: `Evidence ${index + 1}`,
        })),
      },
    }),
  ).toMatchObject({ status: "admitted" });
}

async function selectHandle(h: ManagedTuiFixture, handle: string) {
  await h.press(handle, `> ${handle.replace(/^@/u, "")}`);
  await h.press("\t", handle);
}

test.each([
  { state: "running", columns: 80, rows: 24 },
  { state: "completed", columns: 40, rows: 18 },
  { state: "completed", columns: 120, rows: 32 },
  { state: "queued", columns: 80, rows: 24 },
  { state: "queued", columns: 40, rows: 12 },
])(
  "a bare selected handle opens its exact $state view at $columns columns without a task",
  async ({ state, columns, rows }) => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const count = state === "queued" ? 9 : 1;
    const driver: ModelDriver = {
      async *stream(request) {
        calls += 1;
        yield { type: "text_delta", text: "Visible child evidence." };
        if (calls === (state === "queued" ? 8 : 1)) started.resolve();
        if (state !== "completed")
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const h = await startManagedTui(driver, { columns, rows });
    try {
      await startThreads(h, count);
      await started.promise;
      if (state === "completed") await h.terminal.waitForScreen("Completed");
      const thread = h.presentation.getState().authoritative.managedControl?.threads.at(-1);
      if (thread === undefined) throw new Error("Missing exact child identity.");
      const beforeAdmissions = (await h.store.read()).filter(
        (record) => record.event.type === "admitted",
      );
      const mainBefore = await (await h.sessions.open(h.parent.sessionId))?.read();
      await selectHandle(h, thread.handle);
      await h.press(
        "\r",
        state === "queued" ? `Agent details · ${thread.handle}` : `Conversation · ${thread.handle}`,
      );
      expect(h.presentation.getState().composer.renderedText).toBe(thread.handle);
      expect((await h.store.read()).filter((record) => record.event.type === "admitted")).toEqual(
        beforeAdmissions,
      );
      expect(
        (await h.store.read()).filter((record) => record.event.type === "input_accepted"),
      ).toEqual([]);
      expect(await (await h.sessions.open(h.parent.sessionId))?.read()).toEqual(mainBefore);
      expect(calls).toBe(state === "queued" ? 8 : 1);
      if (state === "queued") {
        expect(await h.children.open(thread.turn.childSessionId)).toBeUndefined();
        await h.press("\x1b", "Agents workspace");
        await h.press("\x1b", thread.handle, "Agents workspace");
      } else await h.press("\x1b", thread.handle, "Conversation ·");
      expect(h.presentation.getState().composer.elements).toEqual([
        expect.objectContaining({
          type: "mention",
          kind: "agent",
          threadId: thread.threadId,
          handle: thread.handle,
        }),
      ]);
      await h.press("\x7f", "deepseek-v4-flash.direct");
      await h.press("Main draft restored.", "Main draft restored.");
      expect(h.presentation.getState().composer.renderedText).toBe("Main draft restored.");
    } finally {
      await h.close();
    }
  },
);

test("a Main command after an exact handle remains a draft and never becomes a child input", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Child completed." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await startThreads(h, 1);
    await h.terminal.waitForScreen("Completed");
    await selectHandle(h, "@explore-1");
    await h.press(" /help xyz", "/help xyz");
    await h.press("\r", "Run this command in Main.");
    expect(h.presentation.getState().composer.renderedText).toBe("@explore-1 /help xyz");
    expect(
      (await h.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
    expect(
      (await h.store.read()).filter((record) => record.event.type === "input_accepted"),
    ).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    await h.close();
  }
});

test("late handle-message acceptance preserves a newer Main draft", async () => {
  const started = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const releaseReceipt = Promise.withResolvers<void>();
  const h = await startManagedTui(
    {
      async *stream(request) {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      controlRecordBarrier: async (record) => {
        if (record.event.type === "input_accepted") {
          accepted.resolve();
          await releaseReceipt.promise;
        }
      },
    },
  );
  try {
    await startThreads(h, 1);
    await started.promise;
    await selectHandle(h, "@explore-1");
    await h.press(" Original input.", "Original input.");
    await h.press("\r", "Send to @explore-1");
    h.terminal.input("\r");
    await accepted.promise;
    await h.press(" New draft.", "New draft.");
    expect(h.presentation.getState().composer.renderedText).toBe(
      "@explore-1 Original input. New draft.",
    );
    const beforeReceipt = h.terminal.output().length;
    releaseReceipt.resolve();
    await h.terminal.waitForFrameAfter("Input accepted for @explore-1", beforeReceipt);
    expect(h.terminal.lines().join("\n")).toContain("Original input. New draft.");
    expect(h.presentation.getState().composer.renderedText).toBe(
      "@explore-1 Original input. New draft.",
    );
    expect(
      (await h.store.read()).filter((record) => record.event.type === "input_accepted"),
    ).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ mode: "cooperative", text: "Original input." }),
      }),
    ]);
  } finally {
    releaseReceipt.resolve();
    await h.close();
  }
});

test("a selected file sharing an agent handle stays a Main file reference", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-handle-file-"));
  await writeFile(join(workspaceRoot, "explore-1"), "File evidence.\n");
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        calls += 1;
        yield {
          type: "text_delta",
          text: calls === 1 ? "Child completed." : "Main file reference received.",
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { workspaceRoot },
  );
  try {
    await startThreads(h, 1);
    await h.terminal.waitForScreen("Completed");
    await h.press("@explore-1", "> explore-1");
    await h.press("\x1b[B", "> explore-1");
    await h.press("\t", "@explore-1");
    await h.press("\r", "The prompt does not target the active session or is blank.");
    expect(calls).toBe(1);
    expect(h.presentation.getState().composer.elements).toEqual([
      expect.objectContaining({ type: "mention", kind: "path", path: "explore-1" }),
    ]);
    await h.press(" Inspect this file.", "Inspect this file.");
    await h.press("\r", "Main file reference received.");
    expect(calls).toBe(2);
    expect(
      (await h.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
    const records = await (await h.sessions.open(h.parent.sessionId))?.read();
    const completion = h.presentation.getState().authoritative.managedControl?.completions[0];
    if (completion === undefined) throw new Error("Missing retained child completion.");
    expect(
      records?.flatMap((record) =>
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "user_message"
          ? [record.record.event.text]
          : [],
      ),
    ).toEqual([
      "@explore-1 Inspect this file.",
      `Parent message (${completion.id}): Managed agent ${completion.threadId}, turn ${completion.turnId}: completed\nChild completed.`,
    ]);
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a bare handle that closes after selection stays unavailable without rebinding", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Child completed." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await startThreads(h, 1);
    await h.terminal.waitForScreen("Completed");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing exact thread.");
    await selectHandle(h, thread.handle);
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "close-selected",
        command: {
          type: "close_thread",
          parentSessionId: h.parent.sessionId,
          threadId: thread.threadId,
          expectedTurnId: thread.turn.turnId,
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.press("\r", "Recipient unavailable");
    expect(h.presentation.getState().composer.elements).toEqual([
      expect.objectContaining({ kind: "agent", threadId: thread.threadId }),
    ]);
    expect(
      (await h.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
    expect(calls).toBe(1);
  } finally {
    await h.close();
  }
});

test("the real viewer keeps a Main command in its private draft without child dispatch", async () => {
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "Child completed." };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await startThreads(h, 1);
    await h.terminal.waitForScreen("Completed");
    await selectHandle(h, "@explore-1");
    await h.press("\r", "Conversation · @explore-1");
    await h.press("\r", "New turn");
    await h.press("/help xyz", "/help xyz");
    await h.press("\r", "Run this command in Main. Child draft retained.");
    expect(h.conversationText()).toContain("/help xyz");
    expect(
      (await h.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(1);
    expect(
      (await h.store.read()).filter((record) => record.event.type === "input_accepted"),
    ).toEqual([]);
    expect(calls).toBe(1);
    await h.press("\x1b", "Enter compose");
    await h.press("\x1b", "@explore-1", "Conversation ·");
    expect(h.presentation.getState().composer.renderedText).toBe("@explore-1");
  } finally {
    await h.close();
  }
});
