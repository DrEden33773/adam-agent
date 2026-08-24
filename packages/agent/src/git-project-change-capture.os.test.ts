import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";
import { createExtensionHost } from "./extension-host.js";
import {
  createGitProjectChangeCaptureAdapter,
  createObservedGitProjectChangeCaptureAdapter,
} from "./git-project-change-capture.js";
import { createProjectChangeMaterializer } from "./project-change-materializer.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("the Git adapter captures the final mixed worktree without changing the real index", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, ".gitignore"), "ignored.txt\n", "utf8");
  await writeFile(join(repositoryRoot, "delete.txt"), "delete me\n", "utf8");
  await writeFile(join(repositoryRoot, "rename-old.txt"), "rename me\n", "utf8");
  await writeFile(join(repositoryRoot, "staged.txt"), "staged before\n", "utf8");
  await writeFile(join(repositoryRoot, "tracked.txt"), "tracked before\n", "utf8");
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);

  await writeFile(join(repositoryRoot, "staged.txt"), "staged after\n", "utf8");
  await git(repositoryRoot, ["add", "staged.txt"]);
  await writeFile(join(repositoryRoot, "tracked.txt"), "tracked after\n", "utf8");
  await unlink(join(repositoryRoot, "delete.txt"));
  await rename(join(repositoryRoot, "rename-old.txt"), join(repositoryRoot, "rename-new.txt"));
  await writeFile(join(repositoryRoot, "untracked.txt"), "untracked\n", "utf8");
  await writeFile(join(repositoryRoot, "ignored.txt"), "ignored\n", "utf8");
  const indexPath = join(repositoryRoot, ".git", "index");
  const indexBefore = await readFile(indexPath);

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(await readFile(indexPath)).toEqual(indexBefore);
  expect(snapshot.sources.map(({ path, side }) => `${side}:${path}`)).toEqual([
    "base:delete.txt",
    "base:rename-old.txt",
    "base:staged.txt",
    "base:tracked.txt",
    "head:rename-new.txt",
    "head:staged.txt",
    "head:tracked.txt",
    "head:untracked.txt",
  ]);
  expect(snapshot.sources.some(({ path }) => path === "ignored.txt")).toBe(false);
  expect(snapshot.unifiedDiff).toContain("rename from rename-old.txt");
  expect(snapshot.unifiedDiff).toContain("rename to rename-new.txt");
});

test("the Git adapter admits fifty-one renames within the per-side entry bound", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  for (let index = 0; index < 51; index += 1) {
    await writeFile(join(repositoryRoot, `old-${index}.txt`), `${index}\n`, "utf8");
  }
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  for (let index = 0; index < 51; index += 1) {
    await rename(
      join(repositoryRoot, `old-${index}.txt`),
      join(repositoryRoot, `new-${index}.txt`),
    );
  }

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.sources.filter(({ side }) => side === "base")).toHaveLength(51);
  expect(snapshot.sources.filter(({ side }) => side === "head")).toHaveLength(51);
  expect(snapshot.unifiedDiff).toContain("rename from old-0.txt");
  expect(snapshot.unifiedDiff).toContain("rename to new-0.txt");
});

test("ExtensionHost uses the production Git adapter before persisting and executing", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-extension-"));
  temporaryRoots.push(repositoryRoot, packageRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");
  const controlKey = `__adam_git_host_${Math.random().toString(16).slice(2)}`;
  const control = { input: undefined as unknown };
  (globalThis as Record<string, unknown>)[controlKey] = control;
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/real-git-review",
      version: "3.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.real-git-review",
        apiVersion: "^0.3.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            command: {
              id: "eve-reviewer.review",
              name: "review",
              title: "Review project changes",
              version: 1,
            },
            id: "eve-reviewer.local-worktree-review@1",
            input: { id: "adam.project-change-snapshot", version: 1 },
            inputSource: { id: "project_changes", version: 1 },
            kind: "operation",
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode: (value) => ({ ok: true, value }), encode: (value) => ({ ok: true, value }) });
export function activate(context) {
  context.registerOperation({
    id: "eve-reviewer.local-worktree-review@1",
    input: codec("adam.project-change-snapshot"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute(input) {
      globalThis[${JSON.stringify(controlKey)}].input = input;
      return { accepted: true };
    },
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.real-git-review",
        grants: [],
        packageName: "@fixture/real-git-review",
        packageRoot,
        packageVersion: "3.0.0",
      },
    ],
    operationOriginAuthority: { validateBoundary: async () => true },
    projectRoot: repositoryRoot,
  });
  const started = await host.startProjectChanges({
    command: { id: "eve-reviewer.review", version: 1 },
    idempotencyKey: "real-git-review-1",
    origin: {
      invocation: { id: "review", kind: "presentation_command", version: 1 },
      sessionId: "33333333-3333-4333-8333-333333333333",
      sourceSequence: 3,
    },
  });
  for await (const _record of host.operations.events({ operationId: started.operationId })) {
    // Draining through the terminal fact is the causal execution boundary.
  }

  expect(control.input).toMatchObject({
    kind: "adam.project-change-snapshot",
    sources: [
      { content: "before\n", path: "example.txt", side: "base" },
      { content: "after\n", path: "example.txt", side: "head" },
    ],
  });
  delete (globalThis as Record<string, unknown>)[controlKey];
});

