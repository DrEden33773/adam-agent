import { open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

export type ToolEffect = "read" | "write" | "execute" | "network" | "delegate" | "administrative";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

export type ToolResult =
  | { readonly status: "completed"; readonly output: JsonValue }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code:
          | "unknown_tool"
          | "invalid_tool_input"
          | "permission_denied"
          | "outside_workspace"
          | "not_found"
          | "tool_io_failed";
        readonly message: string;
      };
    };

type ToolAdapter = {
  readonly definition: ModelToolDefinition;
  readonly outputSchema: z.ZodType<JsonValue>;
  readonly effect: ToolEffect;
  readonly cancellation: "unsupported";
  readonly maximumResult: ToolMaximumResultPolicy;
  prepare(argumentsJson: string): PreparedToolCall | FailedToolResult;
};

type ToolMaximumResultPolicy = {
  readonly maximumBytes?: number;
  readonly maximumEntries?: number;
  readonly maximumFiles?: number;
  readonly maximumFileBytes?: number;
  readonly maximumMatches?: number;
  readonly maximumMatchCharacters?: number;
  readonly maximumQueryCharacters?: number;
};

type FailedToolResult = Extract<ToolResult, { readonly status: "failed" }>;

type PreparedToolCall = {
  readonly status: "ready";
  execute(): Promise<ToolResult>;
};

class ToolExecutionError extends Error {
  readonly code: FailedToolResult["error"]["code"];

