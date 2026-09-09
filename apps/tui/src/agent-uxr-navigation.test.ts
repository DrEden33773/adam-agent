import type {
  ManagedComposerDraft,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AgentConversationViewer } from "./agent-conversation-viewer.js";
import { AgentFleet, AgentWorkspace } from "./agent-fleet.js";
import { agentViewThread } from "./agent-view.test-support.js";
import { createAdamTuiTheme } from "./theme.js";

const unexpected = async (): Promise<never> => {
  throw new Error("Navigation must not dispatch an action.");
};

function workspace(threads: readonly ManagedControlThread[], maximumLines = 12) {
  const opened: { thread: ManagedControlThread; readOnly?: boolean }[] = [];
  const snapshot: ManagedWorkspaceSnapshot = {
    parentSessionId: "parent",
    threads,
    completions: [],
    status: "ready",
    revision: 1,
  };
  const view = new AgentWorkspace({
    snapshot,
    theme: createAdamTuiTheme(false),
    maximumLines: () => maximumLines,
    onChange() {},
    onClose() {},
    onOpen(thread, readOnly) {
      opened.push({ thread, ...(readOnly === undefined ? {} : { readOnly }) });
    },
    onAttention() {},
    onSettings: unexpected,
    onDispatch: unexpected,
  });
  return { view, opened };
}

test("d opens exact details without changing list selection; focused wheel and Esc restore the list", () => {
  const threads = Array.from({ length: 12 }, (_, index) => agentViewThread(index + 1));
  const { view, opened } = workspace(threads);
  view.render(80);
  view.handleInput("\u001b[<65;10;8M");
  const selected = view.render(80).map(stripTerminalSequences).join("\n");
  expect(selected).toContain("> @explore-2");
  view.handleInput("d");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain(
    "Agent details · @explore-2",
  );
  view.handleInput("\u001b[F");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain("thread-2");
  view.handleInput("\u001b");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toBe(selected);
  expect(opened).toEqual([]);
});

test("never-started cancelled turns open an overview and historical started turns remain read only", () => {
  const original = agentViewThread();
  const { hasStarted: _started, ...turn } = original.turn;
  const thread: ManagedControlThread = {
    ...original,
    turn: {
      ...turn,
      phase: "idle",
      label: "Cancelled",
      outcome: {
        type: "outcome",
        status: "cancelled",
        summary: "Cancelled before start",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          providerCalls: 0,
          unknownCalls: 0,
        },
        transcript: { sequence: 0, digest: `sha256:${"b".repeat(64)}` },
      },
    },
    previousTurns: [{ ...original.turn, turnId: "previous-turn" }],
  };
  const { view, opened } = workspace([thread]);
  view.render(80);
  view.handleInput("\r");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain(
    "Agent details · @explore-1",
  );
  expect(opened).toEqual([]);
  view.handleInput("\u001b");
  view.handleInput("h");
  view.render(80);
  view.handleInput("d");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain(
    "Agent details · @explore-1",
  );
  view.handleInput("\u001b");
  view.render(80);
  view.handleInput("\r");
  expect(opened).toMatchObject([
    { thread: { turn: { turnId: "previous-turn" }, actions: [] }, readOnly: true },
  ]);
});

