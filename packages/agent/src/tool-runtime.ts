import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ArtifactStore } from "./artifact-store.js";

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

export type ShellRuntimeLimits = {
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly maximumInlineBytesPerStream: number;
  readonly maximumArtifactBytesPerStream: number;
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
          | "artifact_store_failed"
          | "shell_start_failed"
          | "tool_io_failed";
        readonly message: string;
      };
    };

type ToolAdapter = {
  readonly definition: ModelToolDefinition;
  readonly outputSchema: z.ZodType<JsonValue>;
  readonly effect: ToolEffect;
  readonly cancellation: "unsupported" | "abort_signal";
  readonly maximumResult: ToolMaximumResultPolicy;
  prepare(argumentsJson: string): PreparedToolCall | FailedToolResult;
};

type ToolMaximumResultPolicy = {
  readonly maximumBytes?: number;
};

type FailedToolResult = Extract<ToolResult, { readonly status: "failed" }>;

type PreparedToolCall = {
  readonly status: "ready";
  readonly permissionSubject: PermissionSubject;
  execute(context: ToolExecutionContext): Promise<ToolResult>;
};

type ToolExecutionContext = {
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
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
  | { readonly type: "workspace_path"; readonly path: string }
  | {
      readonly type: "command";
      readonly command: string;
      readonly cwd: ".";
    };

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
const defaultShellRuntimeLimits: ShellRuntimeLimits = {
  timeoutMs: 120_000,
  terminationGraceMs: 100,
  maximumInlineBytesPerStream: 64 * 1024,
  maximumArtifactBytesPerStream: 8 * 1024 * 1024,
};
const readFileMaximumResult = { maximumBytes: 64 * 1024 } as const;

const readFileOutputSchema = z.strictObject({
  path: z.string(),
  content: z.string().max(readFileMaximumResult.maximumBytes),
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
const artifactSourceSchema = z.strictObject({
  type: z.literal("tool_output"),
  callId: z.string(),
  toolName: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
const artifactReferenceSchema = z.strictObject({
  id: z.string(),
  mediaType: z.string(),
  byteCount: z.number().int().nonnegative(),
  source: artifactSourceSchema,
});
const shellStreamOutputShape = {
  tail: z.string(),
  totalBytes: z.number().int().nonnegative(),
  omittedBytes: z.number().int().nonnegative(),
} as const;
const shellStreamOutputSchema = z.union([
  z.strictObject(shellStreamOutputShape),
  z.strictObject({ ...shellStreamOutputShape, artifact: artifactReferenceSchema }),
]);
const runShellOutputSchema = z.strictObject({
  termination: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("exited"), exitCode: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal("timed_out") }),
    z.strictObject({ type: z.literal("interrupted") }),
    z.strictObject({ type: z.literal("signalled"), signal: z.string() }),
  ]),
  stdout: shellStreamOutputSchema,
  stderr: shellStreamOutputSchema,
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
  const adapters = new Map([[readFileAdapter.definition.name, readFileAdapter]]);

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

export function createCodingToolRegistry(options: {
  readonly workspaceRoot: string;
  readonly artifactStore?: ArtifactStore;
  readonly shellLimits?: ShellRuntimeLimits;
}): ToolRegistry {
  const workspaceRoot = resolve(options.workspaceRoot);
  const shellLimits = options.shellLimits ?? defaultShellRuntimeLimits;
  assertShellRuntimeLimits(shellLimits);
  const runShellInputSchema = z.strictObject({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().max(shellLimits.timeoutMs).optional(),
  });
  const readTools = createReadToolRegistry({ workspaceRoot });
  const mutationTools = createMutationToolRegistry({ workspaceRoot });
  const shellAdapter: ToolAdapter = {
    definition: {
      name: "run_shell",
      description:
        "Run one approved command from the workspace root with /bin/sh -c. The process has no OS sandbox or network isolation.",
      inputSchema: z.toJSONSchema(runShellInputSchema),
    },
    outputSchema: runShellOutputSchema,
    effect: "execute",
    cancellation: "abort_signal",
    maximumResult: { maximumBytes: 2 * shellLimits.maximumInlineBytesPerStream },
    prepare(argumentsJson) {
      const parsedArguments = parseInput(runShellInputSchema, argumentsJson);
      if (!parsedArguments.success) {
        return invalidToolInput();
      }
      return {
        status: "ready",
        permissionSubject: {
          type: "command",
          command: parsedArguments.data.command,
          cwd: ".",
        },
        async execute(context) {
          return executeSafely(runShellOutputSchema, () =>
            runShellCommand({
              workspaceRoot,
              command: parsedArguments.data.command,
              timeoutMs: parsedArguments.data.timeoutMs ?? shellLimits.timeoutMs,
              signal: context.signal,
              callId: context.callId,
              toolName: context.toolName,
              artifactStore: options.artifactStore,
              limits: shellLimits,
            }),
          );
        },
      };
    },
  };
  const adapters = [
    requireAdapter(readTools, "read_file"),
    requireAdapter(mutationTools, "write_file"),
    requireAdapter(mutationTools, "edit_file"),
    shellAdapter,
  ];
  const adaptersByName = new Map(adapters.map((adapter) => [adapter.definition.name, adapter]));

  return {
    definitions() {
      return adapters.map((adapter) => adapter.definition);
    },
    resolve(name) {
      return adaptersByName.get(name);
    },
  };
}

function requireAdapter(registry: ToolRegistry, name: string): ToolAdapter {
  const adapter = registry.resolve(name);
  if (adapter === undefined) {
    throw new Error(`Missing required coding tool: ${name}`);
  }
  return adapter;
}

async function runShellCommand(options: {
  readonly workspaceRoot: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
  readonly artifactStore: ArtifactStore | undefined;
  readonly limits: ShellRuntimeLimits;
}): Promise<JsonValue> {
  const isolatedHome = await mkdtemp(join(tmpdir(), "adam-agent-shell-home-"));
  try {
    const processOutput = await new Promise<ShellProcessOutput>((resolvePromise, rejectPromise) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("/bin/sh", ["-c", options.command], {
          cwd: options.workspaceRoot,
          detached: true,
          env: createShellEnvironment(isolatedHome),
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.end();
      } catch {
        rejectPromise(
          new ToolExecutionError("shell_start_failed", "The shell process could not be started."),
        );
        return;
      }
      let stdout = emptyShellStream();
      let stderr = emptyShellStream();
      let terminationCause: "timed_out" | "interrupted" | undefined;
      let settled = false;
      let terminationCleanup: Promise<void> | undefined;
      const terminate = () => {
        terminationCleanup ??= (async () => {
          signalProcessGroup(child.pid, "SIGTERM");
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, options.limits.terminationGraceMs),
          );
          signalProcessGroup(child.pid, "SIGKILL");
        })();
      };
      const timeout = setTimeout(() => {
        if (terminationCause === undefined) {
          terminationCause = "timed_out";
          terminate();
        }
      }, options.timeoutMs);
      timeout.unref();
      const abort = () => {
        if (terminationCause === undefined) {
          terminationCause = "interrupted";
          terminate();
        }
      };
      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendShellOutput(stdout, chunk, options.limits);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendShellOutput(stderr, chunk, options.limits);
      });
      child.once("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        void (terminationCleanup ?? Promise.resolve()).then(
          () =>
            rejectPromise(
              new ToolExecutionError(
                "shell_start_failed",
                "The shell process could not be started.",
              ),
            ),
          rejectPromise,
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        const termination =
          terminationCause !== undefined
            ? { type: terminationCause }
            : exitCode !== null
              ? { type: "exited" as const, exitCode }
              : { type: "signalled" as const, signal: signal ?? "unknown" };
        void (terminationCleanup ?? Promise.resolve()).then(
          () =>
            resolvePromise({
              termination,
              stdout,
              stderr,
            }),
          rejectPromise,
        );
      });
    });
    return {
      termination: processOutput.termination,
      stdout: await finishShellStream(processOutput.stdout, "stdout", options, options.limits),
      stderr: await finishShellStream(processOutput.stderr, "stderr", options, options.limits),
    };
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

