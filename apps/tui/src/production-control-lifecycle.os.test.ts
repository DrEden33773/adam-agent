import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
  type ModelDriver,
  type ModelRequest,
  type ModelTargets,
  type SessionRecord,
} from "@adam-agent/agent";
import {
  createJsonlManagedAgentControlStore,
  createWebSearchConfigurationController,
} from "@adam-agent/agent/internal-testing";
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

async function guarded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          terminalObservationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function openProduction(
  driver: ModelDriver,
  prepare?: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "adam-production-control-lifecycle-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const environment = { XDG_CONFIG_HOME: join(root, "config") };
  await prepare?.(environment);
  const workspaceTrust = createWorkspaceTrust({ environment, workspaceRoot });
  const trust = await workspaceTrust.load();
  if (trust.projectId === null) throw new Error("Missing workspace identity.");
  await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity, contextProfile, driver };
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
  const runtime = await createProductionProjectRuntime({
    environment,
    workspaceRoot,
    stateRoot,
    workspaceTrust,
    modelTargets,
    preferences: createPresentationPreferences({ environment }),
    permissions: createPermissionPolicy({
      allowedEffects: ["read", "delegate"],
      askedEffects: ["network"],
    }),
    extensionPermissions: createPermissionPolicy({ allowedEffects: [] }),
    projectLabel: "Production lifecycle",
    reservedCommandNames: [],
  });
  const presentation = await runtime.createPresentation({ openProject: true });
  const terminal = new VirtualTerminal({ columns: 80, rows: 32 });
  onTestFailed(() => console.error(terminal.lines().join("\n")));
  const running = runTui({
    presentation,
    terminal,
    startupTargetId: identity.targetId,
    closeRuntime: () => runtime.close(),
  });
  await terminal.whenStarted();
  await terminal.waitForScreen("New session");
  const sessions = createJsonlSessionStoreDirectory<SessionRecord>({ workspaceRoot, stateRoot });
  const controlStore = await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot });
  return {
    presentation,
    terminal,
    sessions,
    controlStore,
    async press(input: string, visible: string) {
      const offset = terminal.output().length;
      terminal.input(input);
      await terminal.waitForFrameAfter(visible, offset);
    },
    async waitForState(predicate: () => boolean) {
      const done = Promise.withResolvers<void>();
      const check = () => {
        if (predicate()) done.resolve();
      };
      const unsubscribe = presentation.subscribe(check);
      check();
      try {
        await guarded(done.promise, "Production Presentation did not publish the expected state.");
      } finally {
        unsubscribe();
      }
    },
    async close() {
      if (terminal.running()) terminal.input("\u0011");
      try {
        await running;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function parentReceipts(records: readonly SessionRecord[]) {
  return records.flatMap((record) =>
    record.schemaVersion === 3 && record.record.type === "provider_attempt_started"
      ? [record.record.managedAgentDeliveries?.length ?? 0]
      : [],
  );
}

test("ordinary blank Plan draft confirms Research and exact Web authority before automatic Main consumption", async () => {
  const fetched: string[] = [];
  const server = createServer((request, response) => {
    fetched.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          {
            url: "https://example.com/evidence",
            title: "Exact evidence",
            content: "Production immutable Web evidence.",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing external HTTP fixture address.");
  const mainRequests: ModelRequest[] = [];
  const childRequests: ModelRequest[] = [];
  const h = await openProduction(
    {
      async *stream(request) {
        if (request.purpose === "title") {
          yield { type: "text_delta", text: "Plan Research" };
        } else if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          mainRequests.push(request);
          yield {
            type: "text_delta",
            text:
              mainRequests.length === 1
                ? "Automatic evidence consumed."
                : "Main did not receive evidence twice.",
          };
        } else {
          childRequests.push(request);
          if (childRequests.length === 1) {
            yield { type: "tool_call_start", id: "plan-search", name: "web_search" };
            yield {
              type: "tool_call_delta",
              id: "plan-search",
              json: '{"query":"production evidence","limit":1}',
            };
            yield { type: "tool_call_end", id: "plan-search" };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          yield { type: "text_delta", text: "Research Web evidence complete." };
        }
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    },
    async (environment) => {
      await createWebSearchConfigurationController({ environment }).activateSearxng(
        `http://127.0.0.1:${address.port}/search`,
      );
    },
  );
  try {
    await h.press("/plan\r", "Plan exploring");
    await h.press("@Research", "New agent · Research evidence");
    await h.press("\t", "@Research");
    await h.press(
      " Inspect the configured search evidence.",
      "Inspect the configured search evidence.",
    );
    await h.press("\r", "Delegation");
    expect(await h.sessions.listSessionIds()).toEqual([]);
    expect(h.presentation.getState().authoritative.active).toBeNull();
    expect(mainRequests).toEqual([]);
    expect(childRequests).toEqual([]);
    expect(fetched).toEqual([]);
    await h.press("\r", "1 pending");
    await h.press("\u001ba", "Attention Center");
    await h.waitForState(
      () =>
        h.presentation
          .getState()
          .managedAttention?.some(
            (item) =>
              item.handle === "@research-1" &&
              item.kind === "permission" &&
              item.available &&
              item.interaction?.callId === "plan-search" &&
              item.interaction.effect === "network",
          ) === true,
    );
    expect(mainRequests).toEqual([]);
    expect(childRequests).toHaveLength(1);
    expect(fetched).toEqual([]);
    const attention = h.presentation.getState().managedAttention;
    expect(attention).toEqual([
      expect.objectContaining({
        handle: "@research-1",
        kind: "permission",
        available: true,
        interaction: expect.objectContaining({ callId: "plan-search", effect: "network" }),
      }),
    ]);
    await h.press("a", "Completed");
    await h.waitForState(
      () => h.presentation.getState().authoritative.managedControl?.completions.length === 1,
    );
    expect(childRequests).toHaveLength(2);
    expect(fetched).toHaveLength(1);
    expect(
      new URL(fetched[0] ?? "", `http://127.0.0.1:${address.port}`).searchParams.get("q"),
    ).toBe("production evidence");
    expect(JSON.stringify(childRequests[1]?.messages)).toContain(
      "Production immutable Web evidence.",
    );
    expect(childRequests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "web_open", "web_find"]),
    );
    expect(
      childRequests[0]?.tools.some((tool) =>
        /spawn_agents|run_shell|write_file|edit_file/u.test(tool.name),
      ),
    ).toBe(false);
    const active = h.presentation.getState().authoritative.active;
    if (active === null || active === undefined) throw new Error("Missing direct parent Session.");
    expect(active.plan).toMatchObject({
      state: "exploring",
      policyVersion: "plan-policy.hybrid-delegation-todo-v1",
    });
    const directRecords = await (await h.sessions.open(active.session.id))?.read();
    expect(
      directRecords?.some(
        (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
      ),
    ).toBe(false);
    const beforeMain = await h.controlStore.read();
    expect(beforeMain.find((record) => record.event.type === "admitted")?.event).toMatchObject({
      role: "builtin:research",
      envelope: { origin: { kind: "direct_request" } },
    });
    expect(beforeMain.some((record) => record.event.type === "consumed")).toBe(false);
    await h.press("/plan\r", "Exited Plan.");
    expect(h.presentation.getState().authoritative.active?.plan).toBeUndefined();
    await h.press("Consume the Research evidence.\r", "Automatic evidence consumed.");
    await h.waitForState(
      () => h.presentation.getState().authoritative.active?.parentRun?.phase === "ready",
    );
    await h.press("Continue without duplicate evidence.\r", "Main did not receive evidence twice.");
    await h.waitForState(
      () => h.presentation.getState().authoritative.active?.parentRun?.phase === "ready",
    );
    expect(mainRequests).toHaveLength(2);
    expect(JSON.stringify(mainRequests[0]?.messages)).toContain("Research Web evidence complete.");
    const parent = await (await h.sessions.open(active.session.id))?.read();
    expect(parentReceipts(parent ?? [])).toEqual([1, 0]);
    const consumed = (await h.controlStore.read()).filter(
      (record) => record.event.type === "consumed",
    );
    expect(consumed).toHaveLength(1);
    const receipt = consumed[0]?.event;
    if (receipt?.type !== "consumed") throw new Error("Missing consumption receipt.");
    expect(
      parent?.find((record) => record.sequence === receipt.parentReceipt.sequence),
    ).toMatchObject({
      record: { type: "provider_attempt_started", managedAgentDeliveryVersion: 3 },
    });
  } finally {
    await h.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test.each(["foreground", "wait"] as const)(
  "ordinary production %s returns one settled completion to its exact Main tool result",
  async (mode) => {
    const mainRequests: ModelRequest[] = [];
    const waitRequested = Promise.withResolvers<void>();
    const finishChild = Promise.withResolvers<void>();
    let childCalls = 0;
    const h = await openProduction({
      async *stream(request) {
        if (request.purpose === "title") yield { type: "text_delta", text: "Completion lifecycle" };
        else if (request.tools.some((tool) => tool.name === "spawn_agents")) {
          mainRequests.push(request);
          if (mainRequests.length === 1) {
            yield { type: "tool_call_start", id: "completion-spawn", name: "spawn_agents" };
            yield {
              type: "tool_call_delta",
              id: "completion-spawn",
              json: JSON.stringify({
                ...(mode === "foreground" ? { mode: "foreground" } : {}),
                entries: [
                  {
                    role: "builtin:explore",
                    task: "Return exact completion evidence.",
                    description: "Completion evidence",
                  },
                ],
              }),
            };
            yield { type: "tool_call_end", id: "completion-spawn" };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          if (mode === "wait" && mainRequests.length === 2) {
            const spawned = request.messages.findLast(
              (message) => message.role === "tool" && message.name === "spawn_agents",
            );
            const output =
              spawned?.role === "tool" && spawned.result.status === "completed"
                ? spawned.result.output
                : undefined;
            const turns = (
              output as { turns?: readonly { threadId: string; turnId: string }[] } | undefined
            )?.turns;
            if (turns?.length !== 1) throw new Error("Missing exact admitted target.");
            yield { type: "tool_call_start", id: "completion-wait", name: "wait_agents" };
            yield {
              type: "tool_call_delta",
              id: "completion-wait",
              json: JSON.stringify({
                targets: turns.map((turn) => ({
                  threadId: turn.threadId,
                  expectedTurnId: turn.turnId,
                })),
                mode: "all",
              }),
            };
            yield { type: "tool_call_end", id: "completion-wait" };
            waitRequested.resolve();
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          yield { type: "text_delta", text: `${mode} completion consumed once.` };
        } else {
          childCalls += 1;
          if (mode === "wait") await finishChild.promise;
          request.signal.throwIfAborted();
          yield { type: "text_delta", text: "Exact completion evidence." };
        }
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
      },
    });
    try {
      await h.press(`Run ${mode} completion.\r`, "Confirm delegation");
      const offset = h.terminal.output().length;
      h.terminal.input("\r");
      if (mode === "wait") {
        await guarded(waitRequested.promise, "Main did not request its exact wait target.");
        finishChild.resolve();
      }
      await h.terminal.waitForFrameAfter(`${mode} completion consumed once.`, offset);
      await h.waitForState(
        () => h.presentation.getState().authoritative.active?.parentRun?.phase === "ready",
      );
      expect(childCalls).toBe(1);
      expect(mainRequests).toHaveLength(mode === "foreground" ? 2 : 3);
      expect(
        mainRequests.flatMap((request) =>
          request.messages.filter(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.startsWith("Parent message ("),
          ),
        ),
      ).toEqual([]);
      const result = mainRequests.at(-1)?.messages.findLast((message) => message.role === "tool");
      expect(result).toMatchObject({
        name: mode === "foreground" ? "spawn_agents" : "wait_agents",
        result: {
          status: "completed",
          output: {
            status: "completed",
            results: [
              expect.objectContaining({
                outcome: expect.objectContaining({ summary: "Exact completion evidence." }),
              }),
            ],
          },
        },
      });
      const records = await h.controlStore.read();
      expect(records.filter((record) => record.event.type === "completion")).toHaveLength(1);
      const consumed = records.filter((record) => record.event.type === "consumed");
      expect(consumed).toHaveLength(1);
      const sessionId = h.presentation.getState().authoritative.active?.session.id;
      if (sessionId === undefined || consumed[0]?.event.type !== "consumed")
        throw new Error("Missing exact completion owner.");
      const receipt = consumed[0].event.parentReceipt;
      const parent = await (await h.sessions.open(sessionId))?.read();
      expect(parent?.find((record) => record.sequence === receipt.sequence)).toMatchObject({
        record: {
          type: "runtime_event",
          event: {
            type: "tool_completed",
            name: mode === "foreground" ? "spawn_agents" : "wait_agents",
          },
        },
      });
      expect(parentReceipts(parent ?? [])).toEqual(mode === "foreground" ? [0, 0] : [0, 0, 0]);
      expect(await h.controlStore.readLegacy()).toEqual([]);
    } finally {
      finishChild.resolve();
      await h.close();
    }
  },
);
