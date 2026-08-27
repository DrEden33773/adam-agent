import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AuthoritativePresentationSnapshot,
  CommandReceipt,
  McpDisplay,
  PresentationCommand,
  PresentationDisplayState,
  PresentationSession,
  PresentationTransientState,
  RepositoryInstructionsDisplay,
  SessionNaming,
  SessionSummary,
  SkillCatalogDisplay,
  ToolPreviewDisplay,
  TranscriptItem,
} from "@adam-agent/presentation";
import {
  presentationArtifactPageMaximumBytes,
  reconcilePresentationUpdate,
  resolveSkillMentions,
} from "@adam-agent/presentation";
import type { RuntimeEvent } from "./agent-session-contracts.js";
import { readFileArtifact, readFileArtifactRange } from "./artifact-store.js";
import { maximumModelResponseContentBytes } from "./durable-model-response-policy.js";
import type { ExtensionHost } from "./extension-host.js";
import {
  type ModelTargetIdentity,
  type ModelTargetSnapshot,
  type ModelTargets,
  sameModelTargetIdentity,
} from "./model-targets.js";
import type { OperationHost, OperationSnapshot } from "./operation-host.js";
import {
  type ProjectedOperation,
  projectLinkedOperation,
} from "./presentation-operation-projection.js";
import type { PresentationPreferences } from "./presentation-preferences.js";
import {
  type ChangePreviewProjectionRequest,
  collectChangePreviewRequests,
  projectChangePreviewPage,
  projectPendingPermissionCandidates,
  projectToolDisplays,
  resolveActionableChangePreviewReference,
} from "./presentation-tool-projection.js";
import { listProjectPaths } from "./project-path-catalog.js";
import {
  type SessionNamingHistoryState,
  sessionNamingStateFromRecords,
} from "./session-history-folds.js";
import {
  type CurrentSessionSnapshot,
  type SessionContextUsageSnapshot,
  type SessionLifecycle,
  SessionLifecycleError,
  type SessionMetadataEvent,
  type SessionRuntimeNotification,
} from "./session-lifecycle.js";
import { readJsonlSessionRecords, type SessionRecord } from "./session-store.js";

/** Tests only. Production hydration has no artificial publication barrier. */
export const presentationHydrationBarrier = Symbol("adam-agent.presentation-hydration-barrier");
export const presentationHistoryPageSize = Symbol("adam-agent.presentation-history-page-size");
export const presentationCatalogPageSize = Symbol("adam-agent.presentation-catalog-page-size");
export const presentationRuntimeRefreshBarrier = Symbol(
  "adam-agent.presentation-runtime-refresh-barrier",
);
export const presentationArtifactReadBarrier = Symbol(
  "adam-agent.presentation-artifact-read-barrier",
);
export const presentationSessionRecordReader = Symbol(
  "adam-agent.presentation-session-record-reader",
);

export type PresentationHydrationBarrier = {
  afterHydrate(input: {
    readonly sessionId: string;
    readonly throughSequence: number;
  }): Promise<void>;
};

export type PresentationRuntimeRefreshBarrier = {
  beforeRead(notification: SessionRuntimeNotification): Promise<void>;
};

export type PresentationArtifactReadBarrier = {
  beforeRead(): Promise<void>;
  afterRead?(): Promise<void>;
};

export type PresentationSessionRecordReader = (
  sessionId: string,
) => Promise<readonly SessionRecord[]>;

type PresentationSessionBaseOptions = {
  readonly lifecycle: SessionLifecycle;
  readonly modelTargets?: ModelTargets;
  readonly operations?: OperationHost;
  readonly projectChanges?: Pick<ExtensionHost, "startProjectChanges">;
  readonly preferences?: PresentationPreferences;
  readonly projectLabel: string;
  readonly stateRoot?: string;
  readonly workspaceRoot: string;
  readonly [presentationHydrationBarrier]?: PresentationHydrationBarrier;
  readonly [presentationRuntimeRefreshBarrier]?: PresentationRuntimeRefreshBarrier;
  readonly [presentationArtifactReadBarrier]?: PresentationArtifactReadBarrier;
  readonly [presentationSessionRecordReader]?: PresentationSessionRecordReader;
  readonly [presentationHistoryPageSize]?: number;
  readonly [presentationCatalogPageSize]?: number;
};

type PresentationSessionRecordOptions = Pick<
  PresentationSessionBaseOptions,
  "stateRoot" | "workspaceRoot" | typeof presentationSessionRecordReader
>;

export type CreatePresentationSessionOptions = PresentationSessionBaseOptions &
  (
    | {
        readonly openProject: true;
        readonly sessionId?: never;
        readonly targetIdentity?: never;
      }
    | {
        readonly targetIdentity: ModelTargetIdentity;
        readonly openProject?: never;
        readonly sessionId?: never;
      }
    | {
        readonly sessionId: string;
        readonly openProject?: never;
        readonly targetIdentity?: never;
      }
  );

