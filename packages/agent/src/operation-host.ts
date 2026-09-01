import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type {
  ExtensionActivationDiagnostic,
  ExtensionArtifactSummary,
  ExtensionBiomeAnalysis,
  ExtensionBiomeFileSnapshot,
  ExtensionJsonValue,
  ExtensionOperationBudgetSnapshot,
  ExtensionOperationCapabilities,
  ExtensionOperationContext,
  ExtensionOperationContribution,
  ExtensionOperationEvidenceReference,
  ExtensionOperationReconciliationContext,
  ExtensionOperationReconciliationResult,
  ExtensionOperationRegistration,
  ExtensionRecord,
  ExtensionRecordList,
  ExtensionRecordSummary,
} from "@adam-agent/extension-api";
import {
  EXTENSION_ARTIFACT_CAPABILITY_ID,
  EXTENSION_ARTIFACT_MAX_AGGREGATE_BYTES,
  EXTENSION_ARTIFACT_MAX_BYTES,
  EXTENSION_ARTIFACT_MAX_COUNT,
  EXTENSION_BIOME_CAPABILITY_ID,
  EXTENSION_BIOME_MAX_FILE_BYTES,
  EXTENSION_BIOME_MAX_FILES,
  EXTENSION_BIOME_MAX_REPORT_BYTES,
  EXTENSION_BIOME_MAX_SNAPSHOT_BYTES,
  EXTENSION_BIOME_MAX_STDERR_BYTES,
  EXTENSION_BIOME_MAX_STDOUT_BYTES,
  EXTENSION_BIOME_PROFILE,
  EXTENSION_OPERATION_DEADLINE_DEFAULT_MS,
  EXTENSION_OPERATION_DEADLINE_MAX_MS,
  EXTENSION_OPERATION_INPUT_MAX_BYTES,
  EXTENSION_OPERATION_JSON_MAX_CONTAINERS,
  EXTENSION_OPERATION_JSON_MAX_DEPTH,
  EXTENSION_OPERATION_OUTPUT_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_BYTES,
  EXTENSION_OPERATION_PROGRESS_MAX_RECORDS,
  EXTENSION_OPERATION_PROGRESS_RECORD_MAX_BYTES,
  EXTENSION_RECORD_MAX_AGGREGATE_BYTES,
  EXTENSION_RECORD_MAX_BYTES,
  EXTENSION_RECORD_MAX_CREATES,
  EXTENSION_RECORDS_CAPABILITY_ID,
} from "@adam-agent/extension-api";
import type { ArtifactStore } from "./artifact-store.js";
import type { BiomeExecutionAdapter, BiomeExecutionOutput } from "./biome-execution.js";
import { type ExtensionRecordStore, ExtensionRecordStoreError } from "./extension-record-store.js";
import {
  createInMemoryOperationStore,
  type OperationCancellationReason,
  type OperationEvent,
  type OperationEventRecord,
  type OperationFailure,
  type OperationOrigin,
  type OperationStartedEvent,
  type OperationStore,
  OperationStoreError,
} from "./operation-store.js";
import {
  type ProjectExecutionDomain,
  ProjectExecutionDomainError,
  projectRuntimeRootId,
} from "./project-execution-domain.js";
import type { PermissionPolicy } from "./tool-runtime.js";

export type RegisteredOperation = {
  readonly capabilityIds: readonly string[];
  readonly contributionId: string;
  readonly contribution: ExtensionOperationContribution;
  readonly definitionDigest: string;
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

export type LinkedOperationStartOptions = OperationStartOptions & {
  readonly origin: OperationOrigin;
};

export type MaterializedLinkedOperationStartOptions = Omit<LinkedOperationStartOptions, "input"> & {
  materialize(): Promise<unknown>;
};

export type OperationReference = {
  readonly operationId: string;
};

export type OperationOriginAuthority = {
  validateBoundary(input: {
    readonly origin: OperationOrigin;
    readonly projectId: string;
  }): Promise<boolean>;
};

export type LinkedOperationListOptions = {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sessionId: string;
  readonly throughSequence: number;
};

export type LinkedOperationPage = {
  readonly items: readonly OperationReference[];
  readonly nextCursor: string | null;
};

type OperationSnapshotBase = {
  readonly budget: ExtensionOperationBudgetSnapshot;
  readonly contributionId: string;
  readonly deadlineAt: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly operationId: string;
  readonly origin: OperationOrigin | null;
  readonly progress?: ExtensionJsonValue | undefined;
  readonly presentation: {
    readonly kind: "descriptor" | "generic";
    readonly report: { readonly id: string; readonly version: number } | null;
    readonly title: string;
  };
  readonly startedAt: string;
  readonly throughSequence: number;
};

export type OperationSnapshot =
  | (OperationSnapshotBase & { readonly status: "running" | "cancel_requested" })
  | (OperationSnapshotBase & {
      readonly status: "completed";
      readonly artifacts?: readonly ExtensionArtifactSummary[];
      readonly output: ExtensionJsonValue;
    })
  | (OperationSnapshotBase & {
      readonly status: "failed";
      readonly artifacts?: readonly ExtensionArtifactSummary[];
      readonly error: OperationFailure;
    })
  | (OperationSnapshotBase & {
      readonly status: "cancelled";
      readonly artifacts?: readonly ExtensionArtifactSummary[];
      readonly reason: OperationCancellationReason;
    })
  | (OperationSnapshotBase & {
      readonly status: "inspection_required";
      readonly evidence?: readonly ExtensionOperationEvidenceReference[];
      readonly message: string;
    })
  | (OperationSnapshotBase & {
      readonly status: "recovery_required";
      readonly recoverable: boolean;
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
    readonly signal?: AbortSignal;
  }): AsyncIterable<OperationEventRecord>;
  listLinked(options: LinkedOperationListOptions): Promise<LinkedOperationPage>;
  query(operationId: string): Promise<OperationSnapshot>;
  recover(operationId: string): Promise<OperationSnapshot>;
  start(options: OperationStartOptions): Promise<OperationReference>;
  startLinked(options: LinkedOperationStartOptions): Promise<OperationReference>;
}

export interface OperationHostControl extends OperationHost {
  disableExtensionOperations(extensionId: string, graceMs: number): Promise<boolean>;
  enableExtensionOperations(extensionId: string): Promise<void>;
  startLinkedMaterialized(
    options: MaterializedLinkedOperationStartOptions,
  ): Promise<OperationReference>;
}

export class OperationHostError extends Error {
  readonly code:
    | "operation_contribution_unavailable"
    | "operation_deadline_invalid"
    | "operation_idempotency_conflict"
    | "operation_input_invalid"
    | "operation_input_too_large"
    | "operation_list_invalid"
    | "operation_not_found"
    | "operation_origin_invalid"
    | "operation_persistence_failed"
    | "operation_project_unavailable"
    | "operation_reconciliation_failed"
    | "operation_store_project_mismatch"
    | "project_in_use"
    | "project_owner_unavailable";

  constructor(code: OperationHostError["code"], options?: { readonly cause?: unknown }) {
    super(operationHostErrorMessage(code), options);
    this.name = "OperationHostError";
    this.code = code;
  }
}

type ActiveOperation = {
  readonly abortController: AbortController;
  artifactBytes: number;
  readonly artifacts: ExtensionArtifactSummary[];
  readonly deadlineAt: string;
  artifactCount: number;
  capabilityCalls: number;
  readonly operationId: string;
  ownerDidSettle: boolean;
  readonly ownerSettled: Promise<void>;
  readonly projectId: string;
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
  recordBytes: number;
  recordCreates: number;
  readonly settled: Promise<void>;
  readonly signalHandlerSettled: () => void;
  readonly signalOwnerSettled: () => void;
  readonly signalSettled: () => void;
  settling: boolean;
  terminalDidSettle: boolean;
  terminalPersistenceFailed: boolean;
};

type OperationTerminalEvent = Extract<
  OperationEvent,
  { readonly type: "operation_cancelled" | "operation_completed" | "operation_failed" }
>;

type DurableOperationTerminalEvent = Extract<
  OperationEventRecord["event"],
  {
    readonly type:
      | "operation_cancelled"
      | "operation_completed"
      | "operation_failed"
      | "operation_inspection_required";
  }