test("the Git adapter captures an unborn repository against its explicit empty tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFile(join(repositoryRoot, "first.txt"), "first\n", "utf8");

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.base).toEqual({
    kind: "unborn",
    tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  });
  expect(snapshot.sources.map(({ path, side }) => `${side}:${path}`)).toEqual(["head:first.txt"]);
});

test("the Git adapter records binary, symlink and gitlink sides as unavailable evidence", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  const nestedRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-nested-"));
  temporaryRoots.push(repositoryRoot, nestedRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await git(nestedRoot, ["init", "--initial-branch=main"]);
  await git(nestedRoot, ["config", "user.name", "Adam Test"]);
  await git(nestedRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(nestedRoot, "nested.txt"), "nested\n", "utf8");
  await git(nestedRoot, ["add", "nested.txt"]);
  await git(nestedRoot, ["commit", "-m", "nested"]);
  await writeFile(join(repositoryRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await symlink("missing-target", join(repositoryRoot, "current-link"));
  await rename(nestedRoot, join(repositoryRoot, "nested"));
  temporaryRoots.splice(temporaryRoots.indexOf(nestedRoot), 1);

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.sources).toEqual([]);
  expect(snapshot.unavailable).toEqual([
    { mode: "100644", path: "binary.bin", reason: "binary", side: "head" },
    { mode: "120000", path: "current-link", reason: "symlink", side: "head" },
    { mode: "160000", path: "nested", reason: "gitlink", side: "head" },
  ]);
});

test("the Git adapter keeps the captured candidate when the live worktree changes afterward", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "changing.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "changing.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "changing.txt"), "captured\n", "utf8");
  let observedCandidate = "";

  const snapshot = await createProjectChangeMaterializer(
    createObservedGitProjectChangeCaptureAdapter({
      async afterCandidateTree(candidateTree) {
        observedCandidate = candidateTree;
        await writeFile(join(repositoryRoot, "changing.txt"), "newer live value\n", "utf8");
      },
    }),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.candidateTree).toBe(observedCandidate);
  expect(snapshot.sources.find(({ side }) => side === "head")?.content).toBe("captured\n");
  await expect(readFile(join(repositoryRoot, "changing.txt"), "utf8")).resolves.toBe(
    "newer live value\n",
  );
});

test("the Git adapter derives its diff attributes from the captured candidate tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");

  const snapshot = await createProjectChangeMaterializer(
    createObservedGitProjectChangeCaptureAdapter({
      async afterCandidateTree() {
        await writeFile(join(repositoryRoot, ".gitattributes"), "example.txt binary\n", "utf8");
      },
    }),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.unifiedDiff).toContain("-before\n+after");
  expect(snapshot.unifiedDiff).not.toContain("GIT binary patch");
});

test("the Git adapter records attribute-declared binary text as unavailable evidence", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, ".gitattributes"), "example.txt binary\n", "utf8");
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", ".gitattributes", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.sources).toEqual([]);
  expect(snapshot.unavailable).toEqual([
    { mode: "100644", path: "example.txt", reason: "binary", side: "base" },
    { mode: "100644", path: "example.txt", reason: "binary", side: "head" },
  ]);
});

test("the Git adapter leaves captured objects outside the real object database", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");
  await writeFile(join(repositoryRoot, "private-untracked.txt"), "private\n", "utf8");
  const unreachableBefore = await git(repositoryRoot, ["fsck", "--unreachable", "--no-reflogs"]);

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  await expect(
    git(repositoryRoot, ["cat-file", "-e", `${snapshot.candidateTree}^{tree}`]),
  ).rejects.toBeDefined();
  await expect(git(repositoryRoot, ["fsck", "--unreachable", "--no-reflogs"])).resolves.toEqual(
    unreachableBefore,
  );
});

