import { defaultAgentUiSettings, type ManagedWorkspaceSnapshot } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { agentViewThread } from "./agent-view.test-support.js";
import { AgentWidget } from "./agent-widget.js";
import { createAdamTuiTheme } from "./theme.js";

test.each([3, 4])(
  "Widget spends actual visible line height and counts partial details at a %i-line limit",
  (maximum) => {
    const snapshot: ManagedWorkspaceSnapshot = {
      parentSessionId: "parent",
      revision: 1,
      status: "ready",
      completions: [],
      threads: Array.from({ length: maximum === 3 ? 1 : 3 }, (_, index) =>
        agentViewThread(index + 1),
      ),
    };
    const widget = new AgentWidget(createAdamTuiTheme(true), () => maximum, {
      settings: () => ({ ...defaultAgentUiSettings, showModel: true }),
      scheduler: {
        schedule() {
          return { cancel() {} };
        },
      },
    });
    try {
      widget.setSnapshot(snapshot);
      if (maximum === 4)
        widget.setSnapshot({
          ...snapshot,
          revision: 2,
          threads: snapshot.threads.map((thread) => ({
            ...thread,
            residency: "unloaded",
            actions: ["close", "new_turn"],
            turn: {
              ...thread.turn,
              phase: "idle",
              label: "Completed",
              ownerPhase: "released",
              lastOutcome: "completed",
            },
          })),
        });
      const lines = widget.render(80);
      expect(lines.length).toBeLessThanOrEqual(maximum);
      expect(lines.join("\n")).toContain(
        maximum === 3 ? "2 detail lines hidden" : "2 finished hidden",
      );
      expect(lines.join("\n")).not.toContain("…  hidden");
    } finally {
      widget.dispose();
    }
  },
);
