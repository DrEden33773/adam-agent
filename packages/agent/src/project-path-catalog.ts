import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type ProjectPathCatalog = {
  readonly items: readonly string[];
  readonly omittedCount: number;
  readonly diagnostic: { readonly code: "project_path_catalog_truncated" } | null;
};

const maximumDirectories = 1_000;
const maximumDirectoryEntries = 20_000;
const maximumFiles = 4_096;
const maximumPathBytes = 4_096;

export async function listProjectPaths(workspaceRoot: string): Promise<ProjectPathCatalog> {
  const canonicalRoot = await realpath(workspaceRoot);
  const pending = [canonicalRoot];
  const paths: string[] = [];
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let omittedCount = 0;
  let truncated = false;

  while (pending.length > 0 && !truncated) {
    const directory = pending.shift();
    if (directory === undefined) {
      break;
    }
    visitedDirectories += 1;
    if (visitedDirectories > maximumDirectories) {
      truncated = true;
      break;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maximumDirectoryEntries) {
        truncated = true;
        break;
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory() && !excludedDirectory(entry.name)) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        const projectPath = relative(canonicalRoot, absolutePath).split(sep).join("/");
        if (projectPath.length > 0 && Buffer.byteLength(projectPath, "utf8") <= maximumPathBytes) {
          if (paths.length < maximumFiles) {
            paths.push(projectPath);
          } else {
            omittedCount += 1;
            truncated = true;
          }
        } else {
          omittedCount += 1;
        }
      }
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  return {
    items: paths,
    omittedCount,
    diagnostic: truncated ? { code: "project_path_catalog_truncated" } : null,
  };
}

function excludedDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules";
}
