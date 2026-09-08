import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDriver, ModelRequest } from "@adam-agent/agent";
import { sessionManagedControl } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

test("direct delegation reads only its explicitly attached immutable resource", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-attachment-"));
  const path = join(workspaceRoot, "evidence.txt");
  await writeFile(path, "IMMUTABLE SELECTED EVIDENCE\n");
  const requests: ModelRequest[] = [];
  const driver: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      if (requests.length % 2 === 1) {
        const text = JSON.stringify(request.messages);
        const ids = [
          ...new Set([...text.matchAll(/[a-f0-9-]{36}:input:\d+/gu)].map((match) => match[0])),
        ];
        const currentRun = ids.at(-1)?.split(":input:")[0];
        if (currentRun === undefined)
          throw new Error("Selected immutable resource descriptor missing.");
        for (const occurrenceId of ids.filter((id) => id.startsWith(currentRun))) {
          const id = `read-${occurrenceId}`;
          yield { type: "tool_call_start", id, name: "read_input_resource" };
          yield { type: "tool_call_delta", id, json: JSON.stringify({ occurrenceId }) };
          yield { type: "tool_call_end", id };
        }
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield {
          type: "text_delta",
          text:
            requests.length < 4
              ? "Attached evidence inspected."
              : requests.length < 6
                ? "Added attachment inspected."
                : "Both attachments retained.",
        };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const h = await startManagedTui(driver, { workspaceRoot, blankDraft: true });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect this attachment. ", "Inspect this attachment.");
    expect(await h.presentation.dispatch({ type: "stage_input_resource", path })).toMatchObject({
      status: "admitted",
    });
    await writeFile(path, "LATER LIVE FILE CONTENT\n");
    await h.press("\r", "Delegation");
    expect(requests).toHaveLength(0);
    await h.press("\r", "Completed");
    expect(JSON.stringify(requests[1]?.messages)).toContain("IMMUTABLE SELECTED EVIDENCE");
    expect(JSON.stringify(requests)).not.toContain("LATER LIVE FILE CONTENT");
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      frozen: { inputResources: [{ artifact: { id: expect.stringMatching(/^sha256:/u) } }] },
    });
    expect(h.presentation.getState().composer.renderedText).toBe("");
    const addedPath = join(workspaceRoot, "added.txt");
    await writeFile(addedPath, "EXPLICIT LATER ATTACHMENT\n");
    await h.press("@explore-1", "[Agent] @explore-1 · Inspect this attachment.");
    await h.press("\t", "@explore-1");
    await h.press(
      " Read the explicitly added attachment. ",
      "Read the explicitly added attachment.",
    );
    expect(
      await h.presentation.dispatch({ type: "stage_input_resource", path: addedPath }),
    ).toMatchObject({ status: "admitted" });
    await h.press("\r", "Delegation");
    await h.press("\r", "Input accepted for @explore-1");
    await h.terminal.waitForScreen("○ @explore-1 · Explore · Completed");
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]?.messages)).toContain("EXPLICIT LATER ATTACHMENT");
    const sessionId = h.presentation.getState().authoritative.active?.session.id;
    if (sessionId === undefined) throw new Error("Direct parent Session missing.");
    await h.stop();
    cold = await startManagedTui(driver, { workspaceRoot, restore: { ...h.storage, sessionId } });
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("\r", "Added attachment inspected.");
    await cold.press("\r", "New turn");
    await cold.press("Read both immutable attachments again.\r", "Both attachments retained.");
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(requests[5]?.messages)).toContain("IMMUTABLE SELECTED EVIDENCE");
    expect(JSON.stringify(requests[5]?.messages)).toContain("EXPLICIT LATER ATTACHMENT");
    expect(JSON.stringify(requests[5]?.messages)).not.toContain("LATER LIVE FILE CONTENT");
    const latest = (await cold.store.read()).findLast((record) => record.event.type === "admitted");
    const records =
      latest === undefined ? [] : await (await cold.children.open(latest.childSessionId))?.read();
    expect(
      records?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "input_resource_read_committed",
      ),
    ).toHaveLength(2);
  } finally {
    await (cold ?? h).close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("model delegation links only an exact explicitly selected parent attachment", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-selected-attachment-"));
  const selectedPath = join(workspaceRoot, "selected.txt");
  const privatePath = join(workspaceRoot, "unselected.txt");
  await writeFile(selectedPath, "SELECTED IMMUTABLE BODY\n");
  await writeFile(privatePath, "UNSELECTED PRIVATE BODY\n");
  let mainCalls = 0;
  const children: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        const main = request.tools.some((tool) => tool.name === "spawn_agents");
        if (main) mainCalls += 1;
        else children.push(request);
        const text = JSON.stringify(request.messages);
        const occurrenceId = text.match(/[a-f0-9-]{36}:input:1/u)?.[0];
        if (main && mainCalls === 1) {
          if (occurrenceId === undefined) throw new Error("Missing parent attachment descriptor.");
          yield { type: "tool_call_start", id: "select-artifact", name: "spawn_agents" };
          yield {
            type: "tool_call_delta",
            id: "select-artifact",
            json: JSON.stringify({
              entries: [
                {
                  role: "builtin:explore",
                  description: "Selected artifact",
                  task: "Inspect only the selected artifact.",
                  context: { mode: "task" },
                  artifacts: [occurrenceId],
                },
              ],
            }),
          };
          yield { type: "tool_call_end", id: "select-artifact" };
        } else if (!main && children.length === 1) {
          if (occurrenceId === undefined) throw new Error("Missing child attachment descriptor.");
          yield { type: "tool_call_start", id: "read-selected", name: "read_input_resource" };
          yield {
            type: "tool_call_delta",
            id: "read-selected",
            json: JSON.stringify({ occurrenceId }),
          };
          yield { type: "tool_call_end", id: "read-selected" };
        } else
          yield {
            type: "text_delta",
            text: main ? "Parent delegated one artifact." : "Selected artifact inspected.",
          };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield {
          type: "finish",
          reason:
            (main && mainCalls === 1) || (!main && children.length === 1) ? "tool_calls" : "stop",
        };
      },
    },
    { workspaceRoot },
  );
  try {
    for (const path of [selectedPath, privatePath])
      expect(await h.presentation.dispatch({ type: "stage_input_resource", path })).toMatchObject({
        status: "admitted",
      });
    await h.press(" Delegate one selected artifact.\r", "Delegation");
    await h.press("\r", "Parent delegated one artifact.");
    await h.terminal.waitForScreen("○ @explore-1 · Explore · Completed");
    expect(children).toHaveLength(2);
    expect(JSON.stringify(children)).toContain("SELECTED IMMUTABLE BODY");
    expect(JSON.stringify(children)).not.toContain("unselected.txt");
    expect(JSON.stringify(children)).not.toContain("UNSELECTED PRIVATE BODY");
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      frozen: {
        inputResources: [{ displayName: "selected.txt" }],
        artifactSources: [
          {
            parentSessionId: h.parent.sessionId,
            sequence: expect.any(Number),
            digest: expect.stringMatching(/^sha256:/u),
          },
        ],
      },
    });
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("direct role and exact-thread messages preserve folded pasted evidence", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Pasted evidence inspected." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    for (const [mention, marker] of [
      ["@Explore", "INITIAL PASTED EVIDENCE"],
      ["@explore-1", "FOLLOWUP PASTED EVIDENCE"],
    ] as const) {
      await h.press(
        mention,
        mention === "@Explore" ? "New agent · Explore" : "[Agent] @explore-1 · Inspect these logs.",
      );
      await h.press("\t", mention);
      await h.press(" Inspect these logs.\n", "Inspect these logs.");
      expect(
        await h.presentation.dispatch({
          type: "stage_pasted_text",
          text: `${marker}\n`.repeat(50),
        }),
      ).toMatchObject({ status: "admitted" });
      expect(
        h.presentation
          .getState()
          .composer.elements.some((element) => element.type === "pasted_text"),
      ).toBe(true);
      await h.press("\r", "Delegation");
      await h.press("\r", mention === "@Explore" ? "Completed" : "Input accepted for @explore-1");
      await h.terminal.waitForScreen("○ @explore-1 · Explore · Completed");
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(marker);
      expect(h.presentation.getState().composer.renderedText).toBe("");
    }
    expect(requests).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("requested Skill preactivation is atomic and preserves the rest of the child catalog", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-preactivate-"));
  for (const name of ["requested", "independent"]) {
    const directory = join(workspaceRoot, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Inspect ${name} evidence.\n---\n${name.toUpperCase()} SKILL BODY\n`,
    );
  }
  const requests: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call_start", id: "independent", name: "activate_skill" };
          yield {
            type: "tool_call_delta",
            id: "independent",
            json: '{"qualifiedId":"skill:v1:project:.:independent"}',
          };
          yield { type: "tool_call_end", id: "independent" };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "Both Skills independently available." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    { workspaceRoot },
  );
  try {
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    const entry = {
      role: "builtin:explore",
      task: "Inspect both Skills.",
      description: "Skill preactivation",
      skills: ["skill:v1:project:.:requested"],
    };
    expect(
      await control?.dispatch({
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [entry, { ...entry, skills: ["skill:v1:project:.:missing"] }],
      }),
    ).toMatchObject({ status: "rejected" });
    expect(await h.store.read()).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(
      await control?.dispatch({
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [entry],
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("@explore-1 · Explore · Completed");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("REQUESTED SKILL BODY");
    expect(JSON.stringify(requests[0]?.messages)).toContain("skill:v1:project:.:independent");
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("INDEPENDENT SKILL BODY");
    expect(JSON.stringify(requests[1]?.messages)).toContain("INDEPENDENT SKILL BODY");
    const parent = await h.lifecycle.inspect({ sessionId: h.parent.sessionId });
    expect(parent.schemaVersion === 3 ? parent.skillContext?.active : undefined).toEqual([]);
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the direct delegation overlay shares an explicitly selected older message", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Parent or child evidence recorded." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("EXPLICIT OLDER CONTEXT\r", "Parent or child evidence recorded.");
    await h.terminal.waitForScreen("provider reported · idle");
    await h.press("UNSELECTED NEWER CONTEXT\r", "Parent or child evidence recorded.");
    await h.terminal.waitForScreen("provider reported · idle");
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect this direct task.", "Inspect this direct task.");
    await h.press("\r", "Delegation");
    await h.press("\x1b[B\x1b[B\r", "Context sharing");
    await h.press("\x1b[B\x1b[B\r", "Select parent messages");
    await h.press("\x1b[B\x1b[B\x1b[B\x1b[B\r", "[x] user");
    await h.press("\x1b[A\x1b[A\x1b[A\x1b[A\r", "Context updated.");
    expect(requests).toHaveLength(2);
    await h.press("\r", "@explore-1 · Explore · Completed");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages)).toContain("EXPLICIT OLDER CONTEXT");
    expect(JSON.stringify(requests[2]?.messages)).toContain("Inspect this direct task.");
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("UNSELECTED NEWER CONTEXT");
    expect(
      (await h.store.read()).find((record) => record.event.type === "admitted")?.event,
    ).toMatchObject({
      context: {
        mode: "selected_messages",
        messages: [{ sequence: expect.any(Number), digest: expect.stringMatching(/^sha256:/u) }],
      },
      envelope: { context: "selected_messages" },
    });
  } finally {
    await h.close();
  }
});

test("delegation shares only the selected initial context and does not absorb later Main messages", async () => {
  const requests: ModelRequest[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await startManagedTui({
    async *stream(request) {
      const child = JSON.stringify(request.messages).includes("on the exact delegated task");
      if (child) {
        requests.push(request);
        if (requests.length === 3) started.resolve();
        await release.promise;
      }
      yield {
        type: "text_delta",
        text: child ? "Context evidence inspected." : "Main context recorded.",
      };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("OLDER SELECTED USER MESSAGE\r", "Main context recorded.");
    await h.terminal.waitForScreen("provider reported · idle");
    const parent = await h.sessions.open(h.parent.sessionId);
    const source = (await parent?.read())?.find(
      (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
    );
    if (source === undefined) throw new Error("Missing durable source message.");
    const link = {
      sequence: source.sequence,
      digest:
        `sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}` as const,
    };
    await h.press("CURRENT PARENT REQUEST\r", "Main context recorded.");
    await h.terminal.waitForScreen("provider reported · idle");
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    const entries = [
      {
        role: "builtin:explore",
        task: "Inspect TASK ONLY.",
        description: "Task only",
        context: { mode: "task" },
      },
      {
        role: "builtin:explore",
        task: "Inspect CURRENT.",
        description: "Current",
        context: { mode: "current_request" },
      },
      {
        role: "builtin:explore",
        task: "Inspect SELECTED.",
        description: "Selected",
        context: { mode: "selected_messages", messages: [link] },
      },
    ] as const;
    expect(
      await control?.dispatch({
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries,
      }),
    ).toMatchObject({ status: "admitted" });
    await started.promise;
    const texts = requests.map((request) => JSON.stringify(request.messages));
    expect(texts.find((text) => text.includes("Inspect TASK ONLY."))).not.toMatch(
      /OLDER SELECTED|CURRENT PARENT/,
    );
    expect(texts.find((text) => text.includes("Inspect CURRENT."))).toContain(
      "CURRENT PARENT REQUEST",
    );
    expect(texts.find((text) => text.includes("Inspect CURRENT."))).not.toContain("OLDER SELECTED");
    expect(texts.find((text) => text.includes("Inspect SELECTED."))).toContain(
      "OLDER SELECTED USER MESSAGE",
    );
    expect(texts.find((text) => text.includes("Inspect SELECTED."))).not.toContain(
      "CURRENT PARENT REQUEST",
    );
    await h.press("LATER MAIN MESSAGE MUST STAY IN MAIN\r", "Main context recorded.");
    await h.terminal.waitForScreen("provider reported · idle");
    release.resolve();
    await h.terminal.waitForScreen("@explore-3 · Explore · Completed");
    expect(requests.map((request) => JSON.stringify(request.messages))).toEqual(texts);
    expect(texts.join("\n")).not.toContain("LATER MAIN MESSAGE");
    const admissions = (await h.store.read()).filter((record) => record.event.type === "admitted");
    expect(admissions).toHaveLength(3);
    expect(admissions[2]?.event).toMatchObject({
      context: { mode: "selected_messages", messages: [link] },
    });
    if (control === undefined) throw new Error("Missing managed Control.");
    await (async () => {
      for await (const frame of control.observe({
        parentSessionId: h.parent.sessionId,
        signal: AbortSignal.timeout(terminalObservationTimeoutMilliseconds),
      })) {
        if (
          admissions.every((admission) =>
            frame.snapshot.completions.some(
              (completion) =>
                completion.threadId === admission.threadId &&
                completion.turnId === admission.turnId,
            ),
          )
        )
          return;
      }
      throw new Error("Missing exact completion receipts for delegated context checks.");
    })();
    const before = (await h.store.read()).length;
    const forged = {
      ...entries[2],
      role: "builtin:explore",
      task: "Forged context",
      description: "Forged",
      context: {
        mode: "selected_messages" as const,
        messages: [{ ...link, digest: `sha256:${"0".repeat(64)}` as const }],
      },
    };
    expect(
      await control?.dispatch({
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [forged],
      }),
    ).toMatchObject({ status: "rejected" });
    expect((await h.store.read()).length).toBe(before);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("a lifetime alias restores the exact thread and cannot be rebound after closure", async () => {
  let calls = 0;
  const driver = {
    async *stream() {
      calls += 1;
      yield { type: "text_delta" as const, text: "Alias evidence inspected." };
      yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const h = await startManagedTui(driver, { draftPersistencePolicy: "recoverable" });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    if (control === undefined) throw new Error("Missing control.");
    const entry = {
      role: "builtin:explore",
      task: "Inspect aliases.",
      description: "Alias evidence",
      alias: "证据",
    };
    expect(
      await control.dispatch({
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [entry],
      }),
    ).toMatchObject({ status: "admitted" });
    await h.terminal.waitForScreen("@explore-1 · Explore · Completed");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing thread.");
    await h.press("@证据", "[Agent] @explore-1 · Alias evidence");
    await h.press("\t", "@证");
    await h.press(" Continue explicitly.", "Continue explicitly.");
    await h.stop();
    cold = await startManagedTui(driver, {
      restore: h.storage,
      draftPersistencePolicy: "recoverable",
    });
    await cold.terminal.waitForScreen("Continue explicitly.");
    expect(cold.presentation.getState().composer.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          literal: "@证据",
          threadId: thread.threadId,
          handle: "@explore-1",
        }),
      ]),
    );
    await cold.press("\r", "Delegation");
    await cold.press("\r", "Input accepted for @explore-1");
    await cold.terminal.waitForScreen("@explore-1 · Explore · Completed");
    const resumedControl = await cold.lifecycle[sessionManagedControl](h.parent.sessionId);
    if (resumedControl === undefined) throw new Error("Missing restored control.");
    const current = (await resumedControl.inspect({ parentSessionId: h.parent.sessionId }))
      .threads[0];
    if (current === undefined) throw new Error("Missing restored thread.");
    expect(current).toMatchObject({
      threadId: thread.threadId,
      alias: "证据",
      handle: "@explore-1",
    });
    expect(
      await resumedControl.dispatch({
        type: "close_thread",
        parentSessionId: h.parent.sessionId,
        threadId: current.threadId,
        expectedTurnId: current.turn.turnId,
      }),
    ).toMatchObject({ status: "closed" });
    const before = (await cold.store.read()).length;
    for (const alias of ["证据", "explore-1", "main"]) {
      expect(
        await resumedControl.dispatch({
          type: "spawn_agents",
          parentSessionId: h.parent.sessionId,
          entries: [
            { ...entry, alias },
            { ...entry, alias: "fresh" },
          ],
        }),
      ).toMatchObject({ status: "rejected" });
    }
    expect((await cold.store.read()).length).toBe(before);
    expect(calls).toBe(2);
  } finally {
    if (cold !== undefined) await cold.close();
    await h.close();
  }
});

test.each(["cooperative", "interrupt"] as const)(
  "a selected running handle explicitly delivers %s input at a safe boundary",
  async (mode) => {
    const release = Promise.withResolvers<void>();
    const requests: ModelRequest[] = [];
    const h = await startManagedTui({
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", text: "Inspecting before the boundary." };
          await release.promise;
          yield { type: "tool_call_start", id: "direct-read", name: "read_file" };
          yield { type: "tool_call_delta", id: "direct-read", json: '{"path":"package.json"}' };
          yield { type: "tool_call_end", id: "direct-read" };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "Direct input delivered at the boundary." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        }
      },
    });
    try {
      await h.press("@Explore", "New agent · Explore");
      await h.press("\t", "@Explore");
      await h.press(" Inspect evidence.", "Inspect evidence.");
      await h.press("\r", "Delegation");
      await h.press("\r", "@explore-1 · Explore · Running");
      await h.press("@explore-1", "[Agent] @explore-1 · Inspect evidence.");
      await h.press("\t", "@explore-1");
      await h.press(" Use this explicit later context.", "Use this explicit later context.");
      await h.press("\r", "Send to @explore-1");
      if (mode === "interrupt") await h.press("\x1b[B", "Interrupt after current effect");
      await h.press("\r", "Input accepted for @explore-1");
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.messages)).not.toContain(
        "Use this explicit later context.",
      );
      const accepted = (await h.store.read()).find(
        (record) => record.event.type === "input_accepted",
      );
      expect(accepted?.event).toMatchObject({ mode, text: "Use this explicit later context." });
      expect(h.presentation.getState().composer.renderedText).toBe("");
      await h.openFirstAgent();
      release.resolve();
      await h.terminal.waitForScreen("Direct input delivered at the boundary.");
      expect(JSON.stringify(requests[1]?.messages)).toContain("Use this explicit later context.");
      expect(
        h.presentation.getState().authoritative.managedControl?.threads[0]?.inputs,
      ).toMatchObject([{ status: "delivered" }]);
      expect(requests).toHaveLength(2);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

test("a direct handle confirmation rejects a changed turn and retains the draft", async () => {
  let calls = 0;
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const h = await startManagedTui({
    async *stream() {
      calls += 1;
      if (calls > 1) {
        started.resolve();
        await release.promise;
      }
      yield { type: "text_delta", text: "Turn evidence inspected." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect evidence.", "Inspect evidence.");
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (thread === undefined) throw new Error("Missing first turn.");
    await h.press("@explore-1", "[Agent] @explore-1 · Inspect evidence.");
    await h.press("\t", "@explore-1");
    await h.press(" Send only to the reviewed turn.", "Send only to the reviewed turn.");
    await h.press("\r", "Delegation");
    const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
    expect(
      await control?.dispatch({
        type: "next_turn",
        parentSessionId: h.parent.sessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
        task: "Another explicit continuation.",
      }),
    ).toMatchObject({ status: "accepted" });
    await started.promise;
    await h.press("\r", "The exact turn or input action changed.");
    expect(h.presentation.getState().composer.renderedText).toBe(
      "@explore-1 Send only to the reviewed turn.",
    );
    const admissions = (await h.store.read()).filter((record) => record.event.type === "admitted");
    expect(admissions).toHaveLength(2);
    expect(admissions.at(-1)?.event).toMatchObject({ task: "Another explicit continuation." });
    expect((await h.store.read()).some((record) => record.event.type === "input_accepted")).toBe(
      false,
    );
  } finally {
    release.resolve();
    await h.close();
  }
});

test("a selected main atom routes the following task to the existing Main Session", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Main received the selected task." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("@main", "> [Agent] @main");
    await h.press("\t", "@main");
    await h.press(" Inspect the parent request.", "Inspect the parent request.");
    await h.press("\r", "Main received the selected task.");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Inspect the parent request.");
    expect(h.presentation.getState().authoritative.active?.session.id).toBe(h.parent.sessionId);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("a selected exact handle starts a confirmed new turn in that thread", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield {
        type: "text_delta",
        text: requests.length === 1 ? "Initial evidence inspected." : "Exact handle continued.",
      };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect evidence.", "Inspect evidence.");
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    if (first === undefined) throw new Error("Missing original thread.");
    await h.press("@explore-1", "[Agent] @explore-1 · Inspect evidence.");
    await h.press("\t", "@explore-1");
    await h.press(" Continue only this thread.", "Continue only this thread.");
    await h.press("\r", "Delegation");
    expect(requests).toHaveLength(1);
    await h.press("\r", "Input accepted for @explore-1");
    await h.terminal.waitForScreen("○ @explore-1 · Explore · Completed");
    await h.openFirstAgent();
    await h.terminal.waitForScreen("Exact handle continued.");
    const threads = h.presentation.getState().authoritative.managedControl?.threads;
    expect(threads).toHaveLength(1);
    expect(threads?.[0]?.threadId).toBe(first.threadId);
    expect(threads?.[0]?.turn.turnId).not.toBe(first.turn.turnId);
    const records = await h.store.read();
    expect(records.filter((record) => record.event.type === "admitted")).toHaveLength(2);
    expect(records.findLast((record) => record.event.type === "admitted")?.event).toMatchObject({
      task: "Continue only this thread.",
      envelope: { origin: { kind: "direct_request" } },
    });
    expect(requests).toHaveLength(2);
    expect(h.presentation.getState().composer.renderedText).toBe("");
  } finally {
    await h.close();
  }
});

test.each(["default", "plan"] as const)(
  "a blank %s draft confirms an independent control request without a Main provider turn",
  async (mode) => {
    const requests: ModelRequest[] = [];
    const h = await startManagedTui(
      {
        async *stream(request) {
          requests.push(request);
          yield { type: "text_delta", text: "Blank draft evidence inspected." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { blankDraft: true, thinking: true, draftPersistencePolicy: "recoverable" },
    );
    let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
    try {
      const before = await h.sessions.listSessionIds();
      await h.presentation.dispatch({ type: "set_draft_mode", mode });
      expect(h.presentation.getState().authoritative.active).toBeNull();
      await h.press("/thinking off\r", "Thinking Off selected for the next prompt.");
      await h.press("@Explore", "New agent · Explore");
      await h.press("\t", "@Explore");
      await h.press(" Inspect this direct request.", "Inspect this direct request.");
      await h.press("\r", "Delegation");
      expect(await h.sessions.listSessionIds()).toEqual(before);
      expect(requests).toHaveLength(0);
      const revision = h.presentation.getState().composer.draftRevision;
      const preview = await h.presentation.dispatch({
        type: "direct_delegation",
        draftRevision: revision,
      });
      if (preview.status !== "admitted" || preview.delegation === undefined)
        throw new Error("Missing delegation preview.");
      const forged = await h.presentation.dispatch({
        type: "direct_delegation",
        draftRevision: revision,
        confirmedEnvelope: { ...preview.delegation.envelope, digest: `sha256:${"0".repeat(64)}` },
      });
      expect(forged.status).toBe("rejected");
      expect(await h.sessions.listSessionIds()).toEqual(before);
      expect(
        await h.presentation.dispatch({
          type: "direct_delegation",
          draftRevision: revision,
          confirmedEnvelope: preview.delegation.envelope,
          thinkingSelection: {
            requestedLevelId: "off",
            capability: { id: "stale-capability", version: 1, digest: `sha256:${"0".repeat(64)}` },
          },
        }),
      ).toMatchObject({ status: "rejected" });
      expect(await h.sessions.listSessionIds()).toEqual(before);
      expect(h.presentation.getState().authoritative.active).toBeNull();
      expect(requests).toHaveLength(0);
      await h.press("\x1b", "Inspect this direct request.");
      expect(await h.sessions.listSessionIds()).toEqual(before);
      await h.press("\r", "Delegation");
      await h.press("\r", "Completed");
      const active = h.presentation.getState().authoritative.active;
      expect(active?.session.id).toBeDefined();
      expect(active?.session.id).not.toBe(h.parent.sessionId);
      expect(active?.plan?.state).toBe(mode === "plan" ? "exploring" : undefined);
      expect(await h.sessions.listSessionIds()).toHaveLength(before.length + 1);
      const records = await (await h.sessions.open(active?.session.id ?? ""))?.read();
      expect(
        records?.some(
          (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
        ),
      ).toBe(false);
      const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
      expect(admission?.parentSessionId).toBe(active?.session.id);
      expect(admission?.event).toMatchObject({
        type: "admitted",
        envelope: { origin: { kind: "direct_request", id: expect.any(String) } },
        frozen: {
          parentRequest: "Inspect this direct request.",
          thinkingPolicy: { effectiveLevelId: "off" },
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.thinkingPolicy?.effectiveLevelId).toBe("off");
      expect(h.presentation.getState().composer.renderedText).toBe("");
      await h.stop();
      cold = await startManagedTui(
        {
          stream() {
            throw new Error("No provider expected while reopening the draft.");
          },
        },
        { restore: h.storage, blankDraft: true, draftPersistencePolicy: "recoverable" },
      );
      expect(cold.presentation.getState().composer.renderedText).toBe("");
    } finally {
      if (cold !== undefined) await cold.close();
      await h.close();
    }
  },
);

test("manual and pasted Unicode mentions remain character-editable text", async () => {
  const h = await startManagedTui({
    stream() {
      throw new Error("No provider expected.");
    },
  });
  try {
    await h.press("mail@example.com @探索🧭 ", "mail@example.com");
    expect(h.presentation.getState().composer.elements).toEqual([
      expect.objectContaining({ type: "text", text: "mail@example.com @探索🧭 " }),
    ]);
    await h.press("\x7f", "mail@example.com");
    await h.press("\x7f", "mail@example.com");
    expect(h.presentation.getState().composer.renderedText).toBe("mail@example.com @探索");
    await h.press("\x1b[200~ @Explore @main \x1b[201~", "@main");
    expect(
      h.presentation.getState().composer.elements.every((element) => element.type === "text"),
    ).toBe(true);
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test.each(["@", "$"])(
  "an unselected %s Unicode token supports Backspace, Left and Home as text",
  async (prefix) => {
    const h = await startManagedTui({
      stream() {
        throw new Error("No provider expected.");
      },
    });
    try {
      await h.press(`Inspect ${prefix}探索🧭`, "Inspect");
      await h.press("\x7f", "Inspect");
      expect(h.presentation.getState().composer.renderedText).toBe(`Inspect ${prefix}探索`);
      await h.press("\x1b[D", "Inspect");
      await h.press("X", "Inspect");
      expect(h.presentation.getState().composer.renderedText).toBe(`Inspect ${prefix}探X索`);
      await h.press("\x1b[H", "Inspect");
      await h.press("Y", "YInspect");
      expect(h.presentation.getState().composer.renderedText).toBe(`YInspect ${prefix}探X索`);
      expect(
        h.presentation.getState().composer.elements.every((element) => element.type === "text"),
      ).toBe(true);
    } finally {
      await h.close();
    }
  },
);

test("an accepted role remains one exact deletable and undoable reference", async () => {
  const h = await startManagedTui({
    stream() {
      throw new Error("No provider expected.");
    },
  });
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    const selected = h.presentation.getState().composer.elements;
    expect(selected).toEqual([
      expect.objectContaining({
        type: "mention",
        kind: "role",
        qualifiedRoleId: "builtin:explore",
      }),
    ]);
    await h.press("\x7f", "Adam · Fleet fixture", "@Explore");
    expect(h.presentation.getState().composer.renderedText).toBe("");
    await h.press(String.fromCharCode(31), "Draft edit undone.");
    expect(h.presentation.getState().composer.elements).toEqual(selected);
  } finally {
    await h.close();
  }
});

test("ordinary Enter seals manual recipients as one Main request without child routing", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Main received literal mentions." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    const text = "Inspect @探索🧭 @Explore @main";
    await h.press(text, "Inspect");
    await h.press("\r", "Main received literal mentions.");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain(text);
    expect(await h.store.read()).toEqual([]);
    const records = await (await h.sessions.open(h.parent.sessionId))?.read();
    expect(
      records?.flatMap((record) =>
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "user_message"
          ? [record.record.event.text]
          : [],
      ),
    ).toEqual([text]);
    expect(h.presentation.getState().composer.renderedText).toBe("");
  } finally {
    await h.close();
  }
});

test("multiple selected recipients require one explicit choice before delegation", async () => {
  const h = await startManagedTui({
    stream() {
      throw new Error("No provider expected before confirmation.");
    },
  });
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" @Research", "New agent · Research");
    await h.press("\t", "@Research");
    await h.press(" Inspect the evidence.", "Inspect the evidence.");
    await h.press("\r", "Choose recipient");
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
    await h.press("\x1b[B", "@Research");
    await h.press("\r", "Recipient selected.");
    expect(
      h.presentation.getState().composer.elements.filter((element) => element.type === "mention"),
    ).toEqual([expect.objectContaining({ kind: "role", qualifiedRoleId: "builtin:research" })]);
    await h.press("\r", "Delegation");
    expect(h.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
    await h.press("\x1b", "Inspect the evidence.");
  } finally {
    await h.close();
  }
});

test("a selected role survives cold restart and copied bytes return as ordinary text", async () => {
  const driver = {
    stream() {
      throw new Error("No provider expected.");
    },
  };
  let copied = "";
  const h = await startManagedTui(driver, {
    draftPersistencePolicy: "recoverable",
    clipboard: {
      async writeText(text) {
        copied = text;
        return "copied";
      },
    },
  });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    await h.press("@Explore", "New agent · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect evidence.", "Inspect evidence.");
    await h.stop();
    const selected = h.presentation.getState().composer.elements;
    expect(copied).toBe("@Explore Inspect evidence.");
    expect(selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "role", qualifiedRoleId: "builtin:explore" }),
      ]),
    );
    cold = await startManagedTui(driver, {
      restore: h.storage,
      draftPersistencePolicy: "recoverable",
    });
    await cold.terminal.waitForScreen("Inspect evidence.");
    expect(cold.presentation.getState().composer.elements).toEqual(selected);
    await cold.presentation.dispatch({
      type: "clear_draft",
      baseRevision: cold.presentation.getState().composer.draftRevision,
    });
    await cold.press(`\x1b[200~${copied}\x1b[201~`, "Inspect evidence.");
    await cold.stop();
    expect(cold.presentation.getState().composer.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "@Explore Inspect evidence." }),
      ]),
    );
    expect(cold.presentation.getState().authoritative.managedControl?.threads).toHaveLength(0);
  } finally {
    if (cold !== undefined) await cold.close();
    await h.close();
  }
});

test.each(["remove", "literal", "retarget"] as const)(
  "an unavailable exact thread offers %s without rebinding its handle",
  async (action) => {
    let calls = 0;
    const h = await startManagedTui({
      async *stream() {
        calls += 1;
        yield { type: "text_delta", text: "Evidence inspected." };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      },
    });
    try {
      await h.press("@Explore", "New agent · Explore");
      await h.press("\t", "@Explore");
      await h.press(" Inspect evidence.", "Inspect evidence.");
      await h.press("\r", "Delegation");
      await h.press("\r", "Completed");
      const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
      if (thread === undefined) throw new Error("Missing completed thread.");
      await h.press("@explore-1", "[Agent] @explore-1 · Inspect evidence.");
      await h.press("\t", "@explore-1");
      await h.press(" Continue inspecting.", "Continue inspecting.");
      const control = await h.lifecycle[sessionManagedControl](h.parent.sessionId);
      await control?.dispatch({
        type: "close_thread",
        parentSessionId: h.parent.sessionId,
        threadId: thread.threadId,
        expectedTurnId: thread.turn.turnId,
      });
      await h.terminal.waitForScreen("@explore-1 unavailable");
      expect(h.presentation.getState().composer.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            threadId: thread.threadId,
            parentSessionId: h.parent.sessionId,
          }),
        ]),
      );
      await h.press("\r", "Recipient unavailable");
      if (action !== "remove") await h.press("\x1b[B", "Convert to literal");
      if (action === "retarget") await h.press("\x1b[B", "Retarget");
      await h.press("\r", action === "retarget" ? "Retarget recipient" : "Recipient updated.");
      if (action === "retarget") await h.press("\r", "Recipient updated.");
      expect(calls).toBe(1);
      expect(
        h.presentation.getState().composer.elements.filter((element) => element.type === "mention"),
      ).toEqual(
        action === "remove"
          ? []
          : [
              expect.objectContaining(
                action === "literal"
                  ? { kind: "literal", literal: "@explore-1" }
                  : { kind: "role", qualifiedRoleId: "builtin:explore" },
              ),
            ],
      );
    } finally {
      await h.close();
    }
  },
);

test.each([
  { name: "Explore", role: "builtin:explore" },
  { name: "Research", role: "builtin:research" },
])(
  "selected $name directly starts a described child with independent frozen Skill activation",
  async ({ name, role }) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-input-"));
    const skillRoot = join(workspaceRoot, ".agents", "skills", "inspect-evidence");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: inspect-evidence\ndescription: Inspect exact repository evidence.\n---\nReport the independently activated evidence procedure.\n",
    );
    const requests: ModelRequest[] = [];
    let mainCalls = 0;
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (request.tools.some((tool) => tool.name === "spawn_agents")) mainCalls += 1;
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call_start", id: "activate-evidence", name: "activate_skill" };
            yield {
              type: "tool_call_delta",
              id: "activate-evidence",
              json: '{"qualifiedId":"skill:v1:project:.:inspect-evidence"}',
            };
            yield { type: "tool_call_end", id: "activate-evidence" };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "Independent Skill evidence complete." };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "stop" };
          }
        },
      },
      { workspaceRoot },
    );
    try {
      await h.press(`@${name}`, name);
      await h.press("\t", `@${name}`);
      expect(h.presentation.getState().composer.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "mention",
            kind: "role",
            qualifiedRoleId: role,
          }),
        ]),
      );
      await h.press(" Inspect exact repository evidence.", "Inspect exact repository evidence.");
      await h.press("\r", "Delegation");
      expect(requests).toHaveLength(0);
      await h.press("\r", "Completed");
      const thread = h.presentation.getState().authoritative.managedControl?.threads[0];
      expect(thread).toMatchObject({
        role,
        description: "Inspect exact repository evidence.",
        turn: { outcome: { status: "completed", summary: "Independent Skill evidence complete." } },
      });
      expect(mainCalls).toBe(0);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]?.messages)).toContain(
        "skill:v1:project:.:inspect-evidence",
      );
      expect(JSON.stringify(requests[0]?.messages)).not.toContain(
        "Report the independently activated",
      );
      expect(JSON.stringify(requests[1]?.messages)).toContain("Report the independently activated");
      for (const request of requests) {
        const names = request.tools.map((tool) => tool.name);
        expect(names).toEqual(
          expect.arrayContaining(["read_file", "activate_skill", "read_skill_resource"]),
        );
        expect(names).not.toEqual(expect.arrayContaining(["write_file"]));
        expect(names.some((name) => /web|mcp|shell|spawn/u.test(name))).toBe(false);
      }
      const parent = await h.lifecycle.inspect({ sessionId: h.parent.sessionId });
      expect(parent.schemaVersion === 3 ? parent.skillContext?.active : undefined).toEqual([]);
    } finally {
      await h.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);

test("an Explore continuation retains its activated Skill and resources across a parent catalog reload", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-continuation-"));
  const skillRoot = join(workspaceRoot, ".agents", "skills", "origin-procedure");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: origin-procedure\ndescription: Inspect origin evidence.\n---\nORIGIN PROCEDURE BODY\n",
  );
  await writeFile(join(skillRoot, "evidence.md"), "Exact origin resource evidence.\n");
  const requests: ModelRequest[] = [];
  const h = await startManagedTui(
    {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 3) {
          yield { type: "tool_call_start", id: "read-nested", name: "read_file" };
          yield {
            type: "tool_call_delta",
            id: "read-nested",
            json: '{"path":"nested/evidence.md"}',
          };
          yield { type: "tool_call_end", id: "read-nested" };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "tool_calls" };
        } else if (requests.length === 1 || requests.length === 4) {
          const activate = requests.length === 1;
          yield {
            type: "tool_call_start",
            id: activate ? "activate-origin" : "read-origin",
            name: activate ? "activate_skill" : "read_skill_resource",
          };
          yield {
            type: "tool_call_delta",
            id: activate ? "activate-origin" : "read-origin",
            json: activate
              ? '{"qualifiedId":"skill:v1:project:.:origin-procedure"}'
              : '{"qualifiedId":"skill:v1:project:.:origin-procedure","path":"evidence.md"}',
          };
          yield { type: "tool_call_end", id: activate ? "activate-origin" : "read-origin" };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text_delta",
            text:
              requests.length === 2
                ? "Origin evidence complete."
                : "Continuation resource complete.",
          };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    { workspaceRoot },
  );
  try {
    await h.press("@Explore", "New agent · Explore repository");
    await h.press("\t", "@Explore");
    await h.press(" Inspect origin evidence.", "Inspect origin evidence.");
    await h.press("\r", "Delegation");
    await h.press("\r", "Completed");
    const first = h.presentation.getState().authoritative.managedControl?.threads[0];
    expect(first?.turn.outcome?.status).toBe("completed");
    const laterRoot = join(workspaceRoot, ".agents", "skills", "later-procedure");
    await mkdir(laterRoot, { recursive: true });
    await writeFile(
      join(laterRoot, "SKILL.md"),
      "---\nname: later-procedure\ndescription: Later parent procedure.\n---\nLATER PARENT BODY\n",
    );
    const nestedSkill = join(workspaceRoot, "nested", ".agents", "skills", "nested-late-procedure");
    await mkdir(nestedSkill, { recursive: true });
    await writeFile(
      join(nestedSkill, "SKILL.md"),
      "---\nname: nested-late-procedure\ndescription: Later scoped metadata.\n---\nLATE NESTED PROCEDURE\n",
    );
    await writeFile(join(workspaceRoot, "nested", "AGENTS.md"), "LATER NESTED INSTRUCTIONS\n");
    await writeFile(join(workspaceRoot, "nested", "evidence.md"), "Nested file evidence.\n");
    await h.lifecycle.reloadSkills({ sessionId: h.parent.sessionId });
    await h.openFirstAgent();
    await h.press("\r", "New turn");
    await h.press("Read the active procedure resource.", "Read the active procedure resource.");
    await h.press("\r", "Continuation resource complete.");
    expect(requests).toHaveLength(5);
    expect(JSON.stringify(requests[2]?.messages)).toContain("ORIGIN PROCEDURE BODY");
    expect(JSON.stringify(requests[2]?.messages)).not.toContain("later-procedure");
    expect(JSON.stringify(requests[3]?.messages)).not.toContain("nested-late-procedure");
    expect(JSON.stringify(requests[3]?.messages)).not.toContain("LATER NESTED INSTRUCTIONS");
    expect(JSON.stringify(requests[3]?.messages)).toContain("Nested file evidence.");
    expect(JSON.stringify(requests[4]?.messages)).toContain("Exact origin resource evidence.");
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.threadId).toBe(
      first?.threadId,
    );
  } finally {
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
