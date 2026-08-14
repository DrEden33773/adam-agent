import { constants } from "node:fs";
import { type FileHandle, mkdir, open, opendir, realpath } from "node:fs/promises";
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
          | "already_exists"
          | "ambiguous_match"
          | "binary_file"
          | "file_too_large"
          | "no_match"
          | "overlapping_edits"
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
  readonly permissionSubject: PermissionSubject;
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

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionSubject =
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "workspace_path"; readonly path: string };

export type PermissionPolicyInput = {
  readonly callId: string;
  readonly name: string;
  readonly effect: ToolEffect;
  readonly scope: "call";
  readonly subject: PermissionSubject;
};

export type PermissionPolicy = {
  decide(input: PermissionPolicyInput): PermissionDecision;
};

export function createPermissionPolicy(options: {
  readonly allowedEffects: readonly ToolEffect[];
  readonly askedEffects?: readonly ToolEffect[];
}): PermissionPolicy {
  const allowedEffects = new Set(options.allowedEffects);
  const askedEffects = new Set(options.askedEffects ?? []);
  return {
    decide(input) {
      if (allowedEffects.has(input.effect)) {
        return "allow";
      }
      return askedEffects.has(input.effect) ? "ask" : "deny";
    },
  };
}

const readFileInputSchema = z.strictObject({ path: z.string().min(1) });
const listFilesInputSchema = z.strictObject({ path: z.string().min(1) });
const maximumMutationFileBytes = 1024 * 1024;
const maximumEditArgumentsBytes = 1024 * 1024;
const textMutationContentSchema = z
  .string()
  .refine((content) => !content.includes("\0"))
  .refine((content) => Buffer.byteLength(content, "utf8") <= maximumMutationFileBytes);
