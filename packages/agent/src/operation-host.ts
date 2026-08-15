import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type {
  ExtensionActivationDiagnostic,
  ExtensionJsonValue,
  ExtensionOperationBudgetSnapshot,
  ExtensionOperationContext,
  ExtensionOperationRegistration,
} from "@adam-agent/extension-api";
import {
  EXTENSION_OPERATION_DEADLINE_DEFAULT_MS,
  EXTENSION_OPERATION_DEADLINE_MAX_MS,
  EXTENSION_OPERATION_INPUT_MAX_BYTES,
  EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
  EXTENSION_OPERATION_JSON_MAX_DEPTH,
  EXTENSION_OPERATION_OUTPUT_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_RECORDS,
  EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES,
} from "@adam-agent/extension-api";
import {
  createInMemoryOperationStore,
  type OperationCancellationReason,
  type OperationEvent,
  type OperationEventRecord,
  type OperationFailure,
  type OperationStartedEvent,
  type OperationStore,
  OperationStoreError,
} from "./operation-store.js";

export type RegisteredOperation = {
  readonly contributionId: string;
  readonly diagnostics: readonly ExtensionActivationDiagnostic[];
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly registration: ExtensionOperationRegistration;
};

export type OperationStartOptions = {
  readonly contributionId: string;
  readonly deadlineMs?: number;
  readonly idempotencyKey: string;
  readonly input: unknown;
};

export type OperationReference = {
  readonly operationId: string;
};

type OperationSnapshotBase = {
  readonly budget: ExtensionOperationBudgetSnapshot;
  readonly contributionId: string;
  readonly deadlineAt: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly operationId: string;
  readonly progress?: ExtensionJsonValue | undefined;
  readonly startedAt: string;
};

export type OperationSnapshot =
  | (OperationSnapshotBase & { readonly status: "running" | "cancel_requested" })
  | (OperationSnapshotBase & {
      readonly status: "completed";
      readonly output: ExtensionJsonValue;
    })
  | (OperationSnapshotBase & {
      readonly status: "failed";
      readonly error: OperationFailure;
    })
  | (OperationSnapshotBase & {
      readonly status: "cancelled";
      readonly reason: OperationCancellationReason;
    })
  | (OperationSnapshotBase & {
      readonly status: "recovery_required";
      readonly error: {
        readonly code: "operation_recovery_required";
        readonly message: string;
      };
    });

export interface OperationHost {
  cancel(operationId: string): Promise<OperationSnapshot>;
  events(options: {
    readonly afterSequence?: number;
    readonly operationId: string;
  }): AsyncIterable<OperationEventRecord>;
  query(operationId: string): Promise<OperationSnapshot>;
  start(options: OperationStartOptions): Promise<OperationReference>;
}

export interface OperationHostControl extends OperationHost {
  disableExtensionOperations(extensionId: string, graceMs: number): Promise<boolean>;
  enableExtensionOperations(extensionId: string): Promise<void>;
}

export class OperationHostError extends Error {
  readonly code:
    | "operation_contribution_unavailable"
    | "operation_deadline_invalid"
    | "operation_idempotency_conflict"
    | "operation_input_invalid"
    | "operation_input_too_large"
    | "operation_not_found"
    | "operation_persistence_failed"
    | "operation_project_unavailable"
    | "operation_store_project_mismatch";

  constructor(code: OperationHostError["code"], options?: { readonly cause?: unknown }) {
    super(operationHostErrorMessage(code), options);
    this.name = "OperationHostError";
    this.code = code;
  }
}

type ActiveOperation = {
  readonly abortController: AbortController;
  readonly deadlineAt: string;
  readonly operationId: string;
  readonly registered: RegisteredOperation;
  appendQueue: Promise<void>;
  cancelPromise?: Promise<void>;
  cancelReason?: OperationCancellationReason;
  forcedFailure?: OperationFailure;
  handlerDidSettle: boolean;
  readonly handlerSettled: Promise<void>;
  readonly inputBytes: number;
  nextSequence: number;
  progressBytes: number;
  progressRecords: number;
  readonly settled: Promise<void>;
  readonly signalHandlerSettled: () => void;
  readonly signalSettled: () => void;
  settling: boolean;
  terminalDidSettle: boolean;
};

