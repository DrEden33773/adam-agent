import type { AuthoritativePresentationSnapshot } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import { AgentNavigator, ManagedAgentRoster } from "./agent-navigator.js";
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
        messages: [],
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
        messages: [],
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
  for (const width of [40, 80, 120]) {
    expect(navigator.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(navigator.render(width).join("\n")).not.toContain("\u001b[");
  }
  navigator.handleInput("\u001b[99;1:1u");
  expect(onCancel).not.toHaveBeenCalled();
  expect(navigator.render(80).join("\n")).toContain("Press c again to stop this exact child");
  navigator.handleInput("\u001b[99;1:2u");
  navigator.handleInput("\u001b[99;1:3u");
  expect(onCancel).not.toHaveBeenCalled();
  expect(navigator.render(80).join("\n")).toContain("Press c again to stop this exact child");
  navigator.handleInput("\u001b[99;1:1u");
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
          messages: [],
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
  expect(onCancel).not.toHaveBeenCalled();
  navigator.handleInput("c");
  expect(onCancel).toHaveBeenCalledWith({
    agentId: "123e4567-e89b-42d3-a456-426614174211",
    expectedRevision: 3,
  });
});

test("causal managed updates preserve exact detail identity and bound the active roster to three rows", () => {
  const first = managedAgentFixture();
  const terminal = managedAgentFixture({
    agentId: "123e4567-e89b-42d3-a456-426614174203",
    attemptId: "123e4567-e89b-42d3-a456-426614174204",
    revision: 2,
    status: "completed",
    phase: "terminal",
  });
  const managedAgents = {
    counts: { active: 1, terminal: 1, attention: 0 },
    agents: [first, terminal],
  } satisfies AuthoritativePresentationSnapshot["managedAgents"];
  const fourth = {
    ...first,
    agentId: "123e4567-e89b-42d3-a456-426614174207",
    attemptId: "123e4567-e89b-42d3-a456-426614174208",
    status: "stalled" as const,
    revision: 4,
  };
  const navigator = new AgentNavigator({
    managedAgents,
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });
  navigator.handleInput("\u001b[B");
  navigator.handleInput("\r");
  expect(navigator.render(80).join("\n")).toContain(terminal.agentId);

  navigator.setManagedAgents({
    counts: { active: 3, terminal: 1, attention: 1 },
    agents: [
      { ...terminal, status: "recovery_required", revision: 5 },
      first,
      { ...first, agentId: "123e4567-e89b-42d3-a456-426614174209", revision: 3 },
      fourth,
    ],
  });
  const updatedDetail = navigator.render(80).join("\n");
  expect(updatedDetail).toContain(terminal.agentId);
  expect(updatedDetail).toContain("recovery_required · revision 5");

  const roster = new ManagedAgentRoster({
    managedAgents: {
      counts: { active: 4, terminal: 1, attention: 1 },
      agents: [
        first,
        { ...first, agentId: "123e4567-e89b-42d3-a456-426614174209", revision: 3 },
        fourth,
        { ...first, agentId: "123e4567-e89b-42d3-a456-426614174210", revision: 5 },
        terminal,
      ],
    },
    theme: createAdamTuiTheme(true),
  });
  const rosterLines = roster.render(80);
  expect(rosterLines).toHaveLength(3);
  expect(rosterLines.join("\n")).toContain("+1 active");
  expect(rosterLines.join("\n")).not.toContain(terminal.agentId);
});

