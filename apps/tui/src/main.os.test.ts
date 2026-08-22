import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";
import { removeTuiFixtureRoot as rm, waitForPath } from "./tui-filesystem.test-support.js";
import {
  cleanupActiveTuiFixtures,
  startTuiFixture as startFixture,
} from "./tui-fixture.test-support.js";

const productionPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const mcpFixturePath = fileURLToPath(
  new URL("../../../packages/testkit/dist/mcp-stdio-server.fixture.js", import.meta.url),
);
afterEach(async () => {
  await cleanupActiveTuiFixtures();
});

test("real TUI starts on an authoritative empty session and restores the terminal on exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-startup-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ external: true, stateRoot, workspaceRoot });
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

test("a real tool output artifact opens through the active chronology picker", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-tool-artifact-page-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      external: true,
      scenario: "tool-artifact",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Produce tool output\r");
    await waitForPath(join(controlRoot, "prompt-submitted"));
    const modelRequest = await Promise.race([
      waitForPath(join(controlRoot, "tool-artifact-requested")).then(() => "requested" as const),
      fixture.waitFor("The model run failed.").then(() => "failed" as const),
    ]);
    expect(modelRequest).toBe("requested");
    const toolSettlement = await Promise.race([
      waitForPath(join(controlRoot, "tool-artifact-result")).then(() => "completed" as const),
      fixture.waitFor("artifact_store_failed").then(() => "artifact_failed" as const),
    ]);
    expect(toolSettlement).toBe("completed");
    await fixture.waitFor("Tool artifact complete");
    expect(fixture.output()).toContain("output truncated");
    fixture.write("/artifacts \r");
    const artifactList = await Promise.race([
      fixture.waitFor("shell output").then(() => "listed" as const),
      fixture
        .waitFor("No artifacts are visible in the active chronology")
        .then(() => "empty" as const),
    ]);
    expect(artifactList).toBe("listed");
    fixture.write("\r");
    await waitForPath(join(controlRoot, "artifact-read-1"));
    const firstPage = await Promise.race([
      fixture.waitFor("1-16384 of 70000 bytes").then(() => "opened" as const),
      fixture.waitFor("The artifact could not be read safely").then(() => "unsafe" as const),
      fixture
        .waitFor("The artifact is not available through this Presentation session")
        .then(() => "unavailable" as const),
    ]);
    expect(firstPage).toBe("opened");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
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
    const fixture = startFixture({
      controlRoot,
      external: true,
      scenario: "streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/mc");
    await fixture.waitFor("/mc");
    fixture.write("\t");
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
    await seed.waitFor("Select an exact model target");
    seed.write("\r");
    await seed.waitFor("Adam · New session");
    seed.write("/mc");
    await seed.waitFor("/mc");
    seed.write("\t");
    await seed.waitFor("/mcp");
    seed.write("\r");
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
    resumed.write("/mc");
    await resumed.waitFor("/mc");
    resumed.write("\t");
    await resumed.waitFor("/mcp");
    resumed.write("\r");
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
      external: true,
      scenario: "mcp-close-unconfirmed",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("/mc");
    await fixture.waitFor("/mc");
    fixture.write("\t");
    await fixture.waitFor("/mcp");
    fixture.write("\r");
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
      external: true,
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
      external: true,
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

test("unsupported clipboard is reported after terminal restoration without blocking exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-clipboard-unsupported-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ external: true, stateRoot, workspaceRoot });
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
test("the real terminal admits a mutation permission with Enter", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mutation-permission-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "edit.txt"), "before\n", "utf8");

  try {
    const fixture = startFixture({
      external: true,
      scenario: "mutation",
      stateRoot,
      workspaceRoot,
    });
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

test("the real terminal delivers Ctrl+C interruption without arming exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-cancel-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      external: true,
      scenario: "cancellation",
      stateRoot,
      workspaceRoot,
    });
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
test("the real terminal preserves one bracketed multiline paste as editor input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-bracketed-paste-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      external: true,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("\u001b[200~first pasted line\n第二行\u001b[201~");
    await fixture.waitFor("第二行");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(
      "first pasted line\n第二行",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real terminal redraws after a pseudo-terminal resize", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-resize-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const terminalProcessMarker = join(testRoot, "terminal-process");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      external: true,
      stateRoot,
      terminalProcessMarker,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    const beforeResize = fixture.output().length;
    await fixture.resize(52, 18);
    await fixture.waitForAfter("Adam · New session", beforeResize);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
