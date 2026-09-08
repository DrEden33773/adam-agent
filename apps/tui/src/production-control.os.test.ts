import { expect, test } from "vitest";
import { createPublicEveFixture, observeEve } from "./public-eve.test-support.js";

test("ordinary production at an intermediate height keeps Agent, Todo, Plan, Attention, Review and Main truthful", async () => {
  const h = await createPublicEveFixture({ coexistence: true });
  try {
    const terminal = await h.startTui();
    terminal.resize(80, 20);
    expect(
      await h.presentation.dispatch({
        type: "managed_control",
        commandId: "coexistence-children",
        command: {
          type: "spawn_agents",
          parentSessionId: h.sessionId,
          entries: [0, 1].map((index) => ({
            role: "builtin:explore",
            task: `Concurrent child evidence ${index}`,
            description: `Coexistence ${index}`,
          })),
        },
      }),
    ).toMatchObject({ status: "admitted" });
    await h.child(0);
    const waiting = await h.child(1);
    expect(
      await h.presentation.dispatch({ type: "enter_plan", sessionId: h.sessionId }),
    ).toMatchObject({ status: "admitted" });
    const planReady = observeEve(
      h.presentation,
      () => h.presentation.getState().authoritative.active?.plan?.state === "ready",
      "Missing ready production Plan",
    );
    expect(
      await h.presentation.dispatch({
        type: "submit_prompt",
        sessionId: h.sessionId,
        thinkingSelection: null,
        text: "Prepare coexistence Plan",
        skills: [],
      }),
    ).toMatchObject({ status: "admitted" });
    await planReady;
    expect(await h.startReview()).toMatchObject({ status: "admitted" });
    await h.review();
    waiting.tool("read_file", { path: "value.ts" });
    await observeEve(
      h.presentation,
      () => (h.presentation.getState().managedAttention?.length ?? 0) > 0,
      "Missing child permission attention",
    );
    await terminal.waitForScreen("Attention Center");
    let transition = terminal.output().length;
    terminal.input("\u001b[27;1;27~");
    await terminal.waitForFrameAfter("Review exact submitted plan", transition, "Attention Center");
    transition = terminal.output().length;
    terminal.input("\u001b[27;1;27~");
    await terminal.waitForFrameAfter("Plan ready", transition, "Review exact submitted plan");
    const offset = terminal.output().length;
    terminal.input("retained Main draft");
    await terminal.waitForFrameAfter("retained Main draft", offset);
    const frame = terminal.lines().join("\n");
    expect(frame).toContain("Coexistence 0");
    expect(frame).toContain("Todos (0/1)");
    expect(frame).toContain("Plan ready");
    expect(frame).toContain("permission");
    expect(frame).toContain("Review · Running");
    expect(frame).toContain("deepseek-v4-flash.direct");
    for (const [columns, rows] of [
      [80, 12],
      [80, 16],
      [40, 12],
      [40, 20],
      [120, 40],
      [80, 20],
    ] as const) {
      const before = terminal.output().length;
      terminal.resize(columns, rows);
      await terminal.waitForFrameAfter("retained Main draft", before);
      const resized = terminal.lines().join("\n");
      expect(resized, `${columns}x${rows}`).toContain("Agents");
      expect(resized, `${columns}x${rows}`).toContain("Todos (0/1)");
      expect(resized.toLowerCase(), `${columns}x${rows}`).toContain("plan ready");
      expect(resized, `${columns}x${rows}`).toMatch(/attention|permission/);
      expect(resized, `${columns}x${rows}`).toContain("Review · Running");
      expect(resized, `${columns}x${rows}`).toContain("deepseek-v4-flash");
      expect(resized, `${columns}x${rows}`).toContain("/help");
      expect(resized, `${columns}x${rows}`).toContain("thinking High");
      expect(resized, `${columns}x${rows}`).not.toContain("Review exact submitted plan");
    }
    const restored = terminal.output().length;
    terminal.input(" after resize");
    await terminal.waitForFrameAfter("retained Main draft after resize", restored);
    await observeEve(
      h.presentation,
      () => h.presentation.getState().composer.renderedText === "retained Main draft after resize",
      "Main focus did not restore the exact draft",
    );
    let before = terminal.output().length;
    terminal.input("\u0001\u000b");
    await terminal.waitForFrameAfter("Fleet", before, "retained Main draft");
    for (const [columns, rows] of [
      [80, 12],
      [80, 16],
      [40, 12],
      [40, 20],
      [120, 40],
      [80, 20],
    ] as const) {
      before = terminal.output().length;
      terminal.resize(columns, rows);
      await terminal.waitForFrameAfter("Fleet", before);
      const empty = terminal.lines().join("\n");
      expect(empty, `empty ${columns}x${rows}`).toContain("Agents");
      expect(empty, `empty ${columns}x${rows}`).toContain("Todos (0/1)");
      expect(empty.toLowerCase(), `empty ${columns}x${rows}`).toContain("plan ready");
      expect(empty, `empty ${columns}x${rows}`).toMatch(/attention|permission/);
      expect(empty, `empty ${columns}x${rows}`).toContain("Review · Running");
      expect(empty, `empty ${columns}x${rows}`).toContain("deepseek-v4-flash");
      expect(empty, `empty ${columns}x${rows}`).toContain("/help");
      expect(empty, `empty ${columns}x${rows}`).toContain("thinking High");
    }
    before = terminal.output().length;
    terminal.resize(40, 12);
    await terminal.waitForFrameAfter("/help", before);
    for (const [keys, visible, absent] of [
      ["\u001b[B", "Fleet ● Main", undefined],
      ["\u001b[B", "Fleet ● @explore-1", undefined],
      ["\r", "Conversation · @explore-1", undefined],
      ["\u001b[27;1;27~", "Fleet", "Conversation ·"],
      ["\u001b[27;1;27~", "Fleet ○ Main", undefined],
      ["Main after child navigation", "Main after child navigation", undefined],
    ] as const) {
      before = terminal.output().length;
      terminal.input(keys);
      await terminal.waitForFrameAfter(visible, before, absent);
    }
    await observeEve(
      h.presentation,
      () => h.presentation.getState().composer.renderedText === "Main after child navigation",
      "Small-window Fleet failed to restore Main focus",
    );
  } finally {
    await h.close();
  }
});
