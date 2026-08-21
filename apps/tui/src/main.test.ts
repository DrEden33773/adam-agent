import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm as remove,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import type { FixtureScenario } from "./fixture-scenario.js";

const fixturePath = fileURLToPath(new URL("../dist/test-fixture.js", import.meta.url));
const productionPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const mcpFixturePath = fileURLToPath(
  new URL("../../../packages/testkit/dist/mcp-stdio-server.fixture.js", import.meta.url),
);
const fixtureFailureMilliseconds = 30_000;
const activeFixtures = new Set<Fixture>();

afterEach(async () => {
  await cleanupActiveFixtures();
});

test("real TUI starts on an authoritative empty session and restores the terminal on exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Adam · New session");
    expect(result.stdout).toContain("fake.local · Certified");
    expect(result.stdout).toContain("\u001b[?2004h");
    expect(result.stdout).toContain("\u001b[?2004l");
    expect(result.stdout).toContain("\u001b[?2026h");
    expect(result.stdout).toContain("\u001b[?2026l");
    expect(result.stdout).toContain("\u001b[?25h");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI entry exposes its usage contract", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-help-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: { arguments: ["--help"], cwd: workspaceRoot, entrypoint: productionPath },
      stateRoot,
      workspaceRoot,
    });
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain(
      "Usage: adam-agent-tui [--target <exact-target-id> | --resume <session-id>]",
    );
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
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    const beforeHelp = fixture.output().length;
    fixture.write("/help\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Adam Help", beforeHelp).then(() => "help" as const),
      fixture.waitForAfter("Skill selection complete.", beforeHelp).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("help");
    expect(await readFilesRecursively(stateRoot)).not.toContain('"text":"/help"');
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
    await fixture.waitForAfter("Command Reference", beforeTopic);
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
      fixture.waitForAfter("Effective Hotkeys", beforeHotkeys).then(() => "hotkeys" as const),
      fixture.waitForAfter("Skill selection complete.", beforeHotkeys).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(outcome).toBe("hotkeys");
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