>;

export function createOperationHost(options: {
  readonly artifactStore?: ArtifactStore;
  readonly biomeExecution?: BiomeExecutionAdapter;
  readonly defaultDeadlineMs?: number;
  readonly executionDomain: ProjectExecutionDomain;
  readonly originAuthority?: OperationOriginAuthority;
  readonly projectRoot: string;
  readonly permissions?: PermissionPolicy;
  readonly recordStore?: ExtensionRecordStore;
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
  const recoveryInFlight = new Map<string, Promise<OperationSnapshot>>();

  function notifyOperationListeners(operationId: string): void {
    for (const listener of listeners.get(operationId) ?? []) {
      listener();
    }
  }

  async function appendAndPublish(record: OperationEventRecord): Promise<void> {
    try {
      await store.append(record);
    } catch (error) {
      notifyOperationListeners(record.operationId);
      if (error instanceof OperationStoreError && error.code === "operation_idempotency_conflict") {
        throw error;
      }
      throw new OperationHostError("operation_persistence_failed", { cause: error });
    }
    notifyOperationListeners(record.operationId);
  }

  async function startOperation(
    startOptions: Omit<OperationStartOptions, "input">,
    origin: OperationOrigin | undefined,
    inputSource:
      | { readonly kind: "static"; readonly value: unknown }
      | { readonly kind: "materialized"; materialize(): Promise<unknown> },
  ): Promise<OperationReference> {
    const registered = options.resolveOperation(startOptions.contributionId);
    if (registered === undefined) {
      throw new OperationHostError("operation_contribution_unavailable");
    }
    return enqueueExtensionAdmission(extensionAdmissionQueues, registered.extensionId, async () => {
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
      let normalizedInput =
        inputSource.kind === "static" ? normalizeOperationInput(inputSource.value) : undefined;
      let decodedInput: unknown;
      let inputDecoded = false;
      projectIdPromise ??= createProjectId(options.projectRoot);
      const projectId = await projectIdPromise;
      if (origin !== undefined) {
        let validBoundary = false;
        try {
          validBoundary =
            (await options.originAuthority?.validateBoundary({ origin, projectId })) === true;
        } catch (error) {
          throw new OperationHostError("operation_origin_invalid", { cause: error });
        }
        if (!validBoundary) {
          throw new OperationHostError("operation_origin_invalid");
        }
      }
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
      const existingReference =
        normalizedInput === undefined
          ? resolveMaterializedIdempotentOperation(existing, {
              definitionDigest: registered.definitionDigest,
              origin,
            })
          : resolveIdempotentOperation(existing, {
              definitionDigest: registered.definitionDigest,
              inputDigest: normalizedInput.digest,
              origin,
            });
      if (existingReference !== undefined) {
        return existingReference;
      }
      if (normalizedInput !== undefined) {
        decodedInput = decodeInput(registered.registration, normalizedInput.value);
        inputDecoded = true;
      }
      const operationId = randomUUID();
      const executionClaim = await options.executionDomain
        .claimRoot({ rootId: projectRuntimeRootId })
        .catch((error: unknown) => {
          if (error instanceof ProjectExecutionDomainError) {
            throw new OperationHostError(operationOwnerErrorCode(error), { cause: error });
          }
          throw error;
        });
      let executionClaimTransferred = false;
      try {
        const raced = await store.findByIdempotency(scope);
        const racedReference =
          normalizedInput === undefined
            ? resolveMaterializedIdempotentOperation(raced, {
                definitionDigest: registered.definitionDigest,
                origin,
              })
            : resolveIdempotentOperation(raced, {
                definitionDigest: registered.definitionDigest,
                inputDigest: normalizedInput.digest,
                origin,
              });
        if (racedReference !== undefined) {
          return racedReference;
        }
        if (inputSource.kind === "materialized") {
          normalizedInput = normalizeOperationInput(await inputSource.materialize());
          decodedInput = decodeInput(registered.registration, normalizedInput.value);
          inputDecoded = true;
        }
        if (normalizedInput === undefined || !inputDecoded) {
          throw new OperationHostError("operation_input_invalid");
        }
        const now = Date.now();
        const recordedAt = new Date(now).toISOString();
        const deadlineAt = new Date(now + deadlineMs).toISOString();
        const startedEvent: OperationStartedEvent = {
          type: "operation_started",
          contributionId: registered.contributionId,
          deadlineAt,
          definitionDigest: registered.definitionDigest,
          extensionId: registered.extensionId,
          extensionVersion: registered.extensionVersion,
          idempotencyKey: scope.idempotencyKey,
          input: normalizedInput.value,
          inputDigest: normalizedInput.digest,
          projectId,
        };
        const startedRecord: OperationEventRecord =
          origin === undefined
            ? {
                schemaVersion: 2,
                operationId,
                sequence: 1,
                recordedAt,
                event: startedEvent,
              }
            : {
                schemaVersion: 3,
                operationId,
                sequence: 1,
                recordedAt,
                origin,
                event: startedEvent,
              };
        try {
          await appendAndPublish(startedRecord);
        } catch (error) {
          if (
            error instanceof OperationStoreError &&
            error.code === "operation_idempotency_conflict"
          ) {
            const raced = await store.findByIdempotency(scope);
            const racedReference = resolveIdempotentOperation(raced, {
              definitionDigest: registered.definitionDigest,
              inputDigest: normalizedInput.digest,
              origin,
            });
            if (racedReference !== undefined) {
              return racedReference;
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
        let signalOwnerSettled = () => {};
        const ownerSettled = new Promise<void>((resolve) => {
          signalOwnerSettled = resolve;
        });
        const active: ActiveOperation = {
          abortController: new AbortController(),
          artifactBytes: 0,
          artifacts: [],
          artifactCount: 0,
          capabilityCalls: 0,
          appendQueue: Promise.resolve(),
          deadlineAt,
          handlerDidSettle: false,
          handlerSettled,
          inputBytes: normalizedInput.byteLength,
          nextSequence: 2,
          operationId,
          ownerDidSettle: false,
          ownerSettled,
          projectId,
          progressBytes: 0,
          progressRecords: 0,
          recordBytes: 0,
          recordCreates: 0,
          registered,
          settled,
          signalHandlerSettled,
          signalOwnerSettled,
          signalSettled,
          settling: false,
          terminalDidSettle: false,
          terminalPersistenceFailed: false,
        };
        activeOperations.set(operationId, active);
        executionClaimTransferred = true;
        queueMicrotask(() => {
          void executeOperation(
            active,
            decodedInput,
            appendAndPublish,
            activeOperations,
            options.artifactStore,
            options.biomeExecution,
            options.permissions,
            options.recordStore,
          )
            .catch(() => undefined)
            .finally(async () => {
              await executionClaim.release();
              active.ownerDidSettle = true;
              active.signalOwnerSettled();
              releaseActiveOperation(active, activeOperations);
            });
        });
        return { operationId };
      } finally {
        if (!executionClaimTransferred) {
          await executionClaim.release();
        }
      }
    });
  }

  const host: OperationHostControl = {
    start(startOptions) {
      const { input, ...ordinaryOptions } = startOptions;
      return startOperation(ordinaryOptions, undefined, { kind: "static", value: input });
    },

    async startLinked(startOptions) {
      const origin = validateOperationOrigin(startOptions.origin);
      const { input, origin: _origin, ...ordinaryOptions } = startOptions;
      return startOperation(ordinaryOptions, origin, { kind: "static", value: input });
    },

    async startLinkedMaterialized(startOptions) {
      const origin = validateOperationOrigin(startOptions.origin);
      const { materialize, origin: _origin, ...ordinaryOptions } = startOptions;
      return startOperation(ordinaryOptions, origin, { kind: "materialized", materialize });
    },

    async listLinked(listOptions) {
      const normalized = validateLinkedOperationListOptions(listOptions);
      let starts: readonly OperationEventRecord[];
      try {
        starts = await store.listLinkedStarts({
          ...(normalized.cursor === undefined ? {} : { afterOperationId: normalized.cursor }),
          limit: normalized.limit + 1,
          sessionId: normalized.sessionId,
          throughSequence: normalized.throughSequence,
        });
      } catch (error) {
        if (error instanceof OperationStoreError && error.code === "operation_query_invalid") {
          throw new OperationHostError("operation_list_invalid", { cause: error });
        }
        throw new OperationHostError("operation_persistence_failed", { cause: error });
      }
      const pageStarts = starts.slice(0, normalized.limit);
      return {
        items: pageStarts.map((record) => ({ operationId: record.operationId })),
        nextCursor:
          starts.length > normalized.limit ? (pageStarts.at(-1)?.operationId ?? null) : null,
      };
    },

    async query(operationId) {
      const records = await store.read(operationId);
      if (records.length === 0) {
        throw new OperationHostError("operation_not_found");
      }
      const active = activeOperations.get(operationId);
      return createSnapshot(
        records,
        active !== undefined && !active.terminalPersistenceFailed,
        options.resolveOperation,
      );
    },

    async recover(operationId) {
      const currentRecovery = recoveryInFlight.get(operationId);
      if (currentRecovery !== undefined) {
        return currentRecovery;
      }
      const recovery = options.executionDomain
        .runRoot({ rootId: projectRuntimeRootId }, async () => {
          const records = await store.read(operationId);
          if (records.length === 0) {
            throw new OperationHostError("operation_not_found");
          }
          const existing = createSnapshot(
            records,
            isDurablyActive(activeOperations.get(operationId)),
            options.resolveOperation,
          );
          if (existing.status !== "recovery_required") {
            return existing;
          }
          const started = records[0];
          if (started?.event.type !== "operation_started") {
            throw new OperationHostError("operation_persistence_failed");
          }
          projectIdPromise ??= createProjectId(options.projectRoot);
          const projectId = await projectIdPromise;
          if (
            started.event.projectId !== projectId ||
            (store.projectId !== undefined && store.projectId !== projectId)
          ) {
            throw new OperationHostError("operation_store_project_mismatch");
          }
          if (started.schemaVersion === 1) {
            await appendAndPublish({
              schemaVersion: 2,
              operationId,
              sequence: records.length + 1,
              recordedAt: new Date().toISOString(),
              event: {
                type: "operation_inspection_required",
                message: "Legacy operation identity cannot be reconciled safely.",
              },
            });
            return host.query(operationId);
          }
          const registered = options.resolveOperation(started.event.contributionId);
          if (
            registered === undefined ||
            registered.extensionId !== started.event.extensionId ||
            registered.extensionVersion !== started.event.extensionVersion ||
            registered.definitionDigest !== started.event.definitionDigest ||
            typeof registered.registration.reconcile !== "function"
          ) {
            throw new OperationHostError("operation_contribution_unavailable");
          }
          const decodedInput = decodeInput(registered.registration, started.event.input);
          const attemptNumber =
            records.filter((record) => record.event.type === "operation_reconciliation_started")
              .length + 1;
          const attemptRecord: OperationEventRecord = {
            schemaVersion: 2,
            operationId,
            sequence: records.length + 1,
            recordedAt: new Date().toISOString(),
            event: {
              type: "operation_reconciliation_started",
              attemptId: randomUUID(),
              attemptNumber,
              definitionDigest: registered.definitionDigest,
            },
          };
          await appendAndPublish(attemptRecord);
          const result = await reconcileOperation({
            artifactStore: options.artifactStore,
            configuredDeadlineMs,
            decodedInput,
            operationId,
            operationRecords: records,
            projectId,
            recordStore: options.recordStore,
            registered,
          });
          let terminal: Awaited<ReturnType<typeof createReconciliationTerminal>>;
          try {
            terminal = await createReconciliationTerminal(result, {
              artifactStore: options.artifactStore,
              operationId,
              operationRecords: records,
              projectId,
              recordStore: options.recordStore,
              registered,
            });
          } catch (error) {
            if (error instanceof OperationHostError) {
              throw error;
            }
            throw new OperationHostError("operation_input_invalid", { cause: error });
          }
          try {
            await appendAndPublish({
              schemaVersion: 2,
              operationId,
              sequence: attemptRecord.sequence + 1,
              recordedAt: new Date().toISOString(),
              event: terminal,
            });
          } catch {
            const durableRecords = await store.read(operationId);
            return createSnapshot(durableRecords, false, options.resolveOperation);
          }
          return host.query(operationId);
        })
        .catch((error: unknown) => {
          if (error instanceof ProjectExecutionDomainError) {
            throw new OperationHostError(operationOwnerErrorCode(error), { cause: error });
          }
          throw error;
        });
      recoveryInFlight.set(operationId, recovery);
      void recovery.then(
        () => recoveryInFlight.delete(operationId),
        () => recoveryInFlight.delete(operationId),
      );
      return recovery;
    },

    events({ afterSequence = 0, operationId, signal }) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new TypeError("The event sequence cursor must be a non-negative integer.");
      }
      return streamEvents(operationId, afterSequence, store, activeOperations, listeners, signal);
    },

    async cancel(operationId) {
      const snapshot = await host.query(operationId);
      if (
        snapshot.status === "completed" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled" ||
        snapshot.status === "inspection_required"
      ) {
        return snapshot;
      }
      const active = activeOperations.get(operationId);
      if (active === undefined) {
        return options.executionDomain
          .runRoot({ rootId: projectRuntimeRootId }, async () => {
            const records = await store.read(operationId);
            const current = createSnapshot(records, false, options.resolveOperation);
            if (
              current.status === "completed" ||
              current.status === "failed" ||
              current.status === "cancelled" ||
              current.status === "inspection_required"
            ) {
              return current;
            }
            if (!records.some((record) => record.event.type === "operation_cancel_requested")) {
              await appendAndPublish({
                schemaVersion: 2,
                operationId,
                sequence: records.length + 1,
                recordedAt: new Date().toISOString(),
                event: { type: "operation_cancel_requested", reason: "caller" },
              });
            }
            return host.query(operationId);
          })
          .catch((error: unknown) => {
            if (error instanceof ProjectExecutionDomainError) {
              throw new OperationHostError(operationOwnerErrorCode(error), { cause: error });
            }
            throw error;
          });
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

function createOperationCapabilities(
  active: ActiveOperation,
  artifactStore: ArtifactStore | undefined,
  biomeExecution: BiomeExecutionAdapter | undefined,
  permissions: PermissionPolicy | undefined,
  recordStore: ExtensionRecordStore | undefined,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
): ExtensionOperationCapabilities {
  const artifactCapability =
    artifactStore !== undefined &&
    active.registered.capabilityIds.includes(EXTENSION_ARTIFACT_CAPABILITY_ID)
      ? createArtifactCapability(active, artifactStore, appendAndPublish)
      : undefined;
  const recordCapability =
    recordStore !== undefined &&
    active.registered.capabilityIds.includes(EXTENSION_RECORDS_CAPABILITY_ID)
      ? createRecordCapability(active, recordStore)
      : undefined;
  const biomeCapability =
    biomeExecution !== undefined &&
    permissions !== undefined &&
    active.registered.capabilityIds.includes(EXTENSION_BIOME_CAPABILITY_ID)
      ? createBiomeCapability(active, biomeExecution, permissions)
      : undefined;
  return Object.freeze({
    ...(biomeCapability === undefined ? {} : { [EXTENSION_BIOME_CAPABILITY_ID]: biomeCapability }),
    ...(artifactCapability === undefined
      ? {}
      : { [EXTENSION_ARTIFACT_CAPABILITY_ID]: artifactCapability }),
    ...(recordCapability === undefined
      ? {}
      : { [EXTENSION_RECORDS_CAPABILITY_ID]: recordCapability }),
  });
}

function createArtifactCapability(
  active: ActiveOperation,
  artifactStore: ArtifactStore,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
) {
  return Object.freeze({
    async publish(input: {
      readonly bytes: Uint8Array;
      readonly contract: { readonly id: string; readonly version: number };
      readonly mediaType: string;
    }): Promise<ExtensionArtifactSummary> {
      if (active.settling || active.abortController.signal.aborted) {
        throw new Error("The operation no longer accepts capability calls.");
      }
      if (typeof input !== "object" || input === null) {
        rejectInvalidCapabilityInput(active);
      }
      if (
        input.bytes instanceof Uint8Array &&
        input.bytes.byteLength > EXTENSION_ARTIFACT_MAX_BYTES
      ) {
        markArtifactLimitExceeded(active);
        throw new OperationCapabilityLimitError();
      }
      if (
        !(input.bytes instanceof Uint8Array) ||
        typeof input.mediaType !== "string" ||
        input.mediaType.length === 0 ||
        input.mediaType.length > 256 ||
        typeof input.contract?.id !== "string" ||
        input.contract.id.length === 0 ||
        input.contract.id.length > 256 ||
        !Number.isSafeInteger(input.contract.version) ||
        input.contract.version <= 0
      ) {
        rejectInvalidCapabilityInput(active);
      }
      if (
        active.artifactCount + 1 > EXTENSION_ARTIFACT_MAX_COUNT ||
        active.artifactBytes + input.bytes.byteLength > EXTENSION_ARTIFACT_MAX_AGGREGATE_BYTES
      ) {
        markArtifactLimitExceeded(active);
        throw new OperationCapabilityLimitError();
      }
      active.artifactBytes += input.bytes.byteLength;
      active.artifactCount += 1;
      const contract = Object.freeze({ ...input.contract });
      const provenance = createCapabilityProvenance(active);
      let artifact: {
        readonly byteCount: number;
        readonly id: string;
        readonly mediaType: string;
      };
      try {
        artifact = await artifactStore.write({
          bytes: Buffer.from(input.bytes),
          mediaType: input.mediaType,
          source: {
            type: "extension_operation",
            contract,
            ...provenance,
          },
        });
      } catch {
        markArtifactPersistenceFailed(active);
        throw new OperationCapabilityPersistenceError();
      }
      const summary = Object.freeze({
        byteCount: artifact.byteCount,
        contract,
        id: artifact.id,
        mediaType: artifact.mediaType,
        provenance,
      });
      const append = active.appendQueue.then(async () => {
        await appendAndPublish({
          schemaVersion: 2,
          operationId: active.operationId,
          sequence: active.nextSequence,
          recordedAt: new Date().toISOString(),
          event: { type: "operation_artifact_published", artifact: summary },
        });
        active.nextSequence += 1;
      });
      active.appendQueue = append.catch(() => undefined);
      try {
        await append;
      } catch {
        markArtifactPersistenceFailed(active);
        throw new OperationCapabilityPersistenceError();
      }
      active.artifacts.push(summary);
      assertCapabilityActive(active);
      return summary;
    },
  });
}

function assertCapabilityActive(active: ActiveOperation): void {
  if (active.settling || active.abortController.signal.aborted) {
    throw new Error("The operation no longer accepts capability calls.");
  }
}

function assertContractReference(value: { readonly id: string; readonly version: number }): void {
  if (
    typeof value?.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    !Number.isSafeInteger(value.version) ||
    value.version <= 0
  ) {
    throw new TypeError("The capability contract reference is invalid.");
  }
}

function assertRecordKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment))
  ) {
    throw new TypeError("The extension record key is invalid.");
  }
}

function assertRecordPrefix(value: string): void {
  if (typeof value !== "string" || value.length > 512 || value.startsWith("/")) {
    throw new TypeError("The extension record prefix is invalid.");
  }
  if (value.length > 0) {
    assertRecordKey(value.endsWith("/") ? value.slice(0, -1) : value);
  }
}

function createCapabilityProvenance(active: ActiveOperation) {
  return Object.freeze({
    contributionId: active.registered.contributionId,
    extensionId: active.registered.extensionId,
    extensionVersion: active.registered.extensionVersion,
    operationId: active.operationId,
    projectId: active.projectId,
  });
}

function toRecordSummary(record: ExtensionRecord): ExtensionRecordSummary {
  return {
    byteCount: record.byteCount,
    contract: record.contract,
    digest: record.digest,
    key: record.key,
    provenance: record.provenance,
  };
}

function createBiomeCapability(
  active: ActiveOperation,
  execution: BiomeExecutionAdapter,
  permissions: PermissionPolicy,
) {
  return Object.freeze({
    async analyze(input: {
      readonly files: readonly ExtensionBiomeFileSnapshot[];
      readonly profile: typeof EXTENSION_BIOME_PROFILE;
    }): Promise<ExtensionBiomeAnalysis> {
      assertCapabilityActive(active);
      let files: readonly ExtensionBiomeFileSnapshot[];
      try {
        files = normalizeBiomeFiles(input);
      } catch (error) {
        if (error instanceof OperationCapabilityLimitError) {
          markBiomeLimitExceeded(active);
          throw error;
        }
        rejectInvalidCapabilityInput(active);
      }
      let permissionDecision: ReturnType<PermissionPolicy["decide"]> = "deny";
      active.capabilityCalls += 1;
      try {
        permissionDecision = permissions.decide({
          callId: `${active.operationId}:biome:${active.capabilityCalls}`,
          effect: "execute",
          name: EXTENSION_BIOME_CAPABILITY_ID,
          scope: "call",
          subject: {
            capabilityId: EXTENSION_BIOME_CAPABILITY_ID,
            contributionId: active.registered.contributionId,
            extensionId: active.registered.extensionId,
            extensionVersion: active.registered.extensionVersion,
            operationId: active.operationId,
            type: "extension_capability",
          },
        });
      } catch {
        permissionDecision = "deny";
      }
      if (permissionDecision !== "allow") {
        markBiomePermissionDenied(active);
        throw new OperationCapabilityPermissionDeniedError();
      }
      let output: BiomeExecutionOutput;
      try {
        output = await execution.execute(
          Object.freeze({
            deadlineAt: active.deadlineAt,
            files,
            profile: EXTENSION_BIOME_PROFILE,
            signal: active.abortController.signal,
          }),
        );
      } catch {
        if (active.cancelReason !== undefined || active.abortController.signal.aborted) {
          throw new Error("The Biome execution was cancelled.");
        }
        markBiomeExecutionFailed(active);
        throw new OperationCapabilityExecutionError();
      }
      if (active.settling || active.abortController.signal.aborted) {
        throw new Error("The operation no longer accepts capability results.");
      }
      let report: ExtensionJsonValue;
      try {
        if (
          typeof output.analyzerVersion !== "string" ||
          output.analyzerVersion.length === 0 ||
          output.analyzerVersion.length > 128 ||
          !Number.isSafeInteger(output.exitCode) ||
          output.exitCode < 0 ||
          output.exitCode > 255 ||
          !(output.report instanceof Uint8Array) ||
          output.report.byteLength > EXTENSION_BIOME_MAX_REPORT_BYTES ||
          !(output.stdout instanceof Uint8Array) ||
          output.stdout.byteLength > EXTENSION_BIOME_MAX_STDOUT_BYTES ||
          !(output.stderr instanceof Uint8Array) ||
          output.stderr.byteLength > EXTENSION_BIOME_MAX_STDERR_BYTES
        ) {
          throw new TypeError("The Biome execution output is invalid.");
        }
        const reportJson = new TextDecoder("utf-8", { fatal: true }).decode(output.report);
        report = normalizeJson(JSON.parse(reportJson), EXTENSION_BIOME_MAX_REPORT_BYTES).value;
      } catch {
        markBiomeOutputInvalid(active);
        throw new OperationCapabilityOutputError();
      }
      return Object.freeze({
        execution: Object.freeze({
          analyzer: "biome" as const,
          analyzerVersion: output.analyzerVersion,
          exitCode: output.exitCode,
          profile: EXTENSION_BIOME_PROFILE,
          provenance: createCapabilityProvenance(active),
        }),
        report,
      });
    },
  });
}

function normalizeBiomeFiles(input: {
  readonly files: readonly ExtensionBiomeFileSnapshot[];
  readonly profile: typeof EXTENSION_BIOME_PROFILE;
}): readonly ExtensionBiomeFileSnapshot[] {
  if (
    input?.profile !== EXTENSION_BIOME_PROFILE ||
    !Array.isArray(input.files) ||
    input.files.length === 0 ||
    input.files.length > EXTENSION_BIOME_MAX_FILES
  ) {
    throw new TypeError("The Biome snapshot input is invalid.");
  }
  let aggregateBytes = 0;
  const paths = new Set<string>();
  const files = input.files.map((file) => {
    assertRecordKey(file.path);
    if (paths.has(file.path) || typeof file.content !== "string" || !file.content.isWellFormed()) {
      throw new TypeError("The Biome snapshot input is invalid.");
    }
    paths.add(file.path);
    const byteLength = Buffer.byteLength(file.content, "utf8");
    if (byteLength > EXTENSION_BIOME_MAX_FILE_BYTES) {
      throw new OperationCapabilityLimitError();
    }
    aggregateBytes += byteLength;
    if (aggregateBytes > EXTENSION_BIOME_MAX_SNAPSHOT_BYTES) {
      throw new OperationCapabilityLimitError();
    }
    return Object.freeze({ content: file.content, path: file.path });
  });
  return Object.freeze(files);
}

function createRecordCapability(active: ActiveOperation, recordStore: ExtensionRecordStore) {
  const namespace = Object.freeze({
    extensionId: active.registered.extensionId,
    extensionVersion: active.registered.extensionVersion,
    projectId: active.projectId,
  });
  return Object.freeze({
    async create(input: {
      readonly contract: { readonly id: string; readonly version: number };
      readonly key: string;
      readonly value: ExtensionJsonValue;
    }): Promise<ExtensionRecordSummary> {
      assertCapabilityActive(active);
      try {
        assertRecordKey(input.key);
        assertContractReference(input.contract);
      } catch {
        rejectInvalidCapabilityInput(active);
      }
      let normalized: ReturnType<typeof normalizeJson>;
      try {
        normalized = normalizeJson(input.value, EXTENSION_RECORD_MAX_BYTES);
      } catch (error) {
        if (error instanceof OperationHostError && error.code === "operation_input_too_large") {
          markRecordLimitExceeded(active);
          throw new OperationCapabilityLimitError();
        }
        rejectInvalidCapabilityInput(active);
      }
      if (
        active.recordCreates + 1 > EXTENSION_RECORD_MAX_CREATES ||
        active.recordBytes + normalized.byteLength > EXTENSION_RECORD_MAX_AGGREGATE_BYTES
      ) {
        markRecordLimitExceeded(active);
        throw new OperationCapabilityLimitError();
      }
      active.recordCreates += 1;
      active.recordBytes += normalized.byteLength;
      const record: ExtensionRecord = {
        byteCount: normalized.byteLength,
        contract: Object.freeze({ ...input.contract }),
        digest: normalized.digest,
        key: input.key,
        provenance: createCapabilityProvenance(active),
        value: normalized.value,
      };
      try {
        await recordStore.create(record);
      } catch (error) {
        if (error instanceof ExtensionRecordStoreError && error.code === "record_already_exists") {
          markRecordConflict(active);
          throw new OperationCapabilityConflictError();
        }
        markRecordPersistenceFailed(active);
        throw new OperationCapabilityPersistenceError();
      }
      assertCapabilityActive(active);
      return Object.freeze(toRecordSummary(record));
    },
    async get(key: string): Promise<ExtensionRecord | undefined> {
      assertCapabilityActive(active);
      try {
        assertRecordKey(key);
      } catch {
        rejectInvalidCapabilityInput(active);
      }
      let record: ExtensionRecord | undefined;
      try {
        record = await recordStore.get(namespace, key);
      } catch {
        markRecordPersistenceFailed(active);
        throw new OperationCapabilityPersistenceError();
      }
      assertCapabilityActive(active);
      return record === undefined ? undefined : Object.freeze(record);
    },
    async list(input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly prefix: string;
    }): Promise<ExtensionRecordList> {
      assertCapabilityActive(active);
      try {
        assertRecordPrefix(input.prefix);
        if (input.cursor !== undefined) {
          assertRecordKey(input.cursor);
          if (!input.cursor.startsWith(input.prefix)) {
            throw new TypeError("The extension record cursor is outside the requested prefix.");
          }
        }
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
          throw new TypeError("The extension record list limit is invalid.");
        }
      } catch {
        rejectInvalidCapabilityInput(active);
      }
      const limit = input.limit ?? 100;
      let result: ExtensionRecordList;
      try {
        result = await recordStore.list(namespace, {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit,
          prefix: input.prefix,
        });
      } catch {
        markRecordPersistenceFailed(active);
        throw new OperationCapabilityPersistenceError();
      }
      assertCapabilityActive(active);
      return Object.freeze({
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        records: Object.freeze(result.records.map((record) => Object.freeze(record))),
      });
    },
  });
}