export async function createPresentationSession(
  options: CreatePresentationSessionOptions,
): Promise<PresentationSession> {
  options.lifecycle.enableAutomaticTitles();
  const changePreviewCache = new Map<string, ToolPreviewDisplay | null>();
  const bufferedEvents: SessionRuntimeNotification[] = [];
  const bufferedMetadata: SessionMetadataEvent[] = [];
  let handleRuntime: ((notification: SessionRuntimeNotification) => void) | undefined;
  let handleMetadata: ((event: SessionMetadataEvent) => Promise<void>) | undefined;
  const unsubscribeLifecycle = options.lifecycle.subscribeSessionEvents((notification) => {
    if (handleRuntime === undefined) {
      bufferedEvents.push(notification);
      return;
    }
    handleRuntime(notification);
  });
  const unsubscribeMetadata = options.lifecycle.subscribeMetadata((event) => {
    if (handleMetadata === undefined) {
      bufferedMetadata.push(event);
      return;
    }
    return handleMetadata(event);
  });

  try {
    let created: CurrentSessionSnapshot | undefined;
    if (options.sessionId === undefined) {
      created = undefined;
    } else {
      const inspected = await options.lifecycle.inspect({ sessionId: options.sessionId });
      const existingRecords = await readPresentationSessionRecords(options, options.sessionId);
      if (
        inspected.schemaVersion === 3 &&
        inspected.status !== "interrupted" &&
        !hasOrphanTitle(existingRecords)
      ) {
        created = inspected;
      } else {
        const resumed = await options.lifecycle.resume({ sessionId: options.sessionId });
        if (resumed.status === "rejected") {
          throw new TypeError(resumed.error.message);
        }
        created = resumed.snapshot;
      }
    }
    if (created !== undefined) {
      if (created.schemaVersion !== 3) {
        throw new TypeError("The Presentation Interface requires a current session schema.");
      }
      created = (await options.lifecycle.ensureAutomaticTitle({ sessionId: created.sessionId }))
        .snapshot;
      await options[presentationHydrationBarrier]?.afterHydrate({
        sessionId: created.sessionId,
        throughSequence: created.lastSequence,
      });
      if (bufferedEvents.length > 0) {
        const caughtUp = await options.lifecycle.inspect({ sessionId: created.sessionId });
        if (caughtUp.schemaVersion !== 3) {
          throw new TypeError("The Presentation Interface requires a current session schema.");
        }
        created = caughtUp;
      }
    }
    const records =
      created === undefined ? [] : await readActiveBranchRecords(options, created.sessionId);
    const initialOperationProjection = await projectLinkedOperations(options.operations, records);
    const projectedOperations = initialOperationProjection.items;
    const operationCursors = new Map(
      projectedOperations.map((operation) => [
        operation.display.operationId,
        operation.throughSequence,
      ]),
    );
    const operationCursorSnapshot = (): readonly {
      readonly operationId: string;
      readonly sequence: number;
    }[] => [...operationCursors].map(([operationId, sequence]) => ({ operationId, sequence }));
    const advanceOperationCursor = (operationId: string, sequence: number): void => {
      operationCursors.set(operationId, Math.max(sequence, operationCursors.get(operationId) ?? 0));
    };
    const resetOperationCursors = (operations: readonly ProjectedOperation[]): void => {
      operationCursors.clear();
      for (const operation of operations) {
        operationCursors.set(operation.display.operationId, operation.throughSequence);
      }
    };
    let activeSessionThroughSequence = created?.lastSequence ?? 0;
    const advanceSessionCursor = (sequence: number): void => {
      activeSessionThroughSequence = Math.max(activeSessionThroughSequence, sequence);
    };
    const initialPreviewHydration = hydrateChangePreviews(records, options, changePreviewCache);
    if (initialPreviewHydration !== null) {
      await initialPreviewHydration;
    }
    let transcript: readonly TranscriptItem[] = projectTranscript(
      records,
      projectedOperations,
      changePreviewCache,
    );
    const historyPageSize = boundedHistoryPageSize(options[presentationHistoryPageSize]);
    let loadedTranscriptStart = Math.max(0, transcript.length - historyPageSize);
    const naming =
      created === undefined ? undefined : projectSessionNaming(records, created.sessionId);
    const catalogPageSize = boundedCatalogPageSize(options[presentationCatalogPageSize]);
    const activeSummary: SessionSummary | undefined =
      created === undefined || naming === undefined
        ? undefined
        : {
            id: created.sessionId,
            label: naming.displayLabel,
            naming,
            targetId: created.targetIdentity.targetId,
            status: created.status,
          };
    const modelTargetSnapshot = await options.modelTargets?.snapshot({
      discoverGateway: false,
      signal: new AbortController().signal,
    });
    const initialContextUsage =
      created === undefined
        ? null
        : await options.lifecycle.inspectContextUsage({ sessionId: created.sessionId });
    const configuredPreferences = await options.preferences?.load();
    const configuredTarget = modelTargetSnapshot?.targets.find(
      (target) => target.identity.targetId === configuredPreferences?.defaultTargetId,
    );
    const preferenceDiagnostic =
      configuredPreferences === undefined
        ? null
        : (configuredPreferences.diagnostic ??
          (configuredPreferences.defaultTargetId !== null && configuredTarget === undefined
            ? {
                code: "target_configuration_invalid",
                message: "The saved default target is not in the current target catalog.",
              }
            : configuredTarget?.readiness.status === "missing"
              ? {
                  code: "target_configuration_invalid",
                  message: "The saved default target is missing its required credential.",
                }
              : null));
    const knownTargets = new Map<string, ModelTargetIdentity>();
    for (const target of modelTargetSnapshot?.targets ?? []) {
      if (target.readiness.status === "available") {
        knownTargets.set(target.identity.targetId, target.identity);
      }
    }
    if (created !== undefined && !knownTargets.has(created.targetIdentity.targetId)) {
      knownTargets.set(created.targetIdentity.targetId, created.targetIdentity);
    }
    if (
      "targetIdentity" in options &&
      options.targetIdentity !== undefined &&
      !knownTargets.has(options.targetIdentity.targetId)
    ) {
      knownTargets.set(options.targetIdentity.targetId, options.targetIdentity);
    }
    const catalogPage = await options.lifecycle.listProjectSessions({ limit: catalogPageSize });
    const projectPaths = await listProjectPaths(options.workspaceRoot);
    const catalogItems = (
      await Promise.all(
        catalogPage.items.map(async (snapshot) => {
          if (snapshot.schemaVersion !== 3) {
            return null;
          }
          if (!knownTargets.has(snapshot.targetIdentity.targetId)) {
            knownTargets.set(snapshot.targetIdentity.targetId, snapshot.targetIdentity);
          }
          return sessionSummaryFromSnapshot(
            snapshot,
            snapshot.sessionId === created?.sessionId
              ? records
              : await readActiveBranchRecords(options, snapshot.sessionId),
          );
        }),
      )
    ).filter((candidate): candidate is SessionSummary => candidate !== null);
    const summary =
      created === undefined
        ? undefined
        : (catalogItems.find((candidate) => candidate.id === created.sessionId) ?? activeSummary);
    const initialCatalogItems =
      created === undefined || activeSummary === undefined
        ? catalogItems
        : catalogItems.some((candidate) => candidate.id === created.sessionId)
          ? catalogItems
          : [...catalogItems, activeSummary];
    const initialDraft =
      "targetIdentity" in options && options.targetIdentity !== undefined
        ? await options.lifecycle.previewNewSession({ targetIdentity: options.targetIdentity })
        : null;
    const authoritative: AuthoritativePresentationSnapshot = {
      schemaVersion: 1,
      continuity: initialOperationProjection.truncated
        ? {
            status: "degraded",
            fault: {
              code: "authoritative_state_unavailable",
              message: "The linked operation view exceeds the Presentation bound.",
            },
          }
        : {
            status: "current",
            sessionThroughSequence: activeSessionThroughSequence,
            operationThrough: operationCursorSnapshot(),
          },
      project: { id: catalogPage.projectId, label: options.projectLabel },
      targets: {
        items: (modelTargetSnapshot?.targets ?? []).map((target) => ({
          targetId: target.identity.targetId,
          label: target.identity.modelId,
          route: target.identity.route,
          certification:
            target.identity.certification === "certified" ? "Certified" : "Experimental",
          readiness: target.readiness,
          thinking:
            target.thinkingCapability === undefined
              ? null
              : {
                  capabilityId: target.thinkingCapability.capabilityId,
                  capabilityVersion: target.thinkingCapability.capabilityVersion,
                  capabilityDigest: target.thinkingCapability.capabilityDigest,
                  defaultLevelId: target.thinkingCapability.defaultLevelId,
                  levels: target.thinkingCapability.levels.map((level) => ({
                    id: level.id,
                    label: level.label,
                    effectiveLevelId: level.effectiveLevelId,
                  })),
                },
        })),
        defaultTargetId:
          preferenceDiagnostic === null ? (configuredPreferences?.defaultTargetId ?? null) : null,
        diagnostic: preferenceDiagnostic,
      },
      sessions: { items: initialCatalogItems, nextCursor: catalogPage.nextCursor },
      active:
        created === undefined || summary === undefined
          ? null
          : {
              session: summary,
              transcript: transcriptPage(transcript, loadedTranscriptStart, created.sessionId),
              linkedOperations: projectedOperations.map(({ display }) => display),
              linkedOperationsTruncated: initialOperationProjection.truncated,
              context: projectSessionContext(created, initialContextUsage, modelTargetSnapshot),
              pendingInteractions: await projectPendingInteractions(records, options),
              repositoryInstructions: projectRepositoryInstructions(created),
              skills: projectSkills(created),
              projectPaths,
              mcp: projectMcp(created),
            },
    };
    let state: PresentationDisplayState = {
      revision: 1,
      authoritative,
      draft:
        initialDraft === null
          ? null
          : {
              targetId: initialDraft.targetIdentity.targetId,
              skills: projectSkillContext(initialDraft.skillContext, false),
              projectPaths,
            },
      transient: null,
    };
    let draftTargetIdentity: ModelTargetIdentity | null = initialDraft?.targetIdentity ?? null;
    const metadataThrough = new Map<string, number>();
    if (created !== undefined) {
      metadataThrough.set(`session_naming_changed:${created.sessionId}`, created.lastSequence);
      metadataThrough.set(`mcp_configuration_changed:${created.sessionId}`, created.lastSequence);
    }
    const listeners = new Set<() => void>();
    const publishStateChange = (): void => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Presentation observers cannot change authoritative command or refresh outcomes.
        }
      }
    };
    let closed = false;
    const operationAdmissions = new Set<Promise<void>>();
    const operationRefreshes = new Set<Promise<void>>();
    const operationObservers = new Map<string, AbortController>();
    const ownedOperationIds = new Set<string>();
    const operationRepairs = new Set<string>();
    const operationRecoveries = new Set<string>();
    const publishOperationSnapshot = (next: ProjectedOperation): boolean => {
      const active = state.authoritative.active;
      if (
        closed ||
        active === null ||
        !active.linkedOperations.some(
          (operation) => operation.operationId === next.display.operationId,
        )
      ) {
        return false;
      }
      const previousSequence = operationCursors.get(next.display.operationId) ?? 0;
      if (next.throughSequence < previousSequence) {
        return true;
      }
      advanceOperationCursor(next.display.operationId, next.throughSequence);
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity:
            state.authoritative.continuity.status === "current"
              ? {
                  ...state.authoritative.continuity,
                  operationThrough: operationCursorSnapshot(),
                }
              : state.authoritative.continuity,
          active: {
            ...active,
            linkedOperations: active.linkedOperations.map((operation) =>
              operation.operationId === next.display.operationId ? next.display : operation,
            ),
          },
        },
        draft: state.draft,
        transient: state.transient,
      };
      publishStateChange();
      return true;
    };
    const publishAdmittedOperation = (next: ProjectedOperation): boolean => {
      const active = state.authoritative.active;
      const continuity = state.authoritative.continuity;
      if (
        closed ||
        active === null ||
        continuity.status !== "current" ||
        active.session.id !== next.display.origin.sessionId ||
        continuity.sessionThroughSequence < next.display.origin.sourceSequence
      ) {
        return false;
      }
      if (
        active.linkedOperations.some(
          (operation) => operation.operationId === next.display.operationId,
        )
      ) {
        return publishOperationSnapshot(next);
      }
      if (active.linkedOperations.length >= 256) {
        state = {
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            continuity: {
              status: "degraded",
              fault: {
                code: "authoritative_state_unavailable",
                message: "The linked operation view exceeds the Presentation bound.",
              },
            },
            active: { ...active, linkedOperationsTruncated: true },
          },
          draft: state.draft,
          transient: state.transient,
        };
        publishStateChange();
        return false;
      }
      advanceOperationCursor(next.display.operationId, next.throughSequence);
      const link = {
        type: "operation_link" as const,
        id: `operation:${next.display.operationId}`,
        operationId: next.display.operationId,
        sequence: next.display.origin.sourceSequence,
        sourceSessionId: next.display.origin.sessionId,
        branchBoundary: {
          sessionId: next.display.origin.sessionId,
          sequence: next.display.origin.sourceSequence,
        },
      };
      const items = [...active.transcript.items];
      const insertionIndex = items.findIndex(
        (item) =>
          item.sourceSessionId === next.display.origin.sessionId &&
          (item.sequence > next.display.origin.sourceSequence ||
            (item.sequence === next.display.origin.sourceSequence &&
              item.type === "operation_link" &&
              item.operationId.localeCompare(next.display.operationId) > 0)),
      );
      items.splice(insertionIndex < 0 ? items.length : insertionIndex, 0, link);
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity: {
            ...continuity,
            operationThrough: operationCursorSnapshot(),
          },
          active: {
            ...active,
            transcript: {
              ...active.transcript,
              items,
            },
            linkedOperations: [...active.linkedOperations, next.display],
          },
        },
        draft: state.draft,
        transient: state.transient,
      };
      publishStateChange();
      return true;
    };
    const watchOperation = (projected: ProjectedOperation): void => {
      const operations = options.operations;
      if (
        operations === undefined ||
        (projected.display.status !== "running" && projected.display.status !== "cancel_requested")
      ) {
        return;
      }
      operationObservers.get(projected.display.operationId)?.abort();
      const observer = new AbortController();
      operationObservers.set(projected.display.operationId, observer);
      const refresh = (async () => {
        let observedStatus = projected.display.status;
        let observedThroughSequence = projected.throughSequence;
        for await (const _record of operations.events({
          afterSequence: projected.throughSequence,
          operationId: projected.display.operationId,
          signal: observer.signal,
        })) {
          if (closed || observer.signal.aborted) {
            return;
          }
          const snapshot = await operations.query(projected.display.operationId);
          const next = projectLinkedOperation(snapshot);
          if (observer.signal.aborted || next === null || !publishOperationSnapshot(next)) {
            return;
          }
          observedStatus = next.display.status;
          observedThroughSequence = next.throughSequence;
        }
        if (closed || observer.signal.aborted) {
          return;
        }
        const snapshot = await operations.query(projected.display.operationId);
        const next = projectLinkedOperation(snapshot);
        if (
          observer.signal.aborted ||
          next === null ||
          (next.throughSequence === observedThroughSequence &&
            next.display.status === observedStatus) ||
          !publishOperationSnapshot(next)
        ) {
          return;
        }
      })().catch(async () => {
        if (closed || observer.signal.aborted) {
          return;
        }
        const active = state.authoritative.active;
        const continuity = state.authoritative.continuity;
        if (
          active === null ||
          continuity.status === "degraded" ||
          !active.linkedOperations.some(
            (operation) => operation.operationId === projected.display.operationId,
          )
        ) {
          return;
        }
        operationRepairs.add(projected.display.operationId);
        const sessionId = active.session.id;
        if (continuity.status === "current") {
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              continuity: { status: "repairing", reason: "reconnect" },
            },
            draft: state.draft,
            transient: state.transient,
          };
          publishStateChange();
        }
        try {
          const snapshot = await operations.query(projected.display.operationId);
          const next = projectLinkedOperation(snapshot);
          const latest = state.authoritative.active;
          if (
            closed ||
            observer.signal.aborted ||
            next === null ||
            latest === null ||
            latest.session.id !== sessionId ||
            !latest.linkedOperations.some(
              (operation) => operation.operationId === projected.display.operationId,
            )
          ) {
            operationRepairs.delete(projected.display.operationId);
            return;
          }
          advanceOperationCursor(next.display.operationId, next.throughSequence);
          operationRepairs.delete(projected.display.operationId);
          const latestContinuity = state.authoritative.continuity;
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              continuity:
                latestContinuity.status === "degraded"
                  ? latestContinuity
                  : operationRepairs.size > 0
                    ? { status: "repairing", reason: "reconnect" }
                    : {
                        status: "current",
                        sessionThroughSequence: activeSessionThroughSequence,
                        operationThrough: operationCursorSnapshot(),
                      },
              active: {
                ...latest,
                linkedOperations: latest.linkedOperations.map((operation) =>
                  operation.operationId === next.display.operationId ? next.display : operation,
                ),
              },
            },
            draft: state.draft,
            transient: state.transient,
          };
          publishStateChange();
          watchOperation(next);
        } catch {
          operationRepairs.delete(projected.display.operationId);
          if (closed || observer.signal.aborted) {
            return;
          }
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              continuity: {
                status: "degraded",
                fault: {
                  code: "authoritative_state_unavailable",
                  message: "The durable operation view is temporarily unavailable.",
                },
              },
            },
            draft: state.draft,
            transient: state.transient,
          };
          publishStateChange();
        }
      });
      operationRefreshes.add(refresh);
      void refresh.finally(() => {
        operationRefreshes.delete(refresh);
        if (operationObservers.get(projected.display.operationId) === observer) {
          operationObservers.delete(projected.display.operationId);
        }
      });
    };
    const repairAdmittedOperationProjection = (operationId: string): void => {
      const operations = options.operations;
      if (operations === undefined || operationObservers.has(operationId)) {
        return;
      }
      const observer = new AbortController();
      operationObservers.set(operationId, observer);
      const degrade = () => {
        const active = state.authoritative.active;
        if (
          closed ||
          observer.signal.aborted ||
          active === null ||
          state.authoritative.continuity.status === "degraded"
        ) {
          return;
        }
        state = {
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            continuity: {
              status: "degraded",
              fault: {
                code: "authoritative_state_unavailable",
                message: "The admitted operation view is temporarily unavailable.",
              },
            },
          },
          draft: state.draft,
          transient: state.transient,
        };
        publishStateChange();
      };
      const refresh = (async () => {
        const projectCurrent = async (): Promise<boolean> => {
          try {
            const snapshot = await operations.query(operationId);
            const operation = projectLinkedOperation(snapshot);
            if (operation !== null && publishAdmittedOperation(operation)) {
              watchOperation(operation);
            }
            return operation !== null;
          } catch {
            return false;
          }
        };
        for await (const _record of operations.events({
          afterSequence: 0,
          operationId,
          signal: observer.signal,
        })) {
          if (closed || observer.signal.aborted) {
            return;
          }
          if (await projectCurrent()) {
            return;
          }
        }
        if (closed || observer.signal.aborted || (await projectCurrent())) {
          return;
        }
        degrade();
      })().catch(degrade);
      operationRefreshes.add(refresh);
      void refresh.finally(() => {
        operationRefreshes.delete(refresh);
        if (operationObservers.get(operationId) === observer) {
          operationObservers.delete(operationId);
        }
      });
    };
    for (const operation of projectedOperations) {
      watchOperation(operation);
    }
    let activeRun:
      | {
          sessionId: string | null;
          readonly controller: AbortController;
          readonly settlement: Promise<void>;
        }
      | undefined;
    let snapshotActivationQueue = Promise.resolve();
    const activateSnapshotNow = async (snapshot: CurrentSessionSnapshot): Promise<void> => {
      const activatedRecords = await readActiveBranchRecords(options, snapshot.sessionId);
      const activatedOperationProjection = await projectLinkedOperations(
        options.operations,
        activatedRecords,
      );
      const activatedOperations = activatedOperationProjection.items;
      const activatedContextUsage = await options.lifecycle.inspectContextUsage({
        sessionId: snapshot.sessionId,
      });
      const activatedPreviewHydration = hydrateChangePreviews(
        activatedRecords,
        options,
        changePreviewCache,
      );
      if (activatedPreviewHydration !== null) {
        await activatedPreviewHydration;
      }
      const activatedTranscript = projectTranscript(
        activatedRecords,
        activatedOperations,
        changePreviewCache,
      );
      const activatedLoadedTranscriptStart = Math.max(
        0,
        activatedTranscript.length - historyPageSize,
      );
      const activatedPendingInteractions = await projectPendingInteractions(
        activatedRecords,
        options,
      );
      const activatedNaming = projectSessionNaming(activatedRecords, snapshot.sessionId);
      const activatedSummary: SessionSummary = {
        id: snapshot.sessionId,
        label: activatedNaming.displayLabel,
        naming: activatedNaming,
        targetId: snapshot.targetIdentity.targetId,
        status: snapshot.status,
      };
      if (!knownTargets.has(snapshot.targetIdentity.targetId)) {
        knownTargets.set(snapshot.targetIdentity.targetId, snapshot.targetIdentity);
      }
      const catalogItems = state.authoritative.sessions.items.some(
        (session) => session.id === snapshot.sessionId,
      )
        ? state.authoritative.sessions.items.map((session) =>
            session.id === snapshot.sessionId ? activatedSummary : session,
          )
        : [...state.authoritative.sessions.items, activatedSummary];
      const activeSequence = activatedRecords.reduce(
        (maximum, record) =>
          record.sessionId === snapshot.sessionId
            ? Math.max(maximum, record.entry.sequence)
            : maximum,
        snapshot.lastSequence,
      );
      for (const observer of operationObservers.values()) {
        observer.abort();
      }
      operationRepairs.clear();
      resetOperationCursors(activatedOperations);
      activeSessionThroughSequence = activeSequence;
      transcript = activatedTranscript;
      loadedTranscriptStart = activatedLoadedTranscriptStart;
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity: activatedOperationProjection.truncated
            ? {
                status: "degraded",
                fault: {
                  code: "authoritative_state_unavailable",
                  message: "The linked operation view exceeds the Presentation bound.",
                },
              }
            : {
                status: "current",
                sessionThroughSequence: activeSequence,
                operationThrough: operationCursorSnapshot(),
              },
          sessions: {
            items: catalogItems,
            nextCursor: state.authoritative.sessions.nextCursor,
          },
          active: {
            session: activatedSummary,
            transcript: transcriptPage(transcript, loadedTranscriptStart, snapshot.sessionId),
            linkedOperations: activatedOperations.map((operation) => operation.display),
            linkedOperationsTruncated: activatedOperationProjection.truncated,
            context: projectSessionContext(snapshot, activatedContextUsage, modelTargetSnapshot),
            pendingInteractions: activatedPendingInteractions,
            repositoryInstructions: projectRepositoryInstructions(snapshot),
            skills: projectSkills(snapshot),
            projectPaths,
            mcp: projectMcp(snapshot),
          },
        },
        draft: null,
        transient: null,
      };
      draftTargetIdentity = null;
      publishStateChange();
      for (const operation of activatedOperations) {
        watchOperation(operation);
      }
    };
    const activateSnapshot = (snapshot: CurrentSessionSnapshot): Promise<void> => {
      const activation = snapshotActivationQueue.then(() => activateSnapshotNow(snapshot));
      snapshotActivationQueue = activation.then(
        () => undefined,
        () => undefined,
      );
      return activation;
    };
    const refreshActiveNaming = async (
      sessionId: string,
      throughSequence: number,
    ): Promise<void> => {
      const active = state.authoritative.active;
      if (active === null || active.session.id !== sessionId) {
        throw new TypeError("The active session disappeared during naming.");
      }
      const refreshedRecords = await readActiveBranchRecords(options, sessionId);
      const current = state.authoritative.active;
      if (closed || current === null || current.session.id !== sessionId) {
        return;
      }
      const refreshedNaming = projectSessionNaming(refreshedRecords, sessionId);
      const refreshedSummary: SessionSummary = {
        ...current.session,
        label: refreshedNaming.displayLabel,
        naming: refreshedNaming,
      };
      advanceSessionCursor(throughSequence);
      const continuity = state.authoritative.continuity;
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity:
            continuity.status === "current"
              ? {
                  status: "current",
                  sessionThroughSequence: activeSessionThroughSequence,
                  operationThrough: operationCursorSnapshot(),
                }
              : continuity,
          sessions: {
            ...state.authoritative.sessions,
            items: state.authoritative.sessions.items.map((session) =>
              session.id === sessionId ? refreshedSummary : session,
            ),
          },
          active: { ...current, session: refreshedSummary },
        },
        draft: state.draft,
        transient: state.transient,
      };
      publishStateChange();
    };
    const refreshActiveMcp = async (sessionId: string, throughSequence: number): Promise<void> => {
      const active = state.authoritative.active;
      if (active === null || active.session.id !== sessionId) {
        throw new TypeError("The active session disappeared during MCP refresh.");
      }
      const inspected = await options.lifecycle.inspect({ sessionId });
      if (inspected.schemaVersion !== 3) {
        throw new TypeError("The active MCP session is no longer current.");
      }
      const current = state.authoritative.active;
      if (closed || current === null || current.session.id !== sessionId) {
        return;
      }
      advanceSessionCursor(Math.max(throughSequence, inspected.lastSequence));
      const continuity = state.authoritative.continuity;
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity:
            continuity.status === "current"
              ? {
                  status: "current",
                  sessionThroughSequence: activeSessionThroughSequence,
                  operationThrough: operationCursorSnapshot(),
                }
              : continuity,
          active: { ...current, mcp: projectMcp(inspected) },
        },
        draft: state.draft,
        transient: state.transient,
      };
      publishStateChange();
    };
    let runtimeRefresh = Promise.resolve();
    let metadataRefresh = Promise.resolve();
    const seenRuntimeNotificationIds = new Set<string>();
    const runtimeNotificationOrder: string[] = [];
    handleRuntime = (notification) => {
      if (seenRuntimeNotificationIds.has(notification.notificationId)) {
        return;
      }
      seenRuntimeNotificationIds.add(notification.notificationId);
      runtimeNotificationOrder.push(notification.notificationId);
      if (runtimeNotificationOrder.length > 4_096) {
        const expired = runtimeNotificationOrder.shift();
        if (expired !== undefined) {
          seenRuntimeNotificationIds.delete(expired);
        }
      }
      runtimeRefresh = runtimeRefresh
        .catch(() => undefined)
        .then(async () => {
          try {
            const active = state.authoritative.active;
            if (closed || active === null || notification.sessionId !== active.session.id) {
              return;
            }
            const event = notification.event;
            let missingReasoningSnapshot:
              | {
                  readonly expectedId: string;
                  readonly event: Extract<
                    RuntimeEvent,
                    { readonly type: "model_reasoning_updated" }
                  >;
                }
              | undefined;
            if (event.type === "user_message" || event.type === "model_message_started") {
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                draft: state.draft,
                transient: { activity: "working", assistant: null, reasoning: null },
              };
              publishStateChange();
            } else if (event.type === "tool_requested" || event.type === "tool_started") {
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                draft: state.draft,
                transient: { activity: "using_tool", assistant: null, reasoning: null },
              };
              publishStateChange();
            } else if (event.type === "model_reasoning_started") {
              const target = knownTargets.get(active.session.targetId);
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                draft: state.draft,
                transient: {
                  activity: "working",
                  assistant: state.transient?.assistant ?? null,
                  reasoning: {
                    id: reasoningDisplayId(notification.sessionId, notification.runId, event.id),
                    afterSequence: notification.throughSequence,
                    artifactType: event.artifactType,
                    disclosure: "owner_only",
                    provider: providerDisplayName(target?.vendor),
                    status: "active",
                    text: "",
                  },
                },
              };
              publishStateChange();
            } else if (event.type === "model_reasoning_settled") {
              const reasoning = state.transient?.reasoning;
              const expectedId = reasoningDisplayId(
                notification.sessionId,
                notification.runId,
                event.id,
              );
              if (reasoning?.id === expectedId) {
                state = {
                  revision: state.revision + 1,
                  authoritative: state.authoritative,
                  draft: state.draft,
                  transient: {
                    activity: state.transient?.activity ?? "working",
                    assistant: state.transient?.assistant ?? null,
                    reasoning: { ...reasoning, status: event.status },
                  },
                };
                publishStateChange();
              }
            }
            if (event.type === "model_reasoning_updated") {
              const reasoning = state.transient?.reasoning;
              const expectedId = reasoningDisplayId(
                notification.sessionId,
                notification.runId,
                event.id,
              );
              if (reasoning?.id !== expectedId) {
                missingReasoningSnapshot = { expectedId, event };
              } else {
                state = reconcilePresentationUpdate(state, {
                  type: "reasoning_snapshot",
                  afterSequence: notification.throughSequence,
                  reasoning: { ...reasoning, text: event.text },
                });
                publishStateChange();
                return;
              }
            }
            if (isModelMessageDelta(event)) {
              const streamId = `${notification.sessionId}:${notification.runId}`;
              const existingText =
                state.transient?.assistant?.streamId === streamId
                  ? state.transient.assistant.text
                  : "";
              state = reconcilePresentationUpdate(state, {
                type: "assistant_delta",
                streamId,
                afterSequence: notification.throughSequence,
                text: `${existingText}${event.text}`,
              });
              publishStateChange();
              return;
            }
            if (event.type === "context_usage") {
              const activeIdentity = knownTargets.get(active.session.targetId);
              const profile = modelTargetSnapshot?.targets.find(
                (target) =>
                  activeIdentity !== undefined &&
                  sameModelTargetIdentity(target.identity, activeIdentity),
              )?.contextProfile;
              const current = state.authoritative.active;
              if (profile !== undefined && current?.session.id === active.session.id) {
                state = {
                  revision: state.revision + 1,
                  authoritative: {
                    ...state.authoritative,
                    active: {
                      ...current,
                      context: {
                        profile,
                        ordinaryUsage: event.ordinary,
                        compactionUsage: event.compaction,
                        active:
                          event.active.source === "unknown"
                            ? { source: "unknown" }
                            : { source: event.active.source, tokens: event.active.tokens },
                      },
                    },
                  },
                  draft: state.draft,
                  transient: state.transient,
                };
                publishStateChange();
              }
            }
            const previousSequence =
              state.authoritative.continuity.status === "current"
                ? state.authoritative.continuity.sessionThroughSequence
                : null;
            if (
              previousSequence !== null &&
              notification.throughSequence === previousSequence &&
              missingReasoningSnapshot === undefined
            ) {
              return;
            }
            if (previousSequence !== null && notification.throughSequence < previousSequence) {
              state = {
                revision: state.revision + 1,
                authoritative: {
                  ...state.authoritative,
                  continuity: { status: "repairing", reason: "gap" },
                },
                draft: state.draft,
                transient: null,
              };
              publishStateChange();
            }
            await options[presentationRuntimeRefreshBarrier]?.beforeRead(notification);
            const refreshedRecords = await readActiveBranchRecords(options, active.session.id);
            const refreshedOperationProjection = await projectLinkedOperations(
              options.operations,
              refreshedRecords,
            );
            const refreshedOperations = refreshedOperationProjection.items;
            const current = state.authoritative.active;
            if (closed || current === null || current.session.id !== active.session.id) {
              return;
            }
            const refreshedPreviewHydration = hydrateChangePreviews(
              refreshedRecords,
              options,
              changePreviewCache,
            );
            if (refreshedPreviewHydration !== null) {
              await refreshedPreviewHydration;
            }
            transcript = projectTranscript(
              refreshedRecords,
              refreshedOperations,
              changePreviewCache,
            );
            loadedTranscriptStart = Math.min(
              loadedTranscriptStart,
              Math.max(0, transcript.length - historyPageSize),
            );
            const activeSequence = refreshedRecords.reduce(
              (maximum, record) =>
                record.sessionId === active.session.id
                  ? Math.max(maximum, record.entry.sequence)
                  : maximum,
              0,
            );
            if (activeSequence < notification.throughSequence) {
              state = {
                revision: state.revision + 1,
                authoritative: {
                  ...state.authoritative,
                  continuity: { status: "repairing", reason: "gap" },
                },
                draft: state.draft,
                transient: null,
              };
              publishStateChange();
            }
            const pendingInteractions = await projectPendingInteractions(refreshedRecords, options);
            const recoveredReasoning =
              missingReasoningSnapshot === undefined
                ? undefined
                : projectActiveReasoningSnapshot({
                    records: refreshedRecords,
                    sessionId: notification.sessionId,
                    runId: notification.runId,
                    expectedId: missingReasoningSnapshot.expectedId,
                    event: missingReasoningSnapshot.event,
                    afterSequence: notification.throughSequence,
                    provider: providerDisplayName(
                      knownTargets.get(active.session.targetId)?.vendor,
                    ),
                  });
            const terminalContextUsage = isAssistantTerminalEvent(event)
              ? await options.lifecycle.inspectContextUsage({ sessionId: active.session.id })
              : null;
            const latest = state.authoritative.active;
            if (closed || latest === null || latest.session.id !== active.session.id) {
              return;
            }
            const effectiveOperations = refreshedOperations.map((operation) => {
              const previousSequence = operationCursors.get(operation.display.operationId) ?? 0;
              if (operation.throughSequence >= previousSequence) {
                advanceOperationCursor(operation.display.operationId, operation.throughSequence);
                return operation;
              }
              const currentDisplay = latest.linkedOperations.find(
                (candidate) => candidate.operationId === operation.display.operationId,
              );
              return currentDisplay === undefined
                ? operation
                : { display: currentDisplay, throughSequence: previousSequence };
            });
            const latestSequence =
              state.authoritative.continuity.status === "current"
                ? state.authoritative.continuity.sessionThroughSequence
                : 0;
            advanceSessionCursor(Math.max(activeSequence, latestSequence));
            state = {
              revision: state.revision + 1,
              authoritative: {
                ...state.authoritative,
                continuity: refreshedOperationProjection.truncated
                  ? {
                      status: "degraded",
                      fault: {
                        code: "authoritative_state_unavailable",
                        message: "The linked operation view exceeds the Presentation bound.",
                      },
                    }
                  : {
                      status: "current",
                      sessionThroughSequence: activeSessionThroughSequence,
                      operationThrough: operationCursorSnapshot(),
                    },
                active: {
                  ...latest,
                  transcript: transcriptPage(transcript, loadedTranscriptStart, current.session.id),
                  linkedOperations: effectiveOperations.map((operation) => operation.display),
                  linkedOperationsTruncated: refreshedOperationProjection.truncated,
                  context: resolvePresentationTerminalContext(
                    latest.context,
                    projectSessionContextUsage(
                      knownTargets.get(latest.session.targetId),
                      terminalContextUsage,
                      modelTargetSnapshot,
                    ),
                  ),
                  pendingInteractions,
                },
              },
              draft: state.draft,
              transient: isAssistantTerminalEvent(event)
                ? null
                : recoveredReasoning === undefined
                  ? state.transient
                  : {
                      activity: state.transient?.activity ?? "working",
                      assistant: state.transient?.assistant ?? null,
                      reasoning: recoveredReasoning,
                    },
            };
            publishStateChange();
            for (const operation of effectiveOperations) {
              if (!operationObservers.has(operation.display.operationId)) {
                watchOperation(operation);
              }
            }
          } catch {
            if (closed) {
              return;
            }
            state = {
              revision: state.revision + 1,
              authoritative: {
                ...state.authoritative,
                continuity: {
                  status: "degraded",
                  fault: {
                    code: "authoritative_state_unavailable",
                    message: "The durable session view is temporarily unavailable.",
                  },
                },
              },
              draft: state.draft,
              transient: null,
            };
            publishStateChange();
          }
        });
    };
    for (const event of bufferedEvents.splice(0)) {
      const hydratedThrough =
        state.authoritative.continuity.status === "current"
          ? state.authoritative.continuity.sessionThroughSequence
          : -1;
      if (
        event.sessionId === state.authoritative.active?.session.id &&
        event.throughSequence > hydratedThrough
      ) {
        handleRuntime(event);
      }
    }
    handleMetadata = (event) => {
      metadataRefresh = metadataRefresh.then(async () => {
        const active = state.authoritative.active;
        const metadataKey = `${event.type}:${event.sessionId}`;
        if (
          closed ||
          active === null ||
          event.sessionId !== active.session.id ||
          event.throughSequence <= (metadataThrough.get(metadataKey) ?? 0)
        ) {
          return;
        }
        try {
          if (event.type === "session_naming_changed") {
            await refreshActiveNaming(event.sessionId, event.throughSequence);
          } else {
            await refreshActiveMcp(event.sessionId, event.throughSequence);
          }
          if (!closed && state.authoritative.active?.session.id === event.sessionId) {
            metadataThrough.set(
              metadataKey,
              Math.max(event.throughSequence, metadataThrough.get(metadataKey) ?? 0),
            );
          }
        } catch {
          if (closed) {
            return;
          }
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              continuity: {
                status: "degraded",
                fault: {
                  code: "authoritative_state_unavailable",
                  message: "The durable session view is temporarily unavailable.",
                },
              },
            },
            draft: state.draft,
            transient: null,
          };
          publishStateChange();
        }
      });
      return metadataRefresh;
    };
    for (const event of bufferedMetadata.splice(0)) {
      await handleMetadata(event);
    }

    const dispatch = async (command: PresentationCommand): Promise<CommandReceipt> => {
      if (closed) {
        return {
          status: "rejected",
          code: "presentation_closed",
          message: "The presentation session is closed.",
        };
      }
      if (command.type === "set_default_target") {
        const target = state.authoritative.targets.items.find(
          (candidate) =>
            candidate.targetId === command.targetId && candidate.readiness.status === "available",
        );
        if (target === undefined || options.preferences === undefined) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The exact target cannot be saved as the default.",
          };
        }
        try {
          await options.preferences.setDefaultTarget(command.targetId);
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              targets: {
                ...state.authoritative.targets,
                defaultTargetId: command.targetId,
                diagnostic: null,
              },
            },
            draft: state.draft,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The exact default target could not be saved.",
          };
        }
      }
      if (command.type === "create_session") {
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "A new session cannot be drafted while a run is active.",
          };
        }
        const targetIdentity = knownTargets.get(command.targetId);
        if (targetIdentity === undefined) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The exact target is not available in this Presentation session.",
          };
        }
        let preview: Awaited<ReturnType<SessionLifecycle["previewNewSession"]>>;
        try {
          preview = await options.lifecycle.previewNewSession({ targetIdentity });
        } catch {
          return {
            status: "rejected",
            code: "not_available",
            message: "The exact target and draft Skill catalog could not be prepared.",
          };
        }
        for (const observer of operationObservers.values()) {
          observer.abort();
        }
        operationRepairs.clear();
        operationCursors.clear();
        activeSessionThroughSequence = 0;
        state = {
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            continuity: {
              status: "current",
              sessionThroughSequence: 0,
              operationThrough: [],
            },
            active: null,
          },
          draft: {
            targetId: targetIdentity.targetId,
            skills: projectSkillContext(preview.skillContext, false),
            projectPaths,
          },
          transient: null,
        };
        draftTargetIdentity = targetIdentity;
        publishStateChange();
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "select_session") {
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "A session cannot be selected while a run is active.",
          };
        }
        if (
          !state.authoritative.sessions.items.some((session) => session.id === command.sessionId)
        ) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The requested project session is not in the current catalog.",
          };
        }
        try {
          let snapshot = await options.lifecycle.inspect({ sessionId: command.sessionId });
          if (snapshot.schemaVersion !== 3) {
            throw new TypeError("Legacy sessions cannot be selected for continuation.");
          }
          if (snapshot.status === "interrupted") {
            const resumed = await options.lifecycle.resume({ sessionId: command.sessionId });
            if (resumed.status === "rejected") {
              throw new TypeError(resumed.error.message);
            }
            snapshot = resumed.snapshot;
          }
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The session could not be selected.",
          };
        }
      }
      if (command.type === "submit_prompt") {
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          command.text.trim().length === 0
        ) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The prompt does not target the active session or is blank.",
          };
        }
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The active session already has a running command.",
          };
        }
        const skillResolution = resolveSkillMentions({
          text: command.text,
          explicitQualifiedIds: command.skills,
          catalog: state.authoritative.active.skills,
        });
        if (skillResolution.status === "ambiguous") {
          return ambiguousSkillMentionRejection(skillResolution);
        }
        const controller = new AbortController();
        const commandId = randomUUID();
        const admission = Promise.withResolvers<void>();
        const admissionAfterSequence =
          state.authoritative.continuity.status === "current"
            ? state.authoritative.continuity.sessionThroughSequence
            : -1;
        const unsubscribeAdmission = options.lifecycle.subscribeSessionEvents((notification) => {
          if (
            notification.sessionId === command.sessionId &&
            notification.runId === commandId &&
            notification.throughSequence > admissionAfterSequence &&
            notification.event.type === "user_message" &&
            notification.event.text === command.text
          ) {
            admission.resolve();
          }
        });
        let admissionFailure: unknown;
        const continuation = options.lifecycle.continue({
          sessionId: command.sessionId,
          input: {
            text: command.text,
            ...(skillResolution.qualifiedIds.length === 0
              ? {}
              : { skills: skillResolution.qualifiedIds }),
          },
          runId: commandId,
          signal: controller.signal,
          ...(command.thinkingSelection === null
            ? {}
            : { thinkingSelection: command.thinkingSelection }),
        });
        const settlement = continuation
          .then(async (continued) => {
            if (!closed) {
              await activateSnapshot(continued.snapshot);
            }
          })
          .catch(async () => {
            if (closed) {
              return;
            }
            const inspected = await options.lifecycle.inspect({ sessionId: command.sessionId });
            if (inspected.schemaVersion === 3) {
              await activateSnapshot(inspected);
            }
          })
          .finally(() => {
            if (activeRun?.settlement === settlement) {
              activeRun = undefined;
            }
          });
        activeRun = {
          sessionId: command.sessionId,
          controller,
          settlement,
        };
        const admitted = await Promise.race([
          admission.promise.then(() => ({ status: "admitted" as const })),
          continuation.then(
            (continued) => {
              admissionFailure =
                continued.result.status === "failed" ? continued.result.error.code : null;
              return { status: "rejected" as const };
            },
            (error) => {
              admissionFailure = error;
              return { status: "rejected" as const };
            },
          ),
        ]);
        unsubscribeAdmission();
        if (admitted.status === "rejected") {
          await settlement;
          return (
            thinkingPolicyAdmissionRejection(admissionFailure) ?? {
              status: "rejected",
              code: "not_available",
              message: "The prompt could not be admitted to durable session history.",
            }
          );
        }
        return { status: "admitted", commandId, resource: null };
      }
      if (command.type === "submit_draft_prompt") {
        const draft = state.draft;
        if (draft === null || command.text.trim().length === 0) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "A non-empty prompt and exact draft target are required.",
          };
        }
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The active session already has a running command.",
          };
        }
        const targetIdentity = draftTargetIdentity;
        if (targetIdentity === null || targetIdentity.targetId !== draft.targetId) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The exact draft target is no longer available.",
          };
        }
        const skillResolution = resolveSkillMentions({
          text: command.text,
          explicitQualifiedIds: command.skills,
          catalog: draft.skills,
        });
        if (skillResolution.status === "ambiguous") {
          return ambiguousSkillMentionRejection(skillResolution);
        }
        const controller = new AbortController();
        const commandId = randomUUID();
        const admission = Promise.withResolvers<string>();
        let admittedSessionId: string | null = null;
        state = {
          ...state,
          revision: state.revision + 1,
          transient: { activity: "working", assistant: null, reasoning: null },
        };
        publishStateChange();
        const continuation = options.lifecycle.admit({
          targetIdentity,
          input: {
            text: command.text,
            ...(skillResolution.qualifiedIds.length === 0
              ? {}
              : { skills: skillResolution.qualifiedIds }),
          },
          runId: commandId,
          signal: controller.signal,
          ...(command.thinkingSelection === null
            ? {}
            : { thinkingSelection: command.thinkingSelection }),
          onAdmitted(receipt) {
            if (receipt.runId !== commandId) {
              return;
            }
            admittedSessionId = receipt.sessionId;
            admission.resolve(receipt.sessionId);
          },
        });
        const settlement = continuation
          .then(async (continued) => {
            if (!closed && admittedSessionId !== null) {
              await activateSnapshot(continued.snapshot);
            }
          })
          .catch(async () => {
            const sessionId = admittedSessionId;
            if (closed || sessionId === null) {
              return;
            }
            const inspected = await options.lifecycle.inspect({ sessionId });
            if (inspected.schemaVersion === 3) {
              await activateSnapshot(inspected);
            }
          })
          .finally(() => {
            if (activeRun?.settlement === settlement) {
              activeRun = undefined;
            }
            if (
              !closed &&
              admittedSessionId === null &&
              state.authoritative.active === null &&
              state.transient !== null
            ) {
              state = { ...state, revision: state.revision + 1, transient: null };
              publishStateChange();
            }
          });
        activeRun = {
          sessionId: null,
          controller,
          settlement,
        };
        let admissionFailure: unknown;
        const admitted = await Promise.race([
          admission.promise.then((sessionId) => ({ status: "admitted" as const, sessionId })),
          continuation.then(
            (continued) => {
              admissionFailure =
                continued.result.status === "failed" ? continued.result.error.code : null;
              return { status: "rejected" as const };
            },
            (error) => {
              admissionFailure = error;
              return { status: "rejected" as const };
            },
          ),
        ]);
        if (admitted.status === "rejected") {
          await settlement;
          return draftAdmissionRejection(admissionFailure);
        }
        if (activeRun?.settlement === settlement) {
          activeRun.sessionId = admitted.sessionId;
        }
        const admittedSnapshot = await options.lifecycle.inspect({ sessionId: admitted.sessionId });
        if (admittedSnapshot.schemaVersion !== 3) {
          await settlement;
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The admitted draft session could not be read from durable history.",
          };
        }
        await activateSnapshot(admittedSnapshot);
        return { status: "admitted", commandId, resource: null };
      }
      if (command.type === "branch_session") {
        if (command.parentSessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The branch source is no longer active.",
          };
        }
        if (
          command.sourceBoundary !== undefined &&
          !transcript.some(
            (item) =>
              item.branchBoundary?.sessionId === command.sourceBoundary?.sessionId &&
              item.branchBoundary.sequence === command.sourceBoundary.sequence,
          )
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The source-aware branch boundary is no longer visible.",
          };
        }
        try {
          const snapshot = await options.lifecycle.branch({
            parentSessionId: command.parentSessionId,
            ...(command.sourceBoundary === undefined
              ? { atSequence: command.atSequence }
              : { sourceBoundary: command.sourceBoundary }),
            ...(command.targetId === null ? {} : { targetId: command.targetId }),
          });
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The exact branch boundary was not accepted.",
          };
        }
      }
      if (command.type === "decide_permission") {
        const pending = state.authoritative.active?.pendingInteractions.find(
          (interaction) => interaction.requestId === command.requestId,
        );
        if (pending === undefined) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The permission request is no longer pending.",
          };
        }
        if (command.decision === "allow" && !pending.canAllow) {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The canonical change preview is unavailable.",
          };
        }
        if (
          command.decision === "allow" &&
          pending.effect === "write" &&
          state.authoritative.active !== null &&
          !(await isCurrentActionableChangePreview(
            options,
            state.authoritative.active.session.id,
            command.requestId,
          ))
        ) {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The canonical change preview is unavailable.",
          };
        }
        const result = options.lifecycle.decidePermission(command);
        return result.status === "accepted"
          ? { status: "admitted", commandId: randomUUID(), resource: null }
          : {
              status: "rejected",
              code: "stale_interaction",
              message: "The permission request is no longer pending.",
            };
      }
      if (command.type === "cancel_run") {
        if (activeRun?.sessionId !== command.sessionId) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The requested run is no longer active.",
          };
        }
        activeRun.controller.abort();
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "start_project_changes") {
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          state.authoritative.continuity.status !== "current"
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The active session boundary is no longer available for this command.",
          };
        }
        if (options.operations === undefined || options.projectChanges === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "No active extension command can admit project changes.",
          };
        }
        const commandId = randomUUID();
        const start = options.projectChanges
          .startProjectChanges({
            command: command.command,
            idempotencyKey: commandId,
            origin: {
              invocation: { id: "review", kind: "presentation_command", version: 1 },
              sessionId: command.sessionId,
              sourceSequence: state.authoritative.continuity.sessionThroughSequence,
            },
          })
          .then((reference) => {
            ownedOperationIds.add(reference.operationId);
            return reference;
          });
        const admissionSettlement = start.then(
          () => undefined,
          () => undefined,
        );
        operationAdmissions.add(admissionSettlement);
        let reference: Awaited<typeof start>;
        try {
          reference = await start;
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The project changes could not be admitted for this command.",
          };
        } finally {
          operationAdmissions.delete(admissionSettlement);
        }
        const projection = options.operations
          .query(reference.operationId)
          .then((snapshot) => {
            const operation = projectLinkedOperation(snapshot);
            if (operation !== null && publishAdmittedOperation(operation)) {
              watchOperation(operation);
            }
          })
          .catch(() => repairAdmittedOperationProjection(reference.operationId));
        operationRefreshes.add(projection);
        void projection.finally(() => operationRefreshes.delete(projection));
        return { status: "admitted", commandId, resource: null };
      }
      if (command.type === "cancel_operation") {
        const operation = state.authoritative.active?.linkedOperations.find(
          (candidate) => candidate.operationId === command.operationId,
        );
        if (
          operation === undefined ||
          !operation.actions.some((action: "cancel" | "recover") => action === "cancel")
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The linked operation is no longer cancellable.",
          };
        }
        if (options.operations === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "Operation control is unavailable.",
          };
        }
        try {
          await options.operations.cancel(command.operationId);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The linked operation could not be cancelled.",
          };
        }
      }
      if (command.type === "recover_operation") {
        const operation = state.authoritative.active?.linkedOperations.find(
          (candidate) => candidate.operationId === command.operationId,
        );
        if (
          operation === undefined ||
          !operation.actions.some((action: "cancel" | "recover") => action === "recover") ||
          operationRecoveries.has(command.operationId)
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The linked operation no longer requires recovery.",
          };
        }
        if (options.operations === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "Operation recovery is unavailable.",
          };
        }
        const operations = options.operations;
        operationRecoveries.add(command.operationId);
        void (async () => {
          let snapshot: OperationSnapshot;
          try {
            snapshot = await operations.recover(command.operationId);
          } catch {
            try {
              snapshot = await operations.query(command.operationId);
            } catch {
              if (!closed) {
                state = {
                  revision: state.revision + 1,
                  authoritative: {
                    ...state.authoritative,
                    continuity: {
                      status: "degraded",
                      fault: {
                        code: "authoritative_state_unavailable",
                        message: "The durable operation view is temporarily unavailable.",
                      },
                    },
                  },
                  draft: state.draft,
                  transient: state.transient,
                };
                publishStateChange();
              }
              return;
            }
          }
          if (closed) {
            return;
          }
          operationRecoveries.delete(command.operationId);
          const next = projectLinkedOperation(snapshot);
          if (next !== null && publishOperationSnapshot(next)) {
            watchOperation(next);
          }
        })().finally(() => operationRecoveries.delete(command.operationId));
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "load_older_transcript") {
        const active = state.authoritative.active;
        if (active === null || command.before !== active.transcript.olderCursor) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The transcript cursor is no longer current.",
          };
        }
        loadedTranscriptStart = Math.max(0, loadedTranscriptStart - historyPageSize);
        state = {
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            active: {
              ...active,
              transcript: transcriptPage(transcript, loadedTranscriptStart, active.session.id),
            },
          },
          draft: state.draft,
          transient: state.transient,
        };
        publishStateChange();
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "load_more_sessions") {
        if (command.after !== state.authoritative.sessions.nextCursor) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The project session cursor is no longer current.",
          };
        }
        try {
          const page = await options.lifecycle.listProjectSessions({
            cursor: command.after,
            limit: catalogPageSize,
          });
          const additions = (
            await Promise.all(
              page.items.map(async (snapshot) =>
                snapshot.schemaVersion === 3
                  ? sessionSummaryFromSnapshot(
                      snapshot,
                      await readActiveBranchRecords(options, snapshot.sessionId),
                    )
                  : null,
              ),
            )
          ).filter((candidate): candidate is SessionSummary => candidate !== null);
          const knownSessionIds = new Set(
            state.authoritative.sessions.items.map((session) => session.id),
          );
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              sessions: {
                items: [
                  ...state.authoritative.sessions.items,
                  ...additions.filter((session) => !knownSessionIds.has(session.id)),
                ],
                nextCursor: page.nextCursor,
              },
            },
            draft: state.draft,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The project session catalog could not be read.",
          };
        }
      }
      if (command.type === "read_artifact") {
        const active = state.authoritative.active;
        if (active === null || !isKnownArtifact(active, command.artifact)) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The requested artifact is no longer part of the active presentation.",
          };
        }
        const range = command.range;
        const completeReadAvailable =
          (command.artifact.source === "change_preview" &&
            command.artifact.byteCount <= 64 * 1024) ||
          (command.artifact.source === "model_response" &&
            command.artifact.byteCount <= maximumModelResponseContentBytes);
        if (
          options.stateRoot === undefined ||
          (range === null && !completeReadAvailable) ||
          (range !== null &&
            (!Number.isSafeInteger(range.offset) ||
              range.offset < 0 ||
              !Number.isSafeInteger(range.maximumBytes) ||
              range.maximumBytes <= 0 ||
              range.maximumBytes > presentationArtifactPageMaximumBytes))
        ) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The artifact is not available through this Presentation session.",
          };
        }
        try {
          await options[presentationArtifactReadBarrier]?.beforeRead();
          const page =
            range === null
              ? await readFileArtifact({
                  root: join(options.stateRoot, "artifacts"),
                  id: command.artifact.id,
                  maximumBytes: command.artifact.byteCount,
                }).then((bytes) =>
                  bytes === undefined
                    ? undefined
                    : {
                        bytes,
                        totalByteCount: bytes.byteLength,
                        eof: true,
                      },
                )
              : await readFileArtifactRange({
                  root: join(options.stateRoot, "artifacts"),
                  id: command.artifact.id,
                  expectedByteCount: command.artifact.byteCount,
                  offset: range.offset,
                  maximumBytes: range.maximumBytes,
                });
          if (page === undefined || page.totalByteCount !== command.artifact.byteCount) {
            throw new TypeError("The artifact bytes are unavailable.");
          }
          const decoded = decodeArtifactPage(page.bytes, page.eof);
          const eof = page.eof && decoded.byteCount === page.bytes.byteLength;
          if (!eof && decoded.byteCount === 0) {
            throw new TypeError("The artifact page did not make UTF-8 progress.");
          }
          await options[presentationArtifactReadBarrier]?.afterRead?.();
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: {
              mediaType: command.artifact.mediaType,
              offset: range?.offset ?? 0,
              byteCount: decoded.byteCount,
              totalByteCount: page.totalByteCount,
              eof,
              nextRange:
                range === null || eof
                  ? null
                  : {
                      offset: range.offset + decoded.byteCount,
                      maximumBytes: presentationArtifactPageMaximumBytes,
                    },
              text: decoded.text,
            },
          };
        } catch {
          return {
            status: "rejected",
            code: "not_available",
            message: "The artifact could not be read safely.",
          };
        }
      }
      if (command.type === "set_session_manual_name") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const namingResult = await options.lifecycle.setSessionManualName(command);
          await refreshActiveNaming(command.sessionId, namingResult.snapshot.lastSequence);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The session name was not accepted.",
          };
        }
      }
      if (command.type === "clear_session_manual_name") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const namingResult = await options.lifecycle.clearSessionManualName(command);
          await refreshActiveNaming(command.sessionId, namingResult.snapshot.lastSequence);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The session name could not be cleared.",
          };
        }
      }
      if (command.type === "regenerate_session_title") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const namingResult = await options.lifecycle.regenerateSessionTitle(command);
          await refreshActiveNaming(command.sessionId, namingResult.snapshot.lastSequence);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "conflict",
            message: "A title generation is already active or unavailable.",
          };
        }
      }
      if (command.type === "reload_repository_instructions") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const result = await options.lifecycle.reloadRepositoryInstructions(command);
          await activateSnapshot(result.snapshot);
          return result.status === "rejected"
            ? {
                status: "rejected",
                code: "authority_rejected",
                message: result.error.message,
              }
            : { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "Repository instructions could not be reloaded safely.",
          };
        }
      }
      if (command.type === "reload_skills") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const result = await options.lifecycle.reloadSkills(command);
          await activateSnapshot(result.snapshot);
          return result.status === "rejected"
            ? {
                status: "rejected",
                code: "authority_rejected",
                message: result.error.message,
              }
            : { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The Skill catalog could not be reloaded safely.",
          };
        }
      }
      if (command.type === "confirm_mcp_workspace") {
        const mcp = state.authoritative.active?.mcp;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          mcp === null ||
          mcp === undefined ||
          command.sourceDigest !== mcp.source.digest
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The MCP workspace source is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.configureMcp({
            type: "confirm_workspace",
            sessionId: command.sessionId,
            sourceDigest: command.sourceDigest,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          const inspected = await options.lifecycle
            .inspect({ sessionId: command.sessionId })
            .catch(() => undefined);
          if (inspected?.schemaVersion === 3) {
            await activateSnapshot(inspected);
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The MCP workspace source could not be confirmed.",
          };
        }
      }
      if (command.type === "approve_mcp_server") {
        const active = state.authoritative.active;
        const server = active?.mcp?.servers.find(
          (candidate) =>
            candidate.serverId === command.serverId &&
            candidate.definitionDigest === command.definitionDigest,
        );
        if (command.sessionId !== active?.session.id || server === undefined) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The MCP server definition is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.configureMcp({
            type: "approve_server",
            sessionId: command.sessionId,
            serverId: command.serverId,
            definitionDigest: command.definitionDigest,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The exact MCP server definition could not be approved.",
          };
        }
      }
      if (command.type === "activate_mcp_servers") {
        const active = state.authoritative.active;
        const exactServers = command.servers.every((requested) =>
          active?.mcp?.servers.some(
            (server) =>
              server.serverId === requested.serverId &&
              server.definitionDigest === requested.definitionDigest &&
              server.status === "approved",
          ),
        );
        if (
          command.sessionId !== active?.session.id ||
          command.servers.length === 0 ||
          !exactServers
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The approved MCP server set is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.configureMcp({
            type: "activate_servers",
            sessionId: command.sessionId,
            servers: command.servers,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          const inspected = await options.lifecycle
            .inspect({ sessionId: command.sessionId })
            .catch(() => undefined);
          if (inspected?.schemaVersion === 3) {
            await activateSnapshot(inspected);
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The approved MCP server set could not be activated.",
          };
        }
      }
      if (command.type === "commit_mcp_tool_profile") {
        const active = state.authoritative.active;
        const mcp = active?.mcp;
        const exactSelections = command.selections.every((selection) =>
          mcp?.catalog?.tools.some(
            (tool) =>
              tool.qualifiedName === selection.qualifiedName &&
              tool.definitionDigest === selection.definitionDigest,
          ),
        );
        if (
          command.sessionId !== active?.session.id ||
          mcp?.activation?.generationId !== command.generationId ||
          command.selections.length === 0 ||
          !exactSelections
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The MCP catalog selection is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.configureMcp({
            type: "commit_tool_profile",
            sessionId: command.sessionId,
            generationId: command.generationId,
            selections: command.selections,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The exact MCP Tool Profile could not be committed.",
          };
        }
      }
      if (command.type === "retry_mcp_activation") {
        const active = state.authoritative.active;
        if (
          command.sessionId !== active?.session.id ||
          active.mcp?.status !== "activation_failed" ||
          active.mcp.activation?.generationId !== command.generationId
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The failed MCP generation is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.configureMcp({
            type: "retry_activation",
            sessionId: command.sessionId,
            generationId: command.generationId,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          const inspected = await options.lifecycle
            .inspect({ sessionId: command.sessionId })
            .catch(() => undefined);
          if (inspected?.schemaVersion === 3) {
            await activateSnapshot(inspected);
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The failed MCP generation could not be retried.",
          };
        }
      }
      if (command.type === "revalidate_mcp_catalog") {
        const active = state.authoritative.active;
        if (
          command.sessionId !== active?.session.id ||
          active.mcp?.status !== "catalog_stale" ||
          active.mcp.activation?.generationId !== command.generationId
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The stale MCP generation is no longer current.",
          };
        }
        try {
          const inspected = await options.lifecycle.inspect({ sessionId: command.sessionId });
          if (
            inspected.schemaVersion !== 3 ||
            inspected.mcp?.status !== "catalog_stale" ||
            inspected.mcp.activation?.generationId !== command.generationId
          ) {
            return {
              status: "rejected",
              code: "stale_interaction",
              message: "The stale MCP generation is no longer current.",
            };
          }
          const result = await options.lifecycle.configureMcp({
            type: "revalidate_catalog",
            sessionId: command.sessionId,
            generationId: command.generationId,
          });
          await activateSnapshot(result.snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          const inspected = await options.lifecycle
            .inspect({ sessionId: command.sessionId })
            .catch(() => undefined);
          if (inspected?.schemaVersion === 3) {
            await activateSnapshot(inspected);
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The stale MCP catalog could not be revalidated.",
          };
        }
      }
      return {
        status: "rejected",
        code: "not_available",
        message: "The presentation command is not available yet.",
      };
    };

    return {
      getState: () => state,
      subscribe(onChange) {
        if (closed) {
          return () => {};
        }
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      dispatch,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        activeRun?.controller.abort();
        for (const observer of operationObservers.values()) {
          observer.abort();
        }
        await Promise.all(operationAdmissions);
        if (options.operations !== undefined) {
          await Promise.all(
            [...ownedOperationIds].map((operationId) =>
              settleOwnedOperationForClose(options.operations as OperationHost, operationId),
            ),
          );
        }
        unsubscribeLifecycle();
        unsubscribeMetadata();
        await activeRun?.settlement;
        await runtimeRefresh;
        await metadataRefresh;
        await Promise.all(operationRefreshes);
        listeners.clear();
        state = { ...state, transient: null };
        bufferedEvents.length = 0;
      },
    };
  } catch (error) {
    unsubscribeLifecycle();
    unsubscribeMetadata();
    throw error;
  }
}

async function settleOwnedOperationForClose(
  operations: OperationHost,
  operationId: string,
): Promise<void> {
  const cancellation = await operations.cancel(operationId);
  if (cancellation.status !== "running" && cancellation.status !== "cancel_requested") {
    return;
  }
  for await (const record of operations.events({
    afterSequence: cancellation.throughSequence,
    operationId,
  })) {
    if (
      record.event.type === "operation_cancelled" ||
      record.event.type === "operation_completed" ||
      record.event.type === "operation_failed" ||
      record.event.type === "operation_inspection_required"
    ) {
      break;
    }
  }
  const settled = await operations.query(operationId);
  if (settled.status === "running" || settled.status === "cancel_requested") {
    throw new Error("The owned extension operation did not reach durable settlement on close.");
  }
}

type ProjectedOperationCollection = {
  readonly items: readonly ProjectedOperation[];
  readonly truncated: boolean;
};

async function projectLinkedOperations(
  operations: OperationHost | undefined,
  records: readonly SourcedSessionRecord[],
): Promise<ProjectedOperationCollection> {
  if (operations === undefined || records.length === 0) {
    return { items: [], truncated: false };
  }
  const throughBySession = new Map<string, number>();
  for (const record of records) {
    throughBySession.set(
      record.sessionId,
      Math.max(throughBySession.get(record.sessionId) ?? 0, record.entry.sequence),
    );
  }
  const references: { readonly operationId: string }[] = [];
  let truncated = false;
  for (const [sessionId, throughSequence] of throughBySession) {
    if (references.length > 256) {
      truncated = true;
      break;
    }
    const prefix = await listLinkedOperationPrefix(
      operations,
      sessionId,
      throughSequence,
      257 - references.length,
    );
    references.push(...prefix.items);
    if (prefix.truncated || references.length > 256) {
      truncated = true;
      break;
    }
  }
  const snapshots = await Promise.all(
    [...new Set(references.slice(0, 256).map((reference) => reference.operationId))].map(
      (operationId) => operations.query(operationId),
    ),
  );
  return {
    items: snapshots
      .map(projectLinkedOperation)
      .filter((projected): projected is ProjectedOperation => projected !== null),
    truncated,
  };
}

async function listLinkedOperationPrefix(
  operations: OperationHost,
  sessionId: string,
  throughSequence: number,
  maximumItems: number,
): Promise<{
  readonly items: readonly { readonly operationId: string }[];
  readonly truncated: boolean;
}> {
  const references: { readonly operationId: string }[] = [];
  let cursor: string | undefined;
  while (true) {
    const remaining = maximumItems - references.length;
    if (remaining === 0) {
      return { items: references, truncated: true };
    }
    const page = await operations.listLinked({
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(100, remaining),
      sessionId,
      throughSequence,
    });
    references.push(...page.items);
    if (page.nextCursor === null) {
      return { items: references, truncated: false };
    }
    cursor = page.nextCursor;
  }
}

function decodeArtifactPage(
  bytes: Uint8Array,
  eof: boolean,
): { readonly byteCount: number; readonly text: string } {
  const maximumTrim = eof ? 0 : Math.min(3, bytes.byteLength);
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    const candidate = bytes.subarray(0, bytes.byteLength - trim);
    try {
      return {
        byteCount: candidate.byteLength,
        text: new TextDecoder("utf-8", { fatal: true }).decode(candidate),
      };
    } catch {
      // A bounded non-final page may end inside one UTF-8 scalar; retry without its partial bytes.
    }
  }
  throw new TypeError("The artifact page is not valid UTF-8.");
}

function isKnownArtifact(
  active: import("@adam-agent/presentation").ActiveSessionDisplay,
  artifact: import("@adam-agent/presentation").ArtifactReference,
): boolean {
  const candidates = [
    ...active.linkedOperations.flatMap((operation) =>
      operation.artifacts.map((artifact) => artifact.reference),
    ),
    ...active.pendingInteractions.flatMap((interaction) =>
      interaction.changePreviewRef === null ? [] : [interaction.changePreviewRef],
    ),
    ...active.transcript.items.flatMap((item) => {
      if (item.type === "assistant_message") {
        return item.artifact === null ? [] : [item.artifact];
      }
      if (item.type === "reasoning_block") {
        return item.artifact === null ? [] : [item.artifact];
      }
      if (item.type === "tool_call") {
        return [
          ...item.artifacts,
          ...(item.changePreviewRef === null ? [] : [item.changePreviewRef]),
        ];
      }
      return [];
    }),
  ];
  return candidates.some(
    (candidate) =>
      candidate.id === artifact.id &&
      candidate.mediaType === artifact.mediaType &&
      candidate.byteCount === artifact.byteCount &&
      candidate.source === artifact.source,
  );
}

function projectSessionContext(
  snapshot: CurrentSessionSnapshot,
  usage: SessionContextUsageSnapshot | null,
  targets: ModelTargetSnapshot | undefined,
): import("@adam-agent/presentation").SessionContextDisplay | null {
  const context = snapshot.context;
  if (context !== undefined) {
    return {
      profile: context.profile,
      ordinaryUsage: context.ordinaryUsage,
      compactionUsage: context.compactionUsage,
      active: context.active,
    };
  }
  return projectSessionContextUsage(snapshot.targetIdentity, usage, targets);
}

function projectSessionContextUsage(
  identity: ModelTargetIdentity | undefined,
  usage: SessionContextUsageSnapshot | null,
  targets: ModelTargetSnapshot | undefined,
): import("@adam-agent/presentation").SessionContextDisplay | null {
  const profile = targets?.targets.find(
    (target) => identity !== undefined && sameModelTargetIdentity(target.identity, identity),
  )?.contextProfile;
  if (profile === undefined || usage === null) {
    return null;
  }
  return {
    profile,
    ordinaryUsage: usage.ordinaryUsage,
    compactionUsage: usage.compactionUsage,
    active: usage.active,
  };
}

/** Tests only through the internal-testing entry; production uses this for terminal refreshes. */
export function resolvePresentationTerminalContext(
  latest: import("@adam-agent/presentation").SessionContextDisplay | null,
  terminal: import("@adam-agent/presentation").SessionContextDisplay | null,
): import("@adam-agent/presentation").SessionContextDisplay | null {
  return terminal ?? latest;
}

function boundedHistoryPageSize(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 200
    ? value
    : 100;
}

function boundedCatalogPageSize(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 100
    ? value
    : 100;
}

function isModelMessageDelta(
  event: unknown,
): event is { readonly type: "model_message_delta"; readonly text: string } {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "model_message_delta" &&
    "text" in event &&
    typeof event.text === "string"
  );
}

function isAssistantTerminalEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return false;
  }
  return (
    event.type === "model_message_completed" ||
    event.type === "session_interrupted" ||
    event.type === "session_settled"
  );
}

