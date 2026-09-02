import type { AuthoritativePresentationSnapshot } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import { AgentNavigator } from "./agent-navigator.js";
import { createAdamTuiTheme } from "./theme.js";

test("AgentNavigator renders responsive NO_COLOR list, detail and exact cancel intent", () => {
  const managedAgents: AuthoritativePresentationSnapshot["managedAgents"] = {
    counts: { active: 1, terminal: 1, attention: 0 },
    agents: [
      {
        agentId: "123e4567-e89b-42d3-a456-426614174201",
        attemptId: "123e4567-e89b-42d3-a456-426614174202",
        profile: "scout.v1",
        mode: "background",
        targetIdentity: {
          targetId: "deepseek-v4-flash.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        },
        status: "running",
        revision: 1,
        phase: "model",
        transcript: {
          childSessionId: "123e4567-e89b-42d3-a456-426614174205",
          throughSequence: 2,
        },
        attemptHistory: [
          {
            attemptId: "123e4567-e89b-42d3-a456-426614174202",
            childSessionId: "123e4567-e89b-42d3-a456-426614174205",
            status: "running",
            current: true,
            throughSequence: 2,
          },
        ],
      },
      {
        agentId: "123e4567-e89b-42d3-a456-426614174203",
        attemptId: "123e4567-e89b-42d3-a456-426614174204",
        profile: "scout.v1",
        mode: "background",
        targetIdentity: {
          targetId: "deepseek-v4-flash.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        },
        status: "completed",
        revision: 2,
        phase: "terminal",
        transcript: {
          childSessionId: "123e4567-e89b-42d3-a456-426614174206",
          throughSequence: 4,
        },
        attemptHistory: [
          {
            attemptId: "123e4567-e89b-42d3-a456-426614174204",
            childSessionId: "123e4567-e89b-42d3-a456-426614174206",
            status: "completed",
            current: true,
            throughSequence: 4,
          },
        ],
      },
    ],
  };
  const onCancel = vi.fn();
  const navigator = new AgentNavigator({
    managedAgents,
    onCancel,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  const listed = navigator.render(80).join("\n");
  expect(listed).toContain("Agents · 1 active · 1 terminal");
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

test("AgentNavigator renders one bounded attention question and emits its exact reply intent", () => {
  const onReply = vi.fn();
  const onCancel = vi.fn();
  const navigator = new AgentNavigator({
    managedAgents: {
      counts: { active: 1, terminal: 0, attention: 1 },
      agents: [
        {
          agentId: "123e4567-e89b-42d3-a456-426614174211",
          attemptId: "123e4567-e89b-42d3-a456-426614174212",
          profile: "research.v1",
          mode: "background",
          targetIdentity: {
            targetId: "deepseek-v4-flash.direct",
            vendor: "deepseek",
            modelId: "deepseek-v4-flash",
            route: "direct",
            profileVersion: 1,
            certification: "certified",
          },
          status: "waiting_for_parent",
          revision: 3,
          phase: "waiting_for_parent",
          transcript: {
            childSessionId: "123e4567-e89b-42d3-a456-426614174214",
            throughSequence: 5,
          },
          attemptHistory: [
            {
              attemptId: "123e4567-e89b-42d3-a456-426614174212",
              childSessionId: "123e4567-e89b-42d3-a456-426614174214",
              status: "waiting_for_parent",
              current: true,
              throughSequence: 5,
            },
          ],
          attention: {
            attentionId: "123e4567-e89b-42d3-a456-426614174213",
            question: "Which exact source should I prioritize?",
            status: "waiting",
          },
        },
      ],
    },
    onCancel,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onReply,
    theme: createAdamTuiTheme(true),
  });

  navigator.handleInput("\r");
  const detail = navigator.render(48).join("\n");
  expect(detail).toContain("Parent input requested · Which exact source");
  expect(detail).toContain("r reply exact attention");
  expect(navigator.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
  navigator.handleInput("r");
  expect(onReply).toHaveBeenCalledWith({
    agentId: "123e4567-e89b-42d3-a456-426614174211",
    expectedRevision: 3,
    attentionId: "123e4567-e89b-42d3-a456-426614174213",
  });
  navigator.handleInput("c");
  expect(onCancel).toHaveBeenCalledWith({
    agentId: "123e4567-e89b-42d3-a456-426614174211",
    expectedRevision: 3,
  });
});
