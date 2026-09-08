import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
      await press("Prepare the Todo hierarchy\r", "● Todos (2/7)");
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
        await terminal.waitForFrameAfter("Todos (2/7)", before);
        expect(terminal.lines().join("\n").toLowerCase().replace(/\s+/gu, " ")).toContain(
          "todo 4/1/2",
        );
        if (rows === 12) expect(terminal.lines().join("\n")).toContain("7 hidden");
      }
      await press("/todos\r", "Pending");
      expect(terminal.lines().join("\n")).toContain("In Progress");
      await press("Implement owner", "Implement owner");
      await press("\r", "Todo detail · read-only");
      expect(terminal.lines().join("\n")).toContain("Implementing owner");
      await press("\u001b[27;1;27~", "Todos · revision");
      await press("\u001b[27;1;27~", "Todos (2/7)");
      await press("/hotkeys\r", registry.keybinding("toggle_todo_overlay").keys);
      await press("\u001b[27;1;27~", "Adam Help");
      await press("\u001b[27;1;27~", "Todos (2/7)");
      expect(todoRecords(await store.read())).toEqual(baseline);
      if (key === "alt+t") expect(terminal.output()).not.toContain("\u001b[38;2;");
      await closeFixture(terminal, running);
      terminal = new VirtualTerminal({ columns: 80, rows: 24 });
      running = runTuiFixture({ ...options, terminal, sessionId });
      void running.catch(() => undefined);
      await terminal.waitForScreen("Todos (2/7)");
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