function hasOrphanTitle(records: readonly SessionRecord[]): boolean {
  const started = records.findLast(
    (entry) =>
      entry.schemaVersion === 3 && entry.record.type === "session_title_generation_started",
  );
  if (started?.schemaVersion !== 3 || started.record.type !== "session_title_generation_started") {
    return false;
  }
  const generationId = started.record.generationId;
  return !records.some(
    (entry) =>
      entry.schemaVersion === 3 &&
      (entry.record.type === "session_title_generation_completed" ||
        entry.record.type === "session_title_generation_failed") &&
      entry.record.generationId === generationId,
  );
}

function transcriptPage(transcript: readonly TranscriptItem[], start: number, sessionId: string) {
  return {
    items: transcript.slice(start),
    olderCursor:
      start === 0 ? null : `history:${sessionId}:before:${transcript[start]?.sequence ?? 0}`,
  };
}

type SourcedSessionRecord = {
  readonly sessionId: string;
  readonly entry: SessionRecord;
};

function sessionSummaryFromSnapshot(
  snapshot: CurrentSessionSnapshot,
  records: readonly SourcedSessionRecord[],
): SessionSummary {
  const naming = projectSessionNaming(records, snapshot.sessionId);
  return {
    id: snapshot.sessionId,
    label: naming.displayLabel,
    naming,
    targetId: snapshot.targetIdentity.targetId,
    status: snapshot.status,
  };
}

