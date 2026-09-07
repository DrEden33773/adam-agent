import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

if (manifest.name !== "@adam-agent/extension-api" || typeof manifest.version !== "string") {
  throw new TypeError("The extension API release manifest has an unexpected identity.");
}

const expectedTag = `extension-api-v${manifest.version}`;
if (process.env.GITHUB_REF_TYPE !== "tag" || process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new TypeError(`Release must run from the exact tag ${expectedTag}.`);
}

const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
const commit = stdout.trim();
if (process.env.GITHUB_SHA !== commit) {
  throw new TypeError("The GitHub release ref does not match the checked-out commit.");
}

async function resolveCommit(ref) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

if ((await resolveCommit(`refs/tags/${expectedTag}`)) !== commit) {
  throw new TypeError("The actual release tag does not target the checked-out commit.");
}
if (
  (await resolveCommit("refs/remotes/origin/main")) !== commit ||
  (await resolveCommit("FETCH_HEAD")) !== commit
) {
  throw new TypeError("The release checkout is not the freshly fetched product main.");
}
const { stdout: status } = await execFileAsync(
  "git",
  ["status", "--porcelain", "--untracked-files=normal"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
  },
);
if (status.trim() !== "") {
  throw new TypeError("Staging requires a clean release checkout.");
}

process.stdout.write(
  `${JSON.stringify({
    commit,
    package: manifest.name,
    tag: expectedTag,
    version: manifest.version,
  })}\n`,
);
