import type { AuthoritativePresentationSnapshot } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import { AgentNavigator } from "./agent-navigator.js";
import { createAdamTuiTheme } from "./theme.js";

test("AgentNavigator renders responsive NO_COLOR list, detail and exact cancel intent", () => {
  const managedAgents: AuthoritativePresentationSnapshot["managedAgents"] = {
    counts: { active: 1, completed: 1, attention: 0 },
    agents: [
      {
        agentId: "123e4567-e89b-42d3-a456-426614174201",
        attemptId: "123e4567-e89b-42d3-a456-426614174202",
        profile: "scout.v1",
        mode: "background",
        status: "running",
        revision: 1,
      },
      {
        agentId: "123e4567-e89b-42d3-a456-426614174203",
        attemptId: "123e4567-e89b-42d3-a456-426614174204",
        profile: "scout.v1",
        mode: "background",
        status: "completed",
        revision: 2,
      },
    ],
  };
  const onCancel = vi.fn();
  const navigator = new AgentNavigator({
    managedAgents,
    onCancel,
    onChange: vi.fn(),
    onClose: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  const listed = navigator.render(80).join("\n");
  expect(listed).toContain("Agents · 1 active · 1 completed");
  expect(listed).toContain("scout.v1 · running");
  expect(navigator.render(40).join("\n")).not.toContain("\u001b[");
  navigator.handleInput("\r");
  const detail = navigator.render(80).join("\n");
  expect(detail).toContain("Agent detail");
  expect(detail).toContain("revision 1");
  expect(navigator.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  navigator.handleInput("c");
  expect(onCancel).toHaveBeenCalledWith({
    agentId: "123e4567-e89b-42d3-a456-426614174201",
    expectedRevision: 1,
  });
});
