import type { ManagedAgentTranscriptPageResource } from "@adam-agent/presentation";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AgentConversationViewer } from "./agent-conversation-viewer.js";
import { agentViewThread } from "./agent-view.test-support.js";
import { createAdamTuiTheme } from "./theme.js";

test.each([
  ["diff", "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-**old**\n+**new**", "+**new**"],
  ["shell", "#!/bin/sh\nprintf '**literal**\\n'", "**literal**"],
  ["log", "2026-09-06T00:00:00Z INFO **literal log**", "**literal log**"],
  ["parser failure", `${"> ".repeat(60)}deep evidence`, "> > > > >"],
])("viewer retains %s content literally in full Markdown mode", async (_kind, text, literal) => {
  const viewer = await textViewer(text);
  try {
    expect(viewer.render(80).join("\n")).toContain(literal);
    viewer.handleInput("m");
    expect(viewer.render(80).join("\n")).toContain("m raw");
    expect(viewer.render(80).join("\n")).toContain(literal);
  } finally {
    viewer.dispose();
  }
});

async function textViewer(
  text: string,
  noColor = true,
  maximum = 30,
  items?: ManagedAgentTranscriptPageResource["items"],
  beforeRead?: (viewer: AgentConversationViewer) => void,
  nextRead?: { gate: Promise<void>; changed: () => void },
) {
  const thread = agentViewThread();
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let released = false;
  let reads = 0;
  const unexpected = async () => {
    throw new Error("Rendering literal evidence cannot dispatch an action.");
  };
  const viewer = new AgentConversationViewer({
    thread,
    drafts: new Map(),
    theme: createAdamTuiTheme(noColor),
    maximumLines: () => maximum,
    renderMode: "full",
    onChange: () => {
      if (released) read.resolve();
      if (reads > 1) nextRead?.changed();
    },
    onClose() {},
    onExport: unexpected,
    onSeen: unexpected,
    onSuppress: unexpected,
    onSend: unexpected,
    onSaveDraft: unexpected,
    onClearDraft: unexpected,
    onReadResource: unexpected,
    async onRead(selected) {
      reads += 1;
      await release.promise;
      if (reads > 1) await nextRead?.gate;
      return {
        type: "managed_agent_transcript_page",
        agentId: selected.threadId,
        turnId: selected.turn.turnId,
        attemptId: selected.turn.attemptId,
        childSessionId: selected.turn.childSessionId,
        throughSequence: 1,
        olderCursor: null,
        items: items ?? [
          {
            type: "assistant_message",
            id: "answer",
            sequence: 1,
            sourceSessionId: selected.turn.childSessionId,
            branchBoundary: null,
            text,
            artifact: null,
          },
        ],
      };
    },
  });
  beforeRead?.(viewer);
  released = true;
  release.resolve();
  await read.promise;
  return viewer;
}

test("mixed assistant Markdown keeps formatted prose beside fenced and bare literal evidence", async () => {
  const viewer = await textViewer(
    "# Answer\n\n**strong prose**\n\n```diff\n--- a/a\n+++ b/a\n-**old**\n+**new**\n```\n\n**after code**\n\n2026-09-09T00:00:00Z INFO **literal log**\n\n**after log**",
    false,
    60,
  );
  try {
    const output = viewer.render(120).join("\n");
    for (const text of ["strong prose", "after code", "after log"])
      expect(stripTerminalSequences(output)).toContain(text);
    expect(output).not.toContain("**strong prose**");
    expect(output).not.toContain("**after code**");
    expect(output).not.toContain("**after log**");
    expect(output).toContain("+**new**");
    expect(output).toContain("**literal log**");
    expect(output).toContain("\u001b[1m");
  } finally {
    viewer.dispose();
  }
});

test.each([40, 80, 120])(
  "short viewer separates identity, body and actions at %i columns",
  async (width) => {
    for (const noColor of [false, true]) {
      const viewer = await textViewer("Short e\u0301 中 answer.", noColor, 20);
      try {
        const rendered = viewer.render(width);
        const lines = rendered.map((line) => stripTerminalSequences(line).trimEnd());
        const body = lines.indexOf("Short e\u0301 中 answer.");
        expect(body).toBeGreaterThan(1);
        expect(lines[body - 1]).toBe("");
        expect(lines[body + 1]).toBe("");
        expect(lines).toHaveLength(7);
        expect(lines[0]).toContain("Conversation · @explore-1");
        expect(lines.at(-1)).toContain("Esc back");
        expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (noColor) {
          expect(rendered.join("\n")).not.toContain("\u001b[38;");
          expect(rendered.join("\n")).not.toContain("\u001b[48;");
        }
      } finally {
        viewer.dispose();
      }
    }
  },
);

