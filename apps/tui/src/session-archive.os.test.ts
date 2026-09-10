import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPresentationSession,
  createSessionLifecycle,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  createUnavailablePlanShellEnvironmentV1,
  planShellEnvironmentFactory,
  presentationCatalogPageSize,
  sessionAutomaticTitlesEnabled,
} from "@adam-agent/agent/internal-testing";
import { expect, test, vi } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";
import { runTui } from "./tui-app.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

async function guarded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          terminalObservationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const targetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;
const contextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8_000,
  estimatorVersion: 1,
} as const;
const modelTargets: ModelTargets = {
  async resolve() {
    return {
      identity: targetIdentity,
      contextProfile,
      driver: {
        async *stream() {
          yield { type: "text_delta", text: "Retained archive conversation." };
          yield { type: "finish", reason: "stop" };
        },
      },
    };
  },
  async snapshot() {
    return {
      targets: [
        {
          identity: targetIdentity,
          contextProfile,
          readiness: { status: "available", credentialSource: "fixture" },
        },
      ],
    };
  },
};

test.each([40, 80, 120])(
  "ordinary picker archive, undo and reopen at %i columns",
  async (columns) => {
    const root = await mkdtemp(join(tmpdir(), "adam-tui-archive-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    vi.stubEnv("NO_COLOR", "1");
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
      [sessionAutomaticTitlesEnabled]: false,
      [planShellEnvironmentFactory]: createUnavailablePlanShellEnvironmentV1,
    });
    const terminal = new VirtualTerminal({ columns, rows: 24 });
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    let execution: Promise<void> | undefined;
    try {
      const session = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: "Archive acceptance" },
      });
      await lifecycle.setSessionManualName({ sessionId: session.sessionId, name: "Named history" });
      presentation = await createPresentationSession({
        lifecycle,
        modelTargets,
        workspaceRoot,
        stateRoot,
        sessionId: session.sessionId,
        projectLabel: "Archive project",
      });
      execution = runTui({
        presentation,
        terminal,
        closeRuntime: async () => {
          await presentation?.close();
          await lifecycle.close();
        },
      });
      await terminal.waitForScreen("Retained archive conversation.");
      let before = terminal.output().length;
      terminal.input("/resume");
      await terminal.waitForFrameAfter("/resume", before);
      before = terminal.output().length;
      terminal.input("\r");
      await terminal.waitForFrameAfter("Select a project session", before);
      before = terminal.output().length;
      terminal.input("Named");
      await terminal.waitForFrameAfter("Search: Named", before);
      before = terminal.output().length;
      terminal.input("\u0001");
      await terminal.waitForFrameAfter("Session archived.", before);
      expect(presentation.getState().authoritative.active).toBeNull();
      expect(presentation.getState().authoritative.sessions.items).toEqual([]);
      before = terminal.output().length;
      terminal.input("\t");
      await terminal.waitForFrameAfter("[Archived]", before);
      expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
        session.sessionId,
      ]);
      before = terminal.output().length;
      terminal.input("\u0015");
      await terminal.waitForFrameAfter("Session unarchived.", before);
      before = terminal.output().length;
      terminal.input("\t");
      await terminal.waitForFrameAfter("[Trash]", before);
      before = terminal.output().length;
      terminal.input("\t");
      await terminal.waitForFrameAfter("[Active]", before);
      expect(terminal.lines().join("\n")).toContain("> Named history");
      before = terminal.output().length;
      terminal.input("\r");
      await terminal.waitForFrameAfter(
        "Retained archive conversation.",
        before,
        "Select a project session",
      );
      expect(presentation.getState().authoritative.active?.session.id).toBe(session.sessionId);
      terminal.input("\u0011");
      await execution;
    } finally {
      if (execution !== undefined) {
        if (terminal.running()) terminal.input("\u0011");
        await execution;
      }
      await presentation?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);

