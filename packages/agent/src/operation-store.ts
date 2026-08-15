import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionJsonValue,
  ExtensionOperationCancellationReason,
  ExtensionOperationCancelledEvent,
  ExtensionOperationCancelRequestedEvent,
  ExtensionOperationCompletedEvent,
  ExtensionOperationEvent,
  ExtensionOperationFailedEvent,
  ExtensionOperationFailure,
  ExtensionOperationProgressEvent,
  ExtensionOperationStartedEvent,
} from "@adam-agent/extension-api";
import {
  EXTENSION_OPERATION_DEADLINE_MAX_MS,
  EXTENSION_OPERATION_INPUT_MAX_BYTES,
  EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
  EXTENSION_OPERATION_JSON_MAX_DEPTH,
  EXTENSION_OPERATION_OUTPUT_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_RECORDS,
  EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES,
} from "@adam-agent/extension-api";
import { valid } from "semver";
import { z } from "zod";

export type OperationStartedEvent = ExtensionOperationStartedEvent;

export type OperationIdempotencyScope = {
  readonly contributionId: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
};

export type OperationProgressEvent = ExtensionOperationProgressEvent;

export type OperationCancellationReason = ExtensionOperationCancellationReason;

export type OperationCancelRequestedEvent = ExtensionOperationCancelRequestedEvent;

export type OperationCompletedEvent = ExtensionOperationCompletedEvent;

export type OperationCancelledEvent = ExtensionOperationCancelledEvent;

export type OperationFailure = ExtensionOperationFailure;

export type OperationFailedEvent = ExtensionOperationFailedEvent;

export type OperationEvent = ExtensionOperationEvent;

export type OperationEventRecord = {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: OperationEvent;
};

export interface OperationStore {
  readonly projectId?: string;
  append(record: OperationEventRecord): Promise<void>;
  findByIdempotency(scope: OperationIdempotencyScope): Promise<OperationEventRecord | undefined>;
  read(operationId: string): Promise<readonly OperationEventRecord[]>;
}

export class OperationStoreError extends Error {
  readonly code:
    | "operation_idempotency_conflict"
    | "operation_log_invalid"
    | "operation_log_too_large";

  constructor(
    code:
      | "operation_idempotency_conflict"
      | "operation_log_invalid"
      | "operation_log_too_large" = "operation_log_invalid",
  ) {
    super(
      code === "operation_idempotency_conflict"
        ? "The operation idempotency key is already in use."
        : code === "operation_log_too_large"
          ? "The operation log exceeds its storage limit."
          : "The operation log contains an invalid record.",
    );
    this.name = "OperationStoreError";
    this.code = code;
  }
}

const canonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine(isCanonicalTimestamp);
const operationStartedEventSchema = z.strictObject({
  type: z.literal("operation_started"),
  contributionId: z.string().min(1).max(256),
  deadlineAt: canonicalTimestampSchema,
  extensionId: z.string().min(1).max(256),
  extensionVersion: z
    .string()
    .min(1)
    .max(128)
    .refine((version) => valid(version) !== null),
  idempotencyKey: z.string().min(1).max(256),
  input: z.json(),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
const operationProgressEventSchema = z.strictObject({
  type: z.literal("operation_progress"),
  value: z.json(),
});
const operationCancelRequestedEventSchema = z.strictObject({
  type: z.literal("operation_cancel_requested"),
  reason: z.enum(["caller", "extension_disabled"]),
});
const operationCompletedEventSchema = z.strictObject({
  type: z.literal("operation_completed"),
  output: z.json(),
});
const operationCancelledEventSchema = z.strictObject({
  type: z.literal("operation_cancelled"),
  reason: z.enum(["caller", "extension_disabled"]),
});
const operationFailedEventSchema = z.strictObject({
  type: z.literal("operation_failed"),
  error: z.strictObject({
    code: z.enum([
      "extension_execution_failed",
      "operation_deadline_exceeded",
      "operation_output_invalid",
      "operation_persistence_failed",
      "operation_progress_invalid",
      "operation_progress_limit_exceeded",
    ]),
    message: z.string().min(1).max(512),
  }),
});
const operationEventRecordSchema: z.ZodType<OperationEventRecord> = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.uuid(),
  sequence: z.number().int().positive(),
  recordedAt: canonicalTimestampSchema,
  event: z.discriminatedUnion("type", [
    operationStartedEventSchema,
    operationProgressEventSchema,
    operationCancelRequestedEventSchema,
    operationCompletedEventSchema,
    operationCancelledEventSchema,
    operationFailedEventSchema,
  ]),
});
const operationIdempotencyScopeSchema: z.ZodType<OperationIdempotencyScope> = z.strictObject({
  contributionId: z.string().min(1).max(256),
  extensionId: z.string().min(1).max(256),
  extensionVersion: z
    .string()
    .min(1)
    .max(128)
    .refine((version) => valid(version) !== null),
  idempotencyKey: z.string().min(1).max(256),
  projectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
const maxOperationRecordBytes = 16 * 1024 * 1024;
const maxOperationLogBytes = 256 * 1024 * 1024;
const operationAppendQueues = new Map<string, Promise<void>>();

export function createInMemoryOperationStore(): OperationStore {
  const records: OperationEventRecord[] = [];
  let storedBytes = 0;
  return {
    async append(record) {
      const validated = validateBoundedRecord(record);
      assertIdempotencyAvailable(records, validated.record);
      assertNextSequence(records, validated.record);
      if (storedBytes + validated.storedByteLength > maxOperationLogBytes) {
        throw new OperationStoreError("operation_log_too_large");
      }
      records.push(validated.record);
      storedBytes += validated.storedByteLength;
    },
    async findByIdempotency(scope) {
      return findStartRecord(records, validateIdempotencyScope(scope));
    },
    async read(operationId) {
      assertOperationId(operationId);
      return records.filter((record) => record.operationId === operationId);
    },
  };
}

export async function createJsonlOperationStore(options: {
  readonly workspaceRoot: string;
  readonly stateRoot?: string;
}): Promise<OperationStore> {
  const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
  const projectId = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex");
  const scopedProjectId = `sha256:${projectId}`;
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const projectsDirectory = join(stateRoot, "projects");
  const projectDirectory = join(projectsDirectory, projectId);
  const operationsDirectory = join(projectDirectory, "operations");
  for (const directory of [projectsDirectory, projectDirectory, operationsDirectory]) {
    await ensureOwnerOnlyDirectory(directory);
  }
  const operationLogPath = join(operationsDirectory, "events-v1.jsonl");
  const file = await open(
    operationLogPath,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_RDWR |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new OperationStoreError();
    }
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
  let records = await readOperationLog(operationLogPath);
  assertProjectRecords(records, scopedProjectId);
  let storedBytes = records.reduce(
    (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8") + 1,
    0,
  );

  return {
    projectId: scopedProjectId,
    append(record) {
      return enqueueAppend(operationLogPath, async () => {
        records = await readOperationLog(operationLogPath);
        assertProjectRecords(records, scopedProjectId);
        storedBytes = records.reduce(
          (total, existing) => total + Buffer.byteLength(JSON.stringify(existing), "utf8") + 1,
          0,
        );
        const validated = validateBoundedRecord(record);
        assertProjectRecord(validated.record, scopedProjectId);
        assertIdempotencyAvailable(records, validated.record);
        assertNextSequence(records, validated.record);
        if (storedBytes + validated.storedByteLength > maxOperationLogBytes) {
          throw new OperationStoreError("operation_log_too_large");
        }
        const appendFile = await open(
          operationLogPath,
          constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          const stats = await appendFile.stat();
          if (!stats.isFile()) {
            throw new OperationStoreError();
          }
          await appendFile.chmod(0o600);
          await appendFile.writeFile(`${validated.serialized}\n`, "utf8");
          await appendFile.sync();
        } finally {
          await appendFile.close();
        }
        records = [...records, validated.record];
        storedBytes += validated.storedByteLength;
      });
    },
    async findByIdempotency(scope) {
      await (operationAppendQueues.get(operationLogPath) ?? Promise.resolve());
      records = await readOperationLog(operationLogPath);
      assertProjectRecords(records, scopedProjectId);
      return findStartRecord(records, validateIdempotencyScope(scope));
    },
    async read(operationId) {
      assertOperationId(operationId);
      await (operationAppendQueues.get(operationLogPath) ?? Promise.resolve());
      records = await readOperationLog(operationLogPath);
      assertProjectRecords(records, scopedProjectId);
      return records.filter((record) => record.operationId === operationId);
    },
  };
}

function enqueueAppend(path: string, run: () => Promise<void>): Promise<void> {
  const previous = operationAppendQueues.get(path) ?? Promise.resolve();
  const operation = previous.then(run);
  const settled = operation.catch(() => undefined);
  operationAppendQueues.set(path, settled);
  void settled.finally(() => {
    if (operationAppendQueues.get(path) === settled) {
      operationAppendQueues.delete(path);
    }
  });
  return operation;
}

async function readOperationLog(path: string): Promise<OperationEventRecord[]> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new OperationStoreError();
    }
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new OperationStoreError();
    }
    if (!Number.isSafeInteger(stats.size) || stats.size > maxOperationLogBytes) {
      throw new OperationStoreError("operation_log_too_large");
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const content = bytes.subarray(0, offset).toString("utf8");
    if (content.length === 0) {
      return [];
    }
    if (!content.endsWith("\n")) {
      throw new OperationStoreError();
    }
    const lines = content.slice(0, -1).split("\n");
    if (lines.some((line) => Buffer.byteLength(line, "utf8") > maxOperationRecordBytes)) {
      throw new OperationStoreError("operation_log_too_large");
    }
    const records = lines.map(parseRecord);
    validateSequences(records);
    return records;
  } finally {
    await file.close();
  }
}