test("viewer read_text reuses numbered syntax highlighting and literal evidence notices", async () => {
  const viewer = await textViewer("", false, 30, [
    {
      type: "tool_call",
      id: "read",
      sequence: 1,
      sourceSessionId: "child-1",
      branchBoundary: null,
      callId: "read",
      qualifiedName: "read_file",
      kind: "read",
      effect: "read",
      label: "read_file",
      subject: { type: "path", value: "answer.ts" },
      source: null,
      durationMs: null,
      status: "completed",
      outcome: { status: "completed" },
      resultSummary: null,
      artifacts: [],
      changePreviewRef: null,
      preview: {
        kind: "read_text",
        language: "typescript",
        lines: [{ number: 23, text: "const answer = '**literal**';" }],
        omittedBytes: 5,
        sourceTruncated: true,
      },
    },
  ]);
  try {
    const rendered = viewer.render(80).join("\n");
    const plain = stripTerminalSequences(rendered);
    expect(plain).toContain("23 │ const answer = '**literal**';");
    expect(plain).toContain("5 bytes omitted from bounded preview");
    expect(plain).toContain("tool output truncated at source");
    expect(rendered).toContain("\u001b[38;2;203;166;247mconst");
  } finally {
    viewer.dispose();
  }
});

test.each([
  {
    source: "#!/bin/sh\nprintf first\n\nprintf '**literal**\\n'",
    literal: "**literal**",
    prose: undefined,
  },
  {
    source:
      "2026-09-09T00:00:00Z INFO **literal**\n```ts\nconst answer = 1;\n```\n**formatted prose**",
    literal: "**literal**",
    prose: "formatted prose",
  },
  {
    source:
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n-**old**\n+**literal**\n# Conclusion\n**formatted prose**",
    literal: "**literal**",
    prose: "formatted prose",
  },
])(
  "evidence segmentation preserves blank script lines and adjacent Markdown: $source",
  async ({ source, literal, prose }) => {
    const viewer = await textViewer(source, true, 60);
    try {
      const output = viewer.render(120).join("\n");
      expect(output).toContain(literal);
      if (prose !== undefined) {
        expect(output).toContain(prose);
        expect(output).not.toContain(`**${prose}**`);
      }
    } finally {
      viewer.dispose();
    }
  },
);

test("initial transcript loading cannot freeze an empty page or open partial resources", async () => {
  const viewer = await textViewer("Retained first page.", true, 30, undefined, (pending) => {
    expect(pending.render(80).join("\n")).toContain("Loading transcript");
    pending.handleInput("\u001b[H");
    pending.handleInput("v");
    expect(pending.render(80).join("\n")).not.toContain("Conversation resources");
  });
  try {
    viewer.handleInput("\u001b[H");
    const text = viewer.render(80).join("\n");
    expect(text).toContain("Manual scroll");
    expect(text).toContain("Retained first page.");
  } finally {
    viewer.dispose();
  }
});

test("a changed turn waits for its own first page before manual navigation", async () => {
  const gate = Promise.withResolvers<void>();
  const changed = Promise.withResolvers<void>();
  const viewer = await textViewer("Next-turn retained page.", true, 30, undefined, undefined, {
    gate: gate.promise,
    changed: () => changed.resolve(),
  });
  try {
    const thread = agentViewThread();
    viewer.setThread({
      ...thread,
      turn: { ...thread.turn, turnId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(viewer.render(80).join("\n")).toContain("Loading transcript");
    viewer.handleInput("\u001b[H");
    viewer.handleInput("v");
    expect(viewer.render(80).join("\n")).not.toContain("Conversation resources");
    gate.resolve();
    await changed.promise;
    viewer.handleInput("\u001b[H");
    expect(viewer.render(80).join("\n")).toContain("Next-turn retained page.");
  } finally {
    gate.resolve();
    viewer.dispose();
  }
});

test("leaving a retained manual page waits for the unread current tail", async () => {
  const original = await textViewer("Saved manual evidence.");
  original.handleInput("\u001b[H");
  const saved = original.readingState();
  original.dispose();
  const reopened = await textViewer("Fresh tail evidence.", true, 30, undefined, (pending) => {
    pending.restoreReadingState(saved);
    expect(pending.render(80).join("\n")).toContain("Saved manual evidence.");
    expect(pending.render(80).join("\n")).toContain("Manual scroll");
    pending.handleInput("\u001b[F");
    pending.handleInput("\u001b[H");
    expect(pending.render(80).join("\n")).toContain("Loading transcript");
  });
  try {
    reopened.handleInput("\u001b[H");
    expect(reopened.render(80).join("\n")).toContain("Fresh tail evidence.");
  } finally {
    reopened.dispose();
  }
});