type ShellStreamAccumulator = {
  readonly tail: Buffer;
  readonly totalBytes: number;
  readonly capturedChunks: readonly Buffer[];
  readonly capturedBytes: number;
};

function emptyShellStream(): ShellStreamAccumulator {
  return { tail: Buffer.alloc(0), totalBytes: 0, capturedChunks: [], capturedBytes: 0 };
}

function appendShellOutput(
  stream: ShellStreamAccumulator,
  chunk: Buffer,
  limits: ShellRuntimeLimits,
): ShellStreamAccumulator {
  const combined = Buffer.concat([stream.tail, chunk]);
  const remainingArtifactBytes = limits.maximumArtifactBytesPerStream - stream.capturedBytes;
  const capturedChunk = chunk.subarray(0, Math.max(0, remainingArtifactBytes));
  return {
    tail:
      combined.byteLength <= limits.maximumInlineBytesPerStream
        ? combined
        : combined.subarray(combined.byteLength - limits.maximumInlineBytesPerStream),
    totalBytes: stream.totalBytes + chunk.byteLength,
    capturedChunks:
      capturedChunk.byteLength === 0
        ? stream.capturedChunks
        : [...stream.capturedChunks, capturedChunk],
    capturedBytes: stream.capturedBytes + capturedChunk.byteLength,
  };
}

