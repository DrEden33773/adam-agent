import { createHash } from "node:crypto";
import { chmod, type FileHandle, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import type { RunResult, RuntimeEvent } from "./index.js";
import { modelDriverErrorCategories } from "./model-driver-error.js";
import type { PermissionSubject } from "./tool-runtime.js";

export type CanonicalRuntimeEvent = Exclude<RuntimeEvent, { readonly type: "model_message_delta" }>;

type V1PermissionSubject = Exclude<PermissionSubject, { readonly type: "patch" }>;
type V1ToolError = {
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
type VersionedCanonicalRuntimeEvent<Subject, ToolError> =
  | Exclude<
      CanonicalRuntimeEvent,
      {
        readonly type: "tool_permission_requested" | "tool_permission_decided" | "tool_failed";
      }
    >
  | (Omit<
      Extract<CanonicalRuntimeEvent, { readonly type: "tool_permission_requested" }>,
      "subject"
    > & { readonly subject: Subject })
  | (Omit<
      Extract<CanonicalRuntimeEvent, { readonly type: "tool_permission_decided" }>,
      "subject"
    > & { readonly subject?: Subject | undefined })
  | (Omit<Extract<CanonicalRuntimeEvent, { readonly type: "tool_failed" }>, "error"> & {
      readonly error: ToolError;
    });
type V1CanonicalRuntimeEvent = VersionedCanonicalRuntimeEvent<V1PermissionSubject, V1ToolError>;

export type SessionEventRecord =
  | {
      readonly schemaVersion: 1;
      readonly runId: string;
      readonly sequence: number;
      readonly event: V1CanonicalRuntimeEvent;
    }
  | {
      readonly schemaVersion: 2;
      readonly runId: string;
      readonly sequence: number;
      readonly event: CanonicalRuntimeEvent;
    };

export interface SessionStore {
  append(record: SessionEventRecord): Promise<void>;
  read(): Promise<readonly SessionEventRecord[]>;
}

export class SessionStoreError extends Error {
  readonly code: "session_log_exists" | "session_log_invalid" | "session_log_too_large";

  constructor(
    code:
      | "session_log_exists"
      | "session_log_invalid"
      | "session_log_too_large" = "session_log_invalid",
  ) {
    super(
      code === "session_log_exists"
        ? "The session log already exists."
        : code === "session_log_too_large"
          ? "The session log exceeds its read limit."
          : "The session log contains an invalid record.",
    );
    this.name = "SessionStoreError";
    this.code = code;
  }
}

const ordinaryRunErrorCodeSchema = z.enum([
  "model_stream_incomplete",
  "model_protocol_invalid",
  "model_output_truncated",
  "model_content_filtered",
  "invalid_run_limits",
  "run_already_active",
  "session_persistence_failed",
  "turn_limit_exceeded",
  "token_limit_exceeded",
  "token_usage_missing",
]);
type RunFailure = Extract<RunResult, { readonly status: "failed" }>["error"];
const runFailureSchema: z.ZodType<RunFailure> = z.discriminatedUnion("code", [
  z.strictObject({
    code: ordinaryRunErrorCodeSchema,
    message: z.string(),
  }),
  z.strictObject({
    code: z.enum(["model_resource_exhausted", "model_finish_unknown"]),
    message: z.string(),
    providerReason: z.string().max(128).optional(),
  }),
  z.strictObject({
    code: z.literal("model_request_failed"),
    message: z.string(),
    category: z.enum(modelDriverErrorCategories),
    status: z.number().int().min(100).max(599).optional(),
    providerCode: z.string().max(128).optional(),
    requestId: z.string().max(128).optional(),
  }),
]);
const runResultSchema: z.ZodType<RunResult> = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), answer: z.string() }),
  z.strictObject({
    status: z.literal("cancelled"),
    error: z.strictObject({
      code: z.literal("session_cancelled"),
      message: z.string(),
    }),
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: runFailureSchema,
  }),
]);
const v1ToolErrorSchema = z.strictObject({
  code: z.enum([
    "unknown_tool",
    "invalid_tool_input",
    "permission_denied",
    "outside_workspace",
    "not_found",
    "already_exists",
    "ambiguous_match",
    "binary_file",
    "file_too_large",
    "no_match",
    "overlapping_edits",
    "artifact_store_failed",
    "shell_start_failed",
    "tool_io_failed",
  ]),
  message: z.string(),
});
const canonicalPatchPathSchema = z.string().refine(isCanonicalPatchPath);
const v2ToolErrorSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.enum([
      "unknown_tool",
      "invalid_tool_input",
      "permission_denied",
      "outside_workspace",
      "not_found",
      "already_exists",
      "ambiguous_match",
      "binary_file",
      "file_too_large",
      "no_match",
      "overlapping_edits",
      "path_conflict",
      "artifact_store_failed",
      "shell_start_failed",
      "tool_io_failed",
    ]),
    message: z.string(),
  }),
  z.strictObject({
    code: z.literal("patch_recovery_cleanup_failed"),
    message: z.string(),
    settlement: z.enum(["committed", "rolled_back"]),
    recoveryReference: z.strictObject({ id: z.uuid() }),
  }),
  z.strictObject({
    code: z.literal("patch_state_uncertain"),
    message: z.string(),
    affectedPaths: z
      .array(canonicalPatchPathSchema)
      .min(1)
      .max(64)
      .refine((paths) =>
        paths.every((path, index) => {
          const previousPath = paths[index - 1];
          return index === 0 || (previousPath !== undefined && previousPath < path);
        }),
      ),
    recoveryReference: z.strictObject({ id: z.uuid() }),
  }),
]);
const v1PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]);
const persistedPatchOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["create", "delete", "update"]),
    path: canonicalPatchPathSchema,
  }),
  z.strictObject({
    kind: z.literal("move"),
    from: canonicalPatchPathSchema,
    to: canonicalPatchPathSchema,
  }),
]);
const patchPermissionSubjectSchema = z
  .strictObject({
    type: z.literal("patch"),
    version: z.literal(1),
    operations: z.array(persistedPatchOperationSchema).min(1).max(32),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .superRefine((subject, context) => {
    const paths: string[] = [];
    for (const operation of subject.operations) {
      const operationPaths =
        operation.kind === "move" ? [operation.from, operation.to] : [operation.path];
      for (const path of operationPaths) {
        if (
          paths.some(
            (existingPath) =>
              path === existingPath ||
              path.startsWith(`${existingPath}/`) ||
              existingPath.startsWith(`${path}/`),
          )
        ) {
          context.addIssue({ code: "custom", message: "Patch paths must not conflict." });
          return;
        }
        paths.push(path);
      }
    }
  });
const v2PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
  patchPermissionSubjectSchema,
  z.strictObject({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.literal("."),
  }),
]);

function isCanonicalPatchPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}
function createCanonicalRuntimeEventSchema(options: {
  readonly permissionSubject: z.ZodType;
  readonly toolError: z.ZodType;
}): z.ZodType<CanonicalRuntimeEvent> {
  return z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user_message"), text: z.string() }),
    z.strictObject({ type: z.literal("model_message_started") }),
    z.strictObject({ type: z.literal("model_message_completed"), text: z.string() }),
    z
      .strictObject({
        type: z.literal("model_usage"),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        reasoningTokens: z.number().int().nonnegative().optional(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        cacheMissInputTokens: z.number().int().nonnegative().optional(),
      })
      .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens),
    z.strictObject({
      type: z.literal("tool_requested"),
      callId: z.string(),
      name: z.string(),
    }),
    z.strictObject({
      type: z.literal("tool_permission_requested"),
      requestId: z.string(),
      callId: z.string(),
      name: z.string(),
      effect: z.enum(["read", "write", "execute", "network", "delegate", "administrative"]),
      scope: z.literal("call"),
      subject: options.permissionSubject,
    }),
    z.strictObject({
      type: z.literal("tool_permission_decided"),
      callId: z.string(),
      name: z.string(),
      decision: z.enum(["allow", "deny"]),
      requestId: z.string().optional(),
      effect: z
        .enum(["read", "write", "execute", "network", "delegate", "administrative"])
        .optional(),
      scope: z.literal("call").optional(),
      subject: options.permissionSubject.optional(),
    }),
    z.strictObject({
      type: z.literal("tool_started"),
      callId: z.string(),
      name: z.string(),
    }),
    z.strictObject({
      type: z.literal("tool_completed"),
      callId: z.string(),
      name: z.string(),
      output: z.json(),
    }),
    z.strictObject({
      type: z.literal("tool_failed"),
      callId: z.string(),
      name: z.string(),
      error: options.toolError,
    }),
    z.strictObject({ type: z.literal("session_interrupted"), reason: z.literal("cancelled") }),
    z.strictObject({ type: z.literal("session_settled"), result: runResultSchema }),
  ]) as z.ZodType<CanonicalRuntimeEvent>;
}

