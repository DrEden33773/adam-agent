import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspaces = [
  "apps/cli",
  "apps/tui",
  "packages/agent",
  "packages/presentation",
  "packages/extension-api",
  "packages/testkit",
];

export async function packageLocal(output) {
  if (!output) throw new Error("Usage: pnpm package:local <new output directory>");
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Local packaging requires Linux and Node.js 24.");
  }
  const destination = resolve(output);
  await mkdir(destination); // Never replace an existing output or installation.
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).length > 0;
  const version = `0.0.0-${revision.slice(0, 12)}${dirty ? "-worktree" : ""}`;
  const name = `adam-${version}-linux-${process.arch}`;
  const bundle = join(destination, name);
  await mkdir(bundle);

  const packages = new Map();
  const inventory = [];
  async function locatePackage(from, name) {
    let directory = from;
    while (true) {
      const candidate = join(directory, "node_modules", name);
      try {
        await readFile(join(candidate, "package.json"));
        return await realpath(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  async function copyPackage(source) {
    const canonical = await realpath(source);
    if (packages.has(canonical)) return packages.get(canonical);
    const manifest = JSON.parse(await readFile(join(canonical, "package.json"), "utf8"));
    const target = join(bundle, "packages", String(packages.size), "node_modules", manifest.name);
    packages.set(canonical, target);
    await mkdir(dirname(target), { recursive: true });
    const workspace = workspaces.some((path) => join(root, path) === canonical);
    if (workspace) {
      await mkdir(target);
      await cp(join(canonical, "package.json"), join(target, "package.json"));
      await cp(join(canonical, "dist"), join(target, "dist"), {
        recursive: true,
        filter: (path) =>
          !/(?:^|[.-])(?:test|fixture)(?:[.-]|$)/.test(basename(path)) && !path.endsWith(".map"),
      });
      await cp(join(root, "LICENSE"), join(target, "LICENSE"));
    } else {
      await cp(canonical, target, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) =>
          path === canonical || relative(canonical, path).split("/")[0] !== "node_modules",
      });
    }
    inventory.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "See included license files",
      path: relative(bundle, target),
    });
    const required = { ...manifest.dependencies };
    const optional = { ...manifest.optionalDependencies };
    for (const [name, value] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) optional[name] = value;
      else required[name] = value;
    }
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      const dependency = await locatePackage(canonical, name);
      if (!dependency) {
        if (name in optional) continue;
        throw new Error(`Missing installed production dependency ${manifest.name} -> ${name}`);
      }
      const dependencyTarget = await copyPackage(dependency);
      const link = join(target, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), dependencyTarget), link);
    }
    return target;
  }

  for (const app of ["cli", "tui"]) {
    const target = await copyPackage(join(root, "apps", app));
    const link = join(bundle, "node_modules", "@adam-agent", app);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), target), link);
  }
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "pnpm-lock.yaml"])
    await cp(join(root, file), join(bundle, file));
  await cp(join(root, "patches"), join(bundle, "patches"), { recursive: true });
  await cp(join(root, "scripts", "local-install.mjs"), join(bundle, "install.mjs"));
  for (const [launcher, app] of [
    ["adam", "tui"],
    ["adam-cli", "cli"],
  ]) {
    await writeFile(
      join(bundle, `${launcher}.mjs`),
      `#!/usr/bin/env node\nif (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Adam requires Linux and Node.js 24.");\nawait import("./node_modules/@adam-agent/${app}/dist/main.js");\n`,
      { mode: 0o755 },
    );
  }
  await writeFile(
    join(bundle, "local-package.json"),
    `${JSON.stringify({ format: "adam.local-package.v1", version, revision, dirty, platform: process.platform, arch: process.arch, node: process.versions.node, packages: inventory }, null, 2)}\n`,
  );

  async function checkLinks(directory) {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const target = relative(bundle, await realpath(path));
        if (target === ".." || target.startsWith("../") || isAbsolute(target))
          throw new Error(`External package link: ${path}`);
      } else if (stat.isDirectory()) await checkLinks(path);
    }
  }
  await checkLinks(bundle);
  execFileSync("tar", ["-czf", join(destination, `${name}.tar.gz`), "-C", destination, name], {
    stdio: "inherit",
  });
  console.log(
    `Local package: ${join(destination, `${name}.tar.gz`)}\n${inventory.length} production packages; ${dirty ? "working tree" : revision}`,
  );

  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: pnpm package:local <new output directory>");
  for (const workspace of workspaces)
    await rm(join(root, workspace, "dist"), { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-b", "--force"], {
    cwd: root,
    stdio: "inherit",
  });

  await packageLocal(process.argv[2]);
}
