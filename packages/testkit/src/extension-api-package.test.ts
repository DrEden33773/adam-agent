import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

test("the packed extension API imports with only its public runtime shape", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-extension-api-pack-"));
  const packageRoot = fileURLToPath(new URL("../../extension-api", import.meta.url));
  const installRoot = join(testRoot, "consumer");
  const installedPackage = join(installRoot, "node_modules", "@adam-agent", "extension-api");
  const environment: NodeJS.ProcessEnv = {
    HOME: join(testRoot, "home"),
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: testRoot,
    npm_config_cache: join(testRoot, "npm-cache"),
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  for (const name of ["LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  try {
    await execFileAsync("npm", ["pack", packageRoot, "--pack-destination", testRoot], {
      encoding: "utf8",
      env: environment,
    });
    const tarballs = (await readdir(testRoot)).filter((entry) => entry.endsWith(".tgz"));
    expect(tarballs).toHaveLength(1);
    const tarball = tarballs[0];
    if (tarball === undefined) {
      throw new TypeError("npm pack did not create a tarball.");
    }

    await mkdir(installedPackage, { recursive: true });
    await execFileAsync(
      "tar",
      ["-xzf", join(testRoot, tarball), "-C", installedPackage, "--strip-components=1"],
      { env: environment },
    );
    expect(await listRelativeFiles(installedPackage)).toEqual([
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ]);
    for (const dependency of ["semver", "zod"]) {
      await symlink(
        await realpath(join(packageRoot, "node_modules", dependency)),
        join(installRoot, "node_modules", dependency),
        "dir",
      );
    }
    const imported: unknown = await import(
      `${pathToFileURL(join(installedPackage, "dist", "index.js")).href}?packed=${Date.now()}`
    );
    if (typeof imported !== "object" || imported === null) {
      throw new TypeError("The packed extension API did not import as a module.");
    }
    expect(Object.keys(imported).sort()).toEqual([
      "EXTENSION_API_VERSION",
      "EXTENSION_ARTIFACT_CAPABILITY_ID",
      "EXTENSION_ARTIFACT_MAX_AGGREGATE_BYTES",
      "EXTENSION_ARTIFACT_MAX_BYTES",
      "EXTENSION_ARTIFACT_MAX_COUNT",
      "EXTENSION_BIOME_CAPABILITY_ID",
      "EXTENSION_BIOME_MAX_FILES",
      "EXTENSION_BIOME_MAX_FILE_BYTES",
      "EXTENSION_BIOME_MAX_REPORT_BYTES",
      "EXTENSION_BIOME_MAX_SNAPSHOT_BYTES",
      "EXTENSION_BIOME_MAX_STDERR_BYTES",
      "EXTENSION_BIOME_MAX_STDOUT_BYTES",
      "EXTENSION_BIOME_PROFILE",
      "EXTENSION_ID_MAX_LENGTH",
      "EXTENSION_OPERATION_DEADLINE_DEFAULT_MS",
      "EXTENSION_OPERATION_DEADLINE_MAX_MS",
      "EXTENSION_OPERATION_INPUT_MAX_BYTES",
      "EXTENSION_OPERATION_JSON_MAX_CONTAINERS",
      "EXTENSION_OPERATION_JSON_MAX_DEPTH",
      "EXTENSION_OPERATION_OUTPUT_MAX_BYTES",
      "EXTENSION_OPERATION_PROGRESS_MAX_BYTES",
      "EXTENSION_OPERATION_PROGRESS_MAX_RECORDS",
      "EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES",
      "EXTENSION_PACKAGE_NAME_MAX_LENGTH",
      "EXTENSION_PACKAGE_VERSION_MAX_LENGTH",
      "EXTENSION_RECORDS_CAPABILITY_ID",
      "EXTENSION_RECORD_MAX_AGGREGATE_BYTES",
      "EXTENSION_RECORD_MAX_BYTES",
      "EXTENSION_RECORD_MAX_CREATES",
      "EXTENSION_RECORD_NAMESPACE_MAX_BYTES",
      "parseExtensionPackageManifest",
    ]);
    const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      engines: { node: ">=24.0.0 <25" },
      license: "Apache-2.0",
      name: "@adam-agent/extension-api",
      publishConfig: { access: "public", provenance: true, tag: "bootstrap" },
      repository: {
        directory: "packages/extension-api",
        type: "git",
        url: "git+https://github.com/DrEden33773/adam-agent.git",
      },
      version: "0.0.0-bootstrap.0",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function listRelativeFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix.length === 0 ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}
