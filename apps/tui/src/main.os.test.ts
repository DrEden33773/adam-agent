import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createExtensionHost,
  createJsonlOperationStore,
  createModelTargets,
  createSessionLifecycle,
  createWorkspaceTrust,
} from "@adam-agent/agent";
import { createTrustedWorkspaceTrustForTesting } from "@adam-agent/agent/internal-testing";
import { afterEach, expect, test } from "vitest";
import {
  removeTuiFixtureRoot as rm,
  waitForFileContents,
  waitForPath,
} from "./tui-filesystem.test-support.js";
import {
  cleanupActiveTuiFixtures,
  startTuiFixture as startFixture,
} from "./tui-fixture.test-support.js";

const productionPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const productionFixturePath = fileURLToPath(
  new URL("../dist/production-main.fixture.js", import.meta.url),
);
const cliPath = fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url));
const productRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFile = promisify(execFileCallback);
const mcpFixturePath = fileURLToPath(
  new URL("../../../packages/testkit/dist/mcp-stdio-server.fixture.js", import.meta.url),
);
afterEach(async () => {
  await cleanupActiveTuiFixtures();
});

async function trustWorkspace(configRoot: string, workspaceRoot: string): Promise<void> {
  const workspaceTrust = createWorkspaceTrust({
    environment: { XDG_CONFIG_HOME: configRoot },
    workspaceRoot,
  });
  const snapshot = await workspaceTrust.load();
  if (snapshot.projectId === null) {
    throw new Error("The production TUI fixture requires one canonical project identity.");
  }
  await workspaceTrust.setTrusted({ projectId: snapshot.projectId, trusted: true });
}

async function writeRecoverableReviewPackage(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/recoverable-review",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.recoverable-review",
        apiVersion: "^0.3.0",
        runtime: { entry: "./runtime.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            command: {
              id: "fixture.recoverable-review",
              name: "review",
              title: "Recoverable project review",
              version: 1,
            },
            id: "fixture.recoverable-review@1",
            input: { id: "adam.project-change-snapshot", version: 1 },
            inputSource: { id: "project_changes", version: 1 },
            kind: "operation",
            output: { id: "fixture.review-result", version: 1 },
            progress: { id: "fixture.review-progress", version: 1 },
            recovery: { version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "runtime.js"),
    `import { appendFileSync } from "node:fs";
const codec = (id) => ({
  id,
  version: 1,
  decode(value) { return { ok: true, value }; },
  encode(value) { return { ok: true, value }; },
});
export function activate(context) {
  const configuration = context.configuration;
  const record = (event) => {
    const marker = configuration && event === "execute"
      ? configuration.executeMarker
      : configuration && event === "reconcile"
        ? configuration.reconcileMarker
        : undefined;
    if (typeof marker === "string") {
      appendFileSync(marker, event + "\\n", "utf8");
    }
  };
  context.registerOperation({
    id: "fixture.recoverable-review@1",
    input: codec("adam.project-change-snapshot"),
    output: codec("fixture.review-result"),
    progress: codec("fixture.review-progress"),
    async execute(input, operation) {
      record("execute");
      await operation.progress("analyzing interrupted project changes");
      if (configuration && configuration.block === true) {
        await new Promise(() => {});
      }
      return { digest: input.digest ?? "fixture", reviewed: true };
    },
    reconcile(input) {
      record("reconcile");
      return { status: "completed", output: { digest: input.digest ?? "fixture", reviewed: true } };
    },
  });
}
`,
    "utf8",
  );
}

