import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const sourcePackage = fileURLToPath(new URL("../../extension-api", import.meta.url));

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "adam-api-release-"));
  const repository = join(root, "checkout");
  const remote = join(root, "origin.git");
  const packageRoot = join(repository, "packages", "extension-api");
  await mkdir(packageRoot, { recursive: true });
  for (const file of ["package.json", "verify-release.mjs"])
    await copyFile(join(sourcePackage, file), join(packageRoot, file));
  const git = (...arguments_: string[]) =>
    exec(
      "git",
      [
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...arguments_,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Release fixture");
  await git("init", "--bare", "--quiet", remote);
  await git("remote", "add", "origin", remote);
  await git("push", "--quiet", "origin", "main");
  await git("fetch", "--quiet", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  await git("tag", "extension-api-v0.6.0");
  return {
    git,
    async commitChange() {
      await writeFile(join(repository, "change.txt"), "a later commit\n");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "Later commit");
    },
    async dirty() {
      await writeFile(join(packageRoot, "unexpected.txt"), "Unreviewed package content\n");
    },
    async verify(overrides: Record<string, string> = {}) {
      const commit = (await git("rev-parse", "HEAD")).stdout.trim();
      return exec(process.execPath, [join(packageRoot, "verify-release.mjs")], {
        cwd: repository,
        encoding: "utf8",
        env: {
          // biome-ignore lint/complexity/useLiteralKeys: Node's ProcessEnv requires indexed access.
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "extension-api-v0.6.0",
          GITHUB_SHA: commit,
          ...overrides,
        },
      });
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("release staging accepts the actual clean version tag at freshly fetched main", async () => {
  const fixture = await releaseFixture();
  try {
    const result = await fixture.verify();
    expect(JSON.parse(result.stdout)).toMatchObject({
      package: "@adam-agent/extension-api",
      version: "0.6.0",
      tag: "extension-api-v0.6.0",
    });
  } finally {
    await fixture.close();
  }
});

test.each([
  { GITHUB_REF_TYPE: "branch" },
  { GITHUB_REF_NAME: "extension-api-v0.6.1" },
  { GITHUB_SHA: "0000000000000000000000000000000000000000" },
])("release staging rejects mismatched GitHub ref facts: %j", async (overrides) => {
  const fixture = await releaseFixture();
  try {
    await expect(fixture.verify(overrides)).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test("release staging rejects an actual tag at another commit even with matching environment claims", async () => {
  const fixture = await releaseFixture();
  try {
    await fixture.commitChange();
    await fixture.git("push", "--quiet", "origin", "main");
    await fixture.git(
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
    );
    await expect(fixture.verify()).rejects.toMatchObject({
      stderr: expect.stringContaining("release tag does not target"),
    });
  } finally {
    await fixture.close();
  }
});

test("release staging rejects a tag outside freshly fetched main", async () => {
  const fixture = await releaseFixture();
  try {
    await fixture.commitChange();
    await fixture.git("tag", "--force", "extension-api-v0.6.0");
    await expect(fixture.verify()).rejects.toMatchObject({
      stderr: expect.stringContaining("freshly fetched product main"),
    });
  } finally {
    await fixture.close();
  }
});

test("release staging rejects unreviewed working-tree content", async () => {
  const fixture = await releaseFixture();
  try {
    await fixture.dirty();
    await expect(fixture.verify()).rejects.toMatchObject({
      stderr: expect.stringContaining("clean release checkout"),
    });
  } finally {
    await fixture.close();
  }
});
