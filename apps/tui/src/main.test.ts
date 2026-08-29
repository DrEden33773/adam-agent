import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test } from "vitest";
import { AppliedViewportTerminal } from "./applied-viewport-terminal.test-support.js";
import { copySelectionToClipboard, selectionCopyMaximumBytes } from "./exit-policy.js";
import { runTuiFixture } from "./test-fixture.js";
import {
  readFilesRecursively,
  removeTuiFixtureRoot as rm,
  waitForFileContents,
  waitForPath,
} from "./tui-filesystem.test-support.js";
import {
  cleanupActiveTuiFixtures,
  outputAfterFinalAltScreenExit,
  startTuiFixture as startFixture,
} from "./tui-fixture.test-support.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

afterEach(async () => {
  await cleanupActiveTuiFixtures();
});

test("selection copy rejects text above 1 MiB without truncating or invoking the clipboard", async () => {
  let clipboardCalls = 0;
  const result = await copySelectionToClipboard(
    "界".repeat(Math.floor(selectionCopyMaximumBytes / 3) + 1),
    {
      async writeText() {
        clipboardCalls += 1;
        return "copied";
      },
    },
    {
      schedule() {
        throw new Error("An oversized selection must fail before scheduling clipboard work.");
      },
    },
  );

  expect(result).toBe("too_large");
  expect(clipboardCalls).toBe(0);
});