test("slash completion exposes Registry usage as its argument hint", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-slash-usage-hint-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/he");
    await fixture.waitFor("/help [topic]");
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
    await fixture.waitFor("/help [topic] · /hotkeys · Tab complete");
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
    const fixture = startFixture({ controlRoot, scenario: "history", stateRoot, workspaceRoot });
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
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Selected session prompt", beforeSelection);
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
    expect(result.stdout.slice(beforeCompletion)).not.toContain(
      "Set, clear, or regenerate the active session name.",
    );
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

test("the production TUI entry rejects conflicting target and resume arguments", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-invalid-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: [
          "--resume",
          "session-id",
          "--target",
          "deepseek-v4-flash.direct",
          "--state-root",
          stateRoot,
        ],
        cwd: workspaceRoot,
        entrypoint: productionPath,
      },
      stateRoot,
      workspaceRoot,
    });
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(result.stdout).toContain("--resume and --target cannot be combined.");
    expect(result.stdout).toContain("Usage: adam-agent-tui");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI entry reaches a credentialed exact-target session without a model call", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-startup-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI selects an exact available target before creating an empty-project session", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-target-picker-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a model target");
    await fixture.waitFor("deepseek-v4-flash.direct");
    await fixture.waitFor("deepseek-v4-pro.direct");
    fixture.write("\r");
    await fixture.waitFor("Adam · New session");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
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
    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a model target");
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
    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: {
          DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
          XDG_CONFIG_HOME: configRoot,
        },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Adam · New session");
    expect(result.stdout).not.toContain("Select a model target");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production target picker saves its focused exact target separately from session creation", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-save-target-"));
  const configRoot = join(testRoot, "config");
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: {
          DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
          XDG_CONFIG_HOME: configRoot,
        },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a model target");
    fixture.write("d");
    await fixture.waitFor("Saved deepseek-v4-flash.direct as the default");
    const configurationPath = join(configRoot, "adam-agent", "config.json");
    await waitForPath(configurationPath);
    expect(await readFile(configurationPath, "utf8")).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        defaultTargetId: "deepseek-v4-flash.direct",
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
    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: {
          DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
          XDG_CONFIG_HOME: configRoot,
        },
      },
      stateRoot,
      workspaceRoot,
    });
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
    const seed = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await seed.waitFor("Adam · New session");
    seed.write("\u0011");
    await expect(seed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("deepseek-v4-flash.direct");
    await fixture.waitFor("Select a project session");
    fixture.write("\u001b[27;1;27~");
    fixture.write("\u0003");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Select a project session");
    expect(result.stdout).toContain("New Session");
    expect(result.stdout).not.toContain("Select a model target");
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
    const seed = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await seed.waitFor("Adam · New session");
    seed.write("\u0011");
    await seed.closed;

    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-pro.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
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
    const seed = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await seed.waitFor("Adam · New session");
    seed.write("\u0011");
    await seed.closed;

    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    const beforeSelection = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForAfter("Adam · New session", beforeSelection);
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
    const seed = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await seed.waitFor("Adam · New session");
    seed.write("\u0011");
    await seed.closed;

    const fixture = startFixture({
      program: {
        arguments: ["--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Select a project session");
    const beforeNewSession = fixture.output().length;
    fixture.write("\u001b[B\r");
    await fixture.waitForAfter("Select a model target", beforeNewSession);
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
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeRename = fixture.output().length;
    fixture.write("/name Release triage\r");
    await fixture.waitForAfter("Release triage", beforeRename);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Adam · Release triage");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production editor clears a manual session name through canonical Presentation truth", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-clear-name-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/name Temporary name\r");
    await fixture.waitFor("Adam · Temporary name");
    const beforeClear = fixture.output().length;
    fixture.write("/name --clear\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Adam · New session", beforeClear).then(() => "cleared" as const),
      fixture.waitForAfter("Adam · --clear", beforeClear).then(() => "literal" as const),
    ]);
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("cleared");
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
    fixture.write("/instructions reload\r");
    await fixture.waitFor("Instructions r2 · scopes . · AGENTS.md · reload available");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(fixture.output()).not.toContain("Second revision.");
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
      fixture.waitForAfter("Select next-turn Skills", afterTyping).then(() => "palette" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("palette");
    expect(fixture.output()).toContain("skill:v1:project:.:project-review");
    expect(fixture.output()).toContain("Reviews exact project state.");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the Skill palette renders untrusted metadata and diagnostic identities as inert text", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-skill-controls-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const validDirectory = join(workspaceRoot, ".agents", "skills", "safe-name");
  const invalidDirectory = join(workspaceRoot, ".agents", "skills", "wrong-file");
  const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
  await mkdir(validDirectory, { recursive: true });
  await mkdir(invalidDirectory, { recursive: true });
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

  try {
    const fixture = startFixture({ scenario: "skill-selection", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/skills\r");
    await fixture.waitFor("skill_filename_invalid");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("wrong-file");
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
    fixture.write("/skills reload");
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
    await fixture.waitFor("Open @");
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

test("the real TUI branches from the latest visible authoritative complete boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-branch-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    fixture.write("/branch");
    await fixture.waitFor("/branch");
    const afterTyping = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Adam · Branch of ", afterTyping).then(() => "branch" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("branch");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the Registry canonical fork command preserves the existing branch behavior", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-fork-alias-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "history", stateRoot, workspaceRoot });
    await fixture.waitFor("History prompt 3");
    const beforeFork = fixture.output().length;
    fixture.write("/fork\r");
    const outcome = await Promise.race([
      fixture.waitForAfter("Adam · Branch of ", beforeFork).then(() => "fork" as const),
      fixture.waitForAfter("History answer.", beforeFork).then(() => "model" as const),
    ]);
    fixture.write("\u0011");
    await fixture.closed;
    expect(outcome).toBe("fork");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real TUI MCP wizard preserves every separate B8 authority step", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mcp-wizard-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  const spawnMarker = join(testRoot, "mcp-spawned");
  const closeMarker = join(testRoot, "mcp-closed");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
    "utf8",
  );

  try {
    const fixture = startFixture({ controlRoot, scenario: "streaming", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("/mcp");
    await fixture.waitFor("/mcp");
    const afterTyping = fixture.output().length;
    fixture.write("\r");
    const outcome = await Promise.race([
      fixture
        .waitForAfter("MCP authority · workspace confirmation required", afterTyping)
        .then(() => "wizard" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    expect(outcome).toBe("wizard");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · server approval required");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · activation required");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · tool selection required");
    await waitForPath(spawnMarker);
    fixture.write("1");
    fixture.write("\u001b[B");
    fixture.write("c");
    await fixture.waitFor("MCP authority · profile committed");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await waitForPath(closeMarker);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI resumes and explicitly reactivates one committed MCP profile", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mcp-reactivation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const spawnMarker = join(testRoot, "mcp-spawned");
  const closeMarker = join(testRoot, "mcp-closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
    "utf8",
  );
  const program = {
    arguments: ["--state-root", stateRoot],
    cwd: workspaceRoot,
    entrypoint: productionPath,
    environment: { DEEPSEEK_API_KEY: "deterministic-non-network-fixture" },
  } as const;

  try {
    const seed = startFixture({ program, stateRoot, workspaceRoot });
    await seed.waitFor("Select a model target");
    seed.write("\r");
    await seed.waitFor("Adam · New session");
    seed.write("/mcp\r");
    await seed.waitFor("MCP authority · workspace confirmation required");
    seed.write("\r");
    await seed.waitFor("MCP authority · server approval required");
    seed.write("\r");
    await seed.waitFor("MCP authority · activation required");
    seed.write("\r");
    await seed.waitFor("MCP authority · tool selection required");
    seed.write("1");
    seed.write("\u001b[B");
    seed.write("c");
    await seed.waitFor("MCP authority · profile committed");
    seed.write("\u0011");
    await expect(seed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const resumed = startFixture({ program, stateRoot, workspaceRoot });
    await resumed.waitFor("Select a project session");
    resumed.write("\r");
    await resumed.waitFor("Adam · New session");
    resumed.write("/mcp\r");
    await resumed.waitFor("MCP authority · profile reactivation required");
    resumed.write("\r");
    await resumed.waitFor("MCP authority · profile committed");
    resumed.write("\u0011");
    await expect(resumed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the TUI process fails visibly when MCP shutdown cannot be confirmed", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mcp-close-unconfirmed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const spawnMarker = join(testRoot, "mcp-spawned");
  const closeMarker = join(testRoot, "mcp-closed");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [mcpFixturePath, spawnMarker, closeMarker],
        },
      },
    }),
    "utf8",
  );

  try {
    const fixture = startFixture({
      scenario: "mcp-close-unconfirmed",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/mcp\r");
    await fixture.waitFor("MCP authority · workspace confirmation required");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · server approval required");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · activation required");
    fixture.write("\r");
    await fixture.waitFor("MCP authority · tool selection required");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 1, signal: null });
    expect(`${result.stdout}${result.stderr}`).toContain("MCP shutdown could not be confirmed.");
    await waitForPath(closeMarker);
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
    const fixture = startFixture({
      controlRoot,
      scenario: "streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Explain streaming\r");
    await fixture.waitFor("Explain streaming");
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

test("a real read tool is rendered as a bounded Pi-style tool card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-read-tool-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "# Fixture\n\nReadable content.\n", "utf8");

  try {
    const fixture = startFixture({ scenario: "read", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Read README\r");
    await fixture.waitFor("read README.md");
    await fixture.waitFor("29 bytes");
    await fixture.waitFor("Read complete");
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
    const fixture = startFixture({ scenario: "shell", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Show shell card\r");
    await fixture.waitFor("$ printf shell-card-fixture");
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
    fixture.write("Edit the file\r");
    await fixture.waitFor("Permission required");
    await fixture.waitFor("-before");
    await fixture.waitFor("+after");
    fixture.write("\r");
    await fixture.waitFor("Edit complete");
    await expect(readFile(join(workspaceRoot, "edit.txt"), "utf8")).resolves.toBe("after\n");
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
    fixture.write("Edit before preview\r");
    await fixture.waitFor("Loading canonical preview");
    await fixture.waitFor("Allow unavailable");
    await waitForPath(join(controlRoot, "preview-requested"));
    fixture.write("\r");
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
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ scenario: "cancellation", stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("Cancel this run\r");
    await fixture.waitFor("Working");
    fixture.write("\u0003\u0003");
    await fixture.waitFor("cancelled");
    expect(fixture.output()).not.toContain("Press Ctrl+C again");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("idle Ctrl+C preserves a CJK draft and copies it only on the confirming press", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-retained-draft-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const draft = "保留草稿 🚀";

  try {
    const fixture = startFixture({
      controlRoot,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write(draft);
    await fixture.waitFor(draft);
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit · draft will be copied");
    expect(fixture.output()).not.toContain("clipboard copied");
    fixture.write("\u0003");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(draft);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Kitty Ctrl+C repeat and release phases cannot confirm an armed exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-kitty-phases-"));
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
    fixture.write("草稿");
    await fixture.waitFor("草稿");
    fixture.write("\u001b[99;5:1u");
    await fixture.waitFor("Press Ctrl+C again within two seconds to exit");
    fixture.write("\u001b[99;5:2u\u001b[99;5:3ux");
    await fixture.waitFor("草稿x");
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe("草稿x");
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
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("unsupported clipboard is reported after terminal restoration without blocking exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clipboard-unsupported-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("draft without clipboard");
    await fixture.waitFor("draft without clipboard");
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Clipboard unavailable; draft was not copied.");
    expect(result.stdout.indexOf("\u001b[?2004l")).toBeLessThan(
      result.stdout.indexOf("Clipboard unavailable; draft was not copied."),
    );
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

type FixtureResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
};

type Fixture = {
  readonly cleanup: () => Promise<void>;
  readonly closed: Promise<FixtureResult>;
  readonly output: () => string;
  readonly waitFor: (text: string) => Promise<void>;
  readonly waitForAfter: (text: string, offset: number) => Promise<void>;
  readonly write: (text: string) => void;
};

function startFixture(input: {
  readonly controlRoot?: string;
  readonly noColor?: boolean;
  readonly program?: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly entrypoint: string;
    readonly environment?: Readonly<Record<string, string>>;
  };
  readonly scenario?: FixtureScenario;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
}): Fixture {
  const arguments_ =
    input.program === undefined
      ? [
          process.execPath,
          fixturePath,
          "--state-root",
          input.stateRoot,
          "--workspace-root",
          input.workspaceRoot,
          ...(input.controlRoot === undefined ? [] : ["--control-root", input.controlRoot]),
          ...(input.scenario === undefined ? [] : ["--scenario", input.scenario]),
        ]
      : [process.execPath, input.program.entrypoint, ...input.program.arguments];
  const command = arguments_.map(shellQuote).join(" ");
  const { NO_COLOR: _noColor, ...environment } = process.env;
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    ...(input.program === undefined ? {} : { cwd: input.program.cwd }),
    detached: true,
    env: {
      ...environment,
      ...input.program?.environment,
      ...(input.noColor === true ? { NO_COLOR: "1" } : {}),
      TERM: "xterm-256color",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let processClosed = false;
  const outputWaiters = new Set<{
    readonly offset: number;
    readonly text: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly guard: ReturnType<typeof setTimeout>;
  }>();
  let failureGuard: ReturnType<typeof setTimeout> | undefined;
  const processResult = Promise.withResolvers<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const waiter of outputWaiters) {
      if (stdout.indexOf(waiter.text, waiter.offset) >= 0) {
        clearTimeout(waiter.guard);
        outputWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("close", (code, signal) => {
    processClosed = true;
    processResult.resolve({ code, signal });
  });
  child.once("error", (error) => processResult.reject(error));

  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || processClosed) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
    }
  };
  const awaitCloseWithGuard = async (milliseconds: number): Promise<boolean> => {
    if (processClosed) {
      return true;
    }
    const guard = Promise.withResolvers<boolean>();
    const timeout = setTimeout(() => guard.resolve(false), milliseconds);
    timeout.unref();
    try {
      return await Promise.race([processResult.promise.then(() => true), guard.promise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const cleanup = async (): Promise<void> => {
    if (!processClosed) {
      signalProcessGroup("SIGTERM");
      if (!(await awaitCloseWithGuard(1_000))) {
        signalProcessGroup("SIGKILL");
      }
    }
    await processResult.promise.catch(() => undefined);
  };
  let timedOut = false;
  const result = new Promise<FixtureResult>((resolve, reject) => {
    processResult.promise.then(
      (settled) => {
        if (timedOut) {
          reject(new Error("The real TUI process did not reach startup and causal close."));
        } else {
          resolve({ ...settled, stderr, stdout });
        }
      },
      (error: unknown) => reject(error),
    );
    failureGuard = setTimeout(() => {
      timedOut = true;
      void cleanup();
    }, fixtureFailureMilliseconds);
    failureGuard.unref();
  });
  void result.then(
    () => {
      activeFixtures.delete(fixture);
    },
    () => {
      activeFixtures.delete(fixture);
    },
  );
  const settleOutputWaiters = () => {
    if (failureGuard !== undefined) {
      clearTimeout(failureGuard);
    }
    for (const waiter of outputWaiters) {
      clearTimeout(waiter.guard);
      waiter.reject(new Error(`The TUI process closed before rendering ${waiter.text}.`));
    }
    outputWaiters.clear();
  };
  void processResult.promise.then(settleOutputWaiters, settleOutputWaiters);
  const fixture: Fixture = {
    cleanup,
    closed: result,
    output: () => stdout,
    waitFor(text) {
      return waitForAfter(text, 0);
    },
    waitForAfter,
    write(text) {
      child.stdin.write(text);
    },
  };
  function waitForAfter(text: string, offset: number): Promise<void> {
    if (stdout.indexOf(text, offset) >= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        offset,
        text,
        resolve,
        reject,
        guard: setTimeout(() => {
          outputWaiters.delete(waiter);
          void cleanup().then(
            () => reject(new Error(`The real TUI process did not render ${text}.`)),
            () => reject(new Error(`The real TUI process did not render ${text}.`)),
          );
        }, fixtureFailureMilliseconds),
      };
      outputWaiters.add(waiter);
    });
  }
  activeFixtures.add(fixture);
  return fixture;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function cleanupActiveFixtures(): Promise<void> {
  await Promise.all([...activeFixtures].map((fixture) => fixture.cleanup()));
  activeFixtures.clear();
}

async function rm(path: string, options: { readonly force: boolean; readonly recursive: boolean }) {
  await cleanupActiveFixtures();
  await remove(path, options);
}

async function waitForPath(path: string): Promise<void> {
  const directory = join(path, "..");
  const filename = path.slice(directory.length + 1);
  const watcher = watch(directory);
  const failure = Promise.withResolvers<never>();
  const guard = setTimeout(
    () => failure.reject(new Error(`The fixture did not create ${filename}.`)),
    fixtureFailureMilliseconds,
  );
  try {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      return;
    }
    await Promise.race([
      (async () => {
        for await (const event of watcher) {
          if (
            event.filename === filename &&
            (await access(path).then(
              () => true,
              () => false,
            ))
          ) {
            return;
          }
        }
      })(),
      failure.promise,
    ]);
  } finally {
    clearTimeout(guard);
    await watcher.return?.();
  }
}

async function readFilesRecursively(root: string): Promise<string> {
  const contents: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      contents.push(await readFilesRecursively(path));
    } else if (entry.isFile()) {
      contents.push(await readFile(path, "utf8"));
    }
  }
  return contents.join("\n");
}
