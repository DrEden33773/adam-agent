import { defaultAgentUiSettings, type ManagedWorkspaceSnapshot } from "@adam-agent/presentation";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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

test.each([40, 80, 120])(
  "compact Widget keeps readable Unicode status at %i columns in both color modes",
  (width) => {
    for (const noColor of [false, true]) {
      const running = agentViewThread();
      const queued = agentViewThread(2);
      const queuedTurn = { ...queued.turn };
      delete queuedTurn.hasStarted;
      const widget = new AgentWidget(createAdamTuiTheme(noColor), () => 12, {
        scheduler: {
          schedule() {
            return { cancel() {} };
          },
        },
      });
      try {
        widget.setSnapshot({
          parentSessionId: "parent",
          revision: 1,
          status: "ready",
          completions: [],
          threads: [
            {
              ...running,
              displayName: "审查",
              description: "核查 e\u0301 证据",
              budget: {
                ceiling: 1000,
                knownUsed: 20,
                outstandingReserved: 40,
                unknownReserved: 1,
                available: 939,
                overrun: 0,
              },
              turn: { ...running.turn, phase: "waiting", label: "Permission required" },
            },
            {
              ...queued,
              displayName: "探索",
              description: "读取 e\u0301 文件",
              turn: { ...queuedTurn, phase: "queued", label: "Queued" },
            },
          ],
        });
        widget.setActivity([
          {
            agentId: running.threadId,
            attemptId: running.turn.attemptId,
            childSessionId: running.turn.childSessionId,
            activity: "replying",
            assistant: { itemId: "live", text: "Older activity" },
          },
        ]);
        const lines = widget.render(width);
        const text = stripTerminalSequences(lines.join("\n"));
        expect(text).toContain("审查 · 核查 e\u0301 证据");
        expect(text).toContain("Permission required");
        expect(text).toContain("Queued @explore-2");
        expect(text).not.toMatch(/used|reserved|fixture-target|sha256:/u);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (noColor) expect(lines.join("\n").replaceAll("\u001b[0m", "")).toBe(text);
      } finally {
        widget.dispose();
      }
    }
  },
);

test.each([
  {
    phase: "waiting" as const,
    waitReason: "parent_input" as const,
    label: "Waiting for you",
    expected: "1 waiting",
    attention: true,
  },
  {
    phase: "waiting" as const,
    waitReason: "permission" as const,
    label: "Permission required",
    expected: "1 waiting",
    attention: true,
  },
  {
    phase: "settling" as const,
    waitReason: "none" as const,
    label: "Settling",
    expected: "1 settling",
    attention: false,
  },
  {
    phase: "idle" as const,
    waitReason: "none" as const,
    label: "Failed",
    expected: "1 error",
    attention: false,
  },
])(
  "two-line Widget reports $label instead of counting it as running",
  ({ phase, waitReason, label, expected, attention }) => {
    const thread = agentViewThread();
    const widget = new AgentWidget(createAdamTuiTheme(true), () => 2, {
      scheduler: {
        schedule() {
          return { cancel() {} };
        },
      },
    });
    const snapshot: ManagedWorkspaceSnapshot = {
      parentSessionId: "parent",
      revision: 1,
      status: "ready",
      completions: [],
      threads: [thread],
    };
    try {
      widget.setSnapshot(snapshot);
      widget.setActivity([
        {
          agentId: thread.threadId,
          attemptId: thread.turn.attemptId,
          childSessionId: thread.turn.childSessionId,
          activity: "replying",
          assistant: { itemId: "stale", text: "Old running output" },
        },
      ]);
      widget.setSnapshot({
        ...snapshot,
        revision: 2,
        threads: [
          {
            ...thread,
            turn: {
              ...thread.turn,
              phase,
              waitReason,
              label,
              ...(phase === "idle" ? { lastOutcome: "failed" as const } : {}),
            },
          },
        ],
      });
      const lines = widget.render(40);
      expect(lines).toHaveLength(2);
      expect(lines.join("\n")).toContain(expected);
      if (attention) expect(lines.join("\n")).toContain("1 attention");
      expect(lines.join("\n")).not.toMatch(/running|\d+ run(?:\/|\b)|Old running output/u);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    } finally {
      widget.dispose();
    }
  },
);

