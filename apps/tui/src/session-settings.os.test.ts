import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresentationSession } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { runTuiFixture } from "./test-fixture.js";
import {
  terminalObservationTimeoutMilliseconds,
  VirtualTerminal,
} from "./virtual-terminal.test-support.js";

test("session settings explicitly upgrades a cold legacy session and retains the result on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-session-settings-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  let terminal = new VirtualTerminal({ columns: 80, rows: 24 });
  let presentation: PresentationSession | undefined;
  const options = {
    workspaceRoot,
    stateRoot,
    onPresentationReady: (value: PresentationSession) => {
      presentation = value;
    },
  };
  let running = runTuiFixture({ ...options, terminal, scenario: "skill-selection" });
  void running.catch(() => undefined);
  const press = async (input: string, text: string) => {
    const before = terminal.output().length;
    terminal.input(input);
    await terminal.waitForFrameAfter(text, before);
  };
  const close = async () => {
    if (terminal.running()) terminal.input("\u0011");
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(
            () => reject(new Error("Session settings TUI did not close")),
            terminalObservationTimeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
    }
  };
  try {
    await terminal.waitForScreen("Adam · New session");
    await press("Seed a legacy session\r", "Skill selection complete.");
    await terminal.waitForScreen(" · idle");
    const state = presentation?.getState();
    const sessionId = state?.authoritative.active?.session.id;
    if (sessionId === undefined || state === undefined) throw new Error("Missing seeded session");
    expect(state.authoritative.active?.todoPermissionPolicy).toBe("todo-permission.session-v1");
    await close();
    const logPath = join(
      stateRoot,
      "projects",
      state.authoritative.project.id.replace(/^sha256:/u, ""),
      "sessions",
      `${sessionId}.jsonl`,
    );
    const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
    const genesis = JSON.parse(lines[0] as string) as {
      record: { todoPermissionPolicyVersion?: string };
    };
    delete genesis.record.todoPermissionPolicyVersion;
    lines[0] = JSON.stringify(genesis);
    await writeFile(logPath, `${lines.join("\n")}\n`);
    terminal = new VirtualTerminal({ columns: 80, rows: 24 });
    running = runTuiFixture({ ...options, terminal, sessionId, scenario: "todo" });
    void running.catch(() => undefined);
    await terminal.waitForScreen(" · idle");
    expect(terminal.lines().join("\n")).not.toContain("Session settings");
    expect(presentation?.getState().authoritative.active?.todoPermissionPolicy).toBe(
      "todo-permission.legacy-v1",
    );
    await press("/session settings\r", "Enter enable session Todo defaults");
    for (const [columns, rows] of [
      [40, 12],
      [80, 24],
      [120, 32],
    ] as const) {
      const before = terminal.output().length;
      terminal.resize(columns, rows);
      await terminal.waitForFrameAfter("Session settings", before);
      expect(terminal.lines().join("\n")).toContain("Enter enable session Todo");
    }
    await press("\r\r", "Session Todo defaults enabled.");
    expect(presentation?.getState().authoritative.active?.todoPermissionPolicy).toBe(
      "todo-permission.session-v1",
    );
    expect(
      (await readFile(logPath, "utf8"))
        .split("\n")
        .filter((line) => line.includes('"type":"session_todo_permission_policy_changed"')),
    ).toHaveLength(1);
    await press("\u001b[27;1;27~", " · idle");
    const beforeTodo = terminal.output().length;
    await press("Create a Todo without a prompt\r", "Todo fixture created.");
    await terminal.waitForScreen(" · idle");
    expect(terminal.output().slice(beforeTodo)).not.toContain("Permission required");
    expect(presentation?.getState().authoritative.active?.todo?.counts.pending).toBe(1);
    await close();
    terminal = new VirtualTerminal({ columns: 80, rows: 24 });
    running = runTuiFixture({ ...options, terminal, sessionId, scenario: "todo" });
    void running.catch(() => undefined);
    await terminal.waitForScreen(" · idle");
    expect(terminal.lines().join("\n")).not.toContain("Session settings");
    await press("/session settings\r", "Session Todo defaults enabled.");
    expect(terminal.lines().join("\n")).not.toContain("Enter enable");
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