async function finishShellStream(
  stream: ShellStreamAccumulator,
  streamName: "stdout" | "stderr",
  context: {
    readonly callId: string;
    readonly toolName: string;
    readonly artifactStore: ArtifactStore | undefined;
  },
  limits: ShellRuntimeLimits,
): Promise<JsonValue> {
  const output: { readonly [key: string]: JsonValue } = {
    tail: stream.tail.toString("utf8"),
    totalBytes: stream.totalBytes,
    omittedBytes: stream.totalBytes - stream.tail.byteLength,
  };
  if (stream.totalBytes <= limits.maximumInlineBytesPerStream) {
    return output;
  }
  if (context.artifactStore === undefined) {
    throw new ToolExecutionError(
      "artifact_store_failed",
      "The overflowing shell output could not be stored.",
    );
  }
  try {
    const artifact = await context.artifactStore.write({
      bytes: Buffer.concat(stream.capturedChunks, stream.capturedBytes),
      mediaType: "application/octet-stream",
      source: {
        type: "tool_output",
        callId: context.callId,
        toolName: context.toolName,
        stream: streamName,
        totalBytes: stream.totalBytes,
        truncated: stream.totalBytes > stream.capturedBytes,
      },
    });
    return {
      ...output,
      artifact: {
        id: artifact.id,
        mediaType: artifact.mediaType,
        byteCount: artifact.byteCount,
        source: {
          type: artifact.source.type,
          callId: artifact.source.callId,
          toolName: artifact.source.toolName,
          stream: artifact.source.stream,
          totalBytes: artifact.source.totalBytes,
          truncated: artifact.source.truncated,
        },
      },
    };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      throw error;
    }
    throw new ToolExecutionError(
      "artifact_store_failed",
      "The overflowing shell output could not be stored.",
    );
  }
}

function assertShellRuntimeLimits(limits: ShellRuntimeLimits): void {
  const values = [
    limits.timeoutMs,
    limits.terminationGraceMs,
    limits.maximumInlineBytesPerStream,
    limits.maximumArtifactBytesPerStream,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maximumInlineBytesPerStream > limits.maximumArtifactBytesPerStream
  ) {
    throw new RangeError(
      "Shell limits must be positive safe integers and the artifact limit must cover the inline limit.",
    );
  }
}

type ShellProcessOutput = {
  readonly termination:
    | { readonly type: "exited"; readonly exitCode: number }
    | { readonly type: "timed_out" }
    | { readonly type: "interrupted" }
    | { readonly type: "signalled"; readonly signal: string };
  readonly stdout: ShellStreamAccumulator;
  readonly stderr: ShellStreamAccumulator;
};

function createShellEnvironment(isolatedHome: string): NodeJS.ProcessEnv {
  const { PATH: executablePath } = process.env;
  const environment: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    PATH: executablePath ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tmpdir(),
  };
  for (const name of ["LANG", "LC_ALL", "TERM"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
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
  type: "file" | "workspace_path",
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
