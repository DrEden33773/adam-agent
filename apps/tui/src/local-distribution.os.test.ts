import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { startTuiFixture } from "./tui-fixture.test-support.js";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

// Archive creation measured 11.2 s and installation 6.57 s alone; parallel suite I/O exceeded
// the terminal-specific 10 s guard. File operations have their own budget; frame guards stay unchanged.
const applicationFileOperationTimeoutMilliseconds = 45_000;
const phaseTimeoutMilliseconds = 60_000;
const cleanupReserveMilliseconds = 5_000;
let processDeadline = 0;
const packer = new URL("../../../scripts/package-local.mjs", import.meta.url).href;

let distribution: Awaited<ReturnType<typeof prepareDistribution>>;
beforeAll(async () => {
  processDeadline = performance.now() + phaseTimeoutMilliseconds - cleanupReserveMilliseconds;
  distribution = await prepareDistribution();
}, phaseTimeoutMilliseconds);

async function prepareDistribution() {
  const root = await mkdtemp(join(tmpdir(), "adam-local-distribution-"));
  const output = join(root, "output");
  const relocated = join(root, "relocated");
  const prefix = join(root, "prefix with ' quote");
  const home = join(root, "home");
  const config = join(root, "config");
  const state = join(root, "state");
  const path = join(root, "path");
  await mkdir(path);
  await mkdir(home);
  await symlink(process.execPath, join(path, "node"));
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: config,
    ADAM_AGENT_STATE_ROOT: state,
    PATH: `${path}:/usr/bin:/bin`,
    NO_COLOR: "1",
  };
  const run = (
    file: string,
    args: string[],
    cwd = root,
    timeout = terminalObservationTimeoutMilliseconds,
  ) =>
    runProcess(file, args, {
      cwd,
      env,
      timeout,
    });
  try {
    // Quality already built the candidate. Packaging this output does not rebuild concurrently with other suites.
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { packageLocal } = await import(${JSON.stringify(packer)}); await packageLocal(${JSON.stringify(output)});`,
      ],
      root,
      applicationFileOperationTimeoutMilliseconds,
    );
    const archive = (await readdir(output)).find((name) => name.endsWith(".tar.gz"));
    expect(archive).toBeDefined();
    await mkdir(relocated);
    await run("tar", ["-xzf", join(output, archive ?? ""), "-C", relocated]);
    await rm(output, { recursive: true });
    const bundle = join(relocated, (await readdir(relocated))[0] ?? "");
    return { root, relocated, prefix, config, state, bundle, env, run };
  } catch (error) {
    await Promise.all([...activeProcesses].map((process) => process.cleanup()));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test(
  "relocated production package installs, runs tools and history, switches and removes only application files",
  async () => {
    processDeadline = performance.now() + phaseTimeoutMilliseconds - cleanupReserveMilliseconds;
    const { root, relocated, prefix, config, state, bundle, env, run } = distribution;
    try {
      const metadata = JSON.parse(await readFile(join(bundle, "local-package.json"), "utf8"));
      const names = metadata.packages.map((entry: { name: string }) => entry.name);
      for (const excluded of ["@adam-agent/testkit", "vitest", "typescript", "@eve-reviewer/core"])
        expect(names).not.toContain(excluded);
      expect(names).toContain("@vscode/ripgrep");
      expect(names).toContain("@biomejs/biome");
      expect(await readFile(join(bundle, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain(
        "Catppuccin",
      );
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "user-data"), "preserve configuration\n");
      await mkdir(join(prefix, "bin"), { recursive: true });
      const unrelatedLauncher = join(prefix, "bin", "adam");
      await writeFile(unrelatedLauncher, "unrelated user command\n");
      await expect(
        run(process.execPath, [join(bundle, "install.mjs"), "install", prefix]),
      ).rejects.toThrow("Refusing to replace unrelated launcher");
      expect(await readFile(unrelatedLauncher, "utf8")).toBe("unrelated user command\n");
      await rm(unrelatedLauncher);
      await run(
        process.execPath,
        [join(bundle, "install.mjs"), "install", prefix],
        root,
        applicationFileOperationTimeoutMilliseconds,
      );
      const installed = join(prefix, "lib", "adam-agent", metadata.version);
      const cli = join(prefix, "bin", "adam-cli");
      await expect(
        run(process.execPath, [join(bundle, "install.mjs"), "install", prefix]),
      ).rejects.toThrow("EEXIST");
      await expect(
        run(process.execPath, [join(bundle, "install.mjs"), "uninstall", prefix, "../state"]),
      ).rejects.toThrow("exact installed version");
      const projectA = join(root, "project-a");
      const projectB = join(root, "project-b");
      const retainedHistory = new Map<string, string>();
      for (const [project, content] of [
        [projectA, "First portable project."],
        [projectB, "Second portable project."],
      ] as const) {
        await mkdir(project);
        await writeFile(join(project, "README.md"), `${content}\n`);
        await writeFile(join(project, ".env"), "ADAM_AGENT_TARGET=fake.local\n");
        const trusted = await run(cli, ["--trust-workspace"], project);
        const { projectId }: { projectId: string } = JSON.parse(trusted.stdout);
        expect(projectId).toMatch(/^sha256:/);
        expect((await run(cli, ["Read this project"], project)).stdout).toBe(`${content}\n`);
        const directory = join(state, "projects", projectId.slice("sha256:".length), "sessions");
        const logs = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
        expect(logs).toHaveLength(1);
        const log = logs[0];
        if (log === undefined) throw new Error("Missing the project session log");
        const path = join(directory, log);
        retainedHistory.set(path, await readFile(path, "utf8"));
        expect((await run(cli, ["--resume", basename(log, ".jsonl")], project)).stdout).toContain(
          content,
        );
      }

      const agent = metadata.packages.find(
        (entry: { name: string }) => entry.name === "@adam-agent/agent",
      );
      const agentUrl = pathToFileURL(join(installed, agent.path, "dist/index.js")).href;
      const probe = join(root, "tools.mjs");
      await writeFile(
        probe,
        `
      import { strict as assert } from 'node:assert';
      const { createCodingToolRegistry, createBiomeExecutionAdapter } = await import(${JSON.stringify(agentUrl)});
      const tools = createCodingToolRegistry({ workspaceRoot: process.cwd() });
      async function execute(name, input) {
        const prepared = tools.resolve(name).prepare(JSON.stringify(input));
        assert.equal(prepared.status, 'ready');
        return await prepared.execute({ signal: new AbortController().signal, callId: 'local-package', toolName: name, sessionId: 'local-package', toolProfileDigest: 'sha256:local-package' });
      }
      const search = await execute('search_repository', {kind:'content', query:'First portable'});
      assert.equal(search.status, 'completed');
      assert.ok(JSON.stringify(search).includes('README.md'));
      const shell = await execute('run_shell', { command: 'printf portable-subprocess' });
      assert.equal(shell.status, 'completed');
      assert.ok(JSON.stringify(shell).includes('portable-subprocess'));
      const biome = await createBiomeExecutionAdapter().execute({ deadlineAt: new Date(Date.now()+10000).toISOString(), files:[{path:'example.js',content:'debugger;'}], profile:'adam-biome-recommended-v1', signal:new AbortController().signal });
      assert.equal(biome.analyzerVersion, '2.5.8');
      assert.ok(new TextDecoder().decode(biome.report).includes('noDebugger'));
      console.log('native search, shell and Biome complete');
    `,
      );
      expect((await run(process.execPath, [probe], projectA)).stdout).toContain(
        "native search, shell and Biome complete",
      );

      // A second package identity exercises the same version switch without another expensive build.
      const nextVersion = `${metadata.version}-next`;
      await writeFile(
        join(bundle, "local-package.json"),
        JSON.stringify({ ...metadata, version: nextVersion }),
      );
      await run(
        process.execPath,
        [join(bundle, "install.mjs"), "install", prefix],
        root,
        applicationFileOperationTimeoutMilliseconds,
      );
      await rm(relocated, { recursive: true });
      expect(await readlink(join(prefix, "lib", "adam-agent", "current"))).toBe(nextVersion);
      const installer = join(installed, "install.mjs");
      await run(process.execPath, [installer, "use", prefix, metadata.version]);
      expect(await readlink(join(prefix, "lib", "adam-agent", "current"))).toBe(metadata.version);
      expect((await run(cli, ["--help"], projectB)).stdout).toContain("Usage:");

      const fixture = startTuiFixture({
        workspaceRoot: projectB,
        stateRoot: state,
        noColor: true,
        program: {
          cwd: projectB,
          entrypoint: join(installed, "adam.mjs"),
          arguments: ["--target", "deepseek-v4-flash.direct"],
          environment: {
            ...env,
            ADAM_AGENT_TARGET: "",
            DEEPSEEK_API_KEY: "",
            AI_GATEWAY_API_KEY: "",
          },
        },
      });
      try {
        await fixture.waitForScreen("History check complete");
        const beforeNewSession = fixture.output().length;
        fixture.write("\r");
        await fixture.waitForCompleteFrameAfter("DEEPSEEK_API_KEY", beforeNewSession);
        fixture.write("\u0011");
        const result = await fixture.closed;
        expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
        expect(result.stdout).toContain("\u001b[?1049l");
        expect(result.stdout).toContain("\u001b[?2004l");
        expect(result.stdout).toContain("\u001b[?25h");
      } finally {
        await fixture.cleanup();
      }
      await run(process.execPath, [installer, "uninstall", prefix, nextVersion]);
      await run(process.execPath, [installer, "uninstall", prefix, metadata.version]);
      expect(await readFile(join(config, "user-data"), "utf8")).toBe("preserve configuration\n");
      for (const [path, history] of retainedHistory)
        expect(await readFile(path, "utf8")).toBe(history);
      expect(await readFile(join(projectA, ".env"), "utf8")).toBe("ADAM_AGENT_TARGET=fake.local\n");
      expect(await readdir(join(prefix, "bin"))).toEqual([]);
    } finally {
      await Promise.all([...activeProcesses].map((process) => process.cleanup()));
      await rm(root, { recursive: true, force: true });
    }
  },
  phaseTimeoutMilliseconds,
);

const activeProcesses = new Set<{ cleanup(): Promise<void> }>();
const gracefulCleanupMilliseconds = 1_000;
const forcedCleanupMilliseconds = 2_000;

function runProcess(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const timeout = Math.min(options.timeout, processDeadline - performance.now());
  if (timeout <= 0)
    return Promise.reject(
      new Error("Distribution phase deadline reached; cleanup time is reserved."),
    );
  const result = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const closed = Promise.withResolvers<void>();
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let didClose = false;
  let cleanupPromise: Promise<void> | undefined;
  function signal(signal: NodeJS.Signals) {
    if (child.pid === undefined || didClose) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  async function waitForClose(milliseconds: number) {
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.promise.then(() => true),
        new Promise<false>((resolve) => {
          guard = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(guard);
    }
  }
  const owner = {
    cleanup() {
      cleanupPromise ??= (async () => {
        if (didClose) return;
        signal("SIGTERM");
        if (await waitForClose(gracefulCleanupMilliseconds)) return;
        signal("SIGKILL");
        if (!(await waitForClose(forcedCleanupMilliseconds)))
          throw new Error(`Process group did not close: ${file}`);
      })();
      return cleanupPromise;
    },
  };
  activeProcesses.add(owner);
  function fail(error: Error) {
    result.reject(error);
    void owner.cleanup().catch(() => undefined); // The owning test awaits the same cleanup in finally.
  }
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const guard = setTimeout(
    () => fail(new Error(`Process did not close: ${file} ${args.join(" ")}\n${stderr}`)),
    timeout,
  );
  child.once("error", fail);
  child.once("close", (code, signal) => {
    clearTimeout(guard);
    didClose = true;
    activeProcesses.delete(owner);
    closed.resolve();
    if (code !== 0 || signal !== null)
      result.reject(new Error(`${file} exited ${code}/${signal}\n${stderr}`));
    else result.resolve({ stdout, stderr });
  });
  return result.promise;
}
