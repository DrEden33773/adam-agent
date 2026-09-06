import { expect, test, vi } from "vitest";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test("a current-screen wait does not succeed from a replaced historical frame", async () => {
  const terminal = new VirtualTerminal({ columns: 40, rows: 12 });
  terminal.start(
    () => {},
    () => {},
  );
  terminal.write("\u001b[?2026hOld ready\u001b[?2026l");
  terminal.write("\u001b[?2026h\u001b[2J\u001b[HCurrent busy\u001b[?2026l");
  const pending = terminal.waitForScreen("Old ready");
  terminal.stop();
  await expect(pending).rejects.toThrow("Old ready");
  expect(terminal.lines().join("\n")).toContain("Current busy");
});

test("an explicit action checkpoint retains a complete frame even after the screen advances", async () => {
  const terminal = new VirtualTerminal({ columns: 40, rows: 12 });
  terminal.start(
    () => {},
    () => {},
  );
  terminal.write("\u001b[?2026hOld ready\u001b[?2026l");
  const checkpoint = terminal.output().length;
  terminal.write("\u001b[?2026h\u001b[2J\u001b[HAccepted\u001b[?2026l");
  terminal.write("\u001b[?2026h\u001b[2J\u001b[HWorking\u001b[?2026l");
  await terminal.waitForFrameAfter("Accepted", checkpoint);
  const stale = terminal.waitForFrameAfter("Old ready", checkpoint);
  terminal.stop();
  await expect(stale).rejects.toThrow("Old ready");
});

test("terminal observations reject empty expectations and report the missing screen", async () => {
  const terminal = new VirtualTerminal({ columns: 40, rows: 12 });
  terminal.start(
    () => {},
    () => {},
  );
  terminal.write("\u001b[?2026hWaiting for permission\u001b[?2026l");
  await expect(terminal.waitForScreen("")).rejects.toThrow("non-empty");
  await expect(terminal.waitForFrameAfter(" ", 0)).rejects.toThrow("non-empty");
  const pending = terminal.waitForScreen("Accepted");
  terminal.stop();
  await expect(pending).rejects.toThrow(/Accepted.*Waiting for permission/u);
});

test("a missing-frame deadline reports the expected text and screen before cleanup", async () => {
  vi.useFakeTimers();
  const terminal = new VirtualTerminal({ columns: 40, rows: 12 });
  terminal.start(
    () => {},
    () => {},
  );
  terminal.write("\u001b[?2026hWaiting for permission\u001b[?2026l");
  try {
    const failure = expect(terminal.waitForScreen("Accepted")).rejects.toThrow(
      /Accepted.*40x12.*Waiting for permission/u,
    );
    await vi.runOnlyPendingTimersAsync();
    await failure;
  } finally {
    terminal.stop();
    vi.useRealTimers();
  }
});