test.each([
  [2, false],
  [3, false],
  [3, true],
] as const)(
  "page-two archive and Undo retain selection with %i total sessions (background %s)",
  async (count, backgroundStartup) => {
    const root = await mkdtemp(join(tmpdir(), "adam-archive-page-selection-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
      [sessionAutomaticTitlesEnabled]: false,
      [planShellEnvironmentFactory]: createUnavailablePlanShellEnvironmentV1,
    });
    const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    let execution: Promise<void> | undefined;
    try {
      const sessions: string[] = [];
      for (const name of count === 2
        ? ["History Two", "History Three"]
        : ["History One", "History Two", "History Three"]) {
        const session = await lifecycle.create({ targetIdentity });
        await lifecycle.continue({ sessionId: session.sessionId, input: { text: name } });
        await lifecycle.setSessionManualName({ sessionId: session.sessionId, name });
        sessions.push(session.sessionId);
        await utimes(
          join(
            stateRoot,
            "projects",
            session.projectId.slice("sha256:".length),
            "sessions",
            `${session.sessionId}.jsonl`,
          ),
          100 + sessions.length,
          100 + sessions.length,
        );
      }
      const newest = sessions.at(-1);
      const selected = sessions.at(-2);
      presentation = await createPresentationSession({
        lifecycle,
        modelTargets,
        workspaceRoot,
        stateRoot,
        openProject: true,
        projectLabel: "Paged archives",
        backgroundStartup,
        [presentationCatalogPageSize]: 1,
      });
      execution = runTui({
        presentation,
        terminal,
        closeRuntime: async () => {
          await presentation?.close();
          await lifecycle.close();
        },
      });
      const press = async (key: string, frame: string) => {
        const offset = terminal.output().length;
        terminal.input(key);
        await terminal.waitForFrameAfter(frame, offset);
      };
      await terminal.waitForScreen("History Three");
      await press("\u001b[B", "> History Three");
      await press("\u001b[B", "> Load More");
      await press("\r", count === 2 ? "> History Two" : "History Two");
      expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
        newest,
        selected,
      ]);
      if (count === 3) await press("\u001b[A", "> History Two");
      await press("\u0001", "Session archived.");
      if (backgroundStartup) await terminal.waitForScreen("> History One");
      expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
        newest,
        ...(count === 2 ? [] : [sessions[0]]),
      ]);
      expect(terminal.lines().join("\n")).toContain(
        count === 2 ? "> History Three" : "> History One",
      );
      await press("\u0015", "Session unarchived.");
      expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
        newest,
        selected,
      ]);
      expect(terminal.lines().join("\n")).toContain("> History Two");
      await press("\t", "[Archived]");
      await press("\t", "[Trash]");
      await press("\t", "[Active]");
      expect(terminal.lines().join("\n")).toContain("> History Two");
      if (backgroundStartup) {
        const completed = Promise.withResolvers<void>();
        const observe = () => {
          if (presentation?.getState().authoritative.sessions.health?.status === "complete")
            completed.resolve();
        };
        const unsubscribe = presentation.subscribe(observe);
        try {
          observe();
          await guarded(completed.promise, "restored catalog page depth");
        } finally {
          unsubscribe();
        }
        expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual(
          [newest, selected],
        );
      }
    } finally {
      if (execution !== undefined) {
        if (terminal.running()) terminal.input("\u0011");
        await execution;
      }
      await presentation?.close();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("live Child archive rejection exposes its reason and the user can explicitly stop it in Agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-archive-live-child-"));
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let calls = 0;
  let stopObserved = false;
  const h = await startManagedTui(
    {
      async *stream(request) {
        calls += 1;
        if (calls === 1) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopObserved = true;
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      workspaceRoot: root,
      initialPrompt: "Establish the parent",
      controlReceiptBarrier: async (command) => {
        if (command.type === "cancel_turn") cancelled.resolve();
      },
    },
  );
  try {
    expect(
      (
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "archive-child",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              { role: "builtin:explore", task: "Remain live", description: "Archive blocker" },
            ],
          },
        })
      ).status,
    ).toBe("admitted");
    await guarded(started.promise, "Child did not start");
    await h.press("/resume\r", "Select a project session");
    await h.press("Fleet", "Search: Fleet");
    await h.press("\u0001", "has executing");
    expect(h.terminal.lines().join("\n")).toContain("open Agents");
    expect(stopObserved).toBe(false);
    expect(h.presentation.getState().authoritative.active?.session.id).toBe(h.parent.sessionId);
    await h.press("\u001b", "Fleet", "Select a project session");
    await h.press("/agents\r", "Agents workspace");
    await h.press("x", "x again to cancel");
    await h.press("x", "Cancelled");
    await guarded(cancelled.promise, "Child cancellation receipt missing");
    expect(stopObserved).toBe(true);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
