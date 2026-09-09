import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresentationPreferences, type ModelDriver } from "@adam-agent/agent";
import { type AgentUiSettings, defaultAgentUiSettings } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("owner-private child draft survives a cold TUI and Lifecycle rebuild separately from Main", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      calls += 1;
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: "stop" };
    },
  };
  const h = await startManagedTui(driver, { draftPersistencePolicy: "recoverable" });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "durable-draft",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Inspect evidence.",
              description: "Draft persistence",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    await h.terminal.waitForScreen("@explore-1 · Running · Explore");
    await h.openFirstAgent();
    await h.press("\r", "Cooperative");
    await h.press("Child draft survives restart.", "Child draft survives restart.");
    await h.press("\u001b", "Enter compose · Esc back");
    await h.press("\u001b", "Esc Main", "Conversation ·");
    await h.press("\u001b", "Fleet · ↓ navigate");
    await h.press("Separate Main draft.", "Separate Main draft.");
    await h.stop();
    cold = await startManagedTui(driver, {
      restore: h.storage,
      draftPersistencePolicy: "recoverable",
    });
    await cold.terminal.waitForScreen("Separate Main draft.");
    expect(cold.presentation.getState().composer.renderedText).toBe("Separate Main draft.");
    cold.terminal.input("\u0001\u000b");
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Conversation");
    await cold.press("\r", "Child draft survives restart.");
    expect(cold.conversationText()).toContain("Cooperative");
    expect(cold.presentation.getState().composer.renderedText).not.toContain("Child draft");
    expect(calls).toBe(1);
  } finally {
    await (cold ?? h).close();
  }
});

test("explicit child resources page private reasoning, exact tool records and immutable output with UTF-8 boundaries", async () => {
  const reasoning = `PRIVATE_REASONING\n${"r".repeat(16364)}界界\nREASONING_END`;
  const answer = `RESULT_START\n${"a".repeat(16369)}界界\nRESULT_END`;
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      if (++calls === 1) {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoning };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "tool_call_start", id: "resource-read", name: "read_file" };
        yield { type: "tool_call_delta", id: "resource-read", json: '{"path":"package.json"}' };
        yield { type: "tool_call_end", id: "resource-read" };
        yield { type: "usage", inputTokens: 20, outputTokens: 10, reasoningTokens: 5 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: answer };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "private-resources",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            {
              role: "builtin:explore",
              task: "Private task bytes.",
              description: "Bounded resources",
            },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing child");
    expect(JSON.stringify(h.presentation.getState())).not.toContain("PRIVATE_REASONING");
    expect(JSON.stringify(h.presentation.getState())).not.toContain("Private task bytes.");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    expect(h.conversationText()).not.toContain("PRIVATE_REASONING");
    await h.press("v", "Conversation resources");
    await h.press("\r", "Reasoning page");
    expect(h.terminal.lines().join("\n")).toContain("PRIVATE_REASONING");
    await h.press("n", "REASONING_END");
    expect(h.terminal.lines().join("\n")).not.toContain("�");
    await h.press("\u001b", "Conversation resources");
    await h.press("\u001b[B\r", "Tool page");
    expect(h.terminal.lines().join("\n")).toContain("package.json");
    await h.press("\u001b", "Conversation resources");
    await h.press("\u001b[F\r", "Artifact page");
    expect(h.terminal.lines().join("\n")).toContain("RESULT_START");
    await h.press("n", "RESULT_END");
    expect(h.terminal.lines().join("\n")).not.toContain("�");
    const artifact = thread.turn.outcome?.artifact;
    if (artifact === undefined) throw new Error("Missing output artifact");
    expect(
      await h.presentation.dispatch({
        type: "read_agent_artifact",
        sessionId: thread.parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        artifact: { ...artifact, source: "model_response", id: `sha256:${"0".repeat(64)}` },
        range: { offset: 0, maximumBytes: 16384 },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      h.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
    ).toBe("pending");
    expect(calls).toBe(2);
  } finally {
    await h.close();
  }
});