  constructor(code: FailedToolResult["error"]["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type ToolRegistry = {
  definitions(): readonly ModelToolDefinition[];
  resolve(name: string): ToolAdapter | undefined;
};

export type PermissionDecision = "allow" | "deny";

export type PermissionPolicy = {
  decide(effect: ToolEffect): PermissionDecision;
};

export function createPermissionPolicy(options: {
  readonly allowedEffects: readonly ToolEffect[];
}): PermissionPolicy {
  const allowedEffects = new Set(options.allowedEffects);
  return {
    decide(effect) {
      return allowedEffects.has(effect) ? "allow" : "deny";
    },
  };
}

const readFileInputSchema = z.strictObject({ path: z.string().min(1) });
const listFilesInputSchema = z.strictObject({ path: z.string().min(1) });
const readFileMaximumResult = { maximumBytes: 64 * 1024 } as const;
const listFilesMaximumResult = { maximumEntries: 200 } as const;
const searchTextMaximumResult = {
  maximumEntries: 1_000,
  maximumFiles: 200,
  maximumFileBytes: 64 * 1024,
  maximumMatches: 200,
  maximumMatchCharacters: 1_024,
  maximumQueryCharacters: 1_024,
} as const;
const searchTextInputSchema = z.strictObject({
  path: z.string().min(1),
  query: z.string().min(1).max(searchTextMaximumResult.maximumQueryCharacters),
});

type ListedEntry = {
  readonly path: string;
  readonly type: "file" | "directory";
};

type SearchMatch = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
};

const readFileOutputSchema = z.strictObject({
  path: z.string(),
  content: z.string().max(readFileMaximumResult.maximumBytes),
  truncated: z.boolean(),
});
const listedEntrySchema = z.strictObject({
  path: z.string(),
  type: z.enum(["file", "directory"]),
});
const listFilesOutputSchema = z.strictObject({
  path: z.string(),
  entries: z.array(listedEntrySchema).max(listFilesMaximumResult.maximumEntries),
  truncated: z.boolean(),
});
const searchMatchSchema = z.strictObject({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string().max(searchTextMaximumResult.maximumMatchCharacters),
});
const searchTextOutputSchema = z.strictObject({
  path: z.string(),
  query: z.string().max(searchTextMaximumResult.maximumQueryCharacters),
  matches: z.array(searchMatchSchema).max(searchTextMaximumResult.maximumMatches),
  truncated: z.boolean(),
});

export function createReadToolRegistry(options: { readonly workspaceRoot: string }): ToolRegistry {
  const workspaceRoot = resolve(options.workspaceRoot);
  const readFileAdapter: ToolAdapter = {
    definition: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      inputSchema: z.toJSONSchema(readFileInputSchema),
    },
    outputSchema: readFileOutputSchema,
    effect: "read",
    cancellation: "unsupported",
    maximumResult: readFileMaximumResult,
    prepare(argumentsJson) {
      const parsedArguments = parseInput(readFileInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      return {
        status: "ready",
        async execute() {
          return executeSafely(readFileOutputSchema, async () => {
            const targetPath = await resolveConfinedPath(workspaceRoot, parsedArguments.data.path);
            const { content, truncated } = await readTextFileBounded(
              targetPath,
              readFileMaximumResult.maximumBytes,
            );
            return { path: parsedArguments.data.path, content, truncated };
          });
        },
      };
    },
  };
  const listFilesAdapter: ToolAdapter = {
    definition: {
      name: "list_files",
      description: "List files and directories recursively inside the workspace.",
      inputSchema: z.toJSONSchema(listFilesInputSchema),
    },
    outputSchema: listFilesOutputSchema,
    effect: "read",
    cancellation: "unsupported",
    maximumResult: listFilesMaximumResult,
    prepare(argumentsJson) {
      const parsedArguments = parseInput(listFilesInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      return {
        status: "ready",
        async execute() {
          return executeSafely(listFilesOutputSchema, async () => {
            const targetPath = await resolveConfinedPath(workspaceRoot, parsedArguments.data.path);
            const listing = await collectEntries(
              workspaceRoot,
              targetPath,
              listFilesMaximumResult.maximumEntries,
            );
            return {
              path: parsedArguments.data.path,
              entries: listing.entries,
              truncated: listing.truncated,
            };
          });
        },
      };
    },
  };
  const searchTextAdapter: ToolAdapter = {
    definition: {
      name: "search_text",
      description: "Search for literal text recursively inside workspace files.",
      inputSchema: z.toJSONSchema(searchTextInputSchema),
    },
    outputSchema: searchTextOutputSchema,
    effect: "read",
    cancellation: "unsupported",
    maximumResult: searchTextMaximumResult,
    prepare(argumentsJson) {
      const parsedArguments = parseInput(searchTextInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      return {
        status: "ready",
        async execute() {
          return executeSafely(searchTextOutputSchema, async () => {
            const targetPath = await resolveConfinedPath(workspaceRoot, parsedArguments.data.path);
            const listing = await collectEntries(
              workspaceRoot,
              targetPath,
              searchTextMaximumResult.maximumEntries,
            );
            const matches: SearchMatch[] = [];
            let searchedFiles = 0;
            let truncated = listing.truncated;
            for (const entry of listing.entries) {
              if (entry.type !== "file") {
                continue;
              }
              if (searchedFiles >= searchTextMaximumResult.maximumFiles) {
                truncated = true;
                break;
              }
              searchedFiles += 1;
              const file = await readTextFileBounded(
                resolve(workspaceRoot, entry.path),
                searchTextMaximumResult.maximumFileBytes,
              );
              const { content } = file;
              truncated ||= file.truncated;
              if (content.includes("\0")) {
                continue;
              }
              const matchTextWasTruncated = collectTextMatches(
                entry.path,
                content,
                parsedArguments.data.query,
                matches,
                searchTextMaximumResult.maximumMatches + 1,
                searchTextMaximumResult.maximumMatchCharacters,
              );
              truncated ||= matchTextWasTruncated;
              if (matches.length > searchTextMaximumResult.maximumMatches) {
                truncated = true;
                break;
              }
            }
            return {
              path: parsedArguments.data.path,
              query: parsedArguments.data.query,
              matches: matches.slice(0, searchTextMaximumResult.maximumMatches),
              truncated,
            };
          });
        },
      };
    },
  };
  const adapters = new Map(
    [readFileAdapter, listFilesAdapter, searchTextAdapter].map((adapter) => [
      adapter.definition.name,
      adapter,
    ]),
  );

  return {
    definitions() {
      return [...adapters.values()].map((adapter) => adapter.definition);
    },
    resolve(name) {
      return adapters.get(name);
    },
  };
}

async function readTextFileBounded(
  path: string,
  maximumBytes: number,
): Promise<{ readonly content: string; readonly truncated: boolean }> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, maximumBytes)).toString("utf8"),
      truncated: bytesRead > maximumBytes,
    };
  } finally {
    await file.close();
  }
}