test("AgentNavigator reads one bounded sanitized transcript page and renders exact capacity truth", async () => {
  const agent = managedAgentFixture({
    context: {
      contextWindowTokens: 1_000_000,
      occupancy: { source: "provider_reported", tokens: 96_000 },
    },
    usage: { inputTokens: 120, outputTokens: 30, reasoningTokens: 10, providerCalls: 2 },
    budget: { maximumCumulativeTokens: 2_000_000, usedTokens: 150, remainingTokens: 1_999_850 },
    attempts: {
      childAttempts: 1,
      maximumChildAttempts: 4,
      parentAttempts: 2,
      maximumParentAttempts: 16,
    },
    watchdog: { state: "running", maximumInactivityMilliseconds: 300_000 },
  });
  const onReadTranscript = vi.fn().mockResolvedValue({
    type: "managed_agent_transcript_page",
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    childSessionId: agent.transcript.childSessionId,
    throughSequence: agent.transcript.throughSequence,
    items: [
      {
        type: "assistant_message",
        id: "assistant-1",
        sequence: 2,
        sourceSessionId: agent.transcript.childSessionId,
        branchBoundary: null,
        text: "Bounded child evidence.",
        artifact: null,
      },
    ],
    olderCursor: "older-1",
  });
  const firstPageLoaded = Promise.withResolvers<void>();
  const olderPageLoaded = Promise.withResolvers<void>();
  onReadTranscript.mockImplementation(async (input) => {
    if (input.cursor === "older-1") {
      olderPageLoaded.resolve();
    }
    return {
      type: "managed_agent_transcript_page",
      agentId: agent.agentId,
      attemptId: agent.attemptId,
      childSessionId: agent.transcript.childSessionId,
      throughSequence: agent.transcript.throughSequence,
      items: [
        {
          type: "assistant_message",
          id: "assistant-1",
          sequence: 2,
          sourceSessionId: agent.transcript.childSessionId,
          branchBoundary: null,
          text: "Bounded child evidence.",
          artifact: null,
        },
      ],
      olderCursor: "older-1",
    };
  });
  let navigator!: AgentNavigator;
  navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 0 }, agents: [agent] },
    onCancel: vi.fn(),
    onChange() {
      if (navigator.render(120).join("\n").includes("Bounded child evidence.")) {
        firstPageLoaded.resolve();
      }
    },
    onClose: vi.fn(),
    onReadTranscript,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  navigator.handleInput("\r");
  await firstPageLoaded.promise;
  expect(navigator.render(120).join("\n")).toContain("Bounded child evidence.");
  const detail = navigator.render(120).join("\n");
  expect(detail).toContain("deepseek-v4-flash.direct · deepseek-v4-flash");
  expect(detail).toContain("Context 1000000 capacity · occupancy 96000 · provider_reported");
  expect(detail).toContain("Usage 120 in + 30 out · 10 reasoning · 2 calls");
  expect(detail).toContain("Budget 150/2000000 · 1999850 left");
  expect(detail).toContain("Watchdog running · 300000 ms");
  expect(detail).toContain("Older transcript available");
  expect(onReadTranscript).toHaveBeenCalledWith({
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    expectedRevision: agent.revision,
    expectedThroughSequence: agent.transcript.throughSequence,
    cursor: null,
  });
  navigator.handleInput("\u001b[5~");
  await olderPageLoaded.promise;
  expect(onReadTranscript).toHaveBeenLastCalledWith({
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    expectedRevision: agent.revision,
    expectedThroughSequence: agent.transcript.throughSequence,
    cursor: "older-1",
  });
});

test("AgentNavigator reuses sanitized reasoning, tool preview and bounded artifact surfaces", async () => {
  const agent = managedAgentFixture({
    transcript: { childSessionId: "child-surface", throughSequence: 4 },
  });
  const artifact = {
    id: "sha256:managed-tool-artifact",
    mediaType: "text/plain",
    byteCount: 18,
    source: "tool_output" as const,
  };
  const onReadArtifact = vi.fn().mockResolvedValue({
    mediaType: "text/plain",
    offset: 0,
    byteCount: 18,
    totalByteCount: 18,
    eof: true,
    nextRange: null,
    text: "Bounded artifact.\n",
  });
  const onReadTranscript = vi.fn().mockResolvedValue({
    type: "managed_agent_transcript_page",
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    childSessionId: agent.transcript.childSessionId,
    throughSequence: agent.transcript.throughSequence,
    items: [
      {
        type: "reasoning_block",
        id: "reasoning-1",
        sequence: 1,
        sourceSessionId: agent.transcript.childSessionId,
        branchBoundary: null,
        artifactType: "provider_reasoning",
        disclosure: "owner_only",
        provider: "DeepSeek",
        status: "completed",
        text: null,
        artifact: null,
      },
      {
        type: "tool_call",
        id: "tool-1",
        sequence: 2,
        sourceSessionId: agent.transcript.childSessionId,
        branchBoundary: null,
        callId: "call-1",
        qualifiedName: "read_file",
        kind: "read",
        effect: "read",
        label: "Read file",
        subject: null,
        source: null,
        durationMs: 4,
        status: "completed",
        outcome: { status: "completed" },
        resultSummary: "1 line",
        artifacts: [artifact],
        changePreviewRef: null,
        preview: {
          kind: "read_text",
          language: null,
          lines: [{ number: 1, text: "tool preview line" }],
          omittedBytes: 0,
          sourceTruncated: false,
        },
      },
    ],
    olderCursor: null,
  });
  const transcriptLoaded = Promise.withResolvers<void>();
  const artifactLoaded = Promise.withResolvers<void>();
  let navigator!: AgentNavigator;
  navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 0 }, agents: [agent] },
    onCancel: vi.fn(),
    onChange() {
      const rendered = navigator.render(120).join("\n");
      if (rendered.includes("tool preview line")) transcriptLoaded.resolve();
      if (rendered.includes("Bounded artifact.")) artifactLoaded.resolve();
    },
    onClose: vi.fn(),
    onReadArtifact,
    onReadTranscript,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });
  navigator.handleInput("\r");
  await transcriptLoaded.promise;
  const transcript = navigator.render(120).join("\n");
  expect(transcript).toContain("Thinking done · DeepSeek");
  expect(transcript).toContain("owner-only content undisclosed");
  expect(transcript).toContain("tool preview line");
  expect(transcript).toContain("a read artifact");

  navigator.handleInput("a");
  await artifactLoaded.promise;
  expect(navigator.render(120).join("\n")).toContain("Bounded artifact.");
  expect(onReadArtifact).toHaveBeenCalledWith({
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    expectedRevision: agent.revision,
    expectedThroughSequence: agent.transcript.throughSequence,
    artifact,
    range: { offset: 0, maximumBytes: 16 * 1024 },
  });
});