async function reconcileOperation(options: {
  readonly artifactStore: ArtifactStore | undefined;
  readonly configuredDeadlineMs: number;
  readonly decodedInput: unknown;
  readonly operationId: string;
  readonly operationRecords: readonly OperationEventRecord[];
  readonly projectId: string;
  readonly recordStore: ExtensionRecordStore | undefined;
  readonly registered: RegisteredOperation;
}): Promise<ExtensionOperationReconciliationResult> {
  const reconcile = options.registered.registration.reconcile;
  if (reconcile === undefined) {
    throw new OperationHostError("operation_contribution_unavailable");
  }
  const abortController = new AbortController();
  const deadlineAt = new Date(Date.now() + options.configuredDeadlineMs).toISOString();
  let rejectDeadline = (_error: OperationHostError) => {};
  const deadlineExceeded = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const deadline = setTimeout(() => {
    const error = new OperationHostError("operation_reconciliation_failed");
    abortController.abort(error);
    rejectDeadline(error);
  }, options.configuredDeadlineMs);
  deadline.unref();
  const provenance = Object.freeze({
    contributionId: options.registered.contributionId,
    extensionId: options.registered.extensionId,
    extensionVersion: options.registered.extensionVersion,
    projectId: options.projectId,
  });
  const context: ExtensionOperationReconciliationContext = Object.freeze({
    deadlineAt,
    evidence: Object.freeze({
      artifacts: Object.freeze({
        async read(artifact: ExtensionArtifactSummary): Promise<Uint8Array | undefined> {
          if (abortController.signal.aborted) {
            throw new Error("The operation reconciliation no longer accepts evidence reads.");
          }
          await assertRecoveryArtifact(artifact, {
            artifactStore: options.artifactStore,
            operationId: options.operationId,
            operationRecords: options.operationRecords,
            provenance,
          });
          const bytes = await options.artifactStore?.read(artifact.id);
          return bytes === undefined ? undefined : Uint8Array.from(bytes);
        },
      }),
      records: Object.freeze({
        async get(key: string): Promise<ExtensionRecord | undefined> {
          if (abortController.signal.aborted) {
            throw new Error("The operation reconciliation no longer accepts evidence reads.");
          }
          assertRecordKey(key);
          const record = await options.recordStore?.get(
            {
              extensionId: options.registered.extensionId,
              extensionVersion: options.registered.extensionVersion,
              projectId: options.projectId,
            },
            key,
          );
          if (record === undefined) {
            return undefined;
          }
          if (!provenanceMatchesOperation(record.provenance, options.operationId, provenance)) {
            throw new OperationHostError("operation_input_invalid");
          }
          return Object.freeze(record);
        },
      }),
    }),
    operationId: options.operationId,
    provenance,
    signal: abortController.signal,
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => reconcile(options.decodedInput, context)),
      deadlineExceeded,
    ]);
  } catch (error) {
    if (error instanceof OperationHostError && error.code === "operation_reconciliation_failed") {
      throw error;
    }
    throw new OperationHostError("operation_reconciliation_failed", { cause: error });
  } finally {
    clearTimeout(deadline);
  }
}