async function readActiveBranchRecords(
  options: PresentationSessionRecordOptions,
  sessionId: string,
  visited: ReadonlySet<string> = new Set(),
): Promise<readonly SourcedSessionRecord[]> {
  if (visited.has(sessionId) || visited.size >= 64) {
    throw new TypeError("The presentation lineage is recursive or too deep.");
  }
  const records = await readPresentationSessionRecords(options, sessionId);
  const own = records.map((entry) => ({ sessionId, entry }));
  const genesis = records[0];
  if (
    genesis?.schemaVersion !== 3 ||
    genesis.record.type !== "session_genesis" ||
    genesis.record.lineage === undefined
  ) {
    return own;
  }
  const lineage = genesis.record.lineage;
  const sourceSessionId =
    "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
  const sourceEventPosition =
    "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
  const nextVisited = new Set(visited);
  nextVisited.add(sessionId);
  const parent = await readActiveBranchRecords(options, sourceSessionId, nextVisited);
  return [
    ...parent.filter(
      (record) =>
        record.sessionId !== sourceSessionId || record.entry.sequence <= sourceEventPosition,
    ),
    ...own,
  ];
}

async function readPresentationSessionRecords(
  options: PresentationSessionRecordOptions,
  sessionId: string,
): Promise<readonly SessionRecord[]> {
  return (
    options[presentationSessionRecordReader]?.(sessionId) ??
    readJsonlSessionRecords({
      sessionId,
      workspaceRoot: options.workspaceRoot,
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    })
  );
}