export function createOperationHost(options: {
  readonly defaultDeadlineMs?: number;
  readonly projectRoot: string;
  readonly resolveOperation: (contributionId: string) => RegisteredOperation | undefined;
  readonly store?: OperationStore;
}): OperationHostControl {
  const store = options.store ?? createInMemoryOperationStore();
  const configuredDeadlineMs = options.defaultDeadlineMs ?? EXTENSION_OPERATION_DEADLINE_DEFAULT_MS;
  let projectIdPromise: Promise<string> | undefined;
  const activeOperations = new Map<string, ActiveOperation>();
  const disabledExtensions = new Set<string>();
  const extensionAdmissionQueues = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<() => void>>();

  async function appendAndPublish(record: OperationEventRecord): Promise<void> {
    try {
      await store.append(record);
    } catch (error) {
      if (error instanceof OperationStoreError && error.code === "operation_idempotency_conflict") {
        throw error;
      }
      throw new OperationHostError("operation_persistence_failed", { cause: error });
    }
    for (const listener of listeners.get(record.operationId) ?? []) {
      listener();
    }
  }

  const host: OperationHostControl = {
    async start(startOptions) {
      const registered = options.resolveOperation(startOptions.contributionId);
      if (registered === undefined) {
        throw new OperationHostError("operation_contribution_unavailable");
      }
      return enqueueExtensionAdmission(
        extensionAdmissionQueues,
        registered.extensionId,
        async () => {
          if (
            disabledExtensions.has(registered.extensionId) ||
            options.resolveOperation(startOptions.contributionId) !== registered
          ) {
            throw new OperationHostError("operation_contribution_unavailable");
          }
          const deadlineMs = startOptions.deadlineMs ?? configuredDeadlineMs;
          if (
            !Number.isSafeInteger(deadlineMs) ||
            deadlineMs <= 0 ||
            deadlineMs > configuredDeadlineMs ||
            deadlineMs > EXTENSION_OPERATION_DEADLINE_MAX_MS
          ) {
            throw new OperationHostError("operation_deadline_invalid");
          }
          let normalizedInput: ReturnType<typeof normalizeJson>;
          try {
            normalizedInput = normalizeJson(
              startOptions.input,
              EXTENSION_OPERATION_INPUT_MAX_BYTES,
            );
          } catch (error) {
            if (error instanceof OperationHostError) {
              throw error;
            }
            throw new OperationHostError("operation_input_invalid", { cause: error });
          }
          projectIdPromise ??= createProjectId(options.projectRoot);
          const projectId = await projectIdPromise;
          if (store.projectId !== undefined && store.projectId !== projectId) {
            throw new OperationHostError("operation_store_project_mismatch");
          }
          const scope = {
            contributionId: registered.contributionId,
            extensionId: registered.extensionId,
            extensionVersion: registered.extensionVersion,
            idempotencyKey: validateIdempotencyKey(startOptions.idempotencyKey),
            projectId,
          };
          const existing = await store.findByIdempotency(scope);
          if (existing !== undefined && existing.event.type === "operation_started") {
            if (existing.event.inputDigest !== normalizedInput.digest) {
              throw new OperationHostError("operation_idempotency_conflict");
            }
            return { operationId: existing.operationId };
          }
          const decodedInput = decodeInput(registered.registration, normalizedInput.value);

          const operationId = randomUUID();
          const now = Date.now();
          const recordedAt = new Date(now).toISOString();
          const deadlineAt = new Date(now + deadlineMs).toISOString();
          const startedEvent: OperationStartedEvent = {
            type: "operation_started",
            contributionId: registered.contributionId,
            deadlineAt,
            extensionId: registered.extensionId,
            extensionVersion: registered.extensionVersion,
            idempotencyKey: scope.idempotencyKey,
            input: normalizedInput.value,
            inputDigest: normalizedInput.digest,
            projectId,
          };
          try {
            await appendAndPublish({
              schemaVersion: 1,
              operationId,
              sequence: 1,
              recordedAt,
              event: startedEvent,
            });
          } catch (error) {
            if (
              error instanceof OperationStoreError &&
              error.code === "operation_idempotency_conflict"
            ) {
              const raced = await store.findByIdempotency(scope);
              if (raced?.event.type === "operation_started") {
                if (raced.event.inputDigest !== normalizedInput.digest) {
                  throw new OperationHostError("operation_idempotency_conflict");
                }
                return { operationId: raced.operationId };
              }
            }
            throw error;
          }
          let signalSettled = () => {};
          const settled = new Promise<void>((resolve) => {
            signalSettled = resolve;
          });
          let signalHandlerSettled = () => {};
          const handlerSettled = new Promise<void>((resolve) => {
            signalHandlerSettled = resolve;
          });
          const active: ActiveOperation = {
            abortController: new AbortController(),
            appendQueue: Promise.resolve(),
            deadlineAt,
            handlerDidSettle: false,
            handlerSettled,
            inputBytes: normalizedInput.byteLength,
            nextSequence: 2,
            operationId,
            progressBytes: 0,
            progressRecords: 0,
            registered,
            settled,
            signalHandlerSettled,
            signalSettled,
            settling: false,
            terminalDidSettle: false,
          };
          activeOperations.set(operationId, active);
          queueMicrotask(() => {
            void executeOperation(active, decodedInput, appendAndPublish, activeOperations).catch(
              () => undefined,
            );
          });
          return { operationId };
        },
      );
    },

    async query(operationId) {
      const records = await store.read(operationId);
      if (records.length === 0) {
        throw new OperationHostError("operation_not_found");
      }
      return createSnapshot(records, activeOperations.has(operationId));
    },

    events({ afterSequence = 0, operationId }) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new TypeError("The event sequence cursor must be a non-negative integer.");
      }
      return streamEvents(operationId, afterSequence, store, activeOperations, listeners);
    },

    async cancel(operationId) {
      const snapshot = await host.query(operationId);
      if (
        snapshot.status === "completed" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled" ||
        snapshot.status === "recovery_required"
      ) {
        return snapshot;
      }
      const active = activeOperations.get(operationId);
      if (active === undefined) {
        return host.query(operationId);
      }
      await requestCancellation(active, "caller", appendAndPublish);
      return host.query(operationId);
    },

    async disableExtensionOperations(extensionId, graceMs) {
      disabledExtensions.add(extensionId);
      return enqueueExtensionAdmission(extensionAdmissionQueues, extensionId, async () => {
        const active = [...activeOperations.values()].filter(
          (operation) => operation.registered.extensionId === extensionId,
        );
        if (active.length === 0) {
          return true;
        }
        await Promise.all(
          active.map((operation) =>
            requestCancellation(operation, "extension_disabled", appendAndPublish),
          ),
        );
        if (active.every((operation) => !activeOperations.has(operation.operationId))) {
          return true;
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            Promise.all(
              active.flatMap((operation) => [operation.handlerSettled, operation.settled]),
            ).then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), graceMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
      });
    },

    enableExtensionOperations(extensionId) {
      return enqueueExtensionAdmission(extensionAdmissionQueues, extensionId, async () => {
        disabledExtensions.delete(extensionId);
      });
    },
  };
  return host;
}

