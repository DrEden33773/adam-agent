import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessPlanCommandExecutionV1,
  createPlanGitAttestationV1,
  createPlanShellEnvironmentV1,
  resolvePlanTrustedExecutableV1,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("Plan executable policy rejects hostile Git config and symlink path operands", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-plan-executable-policy-"));
  const workspaceRoot = join(testRoot, "workspace");
  const outsidePath = join(testRoot, "outside.txt");
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  process.env[executablePathName] = "/usr/bin:/bin";
  await mkdir(workspaceRoot);
  await writeFile(outsidePath, "outside\n", "utf8");
  await writeFile(join(workspaceRoot, "safeq"), "safe\n", "utf8");
  await symlink(outsidePath, join(workspaceRoot, "linked.txt"));
  await symlink(outsidePath, join(workspaceRoot, "safe\\q"));
  await runGit(workspaceRoot, ["init"]);

  try {
    const shellEnvironment = await createPlanShellEnvironmentV1();
    const gitExecutable = await resolvePlanTrustedExecutableV1({
      commandName: "git",
      shellEnvironment,
      workspaceRoot,
    });
    if (gitExecutable === undefined) {
      throw new Error("Expected the supported trusted Git executable.");
    }
    const gitAttestation = createPlanGitAttestationV1({
      executable: gitExecutable,
      shellEnvironmentDigest: shellEnvironment.digest,
    });
    const linkedPath = await assessPlanCommandExecutionV1({
      rawCommand: "head -n 1 -- linked.txt",
      shellEnvironment,
      workspaceRoot,
      gitAttestation,
    });
    const quotedBackslashPath = await assessPlanCommandExecutionV1({
      rawCommand: 'head -n 1 -- "safe\\q"',
      shellEnvironment,
      workspaceRoot,
      gitAttestation,
    });
    const configPath = join(workspaceRoot, ".git", "config");
    const config = await readFile(configPath, "utf8");
    const absoluteHooksPath = join(workspaceRoot, "hooks");
    await mkdir(absoluteHooksPath);
    await writeFile(configPath, `${config}\n[core]\n\thooksPath = ${absoluteHooksPath}\n`, "utf8");
    const absoluteHooksGit = await assessPlanCommandExecutionV1({
      rawCommand:
        "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
      shellEnvironment,
      workspaceRoot,
      gitAttestation,
    });
    await writeFile(configPath, `${config}\n[alias]\n\tinspect = !touch escaped\n`, "utf8");
    const hostileGit = await assessPlanCommandExecutionV1({
      rawCommand:
        "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
      shellEnvironment,
      workspaceRoot,
      gitAttestation,
    });

    expect(linkedPath).toMatchObject({
      disposition: "ask_ambiguous",
      reasons: ["path_untrusted"],
    });
    expect(quotedBackslashPath).toMatchObject({
      disposition: "ask_ambiguous",
      reasons: ["path_untrusted"],
    });
    expect(absoluteHooksGit).toMatchObject({
      disposition: "allow_inspection",
      reasons: ["automatic_git_inspection"],
    });
    expect(hostileGit).toMatchObject({
      disposition: "ask_ambiguous",
      reasons: ["git_repository_untrusted"],
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Plan executable policy rejects every untrusted Git repository topology and config family", async () => {
  const executablePathName = "PATH";
  const previousPath = process.env[executablePathName];
  process.env[executablePathName] = "/usr/bin:/bin";
  const cases = [
    {
      label: "missing canonical objects directory",
      mutate: async (workspaceRoot: string) => {
        await rm(join(workspaceRoot, ".git", "objects"), { recursive: true, force: true });
      },
    },
    {
      label: "partial-clone promisor pack",
      mutate: async (workspaceRoot: string) => {
        const packRoot = join(workspaceRoot, ".git", "objects", "pack");
        await mkdir(packRoot, { recursive: true });
        await writeFile(join(packRoot, "pack-test.promisor"), "", "utf8");
      },
    },
    {
      label: "Git administration traversal above its entry cap",
      mutate: async (workspaceRoot: string) => {
        const oversizedRoot = join(workspaceRoot, ".git", "oversized");
        await mkdir(oversizedRoot);
        const names = Array.from({ length: 4_097 }, (_, index) =>
          join(oversizedRoot, index.toString(16).padStart(4, "0")),
        );
        for (let index = 0; index < names.length; index += 128) {
          await Promise.all(names.slice(index, index + 128).map((path) => mkdir(path)));
        }
      },
    },
    {
      label: "malformed quoted config value",
      mutate: async (workspaceRoot: string) => {
        await writeFile(
          join(workspaceRoot, ".git", "config"),
          '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = "unterminated\n',
          "utf8",
        );
      },
    },
    {
      label: "duplicate singleton config value",
      mutate: async (workspaceRoot: string) => {
        await writeFile(
          join(workspaceRoot, ".git", "config"),
          "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = first\n\tname = second\n",
          "utf8",
        );
      },
    },
    {
      label: "symlinked hooksPath",
      mutate: async (workspaceRoot: string, testRoot: string) => {
        const outsideHooks = join(testRoot, "outside-hooks");
        await mkdir(outsideHooks);
        await symlink(outsideHooks, join(workspaceRoot, "hooks-link"));
        await writeFile(
          join(workspaceRoot, ".git", "config"),
          "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\thooksPath = hooks-link\n",
          "utf8",
        );
      },
    },
  ] as const;

  try {
    for (const fixture of cases) {
      const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-plan-git-repository-"));
      const workspaceRoot = join(testRoot, "workspace");
      await mkdir(workspaceRoot);
      try {
        await runGit(workspaceRoot, ["init"]);
        const shellEnvironment = await createPlanShellEnvironmentV1();
        const gitExecutable = await resolvePlanTrustedExecutableV1({
          commandName: "git",
          shellEnvironment,
          workspaceRoot,
        });
        if (gitExecutable === undefined) {
          throw new Error("Expected the supported trusted Git executable.");
        }
        const gitAttestation = createPlanGitAttestationV1({
          executable: gitExecutable,
          shellEnvironmentDigest: shellEnvironment.digest,
        });
        await fixture.mutate(workspaceRoot, testRoot);
        const assessed = await assessPlanCommandExecutionV1({
          rawCommand:
            "git --no-pager status --porcelain=v1 --untracked-files=normal --ignore-submodules=all",
          shellEnvironment,
          workspaceRoot,
          gitAttestation,
        });
        expect(assessed, fixture.label).toMatchObject({
          disposition: "ask_ambiguous",
          reasons: ["git_repository_untrusted"],
        });
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[executablePathName];
    } else {
      process.env[executablePathName] = previousPath;
    }
  }
});

async function runGit(workspaceRoot: string, arguments_: readonly string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("/usr/bin/git", arguments_, {
      cwd: workspaceRoot,
      env: {
        HOME: workspaceRoot,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "ignore",
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Git fixture failed: ${String(code)}/${String(signal)}`));
      }
    });
  });
}