function projectTranscript(
  records: readonly SourcedSessionRecord[],
  operations: readonly ProjectedOperation[],
  changePreviewCache: ReadonlyMap<string, ToolPreviewDisplay | null>,
): readonly TranscriptItem[] {
  const toolDisplays = projectToolDisplays(records, changePreviewCache);
  const attemptProviders = new Map<string, string>(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 && entry.record.type === "provider_attempt_started"
        ? [
            [
              `${sessionId}:${entry.record.runId}:${entry.record.turn}:${entry.record.attempt}`,
              providerDisplayName(entry.record.targetIdentity.vendor),
            ] as const,
          ]
        : [],
    ),
  );
  const reasoningStarts = new Map(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_reasoning_started"
        ? [
            [
              `${sessionId}:${entry.record.runId}:${entry.record.event.id}`,
              entry.record.event,
            ] as const,
          ]
        : [],
    ),
  );
  const terminalBoundaries = new Map(
    records.flatMap(({ entry, sessionId }) => {
      if (entry.schemaVersion !== 3) {
        return [];
      }
      if (entry.record.type === "runtime_event" && entry.record.event.type === "session_settled") {
        return [
          [`${sessionId}:${entry.record.runId}`, { sessionId, sequence: entry.sequence }] as const,
        ];
      }
      return entry.record.type === "run_settled"
        ? [[`${sessionId}:${entry.record.runId}`, { sessionId, sequence: entry.sequence }] as const]
        : [];
    }),
  );
  const publishedResponses = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 && entry.record.type === "model_response_published"
        ? [`${sessionId}:${entry.record.responseSequence}`]
        : [],
    ),
  );
  const completedInlineRuns = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_message_completed"
        ? [`${sessionId}:${entry.record.runId}`]
        : [],
    ),
  );
  const items: TranscriptItem[] = [];
  const terminalNoticeRuns = new Set<string>();
  for (const { entry, sessionId } of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "logical_run_started") {
      items.push({
        type: "user_message",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        text: entry.record.userMessage,
      });
      continue;
    }
    if (entry.record.type === "runtime_event" && entry.record.event.type === "tool_requested") {
      const tool = toolDisplays.get(`${sessionId}:${entry.record.event.callId}`);
      if (tool !== undefined) {
        items.push(tool);
      }
      continue;
    }
    if (entry.record.type === "context_compaction_committed") {
      items.push({
        type: "compaction_marker",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        windowNumber: entry.record.windowNumber,
        sourceThrough: entry.record.sourceThrough,
        retainedFrom: entry.record.retainedFrom,
      });
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "model_reasoning_settled" &&
      entry.record.event.status !== "completed"
    ) {
      const start = reasoningStarts.get(
        `${sessionId}:${entry.record.runId}:${entry.record.event.id}`,
      );
      const attemptIdentity = /^(\d+):(\d+):/.exec(entry.record.event.id);
      if (start !== undefined && attemptIdentity !== null) {
        items.push({
          type: "reasoning_block",
          id: reasoningDisplayId(sessionId, entry.record.runId, entry.record.event.id),
          sequence: entry.sequence,
          sourceSessionId: sessionId,
          branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
          artifactType: start.artifactType,
          disclosure: "owner_only",
          provider:
            attemptProviders.get(
              `${sessionId}:${entry.record.runId}:${attemptIdentity[1]}:${attemptIdentity[2]}`,
            ) ?? providerDisplayName(undefined),
          status: entry.record.event.status,
          text: null,
          artifact: null,
        });
      }
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_interrupted"
    ) {
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
        status: "interrupted",
        reason: entry.record.event.reason,
      });
      continue;
    }
    if (
      entry.record.type === "provider_attempt_interrupted" &&
      entry.record.reason === "process_restart"
    ) {
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: null,
        status: "interrupted",
        reason: "process_restart",
      });
      continue;
    }
    if (
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "session_settled" &&
      (entry.record.event.result.status === "failed" ||
        entry.record.event.result.status === "incomplete") &&
      !terminalNoticeRuns.has(`${sessionId}:${entry.record.runId}`)
    ) {
      terminalNoticeRuns.add(`${sessionId}:${entry.record.runId}`);
      const result = entry.record.event.result;
      items.push(
        result.status === "failed"
          ? {
              type: "session_notice",
              id: `${sessionId}:${entry.sequence}`,
              sequence: entry.sequence,
              sourceSessionId: sessionId,
              branchBoundary: { sessionId, sequence: entry.sequence },
              status: "failed",
              code: result.error.code,
              message: safeRunFailureMessage(result.error.code),
            }
          : {
              type: "session_notice",
              id: `${sessionId}:${entry.sequence}`,
              sequence: entry.sequence,
              sourceSessionId: sessionId,
              branchBoundary: { sessionId, sequence: entry.sequence },
              status: "incomplete",
              reason: result.reason,
            },
      );
      continue;
    }
    if (
      entry.record.type === "run_settled" &&
      entry.record.status === "incomplete" &&
      !terminalNoticeRuns.has(`${sessionId}:${entry.record.runId}`)
    ) {
      terminalNoticeRuns.add(`${sessionId}:${entry.record.runId}`);
      items.push({
        type: "session_notice",
        id: `${sessionId}:${entry.sequence}`,
        sequence: entry.sequence,
        sourceSessionId: sessionId,
        branchBoundary: { sessionId, sequence: entry.sequence },
        status: "incomplete",
        reason: entry.record.reason,
      });
      continue;
    }
    if (entry.record.type !== "model_response_completed") {
      continue;
    }
    const artifactBacked =
      entry.record.response.recordVersion === 2 &&
      (entry.record.response.text.storage === "artifact" ||
        entry.record.response.reasoning?.storage === "artifact");
    if (
      (artifactBacked && !publishedResponses.has(`${sessionId}:${entry.sequence}`)) ||
      (!artifactBacked && !completedInlineRuns.has(`${sessionId}:${entry.record.runId}`))
    ) {
      continue;
    }
    const reasoningField = entry.record.response.reasoning;
    if (reasoningField !== undefined) {
      const reasoningText =
        typeof reasoningField === "string"
          ? reasoningField
          : reasoningField.storage === "inline"
            ? reasoningField.text
            : null;
      const reasoningArtifact =
        typeof reasoningField !== "string" && reasoningField.storage === "artifact"
          ? {
              id: reasoningField.reference.id,
              mediaType: reasoningField.reference.mediaType,
              byteCount: reasoningField.reference.byteCount,
              source: "model_response" as const,
            }
          : null;
      if (reasoningArtifact !== null || (reasoningText !== null && reasoningText.length > 0)) {
        items.push({
          type: "reasoning_block",
          id: reasoningDisplayId(
            sessionId,
            entry.record.runId,
            `${entry.record.turn}:${entry.record.attempt}:provider-reasoning-0`,
          ),
          sequence: entry.sequence,
          sourceSessionId: sessionId,
          branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
          artifactType: "provider_reasoning",
          disclosure: "owner_only",
          provider: providerDisplayName(entry.record.targetIdentity.vendor),
          status: "completed",
          text: reasoningText,
          artifact: reasoningArtifact,
        });
      }
    }
    const text =
      entry.record.response.recordVersion === 2
        ? entry.record.response.text.storage === "inline"
          ? entry.record.response.text.text
          : null
        : entry.record.response.text;
    const artifact =
      entry.record.response.recordVersion === 2 && entry.record.response.text.storage === "artifact"
        ? {
            id: entry.record.response.text.reference.id,
            mediaType: entry.record.response.text.reference.mediaType,
            byteCount: entry.record.response.text.reference.byteCount,
            source: "model_response" as const,
          }
        : null;
    if (artifact === null && (text === null || text.length === 0)) {
      continue;
    }
    items.push({
      type: "assistant_message",
      id: `${sessionId}:${entry.sequence}`,
      sequence: entry.sequence,
      sourceSessionId: sessionId,
      branchBoundary: terminalBoundaries.get(`${sessionId}:${entry.record.runId}`) ?? null,
      text,
      artifact,
    });
  }
  const recordOrder = new Map(
    records.map(
      (record, index) => [`${record.sessionId}:${record.entry.sequence}`, index] as const,
    ),
  );
  const itemOrder = new Map(items.map((item, index) => [item, index] as const));
  const operationLinks: TranscriptItem[] = operations.map(({ display }) => ({
    type: "operation_link",
    id: `operation:${display.operationId}`,
    operationId: display.operationId,
    sequence: display.origin.sourceSequence,
    sourceSessionId: display.origin.sessionId,
    branchBoundary: {
      sessionId: display.origin.sessionId,
      sequence: display.origin.sourceSequence,
    },
  }));
  return [...items, ...operationLinks].sort((left, right) => {
    const leftRecord = recordOrder.get(`${left.sourceSessionId}:${left.sequence}`) ?? Infinity;
    const rightRecord = recordOrder.get(`${right.sourceSessionId}:${right.sequence}`) ?? Infinity;
    if (leftRecord !== rightRecord) {
      return leftRecord - rightRecord;
    }
    if (left.type === "operation_link" && right.type === "operation_link") {
      return left.operationId.localeCompare(right.operationId);
    }
    if (left.type === "operation_link") {
      return 1;
    }
    if (right.type === "operation_link") {
      return -1;
    }
    return (itemOrder.get(left) ?? 0) - (itemOrder.get(right) ?? 0);
  });
}

