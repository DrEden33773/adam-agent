import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionPolicy } from "@adam-agent/agent";
import { afterEach, expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";
import { removeTuiFixtureRoot as rm, waitForPath } from "./tui-filesystem.test-support.js";
import { cleanupActiveTuiFixtures, startTuiFixture } from "./tui-fixture.test-support.js";

afterEach(cleanupActiveTuiFixtures);

test.each([false, true])(
  "representative history keeps Main and two background children reachable through fresh frames: arguments %s",
  async (argumentsBarrier) => {
    const root = await mkdtemp(join(tmpdir(), "adam-responsiveness-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    const controlRoot = join(root, "control");
    await mkdir(workspaceRoot);
    await mkdir(controlRoot);
    await seedWorkspace(workspaceRoot);
    const measurements: Record<string, number[]> = {};
    try {
      const fixture = startTuiFixture({
        scenario: argumentsBarrier ? "responsiveness-arguments" : "responsiveness",
        workspaceRoot,
        stateRoot,
        controlRoot,
      });
      await fixture.waitForScreen("Main responsiveness ready.");
      const measure = async (name: string, keys: string, frame: string, absentText?: string) => {
        const offset = fixture.output().length;
        const start = performance.now();
        fixture.write(keys);
        await fixture.waitForCompleteFrameAfter(frame, offset, absentText);
        measurements[name] ??= [];
        measurements[name].push(performance.now() - start);
      };
      await measure(
        "startChildren",
        "Start two performance children\r",
        "Agents 2 active/0 terminal",
      );
      await Promise.all(
        [1, 2].map((index) => waitForPath(join(controlRoot, `performance-child-${index}`))),
      );
      for (let index = 0; index < (argumentsBarrier ? 1 : 5); index++) {
        await measure("todos", "/todos\r", "Todos · revision 4");
        await measure("todoDetail", "\r", "Todo detail · read-only");
        await measure("todoBack", "\u001b[27;1;27~", "Todos · revision 4");
        await measure(
          "todoClose",
          "\u001b[27;1;27~",
          "Main responsiveness ready.",
          "Todos · revision",
        );
        await measure("agents", "/agents\r", "Agents · 2 active · 0 terminal");
        await measure(
          "childOpen",
          "\r",
          argumentsBarrier
            ? "Live tool · read_file · generating arguments"
            : "research.v2 · background · running",
        );
        await measure("childBack", "\u001b[27;1;27~", "Agents · 2 active · 0 terminal");
        await measure(
          "agentsClose",
          "\u001b[27;1;27~",
          "Main responsiveness ready.",
          "Agents · 2 active",
        );
      }
      await writeFile(join(controlRoot, "release-performance-children"), "release\n");
      await fixture.waitForScreen("Agents 0 active/2 terminal");
      await measure("mainEnter", "Final Main response\r", "Final Main response durably accepted.");
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
      const { ADAM_RESPONSIVENESS_REPORT: reportPath } = process.env;
      if (reportPath !== undefined && !argumentsBarrier)
        await writeFile(reportPath, JSON.stringify(report, null, 2));
      fixture.write("\u0011");
      await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    } finally {
      await writeFile(join(controlRoot, "release-performance-children"), "release\n").catch(
        () => {},
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test("candidate Control remains reachable with representative history and two live children", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-control-responsiveness-"));
  await seedWorkspace(root);
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let seedAttempt = 0;
  let children = 0;
  const h = await startManagedTui(
    {
      async *stream(request) {
        const user = request.messages.findLast((message) => message.role === "user");
        if (user?.role === "user" && user.content === "Seed responsiveness history") {
          const index = seedAttempt++;
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
        } else {
          if (request.messages.at(-1)?.role === "tool") {
            yield { type: "text_delta", text: "Control evidence complete." };
            yield { type: "usage", inputTokens: 10000, outputTokens: 100 };
            yield { type: "finish", reason: "stop" };
            return;
          }

          for (let index = 0; index < 40; index++)
            yield { type: "text_delta", text: `Control evidence ${index}.\n` };
          yield {
            type: "reasoning_start",
            id: "provider-reasoning-0",
            artifactType: "provider_reasoning",
          };
          yield { type: "tool_call_start", id: "control-inspect", name: "read_file" };
          yield { type: "text_delta", text: "Checking the Control arguments." };
          yield {
            type: "reasoning_delta",
            id: "provider-reasoning-0",
            text: "Confirm the evidence path.",
          };
          yield { type: "reasoning_end", id: "provider-reasoning-0" };
          yield { type: "tool_call_delta", id: "control-inspect", json: " " };
          children += 1;
          if (children === 2) started.resolve();
          await release.promise;
          yield {
            type: "tool_call_delta",
            id: "control-inspect",
            json: JSON.stringify({ path: "area-0/evidence.txt" }),
          };
          yield { type: "tool_call_end", id: "control-inspect" };
          yield { type: "usage", inputTokens: 10000, outputTokens: 100 };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "usage", inputTokens: 10000, outputTokens: 100 };
        yield { type: "finish", reason: "stop" };
      },
    },
    {
      workspaceRoot: root,
      contextProfile: {
        version: 1,
        contextWindowTokens: 1_000_000,
        maximumOutputTokens: 32_768,
        compactAtTokens: 800_000,
        postCompactTargetTokens: 200_000,
        retainedTargetTokens: 20_000,
        estimatorVersion: 1,
      },
      initialPrompt: "Seed responsiveness history",
      durableSessions: true,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "write", "delegate"] }),
    },
  );
  try {
    expect(seedAttempt).toBe(41);
    const genesis = (await (await h.sessions.open(h.parent.sessionId))?.read())?.[0];
    if (genesis?.schemaVersion !== 3 || genesis.record.type !== "session_genesis")
      throw new Error("Missing representative genesis.");
    expect(genesis.record.skillContext?.registry.candidates).toHaveLength(88);
    expect(genesis.record.skillContext?.catalog.content?.length).toBeGreaterThan(37000);

    const start = performance.now();
    await expect(
      h.presentation.dispatch({
        type: "managed_control",
        commandId: "performance-admit",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [0, 1].map((index) => ({
            role: "builtin:explore",
            task: `Inspect control evidence ${index}`,
            description: `Evidence ${index}`,
          })),
        },
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-2 · Explore · Running");
    const admissionMilliseconds = performance.now() - start;
    const samples: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      await h.openFirstAgent();
      await h.terminal.waitForScreen("Generating arguments · read_file");
      expect(h.presentation.getState().managedAgentActivity?.[0]?.tool).toMatchObject({
        name: "read_file",
        status: "generating_arguments",
      });
      await h.press("\u001b[27;1;27~", "Fleet", "Conversation ·");
      await h.press("\u001b[27;1;27~", "Fleet", "● @explore-1");
      samples.push(performance.now() - start);
    }
    const { ADAM_CONTROL_RESPONSIVENESS_REPORT: reportPath } = process.env;
    if (reportPath !== undefined)
      await writeFile(reportPath, JSON.stringify({ admissionMilliseconds, samples }, null, 2));
    release.resolve();
    await h.terminal.waitForScreen("@explore-1 · Explore · Completed");
    await h.terminal.waitForScreen("@explore-2 · Explore · Completed");
  } finally {
    release.resolve();
    try {
      await h.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