test("AgentNavigator discards a late artifact page when the selected agent attempt changes", async () => {
  const oldAgent = managedAgentFixture({
    transcript: { childSessionId: "child-old", throughSequence: 4 },
  });
  const newAgent = managedAgentFixture({
    attemptId: "123e4567-e89b-42d3-a456-426614174299",
    revision: 2,
    transcript: { childSessionId: "child-new", throughSequence: 1 },
  });
  const artifact = {
    id: "sha256:late-managed-artifact",
    mediaType: "text/plain",
    byteCount: 19,
    source: "tool_output" as const,
  };
  const artifactStarted = Promise.withResolvers<void>();
  const releaseArtifact = Promise.withResolvers<void>();
  const staleArtifactSettled = Promise.withResolvers<void>();
  const oldTranscriptLoaded = Promise.withResolvers<void>();
  let artifactReturned = false;
  const onReadArtifact = vi.fn(async () => {
    artifactStarted.resolve();
    await releaseArtifact.promise;
    artifactReturned = true;
    return {
      mediaType: "text/plain",
      offset: 0,
      byteCount: 19,
      totalByteCount: 19,
      eof: true,
      nextRange: null,
      text: "stale artifact body",
    };
  });
  const onReadTranscript = vi.fn(
    async (input: { readonly attemptId: string; readonly expectedThroughSequence: number }) => ({
      type: "managed_agent_transcript_page" as const,
      agentId: oldAgent.agentId,
      attemptId: input.attemptId,
      childSessionId: input.attemptId === oldAgent.attemptId ? "child-old" : "child-new",
      throughSequence: input.expectedThroughSequence,
      items:
        input.attemptId === oldAgent.attemptId
          ? [
              {
                type: "tool_call" as const,
                id: "tool-late",
                sequence: 2,
                sourceSessionId: "child-old",
                branchBoundary: null,
                callId: "call-late",
                qualifiedName: "read_file",
                kind: "read" as const,
                effect: "read" as const,
                label: "Read file",
                subject: null,
                source: null,
                durationMs: 4,
                status: "completed" as const,
                outcome: { status: "completed" as const },
                resultSummary: "artifact",
                artifacts: [artifact],
                changePreviewRef: null,
                preview: null,
              },
            ]
          : [],
      olderCursor: null,
    }),
  );
  let navigator!: AgentNavigator;
  navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 0 }, agents: [oldAgent] },
    onCancel: vi.fn(),
    onChange() {
      const rendered = navigator.render(120).join("\n");
      if (rendered.includes("a read artifact")) oldTranscriptLoaded.resolve();
      if (artifactReturned && rendered.includes(newAgent.attemptId)) staleArtifactSettled.resolve();
    },
    onClose: vi.fn(),
    onReadArtifact,
    onReadTranscript,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  navigator.handleInput("\r");
  await oldTranscriptLoaded.promise;
  navigator.handleInput("a");
  await artifactStarted.promise;
  navigator.setManagedAgents(
    { counts: { active: 1, terminal: 0, attention: 0 }, agents: [newAgent] },
    [],
  );
  releaseArtifact.resolve();
  await staleArtifactSettled.promise;

  const rendered = navigator.render(120).join("\n");
  expect(rendered).toContain(newAgent.attemptId);
  expect(rendered).toContain("Transcript · read-only");
  expect(rendered).not.toContain("stale artifact body");
});

