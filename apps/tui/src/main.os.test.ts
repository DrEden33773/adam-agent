import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createModelTargets, createSessionLifecycle } from "@adam-agent/agent";
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

test.each([
  { code: 143, signal: "SIGTERM" as const },
  { code: 129, signal: "SIGHUP" as const },
])(
  "$signal closes authoritative state and restores the real terminal before exit",
  async ({ code, signal }) => {
    const testRoot = await mkdtemp(join(tmpdir(), `adam-agent-tui-${signal.toLowerCase()}-`));
    const workspaceRoot = join(testRoot, "workspace");
    const stateRoot = join(testRoot, "state");
    const controlRoot = join(testRoot, "control");
    const terminalProcessMarker = join(testRoot, "terminal-process");
    await mkdir(workspaceRoot);
    await mkdir(controlRoot);

    try {
      const fixture = startFixture({
        controlRoot,
        external: true,
        stateRoot,
        terminalProcessMarker,
        workspaceRoot,
      });
      await fixture.waitFor("Adam · New session");
      await fixture.terminate(signal);
      const result = await fixture.closed;
      expect(result).toMatchObject({ code, signal: null, stderr: "" });
      await expect(readFile(join(controlRoot, "tui-fixture-closed"), "utf8")).resolves.toBe(
        "closed\n",
      );
      expect(result.stdout).toContain("\u001b[?2004l");
      expect(result.stdout).toContain("\u001b[?25h");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);

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

test("the production TUI composes the Linux clipboard adapter for copy commands", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-clipboard-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const helperPath = join(testRoot, "wl-copy");
  const clipboardMarker = join(testRoot, "clipboard.txt");
  const assistantText = "Production clipboard response.";
  await mkdir(workspaceRoot);
  await writeFile(helperPath, '#!/bin/sh\n/bin/cat > "$ADAM_TEST_CLIPBOARD_MARKER"\n', {
    mode: 0o755,
  });

  try {
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () =>
        new Response(
          `data: {"id":"clipboard-answer","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":${JSON.stringify(assistantText)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
    });
    const targets = await modelTargets.snapshot({
      signal: AbortSignal.timeout(5_000),
    });
    const targetIdentity = targets.targets.find(
      ({ identity }) => identity.targetId === "deepseek-v4-flash.direct",
    )?.identity;
    if (targetIdentity === undefined) {
      throw new Error("The production clipboard fixture requires the DeepSeek Flash target.");
    }
    const seedLifecycle = createSessionLifecycle({ modelTargets, stateRoot, workspaceRoot });
    const created = await seedLifecycle.create({ targetIdentity });
    await seedLifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create a response for the production clipboard tracer." },
    });
    await seedLifecycle.close();
    const { PATH: inheritedPath = "" } = process.env;

    const fixture = startFixture({
      program: {
        arguments: ["--resume", created.sessionId, "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: {
          ADAM_TEST_CLIPBOARD_MARKER: clipboardMarker,
          DEEPSEEK_API_KEY: "test-deepseek-key",
          PATH: `${testRoot}:${inheritedPath}`,
        },
      },
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor(assistantText);
    fixture.write("/copy\r");
    const copyStatus = await Promise.race([
      fixture.waitFor("Copied last assistant response.").then(() => "copied" as const),
      fixture
        .waitFor("Clipboard unavailable; assistant response was not copied.")
        .then(() => "unavailable" as const),
    ]);
    expect(copyStatus).toBe("copied");
    await waitForPath(clipboardMarker);
    await expect(readFile(clipboardMarker, "utf8")).resolves.toBe(assistantText);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
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
        .waitForCompleteFrameAfter("MCP authority · workspace confirmation required", afterTyping)
        .then(() => "wizard" as const),
      fixture.waitForAfter("Working", afterTyping).then(() => "prompt" as const),
    ]);
    expect(outcome).toBe("wizard");
    let beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("MCP authority · server approval required", beforeStep);
    beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("MCP authority · activation required", beforeStep);
    beforeStep = fixture.output().length;
    fixture.write("\r");
    await waitForPath(spawnMarker);
    await fixture.waitForCompleteFrameAfter("MCP authority · tool selection required", beforeStep);
    fixture.write("1");
    fixture.write("\u001b[B");
    beforeStep = fixture.output().length;
    fixture.write("c");
    await fixture.waitForCompleteFrameAfter("MCP authority · profile committed", beforeStep);
    fixture.write("\u0011");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.slice(afterTyping)).toContain("┌");
    expect(result.stdout.slice(afterTyping)).toContain("└");
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
    let beforeStep = seed.output().length;
    seed.write("\r");
    await seed.waitForCompleteFrameAfter(
      "MCP authority · workspace confirmation required",
      beforeStep,
    );
    beforeStep = seed.output().length;
    seed.write("\r");
    await seed.waitForCompleteFrameAfter("MCP authority · server approval required", beforeStep);
    beforeStep = seed.output().length;
    seed.write("\r");
    await seed.waitForCompleteFrameAfter("MCP authority · activation required", beforeStep);
    beforeStep = seed.output().length;
    seed.write("\r");
    await seed.waitForCompleteFrameAfter("MCP authority · tool selection required", beforeStep);
    seed.write("1");
    seed.write("\u001b[B");
    beforeStep = seed.output().length;
    seed.write("c");
    await seed.waitForCompleteFrameAfter("MCP authority · profile committed", beforeStep);
    seed.write("\u0011");
    await expect(seed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const resumed = startFixture({ program, stateRoot, workspaceRoot });
    await resumed.waitFor("Select a project session");
    const beforeSessionSelection = resumed.output().length;
    resumed.write("\u001b[B");
    await resumed.waitForCompleteFrameAfter("New session", beforeSessionSelection);
    resumed.write("\r");
    await resumed.waitFor("Adam · New session");
    resumed.write("/mc");
    await resumed.waitFor("/mc");
    resumed.write("\t");
    await resumed.waitFor("/mcp");
    beforeStep = resumed.output().length;
    resumed.write("\r");
    await resumed.waitForCompleteFrameAfter(
      "MCP authority · profile reactivation required",
      beforeStep,
    );
    beforeStep = resumed.output().length;
    resumed.write("\r");
    await resumed.waitForCompleteFrameAfter("MCP authority · profile committed", beforeStep);
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
    let beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter(
      "MCP authority · workspace confirmation required",
      beforeStep,
    );
    beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("MCP authority · server approval required", beforeStep);
    beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("MCP authority · activation required", beforeStep);
    beforeStep = fixture.output().length;
    fixture.write("\r");
    await fixture.waitForCompleteFrameAfter("MCP authority · tool selection required", beforeStep);
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
test("the real terminal preserves one large bracketed multiline paste as editor input", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-bracketed-paste-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);
  const pasted = Array.from(
    { length: 24 },
    (_, index) => `line ${index + 1} · 中文 · e\u0301 · 👩🏽‍💻`,
  ).join("\n");

  try {
    const fixture = startFixture({
      controlRoot,
      external: true,
      scenario: "clipboard-success",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write(`\u001b[200~${pasted}\u001b[201~`);
    await fixture.waitFor("[paste #1 +24 lines]");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(readFile(join(controlRoot, "clipboard.txt"), "utf8")).resolves.toBe(pasted);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real terminal positions the IME cursor on CJK and grapheme cell boundaries", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-ime-cursor-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({ external: true, stateRoot, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    fixture.write("A中e\u0301👩🏽‍💻Z");
    await fixture.waitFor("A中e");
    for (const expectedColumn of [8, 6, 5, 3]) {
      const beforeMove = fixture.output().length;
      fixture.write("\u001b[D");
      await fixture.waitForAfter(`\u001b[${expectedColumn}G`, beforeMove);
    }
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real terminal redraws through 40, 80, 120, and minimum-size layouts", async () => {
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
    let beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    await fixture.waitForCompleteFrameAfter("context unavailable", beforeResize);
    beforeResize = fixture.output().length;
    await fixture.resize(40, 12);
    await fixture.waitForCompleteFrameAfter("/help · Tab complete", beforeResize);
    beforeResize = fixture.output().length;
    await fixture.resize(39, 11);
    await fixture.waitForCompleteFrameAfter("Terminal too small", beforeResize);
    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForCompleteFrameAfter("workspace · context unavailable · idle", beforeResize);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
