import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  createJsonlSessionStore,
  createModelTargets,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  presentationCatalogPageSize,
  sessionCatalogWorkerFactory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { runTui } from "./tui-app.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

async function guarded<T>(operation: Promise<T>, missing: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(missing)),
          terminalObservationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.each([
  "untouched",
  "search",
  "close",
  "new",
  "history",
  "more",
  "exit-held",
  "missing-workspace",
] as const)(
  "background catalog respects the %s startup choice and reclaims its worker",
  async (choice) => {
    const root = await mkdtemp(join(tmpdir(), "adam-picker-startup-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const configured = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "fixture-only-no-network" },
    });
    const driver: ModelDriver = {
      async *stream() {
        yield { type: "text_delta", text: "Saved fixture answer." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const modelTargets: ModelTargets = {
      ...configured,
      async resolve(input) {
        return { ...(await configured.resolve(input)), driver };
      },
    };
    const heldStart = Promise.withResolvers<() => void>();
    let workerExit: Promise<void> | undefined;
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
      [sessionCatalogWorkerFactory]: (url, options) => {
        const worker = new Worker(url, options);
        workerExit = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
          const [message] = args;
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "start"
          ) {
            heldStart.resolve(() => post(...args));
          } else post(...args);
        };
        return worker;
      },
    });
    const terminal = new VirtualTerminal({ columns: 100, rows: 24 });
    let execution: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      const targetId = "deepseek-v4-flash.direct";
      if (choice === "search" || choice === "history" || choice === "more") {
        const target = await modelTargets.resolve({
          targetId,
          allowExperimental: false,
          signal: new AbortController().signal,
        });
        const saved = await lifecycle.create({ targetIdentity: target.identity });
        await lifecycle.continue({
          sessionId: saved.sessionId,
          input: { text: "Saved history request" },
        });
        await lifecycle.setSessionManualName({ sessionId: saved.sessionId, name: "Saved history" });
      }
      if (choice === "more") {
        const legacy = await createJsonlSessionStore({
          workspaceRoot,
          stateRoot,
          sessionId: "123e4567-e89b-42d3-a456-426614174000",
        });
        await legacy.append({
          schemaVersion: 1,
          runId: "123e4567-e89b-42d3-a456-426614174000",
          sequence: 1,
          event: { type: "user_message", text: "Legacy page" },
        });
      }
      const presentation = await createPresentationSession({
        lifecycle,
        modelTargets,
        workspaceRoot,
        stateRoot,
        openProject: true,
        backgroundStartup: true,
        [presentationCatalogPageSize]: choice === "more" ? 1 : 20,
        projectLabel: "workspace",
      });
      const catalogComplete = Promise.withResolvers<void>();
      const seenDrafts: string[] = [];
      const unsubscribe = presentation.subscribe(() => {
        const state = presentation.getState();
        if (state.draft !== null) seenDrafts.push(state.draft.targetId);
        if (state.authoritative.sessions.health?.status === "complete") catalogComplete.resolve();
      });
      execution = runTui({
        presentation,
        terminal,
        startupTargetId: targetId,
        closeRuntime: () => lifecycle.close().then(() => {}),
      });
      release = await guarded(heldStart.promise, "held native catalog start");
      if (workerExit === undefined) throw new Error("The held catalog has no native worker.");
      await terminal.waitForScreen("Loading sessions…");
      expect(presentation.getState().draft).toBeNull();
      expect(terminal.lines().join("\n")).toContain("New Session");
      if (choice === "exit-held") {
        terminal.input("\u0011");
        await execution;
        await guarded(workerExit, "catalog worker exit while held");
      } else if (choice === "missing-workspace") {
        const beforeFailure = terminal.output().length;
        await rename(workspaceRoot, join(root, "moved-workspace"));
        release();
        await terminal.waitForFrameAfter(
          "History check failed",
          beforeFailure,
          "Loading sessions…",
        );
        expect(presentation.getState().authoritative.sessions).toMatchObject({
          loading: false,
          health: { status: "failed" },
          error: { code: "catalog_scan_failed" },
        });
        const visibleText = terminal
          .lines()
          .map((line) => line.replaceAll("│", "").trim())
          .join(" ");
        expect(visibleText).toContain("Existing local sessions were retained.");
        expect(presentation.getState().draft).toBeNull();
        terminal.input("\u0011");
        await execution;
        await guarded(workerExit, "failed catalog worker exit");
      } else {
        if (choice === "search" || choice === "more") {
          const before = terminal.output().length;
          terminal.input("Saved");
          await terminal.waitForFrameAfter("Search: Saved", before);
        } else if (choice === "close") {
          const before = terminal.output().length;
          terminal.input("\u001b");
          await terminal.waitForFrameAfter("No session", before, "Select a project session");
        } else if (choice === "new") {
          terminal.input("\r");
          await terminal.waitForScreen("Select an exact model target");
          terminal.input("\r");
          await terminal.waitForScreen("New session draft");
          const before = terminal.output().length;
          terminal.input("Preserve my draft");
          await terminal.waitForFrameAfter("Preserve my draft", before);
        }
        const beforeCompletion = terminal.output().length;
        release();
        await guarded(catalogComplete.promise, "completed native catalog");
        if (choice === "untouched") {
          await terminal.waitForFrameAfter("New session draft", beforeCompletion);
          expect(presentation.getState().draft?.targetId).toBe(targetId);
        } else if (choice === "search" || choice === "history") {
          await terminal.waitForFrameAfter("Saved history", beforeCompletion);
          expect(terminal.lines().join("\n")).toContain("Select a project session");
          if (choice === "search") expect(terminal.lines().join("\n")).toContain("Search: Saved");
          expect(presentation.getState().draft).toBeNull();
        } else if (choice === "more") {
          await terminal.waitForFrameAfter("Load More", beforeCompletion);
          expect(presentation.getState().draft).toBeNull();
          const beforePage = terminal.output().length;
          terminal.input("\u001b[B\r");
          await terminal.waitForFrameAfter("Saved history", beforePage);
          expect(terminal.lines().join("\n")).toContain("Search: Saved");
          expect(presentation.getState().authoritative.active).toBeNull();
        } else if (choice === "new") {
          expect(terminal.lines().join("\n")).toContain("Preserve my draft");
          expect(presentation.getState().composer.renderedText).toBe("Preserve my draft");
          expect(presentation.getState().draft?.targetId).toBe(targetId);
        }
        terminal.input("\u0011");
        await execution;
        await guarded(workerExit, "catalog worker exit");
        if (choice === "close") expect(seenDrafts).toEqual([]);
      }
      unsubscribe();
    } finally {
      if (terminal.running()) terminal.input("\u0011");
      await execution?.catch(() => {});
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
