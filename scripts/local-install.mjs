import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [action, prefixArgument, requestedVersion] = process.argv.slice(2);
if (!["install", "use", "uninstall"].includes(action) || !prefixArgument) {
  throw new Error(
    "Usage: node install.mjs install <prefix> | use <prefix> <version> | uninstall <prefix> <version>",
  );
}
const source = dirname(fileURLToPath(import.meta.url));
const prefix = resolve(prefixArgument);
const home = join(prefix, "lib", "adam-agent");
const bins = join(prefix, "bin");
const marker = "# Adam local installation launcher v1\n";
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
async function metadata(directory) {
  const value = JSON.parse(await readFile(join(directory, "local-package.json"), "utf8"));
  if (
    value.format !== "adam.local-package.v1" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.version)
  )
    throw new Error("Not an Adam local application package.");
  return value;
}
const release = action === "install" ? await metadata(source) : undefined;
const version = release?.version ?? requestedVersion;
if (!version || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version))
  throw new Error("An exact installed version is required.");
const target = join(home, version);
const current = join(home, "current");
async function currentVersion() {
  try {
    return await readlink(current);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
// Check every shared entry before copying, switching or removing application files.
for (const name of ["adam", "adam-cli"]) {
  try {
    const path = join(bins, name);
    if (
      !(await lstat(path)).isFile() ||
      !(await readFile(path, "utf8")).startsWith(`#!/bin/sh\n${marker}`)
    )
      throw new Error(`Refusing to replace unrelated launcher: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await currentVersion();
if (action === "install") {
  if (
    release.platform !== platform() ||
    release.arch !== arch() ||
    Number(process.versions.node.split(".")[0]) !== 24
  )
    throw new Error(
      "This package requires its build platform/architecture and Node.js 24 (with compatible libc).",
    );
  await mkdir(home, { recursive: true });
  await mkdir(target); // Existing versions are never overwritten.
  try {
    await cp(source, target, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
} else {
  const installed = await metadata(target);
  if (
    installed.version !== version ||
    (await realpath(target)) !== join(await realpath(home), version)
  )
    throw new Error("Installed application identity does not match.");
}
if (action === "uninstall") {
  if ((await currentVersion()) === version) {
    await rm(current);
    for (const name of ["adam", "adam-cli"]) await rm(join(bins, name), { force: true });
  }
  await rm(target, { recursive: true });
  console.log(`Removed application ${version}.`);
} else {
  await mkdir(bins, { recursive: true });
  const temporary = join(home, `.current-${process.pid}`);
  await symlink(version, temporary);
  await rename(temporary, current);
  for (const name of ["adam", "adam-cli"]) {
    await writeFile(
      join(bins, name),
      `#!/bin/sh\n${marker}exec node ${quote(join(current, `${name}.mjs`))} "$@"\n`,
      { mode: 0o755 },
    );
  }
  console.log(`Active application ${version}. Add ${bins} to PATH.`);
}