function enqueueExtensionAdmission<T>(
  queues: Map<string, Promise<void>>,
  extensionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(extensionId) ?? Promise.resolve();
  const operation = previous.then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  queues.set(extensionId, settled);
  void settled.then(() => {
    if (queues.get(extensionId) === settled) {
      queues.delete(extensionId);
    }
  });
  return operation;
}

async function executeOperation(
  active: ActiveOperation,
  input: unknown,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
  activeOperations: Map<string, ActiveOperation>,
): Promise<void> {
  const deadlineDelay = Math.max(0, Date.parse(active.deadlineAt) - Date.now());
  const deadline = setTimeout(() => {
    active.abortController.abort(new Error("The operation deadline elapsed."));
    void settleFailed(
      active,
      {
        code: "operation_deadline_exceeded",
        message: "The operation exceeded its deadline.",
      },
      appendAndPublish,
      activeOperations,
    ).catch(() => undefined);
  }, deadlineDelay);
  deadline.unref();
  const context: ExtensionOperationContext = Object.freeze({
    budget: Object.freeze({
      inputBytes: active.inputBytes,
      outputBytesRemaining: EXTENSION_OPERATION_OUTPUT_MAX_BYTES,
      progressBytesRemaining: EXTENSION_OPERATION_PROGRESS_MAX_BYTES,
      progressRecordsRemaining: EXTENSION_OPERATION_PROGRESS_MAX_RECORDS,
    }),
    deadlineAt: active.deadlineAt,
    diagnostics: Object.freeze(
      active.registered.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
    operationId: active.operationId,
    provenance: Object.freeze({
      contributionId: active.registered.contributionId,
      extensionId: active.registered.extensionId,
      extensionVersion: active.registered.extensionVersion,
    }),
    signal: active.abortController.signal,
    async progress(value) {
      if (active.settling || active.abortController.signal.aborted) {
        throw new Error("The operation no longer accepts progress.");
      }
      let encoded: ExtensionJsonValue;
      try {
        encoded = encodeProgress(active.registered.registration, value);
      } catch (error) {
        if (error instanceof OperationProgressLimitError) {
          markProgressLimitExceeded(active);
        }
        if (error instanceof OperationProgressInvalidError) {
          markProgressInvalid(active);
        }
        throw error;
      }
      const encodedBytes = Buffer.byteLength(JSON.stringify(encoded), "utf8");
      if (
        encodedBytes > EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES ||
        active.progressRecords + 1 > EXTENSION_OPERATION_PROGRESS_MAX_RECORDS ||
        active.progressBytes + encodedBytes > EXTENSION_OPERATION_PROGRESS_MAX_BYTES
      ) {
        markProgressLimitExceeded(active);
        throw new OperationProgressLimitError();
      }
      active.progressBytes += encodedBytes;
      active.progressRecords += 1;
      const append = active.appendQueue.then(async () => {
        await appendAndPublish({
          schemaVersion: 1,
          operationId: active.operationId,
          sequence: active.nextSequence,
          recordedAt: new Date().toISOString(),
          event: { type: "operation_progress", value: encoded },
        });
        active.nextSequence += 1;
      });
      active.appendQueue = append.catch(() => undefined);
      try {
        await append;
      } catch (error) {
        markProgressPersistenceFailed(active);
        throw error;
      }
    },
  });
  try {
    const output = await active.registered.registration.execute(input, context);
    if (active.settling) {
      return;
    }
    if (active.forcedFailure !== undefined) {
      await settleFailed(active, active.forcedFailure, appendAndPublish, activeOperations);
      return;
    }
    if (active.cancelReason !== undefined) {
      await settleTerminal(
        active,
        { type: "operation_cancelled", reason: active.cancelReason },
        appendAndPublish,
        activeOperations,
      );
      return;
    }
    const encoded = encodeOutput(active.registered.registration, output);
    await settleTerminal(
      active,
      { type: "operation_completed", output: encoded },
      appendAndPublish,
      activeOperations,
    );
  } catch (error) {
    if (active.settling) {
      return;
    }
    if (active.forcedFailure !== undefined) {
      await settleFailed(active, active.forcedFailure, appendAndPublish, activeOperations);
      return;
    }
    if (active.cancelReason !== undefined) {
      await settleTerminal(
        active,
        { type: "operation_cancelled", reason: active.cancelReason },
        appendAndPublish,
        activeOperations,
      );
      return;
    }
    await settleFailed(
      active,
      error instanceof OperationProgressLimitError
        ? {
            code: "operation_progress_limit_exceeded",
            message: "The operation exceeded its progress budget.",
          }
        : error instanceof OperationOutputInvalidError
          ? {
              code: "operation_output_invalid",
              message: "The extension returned invalid operation output.",
            }
          : error instanceof OperationProgressInvalidError
            ? {
                code: "operation_progress_invalid",
                message: "The extension reported invalid operation progress.",
              }
            : {
                code: "extension_execution_failed",
                message: "The extension operation failed.",
              },
      appendAndPublish,
      activeOperations,
    );
  } finally {
    clearTimeout(deadline);
    active.handlerDidSettle = true;
    active.signalHandlerSettled();
    releaseActiveOperation(active, activeOperations);
  }
}

async function requestCancellation(
  active: ActiveOperation,
  reason: OperationCancellationReason,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
): Promise<void> {
  if (active.settling) {
    return active.settled;
  }
  if (active.cancelPromise !== undefined) {
    return active.cancelPromise;
  }
  active.cancelReason = reason;
  const request = active.appendQueue.then(async () => {
    await appendAndPublish({
      schemaVersion: 1,
      operationId: active.operationId,
      sequence: active.nextSequence,
      recordedAt: new Date().toISOString(),
      event: { type: "operation_cancel_requested", reason },
    });
    active.nextSequence += 1;
    active.abortController.abort(new Error("The operation was cancelled."));
  });
  active.cancelPromise = request;
  active.appendQueue = request.catch(() => undefined);
  try {
    await request;
  } catch (error) {
    if (active.cancelPromise === request) {
      delete active.cancelPromise;
      delete active.cancelReason;
    }
    throw error;
  }
}

async function settleFailed(
  active: ActiveOperation,
  error: OperationFailure,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
  activeOperations: Map<string, ActiveOperation>,
): Promise<void> {
  await settleTerminal(
    active,
    { type: "operation_failed", error },
    appendAndPublish,
    activeOperations,
  );
}

async function settleTerminal(
  active: ActiveOperation,
  event: OperationEvent,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
  activeOperations: Map<string, ActiveOperation>,
): Promise<void> {
  if (active.settling) {
    return;
  }
  active.settling = true;
  try {
    await active.appendQueue;
    await appendAndPublish({
      schemaVersion: 1,
      operationId: active.operationId,
      sequence: active.nextSequence,
      recordedAt: new Date().toISOString(),
      event,
    });
    active.nextSequence += 1;
  } finally {
    active.terminalDidSettle = true;
    active.signalSettled();
    releaseActiveOperation(active, activeOperations);
  }
}

function releaseActiveOperation(
  active: ActiveOperation,
  activeOperations: Map<string, ActiveOperation>,
): void {
  if (active.handlerDidSettle && active.terminalDidSettle) {
    activeOperations.delete(active.operationId);
  }
}

class OperationProgressLimitError extends Error {}
class OperationProgressInvalidError extends Error {}
class OperationOutputInvalidError extends Error {}

function markProgressLimitExceeded(active: ActiveOperation): void {
  active.forcedFailure = {
    code: "operation_progress_limit_exceeded",
    message: "The operation exceeded its progress budget.",
  };
  active.abortController.abort(new Error("The operation exceeded its progress budget."));
}

function markProgressInvalid(active: ActiveOperation): void {
  active.forcedFailure = {
    code: "operation_progress_invalid",
    message: "The extension reported invalid operation progress.",
  };
  active.abortController.abort(new Error("The extension reported invalid operation progress."));
}

function markProgressPersistenceFailed(active: ActiveOperation): void {
  active.forcedFailure = {
    code: "operation_persistence_failed",
    message: "The operation could not persist its progress.",
  };
  active.abortController.abort(new Error("The operation could not persist its progress."));
}

async function* streamEvents(
  operationId: string,
  afterSequence: number,
  store: OperationStore,
  activeOperations: Map<string, ActiveOperation>,
  listeners: Map<string, Set<() => void>>,
): AsyncIterable<OperationEventRecord> {
  let notified = false;
  let resume: (() => void) | undefined;
  const listener = () => {
    notified = true;
    resume?.();
  };
  const operationListeners = listeners.get(operationId) ?? new Set<() => void>();
  operationListeners.add(listener);
  listeners.set(operationId, operationListeners);
  let cursor = afterSequence;
  try {
    while (true) {
      notified = false;
      const records = await store.read(operationId);
      if (records.length === 0) {
        throw new OperationHostError("operation_not_found");
      }
      for (const record of records) {
        if (record.sequence > cursor) {
          cursor = record.sequence;
          yield record;
        }
      }
      if (records.some((record) => isTerminal(record.event))) {
        return;
      }
      if (!activeOperations.has(operationId)) {
        const finalRecords = await store.read(operationId);
        for (const record of finalRecords) {
          if (record.sequence > cursor) {
            cursor = record.sequence;
            yield record;
          }
        }
        return;
      }
      const wake = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (notified) {
        resume = undefined;
        continue;
      }
      await wake;
      resume = undefined;
    }
  } finally {
    operationListeners.delete(listener);
    if (operationListeners.size === 0) {
      listeners.delete(operationId);
    }
  }
}

function createSnapshot(
  records: readonly OperationEventRecord[],
  isActive: boolean,
): OperationSnapshot {
  const first = records[0];
  if (first?.event.type !== "operation_started") {
    throw new OperationHostError("operation_persistence_failed");
  }
  const base: OperationSnapshotBase = {
    budget: createBudgetSnapshot(records),
    contributionId: first.event.contributionId,
    deadlineAt: first.event.deadlineAt,
    extensionId: first.event.extensionId,
    extensionVersion: first.event.extensionVersion,
    operationId: first.operationId,
    progress: latestProgress(records),
    startedAt: first.recordedAt,
  };
  const terminal = records.find((record) => isTerminal(record.event))?.event;
  if (terminal?.type === "operation_completed") {
    return { ...base, output: terminal.output, status: "completed" };
  }
  if (terminal?.type === "operation_failed") {
    return { ...base, error: terminal.error, status: "failed" };
  }
  if (terminal?.type === "operation_cancelled") {
    return { ...base, reason: terminal.reason, status: "cancelled" };
  }
  if (!isActive) {
    return {
      ...base,
      error: {
        code: "operation_recovery_required",
        message: "The interrupted operation requires explicit recovery.",
      },
      status: "recovery_required",
    };
  }
  return {
    ...base,
    status: records.some((record) => record.event.type === "operation_cancel_requested")
      ? "cancel_requested"
      : "running",
  };
}

function createBudgetSnapshot(
  records: readonly OperationEventRecord[],
): ExtensionOperationBudgetSnapshot {
  const started = records[0]?.event;
  if (started?.type !== "operation_started") {
    throw new OperationHostError("operation_persistence_failed");
  }
  const progress = records.filter((record) => record.event.type === "operation_progress");
  const progressBytes = progress.reduce(
    (total, record) =>
      record.event.type === "operation_progress"
        ? total + Buffer.byteLength(JSON.stringify(record.event.value), "utf8")
        : total,
    0,
  );
  const completed = records.find((record) => record.event.type === "operation_completed")?.event;
  const outputBytes =
    completed?.type === "operation_completed"
      ? Buffer.byteLength(JSON.stringify(completed.output), "utf8")
      : 0;
  return {
    inputBytes: Buffer.byteLength(JSON.stringify(started.input), "utf8"),
    outputBytesRemaining: Math.max(0, EXTENSION_OPERATION_OUTPUT_MAX_BYTES - outputBytes),
    progressBytesRemaining: Math.max(0, EXTENSION_OPERATION_PROGRESS_MAX_BYTES - progressBytes),
    progressRecordsRemaining: Math.max(
      0,
      EXTENSION_OPERATION_PROGRESS_MAX_RECORDS - progress.length,
    ),
  };
}

function latestProgress(records: readonly OperationEventRecord[]): ExtensionJsonValue | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event;
    if (event?.type === "operation_progress") {
      return event.value;
    }
  }
  return undefined;
}