function projectActiveReasoningSnapshot(input: {
  readonly records: readonly SourcedSessionRecord[];
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedId: string;
  readonly event: Extract<RuntimeEvent, { readonly type: "model_reasoning_updated" }>;
  readonly afterSequence: number;
  readonly provider: string;
}): NonNullable<PresentationTransientState["reasoning"]> | undefined {
  let start: Extract<RuntimeEvent, { readonly type: "model_reasoning_started" }> | undefined;
  let startSequence = 0;
  for (const { entry, sessionId } of input.records) {
    if (
      sessionId !== input.sessionId ||
      entry.schemaVersion !== 3 ||
      entry.record.type !== "runtime_event" ||
      entry.record.runId !== input.runId
    ) {
      continue;
    }
    const event = entry.record.event;
    if (
      event.type === "model_reasoning_started" &&
      reasoningDisplayId(sessionId, input.runId, event.id) === input.expectedId
    ) {
      start = event;
      startSequence = entry.sequence;
      continue;
    }
    if (
      start !== undefined &&
      entry.sequence > startSequence &&
      event.type === "model_reasoning_settled" &&
      event.id === start.id
    ) {
      return undefined;
    }
  }
  if (start === undefined || start.id !== input.event.id) {
    return undefined;
  }
  return {
    id: input.expectedId,
    afterSequence: input.afterSequence,
    artifactType: start.artifactType,
    disclosure: "owner_only",
    provider: input.provider,
    status: "active",
    text: input.event.text,
  };
}