async function createReconciliationTerminal(
  result: ExtensionOperationReconciliationResult,
  options: {
    readonly artifactStore: ArtifactStore | undefined;
    readonly operationId: string;
    readonly operationRecords: readonly OperationEventRecord[];
    readonly projectId: string;
    readonly recordStore: ExtensionRecordStore | undefined;
    readonly registered: RegisteredOperation;
  },
): Promise<
  OperationTerminalEvent | Extract<OperationEvent, { type: "operation_inspection_required" }>
> {
  if (!isPlainRecord(result) || typeof result.status !== "string") {
    throw new OperationHostError("operation_input_invalid");
  }
  if (result.status === "completed") {
    const artifacts = await validateRecoveryArtifacts(result.artifacts, options);
    return {
      type: "operation_completed",
      ...(artifacts === undefined ? {} : { artifacts }),
      output: encodeOutput(options.registered.registration, result.output),
    };
  }
  if (result.status === "failed") {
    const artifacts = await validateRecoveryArtifacts(result.artifacts, options);
    return {
      type: "operation_failed",
      ...(artifacts === undefined ? {} : { artifacts }),
      error: result.error,
    };
  }
  if (result.status === "inspection_required") {
    if (
      typeof result.message !== "string" ||
      result.message.length === 0 ||
      result.message.length > 512
    ) {
      throw new OperationHostError("operation_input_invalid");
    }
    const evidence = await validateInspectionEvidence(result.evidence, options);
    return {
      type: "operation_inspection_required",
      ...(evidence === undefined ? {} : { evidence }),
      message: result.message,
    };
  }
  throw new OperationHostError("operation_input_invalid");
}