test("the Git adapter preserves an isolated global excludes file", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  const configurationRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-config-"));
  temporaryRoots.push(repositoryRoot, configurationRoot);
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const previousConfigurationRoot = process.env["XDG_CONFIG_HOME"];

  try {
    await mkdir(join(configurationRoot, "git"), { recursive: true });
    const excludesPath = join(configurationRoot, "global-ignore");
    await writeFile(excludesPath, "ignored-secret.txt\n", "utf8");
    await writeFile(
      join(configurationRoot, "git", "config"),
      `[core]\n\texcludesFile = ${excludesPath}\n`,
      "utf8",
    );
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
    process.env["XDG_CONFIG_HOME"] = configurationRoot;
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
    await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
    await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
    await writeFile(join(repositoryRoot, "included.txt"), "included\n", "utf8");
    await writeFile(join(repositoryRoot, "ignored-secret.txt"), "secret\n", "utf8");

    const snapshot = await createProjectChangeMaterializer(
      createGitProjectChangeCaptureAdapter(),
    ).materialize({ canonicalProjectRoot: repositoryRoot });

    expect(snapshot.sources.map(({ path }) => path)).toEqual(["included.txt"]);
  } finally {
    if (previousConfigurationRoot === undefined) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      process.env["XDG_CONFIG_HOME"] = previousConfigurationRoot;
    }
  }
});

test("the Git adapter preserves an explicit global configuration excludes file", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  const configurationRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-config-"));
  temporaryRoots.push(repositoryRoot, configurationRoot);
  const configurationPath = join(configurationRoot, "custom-global-config");
  const excludesPath = join(configurationRoot, "global-ignore");
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const previousGlobalConfiguration = process.env["GIT_CONFIG_GLOBAL"];

  try {
    await writeFile(excludesPath, "ignored-secret.txt\n", "utf8");
    await writeFile(configurationPath, `[core]\n\texcludesFile = ${excludesPath}\n`, "utf8");
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
    process.env["GIT_CONFIG_GLOBAL"] = configurationPath;
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
    await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
    await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
    await writeFile(join(repositoryRoot, "included.txt"), "included\n", "utf8");
    await writeFile(join(repositoryRoot, "ignored-secret.txt"), "secret\n", "utf8");

    const snapshot = await createProjectChangeMaterializer(
      createGitProjectChangeCaptureAdapter(),
    ).materialize({ canonicalProjectRoot: repositoryRoot });

    expect(snapshot.sources.map(({ path }) => path)).toEqual(["included.txt"]);
  } finally {
    if (previousGlobalConfiguration === undefined) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      delete process.env["GIT_CONFIG_GLOBAL"];
    } else {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      process.env["GIT_CONFIG_GLOBAL"] = previousGlobalConfiguration;
    }
  }
});

test("the Git adapter rejects configured clean filters before they can execute", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  const markerPath = join(repositoryRoot, "filter-executed.txt");
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, ".gitattributes"), "*.txt filter=unsafe\n", "utf8");
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", ".gitattributes", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await git(repositoryRoot, [
    "config",
    "filter.unsafe.clean",
    `sh -c 'printf executed > ${markerPath}'`,
  ]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "repository_state_unsupported" });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("the Git adapter rejects a configured filesystem monitor before its hook can execute", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  const markerPath = join(repositoryRoot, "fsmonitor-executed.txt");
  const hookPath = join(repositoryRoot, ".git", "fsmonitor-hook");
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");
  await writeFile(
    hookPath,
    `#!/bin/sh\nprintf executed > ${JSON.stringify(markerPath)}\nprintf 'token\\0/\\0'\n`,
    "utf8",
  );
  await chmod(hookPath, 0o700);
  await git(repositoryRoot, ["config", "core.fsmonitor", hookPath]);

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "repository_state_unsupported" });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("the Git adapter does not execute repository hooks while writing its temporary index", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  const markerPath = join(repositoryRoot, "hook-executed.txt");
  const hookPath = join(repositoryRoot, ".git", "hooks", "post-index-change");
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");
  await writeFile(hookPath, `#!/bin/sh\nprintf executed > ${JSON.stringify(markerPath)}\n`, "utf8");
  await chmod(hookPath, 0o700);

  const snapshot = await createProjectChangeMaterializer(
    createGitProjectChangeCaptureAdapter(),
  ).materialize({ canonicalProjectRoot: repositoryRoot });

  expect(snapshot.sources.map(({ path }) => path)).toEqual(["example.txt", "example.txt"]);
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("the Git adapter fails closed for sparse checkout state", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await git(repositoryRoot, ["config", "core.sparseCheckout", "true"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "repository_state_unsupported" });
});