async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await directory.stat();
    if (!stats.isDirectory()) {
      throw new OperationStoreError();
    }
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

function parseRecord(line: string): OperationEventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OperationStoreError();
  }
  return validateBoundedRecord(parsed).record;
}

function validateBoundedRecord(value: unknown): {
  readonly record: OperationEventRecord;
  readonly serialized: string;
  readonly storedByteLength: number;
} {
  const record = validateRecord(value);
  assertEventPayloadBounds(record.event);
  const serialized = JSON.stringify(record);
  const storedByteLength = Buffer.byteLength(serialized, "utf8") + 1;
  if (storedByteLength - 1 > maxOperationRecordBytes) {
    throw new OperationStoreError("operation_log_too_large");
  }
  return { record, serialized, storedByteLength };
}

function validateRecord(value: unknown): OperationEventRecord {
  try {
    assertJsonBounds(
      value,
      EXTENSION_OPERATION_JSON_MAX_DEPTH + 4,
      EXTENSION_OPERATION_JSON_MAX_CONTAINERS + 16,
    );
    const result = operationEventRecordSchema.safeParse(value);
    if (result.success) {
      return result.data;
    }
  } catch (error) {
    if (error instanceof OperationStoreError) {
      throw error;
    }
  }
  throw new OperationStoreError();
}

function validateIdempotencyScope(value: unknown): OperationIdempotencyScope {
  const result = operationIdempotencyScopeSchema.safeParse(value);
  if (!result.success) {
    throw new OperationStoreError();
  }
  return result.data;
}

function validateSequences(records: readonly OperationEventRecord[]): void {
  const histories = new Map<string, OperationEventRecord[]>();
  for (const record of records) {
    const history = histories.get(record.operationId) ?? [];
    validateNextRecord(history, record);
    histories.set(record.operationId, [...history, record]);
  }
}

function assertNextSequence(
  records: readonly OperationEventRecord[],
  candidate: OperationEventRecord,
): void {
  validateNextRecord(
    records.filter((record) => record.operationId === candidate.operationId),
    candidate,
  );
}

function assertIdempotencyAvailable(
  records: readonly OperationEventRecord[],
  candidate: OperationEventRecord,
): void {
  if (candidate.event.type !== "operation_started") {
    return;
  }
  const existing = findStartRecord(records, candidate.event);
  if (existing !== undefined && existing.operationId !== candidate.operationId) {
    throw new OperationStoreError("operation_idempotency_conflict");
  }
}

function findStartRecord(
  records: readonly OperationEventRecord[],
  scope: OperationIdempotencyScope,
): OperationEventRecord | undefined {
  return records.find(
    (record) =>
      record.event.type === "operation_started" &&
      record.event.projectId === scope.projectId &&
      record.event.extensionId === scope.extensionId &&
      record.event.extensionVersion === scope.extensionVersion &&
      record.event.contributionId === scope.contributionId &&
      record.event.idempotencyKey === scope.idempotencyKey,
  );
}

function assertProjectRecords(records: readonly OperationEventRecord[], projectId: string): void {
  for (const record of records) {
    assertProjectRecord(record, projectId);
  }
}

function assertProjectRecord(record: OperationEventRecord, projectId: string): void {
  if (record.event.type === "operation_started" && record.event.projectId !== projectId) {
    throw new OperationStoreError();
  }
}

