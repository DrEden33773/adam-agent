import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
  createPresentationPreferences,
  createProductionManagedControlComposition,
  createSessionLifecycle,
  createWorkspaceTrust,
  type ModelDriver,
  type ModelTargets,
  type SessionRecord,
} from "@adam-agent/agent";
import { createJsonlManagedAgentControlStore } from "@adam-agent/agent/internal-testing";
import { expect, onTestFailed, test } from "vitest";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { awaitEveReceipt } from "./public-eve.test-support.js";
import { runTui } from "./tui-app.js";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test("ordinary production keeps representative history, Todo and two unfinished child tools responsive", async () => {
  const testStarted = performance.now();
  let currentPhase = "workspace setup";
  let phaseStarted = testStarted;
  let seedAttempts = 0;
  let childRequests = 0;
  const measurements: Record<string, number[]> & { seed: number[] } = { seed: [] };
  const phase = (name: string) => {
    currentPhase = name;
    phaseStarted = performance.now();
  };
  onTestFailed(() =>
    console.error(
      "Responsiveness progress",
      JSON.stringify({
        phase: currentPhase,
        elapsedMilliseconds: Math.round(performance.now() - testStarted),
        phaseElapsedMilliseconds: Math.round(performance.now() - phaseStarted),
        seedRequests: seedAttempts,
        childProviderRequests: childRequests,
        measurements: Object.fromEntries(
          Object.entries(measurements).map(([name, samples]) => [
            name,
            samples.slice(0, 5).map((sample) => Math.round(sample)),
          ]),
        ),
      }),
    ),
  );
  const root = await mkdtemp(join(tmpdir(), "adam-production-responsiveness-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await seedWorkspace(workspaceRoot);
  const environment = { XDG_CONFIG_HOME: join(root, "config") };
  const workspaceTrust = createWorkspaceTrust({ environment, workspaceRoot });
  const trust = await workspaceTrust.load();
  if (trust.projectId === null) throw new Error("Missing representative workspace identity.");
  await workspaceTrust.setTrusted({ projectId: trust.projectId, trusted: true });
  const release = Promise.withResolvers<void>();
  const seedToolCompletions = Array.from({ length: 40 }, () => Promise.withResolvers<void>());
  const childrenStarted = Promise.withResolvers<void>();
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
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        yield { type: "text_delta", text: "Production responsiveness" };
      } else if (request.tools.some((tool) => tool.name === "spawn_agents")) {
        const user = request.messages.findLast(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            [
              "Seed responsiveness history",
              "Start two performance children",
              "Concurrent Main response",
              "Final Main response",
            ].includes(message.content),
        );
        if (user?.role === "user" && user.content === "Seed responsiveness history") {
          const index = seedAttempts++;
          if (index > 0) {
            const completed = request.messages.findLast((message) => message.role === "tool");
            expect(completed).toMatchObject({
              role: "tool",
              callId: `seed-${index - 1}`,
              result: { status: "completed" },
            });
            seedToolCompletions[index - 1]?.resolve();
          }
          if (index < 40) {
            const name = index < 4 ? "create_todo" : "read_file";
            yield { type: "tool_call_start", id: `seed-${index}`, name };
            yield {
              type: "tool_call_delta",
              id: `seed-${index}`,
              json: JSON.stringify(
                index < 4
                  ? { title: `Evidence task ${index}` }
                  : { path: `area-${index % 3}/evidence.txt` },
              ),
            };
            yield { type: "tool_call_end", id: `seed-${index}` };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          yield { type: "text_delta", text: "Seed complete." };
        } else if (
          user?.role === "user" &&
          user.content === "Start two performance children" &&
          request.messages.at(-1)?.role === "user"
        ) {
          yield { type: "tool_call_start", id: "performance-spawn", name: "spawn_agents" };
          yield {
            type: "tool_call_delta",
            id: "performance-spawn",
            json: JSON.stringify({
              entries: [0, 1].map((index) => ({
                role: "builtin:explore",
                task: `Inspect performance evidence ${index}`,
                description: `Evidence ${index}`,
              })),
            }),
          };
          yield { type: "tool_call_end", id: "performance-spawn" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        } else
          yield {
            type: "text_delta",
            text:
              user?.role === "user" && user.content === "Final Main response"
                ? "Final Main response durably accepted."
                : user?.role === "user" && user.content === "Concurrent Main response"
                  ? "Main continued while children wait."
                  : "Main responsiveness ready.",
          };
      } else if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text_delta", text: "Child evidence complete." };
      } else {
        childRequests += 1;
        if (childRequests === 2) childrenStarted.resolve();
        for (let index = 0; index < 40; index++)
          yield { type: "text_delta", text: `Control evidence ${index}.\n` };
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield { type: "tool_call_start", id: "control-inspect", name: "read_file" };
        yield { type: "text_delta", text: "Checking the child arguments." };
        yield {
          type: "reasoning_delta",
          id: "provider-reasoning-0",
          text: "Confirm the evidence path.",
        };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "tool_call_delta", id: "control-inspect", json: " " };
        await release.promise;
        request.signal.throwIfAborted();
        yield {
          type: "tool_call_delta",
          id: "control-inspect",
          json: '{"path":"area-0/evidence.txt"}',
        };
        yield { type: "tool_call_end", id: "control-inspect" };
        yield { type: "usage", inputTokens: 10000, outputTokens: 100 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "usage", inputTokens: 10000, outputTokens: 100 };
      yield { type: "finish", reason: "stop" };
    },
  };
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
            readiness: { status: "available", credentialSource: "external fixture" },
          },
        ],
      };
    },
  };
  const permissions = createPermissionPolicy({ allowedEffects: ["read", "write", "delegate"] });
  const preferences = createPresentationPreferences({ environment });
  phase("seed runtime setup");
  const seedLifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    workspaceTrust,
    modelTargets,
    permissions,
    preferences,
    managedControl: await createProductionManagedControlComposition({ workspaceRoot, stateRoot }),
  });
  let seeded: Awaited<ReturnType<typeof seedLifecycle.admit>>;
  try {
    const seedStarted = performance.now();
    const seeding = seedLifecycle.admit({
      targetIdentity: identity,
      input: { text: "Seed responsiveness history" },
    });
    for (const [index, completion] of seedToolCompletions.entries()) {
      phase(`seed tool ${index}`);
      const observed = await awaitEveReceipt(
        Promise.race([
          completion.promise.then(() => "tool completed"),
          seeding.then(() => "producer ended"),
        ]),
        `Seed tool ${index} must complete into the next real provider request.`,
      );
      expect(observed).toBe("tool completed");
    }
    phase("seed settlement");
    seeded = await awaitEveReceipt(
      seeding,
      "Representative history must settle before opening its TUI.",
    );
    expect(seeded.result).toEqual({ status: "completed", answer: "Seed complete." });
    measurements.seed = [performance.now() - seedStarted];
  } finally {
    expect(await seedLifecycle.close()).toMatchObject({ status: "closed" });
  }
  const sessionId = seeded.snapshot.sessionId;
  phase("runtime setup");
  const runtime = await createProductionProjectRuntime({
    environment,
    workspaceRoot,
    stateRoot,
    workspaceTrust,
    modelTargets,
    preferences,
    permissions,
    extensionPermissions: createPermissionPolicy({ allowedEffects: [] }),
    projectLabel: "Production responsiveness",
    reservedCommandNames: [],
  });
  const presentation = await runtime.createPresentation({ sessionId });
  const terminal = new VirtualTerminal({ columns: 80, rows: 32 });
  let running: Promise<void> | undefined;
  const press = async (name: string, keys: string, expected: string, absentText?: string) => {
    phase(name);
    const offset = terminal.output().length;
    const start = performance.now();
    terminal.input(keys);
    await terminal.waitForFrameAfter(expected, offset, absentText);
    measurements[name] ??= [];
    measurements[name].push(performance.now() - start);
  };
  try {
    expect(seedAttempts).toBe(41);
    expect(presentation.getState().authoritative.continuity).toMatchObject({ status: "current" });
    expect(presentation.getState().authoritative.active?.session.id).toBe(sessionId);
    const sessions = createJsonlSessionStoreDirectory<SessionRecord>({ workspaceRoot, stateRoot });
    const store = await sessions.open(sessionId);
    const genesis = (await store?.read())?.[0];
    if (genesis?.schemaVersion !== 3 || genesis.record.type !== "session_genesis")
      throw new Error("Missing durable genesis.");
    expect(genesis.record.managedAgentTools).toBeUndefined();
    expect(genesis.record.promptContext?.toolProfile.definitions.map(({ name }) => name)).toContain(
      "spawn_agents",
    );
    const restored = await runtime.inspectSession(sessionId);
    if (restored.schemaVersion !== 3) throw new Error("Missing current production history.");
    expect(restored.promptContext?.toolProfile.digest).toBe(
      genesis.record.promptContext?.toolProfile.digest,
    );
    expect(genesis.record.skillContext?.registry.candidates).toHaveLength(88);
    expect(genesis.record.skillContext?.catalog.content?.length).toBeGreaterThan(37000);
    const controlStore = await createJsonlManagedAgentControlStore({ workspaceRoot, stateRoot });
    phase("initial historical frame");
    running = runTui({ presentation, terminal, closeRuntime: () => runtime.close() });
    await terminal.whenStarted();
    await terminal.waitForScreen("Seed complete.");
    await terminal.waitForScreen(" · idle");
    await press("permission", "Start two performance children\r", "Confirm delegation");
    expect(childRequests).toBe(0);
    expect(await controlStore.read()).toEqual([]);
    await press("admission", "\r", "@explore-2 · Explore · Running");
    await terminal.waitForScreen("Main responsiveness ready.");
    await awaitEveReceipt(
      childrenStarted.promise,
      "Both real child providers must start before observing their argument boundaries.",
    );
    const argumentsReady = Promise.withResolvers<void>();
    const observeArguments = () => {
      const state = presentation.getState();
      const threads = state.authoritative.managedControl?.threads ?? [];
      if (
        threads.length === 2 &&
        threads.every((thread) =>
          state.managedAgentActivity?.some(
            (activity) =>
              activity.agentId === thread.threadId &&
              activity.attemptId === thread.turn.attemptId &&
              activity.tool?.name === "read_file" &&
              activity.tool.status === "generating_arguments",
          ),
        )
      )
        argumentsReady.resolve();
    };
    const unsubscribeArguments = presentation.subscribe(observeArguments);
    try {
      observeArguments();
      await awaitEveReceipt(
        argumentsReady.promise,
        "Both exact child attempts must publish unfinished read_file arguments.",
      );
    } finally {
      unsubscribeArguments();
    }
    expect(childRequests).toBe(2);
    for (let index = 0; index < 5; index++) {
      await press("todos", "/todos\r", "Todos · revision 4");
      await press("todoDetail", "\r", "Todo detail · read-only");
      await press("todoBack", "\u001b[27;1;27~", "Todos · revision 4");
      await press("todoClose", "\u001b[27;1;27~", "Main responsiveness ready.", "Todos · revision");
      await press("agents", "/agents\r", "Agents workspace");
      await press("agentsClose", "\u001b[27;1;27~", "Fleet", "Agents workspace");
      await press("fleet", "\u001b[B", "● Main");
      await press("childSelect", "\u001b[B", "● @explore-1");
      await press("childOpen", "\r", "Conversation · @explore-1");
      const state = presentation.getState();
      const selected = state.authoritative.managedControl?.threads.find(
        (thread) => thread.handle === "@explore-1",
      );
      expect(
        state.managedAgentActivity?.find(
          (activity) =>
            activity.agentId === selected?.threadId &&
            activity.attemptId === selected?.turn.attemptId,
        )?.tool,
      ).toMatchObject({
        name: "read_file",
        status: "generating_arguments",
      });
      await press("childBack", "\u001b[27;1;27~", "Fleet", "Conversation ·");
      await press("fleetClose", "\u001b[27;1;27~", "Fleet", "● @explore-1");
    }
    await press(
      "mainConcurrentEnter",
      "Concurrent Main response\r",
      "Main continued while children wait.",
    );
    expect(
      presentation
        .getState()
        .authoritative.managedControl?.threads.map((thread) => thread.turn.phase),
    ).toEqual(["executing", "executing"]);
    release.resolve();
    await terminal.waitForScreen("@explore-1 · Explore · Completed");
    await terminal.waitForScreen("@explore-2 · Explore · Completed");
    await press("mainEnter", "Final Main response\r", "Final Main response durably accepted.");
    await terminal.waitForScreen(" · idle");
    phase("final durable history");
    const records = await store?.read();
    expect(
      records?.flatMap((record) =>
        record.schemaVersion === 3 && record.record.type === "logical_run_started"
          ? [record.record.userMessage]
          : [],
      ),
    ).toEqual([
      "Seed responsiveness history",
      "Start two performance children",
      "Concurrent Main response",
      "Final Main response",
    ]);
    const report = Object.fromEntries(
      Object.entries(measurements).map(([name, samples]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return [
          name,
          {
            samples,
            p50: sorted[Math.ceil(samples.length * 0.5) - 1],
            p95: sorted[Math.ceil(samples.length * 0.95) - 1],
          },
        ];
      }),
    );
    const {
      ADAM_RESPONSIVENESS_REPORT: reportPath,
      ADAM_CONTROL_RESPONSIVENESS_REPORT: controlReportPath,
    } = process.env;
    for (const path of new Set([reportPath, controlReportPath])) {
      if (path !== undefined) await writeFile(path, JSON.stringify(report, null, 2));
    }
  } finally {
    release.resolve();
    if (terminal.running()) terminal.input("\u0011");
    try {
      await running;
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
async function seedWorkspace(workspaceRoot: string): Promise<void> {
  for (let index = 0; index < 88; index++) {
    const name = `synthetic-${String(index).padStart(2, "0")}`;
    const directory = join(workspaceRoot, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${"Read project evidence for this bounded synthetic procedure. ".repeat(5)}\n---\nInspect the requested evidence.\n`,
    );
  }
  for (let index = 0; index < 3; index++) {
    const directory = join(workspaceRoot, `area-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, "AGENTS.md"), `Read area ${index} before reporting.\n`);
    await writeFile(
      join(directory, "evidence.txt"),
      `Synthetic area ${index} evidence.\n`.repeat(128),
    );
  }
}