function reasoningDisplayId(
  sessionId: string | null,
  runId: string | null,
  runtimeReasoningId: string,
): string {
  return `${sessionId ?? "unknown-session"}:${runId ?? "unknown-run"}:${runtimeReasoningId}`;
}

function providerDisplayName(vendor: string | undefined): string {
  return vendor === "deepseek" ? "DeepSeek" : (vendor ?? "Provider");
}

async function projectPendingInteractions(
  records: readonly SourcedSessionRecord[],
  options: Pick<CreatePresentationSessionOptions, "stateRoot" | "workspaceRoot">,
): Promise<readonly import("@adam-agent/presentation").PendingInteraction[]> {
  const activeSessionId =
    records.findLast(
      ({ entry }) => entry.schemaVersion === 3 && entry.record.type === "session_genesis",
    )?.sessionId ?? "";
  return Promise.all(
    projectPendingPermissionCandidates(records).map(async (interaction) => ({
      ...interaction,
      canAllow:
        interaction.canAllow ||
        (await isActionableChangePreview(records, activeSessionId, interaction.requestId, options)),
    })),
  );
}

async function isActionableChangePreview(
  records: readonly SourcedSessionRecord[],
  activeSessionId: string,
  requestId: string,
  options: Pick<CreatePresentationSessionOptions, "stateRoot" | "workspaceRoot">,
): Promise<boolean> {
  if (options.stateRoot === undefined) {
    return false;
  }
  const reference = resolveActionableChangePreviewReference(records, activeSessionId, requestId);
  if (reference === null) {
    return false;
  }
  try {
    const bytes = await readFileArtifact({
      root: join(options.stateRoot, "artifacts"),
      id: reference.id,
      maximumBytes: reference.byteCount,
    });
    return bytes?.byteLength === reference.byteCount;
  } catch {
    return false;
  }
}

