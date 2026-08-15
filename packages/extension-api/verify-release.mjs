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

process.stdout.write(
  `${JSON.stringify({
    commit,
    package: manifest.name,
    tag: expectedTag,
    version: manifest.version,
  })}\n`,
);