test("full Markdown renders an actual read-file prose result while assistant mode keeps it literal", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-tool-markdown-"));
  await writeFile(
    join(workspaceRoot, "fixture.md"),
    "# TOOL HEADING\n\n**literal tool text**\n\n3) first\n7) seventh\n",
  );
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        if (++calls === 1) {
          yield { type: "tool_call_start", id: "markdown-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "markdown-read", json: '{"path":"fixture.md"}' };
          yield { type: "tool_call_end", id: "markdown-read" };
        } else yield { type: "text_delta", text: "Tool read completed." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: calls === 1 ? "tool_calls" : "stop" };
      },
    },
    { workspaceRoot },
  );
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "tool-markdown",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "Read fixture.md.", description: "Tool Markdown" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    await h.press("\u001b[H", "Manual scroll");
    expect(h.conversationText()).toContain("**literal tool text**");
    await h.press("m", "m full Markdown");
    expect(h.conversationText()).toContain("literal tool text");
    expect(h.conversationText()).not.toContain("**literal tool text**");
    expect(h.conversationText()).toContain("3) first");
    expect(h.conversationText()).toContain("7) seventh");
    await h.press("\u001b", "Agents workspace");
    await h.press("s", "Viewer · full Markdown");
    await h.press("\r", "Widget · all");
    expect(h.presentation.getState().agentUiSettings?.viewerMode).toBe("full");
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Agents settings persist privately and Reset restores concrete defaults without execution changes", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "adam-agent-ui-settings-"));
  const preferences = createPresentationPreferences({
    environment: { XDG_CONFIG_HOME: configRoot },
  });
  const h = await startManagedTui(
    {
      async *stream() {
        yield { type: "finish", reason: "stop" };
      },
    },
    { preferences },
  );
  try {
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "settings-init",
      command: { type: "list_agents", parentSessionId: h.parent.sessionId },
    });
    const before = h.presentation.getState().authoritative;
    await h.press("/agents settings\r", "Agent settings");
    await h.press("\r", "Widget · all");
    await h.press("\r", "Widget · off");
    await h.press("\u001b[B\r", "Fleet · disabled");
    await h.press("\u001b[B\r", "Model/thinking · shown");
    await h.press("\u001b[B\r", "Viewer · full Markdown");
    await h.press("\u001b[B\r", "Mentions · off");
    const path = join(configRoot, "adam-agent", "ui.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      widgetMode: "off",
      fleetEnabled: false,
      showModel: true,
      viewerMode: "full",
      mentions: "off",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(h.presentation.getState().authoritative).toEqual(before);
    await h.press("\u001b", "Fleet fixture", "Agent settings");
    await h.press("/agents settings\r", "> Widget · off");
    await h.press("\u001b[F", "> Reset defaults");
    await h.press("\r", "Defaults restored");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      widgetMode: "background",
      fleetEnabled: true,
      showModel: false,
      viewerMode: "assistant",
      mentions: "direct",
    });
    expect(await preferences.load()).toMatchObject({ defaultTargetId: null, diagnostic: null });
  } finally {
    await h.close();
    await rm(configRoot, { recursive: true, force: true });
  }
});

test.each([{}, { columns: 40, rows: 12 }])(
  "cold Agents workspace resumes one selected queued turn then the exact remaining set without automatic replay %j",
  async (viewport) => {
    let stopping = false;
    let calls = 0;
    const eight = Promise.withResolvers<void>();
    const driver: ModelDriver = {
      async *stream(request) {
        calls += 1;
        if (calls === 8) eight.resolve();
        if (!stopping)
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        else yield { type: "text_delta", text: "Resumed queued evidence" };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    };
    const h = await startManagedTui(driver);
    let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
    try {
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "cold-queued",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: Array.from({ length: 11 }, (_, index) => ({
            role: "builtin:explore" as const,
            task: `Inspect item ${index}`,
            description: `Cold item ${index}`,
          })),
        },
      });
      await eight.promise;
      stopping = true;
      await h.stop();
      cold = await startManagedTui(driver, { restore: h.storage, ...viewport });
      expect(cold.terminal.lines().join("\n")).not.toContain("3 running");
      await cold.press("/agents\r", "Agents workspace");
      expect(calls).toBe(8);
      await cold.press("\u001b[F", "@explore-11");
      await cold.press("u", "@explore-11");
      expect(cold.terminal.lines().join("\n")).toContain("u again to resume 1");
      await cold.press("u", "Completed");
      expect(calls).toBe(9);
      await cold.press("U", "u again to resume 2");
      await cold.press("u", "Resumed 2");
      const restarted = cold;
      await new Promise<void>((resolve) => {
        const check = () => {
          if (
            restarted.presentation
              .getState()
              .authoritative.managedControl?.threads.filter(
                (entry) => entry.turn.label === "Completed",
              ).length === 3
          ) {
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = restarted.presentation.subscribe(check);
        check();
      });
      expect(calls).toBe(11);
      expect(
        cold.presentation
          .getState()
          .authoritative.managedControl?.threads.filter(
            (entry) => entry.turn.label === "Completed",
          ),
      ).toHaveLength(3);
    } finally {
      await (cold ?? h).close();
    }
  },
);