async function validateInspectionEvidence(
  evidence: readonly ExtensionOperationEvidenceReference[] | undefined,
  options: {
    readonly artifactStore: ArtifactStore | undefined;
    readonly operationId: string;
    readonly operationRecords: readonly OperationEventRecord[];
    readonly projectId: string;
    readonly recordStore: ExtensionRecordStore | undefined;
    readonly registered: RegisteredOperation;
  },
): Promise<readonly ExtensionOperationEvidenceReference[] | undefined> {
  if (evidence === undefined) {
    return undefined;
  }
  if (evidence.length > 16) {
    throw new OperationHostError("operation_input_invalid");
  }
  const provenance = {
    contributionId: options.registered.contributionId,
    extensionId: options.registered.extensionId,
    extensionVersion: options.registered.extensionVersion,
    projectId: options.projectId,
  };
  for (const reference of evidence) {
    if (reference.type === "artifact") {
      await assertRecoveryArtifact(reference.artifact, {
        artifactStore: options.artifactStore,
        operationId: options.operationId,
        operationRecords: options.operationRecords,
        provenance,
      });
      continue;
    }
    if (reference.type !== "record") {
      throw new OperationHostError("operation_input_invalid");
    }
    await assertRecoveryRecord(reference.record, {
      operationId: options.operationId,
      provenance,
      recordStore: options.recordStore,
    });
  }
  return Object.freeze(evidence.map((reference) => Object.freeze(reference)));
}