async function isCurrentActionableChangePreview(
  options: Pick<
    PresentationSessionBaseOptions,
    "lifecycle" | "stateRoot" | "workspaceRoot" | typeof presentationSessionRecordReader
  >,
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const inspected = await options.lifecycle.inspect({ sessionId });
    if (inspected.schemaVersion !== 3) {
      return false;
    }
    return isActionableChangePreview(
      await readActiveBranchRecords(options, sessionId),
      sessionId,
      requestId,
      options,
    );
  } catch {
    return false;
  }
}

function hydrateChangePreviews(
  records: readonly SourcedSessionRecord[],
  options: PresentationSessionRecordOptions,
  changePreviewCache: Map<string, ToolPreviewDisplay | null>,
): Promise<void> | null {
  const pending = collectChangePreviewRequests(records, new Set(changePreviewCache.keys())).map(
    ({ name, reference }) => {
      changePreviewCache.set(reference.id, null);
      return projectChangePreview(name, reference, options).then((preview) => {
        changePreviewCache.set(reference.id, preview);
      });
    },
  );
  return pending.length === 0 ? null : Promise.all(pending).then(() => undefined);
}

async function projectChangePreview(
  name: "write_file" | "edit_file",
  reference: ChangePreviewProjectionRequest["reference"],
  options: PresentationSessionRecordOptions,
): Promise<ToolPreviewDisplay | null> {
  if (
    options.stateRoot === undefined ||
    reference.byteCount <= 0 ||
    !reference.mediaType.startsWith("text/x-diff")
  ) {
    return null;
  }
  try {
    const page = await readFileArtifactRange({
      root: join(options.stateRoot, "artifacts"),
      id: reference.id,
      expectedByteCount: reference.byteCount,
      offset: 0,
      maximumBytes: Math.min(reference.byteCount, presentationArtifactPageMaximumBytes),
    });
    if (page === undefined || page.totalByteCount !== reference.byteCount) {
      return null;
    }
    const decoded = decodeArtifactPage(page.bytes, page.eof);
    return projectChangePreviewPage({
      name,
      referenceByteCount: reference.byteCount,
      decodedText: decoded.text,
      decodedByteCount: decoded.byteCount,
    });
  } catch {
    return null;
  }
}

function safeRunFailureMessage(code: string): string {
  if (code === "tool_effect_indeterminate") {
    return "A tool effect requires inspection before continuing.";
  }
  if (code === "session_persistence_failed") {
    return "The session could not make its result durable.";
  }
  if (code.startsWith("context_") || code.startsWith("token_")) {
    return "The run could not continue within its context limits.";
  }
  if (code === "skill_activation_failed") {
    return "The requested Skill activation failed.";
  }
  return "The model run failed.";
}

function projectRepositoryInstructions(
  snapshot: CurrentSessionSnapshot,
): RepositoryInstructionsDisplay | null {
  const repository = snapshot.promptContext?.repository;
  if (repository === undefined) {
    return null;
  }
  return {
    revision: repository.revision,
    activeScopes: repository.activeScopes,
    sources: repository.sources.map((source) => ({
      scope: source.scope,
      path: source.lexicalPath,
      selectedName: source.selectedName,
      loadReason: source.loadReason,
    })),
    diagnostics: repository.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      ...(diagnostic.scope === undefined ? {} : { scope: diagnostic.scope }),
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      ...(diagnostic.candidate === undefined ? {} : { candidate: diagnostic.candidate }),
    })),
    effectiveDigest: repository.effectiveDigest,
    reloadAvailable: snapshot.status === "idle",
  };
}

function projectSkills(snapshot: CurrentSessionSnapshot): SkillCatalogDisplay | null {
  const skills = snapshot.skillContext;
  if (skills === undefined) {
    return null;
  }
  return projectSkillContext(skills, snapshot.status === "idle");
}

function projectSkillContext(
  skills: NonNullable<CurrentSessionSnapshot["skillContext"]>,
  reloadAvailable: boolean,
): SkillCatalogDisplay {
  const activeQualifiedIds = new Set(
    skills.active
      .filter(
        (activation) =>
          !skills.revocations.some(
            (revocation) => revocation.activationIndex === activation.activationIndex,
          ),
      )
      .map((activation) => activation.qualifiedId),
  );
  return {
    revision: skills.catalog.revision,
    items: skills.catalog.entries.map((entry) => ({
      qualifiedId: entry.qualifiedId,
      name: entry.name,
      description: entry.description,
      source:
        entry.locator.source === "project"
          ? { type: "project", scope: entry.locator.scope }
          : entry.locator.source === "user"
            ? { type: "user" }
            : {
                type: "extension",
                extensionId: entry.locator.extensionId,
                packageName: entry.locator.packageName,
                packageVersion: entry.locator.packageVersion,
              },
      active: activeQualifiedIds.has(entry.qualifiedId),
    })),
    diagnostics: skills.registry.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      source: diagnostic.source,
      ...(diagnostic.scope === undefined ? {} : { scope: diagnostic.scope }),
      ...(diagnostic.extensionId === undefined ? {} : { extensionId: diagnostic.extensionId }),
      ...(diagnostic.packageName === undefined ? {} : { packageName: diagnostic.packageName }),
      ...(diagnostic.packageVersion === undefined
        ? {}
        : { packageVersion: diagnostic.packageVersion }),
      packagePath: diagnostic.packagePath,
      ...(diagnostic.field === undefined ? {} : { field: diagnostic.field }),
      ...(diagnostic.bound === undefined ? {} : { bound: diagnostic.bound }),
    })),
    overflow: {
      omittedCount: skills.catalog.omittedCount,
      shortenedCount: skills.catalog.shortenedCount,
    },
    reloadAvailable,
  };
}

function ambiguousSkillMentionRejection(
  resolution: Extract<ReturnType<typeof resolveSkillMentions>, { readonly status: "ambiguous" }>,
): Extract<CommandReceipt, { readonly status: "rejected" }> {
  const candidates = resolution.candidateQualifiedIds
    .slice(0, 3)
    .map((qualifiedId) => qualifiedId.slice(0, 160))
    .join(", ");
  return {
    status: "rejected",
    code: "invalid_command",
    message: `Skill $${resolution.name} is ambiguous. Select one exact qualified ID with /skills: ${candidates}`,
  };
}

function draftAdmissionRejection(
  failure: unknown,
): Extract<CommandReceipt, { readonly status: "rejected" }> {
  const thinkingPolicyRejection = thinkingPolicyAdmissionRejection(failure);
  if (thinkingPolicyRejection !== null) {
    return thinkingPolicyRejection;
  }
  const code =
    failure instanceof SessionLifecycleError
      ? failure.code
      : typeof failure === "string"
        ? failure
        : null;
  if (code === "session_skill_policy_rejected") {
    return {
      status: "rejected",
      code: "authority_rejected",
      message: "One selected Agent Skill is denied by the draft admission policy.",
    };
  }
  if (code === "session_skill_confirmation_required") {
    return {
      status: "rejected",
      code: "authority_rejected",
      message: "One selected Agent Skill requires confirmation before draft admission.",
    };
  }
  if (code === "session_persistence_failed") {
    return {
      status: "rejected",
      code: "persistence_failed",
      message: "The first prompt could not be persisted as a durable session.",
    };
  }
  if (code === "project_in_use") {
    return {
      status: "rejected",
      code: "conflict",
      message: "Another process is changing this project session state.",
    };
  }
  if (code === "session_invalid" || code === "invalid_run_limits") {
    return {
      status: "rejected",
      code: "invalid_command",
      message: "The first prompt contains invalid draft admission input.",
    };
  }
  if (code === "session_skill_unavailable") {
    return {
      status: "rejected",
      code: "not_available",
      message: "One selected Agent Skill is no longer available for the first prompt.",
    };
  }
  return {
    status: "rejected",
    code: "not_available",
    message: "The exact target or draft resources are no longer available.",
  };
}

function thinkingPolicyAdmissionRejection(
  failure: unknown,
): Extract<CommandReceipt, { readonly code: "thinking_policy_unsupported" }> | null {
  if (
    !(failure instanceof SessionLifecycleError) ||
    failure.code !== "session_thinking_policy_unsupported"
  ) {
    return null;
  }
  const supportedLevelIds = failure.supportedLevelIds ?? [];
  return {
    status: "rejected",
    code: "thinking_policy_unsupported",
    message:
      supportedLevelIds.length === 0
        ? "The requested thinking policy is unavailable for the exact target."
        : `The requested thinking policy is unavailable. Choose ${supportedLevelIds.join(", ")}.`,
    supportedLevelIds,
  };
}

function projectMcp(snapshot: CurrentSessionSnapshot): McpDisplay | null {
  const mcp = snapshot.mcp;
  if (mcp === undefined) {
    return null;
  }
  const activation = "activation" in mcp ? (mcp.activation ?? null) : null;
  const catalog = "catalog" in mcp ? (mcp.catalog ?? null) : null;
  const profile = "profile" in mcp ? (mcp.profile ?? null) : null;
  return {
    schemaVersion: 1,
    status: mcp.status,
    workspaceConfirmed: mcp.workspaceConfirmed,
    source: mcp.source,
    servers: mcp.servers.map((server) => ({
      serverId: server.serverId,
      status: server.status,
      transport: server.transport,
      command:
        server.command.kind === "executable"
          ? { kind: "executable", path: server.command.path }
          : {
              kind: "npm_package",
              packageName: server.command.packageName,
              version: server.command.version,
            },
      arguments: server.arguments,
      cwd: server.cwd,
      requestedEnvironmentNames: server.requestedEnvironmentNames,
      startupEffects: server.startupEffects,
      definitionDigest: server.definitionDigest,
    })),
    activation,
    catalog:
      catalog === null
        ? null
        : {
            status: catalog.status,
            digest: catalog.digest,
            tools: catalog.tools.map((tool) => ({
              serverId: tool.serverId,
              originalName: tool.originalName,
              qualifiedName: tool.qualifiedName,
              description: tool.description,
              rawSchemaDigest: tool.rawSchemaDigest,
              modelProjectionDigest: tool.modelProjectionDigest,
              definitionDigest: tool.definitionDigest,
            })),
          },
    profile,
    diagnostics: mcp.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      ...(diagnostic.serverId === undefined ? {} : { serverId: diagnostic.serverId }),
    })),
  };
}

function projectSessionNaming(
  records: readonly SourcedSessionRecord[],
  sessionId: string,
): SessionNaming {
  const naming = sessionNamingStateFromRecords(
    records
      .filter(({ sessionId: sourceSessionId }) => sourceSessionId === sessionId)
      .map(({ entry }) => entry),
  );
  return {
    manualName: naming.manualName,
    generatedTitle: naming.generatedTitle,
    fallbackTitle: naming.fallbackTitle,
    displayLabel: naming.displayLabel,
    generation: projectSessionTitleGeneration(naming.generation),
  };
}

function projectSessionTitleGeneration(
  generation: SessionNamingHistoryState["generation"],
): SessionNaming["generation"] {
  switch (generation.status) {
    case "not_started":
      return { status: "not_started" };
    case "in_progress":
      return { status: "in_progress", generationId: generation.generationId };
    case "completed":
      return {
        status: "completed",
        generationId: generation.generationId,
        usage: generation.usage,
      };
    case "failed":
      return {
        status: "failed",
        generationId: generation.generationId,
        reason: generation.reason,
      };
    case "skipped_manual":
      return { status: "skipped_manual" };
    default: {
      const unreachable: never = generation;
      return unreachable;
    }
  }
}
