import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createRepositoryInstructionRevisionV1,
  type PromptContextRecordV1,
  type RepositoryInstructionDiagnostic,
  type RepositoryInstructionFailureCode,
  type RepositoryInstructionSourceRecord,
  repositoryInstructionLimitsV1,
} from "./prompt-assembly.js";

type RepositoryLoadReason = "explicit_reload" | "path_scope_activation" | "root_eager";

export class RepositoryInstructionsError extends Error {
  readonly code: RepositoryInstructionFailureCode;

  constructor(code: RepositoryInstructionFailureCode) {
    super("The selected repository instructions could not be loaded safely.");
    this.name = "RepositoryInstructionsError";
    this.code = code;
  }
}

export async function loadInitialRepositoryInstructions(input: {
  readonly includeProjectSources?: boolean;
  readonly workspaceRoot: string;
}): Promise<PromptContextRecordV1["repository"]> {
  if (input.includeProjectSources === false) {
    return createRepositoryInstructionRevisionV1({
      revision: 1,
      activeScopes: ["."],
      sources: [],
      diagnostics: [],
    });
  }
  return loadRepositoryInstructions({
    workspaceRoot: input.workspaceRoot,
    activeScopes: ["."],
    revision: 1,
    loadReason: "root_eager",
  });
}

export async function loadRepositoryInstructions(input: {
  readonly workspaceRoot: string;
  readonly activeScopes: readonly string[];
  readonly revision: number;
  readonly loadReason: RepositoryLoadReason;
}): Promise<PromptContextRecordV1["repository"]> {
  const canonicalRoot = await realpath(input.workspaceRoot);
  const activeScopes = normalizeActiveScopes(input.activeScopes);
  const sources: RepositoryInstructionSourceRecord[] = [];
  const diagnostics: RepositoryInstructionDiagnostic[] = [];
  let aggregateContentBytes = 0;
  for (const scope of activeScopes) {
    const selected = await selectInstructionName(canonicalRoot, scope);
    if (selected === undefined) {
      continue;
    }
    if (selected.masked) {
      diagnostics.push({
        code: "repository_instruction_masked",
        scope,
        path: joinScope(scope, "AGENTS.md"),
        candidate: joinScope(scope, "AGENTS.override.md"),
      });
      if (diagnostics.length > repositoryInstructionLimitsV1.maximumDiagnostics) {
        throw new RepositoryInstructionsError("repository_instruction_diagnostics_overflow");
      }
    }
    if (sources.length >= repositoryInstructionLimitsV1.maximumSources) {
      throw new RepositoryInstructionsError("repository_instruction_source_count_overflow");
    }
    const source = await loadSelectedSource({
      canonicalRoot,
      scope,
      selectedName: selected.name,
      loadReason: input.loadReason,
    });
    aggregateContentBytes += source.byteCount;
    if (aggregateContentBytes > repositoryInstructionLimitsV1.maximumAggregateContentBytes) {
      throw new RepositoryInstructionsError("repository_instruction_content_overflow");
    }
    sources.push(source);
  }
  return createRepositoryInstructionRevisionV1({
    revision: input.revision,
    activeScopes,
    sources,
    diagnostics,
  });
}

function normalizeActiveScopes(scopes: readonly string[]): readonly string[] {
  const unique = [...new Set(scopes)];
  if (!unique.includes(".")) {
    unique.push(".");
  }
  for (const scope of unique) {
    if (!isCanonicalScope(scope)) {
      throw new RepositoryInstructionsError("repository_instruction_scope_invalid");
    }
    if (
      Buffer.byteLength(scope, "utf8") > repositoryInstructionLimitsV1.maximumPathBytes ||
      Buffer.byteLength(joinScope(scope, "AGENTS.override.md"), "utf8") >
        repositoryInstructionLimitsV1.maximumPathBytes
    ) {
      throw new RepositoryInstructionsError("repository_instruction_path_too_long");
    }
  }
  unique.sort(compareScopes);
  if (unique.length > repositoryInstructionLimitsV1.maximumActiveScopes) {
    throw new RepositoryInstructionsError("repository_instruction_scope_count_overflow");
  }
  if (
    unique.reduce((total, scope) => total + Buffer.byteLength(scope, "utf8"), 0) >
    repositoryInstructionLimitsV1.maximumActiveScopePathBytes
  ) {
    throw new RepositoryInstructionsError("repository_instruction_scope_path_overflow");
  }
  return unique;
}

async function selectInstructionName(
  canonicalRoot: string,
  scope: string,
): Promise<
  { readonly name: "AGENTS.md" | "AGENTS.override.md"; readonly masked: boolean } | undefined
> {
  const directory = resolveScope(canonicalRoot, scope);
  const overrideExists = await pathExists(resolve(directory, "AGENTS.override.md"));
  const ordinaryExists = await pathExists(resolve(directory, "AGENTS.md"));
  if (overrideExists) {
    return { name: "AGENTS.override.md", masked: ordinaryExists };
  }
  return ordinaryExists ? { name: "AGENTS.md", masked: false } : undefined;
}