async function assertRecoveryRecord(
  summary: ExtensionRecordSummary,
  options: {
    readonly operationId: string;
    readonly provenance: {
      readonly contributionId: string;
      readonly extensionId: string;
      readonly extensionVersion: string;
      readonly projectId: string;
    };
    readonly recordStore: ExtensionRecordStore | undefined;
  },
): Promise<void> {
  if (
    !isPlainRecord(summary) ||
    !Number.isSafeInteger(summary.byteCount) ||
    summary.byteCount < 0 ||
    summary.byteCount > EXTENSION_RECORD_MAX_BYTES ||
    typeof summary.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(summary.digest) ||
    typeof summary.key !== "string" ||
    !isPlainRecord(summary.contract) ||
    typeof summary.contract.id !== "string" ||
    summary.contract.id.length === 0 ||
    summary.contract.id.length > 256 ||
    !Number.isSafeInteger(summary.contract.version) ||
    summary.contract.version <= 0 ||
    !provenanceMatchesOperation(summary.provenance, options.operationId, options.provenance)
  ) {
    throw new OperationHostError("operation_input_invalid");
  }
  assertRecordKey(summary.key);
  const record = await options.recordStore?.get(
    {
      extensionId: options.provenance.extensionId,
      extensionVersion: options.provenance.extensionVersion,
      projectId: options.provenance.projectId,
    },
    summary.key,
  );
  if (
    record === undefined ||
    record.byteCount !== summary.byteCount ||
    record.digest !== summary.digest ||
    record.contract.id !== summary.contract.id ||
    record.contract.version !== summary.contract.version ||
    !provenanceMatchesOperation(record.provenance, options.operationId, options.provenance)
  ) {
    throw new OperationHostError("operation_input_invalid");
  }
}

async function validateRecoveryArtifacts(
  artifacts: readonly ExtensionArtifactSummary[] | undefined,
  options: {
    readonly artifactStore: ArtifactStore | undefined;
    readonly operationId: string;
    readonly operationRecords: readonly OperationEventRecord[];
    readonly projectId: string;
    readonly registered: RegisteredOperation;
  },
): Promise<readonly ExtensionArtifactSummary[] | undefined> {
  if (artifacts === undefined) {
    return undefined;
  }
  if (artifacts.length === 0 || artifacts.length > EXTENSION_ARTIFACT_MAX_COUNT) {
    throw new OperationHostError("operation_input_invalid");
  }
  const provenance = {
    contributionId: options.registered.contributionId,
    extensionId: options.registered.extensionId,
    extensionVersion: options.registered.extensionVersion,
    projectId: options.projectId,
  };
  let aggregateBytes = 0;
  for (const artifact of artifacts) {
    await assertRecoveryArtifact(artifact, {
      artifactStore: options.artifactStore,
      operationId: options.operationId,
      operationRecords: options.operationRecords,
      provenance,
    });
    aggregateBytes += artifact.byteCount;
    if (aggregateBytes > EXTENSION_ARTIFACT_MAX_AGGREGATE_BYTES) {
      throw new OperationHostError("operation_input_too_large");
    }
  }
  return Object.freeze(artifacts.map((artifact) => Object.freeze(artifact)));
}

async function assertRecoveryArtifact(
  artifact: ExtensionArtifactSummary,
  options: {
    readonly artifactStore: ArtifactStore | undefined;
    readonly operationId: string;
    readonly operationRecords: readonly OperationEventRecord[];
    readonly provenance: {
      readonly contributionId: string;
      readonly extensionId: string;
      readonly extensionVersion: string;
      readonly projectId: string;
    };
  },
): Promise<void> {
  if (
    !isPlainRecord(artifact) ||
    typeof artifact.id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.id) ||
    typeof artifact.mediaType !== "string" ||
    artifact.mediaType.length === 0 ||
    artifact.mediaType.length > 256 ||
    !Number.isSafeInteger(artifact.byteCount) ||
    artifact.byteCount < 0 ||
    artifact.byteCount > EXTENSION_ARTIFACT_MAX_BYTES ||
    !isPlainRecord(artifact.contract) ||
    typeof artifact.contract.id !== "string" ||
    artifact.contract.id.length === 0 ||
    artifact.contract.id.length > 256 ||
    !Number.isSafeInteger(artifact.contract.version) ||
    artifact.contract.version <= 0 ||
    !provenanceMatchesOperation(artifact.provenance, options.operationId, options.provenance)
  ) {
    throw new OperationHostError("operation_input_invalid");
  }
  if (
    !options.operationRecords.some(
      (record) =>
        record.event.type === "operation_artifact_published" &&
        artifactSummariesEqual(record.event.artifact, artifact),
    )
  ) {
    throw new OperationHostError("operation_input_invalid");
  }
  const bytes = await options.artifactStore?.read(artifact.id);
  if (bytes === undefined || bytes.byteLength !== artifact.byteCount) {
    throw new OperationHostError("operation_input_invalid");
  }
}

function artifactSummariesEqual(
  left: ExtensionArtifactSummary,
  right: ExtensionArtifactSummary,
): boolean {
  return (
    left.byteCount === right.byteCount &&
    left.contract.id === right.contract.id &&
    left.contract.version === right.contract.version &&
    left.id === right.id &&
    left.mediaType === right.mediaType &&
    left.provenance.contributionId === right.provenance.contributionId &&
    left.provenance.extensionId === right.provenance.extensionId &&
    left.provenance.extensionVersion === right.provenance.extensionVersion &&
    left.provenance.operationId === right.provenance.operationId &&
    left.provenance.projectId === right.provenance.projectId
  );
}

