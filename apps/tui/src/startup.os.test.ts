import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

// The entry's help/error contract must work without loading runtime, provider or renderer packages.
test("built entries handle help and invalid arguments without application dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-startup-boundary-"));
  const hook = join(root, "offline-entry.mjs");
  await mkdir(join(root, ".env"));
  await writeFile(
    hook,
    `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("/")) {
    throw new Error("Application dependency loaded before command validation: " + specifier);
  }
  return nextResolve(specifier, context);
} });`,
  );
  try {
    for (const fixture of [
      { app: "cli", args: ["--help"], code: 0, text: "Usage: adam-agent <prompt>" },
      { app: "cli", args: ["--branch"], code: 1, text: "Usage: adam-agent --branch" },
      { app: "tui", args: ["--help"], code: 0, text: "Adam Agent TUI" },
      { app: "tui", args: ["--todo-lines", "2"], code: 1, text: "Todo options require" },
      {
        app: "tui",
        args: ["--resume", "example", "--target", "example"],
        code: 1,
        text: "--resume and --target cannot be combined.",
      },
    ]) {
      const entry = fileURLToPath(new URL(`../../${fixture.app}/dist/main.js`, import.meta.url));
      const result = await new Promise<{
        code: string | number;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          ["--import", hook, entry, ...fixture.args],
          {
            cwd: root,
            env: { HOME: root, XDG_CONFIG_HOME: root },
            timeout: terminalObservationTimeoutMilliseconds,
            killSignal: "SIGKILL",
          },
          (error, stdout, stderr) => {
            resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr });
          },
        );
      });
      expect({ code: result.code, signal: result.signal }).toEqual({
        code: fixture.code,
        signal: null,
      });
      expect(fixture.code === 0 ? result.stdout : result.stderr).toContain(fixture.text);
      expect(fixture.code === 0 ? result.stderr : result.stdout).toBe("");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the offline target catalog is usable without loading provider SDKs", async () => {
  const agentUrl = new URL("../../../packages/agent/dist/index.js", import.meta.url).href;
  const program = `
    import { registerHooks } from "node:module";
    import { strict as assert } from "node:assert";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (["openai", "@ai-sdk/deepseek", "@ai-sdk/gateway"].includes(specifier)) {
        throw new Error("Unused provider SDK loaded: " + specifier);
      }
      return nextResolve(specifier, context);
    } });
    const { createModelTargets } = await import(${JSON.stringify(agentUrl)});
    const snapshot = await createModelTargets({ environment: {} }).snapshot({ signal: new AbortController().signal });
    const direct = snapshot.targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash.direct");
    assert.equal(direct.readiness.status, "missing");
    assert.equal(direct.catalog.displayName, "DeepSeek V4 Flash");
    assert.ok(snapshot.targets.some(({ identity }) => identity.route === "vercel-ai-gateway"));
    process.stdout.write("offline-catalog-ready");
  `;
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          timeout: terminalObservationTimeoutMilliseconds,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    },
  );
  expect(result).toEqual({ error: null, stdout: "offline-catalog-ready", stderr: "" });
});