async function writeReviewExtensionConfiguration(
  configDirectory: string,
  packageRoot: string,
  configuration: unknown,
): Promise<void> {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await writeFile(
    join(configDirectory, "extensions.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          configuration,
          enabled: true,
          extensionId: "fixture.recoverable-review",
          grants: [],
          packageName: "@fixture/recoverable-review",
          packageRoot,
          packageVersion: "1.0.0",
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

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

test("the production PTY persists owner-only config and trust, completes a finite action, and exits through slash exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-b10-a3-production-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
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
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    const admissionFrame = fixture.screen()?.join("\n") ?? "";
    expect(admissionFrame).toContain("No — Exit Adam");
    expect(admissionFrame).toContain("Yes — Trust and continue");
    expect(admissionFrame).not.toContain("Adam · New session");
    expect(admissionFrame).not.toContain("Select an exact model target");
    const beforeAdmission = fixture.output().length;
    fixture.write("\u001b[B\r");
    await fixture.waitForCompleteFrameAfter("Adam · New session", beforeAdmission);

    let beforeAction = fixture.output().length;
    fixture.write("/trust st");
    await fixture.waitForCompleteFrameAfter("> status", beforeAction);
    const completionFrame = fixture.output().slice(beforeAction);
    expect(completionFrame).toContain("> status");
    expect(completionFrame).not.toContain("→ status");
    fixture.write("\t\r");
    await fixture.waitForAfter("Workspace trust: trusted", beforeAction);

    beforeAction = fixture.output().length;
    fixture.write("/config output 1234\r");
    await fixture.waitForAfter("Saved output limit: 1234 tokens.", beforeAction);
    beforeAction = fixture.output().length;
    fixture.write("/config\r");
    await fixture.waitForCompleteFrameAfter("User model configuration", beforeAction);
    const configurationFrame = fixture.output().slice(beforeAction);
    expect(configurationFrame).toContain("> Context window");
    expect(configurationFrame).toContain("Output limit");
    expect(configurationFrame).toContain("saved 1234 tokens");
    beforeAction = fixture.output().length;
    fixture.write("\u001b");
    await fixture.waitForAfter("Configuration closed.", beforeAction);

    fixture.write("/exit\r");
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("\u001b[?2004l");
    expect(result.stdout).toContain("\u001b[?2026l");
    expect(result.stdout).toContain("\u001b[?25h");

    const configurationPath = join(configDirectory, "config.json");
    const trustPath = join(configDirectory, "workspace-trust.json");
    expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);
    expect((await stat(trustPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configurationPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      modelPolicy: { maximumOutputTokens: 1_234 },
    });
    expect(JSON.parse(await readFile(trustPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      trustedProjectIds: [expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)],
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("real PTY streams Ctrl+T reasoning and restores application mouse modes on exit", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-reasoning-pty-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const controlRoot = join(testRoot, "control");
  await mkdir(workspaceRoot);
  await mkdir(controlRoot);

  try {
    const fixture = startFixture({
      controlRoot,
      external: true,
      scenario: "reasoning-streaming",
      stateRoot,
      workspaceRoot,
    });
    await fixture.waitFor("Adam · New session");
    fixture.write("Exercise PTY reasoning\r");
    await waitForPath(join(controlRoot, "model-started"));
    await fixture.waitFor("Thinking · provider reasoning · adam");
    fixture.write("\u0014");
    await fixture.waitFor("Inspect ");
    await writeFile(join(controlRoot, "release-reasoning"), "release\n", "utf8");
    await fixture.waitFor("Inspect the evidence.");
    await writeFile(join(controlRoot, "release-model"), "release\n", "utf8");
    await waitForPath(join(controlRoot, "reasoning-session-settled"));
    const beforeTail = fixture.output().length;
    fixture.write("\u001b[F");
    await fixture.waitForCompleteFrameAfter("Reasoning answer.", beforeTail);
    fixture.write("\u0011");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("\u001b[?2004h");
    expect(result.stdout).toContain("\u001b[?2004l");
    expect(result.stdout).toContain("\u001b[?25h");
    expect(result.stdout).toContain("╭");
    expect(result.stdout).toContain("╮");
    expect(result.stdout).toContain("╰");
    expect(result.stdout).toContain("╯");
    expect(result.stdout).toContain("Thinking done · adam");
    expect(result.stdout).toContain("\u001b[?1000h");
    expect(result.stdout).toContain("\u001b[?1006h");
    expect(result.stdout).toContain("\u001b[?1000l");
    expect(result.stdout).toContain("\u001b[?1006l");
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
      program: {
        arguments: ["--help"],
        cwd: workspaceRoot,
        entrypoint: productionPath,
        environment: { ADAM_AGENT_STATE_ROOT: stateRoot },
      },
      stateRoot,
      workspaceRoot,
    });
    const result = await fixture.closed;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("Adam Agent TUI");
    expect(result.stdout).toContain("pnpm tui --target deepseek-v4-flash.direct");
    expect(result.stdout).not.toContain("pnpm tui --target fake.local");
    expect(result.stdout).toContain("pnpm tui --resume <session-id>");
    expect(result.stdout).toContain("pnpm tui --no-mouse");
    expect(result.stdout).toContain(
      "Under the default policy, built-in write and execute tools require call-scoped approval.",
    );
    expect(result.stdout).toContain("Credentials remain external plaintext inputs.");
    expect(result.stdout).toContain("Session state and artifacts are owner-only local files.");
    expect(result.stdout).toContain("Adam does not provide an OS, process, or network sandbox.");
    await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production --no-mouse escape hatch reaches startup without mouse capture", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-main-no-mouse-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);

  try {
    const fixture = startFixture({
      program: {
        arguments: [
          "--no-mouse",
          "--target",
          "deepseek-v4-flash.direct",
          "--state-root",
          stateRoot,
        ],
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
    await fixture.waitForCompleteFrameAfter("Workspace trust required", 0);
    fixture.write("\r");
    const result = await fixture.closed;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain("\u001b[?1000h");
    expect(result.stdout).not.toContain("\u001b[?1006h");
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
  const configRoot = join(testRoot, "config");
  const helperPath = join(testRoot, "wl-copy");
  const clipboardMarker = join(testRoot, "clipboard.txt");
  const assistantText = "Production clipboard response.";
  await mkdir(workspaceRoot);
  await writeFile(helperPath, '#!/bin/sh\n/bin/cat > "$ADAM_TEST_CLIPBOARD_MARKER"\n', {
    mode: 0o755,
  });

  try {
    await trustWorkspace(configRoot, workspaceRoot);
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
    const seedLifecycle = createSessionLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    });
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
          XDG_CONFIG_HOME: configRoot,
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
    await expect(waitForFileContents(clipboardMarker, assistantText)).resolves.toBe(assistantText);
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
  const configRoot = join(testRoot, "config");
  await mkdir(workspaceRoot);

  try {
    await trustWorkspace(configRoot, workspaceRoot);
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
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
    await fixture.waitFor("Adam · New session");
    await fixture.waitFor("deepseek-v4-flash.direct · Certified");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI exposes one enabled extension Skill in the first-prompt draft", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-extension-skill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const packageRoot = join(testRoot, "extension-package");
  const skillDirectory = join(packageRoot, "skills", "extension-procedure");
  await mkdir(workspaceRoot);
  await writeRecoverableReviewPackage(packageRoot);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: extension-procedure\ndescription: Runs only from one enabled production extension.\n---\nExtension procedure body.\n",
    "utf8",
  );
  await writeReviewExtensionConfiguration(configDirectory, packageRoot, { block: false });

  try {
    await trustWorkspace(configRoot, workspaceRoot);
    const fixture = startFixture({
      program: {
        arguments: ["--target", "deepseek-v4-flash.direct", "--state-root", stateRoot],
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
    await fixture.waitFor("Adam · New session");
    const beforePalette = fixture.output().length;
    fixture.write("/skills\r");
    await fixture.waitForCompleteFrameAfter("Select next-turn Skills", beforePalette);
    const paletteFrame = fixture.output().slice(beforePalette);
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    expect(paletteFrame).toContain("extension-procedure ·");
    expect(paletteFrame).toContain("Runs only from one enabled production extension.");
    expect(paletteFrame).toContain("extension:fixture.recoverable-review@1.0.0 · available");
    expect(paletteFrame).not.toContain("No matching commands");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI reviews real Git changes through the exact public Eve adapter and survives restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-eve-registry-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const terminalProcessMarker = join(testRoot, "terminal-process");
  await mkdir(workspaceRoot);
  await execFile("git", ["init", "--initial-branch=main"], { cwd: workspaceRoot });
  await execFile("git", ["config", "user.name", "Adam Test"], { cwd: workspaceRoot });
  await execFile("git", ["config", "user.email", "adam@example.invalid"], {
    cwd: workspaceRoot,
  });
  await writeFile(join(workspaceRoot, ".gitignore"), "ignored.ts\n", "utf8");
  await writeFile(join(workspaceRoot, "reviewed.ts"), "export const answer = 1;\n", "utf8");
  await writeFile(join(workspaceRoot, "staged.ts"), "export const staged = 1;\n", "utf8");
  await execFile("git", ["add", ".gitignore", "reviewed.ts", "staged.ts"], {
    cwd: workspaceRoot,
  });
  await execFile("git", ["commit", "-m", "fixture base"], { cwd: workspaceRoot });
  await writeFile(join(workspaceRoot, "reviewed.ts"), "export const answer = 2;\n", "utf8");
  await writeFile(join(workspaceRoot, "staged.ts"), "export const staged = 2;\n", "utf8");
  await execFile("git", ["add", "staged.ts"], { cwd: workspaceRoot });
  await writeFile(join(workspaceRoot, "untracked.ts"), "export const added = true;\n", "utf8");
  await writeFile(join(workspaceRoot, "ignored.ts"), "export const ignored = true;\n", "utf8");
  const beforeStatus = (await execFile("git", ["status", "--porcelain=v1"], { cwd: workspaceRoot }))
    .stdout;
  expect(beforeStatus).toBe(" M reviewed.ts\nM  staged.ts\n?? untracked.ts\n");

  const adapterRoot = await realpath(
    join(productRoot, "node_modules", "@eve-reviewer", "adam-extension"),
  );
  const adapterPackage = JSON.parse(await readFile(join(adapterRoot, "package.json"), "utf8"));
  const coreRoot = await realpath(join(adapterRoot, "..", "core"));
  const corePackage = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"));
  expect(adapterPackage).toMatchObject({
    name: "@eve-reviewer/adam-extension",
    version: "0.3.0",
    dependencies: { "@eve-reviewer/core": "0.2.0" },
    peerDependencies: { "@adam-agent/extension-api": "0.3.0" },
  });
  expect(corePackage).toMatchObject({ name: "@eve-reviewer/core", version: "0.2.0" });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await writeFile(
    join(configDirectory, "extensions.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          configuration: null,
          enabled: true,
          extensionId: "eve-reviewer",
          grants: [
            { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
            { id: "adam.artifact.publish@1", version: "1.0.0" },
            { id: "adam.storage.records@1", version: "1.0.0" },
          ],
          packageName: "@eve-reviewer/adam-extension",
          packageRoot: adapterRoot,
          packageVersion: "0.3.0",
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  const environment = {
    ADAM_TEST_TERMINAL_PROCESS_MARKER: terminalProcessMarker,
    DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
    XDG_CONFIG_HOME: configRoot,
  } as const;
  const modelTargets = createModelTargets({ environment });
  const targetIdentity = (
    await modelTargets.snapshot({ signal: new AbortController().signal })
  ).targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash.direct")?.identity;
  if (targetIdentity === undefined) {
    throw new Error("The registry Eve fixture requires the DeepSeek Flash target.");
  }
  const seedLifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const created = await seedLifecycle.create({ targetIdentity });
  await seedLifecycle.close();
  const program = {
    arguments: ["--resume", created.sessionId, "--state-root", stateRoot],
    cwd: workspaceRoot,
    entrypoint: productionFixturePath,
    environment,
  } as const;

  try {
    await trustWorkspace(configRoot, workspaceRoot);
    const fixture = startFixture({ program, stateRoot, terminalProcessMarker, workspaceRoot });
    await fixture.waitFor("Adam · New session");
    await fixture.resize(120, 40);
    fixture.write("/review\r");
    await fixture.waitFor("eve-reviewer@0.3.0");
    await fixture.waitFor("Completed");
    await fixture.waitFor("Report · eve-reviewer.review-result@1 · application/json");

    let beforeResize = fixture.output().length;
    await fixture.resize(40, 24);
    await fixture.waitForCompleteFrameAfter("Completed", beforeResize);
    await fixture.waitForCompleteFrameAfter("/artifacts inspect report", beforeResize);
    beforeResize = fixture.output().length;
    await fixture.resize(80, 24);
    await fixture.waitForCompleteFrameAfter("/artifacts inspect report", beforeResize);
    beforeResize = fixture.output().length;
    await fixture.resize(120, 40);
    await fixture.waitForCompleteFrameAfter("eve-reviewer.local-worktree-review@1", beforeResize);

    fixture.write("/artifacts\r");
    await fixture.waitFor("Review project changes report");
    fixture.write("\r");
    await fixture.waitFor("Artifact detail");
    await fixture.waitFor("schemaVersion");
    fixture.write("\u0011");
    const firstResult = await fixture.closed;
    expect(firstResult).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(firstResult.stdout).toContain("\u001b[?2004l");
    expect(firstResult.stdout).toContain("\u001b[?25h");

    const resumed = startFixture({ program, stateRoot, terminalProcessMarker, workspaceRoot });
    await resumed.waitForCompleteFrameAfter("Completed", 0);
    const beforeRestartResize = resumed.output().length;
    await resumed.resize(120, 40);
    await resumed.waitForCompleteFrameAfter(
      "eve-reviewer.local-worktree-review@1",
      beforeRestartResize,
    );
    await resumed.waitForCompleteFrameAfter(
      "Report · eve-reviewer.review-result@1",
      beforeRestartResize,
    );
    const restartedFrame = resumed.screen()?.join("\n") ?? "";
    expect(restartedFrame.match(/eve-reviewer\.local-worktree-review@1/gu) ?? []).toHaveLength(1);
    expect(restartedFrame).toContain("Report · eve-reviewer.review-result@1");
    resumed.write("\u0011");
    await expect(resumed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });

    const afterStatus = (
      await execFile("git", ["status", "--porcelain=v1"], { cwd: workspaceRoot })
    ).stdout;
    expect(afterStatus).toBe(beforeStatus);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a missing configured package disables admission while preserving generic historical operations", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-missing-extension-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const packageRoot = join(testRoot, "recoverable-review");
  const terminalProcessMarker = join(testRoot, "terminal-process");
  await mkdir(workspaceRoot);
  await writeRecoverableReviewPackage(packageRoot);
  await writeReviewExtensionConfiguration(configDirectory, packageRoot, { block: false });
  const environment = {
    ADAM_TEST_TERMINAL_PROCESS_MARKER: terminalProcessMarker,
    DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
    XDG_CONFIG_HOME: configRoot,
  } as const;
  const modelTargets = createModelTargets({ environment });
  const targetIdentity = (
    await modelTargets.snapshot({ signal: new AbortController().signal })
  ).targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash.direct")?.identity;
  if (targetIdentity === undefined) {
    throw new Error("The missing-extension fixture requires the DeepSeek Flash target.");
  }
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const created = await lifecycle.create({ targetIdentity });
  await lifecycle.close();
  const operationStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        configuration: { block: false },
        enabled: true,
        extensionId: "fixture.recoverable-review",
        grants: [],
        packageName: "@fixture/recoverable-review",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    operationStore,
    projectRoot: workspaceRoot,
    stateRoot,
  });

  try {
    await trustWorkspace(configRoot, workspaceRoot);
    await host.loadConfiguredExtensions();
    const reference = await host.operations.startLinked({
      contributionId: "fixture.recoverable-review@1",
      idempotencyKey: "missing-package-history",
      input: { digest: `sha256:${"a".repeat(64)}` },
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: created.sessionId,
        sourceSequence: created.lastSequence,
      },
    });
    for await (const record of host.operations.events({ operationId: reference.operationId })) {
      if (record.event.type === "operation_completed") {
        break;
      }
    }
    await rm(packageRoot, { recursive: true, force: true });

    const fixture = startFixture({
      program: {
        arguments: ["--resume", created.sessionId, "--state-root", stateRoot],
        cwd: workspaceRoot,
        entrypoint: productionFixturePath,
        environment,
      },
      stateRoot,
      terminalProcessMarker,
      workspaceRoot,
    });
    await fixture.waitFor("Configured extension packages are unavailable");
    await fixture.resize(120, 40);
    await fixture.waitFor("fixture.recoverable-review@1");
    await fixture.waitFor("Completed");
    await fixture.waitFor("generic");
    fixture.write("/review\r");
    await fixture.waitFor("Unknown command /review");
    fixture.write("\u0011");
    await expect(fixture.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the production TUI rehydrates and explicitly recovers one operation after process interruption", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-operation-restart-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  const packageRoot = join(testRoot, "recoverable-review");
  const executionMarker = join(testRoot, "operation-execution");
  const reconciliationMarker = join(testRoot, "operation-reconciliation");
  const terminalProcessMarker = join(testRoot, "terminal-process");
  await mkdir(workspaceRoot);
  await execFile("git", ["init", "--initial-branch=main"], { cwd: workspaceRoot });
  await execFile("git", ["config", "user.name", "Adam Test"], { cwd: workspaceRoot });
  await execFile("git", ["config", "user.email", "adam@example.invalid"], {
    cwd: workspaceRoot,
  });
  await writeFile(join(workspaceRoot, "reviewed.ts"), "export const answer = 1;\n", "utf8");
  await execFile("git", ["add", "reviewed.ts"], { cwd: workspaceRoot });
  await execFile("git", ["commit", "-m", "fixture base"], { cwd: workspaceRoot });
  await writeFile(join(workspaceRoot, "reviewed.ts"), "export const answer = 2;\n", "utf8");
  const beforeStatus = (await execFile("git", ["status", "--porcelain=v1"], { cwd: workspaceRoot }))
    .stdout;
  await writeRecoverableReviewPackage(packageRoot);
  await writeReviewExtensionConfiguration(configDirectory, packageRoot, {
    block: true,
    executeMarker: executionMarker,
    reconcileMarker: reconciliationMarker,
  });
  const environment = {
    ADAM_TEST_TERMINAL_PROCESS_MARKER: terminalProcessMarker,
    DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
    XDG_CONFIG_HOME: configRoot,
  } as const;
  const modelTargets = createModelTargets({ environment });
  const targetIdentity = (
    await modelTargets.snapshot({ signal: new AbortController().signal })
  ).targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash.direct")?.identity;
  if (targetIdentity === undefined) {
    throw new Error("The operation restart fixture requires the DeepSeek Flash target.");
  }
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const created = await lifecycle.create({ targetIdentity });
  await lifecycle.close();
  const program = {
    arguments: ["--resume", created.sessionId, "--state-root", stateRoot],
    cwd: workspaceRoot,
    entrypoint: productionFixturePath,
    environment,
  } as const;

  try {
    await trustWorkspace(configRoot, workspaceRoot);
    const interrupted = startFixture({
      program,
      stateRoot,
      terminalProcessMarker,
      workspaceRoot,
    });
    await interrupted.waitFor("Adam · New session");
    interrupted.write("/review\r");
    await interrupted.waitFor("Running · analyzing interrupted project changes");
    await waitForPath(executionMarker);
    await interrupted.terminate("SIGKILL");
    await interrupted.closed;

    const resumed = startFixture({ program, stateRoot, terminalProcessMarker, workspaceRoot });
    await resumed.waitFor("Recovery required");
    await resumed.waitFor("Ctrl+R recover");
    await resumed.resize(120, 40);
    const beforeRecovery = resumed.output().length;
    resumed.write("\u0012");
    await resumed.waitForCompleteFrameAfter("Completed", beforeRecovery);
    await waitForPath(reconciliationMarker);
    expect(await readFile(executionMarker, "utf8")).toBe("execute\n");
    expect(await readFile(reconciliationMarker, "utf8")).toBe("reconcile\n");
    resumed.write("\u0011");
    await expect(resumed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(
      (await execFile("git", ["status", "--porcelain=v1"], { cwd: workspaceRoot })).stdout,
    ).toBe(beforeStatus);
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
  const configRoot = join(testRoot, "config");
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
    environment: {
      DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
      XDG_CONFIG_HOME: configRoot,
    },
  } as const;

  try {
    const workspaceTrust = createWorkspaceTrust({
      environment: { XDG_CONFIG_HOME: configRoot },
      workspaceRoot,
    });
    const trustStatus = await workspaceTrust.load();
    if (trustStatus.projectId === null) {
      throw new Error("The MCP reactivation fixture requires one canonical project identity.");
    }
    await workspaceTrust.setTrusted({ projectId: trustStatus.projectId, trusted: true });
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: "test-deepseek-key" },
      fetch: async () =>
        new Response(
          'data: {"id":"mcp-seed","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"MCP seed ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
    });
    const targets = await modelTargets.snapshot({ signal: new AbortController().signal });
    const targetIdentity = targets.targets.find(
      ({ identity }) => identity.targetId === "deepseek-v4-flash.direct",
    )?.identity;
    if (targetIdentity === undefined) {
      throw new Error("The MCP reactivation fixture requires the DeepSeek Flash target.");
    }
    const seedLifecycle = createSessionLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
      workspaceTrust,
    });
    const created = await seedLifecycle.create({ targetIdentity });
    await seedLifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Create the durable MCP reactivation session." },
    });
    await seedLifecycle.setSessionManualName({
      sessionId: created.sessionId,
      name: "MCP reactivation session",
    });
    await seedLifecycle.close();

    const seed = startFixture({
      program: {
        ...program,
        arguments: ["--resume", created.sessionId, "--state-root", stateRoot],
      },
      stateRoot,
      workspaceRoot,
    });
    await seed.waitForCompleteFrameAfter("Adam · MCP reactivation session", 0);
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
    await resumed.waitForCompleteFrameAfter("MCP reactivation session", beforeSessionSelection);
    const beforeOpen = resumed.output().length;
    resumed.write("\r");
    await resumed.waitForCompleteFrameAfter("Adam · MCP reactivation session", beforeOpen);
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
    const activeMcpPid = Number(await readFile(spawnMarker, "utf8"));
    expect(() => process.kill(activeMcpPid, 0)).not.toThrow();
    let revokeFailure: unknown;
    try {
      await execFile(process.execPath, [cliPath, "--revoke-workspace-trust"], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          ADAM_AGENT_STATE_ROOT: join(testRoot, "independent-cli-state"),
          XDG_CONFIG_HOME: configRoot,
        },
      });
    } catch (error) {
      revokeFailure = error;
    }
    expect(revokeFailure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Another Adam MCP runtime owns this canonical project."),
    });
    await expect(workspaceTrust.load()).resolves.toMatchObject({ status: "trusted" });
    expect(() => process.kill(activeMcpPid, 0)).not.toThrow();
    const closesBeforeRuntimeExit = await readFile(closeMarker, "utf8");
    resumed.write("\u0011");
    await expect(resumed.closed).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
    await expect(
      waitForFileContents(closeMarker, `${closesBeforeRuntimeExit}closed\n`),
    ).resolves.toBe(`${closesBeforeRuntimeExit}closed\n`);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the TUI process preserves the MCP shutdown diagnosis across a terminal cleanup failure", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-tui-mcp-close-unconfirmed-"));
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
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("MCP shutdown could not be confirmed.");
    await waitForPath(join(controlRoot, "terminal-restoration-failed"));
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
      await fixture.waitForAfter(`\u001b[19;${expectedColumn}H`, beforeMove);
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