function provenanceMatchesOperation(
  candidate: unknown,
  operationId: string,
  expected: {
    readonly contributionId: string;
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly projectId: string;
  },
): boolean {
  if (!isPlainRecord(candidate)) {
    return false;
  }
  const {
    operationId: candidateOperationId,
    contributionId,
    extensionId,
    extensionVersion,
    projectId,
  } = candidate;
  return (
    candidateOperationId === operationId &&
    contributionId === expected.contributionId &&
    extensionId === expected.extensionId &&
    extensionVersion === expected.extensionVersion &&
    projectId === expected.projectId
  );
}

async function executeOperation(
  active: ActiveOperation,
  input: unknown,
  appendAndPublish: (record: OperationEventRecord) => Promise<void>,
  activeOperations: Map<string, ActiveOperation>,
  artifactStore: ArtifactStore | undefined,
  biomeExecution: BiomeExecutionAdapter | undefined,
  permissions: PermissionPolicy | undefined,
  recordStore: ExtensionRecordStore | undefined,
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
    capabilities: createOperationCapabilities(
      active,
      artifactStore,
      biomeExecution,
      permissions,
      recordStore,
      appendAndPublish,
    ),
    deadlineAt: active.deadlineAt,
    diagnostics: Object.freeze(
      active.registered.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
    operationId: active.operationId,
    provenance: Object.freeze({
      contributionId: active.registered.contributionId,
      extensionId: active.registered.extensionId,
      extensionVersion: active.registered.extensionVersion,
      projectId: active.projectId,
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
          schemaVersion: 2,
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
        const failure = markProgressPersistenceFailed(active);
        await settleFailed(active, failure, appendAndPublish, activeOperations).catch(
          () => undefined,
        );
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
      schemaVersion: 2,
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
  event: OperationTerminalEvent,
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
      schemaVersion: 2,
      operationId: active.operationId,
      sequence: active.nextSequence,
      recordedAt: new Date().toISOString(),
      event: attachPublishedArtifacts(event, active.artifacts),
    });
    active.nextSequence += 1;
  } catch (error) {
    active.terminalPersistenceFailed = true;
    throw error;
  } finally {
    active.terminalDidSettle = true;
    active.signalSettled();
    releaseActiveOperation(active, activeOperations);
  }
}

function attachPublishedArtifacts(
  event: OperationTerminalEvent,
  artifacts: readonly ExtensionArtifactSummary[],
): OperationTerminalEvent {
  if (artifacts.length === 0) {
    return event;
  }
  return {
    ...event,
    artifacts: Object.freeze([...artifacts]),
  };
}

function releaseActiveOperation(
  active: ActiveOperation,
  activeOperations: Map<string, ActiveOperation>,
): void {
  if (active.handlerDidSettle && active.ownerDidSettle && active.terminalDidSettle) {
    activeOperations.delete(active.operationId);
  }
}

class OperationProgressLimitError extends Error {}
class OperationCapabilityConflictError extends Error {}
class OperationCapabilityExecutionError extends Error {}
class OperationCapabilityInputError extends Error {}
class OperationCapabilityLimitError extends Error {}
class OperationCapabilityPermissionDeniedError extends Error {}
class OperationCapabilityPersistenceError extends Error {}
class OperationCapabilityOutputError extends Error {}
class OperationProgressInvalidError extends Error {}
class OperationOutputInvalidError extends Error {}

function markProgressLimitExceeded(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_progress_limit_exceeded",
    message: "The operation exceeded its progress budget.",
  });
}

function markArtifactLimitExceeded(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_limit_exceeded",
    message: "The operation exceeded an artifact capability limit.",
  });
}

function markArtifactPersistenceFailed(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_persistence_failed",
    message: "The operation could not persist an artifact.",
  });
}

function markRecordLimitExceeded(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_limit_exceeded",
    message: "The operation exceeded a record capability limit.",
  });
}

function markRecordConflict(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_conflict",
    message: "The immutable extension record already exists.",
  });
}

function rejectInvalidCapabilityInput(active: ActiveOperation): never {
  forceOperationFailure(active, {
    code: "operation_capability_input_invalid",
    message: "The operation supplied invalid capability input.",
  });
  throw new OperationCapabilityInputError();
}

function markRecordPersistenceFailed(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_persistence_failed",
    message: "The operation could not persist extension records.",
  });
}

function markBiomeLimitExceeded(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_limit_exceeded",
    message: "The operation exceeded a Biome capability limit.",
  });
}

function markBiomePermissionDenied(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_permission_denied",
    message: "The Biome analyzer execution was denied by policy.",
  });
}

function markBiomeExecutionFailed(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_execution_failed",
    message: "The Biome analyzer execution failed.",
  });
}

function markBiomeOutputInvalid(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_capability_output_invalid",
    message: "The Biome analyzer produced invalid bounded output.",
  });
}

function markProgressInvalid(active: ActiveOperation): void {
  forceOperationFailure(active, {
    code: "operation_progress_invalid",
    message: "The extension reported invalid operation progress.",
  });
}

function markProgressPersistenceFailed(active: ActiveOperation): OperationFailure {
  const failure: OperationFailure = {
    code: "operation_persistence_failed",
    message: "The operation could not persist its progress.",
  };
  forceOperationFailure(active, failure);
  return failure;
}

function forceOperationFailure(active: ActiveOperation, failure: OperationFailure): void {
  active.forcedFailure = failure;
  active.abortController.abort(new Error(failure.message));
}