test("cold undelivered input remains private and can be explicitly inspected and returned to a new-turn draft", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const driver: ModelDriver = {
    async *stream() {
      if (++calls === 1) {
        started.resolve();
        await finish.promise;
      }
      yield { type: "text_delta", text: "Input evidence finished" };
      yield { type: "usage", inputTokens: 10, outputTokens: 10 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const h = await startManagedTui(driver, { draftPersistencePolicy: "recoverable" });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "cold-input",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [{ role: "builtin:explore", task: "Inspect", description: "Private receipts" }],
      },
    });
    await started.promise;
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Conversation");
    await h.press("\r", "Cooperative");
    await h.press("PRIVATE_UNDELIVERED_MESSAGE\r", "Accepted");
    const offset = h.terminal.output().length;
    finish.resolve();
    await h.terminal.waitForFrameAfter("Undelivered · settled", offset);
    await h.stop();
    cold = await startManagedTui(driver, {
      restore: h.storage,
      draftPersistencePolicy: "recoverable",
    });
    expect(JSON.stringify(cold.presentation.getState())).not.toContain(
      "PRIVATE_UNDELIVERED_MESSAGE",
    );
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Undelivered · settled");
    await cold.press("i", "Input receipts");
    await cold.press("\r", "PRIVATE_UNDELIVERED_MESSAGE");
    expect(calls).toBe(1);
    await cold.press("b", "Return input as draft");
    await cold.press("b", "Draft to @explore-1");
    expect(cold.conversationText()).not.toContain("To @explore-1");
    await cold.press("\r", "New turn");
    expect(cold.conversationText()).toContain("PRIVATE_UNDELIVERED_MESSAGE");
    await cold.press("\u001b", "Enter compose · Esc back", "To @explore-1");
    await cold.press("\u0004", "Enter compose · Esc back");
    expect(cold.conversationText()).not.toContain("Draft to @explore-1");
    expect(calls).toBe(1);
    expect(
      cold.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
    ).toBe("pending");
  } finally {
    finish.resolve();
    await (cold ?? h).close();
  }
});

