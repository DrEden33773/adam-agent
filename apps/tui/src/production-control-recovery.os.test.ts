import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type ModelDriver,
  type ModelTargets,
  type SessionRecord,
} from "@adam-agent/agent";
import { createJsonlManagedAgentControlStore } from "@adam-agent/agent/internal-testing";
import { expect, onTestFailed, test } from "vitest";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { runTui } from "./tui-app.js";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

const identity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
} as const;
const contextProfile = {
  version: 1,
  contextWindowTokens: 1_000_000,
  maximumOutputTokens: 32_768,
  compactAtTokens: 800_000,
  postCompactTargetTokens: 200_000,
  retainedTargetTokens: 20_000,
  estimatorVersion: 1,
} as const;

test("ordinary production slash exit settles running Control children, suspends its queue and cold Main Enter stays responsive", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-production-control-recovery-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const environment = { XDG_CONFIG_HOME: join(root, "config") };
  const workspaceTrust = createWorkspaceTrust({ environment, workspaceRoot });
  const trust = await workspaceTrust.load();
  if (trust.projectId === null) throw new Error("Missing workspace identity.");
  await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
  let childRequests = 0;
  let childAborts = 0;
  const allRunning = Promise.withResolvers<void>();
  const model: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") yield { type: "text_delta", text: "Control recovery" };
      else if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        const user = request.messages.findLast((message) => message.role === "user");
        if (
          user?.role === "user" &&
          user.content === "Start running and queued children" &&
          request.messages.at(-1)?.role === "user"
        ) {
          yield { type: "tool_call_start", id: "start-recovery-family", name: "spawn_agents" };
          yield {
            type: "tool_call_delta",
            id: "start-recovery-family",
            json: JSON.stringify({
              entries: Array.from({ length: 9 }, (_, index) => ({
                role: "builtin:explore",
                task: `Hold bounded recovery evidence ${index}.`,
                description: `Recovery evidence ${index}`,
              })),
            }),
          };
          yield { type: "tool_call_end", id: "start-recovery-family" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield {
          type: "text_delta",
          text: request.messages.some(
            (message) => message.role === "user" && message.content === "Cold Main Enter",
          )
            ? "Cold Main accepted after suspension."
            : "Main ready while children remain active.",
        };
      } else {
        childRequests += 1;
        if (childRequests === 8) allRunning.resolve();
        yield { type: "text_delta", text: "Child is waiting for cancellation." };
        try {
          await new Promise<void>((_resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                once: true,
              });
          });
        } finally {
          childAborts += 1;
        }
      }
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity, contextProfile, driver: model };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity,
            contextProfile,
            readiness: { status: "available", credentialSource: "external model fixture" },
          },
        ],
      };
    },
  };
  const open = (resumeSessionId?: string) =>
    createProductionProjectRuntime({
      environment,
      workspaceRoot,
      stateRoot,
      workspaceTrust,
      modelTargets,
      preferences: createPresentationPreferences({ environment }),
      permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate"] }),
      extensionPermissions: createPermissionPolicy({ allowedEffects: [] }),
      projectLabel: "Production recovery",
      reservedCommandNames: [],
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    });
  const warm = await open();
  const presentation = await warm.createPresentation({ openProject: true });
  const terminal = new VirtualTerminal({ columns: 80, rows: 32 });
  let coldTerminal: VirtualTerminal | undefined;
  let coldRun: Promise<void> | undefined;
  let cold: Awaited<ReturnType<typeof open>> | undefined;
  onTestFailed(() => console.error((coldTerminal ?? terminal).lines().join("\n")));
  const warmRun = runTui({
    presentation,
    terminal,
    startupTargetId: identity.targetId,
    closeRuntime: () => warm.close(),
  });
  try {
    await terminal.whenStarted();
    await terminal.waitForScreen("New session");
    terminal.input("Start running and queued children\r");
    await terminal.waitForScreen("Confirm delegation");
    terminal.input("\r");
    await terminal.waitForScreen("Main ready while children remain active.");
    let startupGuard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allRunning.promise,
        new Promise<never>((_resolve, reject) => {
          startupGuard = setTimeout(
            () => reject(new Error("Eight current Control children did not start.")),
            terminalObservationTimeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (startupGuard !== undefined) clearTimeout(startupGuard);
    }
    const sessionId = presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) throw new Error("Missing parent Session.");
    const snapshot = presentation.getState().authoritative.managedControl;
    expect(snapshot?.threads).toHaveLength(9);
    expect(snapshot?.threads.filter((thread) => thread.turn.phase === "queued")).toHaveLength(1);
    terminal.input("/exit\r");
    await warmRun;
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
    expect(childRequests).toBe(8);
    expect(childAborts).toBe(8);
    const store = await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot });
    const closed = await store.read();
    const admitted = closed.filter((record) => record.event.type === "admitted");
    const outcomes = closed.filter((record) => record.event.type === "outcome");
    expect(admitted).toHaveLength(9);
    expect(outcomes).toHaveLength(8);
    expect(
      outcomes.every(
        (record) => record.event.type === "outcome" && record.event.status === "interrupted",
      ),
    ).toBe(true);
    expect(closed.filter((record) => record.event.type === "settled")).toHaveLength(8);
    const queued = admitted.find(
      (record) => !outcomes.some((outcome) => outcome.turnId === record.turnId),
    );
    if (queued === undefined) throw new Error("Missing suspended queued turn.");
    expect(closed).toContainEqual(
      expect.objectContaining({ turnId: queued.turnId, event: { type: "suspend_requested" } }),
    );
    expect(await store.readLegacy()).toEqual([]);
    cold = await open(sessionId);
    let reopened = await cold.createPresentation({ sessionId });
    expect(childRequests).toBe(8);
    expect(
      reopened
        .getState()
        .authoritative.managedControl?.threads.find(
          (thread) => thread.turn.turnId === queued.turnId,
        )?.turn,
    ).toMatchObject({ phase: "waiting", waitReason: "suspended" });
    coldTerminal = new VirtualTerminal({ columns: 80, rows: 32 });
    coldRun = runTui({
      presentation: reopened,
      terminal: coldTerminal,
      startupTargetId: identity.targetId,
      closeRuntime: () => cold?.close() ?? Promise.resolve(),
    });
    await coldTerminal.whenStarted();
    await coldTerminal.waitForScreen("Main ready while children remain active.");
    // Closing a read-only cold inspection must also settle through the current owner.
    coldTerminal.input("/exit\r");
    await coldRun;
    expect(childRequests).toBe(8);
    cold = await open(sessionId);
    reopened = await cold.createPresentation({ sessionId });
    coldTerminal = new VirtualTerminal({ columns: 80, rows: 32 });
    coldRun = runTui({
      presentation: reopened,
      terminal: coldTerminal,
      startupTargetId: identity.targetId,
      closeRuntime: () => cold?.close() ?? Promise.resolve(),
    });
    await coldTerminal.whenStarted();
    await coldTerminal.waitForScreen("Main ready while children remain active.");
    const offset = coldTerminal.output().length;
    coldTerminal.input("Cold Main Enter\r");
    await coldTerminal.waitForFrameAfter("Cold Main accepted after suspension.", offset);
    expect(reopened.getState().authoritative.continuity).toMatchObject({ status: "current" });
    expect(childRequests).toBe(8);
    const sessions = createJsonlSessionStoreDirectory<SessionRecord>({ workspaceRoot, stateRoot });
    const records = await (await sessions.open(sessionId))?.read();
    expect(
      records
        ?.filter(
          (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
        )
        .map((record) =>
          record.schemaVersion === 3 && record.record.type === "logical_run_started"
            ? record.record.userMessage
            : "",
        ),
    ).toEqual(["Start running and queued children", "Cold Main Enter"]);
    coldTerminal.input("/exit\r");
    await coldRun;
  } finally {
    if (terminal.running()) terminal.input("\u0011");
    await warmRun.catch(() => undefined);
    if (coldTerminal?.running()) coldTerminal.input("\u0011");
    await coldRun?.catch(() => undefined);
    await cold?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