const writeFileInputSchema = z.strictObject({
  path: z.string().min(1),
  content: textMutationContentSchema,
});
const editFileInputSchema = z
  .strictObject({
    path: z.string().min(1),
    edits: z
      .array(
        z.strictObject({
          oldText: textMutationContentSchema.refine((text) => text.length > 0),
          newText: textMutationContentSchema,
        }),
      )
      .min(1),
  })
  .refine(
    (input) =>
      input.edits.reduce(
        (total, edit) =>
          total + Buffer.byteLength(edit.oldText, "utf8") + Buffer.byteLength(edit.newText, "utf8"),
        0,
      ) <= maximumEditArgumentsBytes,
  );
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
const writeFileOutputSchema = z.strictObject({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
});
const editFileOutputSchema = z.strictObject({
  path: z.string(),
  replacements: z.number().int().positive(),
  bytesWritten: z.number().int().nonnegative(),
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
      const permissionSubject = preparePermissionSubject(
        workspaceRoot,
        parsedArguments.data.path,
        "file",
      );
      if ("status" in permissionSubject) {
        return permissionSubject;
      }
      return {
        status: "ready",
        permissionSubject,
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
      const permissionSubject = preparePermissionSubject(
        workspaceRoot,
        parsedArguments.data.path,
        "workspace_path",
      );
      if ("status" in permissionSubject) {
        return permissionSubject;
      }
      return {
        status: "ready",
        permissionSubject,
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
      const permissionSubject = preparePermissionSubject(
        workspaceRoot,
        parsedArguments.data.path,
        "workspace_path",
      );
      if ("status" in permissionSubject) {
        return permissionSubject;
      }
      return {
        status: "ready",
        permissionSubject,
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

export function createMutationToolRegistry(options: {
  readonly workspaceRoot: string;
}): ToolRegistry {
  const workspaceRoot = resolve(options.workspaceRoot);
  const writeFileAdapter: ToolAdapter = {
    definition: {
      name: "write_file",
      description: "Create a UTF-8 text file inside the workspace, including missing parents.",
      inputSchema: z.toJSONSchema(writeFileInputSchema),
    },
    outputSchema: writeFileOutputSchema,
    effect: "write",
    cancellation: "unsupported",
    maximumResult: {},
    prepare(argumentsJson) {
      const parsedArguments = parseInput(writeFileInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      const permissionSubject = preparePermissionSubject(
        workspaceRoot,
        parsedArguments.data.path,
        "file",
      );
      if ("status" in permissionSubject) {
        return permissionSubject;
      }
      return {
        status: "ready",
        permissionSubject,
        async execute() {
          return executeSafely(writeFileOutputSchema, async () => {
            const target = await openConfinedMutationTarget(
              workspaceRoot,
              parsedArguments.data.path,
              true,
            );
            try {
              await rejectEscapingExistingTarget(target);
              const file = await open(
                target.path,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o666,
              );
              try {
                await file.writeFile(parsedArguments.data.content, "utf8");
              } finally {
                await file.close();
              }
            } finally {
              await target.parent.close();
            }
            return {
              path: parsedArguments.data.path,
              bytesWritten: Buffer.byteLength(parsedArguments.data.content, "utf8"),
            };
          });
        },
      };
    },
  };
  const editFileAdapter: ToolAdapter = {
    definition: {
      name: "edit_file",
      description: "Apply exact text replacements to one existing workspace file.",
      inputSchema: z.toJSONSchema(editFileInputSchema),
    },
    outputSchema: editFileOutputSchema,
    effect: "write",
    cancellation: "unsupported",
    maximumResult: {},
    prepare(argumentsJson) {
      const parsedArguments = parseInput(editFileInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      const permissionSubject = preparePermissionSubject(
        workspaceRoot,
        parsedArguments.data.path,
        "file",
      );
      if ("status" in permissionSubject) {
        return permissionSubject;
      }
      return {
        status: "ready",
        permissionSubject,
        async execute() {
          return executeSafely(editFileOutputSchema, async () => {
            const target = await openConfinedMutationTarget(
              workspaceRoot,
              parsedArguments.data.path,
              false,
            );
            try {
              const file = await open(target.path, constants.O_RDWR);
              try {
                await assertOpenedHandleIsConfined(target.canonicalRoot, file);
                const originalBytes = await readBytesFromHandleBounded(
                  file,
                  maximumMutationFileBytes + 1,
                );
                if (originalBytes.byteLength > maximumMutationFileBytes) {
                  throw new ToolExecutionError(
                    "file_too_large",
                    "The requested file exceeds the one MiB edit limit.",
                  );
                }
                if (originalBytes.includes(0)) {
                  throw new ToolExecutionError(
                    "binary_file",
                    "The requested file is not supported UTF-8 text.",
                  );
                }
                let originalContent: string;
                try {
                  originalContent = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
                  if (
                    originalBytes[0] === 0xef &&
                    originalBytes[1] === 0xbb &&
                    originalBytes[2] === 0xbf
                  ) {
                    originalContent = `\uFEFF${originalContent}`;
                  }
                } catch {
                  throw new ToolExecutionError(
                    "binary_file",
                    "The requested file is not supported UTF-8 text.",
                  );
                }
                const lineEnding = detectLineEnding(originalContent);
                const replacements = parsedArguments.data.edits.map((edit) => {
                  const firstMatch = originalContent.indexOf(edit.oldText);
                  if (firstMatch === -1) {
                    throw new ToolExecutionError(
                      "no_match",
                      "The edit text was not found in the file.",
                    );
                  }
                  if (originalContent.indexOf(edit.oldText, firstMatch + 1) !== -1) {
                    throw new ToolExecutionError(
                      "ambiguous_match",
                      "The edit text matched more than one location.",
                    );
                  }
                  return {
                    start: firstMatch,
                    end: firstMatch + edit.oldText.length,
                    newText:
                      lineEnding === undefined
                        ? edit.newText
                        : edit.newText.replace(/\r\n|\r|\n/gu, lineEnding),
                  };
                });
                replacements.sort((left, right) => left.start - right.start);
                for (let index = 1; index < replacements.length; index += 1) {
                  const prior = replacements[index - 1];
                  const current = replacements[index];
                  if (prior !== undefined && current !== undefined && current.start < prior.end) {
                    throw new ToolExecutionError(
                      "overlapping_edits",
                      "The requested edits overlap in the original file.",
                    );
                  }
                }
                let updatedContent = "";
                let originalOffset = 0;
                for (const replacement of replacements) {
                  updatedContent += originalContent.slice(originalOffset, replacement.start);
                  updatedContent += replacement.newText;
                  originalOffset = replacement.end;
                }
                updatedContent += originalContent.slice(originalOffset);
                if (Buffer.byteLength(updatedContent, "utf8") > maximumMutationFileBytes) {
                  throw new ToolExecutionError(
                    "file_too_large",
                    "The updated file exceeds the one MiB edit limit.",
                  );
                }
                const updatedBytes = Buffer.from(updatedContent, "utf8");
                await file.truncate(0);
                await writeBytesFully(file, updatedBytes);
                return {
                  path: parsedArguments.data.path,
                  replacements: parsedArguments.data.edits.length,
                  bytesWritten: updatedBytes.byteLength,
                };
              } finally {
                await file.close();
              }
            } finally {
              await target.parent.close();
            }
          });
        },
      };
    },
  };
  const adapters = new Map(
    [writeFileAdapter, editFileAdapter].map((adapter) => [adapter.definition.name, adapter]),
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

async function readBytesFromHandleBounded(file: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes);
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      totalBytesRead,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }
  return buffer.subarray(0, totalBytesRead);
}

async function writeBytesFully(file: FileHandle, content: Buffer): Promise<void> {
  let totalBytesWritten = 0;
  while (totalBytesWritten < content.byteLength) {
    const { bytesWritten } = await file.write(
      content,
      totalBytesWritten,
      content.byteLength - totalBytesWritten,
      totalBytesWritten,
    );
    if (bytesWritten === 0) {
      throw new Error("The filesystem made no progress while writing.");
    }
    totalBytesWritten += bytesWritten;
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
    if (isNodeError(error) && error.code === "EEXIST") {
      return {
        status: "failed",
        error: { code: "already_exists", message: "The requested file already exists." },
      };
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        status: "failed",
        error: { code: "not_found", message: "The requested path does not exist." },
      };
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

function detectLineEnding(content: string): "\n" | "\r" | "\r\n" | undefined {
  const firstCarriageReturn = content.indexOf("\r");
  const firstLineFeed = content.indexOf("\n");
  if (firstCarriageReturn === -1 && firstLineFeed === -1) {
    return undefined;
  }
  if (firstCarriageReturn !== -1 && (firstLineFeed === -1 || firstCarriageReturn < firstLineFeed)) {
    return content[firstCarriageReturn + 1] === "\n" ? "\r\n" : "\r";
  }
  return "\n";
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

function preparePermissionSubject(
  workspaceRoot: string,
  requestedPath: string,
  type: PermissionSubject["type"],
): PermissionSubject | FailedToolResult {
  try {
    const lexicalPath = resolveLexicallyConfinedPath(workspaceRoot, requestedPath);
    return {
      type,
      path: relative(workspaceRoot, lexicalPath).split(sep).join("/"),
    };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return { status: "failed", error: { code: error.code, message: error.message } };
    }
    throw error;
  }
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

type ConfinedMutationTarget = {
  readonly canonicalRoot: string;
  readonly parent: FileHandle;
  readonly path: string;
};

async function openConfinedMutationTarget(
  workspaceRoot: string,
  requestedPath: string,
  createParents: boolean,
): Promise<ConfinedMutationTarget> {
  const lexicalPath = resolveLexicallyConfinedPath(workspaceRoot, requestedPath);
  const canonicalRoot = await realpath(workspaceRoot);
  const relativePath = relative(workspaceRoot, lexicalPath);
  const segments = relativePath === "" ? ["."] : relativePath.split(sep);
  const targetName = segments.pop() ?? ".";
  let currentDirectory = await open(
    canonicalRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const segment of segments) {
      const childPath = pathFromDirectoryHandle(currentDirectory, segment);
      if (createParents) {
        try {
          await mkdir(childPath);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") {
            throw error;
          }
        }
      }
      const childDirectory = await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await assertOpenedHandleIsConfined(canonicalRoot, childDirectory);
      } catch (error) {
        await childDirectory.close();
        throw error;
      }
      await currentDirectory.close();
      currentDirectory = childDirectory;
    }
    return {
      canonicalRoot,
      parent: currentDirectory,
      path: pathFromDirectoryHandle(currentDirectory, targetName),
    };
  } catch (error) {
    await currentDirectory.close();
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      throw new ToolExecutionError(
        "outside_workspace",
        "The requested path resolves through an unsupported symbolic link.",
      );
    }
    throw error;
  }
}

function pathFromDirectoryHandle(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function rejectEscapingExistingTarget(target: ConfinedMutationTarget): Promise<void> {
  try {
    const canonicalTarget = await realpath(target.path);
    if (isOutside(target.canonicalRoot, canonicalTarget)) {
      throw new ToolExecutionError(
        "outside_workspace",
        "The requested path resolves outside the workspace root.",
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function assertOpenedHandleIsConfined(
  canonicalRoot: string,
  file: FileHandle,
): Promise<void> {
  const canonicalTarget = await realpath(`/proc/self/fd/${file.fd}`);
  if (isOutside(canonicalRoot, canonicalTarget)) {
    throw new ToolExecutionError(
      "outside_workspace",
      "The requested path resolves outside the workspace root.",
    );
  }
}

function resolveLexicallyConfinedPath(workspaceRoot: string, requestedPath: string): string {
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
  return lexicalPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isOutside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}