async function conversation(text = "Retained child draft") {
  const thread = agentViewThread();
  const drafts = new Map<string, ManagedComposerDraft>([
    [
      thread.threadId,
      {
        parentSessionId: thread.parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        mode: "cooperative",
        text,
      },
    ],
  ]);
  const read = Promise.withResolvers<void>();
  const resourceRead = Promise.withResolvers<void>();
  let resourceRequested = false;
  const sent: unknown[] = [];
  const viewer = new AgentConversationViewer({
    thread,
    drafts,
    theme: createAdamTuiTheme(false),
    maximumLines: () => 16,
    renderMode: "raw",
    isMainCommand: (input) => input === "/agents",
    onChange: () => {
      read.resolve();
      if (
        resourceRequested &&
        viewer.render(80).map(stripTerminalSequences).join("\n").includes("Artifact page")
      )
        resourceRead.resolve();
    },
    onClose() {},
    onExport: unexpected,
    onSeen: unexpected,
    onSuppress: unexpected,
    async onSend(command) {
      sent.push(command);
      return unexpected();
    },
    async onSaveDraft() {},
    async onClearDraft() {
      return true;
    },
    async onReadResource() {
      resourceRequested = true;
      return {
        mediaType: "text/plain",
        offset: 0,
        byteCount: 400,
        totalByteCount: 400,
        eof: true,
        nextRange: null,
        text: Array.from({ length: 30 }, (_, index) => `Resource line ${index + 1}`).join("\n"),
      };
    },
    async onRead() {
      return {
        type: "managed_agent_transcript_page",
        agentId: thread.threadId,
        turnId: thread.turn.turnId,
        attemptId: thread.turn.attemptId,
        childSessionId: thread.turn.childSessionId,
        throughSequence: 1,
        olderCursor: null,
        items: [
          {
            type: "assistant_message",
            id: "answer",
            sequence: 1,
            sourceSessionId: thread.turn.childSessionId,
            branchBoundary: null,
            artifact: {
              id: "result",
              mediaType: "text/plain",
              byteCount: 400,
              source: "model_response",
            },
            text: Array.from({ length: 30 }, (_, index) => `Transcript line ${index + 1}`).join(
              "\n",
            ),
          },
        ],
      };
    },
  });
  await read.promise;
  return { viewer, drafts, sent, resourceRead: resourceRead.promise };
}

test("viewer details retain drafts and wheel pauses tail across details and help", async () => {
  const { viewer, drafts } = await conversation();
  try {
    const tail = viewer.render(80).map(stripTerminalSequences).join("\n");
    expect(tail).toContain("Transcript line 30");
    viewer.handleInput("\u001b[<64;8;9M");
    const scrolled = viewer.render(80).map(stripTerminalSequences).join("\n");
    expect(scrolled).not.toContain("Transcript line 30");
    viewer.handleInput("d");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "Conversation details",
    );
    expect(drafts.get("thread-1")?.text).toBe("Retained child draft");
    viewer.handleInput("\u001b");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toBe(scrolled);
    viewer.handleInput("?");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain("Conversation help");
    viewer.handleInput("\u001b");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toBe(scrolled);
    viewer.handleInput("\u001b[<65;8;9M");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toBe(tail);
    viewer.handleInput("\u0004");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).not.toContain("Draft to");
    expect(drafts.has("thread-1")).toBe(false);
  } finally {
    viewer.dispose();
  }
});

test("viewer Enter rejects a Main command before creating an input receipt and retains its private draft", async () => {
  const { viewer, drafts, sent } = await conversation("/agents");
  try {
    viewer.handleInput("\r");
    viewer.handleInput("\r");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "Run this command in Main. Child draft retained.",
    );
    expect(sent).toEqual([]);
    expect(drafts.get("thread-1")).toMatchObject({ text: "/agents" });
    expect(drafts.get("thread-1")).not.toHaveProperty("inputId");
    viewer.handleInput("\u001b");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "Draft to @explore-1",
    );
  } finally {
    viewer.dispose();
  }
});

test("resource focus consumes details/help keys and wheel without changing the conversation viewport", async () => {
  const { viewer, resourceRead } = await conversation();
  try {
    viewer.render(80);
    viewer.handleInput("\u001b[<64;8;9M");
    const conversationFrame = viewer.render(80).map(stripTerminalSequences).join("\n");
    viewer.handleInput("v");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "Conversation resources",
    );
    viewer.handleInput("\r");
    await resourceRead;
    const resourceFrame = viewer.render(80).map(stripTerminalSequences).join("\n");
    expect(resourceFrame).toContain("Resource line 1\n");
    viewer.handleInput("d");
    viewer.handleInput("?");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toBe(resourceFrame);
    viewer.handleInput("\u001b[<65;8;9M");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).not.toContain(
      "Resource line 1\n",
    );
    viewer.handleInput("\u001b");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toContain(
      "Conversation resources",
    );
    viewer.handleInput("\u001b");
    expect(viewer.render(80).map(stripTerminalSequences).join("\n")).toBe(conversationFrame);
  } finally {
    viewer.dispose();
  }
});