function decodeInput(registration: ExtensionOperationRegistration, value: ExtensionJsonValue) {
  try {
    const result = registration.input.decode(value);
    if (!isSuccessfulContractResult(result)) {
      throw new OperationHostError("operation_input_invalid");
    }
    return result.value;
  } catch (error) {
    if (error instanceof OperationHostError) {
      throw error;
    }
    throw new OperationHostError("operation_input_invalid", { cause: error });
  }
}

function encodeOutput(
  registration: ExtensionOperationRegistration,
  value: unknown,
): ExtensionJsonValue {
  try {
    const result = registration.output.encode(value);
    if (!isSuccessfulContractResult(result)) {
      throw new OperationOutputInvalidError();
    }
    return normalizeJson(result.value, EXTENSION_OPERATION_OUTPUT_MAX_BYTES).value;
  } catch {
    throw new OperationOutputInvalidError();
  }
}

function encodeProgress(
  registration: ExtensionOperationRegistration,
  value: unknown,
): ExtensionJsonValue {
  let result: unknown;
  try {
    result = registration.progress.encode(value);
  } catch {
    throw new OperationProgressInvalidError();
  }
  if (!isSuccessfulContractResult(result)) {
    throw new OperationProgressInvalidError();
  }
  try {
    return normalizeJson(result.value, Number.MAX_SAFE_INTEGER).value;
  } catch {
    throw new OperationProgressInvalidError();
  }
}