async function* streamEvents(
  operationId: string,
  afterSequence: number,
  store: OperationStore,
  activeOperations: Map<string, ActiveOperation>,
  listeners: Map<string, Set<() => void>>,
  signal: AbortSignal | undefined,
): AsyncIterable<OperationEventRecord> {
  let notified = false;
  let resume: (() => void) | undefined;
  const listener = () => {
    notified = true;
    resume?.();
  };
  const abortListener = () => {
    notified = true;
    resume?.();
  };
  const operationListeners = listeners.get(operationId) ?? new Set<() => void>();
  operationListeners.add(listener);
  listeners.set(operationId, operationListeners);
  signal?.addEventListener("abort", abortListener, { once: true });
  let cursor = afterSequence;
  try {
    while (true) {
      if (signal?.aborted === true) {
        return;
      }
      notified = false;
      const active = activeOperations.get(operationId);
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
        if (active?.handlerDidSettle === true) {
          await active.ownerSettled;
        }
        return;
      }
      if (!isDurablyActive(activeOperations.get(operationId))) {
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
    signal?.removeEventListener("abort", abortListener);
    operationListeners.delete(listener);
    if (operationListeners.size === 0) {
      listeners.delete(operationId);
    }
  }
}

function isDurablyActive(active: ActiveOperation | undefined): boolean {
  return active !== undefined && !active.terminalPersistenceFailed;
}

function createSnapshot(
  records: readonly OperationEventRecord[],
  isActive: boolean,
  resolveOperation: (contributionId: string) => RegisteredOperation | undefined,
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
    origin: first.schemaVersion === 3 ? first.origin : null,
    progress: latestProgress(records),
    presentation: operationPresentation(first, resolveOperation(first.event.contributionId)),
    startedAt: first.recordedAt,
    throughSequence: records.at(-1)?.sequence ?? first.sequence,
  };
  const terminal = records.find((record) => isTerminal(record.event))?.event;
  if (terminal?.type === "operation_completed") {
    return {
      ...base,
      ...(terminal.artifacts === undefined ? {} : { artifacts: terminal.artifacts }),
      output: terminal.output,
      status: "completed",
    };
  }
  if (terminal?.type === "operation_failed") {
    return {
      ...base,
      ...(terminal.artifacts === undefined ? {} : { artifacts: terminal.artifacts }),
      error: terminal.error,
      status: "failed",
    };
  }
  if (terminal?.type === "operation_cancelled") {
    return {
      ...base,
      ...(terminal.artifacts === undefined ? {} : { artifacts: terminal.artifacts }),
      reason: terminal.reason,
      status: "cancelled",
    };
  }
  if (terminal?.type === "operation_inspection_required") {
    return {
      ...base,
      ...(terminal.evidence === undefined ? {} : { evidence: terminal.evidence }),
      message: terminal.message,
      status: "inspection_required",
    };
  }
  if (!isActive) {
    return {
      ...base,
      error: {
        code: "operation_recovery_required",
        message: "The interrupted operation requires explicit recovery.",
      },
      recoverable: isOperationRecoverable(first, resolveOperation(first.event.contributionId)),
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

function isOperationRecoverable(
  started: OperationEventRecord,
  registered: RegisteredOperation | undefined,
): boolean {
  if (started.event.type !== "operation_started") {
    return false;
  }
  if (started.schemaVersion === 1) {
    return true;
  }
  return (
    registered !== undefined &&
    registered.contributionId === started.event.contributionId &&
    registered.extensionId === started.event.extensionId &&
    registered.extensionVersion === started.event.extensionVersion &&
    registered.definitionDigest === started.event.definitionDigest &&
    typeof registered.registration.reconcile === "function"
  );
}

function operationPresentation(
  started: OperationEventRecord,
  registered: RegisteredOperation | undefined,
): OperationSnapshotBase["presentation"] {
  if (started.event.type !== "operation_started") {
    throw new OperationHostError("operation_persistence_failed");
  }
  const exact =
    started.schemaVersion !== 1 &&
    registered !== undefined &&
    registered.contributionId === started.event.contributionId &&
    registered.extensionId === started.event.extensionId &&
    registered.extensionVersion === started.event.extensionVersion &&
    registered.definitionDigest === started.event.definitionDigest;
  const contribution = exact ? registered.contribution : undefined;
  return {
    kind: contribution?.command === undefined ? "generic" : "descriptor",
    report: contribution?.report ?? null,
    title: contribution?.command?.title ?? started.event.contributionId,
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

function validateOperationOrigin(value: unknown): OperationOrigin {
  if (!isPlainRecord(value)) {
    throw new OperationHostError("operation_origin_invalid");
  }
  const candidate = value as {
    readonly invocation?: unknown;
    readonly sessionId?: unknown;
    readonly sourceSequence?: unknown;
  };
  const keys = Object.keys(value).sort();
  const invocation = candidate.invocation;
  const invocationCandidate = invocation as {
    readonly id?: unknown;
    readonly kind?: unknown;
    readonly version?: unknown;
  };
  const invocationKeys = isPlainRecord(invocation) ? Object.keys(invocation).sort() : [];
  if (
    keys.length !== 3 ||
    keys[0] !== "invocation" ||
    keys[1] !== "sessionId" ||
    keys[2] !== "sourceSequence" ||
    !isPlainRecord(invocation) ||
    invocationKeys.length !== 3 ||
    invocationKeys[0] !== "id" ||
    invocationKeys[1] !== "kind" ||
    invocationKeys[2] !== "version" ||
    invocationCandidate.id !== "review" ||
    invocationCandidate.kind !== "presentation_command" ||
    invocationCandidate.version !== 1 ||
    typeof candidate.sessionId !== "string" ||
    !isOperationUuid(candidate.sessionId) ||
    typeof candidate.sourceSequence !== "number" ||
    !Number.isSafeInteger(candidate.sourceSequence) ||
    candidate.sourceSequence <= 0
  ) {
    throw new OperationHostError("operation_origin_invalid");
  }
  return {
    invocation: { id: "review", kind: "presentation_command", version: 1 },
    sessionId: candidate.sessionId,
    sourceSequence: candidate.sourceSequence,
  };
}

function validateLinkedOperationListOptions(value: LinkedOperationListOptions): {
  readonly cursor?: string;
  readonly limit: number;
  readonly sessionId: string;
  readonly throughSequence: number;
} {
  const limit = value.limit ?? 50;
  if (
    !isOperationUuid(value.sessionId) ||
    !Number.isSafeInteger(value.throughSequence) ||
    value.throughSequence <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > 100 ||
    (value.cursor !== undefined && !isOperationUuid(value.cursor))
  ) {
    throw new OperationHostError("operation_list_invalid");
  }
  return {
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    limit,
    sessionId: value.sessionId,
    throughSequence: value.throughSequence,
  };
}

function isOperationUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function resolveIdempotentOperation(
  existing: OperationEventRecord | undefined,
  expected: {
    readonly definitionDigest: string;
    readonly inputDigest: string;
    readonly origin: OperationOrigin | undefined;
  },
): OperationReference | undefined {
  if (existing?.event.type !== "operation_started") {
    return undefined;
  }
  const existingOrigin = existing.schemaVersion === 3 ? existing.origin : undefined;
  const definitionMatches =
    existing.schemaVersion === 1 || existing.event.definitionDigest === expected.definitionDigest;
  if (
    existing.event.inputDigest !== expected.inputDigest ||
    !definitionMatches ||
    !operationOriginsEqual(existingOrigin, expected.origin)
  ) {
    throw new OperationHostError("operation_idempotency_conflict");
  }
  return { operationId: existing.operationId };
}

function resolveMaterializedIdempotentOperation(
  existing: OperationEventRecord | undefined,
  expected: {
    readonly definitionDigest: string;
    readonly origin: OperationOrigin | undefined;
  },
): OperationReference | undefined {
  if (existing?.event.type !== "operation_started") {
    return undefined;
  }
  const existingOrigin = existing.schemaVersion === 3 ? existing.origin : undefined;
  const definitionMatches =
    existing.schemaVersion === 1 || existing.event.definitionDigest === expected.definitionDigest;
  if (!definitionMatches || !operationOriginsEqual(existingOrigin, expected.origin)) {
    throw new OperationHostError("operation_idempotency_conflict");
  }
  return { operationId: existing.operationId };
}

function normalizeOperationInput(value: unknown): ReturnType<typeof normalizeJson> {
  try {
    return normalizeJson(value, EXTENSION_OPERATION_INPUT_MAX_BYTES);
  } catch (error) {
    if (error instanceof OperationHostError) {
      throw error;
    }
    throw new OperationHostError("operation_input_invalid", { cause: error });
  }
}

function operationOriginsEqual(
  left: OperationOrigin | undefined,
  right: OperationOrigin | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.invocation.id === right.invocation.id &&
      left.invocation.kind === right.invocation.kind &&
      left.invocation.version === right.invocation.version &&
      left.sessionId === right.sessionId &&
      left.sourceSequence === right.sourceSequence)
  );
}

async function createProjectId(projectRoot: string): Promise<string> {
  try {
    const canonicalRoot = await realpath(projectRoot);
    return `sha256:${createHash("sha256").update(canonicalRoot).digest("hex")}`;
  } catch (error) {
    throw new OperationHostError("operation_project_unavailable", { cause: error });
  }
}

function isTerminal(event: OperationEventRecord["event"]): event is DurableOperationTerminalEvent {
  return (
    event.type === "operation_cancelled" ||
    event.type === "operation_completed" ||
    event.type === "operation_failed" ||
    event.type === "operation_inspection_required"
  );
}

function operationOwnerErrorCode(
  error: ProjectExecutionDomainError,
): "project_in_use" | "project_owner_unavailable" {
  return error.code === "root_conflict" || error.code === "project_in_use"
    ? "project_in_use"
    : "project_owner_unavailable";
}

function operationHostErrorMessage(code: OperationHostError["code"]): string {
  switch (code) {
    case "operation_contribution_unavailable":
      return "The operation contribution is unavailable.";
    case "operation_deadline_invalid":
      return "The requested operation deadline is invalid.";
    case "operation_idempotency_conflict":
      return "The operation idempotency key was reused with a different definition, origin, or input.";
    case "operation_input_invalid":
      return "The operation input is invalid.";
    case "operation_input_too_large":
      return "The operation input exceeds its byte limit.";
    case "operation_list_invalid":
      return "The linked operation list request is invalid.";
    case "operation_not_found":
      return "The operation does not exist.";
    case "operation_origin_invalid":
      return "The linked operation origin is invalid.";
    case "operation_persistence_failed":
      return "The operation state could not be persisted.";
    case "operation_project_unavailable":
      return "The operation project root is unavailable.";
    case "operation_reconciliation_failed":
      return "The operation reconciliation failed safely.";
    case "operation_store_project_mismatch":
      return "The operation store belongs to another project.";
    case "project_in_use":
      return "Another process owns lifecycle mutations for this canonical project.";
    case "project_owner_unavailable":
      return "The OS-backed project lifecycle owner is unavailable.";
  }
}