test("the Git adapter rejects no changes and removes its exact temporary index directory", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "unchanged\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "no_changes" });
  expect(
    (await readdir(join(repositoryRoot, ".git"))).filter((entry) =>
      entry.startsWith("adam-agent-project-changes-"),
    ),
  ).toEqual([]);
});

test("the Git adapter types a temporary-root creation failure", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "changed\n", "utf8");
  const gitDirectory = join(repositoryRoot, ".git");
  await chmod(gitDirectory, 0o500);

  try {
    await expect(
      createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
        canonicalProjectRoot: repositoryRoot,
      }),
    ).rejects.toMatchObject({ code: "repository_unavailable" });
  } finally {
    await chmod(gitDirectory, 0o700);
  }
});

test("the Git adapter rejects an oversized worktree file before writing a candidate tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "oversized.txt"), new Uint8Array(1_000_001));
  let candidateObservations = 0;

  await expect(
    createProjectChangeMaterializer(
      createObservedGitProjectChangeCaptureAdapter({
        afterCandidateTree() {
          candidateObservations += 1;
        },
      }),
    ).materialize({ canonicalProjectRoot: repositoryRoot }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(candidateObservations).toBe(0);
});

test("the Git adapter rejects too many changed paths before writing a candidate tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      writeFile(join(repositoryRoot, `file-${index}.txt`), `${index}\n`, "utf8"),
    ),
  );
  let candidateObservations = 0;

  await expect(
    createProjectChangeMaterializer(
      createObservedGitProjectChangeCaptureAdapter({
        afterCandidateTree() {
          candidateObservations += 1;
        },
      }),
    ).materialize({ canonicalProjectRoot: repositoryRoot }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(candidateObservations).toBe(0);
});

test("the Git adapter rejects aggregate worktree source bytes before writing a candidate tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      writeFile(join(repositoryRoot, `large-${index}.txt`), new Uint8Array(1_000_000).fill(0x61)),
    ),
  );
  let candidateObservations = 0;

  await expect(
    createProjectChangeMaterializer(
      createObservedGitProjectChangeCaptureAdapter({
        afterCandidateTree() {
          candidateObservations += 1;
        },
      }),
    ).materialize({ canonicalProjectRoot: repositoryRoot }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(candidateObservations).toBe(0);
});

test("the Git adapter rejects invalid UTF-8 content after cleaning its temporary index", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "content_invalid_utf8" });
  expect(
    (await readdir(join(repositoryRoot, ".git"))).filter((entry) =>
      entry.startsWith("adam-agent-project-changes-"),
    ),
  ).toEqual([]);
});

test("the Git adapter rejects a path that cannot be represented as strict UTF-8", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  const invalidPath = Buffer.concat([
    Buffer.from(`${repositoryRoot}/`, "utf8"),
    Buffer.from([0xff]),
  ]);
  await writeFile(invalidPath, "invalid path\n", "utf8");

  await expect(
    createProjectChangeMaterializer(createGitProjectChangeCaptureAdapter()).materialize({
      canonicalProjectRoot: repositoryRoot,
    }),
  ).rejects.toMatchObject({ code: "path_invalid" });
});

test("the Git adapter reports one command failure and cleans up without retry", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "adam-project-changes-"));
  temporaryRoots.push(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Adam Test"]);
  await git(repositoryRoot, ["config", "user.email", "adam@example.test"]);
  await writeFile(join(repositoryRoot, "example.txt"), "before\n", "utf8");
  await git(repositoryRoot, ["add", "example.txt"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  await writeFile(join(repositoryRoot, "example.txt"), "after\n", "utf8");
  let candidateObservations = 0;

  await expect(
    createProjectChangeMaterializer(
      createObservedGitProjectChangeCaptureAdapter({
        async afterCandidateTree() {
          candidateObservations += 1;
          await rename(
            join(repositoryRoot, ".git", "objects"),
            join(repositoryRoot, ".git", "objects-away"),
          );
        },
      }),
    ).materialize({ canonicalProjectRoot: repositoryRoot }),
  ).rejects.toMatchObject({ code: "git_command_failed" });
  expect(candidateObservations).toBe(1);
  expect(
    (await readdir(join(repositoryRoot, ".git"))).filter((entry) =>
      entry.startsWith("adam-agent-project-changes-"),
    ),
  ).toEqual([]);
});

async function git(cwd: string, arguments_: readonly string[]): Promise<Buffer> {
  const result = await execFileAsync("git", arguments_, {
    cwd,
    encoding: "buffer",
    maxBuffer: 2_000_000,
  });
  return result.stdout;
}