function isSuccessfulContractResult(
  value: unknown,
): value is { readonly ok: true; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "value" in value
  );
}

function normalizeJson(
  value: unknown,
  maxBytes: number,
): { readonly byteLength: number; readonly digest: string; readonly value: ExtensionJsonValue } {
  let containers = 0;
  const visit = (candidate: unknown, depth: number): ExtensionJsonValue => {
    if (depth > EXTENSION_OPERATION_JSON_MAX_DEPTH) {
      throw new OperationHostError("operation_input_invalid");
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new OperationHostError("operation_input_invalid");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      containers += 1;
      if (containers > EXTENSION_OPERATION_JSON_MAX_CONTAINERS) {
        throw new OperationHostError("operation_input_invalid");
      }
      return candidate.map((item) => visit(item, depth + 1));
    }
    if (isPlainRecord(candidate)) {
      containers += 1;
      if (containers > EXTENSION_OPERATION_JSON_MAX_CONTAINERS) {
        throw new OperationHostError("operation_input_invalid");
      }
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, visit(candidate[key], depth + 1)]),
      );
    }
    throw new OperationHostError("operation_input_invalid");
  };
  const normalized = visit(value, 0);
  const serialized = JSON.stringify(normalized);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    throw new OperationHostError("operation_input_too_large");
  }
  return {
    byteLength,
    digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    value: normalized,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new OperationHostError("operation_input_invalid");
  }
  return value;
}

async function createProjectId(projectRoot: string): Promise<string> {
  try {
    const canonicalRoot = await realpath(projectRoot);
    return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
  } catch (error) {
    throw new OperationHostError("operation_project_unavailable", { cause: error });
  }
}

function isTerminal(event: OperationEvent): boolean {
  return (
    event.type === "operation_cancelled" ||
    event.type === "operation_completed" ||
    event.type === "operation_failed"
  );
}

function operationHostErrorMessage(code: OperationHostError["code"]): string {
  switch (code) {
    case "operation_contribution_unavailable":
      return "The operation contribution is unavailable.";
    case "operation_deadline_invalid":
      return "The requested operation deadline is invalid.";
    case "operation_idempotency_conflict":
      return "The operation idempotency key was reused with different input.";
    case "operation_input_invalid":
      return "The operation input is invalid.";
    case "operation_input_too_large":
      return "The operation input exceeds its byte limit.";
    case "operation_not_found":
      return "The operation does not exist.";
    case "operation_persistence_failed":
      return "The operation state could not be persisted.";
    case "operation_project_unavailable":
      return "The operation project root is unavailable.";
    case "operation_store_project_mismatch":
      return "The operation store belongs to another project.";
  }
}
