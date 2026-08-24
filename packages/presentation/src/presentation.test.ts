import { describe, expect, it } from "vitest";
import {
  type AuthoritativePresentationSnapshot,
  type PresentationDisplayState,
  reconcilePresentationUpdate,
  resolveSkillMentions,
} from "./index.js";

const emptySnapshot: AuthoritativePresentationSnapshot = {
  schemaVersion: 1,
  continuity: {
    status: "current",
    sessionThroughSequence: 0,
    operationThrough: [],
  },
  project: { id: "project-1", label: "adam-agent" },
  targets: { items: [], defaultTargetId: null, diagnostic: null },
  sessions: {
    items: [
      {
        id: "session-1",
        label: "New session",
        targetId: "fake.local",
        status: "idle",
        naming: {
          manualName: null,
          generatedTitle: null,
          fallbackTitle: null,
          displayLabel: "New session",
          generation: { status: "not_started" },
        },
      },
    ],
    nextCursor: null,
  },
  active: {
    session: {
      id: "session-1",
      label: "New session",
      targetId: "fake.local",
      status: "idle",
      naming: {
        manualName: null,
        generatedTitle: null,
        fallbackTitle: null,
        displayLabel: "New session",
        generation: { status: "not_started" },
      },
    },
    transcript: { items: [], olderCursor: null },
    context: null,
    pendingInteractions: [],
    repositoryInstructions: null,
    skills: null,
    projectPaths: { items: [], omittedCount: 0, diagnostic: null },
    mcp: null,
  },
};

describe("presentation reconciliation", () => {
  it("replaces a transient assistant delta with durable completion", () => {
    const initial: PresentationDisplayState = {
      revision: 1,
      authoritative: emptySnapshot,
      draft: null,
      transient: null,
    };

    const streaming = reconcilePresentationUpdate(initial, {
      type: "assistant_delta",
      streamId: "stream-1",
      afterSequence: 0,
      text: "正在检查",
    });

    expect(streaming).toEqual({
      revision: 2,
      authoritative: emptySnapshot,
      draft: null,
      transient: {
        activity: "replying",
        assistant: {
          streamId: "stream-1",
          afterSequence: 0,
          text: "正在检查",
        },
        reasoning: null,
      },
    });

    const completedSnapshot: AuthoritativePresentationSnapshot = {
      ...emptySnapshot,
      continuity: {
        status: "current",
        sessionThroughSequence: 1,
        operationThrough: [],
      },
      active: {
        session: {
          id: "session-1",
          label: "New session",
          targetId: "fake.local",
          status: "settled",
          naming: {
            manualName: null,
            generatedTitle: null,
            fallbackTitle: null,
            displayLabel: "New session",
            generation: { status: "not_started" },
          },
        },
        transcript: {
          items: [
            {
              type: "assistant_message",
              id: "session-1:1",
              sequence: 1,
              sourceSessionId: "session-1",
              branchBoundary: { sessionId: "session-1", sequence: 1 },
              text: "检查完成。",
              artifact: null,
            },
          ],
          olderCursor: null,
        },
        context: null,
        pendingInteractions: [],
        repositoryInstructions: null,
        skills: null,
        projectPaths: { items: [], omittedCount: 0, diagnostic: null },
        mcp: null,
      },
    };

    expect(
      reconcilePresentationUpdate(streaming, {
        type: "authoritative_snapshot",
        snapshot: completedSnapshot,
      }),
    ).toEqual({
      revision: 3,
      authoritative: completedSnapshot,
      draft: null,
      transient: null,
    });
  });

  it("discards a transient delta anchored across a sequence gap and requests repair", () => {
    const initial: PresentationDisplayState = {
      revision: 7,
      authoritative: emptySnapshot,
      draft: null,
      transient: null,
    };

    expect(
      reconcilePresentationUpdate(initial, {
        type: "assistant_delta",
        streamId: "stream-after-gap",
        afterSequence: 2,
        text: "must not be shown",
      }),
    ).toEqual({
      revision: 8,
      authoritative: {
        ...emptySnapshot,
        continuity: { status: "repairing", reason: "gap" },
      },
      draft: null,
      transient: null,
    });
  });

  it("repairs a dropped reasoning fragment from the next cumulative snapshot", () => {
    const initial: PresentationDisplayState = {
      revision: 3,
      authoritative: emptySnapshot,
      draft: null,
      transient: {
        activity: "working",
        assistant: null,
        reasoning: {
          id: "session-1:run-1:1:1:provider-reasoning-0",
          afterSequence: 0,
          artifactType: "provider_reasoning",
          disclosure: "owner_only",
          provider: "DeepSeek",
          status: "active",
          text: "Inspect ",
        },
      },
    };
    const reasoning = initial.transient?.reasoning;
    if (reasoning === null || reasoning === undefined) {
      throw new Error("Expected a transient reasoning block.");
    }

    const repaired = reconcilePresentationUpdate(initial, {
      type: "reasoning_snapshot",
      afterSequence: 0,
      reasoning: {
        ...reasoning,
        text: "Inspect the complete evidence.",
      },
    });

    expect(repaired.transient?.reasoning?.text).toBe("Inspect the complete evidence.");
  });
});

