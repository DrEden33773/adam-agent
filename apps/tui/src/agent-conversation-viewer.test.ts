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
  const thread = agentViewThread();
  const read = Promise.withResolvers<void>();
  const unexpected = async () => {
    throw new Error("Rendering literal evidence cannot dispatch an action.");
  };
  const viewer = new AgentConversationViewer({
    thread,
    drafts: new Map(),
    theme: createAdamTuiTheme(true),
    maximumLines: () => 30,
    renderMode: "full",
    onChange: () => read.resolve(),
    onClose() {},
    onExport: unexpected,
    onSeen: unexpected,
    onSuppress: unexpected,
    onSend: unexpected,
    onSaveDraft: unexpected,
    onClearDraft: unexpected,
    onReadResource: unexpected,
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
            text,
            artifact: null,
          },
        ],
      };
    },
  });
  try {
    await read.promise;
    expect(viewer.render(80).join("\n")).toContain(literal);
    viewer.handleInput("m");
    expect(viewer.render(80).join("\n")).toContain("m raw");
    expect(viewer.render(80).join("\n")).toContain(literal);
  } finally {
    viewer.dispose();
  }
});
