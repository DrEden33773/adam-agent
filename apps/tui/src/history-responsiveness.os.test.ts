import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  createPresentationSession,
  createSessionLifecycle,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  createUnavailablePlanShellEnvironmentV1,
  planShellEnvironmentFactory,
  sessionAutomaticTitlesEnabled,
  sessionCatalogWorkerFactory,
  sessionHistoryWorkerFactory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { runTui } from "./tui-app.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

async function guarded<T>(promise: Promise<T>, missing: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
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
          yield { type: "text_delta", text: "Retained history answer." };
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

test("history browsing and durable archive receipts do not wait for catalog refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-history-responsive-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  let holdCatalog = false;
  const held: Array<() => void> = [];
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
    [planShellEnvironmentFactory]: createUnavailablePlanShellEnvironmentV1,
    [sessionCatalogWorkerFactory]: (url, options) => {
      const worker = new Worker(url, options);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
        if (holdCatalog && args[0]?.type === "start") held.push(() => post(...args));
        else post(...args);
      };
      return worker;
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let execution: Promise<void> | undefined;
  const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "Named history" } });
    await lifecycle.setSessionManualName({ sessionId: session.sessionId, name: "Named history" });
    presentation = await createPresentationSession({
      lifecycle,
      workspaceRoot,
      stateRoot,
      modelTargets,
      projectLabel: "History responsiveness",
      openProject: true,
      backgroundStartup: true,
    });
    const current = presentation;
    const complete = Promise.withResolvers<void>();
    const observe = () => {
      if (current.getState().authoritative.sessions.health?.status === "complete")
        complete.resolve();
    };
    const unsubscribe = current.subscribe(observe);
    observe();
    await guarded(complete.promise, "initial history health completion");
    unsubscribe();
    execution = runTui({
      presentation: current,
      terminal,
      closeRuntime: async () => {
        await current.close();
        await lifecycle.close();
      },
    });
    await terminal.waitForScreen("Named history");
    const press = async (key: string, frame: string, absent?: string) => {
      const before = terminal.output().length;
      terminal.input(key);
      await terminal.waitForFrameAfter(frame, before, absent);
    };
    await press("Named", "> Named history");
    holdCatalog = true;
    await press("\t", "[Archived]");
    await press("\t", "[Trash]");
    await press("\t", "[Active]");
    expect(current.getState().authoritative.sessions.loading).toBe(true);
    expect(terminal.lines().join("\n")).toContain("> Named history");
    await press("\u007f", "Search: Name");
    await press("\u0001", "Session archived.");
    expect(current.getState().authoritative.sessions.loading).toBe(true);
    expect(current.getState().authoritative.sessions.items).toEqual([]);
    const visibilityPath = join(
      stateRoot,
      "projects",
      session.projectId.slice("sha256:".length),
      "session-visibility",
      "index.json",
    );
    expect(JSON.parse(await readFile(visibilityPath, "utf8")).archived).toEqual([
      session.sessionId,
    ]);
    await press("\t", "[Archived]");
    expect(terminal.lines().join("\n")).toContain("> Named history");
    await press("\u0015", "Session unarchived.");
    expect(JSON.parse(await readFile(visibilityPath, "utf8")).archived).toEqual([]);
    await press("\t", "[Trash]");
    await press("\t", "[Active]");
    expect(terminal.lines().join("\n")).toContain("Search: Name");
    expect(terminal.lines().join("\n")).toContain("> Named history");
    await press("\u001b", "Choose an exact model target", "Select a project session");
    terminal.input("\u0011");
    await guarded(execution, "TUI close while catalog starts are held");
  } finally {
    // Native termination must reclaim held workers; no release is needed for close.
    if (execution !== undefined && terminal.running()) {
      terminal.input("\u0011");
      await guarded(execution, "history fixture TUI cleanup");
    }
    await presentation?.close();
    await lifecycle.close();
    held.length = 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed Trash and Restore finish under their claims without taking the user's newer view", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-history-confirmed-responsive-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  let trashChecks = 0;
  const heldTrash = Promise.withResolvers<() => void>();
  const heldRestore = Promise.withResolvers<() => void>();
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
    [planShellEnvironmentFactory]: createUnavailablePlanShellEnvironmentV1,
    [sessionHistoryWorkerFactory]: (url, options) => {
      const worker = new Worker(url, options);
      const kind = options.workerData.request.type;
      if (kind === "trash") trashChecks += 1;
      const gate =
        kind === "restore"
          ? heldRestore
          : kind === "trash" && trashChecks === 2
            ? heldTrash
            : undefined;
      if (gate !== undefined) {
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
          if (args[0]?.type === "start") gate.resolve(() => post(...args));
          else post(...args);
        };
      }
      return worker;
    },
  });
  const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let execution: Promise<void> | undefined;
  let releaseTrash: (() => void) | undefined;
  let releaseRestore: (() => void) | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "Confirmed target" } });
    await lifecycle.setSessionManualName({
      sessionId: session.sessionId,
      name: "Confirmed target",
    });
    presentation = await createPresentationSession({
      lifecycle,
      workspaceRoot,
      stateRoot,
      modelTargets,
      projectLabel: "Confirmed history",
      openProject: true,
      backgroundStartup: true,
    });
    const current = presentation;
    execution = runTui({
      presentation: current,
      terminal,
      closeRuntime: async () => {
        await current.close();
        await lifecycle.close();
      },
    });
    await terminal.waitForScreen("Confirmed target");
    const preview = await current.dispatch({
      type: "preview_session_trash",
      sessionId: session.sessionId,
    });
    if (preview.status !== "admitted" || preview.trashPreview?.previewId == null)
      throw new Error("Expected a complete Trash preview.");
    const moving = current.dispatch({
      type: "confirm_session_trash",
      previewId: preview.trashPreview.previewId,
    });
    releaseTrash = await guarded(heldTrash.promise, "held confirm revalidation");
    let before = terminal.output().length;
    terminal.input("\t");
    await terminal.waitForFrameAfter("[Archived]", before);
    expect(
      await current.dispatch({
        type: "set_session_visibility",
        sessionId: session.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: "rejected", code: "conflict" });
    releaseTrash();
    const moved = await guarded(moving, "confirmed Trash completion after browsing");
    expect(moved).toMatchObject({ status: "admitted", trashItem: { phase: "trashed" } });
    expect(current.getState().authoritative.sessions.view).toBe("archived");
    const item = (await lifecycle.listSessionTrash()).items[0];
    if (item === undefined) throw new Error("Expected the retained Trash transaction.");
    await current.dispatch({ type: "set_session_view", view: "trash" });
    const restoring = current.dispatch({
      type: "restore_session_trash",
      transactionId: item.transactionId,
      expectedRevision: item.revision,
    });
    releaseRestore = await guarded(heldRestore.promise, "held restored resource validation");
    await expect(lifecycle.inspect({ sessionId: session.sessionId })).rejects.toMatchObject({
      code: "session_in_trash",
    });
    before = terminal.output().length;
    terminal.input("\t");
    await terminal.waitForFrameAfter("[Active]", before);
    before = terminal.output().length;
    terminal.input("\t");
    await terminal.waitForFrameAfter("[Archived]", before);
    releaseRestore();
    expect(await guarded(restoring, "Restore completion after browsing")).toMatchObject({
      status: "admitted",
      trashItem: { phase: "restored" },
    });
    expect(current.getState().authoritative.sessions.view).toBe("archived");
    expect((await lifecycle.inspect({ sessionId: session.sessionId })).status).toBe("settled");
    expect((await lifecycle.listSessionTrash()).items).toEqual([]);
  } finally {
    releaseTrash?.();
    releaseRestore?.();
    if (execution !== undefined && terminal.running()) {
      terminal.input("\u0011");
      await guarded(execution, "confirmed history cleanup");
    }
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["view", "selection", "picker-close", "runtime-close"] as const)(
  "a held Trash inspection is reclaimed after %s while browsing stays responsive",
  async (choice) => {
    const root = await mkdtemp(join(tmpdir(), "adam-history-inspection-responsive-"));
    const workspaceRoot = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const workerStarted = Promise.withResolvers<void>();
    const workerExited = Promise.withResolvers<void>();
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
      [sessionAutomaticTitlesEnabled]: false,
      [planShellEnvironmentFactory]: createUnavailablePlanShellEnvironmentV1,
      [sessionHistoryWorkerFactory]: (url, options) => {
        const worker = new Worker(url, options);
        const post = worker.postMessage.bind(worker);
        worker.once("exit", () => workerExited.resolve());
        worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
          if (args[0]?.type === "start") workerStarted.resolve();
          else post(...args);
        };
        return worker;
      },
    });
    let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
    let execution: Promise<void> | undefined;
    let closePhase = "not requested";
    let preview:
      | ReturnType<Awaited<ReturnType<typeof createPresentationSession>>["dispatch"]>
      | undefined;
    const terminal = new VirtualTerminal({ columns: 100, rows: 28 });
    try {
      const session = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: "Inspection target" },
      });
      await lifecycle.setSessionManualName({
        sessionId: session.sessionId,
        name: "Inspection target",
      });
      presentation = await createPresentationSession({
        lifecycle,
        workspaceRoot,
        stateRoot,
        modelTargets,
        projectLabel: "History inspection",
        openProject: true,
        backgroundStartup: true,
      });
      const current = presentation;
      execution = runTui({
        presentation: current,
        terminal,
        closeRuntime: async () => {
          closePhase = "presentation";
          await current.close();
          closePhase = "lifecycle";
          await lifecycle.close();
          closePhase = "complete";
        },
      });
      await terminal.waitForScreen("Inspection target");
      let before = terminal.output().length;
      terminal.input("Inspect");
      await terminal.waitForFrameAfter("> Inspection target", before);
      preview = current.dispatch({ type: "preview_session_trash", sessionId: session.sessionId });
      expect(current.getState().authoritative.sessions).toMatchObject({
        operation: "trash_preview",
      });
      await guarded(workerStarted.promise, "native history inspection start");
      await terminal.waitForScreen("Checking history and dependencies");
      before = terminal.output().length;
      terminal.input("ion");
      await terminal.waitForFrameAfter("Search: Inspection", before);
      expect(current.getState().authoritative.sessions).toMatchObject({
        operation: "trash_preview",
      });
      before = terminal.output().length;
      if (choice === "view") {
        terminal.input("\t");
        await terminal.waitForFrameAfter("[Archived]", before);
      } else if (choice === "selection") {
        terminal.input("\u001b[A");
        await terminal.waitForFrameAfter("> New Session", before);
      } else if (choice === "picker-close") {
        terminal.input("\u001b");
        await terminal.waitForFrameAfter(
          "Choose an exact model target",
          before,
          "Select a project session",
        );
      } else terminal.input("\u0011");
      await guarded(workerExited.promise, "abandoned preview worker exit");
      expect(await guarded(preview, "abandoned preview receipt")).toMatchObject({
        status: "rejected",
        code: "stale_interaction",
      });
      expect((await lifecycle.listSessionTrash()).items).toEqual([]);
      if (choice === "view" || choice === "selection") {
        before = terminal.output().length;
        terminal.input("\u001b");
        await terminal.waitForFrameAfter(
          "Choose an exact model target",
          before,
          "Select a project session",
        );
      }
      if (choice !== "runtime-close") terminal.input("\u0011");
      await guarded(execution, "history inspection TUI close").catch((error: unknown) => {
        throw new Error(`${String(error)} (${closePhase}): ${terminal.lines().join("\n")}`);
      });
    } finally {
      if (execution !== undefined && terminal.running()) {
        terminal.input("\u0011");
        await guarded(execution, "inspection fixture cleanup");
      }
      await presentation?.close();
      await preview;
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