describe("Skill mention resolution", () => {
  it("keeps canonical prompt text while resolving one exact Skill mention", () => {
    const text = "Please use $project-review before changing the code.";

    expect(
      resolveSkillMentions({
        text,
        explicitQualifiedIds: [],
        catalog: {
          revision: 1,
          items: [
            {
              qualifiedId: "skill:v1:project:.:project-review",
              name: "project-review",
              description: "Reviews exact project state.",
              source: { type: "project", scope: "." },
              active: false,
            },
          ],
          diagnostics: [],
          overflow: { omittedCount: 0, shortenedCount: 0 },
          reloadAvailable: false,
        },
      }),
    ).toEqual({
      status: "resolved",
      text,
      qualifiedIds: ["skill:v1:project:.:project-review"],
    });
  });

  it("recognizes token boundaries while leaving escaped dollar text literal", () => {
    const text = String.raw`Keep \$escaped-skill and prefix$embedded-skill literal; use $valid-skill.`;
    const item = (name: string) => ({
      qualifiedId: `skill:v1:user:${name}`,
      name,
      description: `${name} fixture.`,
      source: { type: "user" as const },
      active: false,
    });

    expect(
      resolveSkillMentions({
        text,
        explicitQualifiedIds: [],
        catalog: {
          revision: 1,
          items: [item("escaped-skill"), item("embedded-skill"), item("valid-skill")],
          diagnostics: [],
          overflow: { omittedCount: 0, shortenedCount: 0 },
          reloadAvailable: false,
        },
      }),
    ).toEqual({
      status: "resolved",
      text,
      qualifiedIds: ["skill:v1:user:valid-skill"],
    });
  });

  it("requires one explicit qualified choice for an ambiguous short mention", () => {
    const text = "Use $shared-name.";
    const catalog: Parameters<typeof resolveSkillMentions>[0]["catalog"] = {
      revision: 1,
      items: [
        {
          qualifiedId: "skill:v1:project:.:shared-name",
          name: "shared-name",
          description: "Project procedure.",
          source: { type: "project", scope: "." },
          active: false,
        },
        {
          qualifiedId: "skill:v1:user:shared-name",
          name: "shared-name",
          description: "User procedure.",
          source: { type: "user" },
          active: false,
        },
      ],
      diagnostics: [],
      overflow: { omittedCount: 0, shortenedCount: 0 },
      reloadAvailable: false,
    };

    expect(resolveSkillMentions({ text, explicitQualifiedIds: [], catalog })).toEqual({
      status: "ambiguous",
      text,
      name: "shared-name",
      candidateQualifiedIds: ["skill:v1:project:.:shared-name", "skill:v1:user:shared-name"],
    });
    expect(
      resolveSkillMentions({
        text,
        explicitQualifiedIds: ["skill:v1:user:shared-name"],
        catalog,
      }),
    ).toEqual({
      status: "resolved",
      text,
      qualifiedIds: ["skill:v1:user:shared-name"],
    });
  });

  it("deduplicates multiple exact mentions in first-appearance order", () => {
    const text = "$alpha then $beta then $alpha.";
    const item = (name: string) => ({
      qualifiedId: `skill:v1:user:${name}`,
      name,
      description: `${name} fixture.`,
      source: { type: "user" as const },
      active: false,
    });

    expect(
      resolveSkillMentions({
        text,
        explicitQualifiedIds: [],
        catalog: {
          revision: 1,
          items: [item("alpha"), item("beta")],
          diagnostics: [],
          overflow: { omittedCount: 0, shortenedCount: 0 },
          reloadAvailable: false,
        },
      }),
    ).toEqual({
      status: "resolved",
      text,
      qualifiedIds: ["skill:v1:user:alpha", "skill:v1:user:beta"],
    });
  });
});
