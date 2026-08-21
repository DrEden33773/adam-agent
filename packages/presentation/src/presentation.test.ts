import { describe, expect, it } from "vitest";
import {
  type AuthoritativePresentationSnapshot,
  type PresentationDisplayState,
  reconcilePresentationUpdate,
} from "./index.js";

const emptySnapshot: AuthoritativePresentationSnapshot = {
  schemaVersion: 1,
  continuity: {
    status: "current",
    sessionThroughSequence: 0,
    operationThrough: [],
  },
  project: { id: "project-1", label: "adam-agent" },
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
    pendingInteractions: [],
  },
};

describe("presentation reconciliation", () => {
  it("replaces a transient assistant delta with durable completion", () => {
    const initial: PresentationDisplayState = {
      revision: 1,
      authoritative: emptySnapshot,
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
      transient: {
        activity: "replying",
        assistant: {
          streamId: "stream-1",
          afterSequence: 0,
          text: "正在检查",
        },
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
        pendingInteractions: [],
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
      transient: null,
    });
  });

  it("discards a transient delta anchored across a sequence gap and requests repair", () => {
    const initial: PresentationDisplayState = {
      revision: 7,
      authoritative: emptySnapshot,
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
      transient: null,
    });
  });
});
