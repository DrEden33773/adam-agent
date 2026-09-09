import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import type { PresentationSession } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { createAdamCommandRegistry, type TodoToggleKey } from "./command-registry.js";
import { runTuiFixture } from "./test-fixture.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

async function closeFixture(terminal: VirtualTerminal, running: Promise<void>) {
  if (terminal.running()) terminal.input("\u0011");
  const expired = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => expired.reject(new Error("Todo TUI did not close")),
    terminalObservationTimeoutMilliseconds,
  );
  try {
    await Promise.race([running, expired.promise]);
  } finally {
    clearTimeout(guard);
  }
}

test.each(["alt+t", "ctrl+shift+t"] as const)(
  "Todo hierarchy, %s, grouped navigation and cold rebuild use real JSONL without UI mutation",
  async (key: TodoToggleKey) => {
    const noColorKey: string = "NO_COLOR";
    const previousNoColor = process.env[noColorKey];
    if (key === "alt+t") process.env[noColorKey] = "1";
    else delete process.env[noColorKey];
    const root = await mkdtemp(join(tmpdir(), "adam-todo-fidelity-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const registry = createAdamCommandRegistry([], { todoToggleKey: key });
    let terminal = new VirtualTerminal({ columns: 80, rows: 24 });
    let presentation: PresentationSession | undefined;
    const options = {
      workspaceRoot,
      stateRoot,
      scenario: "todo-fidelity" as const,
      commandRegistry: registry,
      onPresentationReady: (value: PresentationSession) => {
        presentation = value;
      },
    };
    let running = runTuiFixture({ ...options, terminal });
    void running.catch(() => undefined);
    const press = async (input: string, text: string) => {
      const before = terminal.output().length;
      terminal.input(input);
      await terminal.waitForFrameAfter(text, before);
    };
    try {
      await terminal.waitForScreen("Adam · New session");
      await press("Prepare the Todo hierarchy\r", "Todo hierarchy ready.");
      await terminal.waitForScreen("Implement owner (Implementing owner)");
      const sessionId = presentation?.getState().authoritative.active?.session.id;
      if (sessionId === undefined) throw new Error("Missing durable Todo Session");
      const store = await openJsonlSessionStore<SessionRecord>({
        workspaceRoot,
        stateRoot,
        sessionId,
      });
      const todoRecords = (records: readonly SessionRecord[]) =>
        records.filter(
          (entry) =>
            entry.schemaVersion === 3 &&
            (entry.record.type.startsWith("todo_") ||
              (entry.record.type === "runtime_event" &&
                entry.record.event.type === "tool_completed" &&
                entry.record.event.name === "update_todos")),
        );
      const baseline = todoRecords(await store.read());
      const collapseInput = key === "alt+t" ? "\u001bt" : "\u001b[116;6u";
      await press("retained draft", "retained draft");
      await press(collapseInput, "or /todos toggle to expand");
      expect(terminal.lines().join("\n")).toContain("retained draft");
      await press(collapseInput, "Implement owner (Implementing owner)");
      terminal.input("\u0015");
      await press("/todos toggle\r", "or /todos toggle to expand");
      await press("/todos toggle\r", "Implement owner (Implementing owner)");
      for (const [columns, rows] of [
        [40, 12],
        [80, 18],
        [120, 32],
      ] as const) {
        const before = terminal.output().length;
        terminal.resize(columns, rows);
        await terminal.waitForFrameAfter("Todos (0/5)", before);
        expect(terminal.lines().join("\n").toLowerCase().replace(/\s+/gu, " ")).toContain(
          "todo 5 remaining",
        );
        if (rows === 12) expect(terminal.lines().join("\n")).toContain("5 hidden");
      }
      await press("/todos\r", "Pending");
      expect(terminal.lines().join("\n")).toContain("In Progress");
      await press("Implement owner", "Implement owner");
      await press("\r", "Todo detail · read-only");
      expect(terminal.lines().join("\n")).toContain("Implementing owner");
      await press("\u001b[27;1;27~", "Todos · revision");
      await press("\u001b[27;1;27~", "Todos (0/5)");
      await press("/hotkeys\r", registry.keybinding("toggle_todo_overlay").keys);
      await press("\u001b[27;1;27~", "Adam Help");
      await press("\u001b[27;1;27~", "Todos (0/5)");
      expect(todoRecords(await store.read())).toEqual(baseline);
      if (key === "alt+t") expect(terminal.output()).not.toContain("\u001b[38;2;");
      await closeFixture(terminal, running);
      terminal = new VirtualTerminal({ columns: 80, rows: 24 });
      running = runTuiFixture({ ...options, terminal, sessionId });
      void running.catch(() => undefined);
      await terminal.waitForScreen("Todos (0/5)");
      expect(terminal.lines().join("\n")).toContain("Implementing owner");
      await press("Continue Main\r", "Next Main ready.");
      await terminal.waitForScreen("Todos (0/5)");
      expect(todoRecords(await store.read())).toEqual(baseline);
    } finally {
      try {
        await closeFixture(terminal, running);
        await rm(root, { recursive: true, force: true });
      } finally {
        if (previousNoColor === undefined) delete process.env[noColorKey];
        else process.env[noColorKey] = previousNoColor;
      }
    }
  },
);

test("completed Todo feedback occupies one live line and exits on the Main terminal frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-todo-completed-frame-"));
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new VirtualTerminal({ columns: 80, rows: 24 });
  const running = runTuiFixture({
    workspaceRoot,
    stateRoot: join(root, "state"),
    controlRoot,
    scenario: "todo-batch",
    terminal,
  });
  void running.catch(() => undefined);
  try {
    await terminal.waitForScreen("Adam · New session");
    const before = terminal.output().length;
    terminal.input("Complete the Todo batch\r");
    await terminal.waitForFrameAfter("✓ Todos (4/4 completed)", before);
    const lines = terminal.lines();
    expect(lines.filter((line) => line.includes("Todos ("))).toHaveLength(1);
    expect(lines.some((line) => /[└├]─ ✓ Atomic Task/u.test(line))).toBe(false);
    const terminalBefore = terminal.output().length;
    await writeFile(join(controlRoot, "release-todo-batch"), "release\n", "utf8");
    await terminal.waitForFrameAfter("Atomic Todo batch completed.", terminalBefore);
    await terminal.waitForScreen("idle");
    expect(terminal.lines().join("\n")).not.toContain("Todos (");
    const historyBefore = terminal.output().length;
    terminal.input("/todos\r");
    await terminal.waitForFrameAfter("Atomic Task 0", historyBefore);
    expect(terminal.lines().join("\n")).toContain("Atomic Task 0");
  } finally {
    await closeFixture(terminal, running);
    await rm(root, { recursive: true, force: true });
  }
});
