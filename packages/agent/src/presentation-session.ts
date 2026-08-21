import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AuthoritativePresentationSnapshot,
  CommandReceipt,
  McpDisplay,
  PresentationCommand,
  PresentationDisplayState,
  PresentationSession,
  RepositoryInstructionsDisplay,
  SessionSummary,
  SkillCatalogDisplay,
  ToolCallDisplay,
  TranscriptItem,
} from "@adam-agent/presentation";
import { reconcilePresentationUpdate } from "@adam-agent/presentation";
import { readFileArtifact } from "./artifact-store.js";
import type { ModelTargetIdentity, ModelTargets } from "./model-targets.js";
import type { PresentationPreferences } from "./presentation-preferences.js";
import { listProjectPaths } from "./project-path-catalog.js";
import type {
  CurrentSessionSnapshot,
  SessionLifecycle,
  SessionMetadataEvent,
  SessionRuntimeNotification,
} from "./session-lifecycle.js";
import { sessionTitleFallback } from "./session-naming.js";
import { readJsonlSessionRecords, type SessionRecord } from "./session-store.js";
import type { JsonValue, PermissionSubject, ToolEffect } from "./tool-runtime.js";

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

type PresentationSessionBaseOptions = {
  readonly lifecycle: SessionLifecycle;
  readonly modelTargets?: ModelTargets;
  readonly preferences?: PresentationPreferences;
  readonly projectLabel: string;
  readonly stateRoot?: string;
  readonly workspaceRoot: string;
  readonly [presentationHydrationBarrier]?: PresentationHydrationBarrier;
  readonly [presentationRuntimeRefreshBarrier]?: PresentationRuntimeRefreshBarrier;
  readonly [presentationArtifactReadBarrier]?: PresentationArtifactReadBarrier;
  readonly [presentationHistoryPageSize]?: number;
  readonly [presentationCatalogPageSize]?: number;
};

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
    if (options.openProject === true) {
      created = undefined;
    } else if (options.sessionId === undefined) {
      created = await options.lifecycle.create({ targetIdentity: options.targetIdentity });
    } else {
      const inspected = await options.lifecycle.inspect({ sessionId: options.sessionId });
      const existingRecords = await readJsonlSessionRecords({
        sessionId: options.sessionId,
        workspaceRoot: options.workspaceRoot,
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      });
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
    let transcript: readonly TranscriptItem[] = projectTranscript(records);
    const historyPageSize = boundedHistoryPageSize(options[presentationHistoryPageSize]);
    let loadedTranscriptStart = Math.max(0, transcript.length - historyPageSize);
    const naming =
      created === undefined ? undefined : sessionNamingFromRecords(records, created.sessionId);
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
    if (created !== undefined) {
      knownTargets.set(created.targetIdentity.targetId, created.targetIdentity);
    }
    const catalogPage = await options.lifecycle.listProjectSessions({ limit: catalogPageSize });
    const projectPaths = await listProjectPaths(options.workspaceRoot);
    const catalogItems = (
      await Promise.all(
        catalogPage.items.map(async (snapshot) => {
          if (snapshot.schemaVersion !== 3) {
            return null;
          }
          knownTargets.set(snapshot.targetIdentity.targetId, snapshot.targetIdentity);
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
    const authoritative: AuthoritativePresentationSnapshot = {
      schemaVersion: 1,
      continuity: {
        status: "current",
        sessionThroughSequence: created?.lastSequence ?? 0,
        operationThrough: [],
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
      transient: null,
    };
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
    let activeRun:
      | {
          readonly sessionId: string;
          readonly controller: AbortController;
          readonly settlement: Promise<void>;
        }
      | undefined;
    const activateSnapshot = async (snapshot: CurrentSessionSnapshot): Promise<void> => {
      const activatedRecords = await readActiveBranchRecords(options, snapshot.sessionId);
      transcript = projectTranscript(activatedRecords);
      loadedTranscriptStart = Math.max(0, transcript.length - historyPageSize);
      const activatedNaming = sessionNamingFromRecords(activatedRecords, snapshot.sessionId);
      const activatedSummary: SessionSummary = {
        id: snapshot.sessionId,
        label: activatedNaming.displayLabel,
        naming: activatedNaming,
        targetId: snapshot.targetIdentity.targetId,
        status: snapshot.status,
      };
      knownTargets.set(snapshot.targetIdentity.targetId, snapshot.targetIdentity);
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
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity: {
            status: "current",
            sessionThroughSequence: activeSequence,
            operationThrough: [],
          },
          sessions: {
            items: catalogItems,
            nextCursor: state.authoritative.sessions.nextCursor,
          },
          active: {
            session: activatedSummary,
            transcript: transcriptPage(transcript, loadedTranscriptStart, snapshot.sessionId),
            pendingInteractions: await projectPendingInteractions(activatedRecords, options),
            repositoryInstructions: projectRepositoryInstructions(snapshot),
            skills: projectSkills(snapshot),
            projectPaths,
            mcp: projectMcp(snapshot),
          },
        },
        transient: null,
      };
      publishStateChange();
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
      const refreshedNaming = sessionNamingFromRecords(refreshedRecords, sessionId);
      const refreshedSummary: SessionSummary = {
        ...active.session,
        label: refreshedNaming.displayLabel,
        naming: refreshedNaming,
      };
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity: {
            status: "current",
            sessionThroughSequence: throughSequence,
            operationThrough: [],
          },
          sessions: {
            ...state.authoritative.sessions,
            items: state.authoritative.sessions.items.map((session) =>
              session.id === sessionId ? refreshedSummary : session,
            ),
          },
          active: { ...active, session: refreshedSummary },
        },
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
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          continuity: {
            status: "current",
            sessionThroughSequence: Math.max(throughSequence, inspected.lastSequence),
            operationThrough: [],
          },
          active: { ...active, mcp: projectMcp(inspected) },
        },
        transient: state.transient,
      };
      publishStateChange();
    };
    let runtimeRefresh = Promise.resolve();
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
            if (event.type === "user_message" || event.type === "model_message_started") {
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                transient: { activity: "working", assistant: null },
              };
              publishStateChange();
            } else if (event.type === "tool_requested" || event.type === "tool_started") {
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                transient: { activity: "using_tool", assistant: null },
              };
              publishStateChange();
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
            const previousSequence =
              state.authoritative.continuity.status === "current"
                ? state.authoritative.continuity.sessionThroughSequence
                : null;
            if (previousSequence !== null && notification.throughSequence === previousSequence) {
              return;
            }
            if (previousSequence !== null && notification.throughSequence < previousSequence) {
              state = {
                revision: state.revision + 1,
                authoritative: {
                  ...state.authoritative,
                  continuity: { status: "repairing", reason: "gap" },
                },
                transient: null,
              };
              publishStateChange();
            }
            await options[presentationRuntimeRefreshBarrier]?.beforeRead(notification);
            const refreshedRecords = await readActiveBranchRecords(options, active.session.id);
            if (closed) {
              return;
            }
            transcript = projectTranscript(refreshedRecords);
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
                transient: null,
              };
              publishStateChange();
            }
            state = {
              revision: state.revision + 1,
              authoritative: {
                ...state.authoritative,
                continuity: {
                  status: "current",
                  sessionThroughSequence: activeSequence,
                  operationThrough: [],
                },
                active: {
                  ...active,
                  transcript: transcriptPage(transcript, loadedTranscriptStart, active.session.id),
                  pendingInteractions: await projectPendingInteractions(refreshedRecords, options),
                },
              },
              transient: isAssistantTerminalEvent(event) ? null : state.transient,
            };
            publishStateChange();
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
    handleMetadata = async (event) => {
      const active = state.authoritative.active;
      if (
        closed ||
        active === null ||
        event.sessionId !== active.session.id ||
        (state.authoritative.continuity.status === "current" &&
          event.throughSequence <= state.authoritative.continuity.sessionThroughSequence)
      ) {
        return;
      }
      if (event.type === "session_naming_changed") {
        await refreshActiveNaming(event.sessionId, event.throughSequence);
      } else {
        await refreshActiveMcp(event.sessionId, event.throughSequence);
      }
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
        const targetIdentity = knownTargets.get(command.targetId);
        if (targetIdentity === undefined) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The exact target is not available in this Presentation session.",
          };
        }
        try {
          const snapshot = await options.lifecycle.create({ targetIdentity });
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The session could not be created.",
          };
        }
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
        const continuation = options.lifecycle.continue({
          sessionId: command.sessionId,
          input: {
            text: command.text,
            ...(command.skills.length === 0 ? {} : { skills: command.skills }),
          },
          runId: commandId,
          signal: controller.signal,
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
            () => ({ status: "rejected" as const }),
            () => ({ status: "rejected" as const }),
          ),
        ]);
        unsubscribeAdmission();
        if (admitted.status === "rejected") {
          await settlement;
          return {
            status: "rejected",
            code: "not_available",
            message: "The prompt could not be admitted to durable session history.",
          };
        }
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
        if (
          active === null ||
          command.artifact.source !== "change_preview" ||
          !isKnownArtifact(active, command.artifact)
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The requested artifact is no longer part of the active presentation.",
          };
        }
        if (options.stateRoot === undefined || command.artifact.byteCount > 64 * 1024) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The artifact is not available through this Presentation session.",
          };
        }
        try {
          await options[presentationArtifactReadBarrier]?.beforeRead();
          const bytes = await readFileArtifact({
            root: join(options.stateRoot, "artifacts"),
            id: command.artifact.id,
            maximumBytes: command.artifact.byteCount,
          });
          if (bytes === undefined || bytes.byteLength !== command.artifact.byteCount) {
            throw new TypeError("The artifact bytes are unavailable.");
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          await options[presentationArtifactReadBarrier]?.afterRead?.();
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: {
              mediaType: command.artifact.mediaType,
              offset: 0,
              byteCount: bytes.byteLength,
              totalByteCount: bytes.byteLength,
              eof: true,
              text,
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
        unsubscribeLifecycle();
        unsubscribeMetadata();
        await runtimeRefresh;
        await activeRun?.settlement;
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

function isKnownArtifact(
  active: import("@adam-agent/presentation").ActiveSessionDisplay,
  artifact: import("@adam-agent/presentation").ArtifactReference,
): boolean {
  const candidates = [
    ...active.pendingInteractions.flatMap((interaction) =>
      interaction.changePreviewRef === null ? [] : [interaction.changePreviewRef],
    ),
    ...active.transcript.items.flatMap((item) => {
      if (item.type === "assistant_message") {
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
  const naming = sessionNamingFromRecords(records, snapshot.sessionId);
  return {
    id: snapshot.sessionId,
    label: naming.displayLabel,
    naming,
    targetId: snapshot.targetIdentity.targetId,
    status: snapshot.status,
  };
}

async function readActiveBranchRecords(
  options: Pick<CreatePresentationSessionOptions, "stateRoot" | "workspaceRoot">,
  sessionId: string,
  visited: ReadonlySet<string> = new Set(),
): Promise<readonly SourcedSessionRecord[]> {
  if (visited.has(sessionId) || visited.size >= 64) {
    throw new TypeError("The presentation lineage is recursive or too deep.");
  }
  const records = await readJsonlSessionRecords({
    sessionId,
    workspaceRoot: options.workspaceRoot,
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
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

function projectTranscript(records: readonly SourcedSessionRecord[]): readonly TranscriptItem[] {
  const toolDisplays = collectToolDisplays(records);
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
      entry.record.response.text.storage === "artifact";
    if (
      (artifactBacked && !publishedResponses.has(`${sessionId}:${entry.sequence}`)) ||
      (!artifactBacked && !completedInlineRuns.has(`${sessionId}:${entry.record.runId}`))
    ) {
      continue;
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
  return items;
}

type MutableToolDisplay = {
  sessionId: string;
  callId: string;
  sequence?: number;
  name?: string;
  source?: NonNullable<ToolCallDisplay["source"]>;
  effect?: ToolEffect;
  subject?: PermissionSubject;
  status: ToolCallDisplay["status"];
  output?: JsonValue;
  failure?: { readonly code: string; readonly reason?: string; readonly message: string };
  changePreviewRef?: NonNullable<ToolCallDisplay["changePreviewRef"]>;
};

function collectToolDisplays(
  records: readonly SourcedSessionRecord[],
): ReadonlyMap<string, ToolCallDisplay> {
  const tools = new Map<string, MutableToolDisplay>();
  const toolFor = (sessionId: string, callId: string): MutableToolDisplay => {
    const key = `${sessionId}:${callId}`;
    const existing = tools.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableToolDisplay = { sessionId, callId, status: "requested" };
    tools.set(key, created);
    return created;
  };

  for (const { entry, sessionId } of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "model_response_completed") {
      for (const intent of entry.record.response.toolIntents) {
        const tool = toolFor(sessionId, intent.callId);
        tool.name = intent.name;
        tool.source = {
          provenance: "provider_model_response",
          sessionId,
          responseSequence: entry.sequence,
          argumentsDigest: intent.argumentsDigest,
          definitionDigest: intent.definitionDigest ?? null,
          replay: intent.replay,
        };
        if (intent.effect !== undefined) {
          tool.effect = intent.effect;
        }
      }
      continue;
    }
    if (entry.record.type !== "runtime_event") {
      continue;
    }
    const event = entry.record.event;
    if (event.type === "tool_requested") {
      const tool = toolFor(sessionId, event.callId);
      tool.sequence = entry.sequence;
      tool.name = event.name;
    } else if (event.type === "tool_permission_requested") {
      const tool = toolFor(sessionId, event.callId);
      tool.effect = event.effect;
      tool.subject = event.subject;
      tool.status = "permission_required";
      if (event.changePreviewRef !== undefined) {
        tool.changePreviewRef = presentationChangePreviewRef(event.changePreviewRef);
      }
    } else if (event.type === "tool_permission_decided") {
      const tool = toolFor(sessionId, event.callId);
      if (event.effect !== undefined) {
        tool.effect = event.effect;
      }
      if (event.subject !== undefined) {
        tool.subject = event.subject;
      }
      if (event.changePreviewRef !== undefined) {
        tool.changePreviewRef = presentationChangePreviewRef(event.changePreviewRef);
      }
      tool.status = event.decision === "allow" ? "requested" : "denied";
    } else if (event.type === "tool_started") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = "running";
    } else if (event.type === "tool_completed") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = "completed";
      tool.output = event.output;
    } else if (event.type === "tool_failed") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = event.error.code === "permission_denied" ? "denied" : "failed";
      tool.failure = {
        code: event.error.code,
        ...(event.error.code === "tool_effect_indeterminate" ? { reason: event.error.reason } : {}),
        message: boundedDisplayText(event.error.message),
      };
    }
  }

  return new Map(
    [...tools.entries()].flatMap(([key, tool]) => {
      if (tool.sequence === undefined) {
        return [];
      }
      const name = tool.name ?? "unknown";
      const subject = safeToolSubject(tool.subject, tool.output);
      return [
        [
          key,
          {
            type: "tool_call" as const,
            id: `${tool.sessionId}:${tool.sequence}`,
            sequence: tool.sequence,
            sourceSessionId: tool.sessionId,
            branchBoundary: null,
            callId: tool.callId,
            qualifiedName: name,
            kind: toolKind(name),
            effect: tool.effect ?? null,
            label: toolLabel(name),
            subject,
            source: tool.source ?? null,
            durationMs: null,
            status: tool.status,
            outcome: toolOutcome(tool),
            resultSummary:
              tool.failure === undefined
                ? toolResultSummary(name, tool.output)
                : `${tool.failure.code}: ${tool.failure.message}`,
            artifacts: toolArtifacts(tool.output),
            changePreviewRef: tool.changePreviewRef ?? null,
          },
        ] as const,
      ];
    }),
  );
}

function toolOutcome(tool: MutableToolDisplay): ToolCallDisplay["outcome"] {
  if (tool.failure?.code === "tool_effect_indeterminate") {
    return {
      status: "indeterminate",
      code: "tool_effect_indeterminate",
      reason: tool.failure.reason ?? null,
      message: tool.failure.message,
    };
  }
  if (tool.failure !== undefined) {
    return {
      status: "failed",
      code: tool.failure.code,
      message: tool.failure.message,
    };
  }
  if (tool.status === "completed") {
    return { status: "completed" };
  }
  if (tool.status === "denied") {
    return {
      status: "denied",
      code: "permission_denied",
      message: "Permission was denied for this tool call.",
    };
  }
  return null;
}

async function projectPendingInteractions(
  records: readonly SourcedSessionRecord[],
  options: Pick<CreatePresentationSessionOptions, "stateRoot" | "workspaceRoot">,
): Promise<readonly import("@adam-agent/presentation").PendingInteraction[]> {
  const decided = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "tool_permission_decided" &&
      entry.record.event.requestId !== undefined
        ? [`${sessionId}:${entry.record.event.requestId}`]
        : [],
    ),
  );
  const pending = records.flatMap(({ entry, sessionId }) => {
    if (
      entry.schemaVersion !== 3 ||
      entry.record.type !== "runtime_event" ||
      entry.record.event.type !== "tool_permission_requested" ||
      decided.has(`${sessionId}:${entry.record.event.requestId}`)
    ) {
      return [];
    }
    const subject = safeToolSubject(entry.record.event.subject, undefined);
    if (subject === null) {
      return [];
    }
    const changePreviewRef =
      entry.record.event.changePreviewRef === undefined
        ? null
        : presentationChangePreviewRef(entry.record.event.changePreviewRef);
    return [
      {
        type: "permission" as const,
        requestId: entry.record.event.requestId,
        callId: entry.record.event.callId,
        effect: entry.record.event.effect,
        subject,
        canAllow: entry.record.event.effect !== "write",
        changePreviewRef,
        sourceReference: entry.record.event.changePreviewRef,
      },
    ];
  });
  return Promise.all(
    pending.map(async ({ sourceReference: _sourceReference, ...interaction }) => ({
      ...interaction,
      canAllow:
        interaction.canAllow ||
        (await isActionableChangePreview(
          records,
          records.findLast(
            ({ entry }) => entry.schemaVersion === 3 && entry.record.type === "session_genesis",
          )?.sessionId ?? "",
          interaction.requestId,
          options,
        )),
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
  const requested = records.findLast(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "tool_permission_requested" &&
      entry.record.event.requestId === requestId,
  );
  if (
    requested?.entry.schemaVersion !== 3 ||
    requested.entry.record.type !== "runtime_event" ||
    requested.entry.record.event.type !== "tool_permission_requested" ||
    requested.entry.record.event.changePreviewRef === undefined ||
    records.some(
      ({ entry, sessionId }) =>
        sessionId === activeSessionId &&
        entry.schemaVersion === 3 &&
        entry.record.type === "runtime_event" &&
        entry.record.event.type === "tool_permission_decided" &&
        entry.record.event.requestId === requestId,
    )
  ) {
    return false;
  }
  const event = requested.entry.record.event;
  const runId = requested.entry.record.runId;
  const genesis = records.find(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_genesis",
  );
  const response = records.findLast(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "model_response_completed" &&
      entry.record.runId === runId,
  );
  if (
    genesis?.entry.schemaVersion !== 3 ||
    genesis.entry.record.type !== "session_genesis" ||
    response?.entry.schemaVersion !== 3 ||
    response.entry.record.type !== "model_response_completed"
  ) {
    return false;
  }
  const callIndex = response.entry.record.response.toolCalls.findIndex(
    (call) => call.id === event.callId && call.name === event.name,
  );
  const call = response.entry.record.response.toolCalls[callIndex];
  const intent = response.entry.record.response.toolIntents[callIndex];
  const reference = event.changePreviewRef;
  if (
    call === undefined ||
    intent === undefined ||
    reference === undefined ||
    reference.source.projectId !== genesis.entry.record.projectId ||
    reference.source.sessionId !== activeSessionId ||
    reference.source.runId !== runId ||
    reference.source.callId !== event.callId ||
    reference.source.toolName !== event.name ||
    reference.source.argumentsDigest !== intent.argumentsDigest ||
    reference.source.provenance !== "prepared_tool_change"
  ) {
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
  options: Pick<CreatePresentationSessionOptions, "lifecycle" | "stateRoot" | "workspaceRoot">,
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

function presentationChangePreviewRef(
  reference: import("./artifact-store.js").ArtifactReference<
    import("./artifact-store.js").ChangePreviewArtifactSource
  >,
): NonNullable<ToolCallDisplay["changePreviewRef"]> {
  return {
    id: reference.id,
    mediaType: reference.mediaType,
    byteCount: reference.byteCount,
    source: "change_preview",
  };
}

function toolKind(name: string): ToolCallDisplay["kind"] {
  if (name === "read_file") {
    return "read";
  }
  if (name === "run_shell") {
    return "shell";
  }
  if (name === "write_file" || name === "edit_file") {
    return "mutation";
  }
  return name.startsWith("mcp__") ? "mcp" : "unknown";
}

function toolLabel(name: string): string {
  return name === "read_file"
    ? "read"
    : name === "run_shell"
      ? "shell"
      : name === "write_file"
        ? "write"
        : name === "edit_file"
          ? "edit"
          : name;
}

function safeToolSubject(
  subject: PermissionSubject | undefined,
  output: JsonValue | undefined,
): ToolCallDisplay["subject"] {
  if (subject?.type === "file" || subject?.type === "workspace_path") {
    return { type: "path", value: subject.path };
  }
  if (subject?.type === "command") {
    return { type: "command", value: subject.command };
  }
  const outputRecord = jsonRecord(output);
  const outputPath = outputRecord?.path;
  if (typeof outputPath === "string") {
    return { type: "path", value: outputPath };
  }
  return subject === undefined ? null : { type: "generic", value: subject.type };
}

function toolResultSummary(name: string, output: JsonValue | undefined): string | null {
  const outputRecord = jsonRecord(output);
  if (name === "read_file" && typeof outputRecord?.content === "string") {
    return `${Buffer.byteLength(outputRecord.content, "utf8")} bytes`;
  }
  if (name === "run_shell") {
    const termination = jsonRecord(outputRecord?.termination);
    const stdout = jsonRecord(outputRecord?.stdout);
    if (
      termination?.type === "exited" &&
      typeof termination.exitCode === "number" &&
      typeof stdout?.totalBytes === "number"
    ) {
      return `exit ${termination.exitCode} · ${stdout.totalBytes} stdout bytes`;
    }
  }
  return output === undefined ? null : "Completed";
}

function boundedDisplayText(value: string): string {
  return [...value.replaceAll(/\s+/gu, " ").trim()].slice(0, 240).join("");
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

function toolArtifacts(
  output: JsonValue | undefined,
): readonly ToolCallDisplay["artifacts"][number][] {
  const outputRecord = jsonRecord(output);
  const candidates = [
    jsonRecord(jsonRecord(outputRecord?.stdout)?.artifact),
    jsonRecord(jsonRecord(outputRecord?.stderr)?.artifact),
  ];
  return candidates.flatMap((candidate) => {
    const id = candidate?.id;
    const mediaType = candidate?.mediaType;
    const byteCount = candidate?.byteCount;
    return typeof id === "string" && typeof mediaType === "string" && typeof byteCount === "number"
      ? [{ id, mediaType, byteCount, source: "tool_output" as const }]
      : [];
  });
}

type KnownJsonRecord = Readonly<Record<string, JsonValue>> & {
  readonly path?: JsonValue;
  readonly content?: JsonValue;
  readonly termination?: JsonValue;
  readonly stdout?: JsonValue;
  readonly stderr?: JsonValue;
  readonly artifact?: JsonValue;
  readonly type?: JsonValue;
  readonly exitCode?: JsonValue;
  readonly totalBytes?: JsonValue;
  readonly id?: JsonValue;
  readonly mediaType?: JsonValue;
  readonly byteCount?: JsonValue;
};

function jsonRecord(value: JsonValue | undefined): KnownJsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as KnownJsonRecord)
    : undefined;
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
      packagePath: diagnostic.packagePath,
    })),
    overflow: {
      omittedCount: skills.catalog.omittedCount,
      shortenedCount: skills.catalog.shortenedCount,
    },
    reloadAvailable: snapshot.status === "idle",
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

function sessionNamingFromRecords(
  records: readonly SourcedSessionRecord[],
  sessionId: string,
): SessionSummary["naming"] {
  const firstRun = records.find(
    ({ entry, sessionId: sourceSessionId }) =>
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "logical_run_started",
  );
  const genesis = records.find(
    ({ entry, sessionId: sourceSessionId }) =>
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_genesis",
  );
  const genesisFallback =
    genesis?.entry.schemaVersion === 3 && genesis.entry.record.type === "session_genesis"
      ? (genesis.entry.record.naming?.fallbackTitle ?? null)
      : null;
  const fallbackTitle =
    genesisFallback ??
    (firstRun?.entry.schemaVersion === 3 && firstRun.entry.record.type === "logical_run_started"
      ? (firstRun.entry.record.naming?.fallbackTitle ??
        sessionTitleFallback(firstRun.entry.record.userMessage))
      : null);
  let manualName: string | null = null;
  let generatedTitle: string | null = null;
  let generation: SessionSummary["naming"]["generation"] = { status: "not_started" };
  for (const { entry, sessionId: sourceSessionId } of records) {
    if (
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      (entry.record.type === "session_manual_name_set" ||
        entry.record.type === "session_manual_name_cleared")
    ) {
      manualName = entry.record.type === "session_manual_name_set" ? entry.record.name : null;
    }
    if (
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_title_generation_started"
    ) {
      generation = { status: "in_progress", generationId: entry.record.generationId };
    }
    if (
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_title_generation_completed"
    ) {
      generatedTitle = entry.record.title;
      generation = {
        status: "completed",
        generationId: entry.record.generationId,
        usage: entry.record.usage,
      };
    }
    if (
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_title_generation_skipped_manual"
    ) {
      generation = { status: "skipped_manual" };
    }
    if (
      sourceSessionId === sessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_title_generation_failed"
    ) {
      generation = {
        status: "failed",
        generationId: entry.record.generationId,
        reason: entry.record.reason,
      };
    }
  }
  return {
    manualName,
    generatedTitle,
    fallbackTitle,
    displayLabel: manualName ?? generatedTitle ?? fallbackTitle ?? "New session",
    generation,
  };
}
