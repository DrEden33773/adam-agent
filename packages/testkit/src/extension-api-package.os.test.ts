import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const PACK_PROCESS_TIMEOUT_MS = 20_000;

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
      timeout: PACK_PROCESS_TIMEOUT_MS,
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
      { env: environment, timeout: PACK_PROCESS_TIMEOUT_MS },
    );
    expect(await listRelativeFiles(installedPackage)).toEqual([
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/managed-review.d.ts",
      "dist/managed-review.js",
      "package.json",
    ]);
    for (const dependency of ["semver", "zod"]) {
      await symlink(
        await realpath(join(packageRoot, "node_modules", dependency)),
        join(installRoot, "node_modules", dependency),
        "dir",
      );
    }
    await writeFile(
      join(installRoot, "consumer.mjs"),
      `import * as api from "@adam-agent/extension-api";
process.stdout.write(JSON.stringify({ keys: Object.keys(api).sort(), version: api.EXTENSION_API_VERSION, decoded: api.extensionManagedReviewTerminalCodec.decode({ status: "failed", error: { code: "review_deadline_exceeded", message: "Incomplete review." } }).ok }));\n`,
    );
    const consumed = await execFileAsync(process.execPath, [join(installRoot, "consumer.mjs")], {
      cwd: installRoot,
      encoding: "utf8",
      env: environment,
      timeout: PACK_PROCESS_TIMEOUT_MS,
    });
    const imported = JSON.parse(consumed.stdout) as {
      keys: string[];
      version: string;
      decoded: boolean;
    };
    expect(imported.keys).toEqual([
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
      "EXTENSION_MANAGED_REVIEW_CAPABILITY_ID",
      "EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_BYTES",
      "EXTENSION_MANAGED_REVIEW_MAX_EVIDENCE_COUNT",
      "EXTENSION_MANAGED_REVIEW_MAX_INSTRUCTION_BYTES",
      "EXTENSION_MANAGED_REVIEW_MAX_OUTPUT_BYTES",
      "EXTENSION_MANAGED_REVIEW_TOTAL_DEFAULT_MS",
      "EXTENSION_MANAGED_REVIEW_TOTAL_MAX_MS",
      "EXTENSION_MANAGED_SESSION_CAPABILITY_ID",
      "EXTENSION_MANAGED_SESSION_V2_CAPABILITY_ID",
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
      "EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES",
      "EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES",
      "EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE",
      "EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES",
      "EXTENSION_PROJECT_CHANGE_PATH_MAX_BYTES",
      "EXTENSION_PROJECT_CHANGE_SNAPSHOT_CONTRACT",
      "EXTENSION_PROJECT_CHANGE_SNAPSHOT_MAX_BYTES",
      "EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES",
      "EXTENSION_RECORDS_CAPABILITY_ID",
      "EXTENSION_RECORD_MAX_AGGREGATE_BYTES",
      "EXTENSION_RECORD_MAX_BYTES",
      "EXTENSION_RECORD_MAX_CREATES",
      "EXTENSION_RECORD_NAMESPACE_MAX_BYTES",
      "extensionManagedReviewProgressCodec",
      "extensionManagedReviewRequestCodec",
      "extensionManagedReviewTerminalCodec",
      "extensionProjectChangeSnapshotCodec",
      "parseExtensionPackageManifest",
    ]);
    expect(imported.version).toBe("0.6.0");
    expect(imported.decoded).toBe(true);
    await writeFile(
      join(installRoot, "consumer.mts"),
      `import type { ExtensionManagedReviewRequest, ExtensionOperationEvidenceReference, ExtensionManagedReviewCapability } from "@adam-agent/extension-api";
declare const evidence: readonly ExtensionOperationEvidenceReference[];
declare const capability: ExtensionManagedReviewCapability;
const request: ExtensionManagedReviewRequest = { evidence, instruction: "Review.", outputContract: { id: "consumer.result", version: 1 } };
const result = await capability.review(request);
if (result.status === "completed") result.receipt.reviewRunId satisfies string;\n`,
    );
    await writeFile(
      join(installRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2024",
          strict: true,
          types: [],
          noEmit: true,
        },
        files: ["consumer.mts"],
      }),
    );
    try {
      await execFileAsync(
        fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url)),
        ["-p", join(installRoot, "tsconfig.json")],
        { cwd: installRoot, env: environment, encoding: "utf8", timeout: PACK_PROCESS_TIMEOUT_MS },
      );
    } catch (error) {
      throw new Error(
        error instanceof Error && "stdout" in error
          ? String(error.stdout)
          : "Isolated consumer compilation failed.",
        { cause: error },
      );
    }
    const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      engines: { node: ">=24.0.0 <25" },
      license: "Apache-2.0",
      name: "@adam-agent/extension-api",
      repository: {
        directory: "packages/extension-api",
        type: "git",
        url: "git+https://github.com/DrEden33773/adam-agent.git",
      },
      version: "0.6.0",
    });
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
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