async function loadSelectedSource(input: {
  readonly canonicalRoot: string;
  readonly scope: string;
  readonly selectedName: "AGENTS.md" | "AGENTS.override.md";
  readonly loadReason: RepositoryLoadReason;
}): Promise<RepositoryInstructionSourceRecord> {
  const lexicalAbsolutePath = resolve(
    resolveScope(input.canonicalRoot, input.scope),
    input.selectedName,
  );
  const lexicalPath = toProjectRelativePath(input.canonicalRoot, lexicalAbsolutePath);
  if (Buffer.byteLength(lexicalPath, "utf8") > repositoryInstructionLimitsV1.maximumPathBytes) {
    throw new RepositoryInstructionsError("repository_instruction_path_too_long");
  }
  let resolvedAbsolutePath: string;
  try {
    resolvedAbsolutePath = await realpath(lexicalAbsolutePath);
  } catch {
    throw new RepositoryInstructionsError("repository_instruction_unreadable");
  }
  if (!isWithinRoot(input.canonicalRoot, resolvedAbsolutePath)) {
    throw new RepositoryInstructionsError("repository_instruction_symlink_escape");
  }
  const initiallyResolvedPath = toProjectRelativePath(input.canonicalRoot, resolvedAbsolutePath);
  if (
    Buffer.byteLength(initiallyResolvedPath, "utf8") >
    repositoryInstructionLimitsV1.maximumPathBytes
  ) {
    throw new RepositoryInstructionsError("repository_instruction_path_too_long");
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(resolvedAbsolutePath);
  } catch {
    throw new RepositoryInstructionsError("repository_instruction_unreadable");
  }
  if (!metadata.isFile()) {
    throw new RepositoryInstructionsError("repository_instruction_not_regular_file");
  }
  if (metadata.size > repositoryInstructionLimitsV1.maximumSourceBytes) {
    throw new RepositoryInstructionsError("repository_instruction_file_too_large");
  }

  let bytes: Buffer;
  let resolvedPath: string;
  try {
    const handle = await open(
      resolvedAbsolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw new RepositoryInstructionsError("repository_instruction_not_regular_file");
      }
      if (openedMetadata.size > repositoryInstructionLimitsV1.maximumSourceBytes) {
        throw new RepositoryInstructionsError("repository_instruction_file_too_large");
      }
      const openedAbsolutePath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isWithinRoot(input.canonicalRoot, openedAbsolutePath)) {
        throw new RepositoryInstructionsError("repository_instruction_symlink_escape");
      }
      resolvedPath = toProjectRelativePath(input.canonicalRoot, openedAbsolutePath);
      if (
        Buffer.byteLength(resolvedPath, "utf8") > repositoryInstructionLimitsV1.maximumPathBytes
      ) {
        throw new RepositoryInstructionsError("repository_instruction_path_too_long");
      }
      bytes = await readBounded(handle, repositoryInstructionLimitsV1.maximumSourceBytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RepositoryInstructionsError) {
      throw error;
    }
    throw new RepositoryInstructionsError("repository_instruction_unreadable");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RepositoryInstructionsError("repository_instruction_invalid_utf8");
  }
  return {
    scope: input.scope,
    lexicalPath,
    resolvedPath,
    selectedName: input.selectedName,
    byteCount: bytes.length,
    lineCount: content.length === 0 ? 0 : 1 + (content.match(/\n/gu)?.length ?? 0),
    estimatedTokens: Math.ceil(bytes.length / 4),
    contentDigest: digestBytes(bytes),
    loadReason: input.loadReason,
    content,
  };
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new RepositoryInstructionsError("repository_instruction_file_too_large");
  }
  return buffer.subarray(0, offset);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw new RepositoryInstructionsError("repository_instruction_unreadable");
  }
}

function digestBytes(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resolveScope(root: string, scope: string): string {
  const target = scope === "." ? root : resolve(root, ...scope.split("/"));
  if (!isWithinRoot(root, target)) {
    throw new RepositoryInstructionsError("repository_instruction_scope_invalid");
  }
  return target;
}

function isCanonicalScope(scope: string): boolean {
  return (
    scope === "." ||
    (!isAbsolute(scope) &&
      scope.length > 0 &&
      !scope.startsWith("./") &&
      !scope.endsWith("/") &&
      !scope
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === ".."))
  );
}

function compareScopes(left: string, right: string): number {
  const leftDepth = left === "." ? 0 : left.split("/").length;
  const rightDepth = right === "." ? 0 : right.split("/").length;
  return leftDepth - rightDepth || (left < right ? -1 : left > right ? 1 : 0);
}

function joinScope(scope: string, name: string): string {
  return scope === "." ? name : `${scope}/${name}`;
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function toProjectRelativePath(root: string, target: string): string {
  const path = relative(root, target);
  return path === "" ? "." : path.split(sep).join("/");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
