import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const releaseVerifier = fileURLToPath(
  new URL("../../extension-api/verify-release.mjs", import.meta.url),
);
const releaseWorkflow = fileURLToPath(
  new URL("../../../.github/workflows/publish-extension-api.yml", import.meta.url),
);

interface ReleaseEnvironment {
  readonly GITHUB_REF_NAME: string;
  readonly GITHUB_REF_TYPE: string;
  readonly GITHUB_SHA: string;
}

async function currentCommit(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

function verifyRelease(environment: ReleaseEnvironment) {
  return execFileAsync(process.execPath, [releaseVerifier], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...environment,
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    },
  });
}

test("the extension API release verifier accepts its exact tagged checkout", async () => {
  const commit = await currentCommit();
  await expect(
    verifyRelease({
      GITHUB_REF_NAME: "extension-api-v0.2.0",
      GITHUB_REF_TYPE: "tag",
      GITHUB_SHA: commit,
    }),
  ).resolves.toMatchObject({ stderr: "" });
});

test.each([
  {
    environment: {
      GITHUB_REF_NAME: "extension-api-v0.2.0",
      GITHUB_REF_TYPE: "branch",
    },
    name: "a branch ref",
  },
  {
    environment: {
      GITHUB_REF_NAME: "extension-api-v0.2.1",
      GITHUB_REF_TYPE: "tag",
    },
    name: "a different version tag",
  },
])("the extension API release verifier rejects $name", async ({ environment }) => {
  await expect(
    verifyRelease({ ...environment, GITHUB_SHA: await currentCommit() }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("Release must run from the exact tag extension-api-v0.2.0."),
  });
});

test("the extension API release verifier rejects a tag at another commit", async () => {
  await expect(
    verifyRelease({
      GITHUB_REF_NAME: "extension-api-v0.2.0",
      GITHUB_REF_TYPE: "tag",
      GITHUB_SHA: "0000000000000000000000000000000000000000",
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "The GitHub release ref does not match the checked-out commit.",
    ),
  });
});

test("the extension API release workflow stages only a verified exact tag through OIDC", async () => {
  const workflow = await readFile(releaseWorkflow, "utf8");

  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("contents: read");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v6/u);
  expect(workflow).toMatch(/uses: actions\/setup-node@[0-9a-f]{40} # v6/u);
  expect(workflow).toContain("package-manager-cache: false");
  expect(workflow).toContain("npm install --global npm@12.0.1 --ignore-scripts");
  expect(workflow).toContain("pnpm install --frozen-lockfile --ignore-scripts");
  expect(workflow).toContain("git fetch --no-tags --depth=1 origin main");
  expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)"');
  expect(workflow).toContain("node packages/extension-api/verify-release.mjs");
  expect(workflow).toContain("pnpm quality:check");
  expect(workflow).toContain("working-directory: packages/extension-api");
  expect(workflow).toContain("npm stage publish --access public");
  expect(workflow).not.toContain("NODE_AUTH_TOKEN");
});
