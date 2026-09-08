import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { AgentAdmissionCard } from "./agent-admission-card.js";
import { createAdamTuiTheme } from "./theme.js";

test.each([40, 80, 120])(
  "admission cards use the available %i columns while keeping the exact receipt separate",
  (width) => {
    for (const noColor of [false, true]) {
      const card = new AgentAdmissionCard(
        {
          status: "queued",
          lane: "background",
          threadId: "thread",
          turnId: "turn",
          handle: "@explore-9",
          displayName: "Explore",
          description: "核查 e\u0301 schema compatibility and runtime ownership evidence",
        },
        createAdamTuiTheme(noColor),
      );
      const lines = card.render(width);
      expect(lines).toHaveLength(2);
      expect(stripTerminalSequences(lines[1] ?? "")).toBe("Queued @explore-9");
      expect(stripTerminalSequences(lines[0] ?? "")).toContain("Explore · 核查 e\u0301");
      if (width >= 80)
        expect(stripTerminalSequences(lines[0] ?? "")).toBe(
          "Explore · 核查 e\u0301 schema compatibility and runtime ownership evidence",
        );
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (noColor)
        expect(lines.join("\n").replaceAll("\u001b[0m", "")).toBe(
          stripTerminalSequences(lines.join("\n")),
        );
    }
  },
);