test("minimum-size rendering preserves the draft and returns to the supported layout", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-minimum-size-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("保留 draft 👩🏽‍💻");
    await fixture.waitFor("保留 draft");
    const beforeMinimum = fixture.output().length;
    await fixture.resize(39, 11);
    const minimumFrame = latestSynchronizedFrame(fixture.output().slice(beforeMinimum));
    expect(minimumFrame.join("\n")).toContain("Terminal too small");
    expect(minimumFrame.join("\n")).toContain("Ctrl+C abort/exit");
    expect(minimumFrame.every((line) => visibleWidth(line) <= 39)).toBe(true);

    const beforeRestore = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForAfter("保留 draft", beforeRestore);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("minimum-size mode consumes ordinary editor input while preserving safe exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-minimum-input-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("exact draft");
    await fixture.waitFor("exact draft");
    await fixture.resize(39, 11);
    fixture.write(" must not enter the editor");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe("exact draft");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+Q explicitly preserves the pre-Adam screen without printing the transcript or draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-preserve-screen-ctrl-q-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminal = new VirtualTerminal();
  const previousScreenSentinel = "PRE_ADAM_SCREEN_SENTINEL";
  const privateDraftSentinel = "PRIVATE_DRAFT_SENTINEL";
  await mkdir(workspaceRoot);
  terminal.write(previousScreenSentinel);

  const execution = runTuiFixture({
    clipboard: {
      async writeText() {
        return "copied";
      },
    },
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.whenStarted();
    terminal.input(privateDraftSentinel);
    await terminal.nextSynchronizedFrameContaining(privateDraftSentinel);
    terminal.input("\u0011");
    await expect(execution).resolves.toBeUndefined();

    const output = terminal.output();
    expect(output.startsWith(previousScreenSentinel)).toBe(true);
    const afterExit = outputAfterFinalAltScreenExit(output);
    expect(afterExit).toBe("\u001b[?25h\u001b[?2026l");
    expect(afterExit).not.toContain("Adam ·");
    expect(afterExit).not.toContain(privateDraftSentinel);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("/exit clears its literal input and reaches the existing TUI cleanup without submission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-exit-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const presentationCloseMarker = join(controlRoot, "presentation-closed");
  const terminal = new VirtualTerminal();
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  const execution = runTuiFixture({
    clipboard: {
      async writeText(text) {
        await writeFile(join(controlRoot, "clipboard.txt"), text, "utf8");
        return "copied";
      },
    },
    controlRoot,
    presentationCloseMarker,
    scenario: "provider-no-usage",
    stateRoot,
    terminal,
    workspaceRoot,
  });
  try {
    await terminal.whenStarted();
    const privateTranscriptSentinel = "PRIVATE_TRANSCRIPT_SENTINEL";
    terminal.input(`${privateTranscriptSentinel}\r`);
    await terminal.nextSynchronizedFrameContaining("Provider usage unavailable.");
    terminal.input("/exit extra\r");
    await terminal.nextOutputContaining("Usage: /exit");
    expect(terminal.running()).toBe(true);
    terminal.input("/exit\r");
    const outcome = await Promise.race([
      execution.then(() => "closed" as const),
      terminal.nextOutputContaining("Unknown command /exit").then(
        () => "unknown" as const,
        () => "stopped" as const,
      ),
    ]);
    expect(outcome).not.toBe("unknown");
    await expect(execution).resolves.toBeUndefined();
    await expect(readFile(presentationCloseMarker, "utf8")).resolves.toBe("closed\n");
    await expect(access(join(controlRoot, "clipboard.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/exit');
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
    const afterExit = outputAfterFinalAltScreenExit(terminal.output());
    expect(afterExit).toBe("\u001b[?25h\u001b[?2026l");
    expect(afterExit).not.toContain(privateTranscriptSentinel);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Usage feedback remains actionable until editor correction begins", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-usage-lifetime-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/exit extra\r");
    await fixture.waitForCompleteFrameAfter("! Usage: /exit", 0);
    expect(latestSynchronizedFrame(fixture.output()).join("\n")).toContain(
      "\u001b[38;2;249;226;175m! Usage: /exit\u001b[39m",
    );
    await fixture.resize(40, 24);
    expect(fixture.screen()?.join("\n") ?? "").toContain("! Usage: /exit");
    expect((fixture.screen() ?? []).every((line) => visibleWidth(line) <= 40)).toBe(true);
    await fixture.resize(120, 24);
    expect(fixture.screen()?.join("\n") ?? "").toContain("! Usage: /exit");
    expect((fixture.screen() ?? []).every((line) => visibleWidth(line) <= 120)).toBe(true);
    const beforeCorrection = fixture.output().length;
    fixture.write("/e");
    await fixture.waitForCompleteFrameAfter("/e", beforeCorrection);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeCorrection)).join("\n");

    expect(frame).not.toContain("Usage: /exit");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Usage feedback keeps its semantic marker without color", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-usage-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ noColor: true, stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeUsage = fixture.output().length;
    fixture.write("/exit extra\r");
    await fixture.waitForCompleteFrameAfter("! Usage: /exit", beforeUsage);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeUsage)).join("\n");

    expect(frame).toContain("! Usage: /exit");
    expect(frame).not.toContain("\u001b[38;2;");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("/exit preserves the existing combined cleanup failure classification", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-exit-failures-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const terminal = new VirtualTerminal({ throwAfterStop: true });
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const execution = runTuiFixture({
      clipboard: {
        close() {
          throw new Error("Injected clipboard close failure.");
        },
        writeText: async () => "copied",
      },
      controlRoot,
      presentationCloseMarker: join(controlRoot, "presentation-closed"),
      stateRoot,
      terminal,
      workspaceRoot,
    });
    await terminal.whenStarted();
    terminal.input("/exit\r");
    const failure = await execution.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Injected terminal stop failure after restoration." }),
      expect.objectContaining({ message: "Injected clipboard close failure." }),
    ]);
    await expect(readFile(join(controlRoot, "presentation-closed"), "utf8")).resolves.toBe(
      "closed\n",
    );
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("/exit remains available during a held run and closes without releasing the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-exit-active-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Hold this run\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");
    fixture.write("/exit\r");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(access(join(controlRoot, "release-model"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the 40, 80, and 120 column layouts expose progressively bounded footer facts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-responsive-footer-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");

    let beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    let frameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    let frame = frameLines.join("\n");
    expect(frame).toContain("workspace · context unavailable · idle");
    expect(frame).toContain("/help [topic] · /hotkeys · Tab complete");
    expect(frameLines.every((line) => visibleWidth(line) <= 120)).toBe(true);

    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    frameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    frame = frameLines.join("\n");
    expect(frame).toContain("workspace · context unavailable · idle");
    expect(frame).toContain("fake.local · Certified · /help · Tab complete");
    expect(frameLines.every((line) => visibleWidth(line) <= 80)).toBe(true);

    beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    frameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    frame = frameLines.join("\n");
    expect(frame).toContain("idle · ctx unavailable");
    expect(frame).toContain("fake.local · Certified");
    expect(frame).toContain("/help · Tab complete");
    expect(frame).not.toContain("workspace");
    expect(frameLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Help keeps its exact page and focus across minimum-size resize", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-resize-focus-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/help\r\r");
    await fixture.waitFor("Command Reference");

    let beforeResize = fixture.output().length;
    await fixture.resize(39, 11);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("Terminal too small");
    expect(frame).not.toContain("Command Reference");

    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("Command Reference");
    fixture.write("\u0003focus restored");
    await fixture.waitFor("focus restored");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a permission remains authoritative across narrow and minimum-size focus repair", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-permission-resize-focus-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "mutation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Edit after resize\r");
    await fixture.waitFor("+after");

    let beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("Permission required");
    expect(frame).toContain("Allow");
    expect(frame).toContain("Deny");

    beforeResize = fixture.output().length;
    await fixture.resize(39, 11);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("Terminal too small");
    expect(frame).not.toContain("Permission required");
    fixture.write("\u001b[27;1;27~");
    await fixture.resize(80, 24);
    await fixture.waitFor("denied");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("before\n");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Shift+Enter and Ctrl+J preserve one exact multiline draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-multiline-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("first\u001b[13;2usecond\n第三行");
    await fixture.waitFor("第三行");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(
      "first\nsecond\n第三行",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a chunked large bracketed paste remains one exact expandable editor value", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-large-paste-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const pasted = Array.from(
    { length: 24 },
    (_, index) => `line ${index + 1} · 中文 · e\u0301 · 👩🏽‍💻`,
  ).join("\n");
  const split = Math.floor(pasted.length / 2);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write(`\u001b[200~${pasted.slice(0, split)}`);
    fixture.write(`${pasted.slice(split)}\u001b[201~`);
    await fixture.waitFor("[paste #1 +24 lines]");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(pasted);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the focused editor positions the IME hardware cursor on grapheme cell boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-ime-cursor-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("A中e\u0301👩🏽‍💻Z");
    await fixture.waitFor("A中e");

    for (const expectedColumn of [8, 6, 5, 3]) {
      const beforeMove = fixture.output().length;
      fixture.write("\u001b[D");
      await fixture.resize(80, 24);
      expect(lastAbsoluteCursorColumn(fixture.output().slice(beforeMove))).toBe(expectedColumn);
    }
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("minimum-size Ctrl+C still aborts one active run without arming exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-minimum-abort-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "cancellation",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Cancel from minimum mode\r");
    await fixture.waitFor("Working");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.resize(39, 11);
    fixture.write("\u0003");
    const beforeRestore = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForAfter("cancelled", beforeRestore);
    expect(fixture.output().slice(beforeRestore)).not.toContain("Press Ctrl+C again");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a terminal start failure after acquisition still restores the terminal", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-start-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminal = new VirtualTerminal({ throwAfterStart: true });
  await mkdir(workspaceRoot);

  try {
    await expect(runTuiFixture({ stateRoot, terminal, workspaceRoot })).rejects.toThrow(
      "Injected terminal start failure after acquisition.",
    );
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a terminal stop failure cannot skip Presentation close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-stop-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const terminal = new VirtualTerminal({ throwAfterStop: true });
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const execution = runTuiFixture({
      controlRoot,
      presentationCloseMarker: join(controlRoot, "presentation-closed"),
      stateRoot,
      terminal,
      workspaceRoot,
    });
    await terminal.whenStarted();
    terminal.input("\u0011");
    await expect(execution).rejects.toThrow("Injected terminal stop failure after restoration.");
    await expect(readFile(join(controlRoot, "presentation-closed"), "utf8")).resolves.toBe(
      "closed\n",
    );
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("terminal and clipboard failures remain independent and cannot skip Presentation close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-multiple-close-failures-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const terminal = new VirtualTerminal({ throwAfterStop: true });
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const execution = runTuiFixture({
      clipboard: {
        writeText() {
          throw new Error("Injected clipboard failure.");
        },
      },
      controlRoot,
      presentationCloseMarker: join(controlRoot, "presentation-closed"),
      stateRoot,
      terminal,
      workspaceRoot,
    });
    await terminal.whenStarted();
    terminal.input("preserve this exact draft");
    await terminal.nextOutputContaining("preserve this exact draft");
    terminal.input("\u0011");
    const failure = await execution.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: "Injected terminal stop failure after restoration.",
      }),
      expect.objectContaining({ message: "Injected clipboard failure." }),
    ]);
    await expect(readFile(join(controlRoot, "presentation-closed"), "utf8")).resolves.toBe(
      "closed\n",
    );
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an overlay cleanup failure cannot skip terminal restoration or Presentation close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-overlay-close-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const terminal = new VirtualTerminal({ throwOnHideCursorAfterInput: "\u0011" });
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const execution = runTuiFixture({
      controlRoot,
      presentationCloseMarker: join(controlRoot, "presentation-closed"),
      stateRoot,
      terminal,
      workspaceRoot,
    });
    await terminal.whenStarted();
    terminal.input("/help\r");
    await terminal.nextOutputContaining("Adam Help");
    terminal.input("\u0011");
    await expect(execution).rejects.toThrow(
      "Injected overlay cleanup failure before terminal restoration.",
    );
    await expect(readFile(join(controlRoot, "presentation-closed"), "utf8")).resolves.toBe(
      "closed\n",
    );
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("startup and cleanup failures preserve both causal errors", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-start-cleanup-failures-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminal = new VirtualTerminal({ throwAfterStart: true, throwAfterStop: true });
  await mkdir(workspaceRoot);

  try {
    const failure = await runTuiFixture({ stateRoot, terminal, workspaceRoot }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: "Injected terminal start failure after acquisition.",
      }),
      expect.objectContaining({
        message: "Injected terminal stop failure after restoration.",
      }),
    ]);
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

function latestSynchronizedFrame(output: string): readonly string[] {
  const start = output.lastIndexOf("\u001b[?2026h");
  const end = output.indexOf("\u001b[?2026l", start);
  if (start < 0 || end < 0) {
    throw new Error("The TUI did not emit one complete synchronized frame.");
  }
  const frame = output
    .slice(start + "\u001b[?2026h".length, end)
    .replace("\u001b[2J\u001b[H\u001b[3J", "");
  const absoluteRows = [
    ...frame.matchAll(new RegExp(`${"\u001b"}\\[(\\d+);1H${"\u001b"}\\[2K`, "gu")),
  ];
  if (absoluteRows.length === 0) {
    return frame.split("\r\n");
  }
  const lines: string[] = [];
  for (const [index, match] of absoluteRows.entries()) {
    const row = Number(match[1]) - 1;
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = absoluteRows[index + 1]?.index ?? frame.length;
    const content = frame.slice(contentStart, contentEnd);
    lines[row] = content
      .replace(new RegExp(`${"\u001b"}\\[\\d+;\\d+H`, "gu"), "")
      .replace(new RegExp(`${"\u001b"}\\[\\?25[hl]`, "gu"), "");
  }
  return Array.from({ length: lines.length }, (_, index) => lines[index] ?? "");
}

function keywordLabel(text: string): string {
  return `\u001b[1m\u001b[38;2;203;166;247m${text}\u001b[39m\u001b[22m`;
}

async function inputAndWaitForPhysicalFrame(
  terminal: AppliedViewportTerminal,
  input: string,
): Promise<void> {
  const frame = terminal.frame;
  terminal.input(input);
  await terminal.nextFrame(frame);
}

async function waitForPhysicalText(
  terminal: AppliedViewportTerminal,
  expected: string,
): Promise<void> {
  while (!terminal.lines().join("\n").includes(expected)) {
    await terminal.nextFrame(terminal.frame);
  }
}

function expectFramedOverlay(output: string, title: string): void {
  const lines = latestSynchronizedFrame(output);
  const titleIndex = lines.findIndex((line) => line.includes(title));
  const topIndex = lines.findLastIndex(
    (line, index) => index < titleIndex && line.includes("┌") && line.includes("┐"),
  );
  const bottomIndex = lines.findIndex(
    (line, index) => index > titleIndex && line.includes("└") && line.includes("┘"),
  );
  expect(titleIndex).toBeGreaterThan(topIndex);
  expect(bottomIndex).toBeGreaterThan(titleIndex);
  expect([...(lines[titleIndex] ?? "").matchAll(/│/gu)]).toHaveLength(2);
}

function lastAbsoluteCursorColumn(output: string): number | undefined {
  const absoluteColumn = new RegExp(`${String.fromCharCode(27)}\\[(?:(\\d+)G|\\d+;(\\d+)H)`, "gu");
  return [...output.matchAll(absoluteColumn)]
    .map((match) => Number.parseInt((match[1] ?? match[2]) as string, 10))
    .at(-1);
}

test("the production TUI selects an exact available target before creating an empty-project session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-target-picker-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "provider-no-usage",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Select an exact model target", 0);
    expectFramedOverlay(fixture.output(), "Select an exact model target");
    await fixture.waitFor("deepseek-v4-flash.direct");
    await fixture.waitFor("deepseek-v4-pro.direct");
    const targetFrame = latestSynchronizedFrame(fixture.output()).join("\n");
    expect(targetFrame).toContain("deepseek-v4-flash-vision-exp.d");
    expect(targetFrame).toContain("Upstream Experimental");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI tests a configured exact target without conflating reachability and certification in process", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-target-connection-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new VirtualTerminal({ columns: 120, rows: 24 });
  const execution = runTuiFixture({
    launch: { startupTargetId: "deepseek-v4-flash-vision-exp.direct" },
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.whenStarted();
    await terminal.nextSynchronizedFrameContaining("Adam · New session");
    await terminal.nextSynchronizedFrameContaining(
      "deepseek-v4-flash-vision-exp.direct · Certified",
    );
    await terminal.nextSynchronizedFrameContaining("Configured · Not tested");
    const beforeTest = terminal.output().length;

    terminal.input("/connection\r");

    await terminal.nextSynchronizedFrameContaining(
      "Connection test: Configured · Reachable · Certified.",
      beforeTest,
    );
    terminal.input("\u0011");
    await expect(execution).resolves.toBeUndefined();
    expect(terminal.lifecycle()).toEqual(["started", "stopped"]);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the session header distinguishes the Adam brand from the session title", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-session-header-colors-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { startupTargetId: "deepseek-v4-flash.direct" },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const frame = latestSynchronizedFrame(fixture.output()).join("\n");
    expect(frame).toContain("\u001b[1m\u001b[38;2;203;166;247mAdam\u001b[39m\u001b[22m");
    expect(frame).toContain("\u001b[38;2;166;227;161mNew session\u001b[39m");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("NO_COLOR keeps the semantically split session header plain", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-session-header-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { startupTargetId: "deepseek-v4-flash.direct" },
      noColor: true,
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const frame = latestSynchronizedFrame(fixture.output()).join("\n");
    expect(frame).toContain("Adam · New session");
    expect(frame).not.toContain("\u001b[38;2;203;166;247m");
    expect(frame).not.toContain("\u001b[38;2;166;227;161m");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Escape closes the target picker before idle Ctrl+C can arm exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-target-picker-escape-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\u001b[27;1;27~");
    fixture.write("\u0003");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI creates from one valid saved exact default without opening the target picker", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-default-target-"));
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspaceRoot);
  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({ schemaVersion: 1, defaultTargetId: "deepseek-v4-flash.direct" }),
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    const fixture = startFixture({ launch: { configRoot }, stateRoot, workspaceRoot });
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(fixture.screen()?.join("\n") ?? "").toContain("Adam · New session");
    expect(result.stdout).not.toContain("Select an exact model target");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production target picker saves and clears its focused exact default separately from session creation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-save-target-"));
  const configRoot = join(testRoot, "config");
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: { configRoot }, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\u0013");
    await fixture.waitFor("Saved deepseek-v4-flash.direct as the default");
    const configurationPath = join(configRoot, "adam-agent", "config.json");
    await waitForPath(configurationPath);
    expect(await readFile(configurationPath, "utf8")).toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: "deepseek-v4-flash.direct",
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens: null,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
    fixture.write("\u0013");
    await fixture.waitFor("Cleared the saved default target");
    expect(await readFile(configurationPath, "utf8")).toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens: null,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain("Adam · New session");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production target picker clears a saved default that is absent from the catalog", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-clear-missing-target-"));
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const configurationPath = join(configDirectory, "config.json");
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspaceRoot);
  await writeFile(
    configurationPath,
    `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: "removed-target.direct",
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    const fixture = startFixture({ launch: { configRoot }, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    await fixture.waitFor("Clear saved default");
    fixture.write("clear");
    await fixture.waitFor("Search: clear");
    const beforeClear = fixture.output().length;
    fixture.write("\u001b[A");
    fixture.write("\r");
    await fixture.waitForAfter("Cleared the saved default target", beforeClear);
    const expectedConfiguration = `${JSON.stringify({
      schemaVersion: 2,
      defaultTargetId: null,
      modelPolicy: {
        contextWindowTokens: null,
        maximumOutputTokens: null,
        automaticCompactionWindowTokens: null,
      },
    })}\n`;
    await waitForFileContents(configurationPath, expectedConfiguration);
    expect(await readFile(configurationPath, "utf8")).toBe(expectedConfiguration);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI keeps an edited new-session draft out of persistence until submit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-session-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    const beforeTarget = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Adam · New session", beforeTarget);
    fixture.write("temporary unsent draft");
    await fixture.waitForAfter("temporary unsent draft", beforeTarget);
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("deepseek-v4-flash.direct · Certified");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI stages and sends one linked input resource", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-linked-input-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "outside-notes.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "linked TUI bytes\n", "utf8");

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "provider-no-usage",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    const beforeAttach = fixture.output().length;
    fixture.write(`/attach ${selectedPath}\r`);
    await expect(
      Promise.race([
        fixture
          .waitForCompleteFrameAfter("ready · outside-notes.txt · 17 bytes", beforeAttach)
          .then(() => "ready" as const),
        fixture
          .waitForAfter("Unknown command /attach", beforeAttach)
          .then(() => "unknown" as const),
      ]),
    ).resolves.toBe("ready");

    const beforePrompt = fixture.output().length;
    fixture.write("Use the linked notes if needed.\r");
    await fixture.waitForAfter("Provider usage unavailable.", beforePrompt);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    const durable = await readFilesRecursively(stateRoot);
    expect(durable).toContain('"displayName":"outside-notes.txt"');
    expect(durable).not.toContain(selectedPath);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI stages and sends one validated image to the exact Vision Chat target in process", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-vision-image-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "one-pixel.png");
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, imageBytes);
  const terminal = new VirtualTerminal({ columns: 120, rows: 24 });
  const execution = runTuiFixture({
    launch: { startupTargetId: "deepseek-v4-flash-vision-exp.direct" },
    scenario: "provider-no-usage",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.whenStarted();
    await terminal.nextSynchronizedFrameContaining("Adam · New session");
    const beforeAttach = terminal.output().length;
    terminal.input(`/attach ${selectedPath}\r`);
    await terminal.nextSynchronizedFrameContaining(
      `ready · one-pixel.png · ${imageBytes.byteLength} bytes`,
      beforeAttach,
    );

    const beforePrompt = terminal.output().length;
    terminal.input("Describe the attached image.\r");
    await terminal.nextSynchronizedFrameContaining("Provider usage unavailable.", beforePrompt);
    terminal.input("\u0011");
    await expect(execution).resolves.toBeUndefined();
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI removes a ready linked input resource by its visible index", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-remove-input-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "discard-notes.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "discard these bytes\n", "utf8");

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "provider-no-usage",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write(`/attach ${selectedPath}\r`);
    await fixture.waitFor("ready · discard-notes.txt · 20 bytes");

    const beforeRemove = fixture.output().length;
    fixture.write("/detach 1\r");
    await expect(
      Promise.race([
        fixture
          .waitForAfter("Input resource removed.", beforeRemove)
          .then(() => "removed" as const),
        fixture
          .waitForAfter("Unknown command /detach", beforeRemove)
          .then(() => "unknown" as const),
      ]),
    ).resolves.toBe("removed");
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("discard-notes.txt");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI cancels a copying input resource by its visible index", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-input-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const selectedPath = join(testRoot, "slow-notes.txt");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(selectedPath, "slow linked bytes\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      launch: {},
      scenario: "input-resource-copying",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write(`/attach ${selectedPath}\r`);
    await waitForPath(join(controlRoot, "input-resource-copying"));
    await fixture.waitFor("copying · slow-notes.txt · size pending");

    const beforeCancel = fixture.output().length;
    fixture.write("/cancelattach 1\r");
    await expect(
      Promise.race([
        fixture
          .waitForAfter("cancelled · slow-notes.txt", beforeCancel)
          .then(() => "cancelled" as const),
        fixture
          .waitForAfter("Unknown command /cancelattach", beforeCancel)
          .then(() => "unknown" as const),
      ]),
    ).resolves.toBe("cancelled");
    await writeFile(join(controlRoot, "release-input-resource-copy"), "release\n", "utf8");
    await fixture.waitFor("Input resource cancelled.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await writeFile(join(controlRoot, "release-input-resource-copy"), "release\n", "utf8").catch(
      () => undefined,
    );
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("linked input resources stay sanitized, colorless, and bounded at supported widths", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-safe-input-resource-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const selectedPath = join(testRoot, "unsafe\u0085name.txt");
  await mkdir(workspaceRoot);
  await writeFile(selectedPath, "safe display bytes\n", "utf8");

  try {
    const fixture = startFixture({
      launch: {},
      noColor: true,
      scenario: "provider-no-usage",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write(`/attach ${selectedPath}\r`);
    await fixture.waitFor("ready · unsafe�name.txt · 19 bytes");

    for (const columns of [40, 80, 120]) {
      const beforeResize = fixture.output().length;
      await fixture.resize(columns, 40);
      const frame = latestSynchronizedFrame(fixture.output().slice(beforeResize));
      expect(frame.join("\n")).toContain("Linked input resources");
      expect(frame.join("\n")).not.toContain("\u0085");
      expect(frame.join("\n")).not.toContain("\u001b[38;2;");
      expect(frame.join("\n")).not.toContain("\u001b[48;2;");
      expect(frame.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }

    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI selects a draft Skill without creating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-skill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-review\ndescription: Reviews a draft before admission.\n---\nDraft Skill body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("Select next-turn Skills");
    fixture.write("\r");
    await fixture.waitFor("1 Skill selected");
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("skill:v1:project:.:draft-review");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI admits one selected draft Skill with the first prompt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-skill-admission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-review");
  const qualifiedId = "skill:v1:project:.:draft-review";
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-review\ndescription: Reviews a draft before admission.\n---\nDraft Skill body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("Select next-turn Skills");
    fixture.write("\r");
    await fixture.waitFor("1 Skill selected");
    fixture.write("Apply the draft procedure\r");
    await fixture.waitFor("Skill selection complete.");
    fixture.write("\u0011");
    const result = await fixture.closed;
    const durable = await readFilesRecursively(stateRoot);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(durable).toContain(`"qualifiedId":"${qualifiedId}"`);
    expect(durable).toContain('"reason":"user_explicit"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI opens command Help from a draft without creating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write("/help commands\r");
    await fixture.waitFor("Command Reference");
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI reopens the project session picker from a draft without admitting it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-resume-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { seedTargetIds: ["deepseek-v4-flash.direct"] },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    fixture.write("\r");
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    const beforeResume = fixture.output().length;
    fixture.write("/resume\r");
    await fixture.waitForAfter("Select a project session", beforeResume);
    fixture.write("\u0011");
    const result = await fixture.closed;
    const durable = await readFilesRecursively(stateRoot);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(durable.match(/"type":"session_genesis"/gu)).toHaveLength(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI switches an exact draft target without creating durable session identity", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-target-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    const beforeTarget = fixture.output().length;
    fixture.write("/target\r");
    await fixture.waitForAfter("Select an exact model target", beforeTarget);
    fixture.write("\u001b[B");
    fixture.write("\r");
    await fixture.waitForAfter("deepseek-v4-pro.direct · Certified", beforeTarget);
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("canceling target selection restores the editor without status noise", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-draft-target-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { startupTargetId: "deepseek-v4-flash.direct" },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeTarget = fixture.output().length;
    fixture.write("/target\r");
    await fixture.waitForCompleteFrameAfter("Select an exact model target", beforeTarget);
    fixture.write("\u001b[27;1;27~");
    fixture.write("target focus restored");
    await fixture.waitForCompleteFrameAfter("target focus restored", beforeTarget);
    const restoredFrame = fixture.screen()?.join("\n") ?? "";
    expect(restoredFrame).toContain("Adam · New session");
    expect(restoredFrame).not.toContain("Select an exact model target");
    expect(restoredFrame).not.toContain("Target selection closed.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI opens owner-local configuration from an exact draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-draft-configuration-page-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { configRoot, startupTargetId: "deepseek-v4-flash.direct" },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePage = fixture.output().length;
    fixture.write("/config\r");
    await fixture.waitForCompleteFrameAfter("User model configuration", beforePage);
    expect(latestSynchronizedFrame(fixture.output().slice(beforePage)).join("\n")).toContain(
      "Context window",
    );
    const beforeClose = fixture.output().length;
    fixture.write("\u0003");
    fixture.write("configuration focus restored");
    await fixture.waitForCompleteFrameAfter("configuration focus restored", beforeClose);
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("Configuration closed.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI applies one exact draft policy command", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-draft-configuration-command-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "1234-file"), "completion decoy\n", "utf8");

  try {
    const fixture = startFixture({
      launch: { configRoot, startupTargetId: "deepseek-v4-flash.direct" },
      scenario: "provider-no-usage",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    let beforeMutation = fixture.output().length;
    fixture.write("/config con");
    await fixture.waitForCompleteFrameAfter("context", beforeMutation);
    fixture.write("\t d");
    await fixture.waitForCompleteFrameAfter("default", beforeMutation);
    fixture.write("\t\r");
    await fixture.waitForAfter("Saved context limit: default.", beforeMutation);

    beforeMutation = fixture.output().length;
    fixture.write("/config out");
    await fixture.waitForCompleteFrameAfter("output", beforeMutation);
    fixture.write("\t 1234");
    await fixture.waitForCompleteFrameAfter("/config output 1234", beforeMutation);
    const beforeForcedCompletion = fixture.output().length;
    fixture.write("\t");
    await fixture.resize(81, 24);
    await fixture.waitForCompleteFrameAfter("/config output 1234", beforeForcedCompletion);
    fixture.write("\r");
    await fixture.waitForAfter("Saved output limit: 1234 tokens.", beforeMutation);
    const beforePrompt = fixture.output().length;
    fixture.write("Configured TUI admission\r");
    await fixture.waitForAfter("Provider usage unavailable.", beforePrompt);
    await fixture.waitForAfter(" · idle", beforePrompt);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    expect(await readFilesRecursively(stateRoot)).toContain('"maximumOutputTokens":1234');
    await expect(readFile(join(configRoot, "adam-agent", "config.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 2,
        defaultTargetId: null,
        modelPolicy: {
          contextWindowTokens: null,
          maximumOutputTokens: 1_234,
          automaticCompactionWindowTokens: null,
        },
      })}\n`,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI admits owner-local workspace trust before session or target selection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-workspace-trust-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(stateRoot);
  await mkdir(controlRoot);
  await mkdir(join(configRoot, "adam-agent"), { recursive: true, mode: 0o700 });

  try {
    const fixture = startFixture({
      controlRoot,
      launch: {
        configRoot,
        startupTargetId: "deepseek-v4-flash.direct",
        workspaceTrust: "owner-local",
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    const gate = fixture.screen()?.join("\n") ?? "";
    expect(gate).toContain("No — Exit Adam");
    expect(gate).toContain("Yes — Trust and continue");
    expect(gate).not.toContain("Select a project session");
    expect(gate).not.toContain("Select an exact model target");
    expect(gate).not.toContain("Adam · New session");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
    await expect(
      access(join(configRoot, "adam-agent", "workspace-trust.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fixture.resize(40, 12);
    const narrowGate = fixture.screen()?.join("\n") ?? "";
    expect(narrowGate).toContain("No — Exit Adam");
    expect(narrowGate).toContain("Yes — Trust and continue");
    fixture.write("\u001b[B");
    await fixture.resize(41, 12);
    expect(fixture.screen()?.join("\n") ?? "").toContain("> Yes — Trust and continue");
    fixture.write("\r");
    const trustReceiptPath = join(controlRoot, "workspace-trust-dispatch-settled");
    await expect(waitForFileContents(trustReceiptPath, "admitted\n")).resolves.toBe("admitted\n");
    await waitForPath(join(configRoot, "adam-agent", "workspace-trust.json"));
    const createReceiptPath = join(controlRoot, "create-session-dispatch-settled");
    await expect(waitForFileContents(createReceiptPath, "admitted\n")).resolves.toBe("admitted\n");
    await fixture.resize(42, 12);
    const admittedNarrow = fixture.screen()?.join("\n") ?? "";
    expect(admittedNarrow).not.toContain("Workspace trust required");
    expect(admittedNarrow).toContain("draft · idle");
    expect(admittedNarrow).toContain("deepseek-v4-flash.direct");
    await fixture.resize(80, 24);
    expect(fixture.screen()?.join("\n") ?? "").toContain("Adam · New session");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const document = JSON.parse(
      await readFile(join(configRoot, "adam-agent", "workspace-trust.json"), "utf8"),
    ) as { readonly schemaVersion: number; readonly trustedProjectIds: readonly string[] };
    expect(document).toEqual({
      schemaVersion: 1,
      trustedProjectIds: [expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)],
    });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("canceling workspace trust management restores the editor without status noise", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-workspace-trust-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { startupTargetId: "deepseek-v4-flash.direct" },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeTrust = fixture.output().length;
    fixture.write("/trust\r");
    await fixture.waitForCompleteFrameAfter("Workspace trust", beforeTrust);
    fixture.write("\u001b[27;1;27~");
    fixture.write("trust focus restored");
    await fixture.waitForCompleteFrameAfter("trust focus restored", beforeTrust);
    const restoredFrame = fixture.screen()?.join("\n") ?? "";
    expect(restoredFrame).toContain("Adam · New session");
    expect(restoredFrame).not.toContain("Workspace trust unchanged.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the startup workspace trust gate defaults No to clean exit without authority or session state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-trust-no-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);
  await mkdir(stateRoot);

  try {
    const fixture = startFixture({
      launch: {
        configRoot,
        startupTargetId: "deepseek-v4-flash.direct",
        workspaceTrust: "owner-local",
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    fixture.write("\r");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
    await expect(
      access(join(configRoot, "adam-agent", "workspace-trust.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("unavailable startup trust stays fail closed and Escape exits without owner state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-trust-unavailable-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);
  await mkdir(stateRoot);

  try {
    const fixture = startFixture({
      launch: {
        configRoot,
        startupTargetId: "deepseek-v4-flash.direct",
        workspaceTrust: "unavailable",
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    const gate = fixture.screen()?.join("\n") ?? "";
    expect(gate).toContain("workspace · unavailable");
    expect(gate).toContain("No — Exit Adam");
    expect(gate).not.toContain("Yes — Trust and continue");
    fixture.write("\u001b");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(
      access(join(configRoot, "adam-agent", "workspace-trust.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a failed startup trust mutation remains visibly blocked and creates no session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-trust-failure-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);
  await mkdir(stateRoot);

  try {
    const fixture = startFixture({
      launch: {
        configRoot,
        startupTargetId: "deepseek-v4-flash.direct",
        workspaceTrust: "owner-local",
        workspaceTrustMutation: "reject",
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    const beforeGrant = fixture.output().length;
    fixture.write("\u001b[B\r");
    await fixture.waitForCompleteFrameAfter("Injected trust mutation rejection.", beforeGrant);
    expect(fixture.screen()?.join("\n") ?? "").toContain("Workspace trust required");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("startup trust persists across restart and revocation restores the admission gate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-trust-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);

  const launch = {
    configRoot,
    startupTargetId: "deepseek-v4-flash.direct",
    workspaceTrust: "owner-local" as const,
  };
  try {
    const first = startFixture({ launch, stateRoot, workspaceRoot });
    await first.waitForCompleteFrameAfter("Workspace trust required", 0);
    first.write("\u001b[B\r");
    await first.waitForCompleteFrameAfter("Adam · New session", 0);
    first.write("\u0011");
    await expect(first.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const restarted = startFixture({ launch, stateRoot, workspaceRoot });
    await restarted.waitForCompleteFrameAfter("Adam · New session", 0);
    expect(restarted.screen()?.join("\n") ?? "").not.toContain("Workspace trust required");
    const beforeRevoke = restarted.output().length;
    restarted.write("/trust revoke\r");
    await restarted.waitForCompleteFrameAfter("Workspace trust required", beforeRevoke);
    expect(restarted.screen()?.join("\n") ?? "").toContain("No — Exit Adam");
    restarted.write("\r");
    await expect(restarted.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const document = JSON.parse(
      await readFile(join(configRoot, "adam-agent", "workspace-trust.json"), "utf8"),
    ) as { readonly schemaVersion: number; readonly trustedProjectIds: readonly string[] };
    expect(document).toEqual({ schemaVersion: 1, trustedProjectIds: [] });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI clears draft Skill selections when the exact target changes", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-target-skills-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "draft-review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: draft-review\ndescription: Must not remain selected across exact targets.\n---\nDraft Skill body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("Select next-turn Skills");
    fixture.write("\r");
    await fixture.waitFor("1 Skill selected");
    const beforeTarget = fixture.output().length;
    fixture.write("/target\r");
    await fixture.waitForAfter("Select an exact model target", beforeTarget);
    fixture.write("\u001b[B\r");
    await fixture.waitForCompleteFrameAfter("deepseek-v4-pro.direct · Certified", beforeTarget);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeTarget)).join("\n");
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(frame).not.toContain("1 Skill selected");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI explains durable-identity commands without admitting a draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-identity-command-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ launch: {}, stateRoot, workspaceRoot });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    const beforeName = fixture.output().length;
    fixture.write("/name Draft name\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("/name needs a session. Submit the first prompt or use /resume.", beforeName)
        .then(() => "actionable" as const),
      fixture
        .waitForAfter(
          "This command is not available before the first prompt is admitted.",
          beforeName,
        )
        .then(() => "generic" as const),
    ]);
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("actionable");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI admits the first draft prompt before showing its durable answer", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-draft-admission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {},
      scenario: "skill-selection",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Admit this first draft prompt\r");
    await fixture.waitForAfter("Skill selection complete.", beforePrompt);
    fixture.write("\u0011");
    const result = await fixture.closed;
    const durable = await readFilesRecursively(stateRoot);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(durable).toContain('"type":"session_genesis"');
    expect(durable).toContain('"type":"logical_run_started"');
    expect(durable).toContain('"userMessage":"Admit this first draft prompt"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+C cancels draft admission preflight without persisting or arming exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-draft-admission-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      launch: {},
      scenario: "draft-admission-cancellation",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select an exact model target");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    fixture.write("Cancel this draft admission\r");
    await waitForPath(join(controlRoot, "model-resolve-pending"));
    const beforeCancel = fixture.output().length;
    fixture.write("\u0003");
    await fixture.waitForCompleteFrameAfter(
      "The exact target or draft resources are no longer available.",
      beforeCancel,
    );
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeCancel)).join("\n");

    expect(frame).toContain("Cancel this draft admission");
    expect(frame).not.toContain("Press Ctrl+C again");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"type":"session_genesis"');
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production target picker shows malformed configuration diagnostics without losing direct targets", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-invalid-target-config-"));
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspaceRoot);
  await writeFile(join(configDirectory, "config.json"), "{not-json\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    const fixture = startFixture({ launch: { configRoot }, stateRoot, workspaceRoot });
    await fixture.waitFor("deepseek-v4-flash.direct");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("The saved default target configuration is invalid.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI shows the project session picker before any target resolution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-session-picker-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { seedTargetIds: ["deepseek-v4-flash.direct"] },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("deepseek-v4-flash.direct");
    await fixture.waitForCompleteFrameAfter("Select a project session", 0);
    expectFramedOverlay(fixture.output(), "Select a project session");
    const frame = latestSynchronizedFrame(fixture.output()).join("\n");
    const titleIndex = frame.indexOf("Select a project session");
    const newSessionIndex = frame.indexOf("New Session");
    const searchIndex = frame.indexOf("Search:");
    const existingSessionIndex = frame.indexOf("deepseek-v4-flash.direct");
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(newSessionIndex).toBeGreaterThan(titleIndex);
    expect(searchIndex).toBeGreaterThan(newSessionIndex);
    expect(existingSessionIndex).toBeGreaterThan(searchIndex);
    expect(frame).toContain("┌");
    expect(frame).toContain("└");
    const inverseStart = "\u001b[48;2;205;214;244m\u001b[38;2;17;17;27m";
    const inverseEnd = "\u001b[39m\u001b[49m";
    const pinnedLine = frame.split("\n").find((line) => line.includes("> New Session"));
    expect(pinnedLine).toBeDefined();
    const pinnedStart = pinnedLine?.indexOf(inverseStart) ?? -1;
    const pinnedEnd = pinnedLine?.indexOf(inverseEnd, pinnedStart + inverseStart.length) ?? -1;
    expect(pinnedStart).toBeGreaterThanOrEqual(0);
    expect(pinnedEnd).toBeGreaterThan(pinnedStart);
    const pinnedContent = pinnedLine?.slice(pinnedStart + inverseStart.length, pinnedEnd) ?? "";
    expect(pinnedContent).toContain("> New Session");
    expect(pinnedContent).not.toContain("→ New Session");
    expect(pinnedContent).toContain("Choose an exact target");
    expect(pinnedContent.endsWith("  ")).toBe(true);
    expect(visibleWidth(pinnedContent)).toBe(60);
    const resizedFrames: Array<{ readonly columns: number; readonly lines: readonly string[] }> =
      [];
    for (const [columns, rows] of [
      [120, 40],
      [40, 12],
    ] as const) {
      const beforeResize = fixture.output().length;
      await Promise.race([
        fixture.resize(columns, rows),
        fixture.closed.then(() => {
          throw new Error("The session picker closed while resizing.");
        }),
      ]);
      resizedFrames.push({
        columns,
        lines: latestSynchronizedFrame(fixture.output().slice(beforeResize)),
      });
    }
    fixture.write("\u0011");
    const result = await fixture.closed;
    for (const { columns, lines } of resizedFrames) {
      const resizedFrame = lines.join("\n");
      expect(resizedFrame).toContain("New Session");
      expect(resizedFrame).toContain("Search:");
      expect(resizedFrame).toContain("┌");
      expect(resizedFrame).toContain("└");
      expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Select a project session");
    expect(result.stdout).toContain("New Session");
    expect(result.stdout).not.toContain("Select an exact model target");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an explicit target still waits for explicit New Session when project sessions exist", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-explicit-target-session-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: {
        seedTargetIds: ["deepseek-v4-flash.direct"],
        startupTargetId: "deepseek-v4-pro.direct",
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("deepseek-v4-");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result.stdout).toContain("Select a project session");
    expect(result.stdout).not.toContain("Adam · New session");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production session picker opens the exact focused existing session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-select-session-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { seedTargetIds: ["deepseek-v4-flash.direct"] },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    const beforeSelection = fixture.output().length;
    fixture.write("\u001b[B\r");
    await fixture.waitForAfter("Adam · Streaming session", beforeSelection);
    await fixture.waitForAfter("deepseek-v4-flash.direct · Certified", beforeSelection);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production session picker requires explicit New Session before target selection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-new-session-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      launch: { seedTargetIds: ["deepseek-v4-flash.direct"] },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    const beforeNewSession = fixture.output().length;
    fixture.write("\u001b[B\u001b[A\r");
    await fixture.waitForAfter("Select an exact model target", beforeNewSession);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production editor renames the active session through canonical Presentation truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-name-session-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeRename = fixture.output().length;
    fixture.write("/name Release triage\r");
    const settledMarker = join(controlRoot, "session-name-dispatch-settled");
    await expect(waitForFileContents(settledMarker, "admitted\n")).resolves.toBe("admitted\n");
    await fixture.waitForCompleteFrameAfter("Adam · Release triage", beforeRename);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(fixture.screen()?.join("\n") ?? "").toContain("Adam · Release triage");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI opens slash Help locally without submitting it to the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-interactive-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-unavailable", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeHelp = fixture.output().length;
    fixture.write("/help\r");
    const outcome = await Promise.race([
      fixture.waitForCompleteFrameAfter("Adam Help", beforeHelp).then(() => "help" as const),
      fixture.waitForAfter("Skill selection complete.", beforeHelp).then(() => "model" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(beforeHelp), "Adam Help");
    expect(fixture.output().slice(beforeHelp)).toContain(keywordLabel("Commands"));
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("help");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/help"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI explains its safety and trust boundary locally", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-safety-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-unavailable", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeHelp = fixture.output().length;
    fixture.write("/help safety\r");
    const outcome = await Promise.race([
      fixture
        .waitForCompleteFrameAfter("Safety and Trust", beforeHelp)
        .then(() => "safety" as const),
      fixture.waitForAfter("Unknown Help topic safety", beforeHelp).then(() => "unknown" as const),
    ]);
    expect(outcome).toBe("safety");
    const frame = fixture.output().slice(beforeHelp);
    expect(frame).toContain("Default built-in policy");
    expect(frame).toContain("Write/execute: exact-call approval");
    expect(frame).toContain("Built-in file tools");
    expect(frame).toContain("Reject traversal/symlink escape");
    expect(frame).toContain("Shell/MCP: same-user authority");
    expect(frame).toContain("Extensions: trusted in-process code");
    expect(frame).toContain("Credentials: external plaintext");
    expect(frame).toContain("State/artifacts: owner-only local");
    expect(frame).toContain("No OS/process/network sandbox");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/help safety"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Escape closes the Help root and restores editor focus", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-escape-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/help\r");
    await fixture.waitFor("Adam Help");
    fixture.write("\u001b[27;1;27~draft after Help");
    fixture.write("\u0011");
    await waitForPath(join(controlRoot, "clipboard.txt"));
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("draft after Help");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Escape returns from a Help topic to the Help root", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-parent-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeTopic = fixture.output().length;
    fixture.write("/help commands");
    await fixture.waitForAfter("Command names, arguments, and aliases", beforeTopic);
    fixture.write("\t\r");
    const opened = await Promise.race([
      fixture.waitForAfter("Command Reference", beforeTopic).then(() => "topic" as const),
      fixture.waitForAfter("Adam Help", beforeTopic).then(() => "root" as const),
    ]);
    expect(opened).toBe("topic");
    const beforeParent = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForAfter("Adam Help", beforeParent);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Enter opens the focused topic in the Help navigator", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-enter-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/help\r");
    await fixture.waitFor("Adam Help");
    const beforeTopic = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Command Reference", beforeTopic);
    expectFramedOverlay(fixture.output().slice(beforeTopic), "Command Reference");
    expect(fixture.output().slice(beforeTopic)).toContain(
      "\u001b[1m\u001b[38;2;203;166;247m/help [topic]\u001b[39m\u001b[22m",
    );
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(beforeTopic)).toContain("Command Reference");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Hotkeys opens the shared local Help navigator", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-hotkeys-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeHotkeys = fixture.output().length;
    fixture.write("/hotkeys\r");
    const outcome = await Promise.race([
      fixture
        .waitForCompleteFrameAfter("Effective Hotkeys", beforeHotkeys)
        .then(() => "hotkeys" as const),
      fixture.waitForAfter("Skill selection complete.", beforeHotkeys).then(() => "model" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(beforeHotkeys), "Effective Hotkeys");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("hotkeys");
    expect(fixture.output().slice(beforeHotkeys)).toContain("Ctrl+T");
    expect(fixture.output().slice(beforeHotkeys)).toContain("Ctrl+R");
    expect(fixture.output().slice(beforeHotkeys)).toContain("Ctrl+N");
    expect(fixture.output().slice(beforeHotkeys)).toContain("Ctrl+F");
    expect(fixture.output().slice(beforeHotkeys)).toContain("Ctrl+S");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/hotkeys"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+C closes the complete Help stack without arming idle exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-control-c-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/hotkeys\r");
    await fixture.waitFor("Effective Hotkeys");
    const beforeClose = fixture.output().length;
    fixture.write("\u0003");
    fixture.write("draft after Help");
    fixture.write("\u0003");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Clipboard unavailable; draft was not copied.");
    expect(result.stdout.slice(beforeClose)).not.toContain(
      "Press Ctrl+C again within two seconds to exit",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("question mark remains ordinary editor input instead of a Help binding", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-question-mark-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeDraft = fixture.output().length;
    fixture.write("?");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("?");
    expect(result.stdout.slice(beforeDraft)).not.toContain("Adam Help");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes a slash command from the local Registry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeCompletion = fixture.output().length;
    fixture.write("/hot");
    await fixture.waitForAfter("Show the fixed effective keyboard map.", beforeCompletion);
    fixture.write("\t\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Effective Hotkeys", beforeCompletion).then(() => "completed" as const),
      fixture
        .waitForAfter("Skill selection complete.", beforeCompletion)
        .then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("completed");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Registry discovers the no-argument review command without sending it to the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-registry-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-unavailable", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeCompletion = fixture.output().length;
    fixture.write("/rev");
    await fixture.waitForAfter("Review project changes", beforeCompletion);
    fixture.write("\t\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("No active extension command can admit project changes.", beforeCompletion)
        .then(() => "rejected" as const),
      fixture
        .waitForAfter("Skill selection complete.", beforeCompletion)
        .then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("rejected");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an admitted project review renders one inline generic operation card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-operation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-operation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    await fixture.resize(120, 40);
    const beforeReview = fixture.output().length;
    fixture.write("/review\r");
    await fixture.waitForCompleteFrameAfter("fixture.review-extension@1.0.0", beforeReview);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeReview)).join("\n");
    expect(frame).toContain("fixture.review-extension@1.0.0");
    expect(frame).toContain("fixture.local-worktree-review@1");
    expect(frame).toContain("Running · analyzing project changes");
    expect(frame.match(/fixture\.local-worktree-review@1/gu)).toHaveLength(1);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("an active operation card keeps its status, action, identity, and draft through 120, 80, and 40 columns", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-responsive-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-operation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/review\r");
    await fixture.waitFor("Ctrl+C cancel");
    fixture.write("preserved review draft");

    let operationId: string | undefined;
    for (const columns of [120, 80, 40]) {
      const beforeResize = fixture.output().length;
      await fixture.resize(columns, 40);
      await fixture.waitForCompleteFrameAfter("Ctrl+C cancel", beforeResize);
      const lines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
      const frame = lines.join("\n");
      expect(frame).toContain("Running");
      expect(frame).toContain("Ctrl+C cancel");
      expect(frame).toContain("preserved review draft");
      expect(frame).toContain("fixture.review-extension@1.0.0");
      expect(frame).toContain("fixture.local-worktree-review@1");
      expect(frame).toContain("descriptor");
      if (columns === 120) {
        operationId = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u.exec(
          frame,
        )?.[0];
        expect(operationId).toBeDefined();
      }
      expect(frame).toContain(operationId);
      expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("a 40-column operation card keeps exact long provenance identities reachable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-long-provenance-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const extensionId = `fixture.review-extension.${"extension-segment.".repeat(4)}final`;
  const contributionId = `fixture.local-worktree-review.${"contribution-segment.".repeat(4)}final@1`;
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      noColor: true,
      scenario: "review-operation-long-provenance",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/review\r");
    await fixture.waitFor("Ctrl+C cancel");
    const beforeResize = fixture.output().length;
    await fixture.resize(40, 60);
    await fixture.waitForCompleteFrameAfter("Ctrl+C cancel", beforeResize);
    const lines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    const compactFrame = lines
      .map((line) =>
        line
          .replaceAll("\u001b]8;;\u0007", "")
          .replaceAll("\u001b[0m", "")
          .replaceAll("\u001b[7m", "")
          .trim(),
      )
      .join("");
    expect(compactFrame).toContain(extensionId);
    expect(compactFrame).toContain(contributionId);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("Ctrl+C cancels only an actionable linked review and waits for durable settlement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-operation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/review\r");
    await fixture.waitFor("Ctrl+C cancel");
    const beforeCancel = fixture.output().length;
    fixture.write("\u0003");
    await fixture.waitForCompleteFrameAfter("Cancelled · caller", beforeCancel);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeCancel)).join("\n");
    expect(frame).toContain("Cancelled · caller");
    expect(frame).not.toContain("Ctrl+C cancel");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("a completed linked review opens its bounded generic report through slash Artifacts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-report-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "review-completed",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    await fixture.resize(120, 40);
    fixture.write("/review\r");
    await fixture.waitFor("Completed");
    await fixture.waitFor("Review project changes admitted.");
    expect(fixture.output()).toContain("Report · fixture.review-result@1 · application/json");
    const beforeArtifacts = fixture.output().length;
    fixture.write("/artifacts\r");
    await fixture.waitForCompleteFrameAfter("Session artifacts", beforeArtifacts);
    expect(latestSynchronizedFrame(fixture.output().slice(beforeArtifacts)).join("\n")).toContain(
      "Review project changes report",
    );
    const beforeOpen = fixture.output().length;
    fixture.write("\r");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await fixture.waitForAfter('"reviewed":true', beforeOpen);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("Ctrl+R recovers only an eligible linked review from durable operation evidence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-recovery-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "review-recovery",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/review\r");
    await fixture.waitFor("Ctrl+R recover");
    const beforeRecovery = fixture.output().length;
    fixture.write("\u0012");
    await waitForPath(join(controlRoot, "operation-recover-submitted"));
    await fixture.waitForCompleteFrameAfter("Completed", beforeRecovery);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeRecovery)).join("\n");
    expect(frame).toContain("Completed");
    expect(frame).not.toContain("Ctrl+R recover");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("review arguments are rejected locally with descriptor-owned usage", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-review-usage-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "review-unavailable", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/review extra\r");
    await fixture.waitFor("Usage: /review");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/review extra"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}, 5_000);

test("slash completion exposes Registry usage as its argument hint", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-usage-hint-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeCompletion = fixture.output().length;
    fixture.write("/he");
    await fixture.waitForAfter("/help [topic]", beforeCompletion);
    expect(fixture.output().slice(beforeCompletion)).toContain(keywordLabel("/help"));
    fixture.write("\t\r");
    await fixture.waitForAfter("Adam Help", beforeCompletion);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the idle footer exposes Registry-driven interaction hints", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-footer-hints-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    await fixture.resize(120, 40);
    await fixture.waitFor("/help [topic] · /hotkeys · Tab complete");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the footer exposes authoritative project context and run facts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-footer-facts-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    await fixture.resize(120, 40);
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitFor("Adam · Streaming session");
    const beforeCompaction = fixture.output().length;
    fixture.write("Continue after the large answer\r");
    await fixture.waitForCompleteFrameAfter("Working", beforeCompaction);
    const afterWorking = fixture.output().length;
    await fixture.waitForAfter("Context compacted · window 1", beforeCompaction);
    const secondAssistantSummary = "· 270058 bytes · /artifacts to inspect";
    await fixture.waitForAfter(secondAssistantSummary, afterWorking);
    const afterAssistant = fixture.output().lastIndexOf(secondAssistantSummary);
    await fixture.waitForCompleteFrameAfter("context · estimated · idle", afterAssistant);
    expect(fixture.output()).toMatch(/workspace · \d+\/32768 context · estimated · idle/u);

    let beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForAfter("context · estimated · idle", beforeResize);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toMatch(/workspace · \d+\/32768 context · estimated · idle/u);

    beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    await fixture.waitForCompleteFrameAfter("32.8k est", beforeResize);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toMatch(/idle · ctx [\d.]+(?:k|m)?\/32\.8k est/u);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the footer distinguishes provider-reported context occupancy at every width", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-footer-provider-context-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "provider-usage", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Report exact usage\r");
    await fixture.waitFor("Provider usage answer.");
    await fixture.waitForAfter(" · idle", beforePrompt);
    expect(await readFilesRecursively(stateRoot)).toContain('"inputTokens":12345');

    let beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("workspace · 12345/32768 context · provider reported · idle");

    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("workspace · 12345/32768 context · provider reported · idle");

    beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("idle · ctx 12.3k/32.8k reported");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the footer distinguishes unknown context occupancy at every width", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-footer-unknown-context-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "provider-no-usage", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Report usage availability\r");
    await fixture.waitForAfter("Provider usage unavailable.", beforePrompt);
    await fixture.waitForAfter("context · unknown · idle", beforePrompt);

    let beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    await fixture.waitForCompleteFrameAfter("context · unknown · idle", beforeResize);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("workspace · ?/32768 context · unknown · idle");

    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForCompleteFrameAfter("context · unknown · idle", beforeResize);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("workspace · ?/32768 context · unknown · idle");

    beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    await fixture.waitForCompleteFrameAfter("ctx ?/32.8k unknown", beforeResize);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).toContain("idle · ctx ?/32.8k unknown");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab accepts a fuzzy slash-command suggestion from the Registry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-fuzzy-slash-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/nme");
    await fixture.waitFor("/name <text|--clear|--generate>");
    fixture.write("\t");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("/name");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes an authoritative project path without reading the file", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tab-path-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "src", "alpha.ts"), "PRIVATE_ALPHA_BYTES\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("src/al");
    await fixture.waitFor("src/al");
    const beforeTab = fixture.output().length;
    fixture.write("\t");
    await fixture.waitForAfter("src/alpha.ts", beforeTab);
    fixture.write("\u0011");
    await waitForPath(join(controlRoot, "clipboard.txt"));
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("src/alpha.ts");
    expect(result.stdout).not.toContain("PRIVATE_ALPHA_BYTES");
    expect(await readFilesRecursively(stateRoot)).not.toContain("PRIVATE_ALPHA_BYTES");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes an authoritative project path on a later multiline draft line", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tab-multiline-path-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "src", "alpha.ts"), "private\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("first line\u000asrc/al");
    await fixture.waitFor("src/al");
    fixture.write("\t");
    await fixture.waitFor("src/alpha.ts");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe(
      "first line\nsrc/alpha.ts",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab path completion renders terminal controls from filenames as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tab-path-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "src", `evil${unsafeSequence}.ts`), "private\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("src/ev");
    await fixture.waitFor("src/ev");
    fixture.write("\t");
    await fixture.waitFor("src/evil.ts");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("src/evil.ts");
    expect(result.stdout).not.toContain(unsafeSequence);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the at path selector opens only at a token boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-at-boundary-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "README.md"), "PRIVATE_README_BYTES\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeDraft = fixture.output().length;
    fixture.write("email@example@");
    fixture.write("\u0011");
    await waitForPath(join(controlRoot, "clipboard.txt"));
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("email@example@");
    expect(result.stdout.slice(beforeDraft)).not.toContain("Select a project path");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes an exact qualified Skill argument from authoritative catalog metadata", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(join(workspaceRoot, ".agents", "skills", "first"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".agents", "skills", "first", "SKILL.md"),
    "---\nname: first\ndescription: First completion procedure.\n---\nFirst body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills skill:v1:project:.:fir");
    await fixture.waitFor("First completion procedure.");
    fixture.write("\t\r");
    const outcome = await Promise.race([
      fixture.waitFor("1 Skill selected").then(() => "selected" as const),
      fixture.waitFor("Skill selection complete.").then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("selected");
    expect(await readFilesRecursively(stateRoot)).not.toContain(
      '"text":"/skills skill:v1:project:.:first"',
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes and admits a Skill mention from the current first-draft catalog", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-draft-skill-mention-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "first");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: first\ndescription: First mention completion procedure.\n---\nFIRST_MENTION_BODY\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Use $fir");
    await fixture.waitFor("$first");
    fixture.write("\t");
    await fixture.waitFor("Use $first");
    fixture.write("\r");
    await fixture.waitFor("Skill selection complete.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const durableState = await readFilesRecursively(stateRoot);
    expect(durableState).toContain('"qualifiedId":"skill:v1:project:.:first"');
    expect(durableState).toContain('"reason":"user_explicit"');
    expect(durableState).toContain('"userMessage":"Use $first"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes a Help topic argument from the Registry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-topic-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeCompletion = fixture.output().length;
    fixture.write("/help hot");
    await fixture.waitForAfter("Fixed effective keyboard bindings", beforeCompletion);
    expect(fixture.output().slice(beforeCompletion)).toContain(keywordLabel("hotkeys"));
    fixture.write("\t\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Effective Hotkeys", beforeCompletion).then(() => "hotkeys" as const),
      fixture.waitForAfter("Adam Help", beforeCompletion).then(() => "root" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("hotkeys");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("NO_COLOR keeps slash, Help-topic, and first-level Help labels plain", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-labels-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ noColor: true, stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    let beforeAction = fixture.output().length;
    fixture.write("/help hot");
    await fixture.waitForCompleteFrameAfter("Fixed effective keyboard bindings", beforeAction);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeAction)).join("\n");
    expect(frame).toContain("> hotkeys");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");
    fixture.write("\t\r");
    await fixture.waitForAfter("Effective Hotkeys", beforeAction);

    beforeAction = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForCompleteFrameAfter("Adam Help", beforeAction);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeAction)).join("\n");
    expect(frame).toContain("Commands  Command names, arguments, and aliases");
    expect(frame).toContain("> Hotkeys  Fixed effective keyboard bindings");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an unknown Help topic is rejected locally with a Registry suggestion", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-topic-unknown-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeTopic = fixture.output().length;
    fixture.write("/help htokeys\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("Unknown Help topic htokeys · Did you mean hotkeys?", beforeTopic)
        .then(() => "rejected" as const),
      fixture.waitForAfter("Adam Help", beforeTopic).then(() => "root" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("rejected");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Help exposes the effective Pi Editor hotkeys on a dedicated topic", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-editor-hotkeys-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeTopic = fixture.output().length;
    fixture.write("/help editor");
    await fixture.waitFor("Pi Editor navigation and editing bindings");
    fixture.write("\t\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Editor Hotkeys", beforeTopic).then(() => "editor" as const),
      fixture.waitForAfter("Unknown Help topic editor", beforeTopic).then(() => "unknown" as const),
    ]);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("editor");
    expect(result.stdout).toContain("Ctrl+W / Alt+Backspace");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("resume rebuilds prompt history from active authoritative chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-prompt-history-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("History prompt 3");
    fixture.write("\u001b[A");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("History prompt 3");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("restored prompt history renders terminal controls as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-unsafe-history-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "unsafe-history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Visible history");
    fixture.write("\u001b[A");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("Visible history");
    expect(result.stdout).not.toContain(unsafeSequence);
    expect(result.stdout).not.toContain("\u202E");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("session selection rebuilds prompt history from the selected authoritative chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-selected-history-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "session-selection-history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    fixture.write("Selected");
    await fixture.waitFor("Search: Selected");
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Selected session prompt", beforeSelection);
    fixture.write("\u001b[A");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe(
      "Selected session prompt",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Resume opens the project session catalog from an active session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-resume-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeResume = fixture.output().length;
    fixture.write("/resume\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Select a project session", beforeResume).then(() => "catalog" as const),
      fixture.waitForAfter("Skill selection complete.", beforeResume).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("catalog");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/resume"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("successful session selection feedback expires when editing begins", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-session-feedback-lifetime-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      scenario: "session-selection-history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    fixture.write("Selected");
    await fixture.waitFor("Search: Selected");
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("✓ Session selected.", beforeSelection);
    const beforeDraft = fixture.output().length;
    fixture.write("A later draft");
    await fixture.waitForCompleteFrameAfter("A later draft", beforeDraft);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeDraft)).join("\n");

    expect(frame).not.toContain("Session selected.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash New requires an exact target before creating another session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-new-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeNew = fixture.output().length;
    fixture.write("/new \r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Select an exact model target", beforeNew).then(() => "target" as const),
      fixture.waitForAfter("Skill selection complete.", beforeNew).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("target");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/new"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Session opens bounded authoritative session and context facts", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-session-facts-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    const beforeSession = fixture.output().length;
    fixture.write("/session \r");
    const outcome = await Promise.race([
      fixture
        .waitForCompleteFrameAfter("Session facts", beforeSession)
        .then(() => "facts" as const),
      fixture.waitForAfter("History answer.", beforeSession).then(() => "model" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(beforeSession), "Session facts");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("facts");
    expect(result.stdout.slice(beforeSession)).toContain("Target  fake.local");
    expect(result.stdout.slice(beforeSession)).toContain("Status  settled");
    expect(result.stdout.slice(beforeSession)).toContain("Chronology");
    expect(result.stdout.slice(beforeSession)).toContain("Context");
    expect(result.stdout.slice(beforeSession)).toContain("Usage");
    expect(result.stdout.slice(beforeSession)).toContain("Compaction");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/session"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Tree opens a read-only browser over visible complete chronology boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tree-browser-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    const beforeTree = fixture.output().length;
    fixture.write("/tree \r");
    await fixture.waitForCompleteFrameAfter("Active chronology · read only", beforeTree);
    expectFramedOverlay(fixture.output().slice(beforeTree), "Active chronology · read only");
    fixture.write("prompt3");
    await fixture.waitForAfter("Search: prompt3", beforeTree);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(beforeTree)).toContain("History prompt 3");
    expect(result.stdout.slice(beforeTree)).toContain("complete boundary");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/tree"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("read-only Tree selection focuses a loaded conversation without mutating durable chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tree-focus-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 12 });
  const execution = runTuiFixture({ scenario: "history", stateRoot, terminal, workspaceRoot });

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "History answer.");
    const durableStateBeforeFocus = await readFilesRecursively(stateRoot);
    await inputAndWaitForPhysicalFrame(terminal, "/tree\r");
    await waitForPhysicalText(terminal, "Active chronology · read only");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[B");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    expect(terminal.lines().join("\n")).toContain("History prompt 2");
    await inputAndWaitForPhysicalFrame(terminal, "\r");

    expect(terminal.lines().join("\n")).not.toContain("Active chronology · read only");
    expect(terminal.lines().join("\n")).toContain("History prompt 2");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeFocus);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("prompt history navigation restores the exact draft after returning past newest", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-history-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    fixture.write("unsent draft");
    fixture.write("\u001b[A");
    fixture.write("\u001b[B");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("unsent draft");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an unknown slash command is rejected locally with a fuzzy suggestion", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-unknown-command-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeUnknown = fixture.output().length;
    fixture.write("/hepl\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("Unknown command /hepl · Did you mean /help?", beforeUnknown)
        .then(() => "rejected" as const),
      fixture.waitForAfter("Skill selection complete.", beforeUnknown).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("rejected");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/hepl"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("malformed slash input is rejected locally instead of reaching the model", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-malformed-command-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeMalformed = fixture.output().length;
    fixture.write("/help!\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("Unknown command /help!", beforeMalformed)
        .then(() => "rejected" as const),
      fixture
        .waitForAfter("Skill selection complete.", beforeMalformed)
        .then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("rejected");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/help!"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("invalid arguments for a known command are rejected locally with Registry usage", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-command-usage-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeInvalid = fixture.output().length;
    fixture.write("/mcp unexpected\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Usage: /mcp", beforeInvalid).then(() => "usage" as const),
      fixture.waitForAfter("Skill selection complete.", beforeInvalid).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("usage");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/mcp unexpected"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Help remains locally available while a model run is active", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Start a held run\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");
    const beforeHelp = fixture.output().length;
    fixture.write("/help");
    await fixture.waitForAfter("Browse Adam commands and interaction help.", beforeHelp);
    fixture.write("\t\r");
    await fixture.waitForAfter("Adam Help", beforeHelp);
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    fixture.write("\u001b[27;1;27~");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(beforeHelp)).toContain("Adam Help");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/help"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("thinking selection changed during a run applies only to the next prompt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-thinking-policy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/thinking max\r");
    await fixture.waitFor("Thinking Max selected for the next prompt.");
    fixture.write("First held prompt\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");

    const beforeNextSelection = fixture.output().length;
    fixture.write("/thinking off\r");
    await fixture.waitForAfter("Thinking Off selected for the next prompt.", beforeNextSelection);
    await fixture.waitForAfter("Next thinking Off", beforeNextSelection);
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Thinking policy: max.");
    await fixture.waitFor("Adam · Streaming session");
    const beforeSecondPrompt = fixture.output().length;
    fixture.write("Second prompt\r");
    await fixture.waitForAfter("Thinking policy: off.", beforeSecondPrompt);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Tab completes a thinking level from the exact current target without model admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-thinking-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeCompletion = fixture.output().length;
    fixture.write("/thinking ma");
    await fixture.waitForAfter("max", beforeCompletion);
    fixture.write("\t\r");
    await fixture.waitForAfter("Thinking Max selected for the next prompt.", beforeCompletion);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(access(join(controlRoot, "model-started"))).rejects.toThrow();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Thinking opens the framed exact-level selector without admitting a prompt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-thinking-picker-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforePicker = fixture.output().length;
    fixture.write("/thinking\r");
    await fixture.waitForCompleteFrameAfter("Thinking level for the next prompt", beforePicker);
    expectFramedOverlay(fixture.output(), "Thinking level for the next prompt");
    await fixture.waitFor("Off");
    await fixture.waitFor("Low");
    await fixture.waitFor("High");
    await fixture.waitFor("Max");
    fixture.write("\u001b[B\r");
    await fixture.waitFor("Thinking Max selected for the next prompt.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(access(join(controlRoot, "model-started"))).rejects.toThrow();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Thinking selector keeps keyboard focus visible without color", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-thinking-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      noColor: true,
      scenario: "streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePicker = fixture.output().length;
    fixture.write("/thinking\r");
    await fixture.waitForCompleteFrameAfter("Thinking level for the next prompt", beforePicker);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforePicker)).join("\n");
    expect(frame).toContain("> High");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");

    const beforeClose = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForAfter("\u001b[?2026l", beforeClose);
    expect(fixture.screen()?.join("\n")).toContain("Next thinking High");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("editor submission renders Working then a streamed Markdown answer from real Presentation truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-streaming-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Explain streaming\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("\u001b[48;2;49;50;68m");
    expect(result.stdout).toContain("\u001b[38;2;243;139;168m");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+T expands cumulative live provider reasoning and preserves disclosure through completion", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-streaming-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "reasoning-streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Reason before answering\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Thinking · provider reasoning · adam");
    let beforeFrame = fixture.output().length;
    await fixture.resize(80, 24);
    let frame = latestSynchronizedFrame(fixture.output().slice(beforeFrame)).join("\n");
    expect(frame).not.toContain("Inspect ");
    expect(frame).not.toContain("Working");
    expect(frame).not.toContain("╭");

    fixture.write("\u0014");
    await fixture.waitFor("Inspect ");
    beforeFrame = fixture.output().length;
    fixture.write("\u001b[116;5:2u");
    await fixture.resize(79, 24);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeFrame)).join("\n");
    expect(frame).toContain("Inspect ");
    expect(frame).toContain("╭");
    expect(frame).toContain("╮");
    expect(frame).toContain("╰");
    expect(frame).toContain("╯");
    beforeFrame = fixture.output().length;
    fixture.write("\u001b[116;5:3u");
    await fixture.resize(40, 12);
    let lines = latestSynchronizedFrame(fixture.output().slice(beforeFrame));
    frame = lines.join("\n");
    expect(frame).toContain("▾ Thinking");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);

    beforeFrame = fixture.output().length;
    await writeFile(join(controlRoot, "release-reasoning"), "release\n", "utf8");
    await fixture.resize(120, 40);
    await fixture.waitForAfter("Inspect the evidence.", beforeFrame);
    lines = fixture.screen() ?? [];
    expect(lines.join("\n")).toContain("Inspect the evidence.");
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);

    const beforeCompletion = fixture.output().length;
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Thinking done · adam");
    await fixture.waitFor("Reasoning answer.");
    await fixture.waitForAfter(" · idle", beforeCompletion);
    await fixture.waitForAfter("Adam · Streaming session", beforeCompletion);
    beforeFrame = fixture.output().length;
    await fixture.resize(80, 24);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeFrame)).join("\n");
    expect(frame).toContain("Inspect the evidence.");
    expect(frame).not.toContain("Working");
    fixture.write("/copy\r");
    await fixture.waitFor("Copied last assistant response.");
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(
      "Reasoning answer.",
    );
    fixture.write("/session\r");
    await fixture.waitFor("Session facts");
    beforeFrame = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    fixture.write("session inspector focus restored");
    await fixture.waitForCompleteFrameAfter("session inspector focus restored", beforeFrame);
    fixture.write("\u0015");

    fixture.write("/resume\r");
    await fixture.waitFor("Select a project session");
    beforeFrame = fixture.output().length;
    fixture.write("fake.local\r");
    await fixture.waitForCompleteFrameAfter("Thinking done · adam", beforeFrame);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeFrame)).join("\n");
    expect(frame).not.toContain("Inspect the evidence.");
    const beforeReopenToggle = fixture.output().length;
    fixture.write("\u0014");
    await fixture.waitForAfter("\u001b[?2026l", beforeReopenToggle);
    fixture.write("\u001b[6~");
    await fixture.waitForAfter("Inspect the evidence.", beforeFrame);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repeated completed reasoning folds keep the selected block visible without duplicating durable output", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-viewport-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 40, rows: 12 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-streaming",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Reason before answering\r");
    await waitForPath(join(controlRoot, "model-started"));
    await writeFile(join(controlRoot, "release-reasoning"), "release\n", "utf8");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await waitForPhysicalText(terminal, "Adam · Streaming session");
    const durableStateBeforeFolds = await readFilesRecursively(stateRoot);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await inputAndWaitForPhysicalFrame(terminal, "\u0014");
      expect(terminal.lines().join("\n")).toContain("▾ Thinking done · adam");
      await inputAndWaitForPhysicalFrame(terminal, "\u0014");
      expect(terminal.lines().join("\n")).toContain("▸ Thinking done · adam");
    }

    const durableState = await readFilesRecursively(stateRoot);
    expect(durableState).toBe(durableStateBeforeFolds);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("mouse wheel scrolls expanded reasoning and the transcript remains movable after folding", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-mouse-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    scenario: "reasoning-viewport",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Inspect a long reasoning block\r");
    await waitForPhysicalText(terminal, "Reasoning viewport answer 1.");
    expect(terminal.output()).toContain("\u001b[?1000h");
    expect(terminal.lines().join("\n")).not.toContain("Wheel/PageUp/PageDown scroll · Ctrl+T fold");
    expect(terminal.lines().join("\n")).toContain("▸ Thinking done · adam · Ctrl+T expand");
    const collapsedTitleRow = terminal
      .lines()
      .findIndex((line) => line.includes("▸ Thinking done"));
    expect(collapsedTitleRow).toBeGreaterThanOrEqual(0);

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).toContain("▾ Thinking done · adam · Ctrl+T fold");
    expect(terminal.lines().join("\n")).toContain("Reasoning viewport turn 1 line 01");
    expect(terminal.lines().findIndex((line) => line.includes("▾ Thinking done"))).toBe(
      collapsedTitleRow,
    );

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;20;5M".repeat(20));
    expect(terminal.lines().join("\n")).toContain("Reasoning viewport turn 1 line 20");

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).toContain("▸ Thinking done · adam · Ctrl+T expand");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<64;20;5M".repeat(20));
    expect(terminal.lines().join("\n")).toContain("Inspect a long reasoning block");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a conditional notice row preserves the scrolled transcript anchor when it appears and clears", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-notice-viewport-anchor-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    scenario: "reasoning-viewport",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Inspect notice viewport stability\r");
    await waitForPhysicalText(terminal, "Reasoning viewport answer 1.");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;20;5M".repeat(12));
    const anchoredLine = terminal
      .lines()
      .find((line) => line.includes("Reasoning viewport turn 1 line"));
    expect(anchoredLine).toBeDefined();
    const anchoredRow = terminal.lines().indexOf(anchoredLine ?? "");

    terminal.input("/exit extra\r");
    await waitForPhysicalText(terminal, "! Usage: /exit");
    expect(terminal.lines().indexOf(anchoredLine ?? "")).toBe(anchoredRow);

    await inputAndWaitForPhysicalFrame(terminal, "/e");
    expect(terminal.lines().join("\n")).not.toContain("Usage: /exit");
    expect(terminal.lines().indexOf(anchoredLine ?? "")).toBe(anchoredRow);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("mouse drag copies current-screen text through the bounded Adam clipboard", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mouse-selection-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const copied = Promise.withResolvers<string>();
  const execution = runTuiFixture({
    clipboard: {
      async writeText(text) {
        copied.resolve(text);
        return "copied";
      },
    },
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("\u001b[<0;2;2M\u001b[<32;5;2M\u001b[<0;5;2m");
    await expect(copied.promise).resolves.toContain("Adam");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("mouse capture can be disabled without removing keyboard viewport controls", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-no-mouse-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    mouse: false,
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    expect(terminal.output()).not.toContain("\u001b[?1000h");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[5~");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("live reasoning growth preserves reading until the user returns to the tail", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-live-reasoning-viewport-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-live-viewport",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Inspect live reasoning growth\r");
    await waitForPath(join(controlRoot, "reasoning-live-ready"));
    await waitForPhysicalText(terminal, "Thinking · provider reasoning · adam");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;40;5M".repeat(4));
    const firstVisibleReadingLine = terminal
      .lines()
      .find((line) => line.includes("Reasoning live line"));
    expect(firstVisibleReadingLine).toBeDefined();

    const beforeGrowthFrame = terminal.frame;
    await writeFile(join(controlRoot, "release-live-growth"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-live-grown"));
    await terminal.nextFrame(beforeGrowthFrame);
    expect(terminal.lines()).toContain(firstVisibleReadingLine);

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[F");
    expect(terminal.lines().join("\n")).toContain("Reasoning live line 40");
    const beforeCompletionFrame = terminal.frame;
    await writeFile(join(controlRoot, "release-live-completion"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-live-completed"));
    await terminal.nextFrame(beforeCompletionFrame);
    await waitForPhysicalText(terminal, "Live reasoning answer.");
    await waitForPhysicalText(terminal, " · idle");
    expect(terminal.lines().join("\n")).toContain("Live reasoning answer.");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+T targets visible reasoning before a newer offscreen block", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-target-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 18 });
  const execution = runTuiFixture({
    scenario: "reasoning-multiple",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "Multiple reasoning answer 3.");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<64;40;5M".repeat(20));
    expect(terminal.lines().join("\n")).toContain("Multiple reasoning answer 1.");
    expect(terminal.lines().join("\n")).not.toContain("Multiple reasoning answer 3.");

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    const screen = terminal.lines().join("\n");
    expect(screen).toContain("Reasoning block 1 line 01");
    expect(screen).not.toContain("Reasoning block 3 line 01");

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;40;5M".repeat(30));
    expect(terminal.lines().join("\n")).toContain("Multiple reasoning answer 3.");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).toContain("Reasoning block 3 line 01");

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<64;40;5M".repeat(30));
    expect(terminal.lines().join("\n")).toContain("Reasoning block 1 line 01");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;40;5M".repeat(30));
    expect(terminal.lines().join("\n")).toContain("Reasoning block 3 line 01");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each([
  {
    scenario: "reasoning-cancellation" as const,
    title: "Thinking interrupted · adam",
    marker: "◇",
    action: "cancel" as const,
  },
  {
    scenario: "reasoning-failure" as const,
    title: "Thinking failed · adam",
    marker: "×",
    action: "wait" as const,
  },
])(
  "provider reasoning renders its $action terminal state",
  async ({ action, marker, scenario, title }) => {
    const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-tui-${scenario}-`));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    await mkdir(workspaceRoot);

    try {
      const fixture = startFixture({ noColor: true, scenario, stateRoot, workspaceRoot });
      await fixture.waitFor("Adam · New session");
      const beforePrompt = fixture.output().length;
      fixture.write("Exercise a reasoning terminal state\r");
      if (action === "cancel") {
        await fixture.waitForCompleteFrameAfter(
          "Thinking · provider reasoning · adam",
          beforePrompt,
        );
        fixture.write("\u0003");
      }
      await fixture.waitForCompleteFrameAfter(title, beforePrompt);
      const frame = latestSynchronizedFrame(fixture.output().slice(beforePrompt)).join("\n");
      expect(frame).toContain(`${marker} ▸ ${title}`);
      expect(frame).not.toContain("Inspect terminal state.");
      fixture.write("\u0011");
      await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("Ctrl+T reads artifact-backed provider reasoning without placing it in the collapsed frame", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "reasoning-artifact",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Store provider reasoning out of line\r");
    await fixture.waitForCompleteFrameAfter("Thinking done · adam", beforePrompt);
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    let frame = latestSynchronizedFrame(fixture.output().slice(beforePrompt)).join("\n");
    expect(frame).not.toContain("Artifact reasoning evidence");
    const durableStateBeforeExpand = await readFilesRecursively(stateRoot);

    const beforeExpand = fixture.output().length;
    fixture.write("\u0014");
    await waitForPath(join(controlRoot, "artifact-read-1-range"));
    await expect(readFile(join(controlRoot, "artifact-read-1-range"), "utf8")).resolves.toBe(
      "0:16384\n",
    );
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await fixture.waitForCompleteFrameAfter(
      "Large reasoning · plain view · 1-16384 of 270028 bytes",
      beforeExpand,
    );
    frame = latestSynchronizedFrame(fixture.output().slice(beforeExpand)).join("\n");
    expect(frame).toContain("Large reasoning · plain view");
    const beforePageDown = fixture.output().length;
    fixture.write("\u001b[6~");
    await fixture.waitForCompleteFrameAfter("Reasoning bytes 1-16384", beforePageDown);
    frame = latestSynchronizedFrame(fixture.output().slice(beforePageDown)).join("\n");
    expect(frame).toContain("More reasoning below");
    expect(frame).toContain("Artifact reasoning evidence");
    expect(frame).toContain("Reasoning bytes 1-16384");

    fixture.write("\u001b[<65;20;5M".repeat(250));
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-2-range"), "16384:16384\n"),
    ).resolves.toBe("16384:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-2-settled"));
    await fixture.waitFor("Reasoning bytes 16385-32768");
    const beforeNarrowResize = fixture.output().length;
    await fixture.resize(40, 18);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeNarrowResize)).join("\n");
    expect(frame).toContain("Reasoning bytes 16385-32768");
    const beforeWideResize = fixture.output().length;
    await fixture.resize(80, 24);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeWideResize)).join("\n");
    expect(frame).toContain("Reasoning bytes 16385-32768");
    const beforeFold = fixture.output().length;
    fixture.write("\u0014");
    await fixture.waitForCompleteFrameAfter("Artifact reasoning answer.", beforeFold);
    frame = latestSynchronizedFrame(fixture.output().slice(beforeFold)).join("\n");
    expect(frame).toContain("Thinking done · adam");
    expect(frame).not.toContain("Large reasoning · plain view");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeExpand);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("continued scrolling loads only the adjacent oversized reasoning range", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-adjacent-range-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-artifact",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Traverse provider reasoning ranges\r");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await waitForPhysicalText(terminal, "Thinking done · adam");
    const durableStateBeforeNavigation = await readFilesRecursively(stateRoot);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await waitForPhysicalText(terminal, "Large reasoning · plain view · 1-16384 of 270028 bytes");

    terminal.input("\u001b[<65;40;5M".repeat(250));
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-2-range"), "16384:16384\n"),
    ).resolves.toBe("16384:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-2-settled"));
    await waitForPhysicalText(terminal, "Reasoning bytes 16385-32768");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeNavigation);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("oversized reasoning evicts offscreen ranges by bytes and reloads them on upward traversal", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-range-lru-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-artifact",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  const navigateToUncachedRange = async (readOrdinal: number, offset: number) => {
    terminal.input("\u001b[<65;40;5M".repeat(250));
    await expect(
      waitForFileContents(
        join(controlRoot, `artifact-read-${readOrdinal}-range`),
        `${offset}:16384\n`,
      ),
    ).resolves.toBe(`${offset}:16384\n`);
    await waitForPath(join(controlRoot, `artifact-read-${readOrdinal}-settled`));
    await waitForPhysicalText(terminal, `Reasoning bytes ${offset + 1}-${offset + 16_384}`);
  };
  const navigateToCachedPreviousRange = async (offset: number) => {
    const expected = `Reasoning bytes ${offset + 1}-${offset + 16_384}`;
    for (let step = 0; step < 64; step += 1) {
      await inputAndWaitForPhysicalFrame(terminal, "\u001b[5~");
      const screen = terminal.lines().join("\n");
      if (screen.includes(expected)) {
        return;
      }
      if (screen.includes("↑ More reasoning above · Wheel/PageUp")) {
        await waitForPhysicalText(terminal, expected);
        return;
      }
    }
    throw new Error(`PageUp did not reach ${expected}.`);
  };

  try {
    await terminal.nextFrame(0);
    terminal.input("Exercise bounded reasoning range eviction\r");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await waitForPhysicalText(terminal, "Thinking done · adam");
    const durableStateBeforeNavigation = await readFilesRecursively(stateRoot);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await waitForPhysicalText(terminal, "Large reasoning · plain view · 1-16384 of 270028 bytes");

    for (let page = 1; page <= 9; page += 1) {
      await navigateToUncachedRange(page + 1, page * 16_384);
    }

    for (let page = 8; page >= 2; page -= 1) {
      await navigateToCachedPreviousRange(page * 16_384);
    }
    terminal.input("\u001b[<64;40;5M".repeat(250));
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-11-range"), "16384:16384\n"),
    ).resolves.toBe("16384:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-11-settled"));
    await waitForPhysicalText(terminal, "Reasoning bytes 16385-32768");
    terminal.input("\u001b[<64;40;5M".repeat(250));
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-12-range"), "0:16384\n"),
    ).resolves.toBe("0:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-12-settled"));
    await waitForPhysicalText(terminal, "Reasoning bytes 1-16384");

    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeNavigation);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a late downward reasoning range cannot replace the page selected while it was pending", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-reorder-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-artifact-reorder",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Keep a reordered reasoning range out of the viewport\r");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await waitForPhysicalText(terminal, "Thinking done · adam");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await waitForPhysicalText(terminal, "Large reasoning · plain view · 1-16384 of 270028 bytes");
    terminal.input("\u001b[<65;40;5M".repeat(250));
    await waitForPath(join(controlRoot, "artifact-read-2-settled"));
    await waitForPhysicalText(terminal, "Reasoning bytes 16385-32768");

    terminal.input("\u001b[<65;40;5M".repeat(250));
    await waitForPath(join(controlRoot, "reasoning-page-3-pending"));
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<64;40;5M".repeat(250));
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");
    const durableStateBeforeRelease = await readFilesRecursively(stateRoot);
    const screenBeforeRelease = terminal.lines().join("\n");
    const frameBeforeRelease = terminal.frame;
    await writeFile(join(controlRoot, "release-reasoning-page-3"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "artifact-read-3-settled"));
    await terminal.nextFrame(frameBeforeRelease);

    const screenAfterLateRange = terminal.lines().join("\n");
    expect(screenAfterLateRange).toBe(screenBeforeRelease);
    expect(screenAfterLateRange).not.toContain("Reasoning bytes 32769-49152");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeRelease);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("multiple oversized reasoning blocks share one byte-bounded range cache", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-multi-lru-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 18 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-large-multiple",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  const loadNextRange = async (readOrdinal: number, offset: number) => {
    terminal.input("\u001b[<65;40;5M".repeat(250));
    await expect(
      waitForFileContents(
        join(controlRoot, `artifact-read-${readOrdinal}-range`),
        `${offset}:16384\n`,
      ),
    ).resolves.toBe(`${offset}:16384\n`);
    await waitForPath(join(controlRoot, `artifact-read-${readOrdinal}-settled`));
    await waitForPhysicalText(terminal, `Reasoning bytes ${offset + 1}-${offset + 16_384}`);
  };
  const expectReadFromBlock = async (readOrdinal: number, block: number) => {
    const artifactId = (
      await readFile(join(controlRoot, `artifact-read-${readOrdinal}-id`), "utf8")
    ).trim();
    const artifact = await readFile(
      join(stateRoot, "artifacts", artifactId.replace(/^sha256:/u, "")),
      "utf8",
    );
    expect(artifact.startsWith(`Large reasoning block ${block}\n`)).toBe(true);
  };
  const focusTurn = async (answer: number) => {
    const prompt = `Inspect seeded reasoning block ${answer}`;
    await inputAndWaitForPhysicalFrame(terminal, "/tree\r");
    await waitForPhysicalText(terminal, "Active chronology · read only");
    await inputAndWaitForPhysicalFrame(terminal, `block ${answer}`);
    await waitForPhysicalText(terminal, `Search: block ${answer}`);
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    expect(terminal.lines().join("\n")).not.toContain("Active chronology · read only");
    expect(terminal.lines().join("\n")).toContain(prompt);
    for (let step = 0; step < 10; step += 1) {
      if (terminal.lines().join("\n").includes("Thinking done")) {
        return;
      }
      await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;40;5M");
    }
    throw new Error(`The focused turn did not reveal its reasoning fold: ${prompt}.`);
  };

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "Multiple reasoning answer 3.");
    const durableStateBeforeNavigation = await readFilesRecursively(stateRoot);

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await waitForPhysicalText(terminal, "Large reasoning · plain view · 1-16384 of 270024 bytes");
    await expectReadFromBlock(1, 3);
    for (let page = 1; page <= 5; page += 1) {
      await loadNextRange(page + 1, page * 16_384);
    }
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");

    await focusTurn(2);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-7-range"), "0:16384\n"),
    ).resolves.toBe("0:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-7-settled"));
    await expectReadFromBlock(7, 2);
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");
    await loadNextRange(8, 16_384);
    await loadNextRange(9, 32_768);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");

    await focusTurn(3);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-10-range"), "0:16384\n"),
    ).resolves.toBe("0:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-10-settled"));
    await expectReadFromBlock(10, 3);
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");

    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeNavigation);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("folding oversized reasoning rejects a late range before a clean retry", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-range-race-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-artifact-race",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Hold one provider reasoning range\r");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await waitForPhysicalText(terminal, "Thinking done · adam");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "reasoning-page-read-pending"));

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).toContain("Thinking done · adam");
    expect(terminal.lines().join("\n")).not.toContain("Large reasoning · plain view");
    const durableStateBeforeRelease = await readFilesRecursively(stateRoot);
    await writeFile(join(controlRoot, "release-reasoning-page-read"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[5~");
    expect(terminal.lines().join("\n")).not.toContain("Artifact reasoning evidence");
    expect(terminal.lines().join("\n")).not.toContain("Large reasoning · plain view");

    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-2-range"), "0:16384\n"),
    ).resolves.toBe("0:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-2-settled"));
    await waitForPhysicalText(terminal, "Large reasoning · plain view · 1-16384 of 270028 bytes");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeRelease);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("switching sessions rejects a late oversized reasoning range from the prior session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-session-race-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-artifact-session-race",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "Adam · Reasoning source session");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPath(join(controlRoot, "reasoning-page-read-pending"));

    await inputAndWaitForPhysicalFrame(terminal, "/resume\r");
    await waitForPhysicalText(terminal, "Select a project session");
    await inputAndWaitForPhysicalFrame(terminal, "Switch target session\r");
    await waitForPhysicalText(terminal, "Adam · Switch target session");
    expect(terminal.lines().join("\n")).not.toContain("Large reasoning · plain view");
    const durableStateBeforeRelease = await readFilesRecursively(stateRoot);

    await writeFile(join(controlRoot, "release-reasoning-page-read"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[5~");
    const screenAfterLateRange = terminal.lines().join("\n");
    expect(screenAfterLateRange).toContain("Adam · Switch target session");
    expect(screenAfterLateRange).not.toContain("Large reasoning · plain view");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeRelease);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test.each(["missing", "truncated", "same-size corrupt"] as const)(
  "a %s oversized reasoning artifact fails locally and retries after repair",
  async (failure) => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-unavailable-"));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const controlRoot = join(testRoot, "control");
    await mkdir(workspaceRoot);
    await mkdir(controlRoot);

    try {
      const fixture = startFixture({
        controlRoot,
        scenario: "reasoning-artifact",
        stateRoot,
        workspaceRoot,
      });
      await fixture.waitFor("Adam · New session");
      const beforePrompt = fixture.output().length;
      fixture.write("Recover one unavailable reasoning range\r");
      await fixture.waitForCompleteFrameAfter("Thinking done · adam", beforePrompt);
      await waitForPath(join(controlRoot, "reasoning-session-settled"));
      const artifactRoot = join(stateRoot, "artifacts");
      const artifactRelativePaths = (await readdir(artifactRoot, { recursive: true })).filter(
        (path): path is string => typeof path === "string" && !path.endsWith(".tmp"),
      );
      expect(artifactRelativePaths).toHaveLength(1);
      const artifactPath = join(artifactRoot, artifactRelativePaths[0] as string);
      const artifactBytes = await readFile(artifactPath);
      const jsonlRelativePaths = (await readdir(stateRoot, { recursive: true })).filter(
        (path): path is string => typeof path === "string" && path.endsWith(".jsonl"),
      );
      expect(jsonlRelativePaths.length).toBeGreaterThan(0);
      const jsonlBefore = await Promise.all(
        jsonlRelativePaths.map((path) => readFile(join(stateRoot, path), "utf8")),
      );
      await chmod(artifactPath, 0o600);
      if (failure === "missing") {
        await rename(artifactPath, `${artifactPath}.missing`);
      } else if (failure === "truncated") {
        await writeFile(artifactPath, "truncated", "utf8");
      } else {
        await writeFile(artifactPath, Buffer.alloc(artifactBytes.length, 0x78));
      }

      const beforeFailure = fixture.output().length;
      fixture.write("\u0014");
      await waitForPath(join(controlRoot, "artifact-read-1-settled"));
      const beforeFailureScroll = fixture.output().length;
      fixture.write("\u001b[6~");
      await fixture.waitForAfter("\u001b[?2026l", beforeFailureScroll);
      fixture.write("\u001b[6~");
      await fixture.waitForCompleteFrameAfter("Reasoning range unavailable", beforeFailure);
      if (failure === "missing") {
        await rename(`${artifactPath}.missing`, artifactPath);
      } else {
        await writeFile(artifactPath, artifactBytes);
      }
      await chmod(artifactPath, 0o400);
      fixture.write("\u0014");
      const beforeRetry = fixture.output().length;
      fixture.write("\u0014");
      await expect(
        waitForFileContents(join(controlRoot, "artifact-read-2-range"), "0:16384\n"),
      ).resolves.toBe("0:16384\n");
      await waitForPath(join(controlRoot, "artifact-read-2-settled"));
      await fixture.waitForCompleteFrameAfter(
        "Large reasoning · plain view · 1-16384 of 270028 bytes",
        beforeRetry,
      );
      await expect(
        Promise.all(jsonlRelativePaths.map((path) => readFile(join(stateRoot, path), "utf8"))),
      ).resolves.toEqual(jsonlBefore);

      fixture.write("\u0011");
      await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

test("live reasoning crosses atomically into the bounded plain view without durable UI state", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-live-large-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    controlRoot,
    scenario: "reasoning-large-live",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Cross the live reasoning display threshold\r");
    await waitForPath(join(controlRoot, "reasoning-large-ready"));
    await waitForPhysicalText(terminal, "Thinking · provider reasoning · adam");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).not.toContain("Large reasoning · plain view");
    const durableStateBeforeFolds = await readFilesRecursively(stateRoot);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    expect(terminal.lines().join("\n")).not.toContain("Large reasoning · plain view");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeFolds);
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[F");

    const frameBeforeGrowth = terminal.frame;
    await writeFile(join(controlRoot, "release-reasoning-large-growth"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-large-grown"));
    await terminal.nextFrame(frameBeforeGrowth);
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeFolds);
    expect((await readdir(controlRoot)).some((path) => /^artifact-read-/u.test(path))).toBe(false);

    const frameBeforeCompletion = terminal.frame;
    await writeFile(join(controlRoot, "release-reasoning-large-completion"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-large-completed"));
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    await terminal.nextFrame(frameBeforeCompletion);
    expect((await readdir(controlRoot)).some((path) => /^artifact-read-/u.test(path))).toBe(false);
    const durableStateBeforeArtifactNavigation = await readFilesRecursively(stateRoot);
    terminal.input("\u001b[<64;40;5M".repeat(500));
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-1-range"), "229376:16384\n"),
    ).resolves.toBe("229376:16384\n");
    await waitForPath(join(controlRoot, "artifact-read-1-settled"));
    await waitForPhysicalText(terminal, "Reasoning bytes 229377-245760");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeArtifactNavigation);
    await inputAndWaitForPhysicalFrame(terminal, "\u0014");
    await waitForPhysicalText(terminal, "Large live reasoning answer.");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("provider reasoning disclosure keeps explicit markers without color", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      noColor: true,
      scenario: "reasoning-streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Reason without color\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("▸ Thinking · provider reasoning · adam");
    fixture.write("\u0014");
    await fixture.waitFor("Inspect ");
    const beforeFrame = fixture.output().length;
    await fixture.resize(40, 12);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeFrame)).join("\n");
    expect(frame).toContain("▾ Thinking");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");
    const beforeCompletion = fixture.output().length;
    await writeFile(join(controlRoot, "release-reasoning"), "release\n", "utf8");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.resize(80, 24);
    await fixture.waitForAfter(" · idle", beforeCompletion);
    fixture.write("\u001b[F");
    await fixture.waitForAfter("Reasoning answer.", beforeCompletion);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Session remains read-only and available while a model run is active", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-session-facts-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Start a held run\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");
    const beforeSession = fixture.output().length;
    fixture.write("/session\r");
    await fixture.waitForAfter("Session facts", beforeSession);
    await fixture.waitForAfter("Run     working", beforeSession);
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/session"');
    const beforeClose = fixture.output().length;
    fixture.write("\u0003");
    await fixture.waitForAfter("Working", beforeClose);
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash completion exposes only Registry commands available during an active run", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Start completion hold\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");
    const beforeCompletion = fixture.output().length;
    fixture.write("/");
    await fixture.waitForAfter("Browse Adam commands and interaction help.", beforeCompletion);
    fixture.write("\u001b[27;1;27~");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(beforeCompletion)).toContain(
      "Exit through the authoritative TUI cleanup path.",
    );
    expect(result.stdout.slice(beforeCompletion)).not.toContain(
      "Set, clear, or regenerate the active session name.",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("active-run finite argument families stay unavailable without forced path fallthrough", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-active-argument-completion-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  for (const path of ["c-file", "g-file", "--c-file", "r-file"]) {
    await writeFile(join(workspaceRoot, path), "completion decoy\n", "utf8");
  }

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Start argument completion hold\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Working");

    let columns = 80;
    for (const input of ["/config c", "/trust g", "/name --c", "/instructions r", "/skills r"]) {
      const beforeInput = fixture.output().length;
      fixture.write(input);
      await fixture.waitForCompleteFrameAfter(input, beforeInput);
      const beforeTab = fixture.output().length;
      fixture.write("\t");
      columns += 1;
      await fixture.resize(columns, 24);
      await fixture.waitForCompleteFrameAfter(input, beforeTab);
      fixture.write("z");
      await fixture.waitForCompleteFrameAfter(`${input}z`, beforeTab);
      fixture.write("\u0015");
    }

    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Streaming answer");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("permission preempts Help and restores its exact page after settlement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-help-permission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "mutation-after-release",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Prepare a held edit\r");
    await waitForPath(join(controlRoot, "model-started"));
    fixture.write("/hotkeys");
    await fixture.waitFor("Show the fixed effective keyboard map.");
    fixture.write("\t\r");
    await fixture.waitFor("Effective Hotkeys");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitFor("Permission required");
    const beforeRestore = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForAfter("Effective Hotkeys", beforeRestore);
    await fixture.waitForAfter(" · idle", beforeRestore);
    const beforeParent = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await fixture.waitForAfter("Adam Help", beforeParent);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(beforeParent)).toContain("Adam Help");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("permission settlement restores an existing ordinary overlay as the exact focus owner", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-session-permission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "mutation-after-release-with-continuation-barrier",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Prepare an inspector-held edit\r");
    await waitForPath(join(controlRoot, "model-started"));
    fixture.write("/session\r");
    await fixture.waitFor("Session facts");
    expect(fixture.output()).toContain("Run     working");

    const beforePermission = fixture.output().length;
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await fixture.waitForCompleteFrameAfter("Permission required", beforePermission);
    const beforeRestore = fixture.output().length;
    fixture.write("\u001b[27;1;27~");
    await waitForPath(join(controlRoot, "model-continuation-ready"));
    const beforeRestoredFrame = fixture.output().length;
    await writeFile(join(controlRoot, "release-model-continuation"), "release\n", "utf8");
    await fixture.waitForCompleteFrameAfter("Session facts", beforeRestoredFrame);
    const restoredOutput = fixture.output().slice(beforeRestore);
    expect(restoredOutput.lastIndexOf("\u001b[?25l")).toBeGreaterThan(
      restoredOutput.lastIndexOf("\u001b[?25h"),
    );

    fixture.write("\u001b[27;1;27~");
    const beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(frame).not.toContain("Session facts");
    expect(fixture.screen()?.join("\n") ?? "").toContain("Adam · New session");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production editor clears a manual session name through canonical Presentation truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-clear-name-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/name Temporary name\r");
    await fixture.waitFor("Adam · Temporary name");
    const beforeClear = fixture.output().length;
    fixture.write("/name --");
    await fixture.waitForCompleteFrameAfter("--generate", beforeClear);
    fixture.write("\t");
    await fixture.resize(81, 24);
    await fixture.waitForCompleteFrameAfter("/name --clear", beforeClear);
    const beforeSubmit = fixture.output().length;
    fixture.write("\r");
    await expect(
      waitForFileContents(join(controlRoot, "clear-session-name-dispatch-settled"), "admitted\n"),
    ).resolves.toBe("admitted\n");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeSubmit);
    fixture.write("\u0011");
    await fixture.closed;
    expect(fixture.screen()?.join("\n") ?? "").not.toContain("Adam · --clear");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI inspects and reloads repository instruction status through Presentation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-instructions-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const instructionsPath = join(workspaceRoot, "AGENTS.md");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(instructionsPath, "# Rules\n\nFirst revision.\n", "utf8");

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/instructions");
    await fixture.waitFor("/instructions");
    const afterTyping = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("Instructions r1 · scopes . · AGENTS.md · reload available", afterTyping)
        .then(() => "status" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    expect(outcome).toBe("status");
    await writeFile(instructionsPath, "# Rules\n\nSecond revision.\n", "utf8");
    const beforeReload = fixture.output().length;
    fixture.write("/instructions r");
    await fixture.waitForCompleteFrameAfter("reload", beforeReload);
    fixture.write("\t\r");
    await fixture.waitFor("Instructions r2 · scopes . · AGENTS.md · reload available");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(fixture.output()).not.toContain("Second revision.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Reload selects one existing resource authority explicitly", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-resource-reload-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const instructionsPath = join(workspaceRoot, "AGENTS.md");
  await mkdir(workspaceRoot);
  await writeFile(instructionsPath, "# Rules\n\nFirst revision.\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    await writeFile(instructionsPath, "# Rules\n\nSecond revision.\n", "utf8");
    const beforeReload = fixture.output().length;
    fixture.write("/reload \r");
    await fixture.waitForCompleteFrameAfter("Reload project resources", beforeReload);
    expectFramedOverlay(fixture.output().slice(beforeReload), "Reload project resources");
    fixture.write("\r");
    await fixture.waitForAfter("Reloaded repository instructions.", beforeReload);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/reload"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository instruction status exposes bounded diagnostic identities", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-instruction-diagnostics-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "AGENTS.md"), "Masked rules.\n", "utf8");
  await writeFile(join(workspaceRoot, "AGENTS.override.md"), "Active rules.\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/instructions\r");
    await fixture.waitFor("repository_instruction_masked");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("repository_instruction_masked");
    expect(result.stdout).toContain("path AGENTS.md");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI opens exact next-turn Skill metadata instead of submitting a hidden prompt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-palette-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "project-review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: project-review\ndescription: Reviews exact project state.\n---\nPrivate body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills");
    await fixture.waitFor("/skills");
    const afterTyping = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture
        .waitForCompleteFrameAfter("Select next-turn Skills", afterTyping)
        .then(() => "palette" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(afterTyping), "Select next-turn Skills");
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("palette");
    expect(fixture.output()).toContain("skill:v1:project:.:project-review");
    expect(fixture.output()).toContain("Reviews exact project state.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repeated Skill navigation leaves the physical viewport and the next overlay clean", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-viewport-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillRoot = join(workspaceRoot, ".agents", "skills");
  await mkdir(skillRoot, { recursive: true });
  await Promise.all(
    Array.from({ length: 64 }, async (_, index) => {
      const name = `viewport-${String(index).padStart(2, "0")}`;
      const directory = join(skillRoot, name);
      await mkdir(directory);
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Deterministic viewport Skill ${index}.\n---\nBody.\n`,
        "utf8",
      );
    }),
  );
  const terminal = new AppliedViewportTerminal({
    columns: 120,
    commitPendingWrapAtFrameEnd: true,
    rows: 30,
  });
  const execution = runTuiFixture({
    scenario: "history",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    const interactionOutputOffset = terminal.output().length;
    await inputAndWaitForPhysicalFrame(terminal, "/skills");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    expect(terminal.lines().join("\n")).toContain("Select next-turn Skills");
    let maximumSkillRows = 0;
    let minimumUniqueSkillRows = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 56; step += 1) {
      await inputAndWaitForPhysicalFrame(terminal, "\u001b[B");
      const skillRows = terminal.lines().filter((line) => line.includes("skill:v1:"));
      maximumSkillRows = Math.max(maximumSkillRows, skillRows.length);
      minimumUniqueSkillRows = Math.min(minimumUniqueSkillRows, new Set(skillRows).size);
    }

    await inputAndWaitForPhysicalFrame(terminal, "\u001b");
    const afterSkills = terminal.lines().join("\n");
    await inputAndWaitForPhysicalFrame(terminal, "/tree");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    const treeViewport = terminal.lines().join("\n");

    expect({
      maximumSkillRows,
      minimumUniqueSkillRows,
      skillsRemainAfterClose:
        afterSkills.includes("Select next-turn Skills") || afterSkills.includes("skill:v1:"),
      treeOpened: treeViewport.includes("Active chronology"),
      skillsLeakIntoTree:
        treeViewport.includes("Select next-turn Skills") || treeViewport.includes("skill:v1:"),
      scrollbackWasCleared: terminal.output().slice(interactionOutputOffset).includes("\u001b[3J"),
    }).toEqual({
      maximumSkillRows: 8,
      minimumUniqueSkillRows: 8,
      skillsRemainAfterClose: false,
      treeOpened: true,
      skillsLeakIntoTree: false,
      scrollbackWasCleared: false,
    });
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the Skill palette renders untrusted metadata and diagnostic identities as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const validDirectory = join(workspaceRoot, ".agents", "skills", "safe-name");
  const invalidDirectory = join(workspaceRoot, ".agents", "skills", "wrong-file");
  const oversizedDirectory = join(workspaceRoot, ".agents", "skills", "oversized-frontmatter");
  const oversizedFileDirectory = join(workspaceRoot, ".agents", "skills", "oversized-file");
  const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
  await mkdir(validDirectory, { recursive: true });
  await mkdir(invalidDirectory, { recursive: true });
  await mkdir(oversizedDirectory, { recursive: true });
  await mkdir(oversizedFileDirectory, { recursive: true });
  await writeFile(
    join(validDirectory, "SKILL.md"),
    `---\nname: safe-name\ndescription: Safe ${unsafeSequence} description.\n---\nPrivate body.\n`,
    "utf8",
  );
  await writeFile(
    join(invalidDirectory, "skill.md"),
    "---\nname: wrong-file\ndescription: Wrong filename.\n---\n",
    "utf8",
  );
  await writeFile(
    join(oversizedDirectory, "SKILL.md"),
    `---\nname: oversized-frontmatter\ndescription: Must expose its rejected frontmatter bound.\nvendor: ${"x".repeat(16_400)}\n---\n`,
    "utf8",
  );
  await writeFile(join(oversizedFileDirectory, "SKILL.md"), "x".repeat(65_537), "utf8");

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("skill_filename_invalid");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("wrong-file");
    expect(result.stdout).toContain("field skill.md");
    expect(result.stdout).toContain("maximum 16384 bytes");
    expect(result.stdout).toContain("oversized-file");
    expect(result.stdout).toContain("maximum 65536 bytes");
    expect(result.stdout).not.toContain(unsafeSequence);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("idle Ctrl+C closes the Skill palette and returns focus to the editor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-palette-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "project-review");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# Rules\n", "utf8");
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: project-review\ndescription: Reviews exact project state.\n---\nPrivate body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("Select next-turn Skills");
    fixture.write("\u0003");
    fixture.write("/instructions\r");
    await fixture.waitFor("Instructions r1");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI submits exact selected Skills once and clears them only after admission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-selection-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const skillDirectory = join(workspaceRoot, ".agents", "skills", "project-review");
  const qualifiedId = "skill:v1:project:.:project-review";
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: project-review\ndescription: Reviews exact project state.\n---\nPRIVATE_SELECTED_SKILL_BODY\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills");
    await fixture.waitFor("/skills");
    fixture.write("\r");
    await fixture.waitFor("Select next-turn Skills");
    fixture.write("\r");
    await fixture.waitFor("1 Skill selected");
    fixture.write("Apply the selected procedure");
    await fixture.waitFor("Apply the selected procedure");
    fixture.write("\r");
    await fixture.waitFor("Skill selection complete.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const durableState = await readFilesRecursively(stateRoot);
    expect(durableState).toContain(`"qualifiedId":"${qualifiedId}"`);
    expect(durableState).toContain('"reason":"user_explicit"');
    const settledOutput = fixture
      .output()
      .slice(fixture.output().lastIndexOf("Skill selection complete."));
    expect(settledOutput).not.toContain("Skill selected");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI reloads its Skill palette through lifecycle authority", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-reload-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const skillRoot = join(workspaceRoot, ".agents", "skills");
  await mkdir(join(skillRoot, "first"), { recursive: true });
  await mkdir(controlRoot);
  await writeFile(
    join(skillRoot, "first", "SKILL.md"),
    "---\nname: first\ndescription: First procedure.\n---\nFirst body.\n",
    "utf8",
  );

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    await mkdir(join(skillRoot, "second"));
    await writeFile(
      join(skillRoot, "second", "SKILL.md"),
      "---\nname: second\ndescription: Second procedure.\n---\nSecond body.\n",
      "utf8",
    );
    const beforeCompletion = fixture.output().length;
    fixture.write("/skills r");
    await fixture.waitForCompleteFrameAfter("reload", beforeCompletion);
    fixture.write("\t");
    await fixture.waitFor("/skills reload");
    const afterTyping = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Skills r2 · 2 visible", afterTyping).then(() => "reloaded" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    expect(outcome).toBe("reloaded");
    fixture.write("/skills\r");
    await fixture.waitFor("skill:v1:project:.:second");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI opens the bounded project path selector from the at trigger", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-project-paths-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "Private README bytes.\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "alpha.ts"), "Private source bytes.\n", "utf8");

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Open @");
    await fixture.waitForCompleteFrameAfter("Select a project path", 0);
    expectFramedOverlay(fixture.output(), "Select a project path");
    fixture.write("\u0011");
    await fixture.closed;
    expect(fixture.output()).toContain("Select a project path");
    expect(fixture.output()).toContain("README.md");
    expect(fixture.output()).toContain("src/alpha.ts");
    expect(fixture.output()).not.toContain("Private source bytes.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI fuzzy-selects and quotes a normalized project path without reading it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-project-path-insert-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "PRIVATE_README_BYTES\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "alpha.ts"), "PRIVATE_ALPHA_BYTES\n", "utf8");

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Inspect @");
    await fixture.waitFor("Select a project path");
    fixture.write("srca");
    await fixture.waitFor("Filter: srca");
    fixture.write("\r");
    await fixture.waitFor("Inspect `src/alpha.ts`");
    fixture.write("\u0011");
    await fixture.closed;

    const durableState = await readFilesRecursively(stateRoot);
    expect(durableState).not.toContain("src/alpha.ts");
    expect(durableState).not.toContain("PRIVATE_ALPHA_BYTES");
    expect(fixture.output()).not.toContain("PRIVATE_ALPHA_BYTES");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("project path insertion renders terminal controls from filenames as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-project-path-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", `${unsafeSequence}.ts`), "private\n", "utf8");

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Inspect @");
    await fixture.waitFor("Select a project path");
    fixture.write("\r");
    await fixture.waitFor("Inspect `src/.ts`");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain(unsafeSequence);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI loads older authoritative chronology through the current opaque cursor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-history-paging-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    fixture.write("/history\r");
    await fixture.waitFor("History prompt 2");
    fixture.write("/history\r");
    await fixture.waitFor("History prompt 1");
    fixture.write("\u001b[A\u001b[A\u001b[A");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("History prompt 1");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the branch compatibility alias selects an authoritative complete boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-branch-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    const afterTyping = fixture.output().length;
    fixture.write("/branch \r");
    await fixture.waitForAfter("Fork from a boundary", afterTyping);
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Adam · Branch of ", beforeSelection).then(() => "branch" as const),
      fixture.waitForAfter("Working", beforeSelection).then(() => "prompt" as const),
    ]);
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("branch");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Model and Target share an immutable-target transition page", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-target-navigation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "target-navigation", stateRoot, workspaceRoot });
    await fixture.waitForCompleteFrameAfter("Target navigation answer.", 0);
    await fixture.waitForCompleteFrameAfter(" · idle", 0);
    const beforeModel = fixture.output().length;
    fixture.write("/model \r");
    await fixture.waitForAfter("Select an exact model target", beforeModel);
    await fixture.waitForAfter(
      "Current fake.local · existing session target immutable",
      beforeModel,
    );
    fixture.write("other");
    await fixture.waitFor("Search: other");
    fixture.write("\u0006");
    await fixture.waitFor("fake.other · Experimental");
    const beforeTarget = fixture.output().length;
    fixture.write("/target \r");
    await fixture.waitForAfter("Select an exact model target", beforeTarget);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    const durableState = await readFilesRecursively(stateRoot);
    expect(durableState).toContain('"targetId":"fake.local"');
    expect(durableState).toContain('"targetId":"fake.other"');
    expect(durableState).not.toContain('"text":"/model"');
    expect(durableState).not.toContain('"text":"/target"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a real read tool is rendered as a bounded Pi-style tool card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-read-tool-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Fixture\n\nReadable content.\n", "utf8");

  try {
    const fixture = startFixture({ noColor: true, scenario: "read", stateRoot, workspaceRoot });
    await fixture.waitForCompleteFrameAfter("Adam · New session", 0);
    await fixture.waitForCompleteFrameAfter(" · idle", 0);
    fixture.write("Read README\r");
    await fixture.waitFor("read README.md");
    await fixture.waitFor("29 bytes");
    await fixture.waitFor("Read complete");
    await fixture.waitFor("1 │ # Fixture");
    await fixture.waitFor("3 │ Readable content.");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a real repository search is rendered as one bounded read-like tool card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-search-tool-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "alpha.ts"), "export const orchard = 1;\n", "utf8");
  await writeFile(join(workspaceRoot, "beta.ts"), "export const orchard = 2;\n", "utf8");

  try {
    const fixture = startFixture({ noColor: true, scenario: "search", stateRoot, workspaceRoot });
    await fixture.waitForCompleteFrameAfter("Adam · New session", 0);
    await fixture.waitForCompleteFrameAfter(" · idle", 0);
    fixture.write("Search orchard\r");
    await fixture.waitFor("Search complete.");
    expect(fixture.output()).toContain("search .");
    expect(fixture.output()).toContain("2 results");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Kitty Ctrl+O repeat and release phases toggle bounded tool details only once", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tool-details-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "README.md"),
    `${Array.from({ length: 12 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`).join(
      "\n",
    )}\n`,
    "utf8",
  );

  try {
    const fixture = startFixture({ noColor: true, scenario: "read", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Read the README\r");
    await fixture.waitFor("Read complete");
    expect(fixture.output()).toContain("10 │ line10");
    expect(fixture.output()).not.toContain("11 │ line11");
    expect(fixture.output()).not.toContain("provider model response");
    let beforeResize = fixture.output().length;
    await fixture.resize(80, 40);
    const resizedFrame = latestSynchronizedFrame(fixture.output().slice(beforeResize)).join("\n");
    expect(resizedFrame.match(/Ctrl\+O expand/gu)).toHaveLength(1);
    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForAfter("\u001b[?2026l", beforeResize);
    const beforeToolView = fixture.output().length;
    fixture.write("\u001b[5~");
    await fixture.waitForAfter("\u001b[?2026l", beforeToolView);
    const collapsedToolRow = fixture.screen()?.findIndex((line) => line.includes("read README.md"));
    expect(collapsedToolRow).toBeGreaterThanOrEqual(0);
    expect((fixture.screen()?.join("\n") ?? "").match(/Ctrl\+O expand/gu)).toHaveLength(1);
    const beforeExpand = fixture.output().length;
    fixture.write("\u001b[111;5:1u\u001b[111;5:2u\u001b[111;5:2u\u001b[111;5:3u");
    await fixture.waitForAfter("\u001b[?2026l", beforeExpand);
    let screen = fixture.screen()?.join("\n") ?? "";
    expect(fixture.screen()?.findIndex((line) => line.includes("read README.md"))).toBe(
      collapsedToolRow,
    );
    const beforeDetails = fixture.output().length;
    fixture.write("\u001b[6~");
    await fixture.waitForAfter("\u001b[?2026l", beforeDetails);
    screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("12 │ line12");
    const beforeMetadata = fixture.output().length;
    fixture.write("\u001b[6~");
    await fixture.waitForAfter("\u001b[?2026l", beforeMetadata);
    screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("read_file · read · completed · replay safe");
    expect(screen).toContain("provider model response");
    expect(screen).toContain("duration unavailable");
    await fixture.resize(39, 11);
    await fixture.resize(80, 24);
    screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("provider model response");
    const beforeCollapse = fixture.output().length;
    fixture.write("\u000f");
    await fixture.waitForAfter("\u001b[?2026l", beforeCollapse);
    screen = fixture.screen()?.join("\n") ?? "";
    expect(screen).toContain("read README.md · Ctrl+O expand");
    expect(screen).not.toContain("provider model response");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+O targets the visible tool card and keeps other cards independently collapsed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tool-target-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  for (let card = 1; card <= 3; card += 1) {
    await writeFile(
      join(workspaceRoot, `tool-${card}.txt`),
      `${Array.from(
        { length: 12 },
        (_, index) => `tool${card}-line${String(index + 1).padStart(2, "0")}`,
      ).join("\n")}\n`,
      "utf8",
    );
  }
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 18 });
  const execution = runTuiFixture({
    scenario: "tool-multiple",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "Multiple tool answer 3.");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[H");
    await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");
    let screen = terminal.lines().join("\n");
    expect(screen).toContain("read tool-1.txt · Ctrl+O expand");
    expect(screen.match(/Ctrl\+O expand/gu)).toHaveLength(1);
    expect(screen).not.toContain("read tool-3.txt");
    const collapsedToolRow = terminal.lines().findIndex((line) => line.includes("read tool-1.txt"));

    await inputAndWaitForPhysicalFrame(terminal, "\u000f");
    screen = terminal.lines().join("\n");
    expect(terminal.lines().findIndex((line) => line.includes("read tool-1.txt"))).toBe(
      collapsedToolRow,
    );
    expect(screen).toContain("read tool-1.txt · Ctrl+O fold");
    for (let page = 0; page < 4; page += 1) {
      await inputAndWaitForPhysicalFrame(terminal, "\u001b[6~");
    }
    screen = terminal.lines().join("\n");
    expect(screen).toContain("tool1-line12");

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[F");
    screen = terminal.lines().join("\n");
    expect(screen).toContain("Multiple tool answer 3.");
    expect(screen).toContain("2 more projected lines");
    expect(screen).not.toContain("tool3-line12");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("tool disclosure resets across session switches without changing durable JSONL", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tool-session-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  for (let card = 1; card <= 3; card += 1) {
    await writeFile(
      join(workspaceRoot, `tool-${card}.txt`),
      `${Array.from(
        { length: 12 },
        (_, index) => `tool${card}-line${String(index + 1).padStart(2, "0")}`,
      ).join("\n")}\n`,
      "utf8",
    );
  }
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 18 });
  const execution = runTuiFixture({
    scenario: "tool-multiple",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    await waitForPhysicalText(terminal, "Adam · Tool disclosure source session");
    const durableStateBeforeDisclosure = await readFilesRecursively(stateRoot);
    await inputAndWaitForPhysicalFrame(terminal, "\u000f");
    expect(terminal.lines().join("\n")).toContain("Ctrl+O fold");

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[F");
    await inputAndWaitForPhysicalFrame(terminal, "/resume");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    await waitForPhysicalText(terminal, "Select a project session");
    await inputAndWaitForPhysicalFrame(terminal, "Tool disclosure switch session");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    await waitForPhysicalText(terminal, "Adam · Tool disclosure switch session");

    await inputAndWaitForPhysicalFrame(terminal, "/resume");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    await waitForPhysicalText(terminal, "Select a project session");
    await inputAndWaitForPhysicalFrame(terminal, "Tool disclosure source session");
    await inputAndWaitForPhysicalFrame(terminal, "\r");
    await waitForPhysicalText(terminal, "Adam · Tool disclosure source session");
    await inputAndWaitForPhysicalFrame(terminal, "\u000f");
    const screen = terminal.lines().join("\n");
    expect(screen).toContain("read tool-3.txt · Ctrl+O fold");
    expect(await readFilesRecursively(stateRoot)).toBe(durableStateBeforeDisclosure);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a settled write card previews numbered content from its canonical change artifact", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-write-preview-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ noColor: true, scenario: "write", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Create a TypeScript file\r");
    await fixture.waitFor("Permission required");
    await fixture.waitFor("Preview 1-8 of");
    fixture.write("\u001b[6~");
    await fixture.waitFor("+export const value12 = 12;");
    const beforeAllow = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Write complete.", beforeAllow);
    await fixture.waitForAfter(" 1 │ export const value01 = 1;", beforeAllow);
    await fixture.waitForAfter("10 │ export const value10 = 10;", beforeAllow);
    expect(fixture.output().slice(beforeAllow)).not.toContain("11 │ export const value11");
    await expect(readFile(join(workspaceRoot, "created.ts"), "utf8")).resolves.toContain(
      "export const value12 = 12;",
    );
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a settled edit card previews its canonical diff without inventing line coordinates", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-edit-preview-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({ noColor: true, scenario: "mutation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Edit the file\r");
    await fixture.waitFor("Permission required");
    await fixture.waitFor("+after");
    const beforeAllow = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Edit complete.", beforeAllow);
    await fixture.waitForAfter("  - │ before", beforeAllow);
    await fixture.waitForAfter("  + │ after", beforeAllow);
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("after\n");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Copy copies the last inline assistant response without persisting a prompt", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-assistant-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "README.md"), "copy fixture\n", "utf8");

  try {
    const fixture = startFixture({ controlRoot, scenario: "read", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Read the README\r");
    await fixture.waitForCompleteFrameAfter("Read complete", beforePrompt);
    const resultOccurrence = fixture.output().lastIndexOf("Read complete");
    expect(resultOccurrence).toBeGreaterThanOrEqual(beforePrompt);
    await fixture.waitForCompleteFrameAfter(" · idle", resultOccurrence);
    const beforeCopy = fixture.output().length;
    fixture.write("/copy \r");
    const outcome = await Promise.race([
      waitForFileContents(join(controlRoot, "clipboard.txt"), "Read complete.").then(
        () => "copied" as const,
      ),
      fixture.waitForAfter("Unknown command /copy", beforeCopy).then(() => "unknown" as const),
    ]);
    expect(outcome).toBe("copied");
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("Read complete.");
    await fixture.waitForAfter("Copied last assistant response.", beforeCopy);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/copy"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an older asynchronous copy receipt cannot replace newer Usage feedback", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-notice-generation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminal = new VirtualTerminal();
  const copyStarted = Promise.withResolvers<void>();
  const copyResult = Promise.withResolvers<"copied" | "failed" | "unsupported">();
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "copy fixture\n", "utf8");

  const execution = runTuiFixture({
    clipboard: {
      async writeText() {
        copyStarted.resolve();
        return copyResult.promise;
      },
    },
    deadlineScheduler: {
      schedule() {
        return { cancel() {} };
      },
    },
    scenario: "read",
    stateRoot,
    terminal,
    workspaceRoot,
  });
  try {
    await terminal.whenStarted();
    terminal.input("Read the README\r");
    await terminal.nextSynchronizedFrameContaining("Read complete");
    const resultOccurrence = terminal.output().lastIndexOf("Read complete");
    expect(resultOccurrence).toBeGreaterThanOrEqual(0);
    await terminal.nextSynchronizedFrameContaining(" · idle", resultOccurrence);
    terminal.input("/copy\r");
    await copyStarted.promise;
    terminal.input("/exit extra\r");
    await terminal.nextSynchronizedFrameContaining("! Usage: /exit");
    const beforeCopyReceipt = terminal.output().length;
    copyResult.resolve("copied");
    await terminal.nextSynchronizedFrameContaining("! Usage: /exit", beforeCopyReceipt);

    terminal.input("\u0011");
    await expect(execution).resolves.toBeUndefined();
  } finally {
    copyResult.resolve("failed");
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an older asynchronous copy receipt cannot survive a newer overlay action", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-overlay-generation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminal = new VirtualTerminal();
  const copyStarted = Promise.withResolvers<void>();
  const copyResult = Promise.withResolvers<"copied" | "failed" | "unsupported">();
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "copy fixture\n", "utf8");

  const execution = runTuiFixture({
    clipboard: {
      async writeText() {
        copyStarted.resolve();
        return copyResult.promise;
      },
    },
    deadlineScheduler: {
      schedule() {
        return { cancel() {} };
      },
    },
    scenario: "read",
    stateRoot,
    terminal,
    workspaceRoot,
  });
  try {
    await terminal.whenStarted();
    terminal.input("Read the README\r");
    await terminal.nextSynchronizedFrameContaining("Read complete");
    const resultOccurrence = terminal.output().lastIndexOf("Read complete");
    expect(resultOccurrence).toBeGreaterThanOrEqual(0);
    await terminal.nextSynchronizedFrameContaining(" · idle", resultOccurrence);
    terminal.input("/copy\r");
    await copyStarted.promise;
    terminal.input("/session\r");
    await terminal.nextSynchronizedFrameContaining("Session facts");
    const beforeCopyReceipt = terminal.output().length;
    copyResult.resolve("copied");
    await terminal.nextSynchronizedFrameContaining("Session facts", beforeCopyReceipt);
    const beforeClose = terminal.output().length;
    terminal.input("\u001b[27;1;27~");
    await terminal.nextSynchronizedFrameContaining("Adam · Streaming session", beforeClose);

    expect(terminal.lines().join("\n")).not.toContain("Copied last assistant response.");
    terminal.input("\u0011");
    await expect(execution).resolves.toBeUndefined();
  } finally {
    copyResult.resolve("failed");
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Copy never truncates a large inline assistant response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-large-assistant-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "copy-large-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Produce a large inline response\r");
    await fixture.waitForCompleteFrameAfter("Exact copy tail.", beforePrompt);
    const resultOccurrence = fixture.output().lastIndexOf("Exact copy tail.");
    expect(resultOccurrence).toBeGreaterThanOrEqual(beforePrompt);
    await fixture.waitForCompleteFrameAfter(" · idle", resultOccurrence);
    const expected = `${"c".repeat(65 * 1024)}\nExact copy tail.`;
    fixture.write("/copy \r");
    await expect(waitForFileContents(join(controlRoot, "clipboard.txt"), expected)).resolves.toBe(
      expected,
    );
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Copy reads and copies the complete last artifact-backed assistant response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-artifact-assistant-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitForCompleteFrameAfter("Assistant response stored as artifact", beforePrompt);
    const resultOccurrence = fixture.output().lastIndexOf("Assistant response stored as artifact");
    expect(resultOccurrence).toBeGreaterThanOrEqual(beforePrompt);
    await fixture.waitForCompleteFrameAfter(" · idle", resultOccurrence);
    const expected = `Assistant artifact page one\n${"a".repeat(20_000)}\nAssistant artifact page two\n${"b".repeat(250_000)}`;
    fixture.write("/copy \r");
    const copied = await waitForFileContents(join(controlRoot, "clipboard.txt"), expected);
    expect(Buffer.byteLength(copied, "utf8")).toBe(270_057);
    expect(copied).toMatch(/^Assistant artifact page one/u);
    expect(copied).toContain("Assistant artifact page two");
    expect(copied.endsWith("b")).toBe(true);
    expect(await readFile(join(controlRoot, "artifact-read-1"), "utf8")).toBe("0\n");
    await expect(access(join(controlRoot, "artifact-read-2"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Copy loads older active chronology to find the last assistant response", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-copy-older-assistant-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "copy-older-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitForCompleteFrameAfter("Later copy prompt two", 0);
    const resultOccurrence = fixture.output().lastIndexOf("Later copy prompt two");
    expect(resultOccurrence).toBeGreaterThanOrEqual(0);
    await fixture.waitForCompleteFrameAfter(" · idle", resultOccurrence);
    expect(fixture.output()).not.toContain("Older copy answer.");
    const beforeCopy = fixture.output().length;
    fixture.write("/copy \r");
    const outcome = await Promise.race([
      waitForFileContents(join(controlRoot, "clipboard.txt"), "Older copy answer.").then(
        () => "copied" as const,
      ),
      fixture
        .waitForAfter("No assistant response is available to copy.", beforeCopy)
        .then(() => "missing" as const),
    ]);
    expect(outcome).toBe("copied");
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("Older copy answer.");
    await fixture.waitForAfter("Copied last assistant response.", beforeCopy);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a shell tool card uses the accepted dollar-command grammar", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-shell-card-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ noColor: true, scenario: "shell", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Show shell card\r");
    await fixture.waitFor("$ printf shell-card-fixture");
    await fixture.waitFor("Shell card complete.");
    await fixture.waitFor("stdout");
    expect(fixture.output()).not.toContain("stderr");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("tool subjects keep their full bounded value only in the 120-column layout", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-responsive-tool-card-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "shell", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Show responsive shell card\r");
    await fixture.waitFor("Shell card complete.");

    let beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    const wideFrameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    let frame = wideFrameLines.join("\n");
    expect(frame).toContain("bounded-secondary-provenance-and-wide-tail");
    expect(wideFrameLines.find((line) => line.includes("$ printf"))).toContain("Ctrl+O expand");

    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    const frameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    frame = frameLines.join("\n");
    expect(frame).toContain("$ printf shell-card-fixture");
    expect(frameLines.find((line) => line.includes("$ printf"))).not.toContain(
      "bounded-secondary-provenance-and-wide-tail",
    );
    expect(frameLines.find((line) => line.includes("$ printf"))).toContain("Ctrl+O expand");
    expect(frame).toContain("shell-card-fixture-with-bounded-secondary-provenance-and-wide-tail");

    beforeResize = fixture.output().length;
    await fixture.resize(40, 40);
    await fixture.waitForAfter("\u001b[?2026l", beforeResize);
    const narrowFrameLines = latestSynchronizedFrame(fixture.output().slice(beforeResize));
    expect(narrowFrameLines.find((line) => line.includes("$ printf"))).toContain("Ctrl+O expand");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an artifact-backed assistant response remains visible in the transcript", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-assistant-artifact-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitFor("Adam · Streaming session");
    expect(fixture.output()).toContain("Assistant response stored as artifact");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Artifacts opens one bounded assistant artifact page", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-assistant-artifact-page-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitFor("Adam · Streaming session");
    const beforeArtifacts = fixture.output().length;
    fixture.write("/artifacts \r");
    const opened = await Promise.race([
      fixture
        .waitForCompleteFrameAfter("Session artifacts", beforeArtifacts)
        .then(() => "opened" as const),
      fixture
        .waitForAfter("Unknown command /artifacts", beforeArtifacts)
        .then(() => "unknown" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(beforeArtifacts), "Session artifacts");
    expect(opened).toBe("opened");
    await fixture.waitForAfter("assistant response", beforeArtifacts);
    fixture.write("\r");
    await fixture.waitForAfter("Artifact detail", beforeArtifacts);
    const detailOutput = fixture.output().slice(beforeArtifacts);
    expect(detailOutput).toContain("Assistant artifact page one");
    expect(detailOutput).not.toContain("Assistant artifact page two");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Artifacts loads artifact references from older active chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-artifact-history-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "artifact-history", stateRoot, workspaceRoot });
    await fixture.waitFor("Later history answer.");
    fixture.write("/artifacts \r");
    await fixture.waitFor("Session artifacts");
    await fixture.waitFor("Load older chronology");
    const beforeFirstPage = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Load older chronology", beforeFirstPage);
    fixture.write("\r");
    await fixture.waitFor("assistant response");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("PageDown reads the next bounded assistant artifact page", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-assistant-artifact-next-page-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitForCompleteFrameAfter("Assistant response stored as artifact", beforePrompt);
    const resultOccurrence = fixture.output().lastIndexOf("Assistant response stored as artifact");
    expect(resultOccurrence).toBeGreaterThanOrEqual(beforePrompt);
    await fixture.waitForCompleteFrameAfter(" · idle", resultOccurrence);
    fixture.write("/artifacts \r");
    await fixture.waitFor("Session artifacts");
    fixture.write("\r");
    await waitForPath(join(controlRoot, "artifact-read-1"));
    await fixture.waitFor("1-16384 of 270057 bytes");
    const beforeNextPage = fixture.output().length;
    fixture.write("\u001b[6~");
    await expect(
      waitForFileContents(join(controlRoot, "artifact-read-2"), "16384\n"),
    ).resolves.toBe("16384\n");
    await fixture.waitForAfter("16385-32768 of 270057 bytes", beforeNextPage);
    await fixture.waitForAfter("Assistant artifact page two", beforeNextPage);
    const beforePreviousPage = fixture.output().length;
    fixture.write("\u001b[5~");
    await expect(waitForFileContents(join(controlRoot, "artifact-read-3"), "0\n")).resolves.toBe(
      "0\n",
    );
    await fixture.waitForAfter("1-16384 of 270057 bytes", beforePreviousPage);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Escape keeps a late artifact page response from restoring stale detail", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-artifact-page-race-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "artifact-page-race",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitFor("Assistant response stored as artifact");
    fixture.write("/artifacts \r");
    await fixture.waitFor("Session artifacts");
    fixture.write("\r");
    await fixture.waitFor("Artifact detail");
    fixture.write("\u001b[6~");
    await waitForPath(join(controlRoot, "page-read-pending"));
    const beforeEscape = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForAfter("type search · Enter inspect", beforeEscape);
    await writeFile(join(controlRoot, "release-page-read"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "artifact-read-2-settled"));
    fixture.write("no-such-artifact");
    await fixture.waitFor("Search: no-such-artifact");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("completed durable-context compaction renders an explicit chronology marker", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-compaction-marker-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      scenario: "artifact-backed-assistant",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Produce an artifact-backed answer\r");
    await fixture.waitFor("Assistant response stored as artifact");
    await fixture.waitFor("Adam · Streaming session");
    const beforeCompaction = fixture.output().length;
    fixture.write("Continue after the large answer\r");
    await fixture.waitForAfter("Context compacted · window 1", beforeCompaction);
    await fixture.waitForAfter("Assistant response stored as artifact", beforeCompaction);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a mutation permission shows its canonical diff and Enter allows the exact call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mutation-permission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "mutation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforePermission = fixture.output().length;
    fixture.write("Edit the file\r");
    await fixture.waitFor("Permission required");
    await fixture.waitFor("-before");
    await fixture.waitForCompleteFrameAfter("+after", beforePermission);
    expectFramedOverlay(fixture.output().slice(beforePermission), "Permission required");
    const permissionOutput = fixture.output().slice(beforePermission);
    expect(permissionOutput).toContain(
      "\u001b[1m\u001b[38;2;203;166;247mAction\u001b[39m\u001b[22m",
    );
    expect(permissionOutput).toContain("\u001b[38;2;243;139;168mwrite\u001b[39m");
    expect(permissionOutput).toContain("\u001b[38;2;137;180;250mpatch\u001b[39m");
    expect(permissionOutput).toContain("\u001b[38;2;166;227;161mAllow\u001b[39m");
    expect(permissionOutput).toContain("\u001b[38;2;243;139;168mDeny\u001b[39m");
    fixture.write("\r");
    await fixture.waitFor("Edit complete");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("after\n");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a mandatory permission keeps input ownership when the inherited transcript-search chord is pressed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-permission-search-chord-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    scenario: "mutation",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Edit the file\r");
    await waitForPhysicalText(terminal, "Permission required");
    const transcriptHeaderRow = terminal
      .lines()
      .findIndex((line) => line.includes("Adam · New session"));
    expect(transcriptHeaderRow).toBeGreaterThanOrEqual(0);

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[102;6u");

    const frame = terminal.lines().join("\n");
    expect(frame).toContain("Permission required");
    expect(frame).not.toContain("Find transcript");
    expect(terminal.lines().findIndex((line) => line.includes("Adam · New session"))).toBe(
      transcriptHeaderRow,
    );

    terminal.input("\u001b");
    await waitForPhysicalText(terminal, "denied");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("before\n");
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("permission owns wheel input and scrolls its long preview without moving the transcript", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-permission-wheel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const original = `${Array.from(
    { length: 20 },
    (_, index) => `before-${String(index + 1).padStart(2, "0")}`,
  ).join("\n")}\n`;
  await writeFile(join(workspaceRoot, "edit.txt"), original, "utf8");
  const terminal = new AppliedViewportTerminal({ columns: 80, rows: 24 });
  const execution = runTuiFixture({
    scenario: "mutation-long-preview",
    stateRoot,
    terminal,
    workspaceRoot,
  });

  try {
    await terminal.nextFrame(0);
    terminal.input("Inspect a long permission preview\r");
    await waitForPhysicalText(terminal, "Permission required");
    await waitForPhysicalText(terminal, "Preview 1-8 of");
    const transcriptHeaderRow = terminal
      .lines()
      .findIndex((line) => line.includes("Adam · New session"));

    await inputAndWaitForPhysicalFrame(terminal, "\u001b[<65;40;12M".repeat(4));
    const scrolled = terminal.lines().join("\n");
    expect(scrolled).toContain("Permission required");
    expect(scrolled).toMatch(/Preview (?:1[0-9]|2[0-9])-/u);
    expect(terminal.lines().findIndex((line) => line.includes("Adam · New session"))).toBe(
      transcriptHeaderRow,
    );

    await inputAndWaitForPhysicalFrame(terminal, "\u001b");
    await waitForPhysicalText(terminal, "denied");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe(original);
  } finally {
    if (terminal.running()) {
      terminal.input("\u0011");
    }
    await execution.catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("permission semantics remain explicit without color", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-permission-no-color-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({
      noColor: true,
      scenario: "mutation",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePermission = fixture.output().length;
    fixture.write("Edit without color\r");
    await fixture.waitForCompleteFrameAfter("+after", beforePermission);
    const frame = latestSynchronizedFrame(fixture.output().slice(beforePermission)).join("\n");
    expect(frame).toContain("Action write · Subject patch");
    expect(frame).toContain("> Allow");
    expect(frame).toContain("Deny");
    expect(frame).not.toContain("\u001b[38;2;");
    expect(frame).not.toContain("\u001b[48;2;");
    fixture.write("\u001b[27;1;27~");
    await fixture.waitFor("denied");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("before\n");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Diffs reopens a settled mutation preview from authoritative chronology", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-settled-diff-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "mutation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Edit the file\r");
    await fixture.waitFor("Permission required");
    fixture.write("\r");
    await fixture.waitFor("Edit complete");
    const beforeDiffs = fixture.output().length;
    fixture.write("/diffs \r");
    const opened = await Promise.race([
      fixture.waitForCompleteFrameAfter("Settled diffs", beforeDiffs).then(() => "opened" as const),
      fixture.waitForAfter("Unknown command /diffs", beforeDiffs).then(() => "unknown" as const),
    ]);
    expectFramedOverlay(fixture.output().slice(beforeDiffs), "Settled diffs");
    expect(opened).toBe("opened");
    await fixture.waitForAfter("edit change preview", beforeDiffs);
    fixture.write("\r");
    await fixture.waitForAfter("Diff detail", beforeDiffs);
    await fixture.waitForAfter("-before", beforeDiffs);
    await fixture.waitForAfter("+after", beforeDiffs);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Enter cannot allow a mutation while its canonical preview is still loading", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-preview-loading-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "mutation-delayed-preview",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforePrompt = fixture.output().length;
    fixture.write("Edit before preview\r");
    await fixture.waitForCompleteFrameAfter("Loading canonical preview", beforePrompt);
    expect(fixture.output().slice(beforePrompt)).toContain("unavailable");
    await waitForPath(join(controlRoot, "preview-requested"));
    fixture.write("\r");
    await waitForPath(join(controlRoot, "permission-decision-submitted"));
    await writeFile(join(controlRoot, "release-preview"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "preview-read-complete"));
    await fixture.waitFor("denied");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("before\n");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Ctrl+C cancels one active run and repeated input cannot arm exit while settling", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "cancellation",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Cancel this run\r");
    await fixture.waitFor("Working");
    await waitForPath(join(controlRoot, "model-started"));
    fixture.write("\u0003\u0003");
    await fixture.waitFor("cancelled");
    expect(fixture.output()).not.toContain("Press Ctrl+C again");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the injected deadline causally expires an idle Ctrl+C exit arm", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-exit-expiry-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "deadline", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    await waitForPath(join(controlRoot, "scheduled-deadline-2000-1"));
    const armedOutputEnd = fixture.output().length;
    await writeFile(join(controlRoot, "deadline-2000-1"), "expire\n", "utf8");
    await fixture.waitForAfter("fake.local · Certified", armedOutputEnd);
    const expiredOutputEnd = fixture.output().length;
    fixture.write("\u001b[99;5:1u");
    await fixture.waitForAfter("Press Ctrl+C again within two seconds to exit", expiredOutputEnd);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the legacy duplicate guard consumes one immediate Ctrl+C duplicate", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-legacy-duplicate-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({ controlRoot, scenario: "deadline", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("保留");
    await fixture.waitFor("保留");
    fixture.write("\u0003\u0003");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    await waitForPath(join(controlRoot, "scheduled-deadline-50-1"));
    await writeFile(join(controlRoot, "deadline-50-1"), "expire\n", "utf8");
    fixture.write("x");
    await fixture.waitFor("保留x");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a pending clipboard adapter fails closed from the injected deadline", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clipboard-timeout-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-timeout",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("保留超时草稿");
    await fixture.waitFor("保留超时草稿");
    fixture.write("\u0011");
    await waitForPath(join(controlRoot, "clipboard-started"));
    await waitForPath(join(controlRoot, "scheduled-deadline-250-1"));
    await writeFile(join(controlRoot, "deadline-250-1"), "expire\n", "utf8");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Clipboard copy failed; draft was not copied.");
    await waitForPath(join(controlRoot, "clipboard-closed"));
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a restarted TUI resumes an existing authoritative transcript", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-resume-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "resume", stateRoot, workspaceRoot });
    await fixture.waitFor("Resume transcript");
    await fixture.waitFor("Previous answer");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("untrusted model terminal controls are rendered as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-terminal-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      noColor: true,
      scenario: "unsafe-output",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Render unsafe output\r");
    await fixture.waitFor("Visible");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain("\u001b]52;c;YXR0YWNr\u0007");
    expect(result.stdout).not.toContain("\u001b[2Janswer");
    expect(result.stdout).not.toContain("\u001b[38;2;");
    expect(result.stdout).not.toContain("\u001b[48;2;");
    expect(result.stdout).toContain("› Render unsafe output");
    expect(result.stdout).toContain("Visible answer.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
test("slash Fork restores the selected boundary prompt in the child editor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-fork-alias-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("History prompt 3");
    const beforeFork = fixture.output().length;
    fixture.write("/fork \r");
    await fixture.waitForAfter("Fork from a boundary", beforeFork);
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("Adam · Branch of ", beforeSelection);
    fixture.write("\u0011");
    await fixture.closed;
    expect(await readFile(join(controlRoot, "clipboard.txt"), "utf8")).toBe("History prompt 3");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("slash Clone branches at the latest complete boundary with an empty editor", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clone-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "history",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("History prompt 3");
    const beforeClone = fixture.output().length;
    fixture.write("/clone \r");
    await fixture.waitForAfter("Adam · Branch of ", beforeClone);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(access(join(controlRoot, "clipboard.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/clone"');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