test.each([2, 3])(
  "%i-line Widget preserves mixed attention, settling and error counts",
  (maximum) => {
    const threads = Array.from({ length: 4 }, (_, index) => agentViewThread(index + 1));
    const snapshot: ManagedWorkspaceSnapshot = {
      parentSessionId: "parent",
      revision: 1,
      status: "ready",
      completions: [],
      threads,
    };
    const widget = new AgentWidget(createAdamTuiTheme(true), () => maximum, {
      scheduler: {
        schedule() {
          return { cancel() {} };
        },
      },
    });
    try {
      widget.setSnapshot(snapshot);
      widget.setSnapshot({
        ...snapshot,
        revision: 2,
        threads: threads.map((thread, index) => ({
          ...thread,
          turn: {
            ...thread.turn,
            phase: index < 2 ? "waiting" : index === 2 ? "settling" : "idle",
            waitReason: index === 0 ? "parent_input" : index === 1 ? "permission" : "none",
            label: index < 2 ? "Waiting for you" : index === 2 ? "Settling" : "Failed",
            lastOutcome: index === 3 ? "failed" : "none",
          },
        })),
      });
      const lines = widget.render(40);
      expect(lines).toHaveLength(maximum);
      expect(lines.join("\n")).toContain("2 waiting");
      expect(lines.join("\n")).toContain("1 settling");
      expect(lines.join("\n")).toContain("2 attention");
      expect(lines.join("\n")).toContain("1 error");
      expect(lines.join("\n")).not.toContain("running");
      if (maximum === 2) expect(lines[0]).toBe("● Agents 4 · 2 attention · 1 error");
      else expect(lines[1]).toBe("└─ Failed · Explore · Evidence 4");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    } finally {
      widget.dispose();
    }
  },
);

test.each([
  ["generating_arguments", "Generating arguments"],
  ["awaiting_model_completion", "Arguments received · waiting for model completion"],
  ["processing_response", "Processing model response"],
] as const)("Widget distinguishes %s from tool execution", (status, label) => {
  const thread = agentViewThread();
  const widget = new AgentWidget(createAdamTuiTheme(true), () => 12, {
    scheduler: {
      schedule() {
        return { cancel() {} };
      },
    },
  });
  try {
    widget.setSnapshot({
      parentSessionId: "parent",
      revision: 1,
      status: "ready",
      completions: [],
      threads: [thread],
    });
    widget.setActivity([
      {
        agentId: thread.threadId,
        attemptId: thread.turn.attemptId,
        childSessionId: thread.turn.childSessionId,
        activity: "using_tool",
        tool: { callId: "call-1", name: "read_file", status },
      },
    ]);
    expect(widget.render(120).join("\n")).toContain(`${label} · read_file`);
  } finally {
    widget.dispose();
  }
});

test("Widget animation redraws while linger expiration separately changes membership", () => {
  const timers = new Map<object, { milliseconds: number; fire: () => void }>();
  let animations = 0;
  let changes = 0;
  const widget = new AgentWidget(createAdamTuiTheme(true), () => 12, {
    scheduler: {
      schedule(milliseconds, fire) {
        const key = {};
        timers.set(key, { milliseconds, fire });
        return {
          cancel() {
            timers.delete(key);
          },
        };
      },
    },
    onAnimation: () => {
      animations += 1;
    },
    onChange: () => {
      changes += 1;
    },
  });
  const thread = agentViewThread();
  const snapshot: ManagedWorkspaceSnapshot = {
    parentSessionId: "parent",
    revision: 1,
    status: "ready",
    completions: [],
    threads: [thread],
  };
  try {
    widget.setSnapshot(snapshot);
    const before = widget.render(80);
    const animation = [...timers.values()].find((timer) => timer.milliseconds === 80);
    expect(animation).toBeDefined();
    animation?.fire();
    expect(widget.render(80)).not.toEqual(before);
    expect(animations).toBe(1);
    expect(changes).toBe(0);
    widget.setSnapshot({
      ...snapshot,
      threads: [{ ...thread, turn: { ...thread.turn, phase: "idle", label: "Completed" } }],
    });
    expect(widget.visibleThreads()).toHaveLength(1);
    const linger = [...timers.values()].find((timer) => timer.milliseconds === 4000);
    expect(linger).toBeDefined();
    linger?.fire();
    expect(widget.visibleThreads()).toHaveLength(0);
    expect(widget.render(80)).toEqual([]);
    expect(changes).toBe(1);
    expect([...timers.values()]).toEqual([]);
  } finally {
    widget.dispose();
  }
});