const v1CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v1PermissionSubjectSchema,
  toolError: v1ToolErrorSchema,
}) as z.ZodType<V1CanonicalRuntimeEvent>;
const v2CanonicalRuntimeEventSchema = createCanonicalRuntimeEventSchema({
  permissionSubject: v2PermissionSubjectSchema,
  toolError: v2ToolErrorSchema,
});
const sessionEventRecordSchema: z.ZodType<SessionEventRecord> = z.discriminatedUnion(
  "schemaVersion",
  [
    z.strictObject({
      schemaVersion: z.literal(1),
      runId: z.uuid(),
      sequence: z.number().int().positive(),
      event: v1CanonicalRuntimeEventSchema,
    }),
    z.strictObject({
      schemaVersion: z.literal(2),
      runId: z.uuid(),
      sequence: z.number().int().positive(),
      event: v2CanonicalRuntimeEventSchema,
    }),
  ],
);
const maxSessionLogBytes = 8 * 1024 * 1024;
const maxSessionRecordBytes = 1024 * 1024;

export function createInMemorySessionStore(): SessionStore {
  const records: SessionEventRecord[] = [];
  let nextSequence = 1;
  let storedBytes = 0;
  return {
    async append(record) {
      const { record: validatedRecord, storedByteLength } =
        validateBoundedSessionEventRecord(record);
      if (validatedRecord.sequence !== nextSequence) {
        throw new SessionStoreError();
      }
      if (storedBytes + storedByteLength > maxSessionLogBytes) {
        throw new SessionStoreError("session_log_too_large");
      }
      records.push(validatedRecord);
      nextSequence += 1;
      storedBytes += storedByteLength;
    },
    async read() {
      return validateRecordSequence([...records]);
    },
  };
}

export async function createJsonlSessionStore(options: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly stateRoot?: string;
}): Promise<SessionStore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(options.sessionId)) {
    throw new TypeError("The session ID must be a safe filename segment.");
  }

  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectId = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const projectsDirectory = join(stateRoot, "projects");
  const projectDirectory = join(projectsDirectory, projectId);
  const sessionsDirectory = join(projectDirectory, "sessions");
  for (const directory of [projectsDirectory, projectDirectory, sessionsDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const sessionPath = join(sessionsDirectory, `${options.sessionId}.jsonl`);
  try {
    const file = await open(sessionPath, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new SessionStoreError("session_log_exists");
    }
    throw error;
  }
  let nextSequence = 1;
  let storedBytes = 0;
  let appendQueue = Promise.resolve();

  return {
    append(record) {
      const operation = appendQueue.then(async () => {
        const {
          record: validatedRecord,
          serialized,
          storedByteLength,
        } = validateBoundedSessionEventRecord(record);
        if (validatedRecord.sequence !== nextSequence) {
          throw new SessionStoreError();
        }
        if (storedBytes + storedByteLength > maxSessionLogBytes) {
          throw new SessionStoreError("session_log_too_large");
        }
        const file = await open(sessionPath, "a", 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(`${serialized}\n`, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        nextSequence += 1;
        storedBytes += storedByteLength;
      });
      appendQueue = operation.catch(() => {});
      return operation;
    },
    async read() {
      await appendQueue;
      const content = await readBoundedSessionLog(sessionPath);
      if (content === undefined) {
        return [];
      }
      if (content.length === 0) {
        return [];
      }
      if (!content.endsWith("\n")) {
        throw new SessionStoreError();
      }
      const lines = content.slice(0, -1).split("\n");
      if (lines.some((line) => Buffer.byteLength(line, "utf8") > maxSessionRecordBytes)) {
        throw new SessionStoreError("session_log_too_large");
      }
      const records = lines.map((line) => parseSessionEventRecord(line));
      return validateRecordSequence(records);
    },
  };
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

async function readBoundedSessionLog(sessionPath: string): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(sessionPath, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size > maxSessionLogBytes) {
      throw new SessionStoreError("session_log_too_large");
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseSessionEventRecord(line: string): SessionEventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SessionStoreError();
  }
  return validateSessionEventRecord(parsed);
}

function validateSessionEventRecord(value: unknown): SessionEventRecord {
  const result = sessionEventRecordSchema.safeParse(value);
  if (!result.success) {
    throw new SessionStoreError();
  }
  return result.data;
}

function validateBoundedSessionEventRecord(value: unknown): {
  readonly record: SessionEventRecord;
  readonly serialized: string;
  readonly storedByteLength: number;
} {
  const record = validateSessionEventRecord(value);
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > maxSessionRecordBytes) {
    throw new SessionStoreError("session_log_too_large");
  }
  return { record, serialized, storedByteLength: Buffer.byteLength(serialized, "utf8") + 1 };
}

function validateRecordSequence(
  records: readonly SessionEventRecord[],
): readonly SessionEventRecord[] {
  if (records.some((record, index) => record.sequence !== index + 1)) {
    throw new SessionStoreError();
  }
  return records;
}