test("a stalled Agent detail offers an exact ordinary message with safe-boundary delivery copy", () => {
  const agent = managedAgentFixture({
    status: "stalled",
    phase: "stalled",
    watchdog: { state: "stalled", maximumInactivityMilliseconds: 300_000 },
  });
  const onMessage = vi.fn();
  const navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 1 }, agents: [agent] },
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    onMessage,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  navigator.handleInput("\r");
  const detail = navigator.render(80).join("\n");
  expect(detail).toContain("stalled · revision 1 · stalled");
  expect(detail).toContain("m message at next safe boundary; delivery does not imply compliance");
  navigator.handleInput("m");
  expect(onMessage).toHaveBeenCalledWith({ agentId: agent.agentId, expectedRevision: 1 });
});

test("terminal Agent details expose exact follow-up and recovery intents only for eligible states", () => {
  const completed = managedAgentFixture({ status: "completed", phase: "terminal", revision: 6 });
  const recovery = managedAgentFixture({
    agentId: "123e4567-e89b-42d3-a456-426614174231",
    status: "recovery_required",
    phase: "terminal",
    revision: 8,
  });
  const onFollowUp = vi.fn();
  const onRecovery = vi.fn();
  const navigator = new AgentNavigator({
    managedAgents: {
      counts: { active: 0, terminal: 2, attention: 0 },
      agents: [completed, recovery],
    },
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    onFollowUp,
    onRecovery,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  navigator.handleInput("\r");
  expect(navigator.render(80).join("\n")).toContain("f follow-up from exact terminal evidence");
  navigator.handleInput("f");
  expect(onFollowUp).toHaveBeenCalledWith({
    agentId: completed.agentId,
    expectedRevision: completed.revision,
  });
  navigator.handleInput("\u001b[27;1;27~");
  navigator.handleInput("\u001b[B");
  navigator.handleInput("\r");
  expect(navigator.render(80).join("\n")).toContain("r recover from exact durable evidence");
  navigator.handleInput("r");
  expect(onRecovery).toHaveBeenCalledWith({
    agentId: recovery.agentId,
    expectedRevision: recovery.revision,
  });
});

test("manual managed transcript scroll pauses live-tail following and PageDown resumes it", async () => {
  const agent = managedAgentFixture({
    transcript: { childSessionId: "child-live", throughSequence: 9 },
  });
  const initialPage = {
    type: "managed_agent_transcript_page",
    agentId: agent.agentId,
    attemptId: agent.attemptId,
    childSessionId: agent.transcript.childSessionId,
    throughSequence: agent.transcript.throughSequence,
    items: Array.from({ length: 8 }, (_, index) => ({
      type: "assistant_message" as const,
      id: `assistant-${index}`,
      sequence: index + 1,
      sourceSessionId: agent.transcript.childSessionId,
      branchBoundary: null,
      text: `durable-${index}`,
      artifact: null,
    })),
    olderCursor: null,
  } as const;
  let refreshReadStarted = false;
  const onReadTranscript = vi.fn(async (input: { readonly expectedThroughSequence: number }) => {
    if (input.expectedThroughSequence !== 10) {
      return initialPage;
    }
    refreshReadStarted = true;
    return {
      ...initialPage,
      throughSequence: 10,
      items: Array.from({ length: 5 }, (_, index) => ({
        type: "assistant_message" as const,
        id: `assistant-${index + 5}`,
        sequence: index + 6,
        sourceSessionId: agent.transcript.childSessionId,
        branchBoundary: null,
        text: `durable-${index + 5}`,
        artifact: null,
      })),
    };
  });
  const transcriptLoaded = Promise.withResolvers<void>();
  const transcriptRefreshed = Promise.withResolvers<void>();
  let navigator!: AgentNavigator;
  navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 0 }, agents: [agent] },
    onCancel: vi.fn(),
    onChange() {
      const rendered = navigator.render(80).join("\n");
      if (rendered.includes("durable-7")) transcriptLoaded.resolve();
      if (
        refreshReadStarted &&
        rendered.includes("reading paused") &&
        rendered.includes("durable-2") &&
        rendered.includes("durable-6")
      ) {
        transcriptRefreshed.resolve();
      }
    },
    onClose: vi.fn(),
    onReadTranscript,
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });
  navigator.handleInput("\r");
  await transcriptLoaded.promise;
  expect(navigator.render(80).join("\n")).toContain("durable-7");
  navigator.handleInput("\u001b[A");
  const updatedAgent = {
    ...agent,
    transcript: { ...agent.transcript, throughSequence: 10 },
  };
  navigator.setManagedAgents(
    { counts: { active: 1, terminal: 0, attention: 0 }, agents: [updatedAgent] },
    [
      {
        agentId: agent.agentId,
        attemptId: agent.attemptId,
        childSessionId: agent.transcript.childSessionId,
        activity: "replying",
        assistant: { itemId: "live-1", text: "live child tail" },
      },
    ],
  );
  await transcriptRefreshed.promise;
  const paused = navigator.render(80).join("\n");
  expect(paused).toContain("reading paused");
  expect(paused).toContain("durable-2");
  navigator.handleInput("\u001b[6~");
  const resumed = navigator.render(80).join("\n");
  expect(resumed).toContain("following live tail");
  expect(resumed).toContain("live child tail");
});