test.each([40, 80, 120])(
  "Fleet selection uses the current theme and readable overflow at %i columns",
  (width) => {
    for (const noColor of [false, true]) {
      const view = new AgentFleet({
        theme: createAdamTuiTheme(noColor),
        onChange() {},
        onOpen() {},
        maximumLines: () => 4,
      });
      view.setSnapshot({
        parentSessionId: "parent",
        revision: 1,
        status: "ready",
        completions: [],
        threads: Array.from({ length: 8 }, (_, index) => agentViewThread(index + 1)),
      });
      view.render(width);
      for (let index = 0; index < 5; index += 1) {
        view.handleMainInput("\u001b[B", true);
        view.render(width);
      }
      const lines = view.render(width);
      const plain = lines.map(stripTerminalSequences);
      expect(plain[0]).toContain("2 above");
      expect(plain[0]).toContain("4 below");
      const selected = lines.find((line) =>
        stripTerminalSequences(line).startsWith("> @explore-4"),
      );
      expect(selected).toBeDefined();
      expect(stripTerminalSequences(selected ?? "")).toContain("Running");
      expect(visibleWidth(selected ?? "")).toBe(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (noColor) expect(lines.join("\n")).not.toContain("\u001b[");
      else {
        expect(selected).toContain("\u001b[48;2;49;50;68m");
        expect(selected).toContain("\u001b[38;2;137;220;235m@explore-4");
      }
    }
  },
);

test("truncated Fleet selection keeps its surface through every terminal cell", () => {
  const thread = agentViewThread();
  const view = new AgentFleet({ theme: createAdamTuiTheme(false), onChange() {}, onOpen() {} });
  view.setSnapshot({
    parentSessionId: "parent",
    revision: 1,
    status: "ready",
    completions: [],
    threads: [
      {
        ...thread,
        description: "long description ".repeat(10),
        turn: { ...thread.turn, startedAtUnixMilliseconds: Date.now() - 1000 },
      },
    ],
  });
  view.render(40);
  view.handleMainInput("\u001b[B", true);
  view.render(40);
  view.handleMainInput("\u001b[B", true);
  const row = view
    .render(40)
    .find((line) => stripTerminalSequences(line).startsWith("> @explore-1"));
  expect(row).toBeDefined();
  expect(stripTerminalSequences(row ?? "")).toContain("...");
  let background = "default";
  const cells: string[] = [];
  // Interpret the SGR adapter output, including foreground RGB parameters which may contain zeros.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: interpret actual terminal SGR sequences in this adapter assertion.
  for (const token of (row ?? "").split(/(\x1b\[[0-9;]*m)/u)) {
    if (!token.startsWith("\u001b[")) {
      cells.push(...Array.from(token, () => background));
      continue;
    }
    const parameters = token.slice(2, -1).split(";").map(Number);
    for (let index = 0; index < parameters.length; index += 1) {
      const code = parameters[index];
      if ((code === 38 || code === 48) && parameters[index + 1] === 2) {
        if (code === 48) background = parameters.slice(index + 2, index + 5).join(";");
        index += 4;
      } else if (code === 0 || code === 49) background = "default";
    }
  }
  expect(cells).toHaveLength(40);
  expect(new Set(cells)).toEqual(new Set(["49;50;68"]));
});

test("historical completed outcomes without an end timestamp retain unknown elapsed", () => {
  const original = agentViewThread();
  const completed: ManagedControlThread = {
    ...original,
    turn: {
      ...original.turn,
      phase: "idle",
      label: "Completed",
      lastOutcome: "completed",
      startedAtUnixMilliseconds: 1000,
      outcome: {
        type: "outcome",
        status: "completed",
        summary: "Historical completion",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          providerCalls: 0,
          unknownCalls: 0,
        },
        transcript: { sequence: 0, digest: `sha256:${"a".repeat(64)}` },
      },
    },
  };
  const { view } = workspace([completed]);
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain("?s");
  view.handleInput("d");
  expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain("elapsed unknown");
});