function validateNextRecord(
  history: readonly OperationEventRecord[],
  candidate: OperationEventRecord,
): void {
  if (candidate.sequence !== history.length + 1) {
    throw new OperationStoreError();
  }
  if (history.length === 0 && candidate.event.type !== "operation_started") {
    throw new OperationStoreError();
  }
  if (candidate.event.type === "operation_started") {
    const deadlineMs = Date.parse(candidate.event.deadlineAt) - Date.parse(candidate.recordedAt);
    if (deadlineMs <= 0 || deadlineMs > EXTENSION_OPERATION_DEADLINE_MAX_MS) {
      throw new OperationStoreError();
    }
  }
  if (history.length > 0 && candidate.event.type === "operation_started") {
    throw new OperationStoreError();
  }
  if (history.some((record) => isTerminalEvent(record.event))) {
    throw new OperationStoreError();
  }
  if (
    candidate.event.type === "operation_cancel_requested" &&
    history.some((record) => record.event.type === "operation_cancel_requested")
  ) {
    throw new OperationStoreError();
  }
  if (candidate.event.type === "operation_cancelled") {
    const request = history.find(
      (record) => record.event.type === "operation_cancel_requested",
    )?.event;
    if (
      request?.type !== "operation_cancel_requested" ||
      request.reason !== candidate.event.reason
    ) {
      throw new OperationStoreError();
    }
  }
  if (candidate.event.type === "operation_progress") {
    if (history.some((record) => record.event.type === "operation_cancel_requested")) {
      throw new OperationStoreError();
    }
    const progressEvents = history.filter((record) => record.event.type === "operation_progress");
    const aggregateBytes = progressEvents.reduce(
      (total, record) =>
        record.event.type === "operation_progress"
          ? total + jsonByteLength(record.event.value)
          : total,
      jsonByteLength(candidate.event.value),
    );
    if (
      progressEvents.length + 1 > EXTENSION_OPERATION_PROGRESS_MAX_RECORDS ||
      aggregateBytes > EXTENSION_OPERATION_PROGRESS_MAX_BYTES
    ) {
      throw new OperationStoreError("operation_log_too_large");
    }
  }
}

function assertEventPayloadBounds(event: OperationEvent): void {
  if (event.type === "operation_started") {
    assertJsonBounds(
      event.input,
      EXTENSION_OPERATION_JSON_MAX_DEPTH,
      EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
    );
    if (jsonByteLength(event.input) > EXTENSION_OPERATION_INPUT_MAX_BYTES) {
      throw new OperationStoreError("operation_log_too_large");
    }
    const canonicalInput = JSON.stringify(canonicalizeJson(event.input));
    const expectedDigest = `sha256:${createHash("sha256").update(canonicalInput).digest("hex")}`;
    if (event.inputDigest !== expectedDigest) {
      throw new OperationStoreError();
    }
  }
  if (event.type === "operation_completed") {
    assertJsonBounds(
      event.output,
      EXTENSION_OPERATION_JSON_MAX_DEPTH,
      EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
    );
    if (jsonByteLength(event.output) > EXTENSION_OPERATION_OUTPUT_MAX_BYTES) {
      throw new OperationStoreError("operation_log_too_large");
    }
  }
  if (event.type === "operation_progress") {
    assertJsonBounds(
      event.value,
      EXTENSION_OPERATION_JSON_MAX_DEPTH,
      EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
    );
    if (jsonByteLength(event.value) > EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES) {
      throw new OperationStoreError("operation_log_too_large");
    }
  }
}

function assertJsonBounds(value: unknown, maxDepth: number, maxContainers: number): void {
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  const seen = new WeakSet<object>();
  let containers = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const candidate = current.value;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      continue;
    }
    if (typeof candidate !== "object") {
      throw new OperationStoreError();
    }
    if (current.depth > maxDepth || seen.has(candidate)) {
      throw new OperationStoreError();
    }
    seen.add(candidate);
    containers += 1;
    if (containers > maxContainers) {
      throw new OperationStoreError();
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        pending.push({ depth: current.depth + 1, value: item });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OperationStoreError();
    }
    for (const item of Object.values(candidate)) {
      pending.push({ depth: current.depth + 1, value: item });
    }
  }
}

function jsonByteLength(value: ExtensionJsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function canonicalizeJson(value: ExtensionJsonValue): ExtensionJsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: ExtensionJsonValue };
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeJson(record[key] as ExtensionJsonValue)]),
    );
  }
  return value;
}

function isTerminalEvent(event: OperationEvent): boolean {
  return (
    event.type === "operation_cancelled" ||
    event.type === "operation_completed" ||
    event.type === "operation_failed"
  );
}

function assertOperationId(operationId: string): void {
  if (!z.uuid().safeParse(operationId).success) {
    throw new TypeError("The operation ID must be a UUID.");
  }
}

function defaultStateRoot(): string {
  const { XDG_STATE_HOME: xdgStateHome } = process.env;
  return xdgStateHome === undefined || xdgStateHome.length === 0
    ? join(homedir(), ".local", "state", "adam-agent")
    : join(xdgStateHome, "adam-agent");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