test("confirmed bounded exports persist selected fields privately with a separate reasoning opt-in and no completion consumption", async () => {
  const reasoning = `PRIVATE_REASONING_EXPORT\n${"r".repeat(16356)}界界\nREASONING_END`;
  const answer = `PUBLIC_RESULT_EXPORT\n${"a".repeat(19000)}界界\nRESULT_END`;
  let calls = 0;
  const h = await startManagedTui({
    async *stream() {
      if (++calls === 1) {
        yield {
          type: "reasoning_start",
          id: "provider-reasoning-0",
          artifactType: "provider_reasoning",
        };
        yield { type: "reasoning_delta", id: "provider-reasoning-0", text: reasoning };
        yield { type: "reasoning_end", id: "provider-reasoning-0" };
        yield { type: "tool_call_start", id: "export-tool", name: "read_file" };
        yield { type: "tool_call_delta", id: "export-tool", json: '{"path":"package.json"}' };
        yield { type: "tool_call_end", id: "export-tool" };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: answer };
        yield { type: "usage", inputTokens: 10, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      }
    },
  });
  try {
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "explicit-export",
        command: {
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { role: "builtin:explore", task: "PRIVATE_TASK_EXPORT", description: "Export subject" },
          ],
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("Completed");
    await h.press("/agents\r", "Agents workspace");
    await h.press("\r", "Seen · Main pending");
    const artifactsBefore = await readdir(join(h.storage.stateRoot, "artifacts"));
    await h.press("e", "Export agent");
    await h.press("\u001b", "Seen · Main pending");
    expect((await h.store.read()).some((record) => record.event.type === "exported")).toBe(false);
    expect(await readdir(join(h.storage.stateRoot, "artifacts"))).toEqual(artifactsBefore);
    await h.press("e", "Export agent");
    await h.press("\r", "Confirm export");
    await h.press("\u001b", "Export agent");
    expect((await h.store.read()).some((record) => record.event.type === "exported")).toBe(false);
    await h.press("\r", "Confirm export");
    await h.press("\r", "Export ready");
    const first = h.presentation.getState().authoritative.managedControl?.exports?.[0];
    if (first === undefined) throw new Error("Missing first export");
    const path = join(h.storage.stateRoot, "artifacts", first.artifact.id.slice("sha256:".length));
    const firstText = await readFile(path, "utf8");
    const firstData = JSON.parse(firstText);
    expect(Object.keys(firstData.fields)).toEqual(["summary", "result"]);
    expect(firstData.fields.result.text).toContain("PUBLIC_RESULT_EXPORT");
    expect(firstData.fields.result.omittedBytes).toBeGreaterThan(0);
    expect(firstText).not.toContain("PRIVATE_REASONING_EXPORT");
    expect(firstText).not.toContain("PRIVATE_TASK_EXPORT");
    expect(firstText).not.toContain("argumentsJson");
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    await h.press("\u001b", "Seen · Main pending");
    await h.press("e", "Export agent");
    await h.press("\u001b[B\u001b[B\u001b[B\u001b[B ", "[x] Reasoning");
    await h.press("\r", "Confirm export");
    await h.press("\r", "Export ready");
    const second = h.presentation.getState().authoritative.managedControl?.exports?.[1];
    if (second === undefined) throw new Error("Missing reasoning export");
    const secondText = await readFile(
      join(h.storage.stateRoot, "artifacts", second.artifact.id.slice("sha256:".length)),
      "utf8",
    );
    const secondData = JSON.parse(secondText);
    expect(secondData.fields.reasoning.items[0].text).toContain("PRIVATE_REASONING_EXPORT");
    expect(secondData.fields.reasoning.items[0].omittedBytes).toBeGreaterThan(0);
    expect(secondText).not.toContain("�");
    await h.press("v", "Artifact page");
    expect(h.terminal.lines().join("\n")).toContain("adam.agent-export.v1");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing export identity");
    expect(
      await h.presentation.dispatch({
        type: "read_agent_artifact",
        sessionId: thread.parentSessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        artifact: { ...second.artifact, id: `sha256:${"0".repeat(64)}` },
        range: { offset: 0, maximumBytes: 16384 },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(h.presentation.getState().authoritative.managedControl?.completions[0]).toMatchObject({
      userSeen: true,
      consumption: "pending",
    });
    expect(calls).toBe(2);
    await h.press("\u001b", "Conversation resources");
    await h.press("\u001b", "Seen · Main pending");
    await h.press("e", "Export agent");
    await h.press("\u001b[B ", "[x] Conversation");
    await h.press("\u001b[B ", "[x] Tool records");
    await h.press("\r", "Confirm export");
    await h.press("\r", "Export ready");
    const third = h.presentation.getState().authoritative.managedControl?.exports?.[2];
    if (third === undefined) throw new Error("Missing selected resource export");
    const thirdText = await readFile(
      join(h.storage.stateRoot, "artifacts", third.artifact.id.slice("sha256:".length)),
      "utf8",
    );
    const thirdData = JSON.parse(thirdText);
    expect(thirdData.fields.tools.items[0].text).toContain("argumentsJson");
    expect(thirdData.fields.tools.items[0].text).toContain("package.json");
    expect(thirdData.fields.conversation.items[0].text).toContain("PUBLIC_RESULT_EXPORT");
    expect(thirdText).not.toContain("PRIVATE_REASONING_EXPORT");
    expect(thirdText).not.toContain("PRIVATE_TASK_EXPORT");
    const completion = h.presentation.getState().authoritative.managedControl?.completions[0];
    if (completion === undefined) throw new Error("Missing export receipt");
    const exportRequest = {
      type: "export_agent" as const,
      confirmed: true as const,
      sessionId: thread.parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      completion: completion.receipt,
      fields: ["summary"] as const,
    };
    expect(
      await h.presentation.dispatch({
        ...exportRequest,
        completion: { ...completion.receipt, digest: `sha256:${"0".repeat(64)}` },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      await h.presentation.dispatch({ ...exportRequest, fields: ["reasoning", "reasoning"] }),
    ).toMatchObject({ status: "rejected" });
    await h.stop();
    const cold = await startManagedTui(
      {
        stream() {
          throw new Error("Export inspection must not start a provider.");
        },
      },
      { restore: h.storage },
    );
    try {
      await cold.press("/agents\r", "Agents workspace");
      await cold.press("\r", "Seen · Main pending");
      await cold.press("v", "Conversation resources");
      await cold.press("\u001b[F\r", "Artifact page");
      expect(cold.terminal.lines().join("\n")).toContain("adam.agent-export.v1");
      expect(cold.presentation.getState().authoritative.managedControl?.exports).toHaveLength(3);
      expect(
        cold.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
      ).toBe("pending");
    } finally {
      await cold.stop();
    }
  } finally {
    await h.close();
  }
});

test.each([
  [40, 12],
  [80, 24],
  [120, 40],
])(
  "%i×%i export requires a rendered confirmation and exposes every selected field",
  async (columns, rows) => {
    const h = await startManagedTui(
      {
        async *stream() {
          yield {
            type: "reasoning_start",
            id: "provider-reasoning-0",
            artifactType: "provider_reasoning",
          };
          yield {
            type: "reasoning_delta",
            id: "provider-reasoning-0",
            text: "MIN_PRIVATE_REASONING",
          };
          yield { type: "reasoning_end", id: "provider-reasoning-0" };
          yield { type: "text_delta", text: "MIN_EXPORT" };
          yield { type: "usage", inputTokens: 10, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { columns, rows },
    );
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "rendered-export-confirm",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [{ role: "builtin:explore", task: "Inspect", description: "Export viewport" }],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await h.terminal.waitForScreen("Completed");
      await h.press("/agents\r", "Agents workspace");
      await h.press("\r", "Seen · Main pending");
      await h.press("e", "Export agent");
      await h.press("\r\r", "Confirm export");
      expect(h.presentation.getState().authoritative.managedControl?.exports).toEqual([]);
      await h.press("\u001b", "Export agent");
      await h.press("\u001b[B", "Conversation");
      await h.press(" ", "[x] Conversation");
      await h.press("\u001b[B", "Tool records");
      await h.press(" ", "[x] Tool records");
      await h.press("\u001b[F", "Reasoning");
      await h.press(" ", "[x] Reasoning");
      await h.press("\r", "Reasoning INCLUDED");
      expect(h.terminal.lines().join("\n")).toContain("Enter export");
      await h.press("\r", "Export ready");
      const exported = h.presentation.getState().authoritative.managedControl?.exports?.[0];
      if (exported === undefined) throw new Error("Missing viewport export");
      const data = JSON.parse(
        await readFile(
          join(h.storage.stateRoot, "artifacts", exported.artifact.id.slice("sha256:".length)),
          "utf8",
        ),
      );
      expect(Object.keys(data.fields)).toEqual([
        "summary",
        "conversation",
        "tools",
        "result",
        "reasoning",
      ]);
      expect(data.fields.reasoning.items[0].text).toBe("MIN_PRIVATE_REASONING");
      expect(
        h.presentation.getState().authoritative.managedControl?.completions[0]?.consumption,
      ).toBe("pending");
    } finally {
      await h.close();
    }
  },
);

test.each(["widgetMode", "viewerMode", "mentions"] as const)(
  "UI settings reject non-string %s values on load and write",
  async (field) => {
    const root = await mkdtemp(join(tmpdir(), "adam-ui-settings-invalid-"));
    const preferences = createPresentationPreferences({ environment: { XDG_CONFIG_HOME: root } });
    try {
      await preferences.setAgentUi?.(defaultAgentUiSettings);
      const path = join(root, "adam-agent", "ui.json");
      const malformed = { ...defaultAgentUiSettings, [field]: [defaultAgentUiSettings[field]] };
      await writeFile(path, JSON.stringify({ schemaVersion: 1, ...malformed }));
      await expect(preferences.loadAgentUi?.()).rejects.toThrow("Agent UI settings are invalid");
      await expect(
        preferences.setAgentUi?.(malformed as unknown as AgentUiSettings),
      ).rejects.toThrow("Agent UI settings are invalid");
      expect(JSON.parse(await readFile(path, "utf8"))[field]).toEqual(malformed[field]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