test("Agent detail preserves controls and one transcript row inside the minimum overlay height", () => {
  const agent = managedAgentFixture({ status: "stalled", phase: "stalled" });
  let height = 8;
  const navigator = new AgentNavigator({
    managedAgents: { counts: { active: 1, terminal: 0, attention: 1 }, agents: [agent] },
    maximumContentHeight: () => height,
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn(),
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });
  navigator.handleInput("\r");

  for (height of [8, 12, 13, 14, 17, 20]) {
    const lines = navigator.render(104);
    const rendered = lines.join("\n");
    expect(lines.length, `height ${height}`).toBeLessThanOrEqual(height);
    expect(rendered, `height ${height}`).toContain("Agent detail");
    expect(rendered, `height ${height}`).toContain("m message");
    expect(rendered, `height ${height}`).toContain("Esc back");
    expect(rendered, `height ${height}`).toContain("Transcript · read-only");
    expect(rendered, `height ${height}`).toContain("Transcript is unavailable");
  }
});

test("Agent roster keeps the focused child visible inside the minimum overlay height", () => {
  const agents = Array.from({ length: 6 }, (_, index) =>
    managedAgentFixture({
      agentId: `123e4567-e89b-42d3-a456-${String(index + 1).padStart(12, "0")}`,
      attemptId: `123e4567-e89b-42d3-a457-${String(index + 1).padStart(12, "0")}`,
      profile: index === 5 ? "research.v2" : "scout.v1",
    }),
  );
  const navigator = new AgentNavigator({
    managedAgents: { counts: { active: 6, terminal: 0, attention: 0 }, agents },
    maximumContentHeight: () => 8,
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onClose: vi.fn(),
    onReply: vi.fn(),
    theme: createAdamTuiTheme(true),
  });

  for (let index = 0; index < 5; index += 1) {
    navigator.handleInput("\u001b[B");
  }
  const lines = navigator.render(40);

  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines.join("\n")).toContain("Enter detail");
  expect(lines.join("\n")).toContain("Esc close");
  expect(lines.join("\n")).toContain(agents[5]?.agentId);
  expect(lines.some((line) => line.startsWith("> "))).toBe(true);

  navigator.handleInput("\u001b[118;1:1u");
  navigator.handleInput("\u001b[50;1:1u");
  const filtered = navigator.render(40).join("\n");
  expect(filtered).toContain("Search: v2");
  expect(filtered).toContain(agents[5]?.agentId);
});

function managedAgentFixture(
  overrides: Partial<AuthoritativePresentationSnapshot["managedAgents"]["agents"][number]> = {},
): AuthoritativePresentationSnapshot["managedAgents"]["agents"][number] {
  return {
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
    messages: [],
    ...overrides,
  };
}