async function executeSafely(
  outputSchema: z.ZodType<JsonValue>,
  operation: () => Promise<JsonValue>,
): Promise<ToolResult> {
  try {
    const output = outputSchema.safeParse(await operation());
    if (!output.success) {
      return {
        status: "failed",
        error: { code: "tool_io_failed", message: "The tool produced an invalid result." },
      };
    }
    return { status: "completed", output: output.data };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return { status: "failed", error: { code: error.code, message: error.message } };
    }
    return {
      status: "failed",
      error: { code: "tool_io_failed", message: "The filesystem operation failed." },
    };
  }
}

async function collectEntries(
  workspaceRoot: string,
  directoryPath: string,
  maximumEntries: number,
): Promise<{ readonly entries: readonly ListedEntry[]; readonly truncated: boolean }> {
  const entries: ListedEntry[] = [];
  const visit = async (currentDirectory: string): Promise<boolean> => {
    const remaining = maximumEntries - entries.length;
    if (remaining <= 0) {
      return hasListableEntry(currentDirectory);
    }

    const directoryEntries = [];
    const directory = await opendir(currentDirectory);
    for await (const entry of directory) {
      if (entry.isDirectory() || entry.isFile()) {
        directoryEntries.push(entry);
      }
      if (directoryEntries.length > remaining) {
        break;
      }
    }
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    const directoryWasTruncated = directoryEntries.length > remaining;
    for (const entry of directoryEntries.slice(0, remaining)) {
      if (entries.length >= maximumEntries) {
        return true;
      }
      const entryPath = resolve(currentDirectory, entry.name);
      const relativePath = relative(workspaceRoot, entryPath).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        if (await visit(entryPath)) {
          return true;
        }
      } else {
        entries.push({ path: relativePath, type: "file" });
      }
    }

    return directoryWasTruncated;
  };

  return { entries, truncated: await visit(directoryPath) };
}

async function hasListableEntry(directoryPath: string): Promise<boolean> {
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    if (entry.isDirectory() || entry.isFile()) {
      return true;
    }
  }
  return false;
}

function collectTextMatches(
  path: string,
  content: string,
  query: string,
  matches: SearchMatch[],
  maximumMatches: number,
  maximumMatchCharacters: number,
): boolean {
  let truncated = false;
  const lines = content.split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    let searchFrom = 0;
    while (searchFrom <= line.length) {
      const matchIndex = line.indexOf(query, searchFrom);
      if (matchIndex === -1) {
        break;
      }
      truncated ||= line.length > maximumMatchCharacters;
      matches.push({
        path,
        line: lineIndex + 1,
        column: matchIndex + 1,
        text: line.slice(0, maximumMatchCharacters),
      });
      if (matches.length >= maximumMatches) {
        return truncated;
      }
      searchFrom = matchIndex + Math.max(query.length, 1);
    }
  }
  return truncated;
}

function parseInput<T>(
  schema: z.ZodType<T>,
  argumentsJson: string,
): { readonly success: true; readonly data: T } | { readonly success: false } {
  let untrustedInput: unknown;
  try {
    untrustedInput = JSON.parse(argumentsJson);
  } catch {
    return { success: false };
  }

  const result = schema.safeParse(untrustedInput);
  return result.success ? { success: true, data: result.data } : { success: false };
}

function invalidToolInput(): FailedToolResult {
  return {
    status: "failed",
    error: {
      code: "invalid_tool_input",
      message: "The tool input did not match its schema.",
    },
  };
}

async function resolveConfinedPath(workspaceRoot: string, requestedPath: string): Promise<string> {
  if (isAbsolute(requestedPath)) {
    throw new ToolExecutionError(
      "outside_workspace",
      "The requested path must be relative to the workspace root.",
    );
  }

  const lexicalPath = resolve(workspaceRoot, requestedPath);
  if (isOutside(workspaceRoot, lexicalPath)) {
    throw new ToolExecutionError(
      "outside_workspace",
      "The requested path is outside the workspace root.",
    );
  }

  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(lexicalPath),
  ]);
  if (isOutside(canonicalRoot, canonicalPath)) {
    throw new ToolExecutionError(
      "outside_workspace",
      "The requested path resolves outside the workspace root.",
    );
  }
  return canonicalPath;
}

function isOutside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}
