import { createHash } from "node:crypto";
import { chmod, type FileHandle, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { RunResult, RuntimeEvent } from "./index.js";

export type CanonicalRuntimeEvent = Exclude<RuntimeEvent, { readonly type: "model_message_delta" }>;

export type SessionEventRecord = {
  readonly schemaVersion: 1;
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

const runErrorCodeSchema = z.enum([
  "model_stream_incomplete",
  "model_protocol_invalid",
  "invalid_run_limits",
  "run_already_active",
  "session_persistence_failed",
  "turn_limit_exceeded",
  "token_limit_exceeded",
  "token_usage_missing",
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
    error: z.strictObject({ code: runErrorCodeSchema, message: z.string() }),
  }),
]);
const toolErrorSchema = z.strictObject({
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
    "tool_io_failed",
  ]),
  message: z.string(),
});
const permissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), path: z.string() }),
  z.strictObject({ type: z.literal("workspace_path"), path: z.string() }),
]);
const canonicalRuntimeEventSchema: z.ZodType<CanonicalRuntimeEvent> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user_message"), text: z.string() }),
  z.strictObject({ type: z.literal("model_message_started") }),
  z.strictObject({ type: z.literal("model_message_completed"), text: z.string() }),
  z
    .strictObject({
      type: z.literal("model_usage"),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
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
    subject: permissionSubjectSchema,
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
    subject: permissionSubjectSchema.optional(),
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
    error: toolErrorSchema,
  }),
  z.strictObject({ type: z.literal("session_interrupted"), reason: z.literal("cancelled") }),
  z.strictObject({ type: z.literal("session_settled"), result: runResultSchema }),
]);
const sessionEventRecordSchema: z.ZodType<SessionEventRecord> = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  sequence: z.number().int().positive(),
  event: canonicalRuntimeEventSchema,
});
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
