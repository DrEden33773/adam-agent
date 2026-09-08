import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test.each(["Explore", "Research"] as const)(
  "%s remains selectable and admits a child after Main reasoning, tool, text and naming updates",
  async (role) => {
    let requests = 0;
    const generated = Promise.withResolvers<void>();
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (request.purpose === "title") {
            yield { type: "text_delta", text: "Generated Main title" };
            yield { type: "finish", reason: "stop" };
            return;
          }
          requests += 1;
          if (requests === 1) {
            yield {
              type: "reasoning_start",
              id: "provider-reasoning-0",
              artifactType: "provider_reasoning",
            };
            yield {
              type: "reasoning_delta",
              id: "provider-reasoning-0",
              text: "Inspect the instructions.",
            };
            yield { type: "reasoning_end", id: "provider-reasoning-0" };
            yield { type: "tool_call_start", id: "read-1", name: "read_file" };
            yield { type: "tool_call_delta", id: "read-1", json: '{"path":"AGENTS.md"}' };
            yield { type: "tool_call_end", id: "read-1" };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          yield {
            type: "text_delta",
            text: requests === 2 ? "Main inspection complete." : "Role child completed.",
          };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        },
      },
      {},
    );
    h.lifecycle.enableAutomaticTitles();
    const droppedRoles: number[] = [];
    const unsubscribe = h.presentation.subscribe(() => {
      const state = h.presentation.getState();
      if (state.authoritative.active?.session.naming.generatedTitle === "Generated Main title")
        generated.resolve();
      if (!state.agentRoles?.some((item) => item.name === role)) droppedRoles.push(state.revision);
    });
    try {
      await h.presentation.dispatch({
        type: "clear_session_manual_name",
        sessionId: h.parent.sessionId,
      });
      await h.press("Inspect instructions.\r", "Main inspection complete.");
      await generated.promise;
      expect(h.presentation.getState().agentRoles?.map((item) => item.name)).toEqual(
        expect.arrayContaining(["Explore", "Research"]),
      );
      await h.presentation.dispatch({
        type: "set_session_manual_name",
        sessionId: h.parent.sessionId,
        name: "Renamed Main",
      });
      await h.press(`@${role}`, `New agent · ${role}`);
      await h.press("\t", `@${role}`);
      await h.press(" Inspect the evidence.\r", "Delegation");
      await h.press("\r", "Completed");
      expect(droppedRoles).toEqual([]);
      expect(
        (await h.store.read()).filter((record) => record.event.type === "admitted"),
      ).toHaveLength(1);
      expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.role).toBe(
        `builtin:${role.toLowerCase()}`,
      );
    } finally {
      unsubscribe();
      await h.close();
    }
  },
);

test("selecting another session clears the old role catalog and reloads the destination", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-uir-roles-"));
  const directory = join(workspaceRoot, ".agents", "agents");
  await mkdir(directory, { recursive: true });
  const roleFile = join(directory, "custom.md");
  const definition = (name: string) =>
    `---\nname: ${name}\ndescription: ${name} evidence.\nbase: explore\n---\nInspect evidence.\n`;
  await writeFile(roleFile, definition("Original"));
  const h = await startManagedTui(
    {
      async *stream() {
        yield { type: "text_delta", text: "Destination role completed." };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "stop" };
      },
    },
    { workspaceRoot },
  );
  const leaked: string[] = [];
  const unsubscribe = h.presentation.subscribe(() => {
    const state = h.presentation.getState();
    if (
      state.authoritative.active?.session.id !== h.parent.sessionId &&
      state.agentRoles?.some((role) => role.name === "Original")
    )
      leaked.push("Original");
  });
  try {
    expect(h.presentation.getState().agentRoles?.map((role) => role.name)).toContain("Original");
    await writeFile(roleFile, definition("Destination"));
    expect(
      await h.presentation.dispatch({
        type: "create_session",
        targetId: "deepseek-v4-flash.direct",
      }),
    ).toMatchObject({ status: "admitted" });
    expect(h.presentation.getState().agentRoles?.map((role) => role.name)).not.toContain(
      "Original",
    );
    await h.press("\x1b", "New session draft");
    await h.press("@Destination", "New agent · Destination evidence.");
    await h.press("\t", "@Destination");
    await h.press(" Inspect evidence.\r", "Delegation");
    await h.press("\r", "Completed");
    expect(h.presentation.getState().authoritative.managedControl?.threads[0]?.role).toBe(
      "project:Destination",
    );
    expect(leaked).toEqual([]);
  } finally {
    unsubscribe();
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("every complete Main frame consumes the durable response once and preserves a later equal response", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-uir-frames-"));
  await writeFile(join(workspaceRoot, "evidence.txt"), "Small evidence file.");
  const finishFirst = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const finishSecond = Promise.withResolvers<void>();
  let calls = 0;
  const h = await startManagedTui(
    {
      async *stream() {
        if (++calls === 1) {
          yield { type: "text_delta", text: "Equal response marker." };
          await finishFirst.promise;
          yield { type: "tool_call_start", id: "read", name: "read_file" };
          yield { type: "tool_call_delta", id: "read", json: '{"path":"evidence.txt"}' };
          yield { type: "tool_call_end", id: "read" };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          secondEntered.resolve();
          await finishSecond.promise;
          yield { type: "text_delta", text: "Equal response marker." };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        }
      },
    },
    { workspaceRoot, rows: 50 },
  );
  const finalSettled = Promise.withResolvers<number>();
  const unsubscribe = h.presentation.subscribe(() => {
    const state = h.presentation.getState();
    if (
      calls === 2 &&
      state.authoritative.active?.session.status === "settled" &&
      state.transient === null
    )
      finalSettled.resolve(h.terminal.output().length);
  });
  try {
    const offset = h.terminal.output().length;
    await h.press("Inspect evidence.\r", "Equal response marker.");
    finishFirst.resolve();
    await h.terminal.waitForFrameAfter("Small evidence file.", offset);
    await secondEntered.promise;
    const firstFrames = h.terminal.completeFramesAfter(offset);
    expect(firstFrames.length).toBeGreaterThan(0);
    expect(firstFrames.map((frame) => frame.split("Equal response marker.").length - 1)).toEqual(
      expect.arrayContaining([1]),
    );
    expect(
      firstFrames.every((frame) => frame.split("Equal response marker.").length - 1 <= 1),
    ).toBe(true);
    const secondOffset = h.terminal.output().length;
    finishSecond.resolve();
    const settledOffset = await finalSettled.promise;
    await h.terminal.waitForFrameAfter("idle", settledOffset);
    expect(h.terminal.lines().join("\n").split("Equal response marker.").length - 1).toBe(2);
    expect(
      h.terminal
        .completeFramesAfter(secondOffset)
        .every((frame) => frame.split("Equal response marker.").length - 1 <= 2),
    ).toBe(true);
  } finally {
    unsubscribe();
    finishFirst.resolve();
    finishSecond.resolve();
    await h.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
