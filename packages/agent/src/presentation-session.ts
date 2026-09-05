import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ArtifactChunk,
  ArtifactRange,
  ArtifactReference,
  AuthoritativePresentationSnapshot,
  CommandReceipt,
  McpDisplay,
  PendingInteraction,
  PresentationCommand,
  PresentationDisplayState,
  PresentationSession,
  RepositoryInstructionsDisplay,
  SessionHistoryDiagnosticsDisplay,
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
import { createFileTurnComposerResourceStager } from "./input-resource-staging.js";
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
import {
  projectActiveReasoningSnapshot,
  projectTranscript,
  providerDisplayName,
  reasoningDisplayId,
} from "./presentation-transcript-projection.js";
import { listProjectPaths } from "./project-path-catalog.js";
import {
  createRecoverableTurnDraftRepository,
  type RecoverableTurnDraftRepository,
  type TurnDraftScopeV1,
} from "./recoverable-turn-draft.js";
import {
  type SessionNamingHistoryState,
  sessionNamingStateFromRecords,
} from "./session-history-folds.js";
import {
  type CurrentSessionSnapshot,
  effectiveSessionStateRoot,
  type ManagedAgentControlReceipt,
  type ManagedAgentNotification,
  type ManagedAgentTranscriptRecords,
  type SessionContextUsageSnapshot,
  type SessionHistoryDiagnostics,
  type SessionLifecycle,
  SessionLifecycleError,
  type SessionMetadataEvent,
  type SessionRuntimeNotification,
  sessionManagedAgentTranscriptReader,
} from "./session-lifecycle.js";
import { readJsonlSessionRecords, type SessionRecord } from "./session-store.js";
import { todoStoreSnapshotFromRecordsV1, todoSummaryV1 } from "./todo.js";
import {
  createTurnComposer,
  type TurnComposer,
  TurnComposerError,
  type TurnComposerStageBarrier,
  turnComposerStageBarrier,
} from "./turn-composer.js";
import type { WebHttpAdapter } from "./web-evidence.js";
import { createSafeWebHttpAdapter } from "./web-safe-http.js";
import {
  createWebSearchConfigurationController,
  normalizeWebSyntheticDnsRange,
  type WebSearchConfigurationSnapshot,
} from "./web-search-configuration.js";

/** Tests only. Production hydration has no artificial publication barrier. */
export const presentationHydrationBarrier = Symbol("adam-agent.presentation-hydration-barrier");
export const presentationHistoryPageSize = Symbol("adam-agent.presentation-history-page-size");
export const presentationCatalogPageSize = Symbol("adam-agent.presentation-catalog-page-size");
export const presentationManagedAgentTranscriptPageSize = Symbol(
  "adam-agent.presentation-managed-agent-transcript-page-size",
);
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
  afterAdmissionSnapshot?(): Promise<void>;
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
  readonly draftPersistencePolicy?: "process_only" | "recoverable";
  readonly lifecycle: SessionLifecycle;
  readonly modelTargets?: ModelTargets;
  readonly operations?: OperationHost;
  readonly projectChanges?: Pick<ExtensionHost, "startProjectChanges">;
  readonly preferences?: PresentationPreferences;
  readonly projectLabel: string;
  readonly stateRoot?: string;
  readonly workspaceRoot: string;
  readonly webHttp?: WebHttpAdapter;
  readonly webSearchEnvironment?: NodeJS.ProcessEnv;
  readonly [presentationHydrationBarrier]?: PresentationHydrationBarrier;
  readonly [presentationRuntimeRefreshBarrier]?: PresentationRuntimeRefreshBarrier;
  readonly [presentationArtifactReadBarrier]?: PresentationArtifactReadBarrier;
  readonly [presentationSessionRecordReader]?: PresentationSessionRecordReader;
  readonly [presentationHistoryPageSize]?: number;
  readonly [presentationCatalogPageSize]?: number;
  readonly [presentationManagedAgentTranscriptPageSize]?: number;
  readonly [turnComposerStageBarrier]?: TurnComposerStageBarrier;
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
  const webSearchConfiguration =
    options.webSearchEnvironment === undefined
      ? undefined
      : createWebSearchConfigurationController({ environment: options.webSearchEnvironment });
  const webHttp =
    options.webHttp ??
    createSafeWebHttpAdapter({
      async resolveAllowedHostnameRanges() {
        const snapshot = await webSearchConfiguration?.load();
        return snapshot?.syntheticDnsRange === null || snapshot?.syntheticDnsRange === undefined
          ? []
          : [snapshot.syntheticDnsRange];
      },
    });
  const managedAgentTranscriptPageSize = Math.min(
    100,
    Math.max(1, options[presentationManagedAgentTranscriptPageSize] ?? 20),
  );
  const changePreviewCache = new Map<string, ToolPreviewDisplay | null>();
  const managedPermissionInteractions = new Map<string, PendingInteraction>();
  const withManagedPermissionInteractions = (
    interactions: readonly PendingInteraction[],
  ): readonly PendingInteraction[] => [
    ...interactions.filter(
      (interaction) => !managedPermissionInteractions.has(interaction.requestId),
    ),
    ...managedPermissionInteractions.values(),
  ];
  const bufferedEvents: SessionRuntimeNotification[] = [];
  const bufferedManagedAgentEvents: ManagedAgentNotification[] = [];
  const bufferedMetadata: SessionMetadataEvent[] = [];
  let handleRuntime: ((notification: SessionRuntimeNotification) => void) | undefined;
  let handleMetadata: ((event: SessionMetadataEvent) => Promise<void>) | undefined;
  let handleManagedAgentEvent: ((input: ManagedAgentNotification) => void) | undefined;
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
  const unsubscribeManagedAgentEvents =
    options.lifecycle.subscribeManagedAgentEvents?.((input) => {
      if (handleManagedAgentEvent === undefined) {
        bufferedManagedAgentEvents.push(input);
        return;
      }
      handleManagedAgentEvent(input);
    }) ?? (() => {});

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
        const resumed = await options.lifecycle.resume({
          sessionId: options.sessionId,
          preserveInterruptedEffects: true,
        });
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
      projectedOperations.map(({ display }) => display),
      projectToolDisplays(records, changePreviewCache),
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
    type ConfiguredPreferences = Awaited<ReturnType<PresentationPreferences["load"]>>;
    type ConfiguredTargetContext = {
      readonly official: ModelTargetSnapshot["targets"][number]["contextProfile"];
      readonly effective: ModelTargetSnapshot["targets"][number]["contextProfile"] | null;
      readonly source: {
        readonly contextWindowTokens: "default" | "user";
        readonly maximumOutputTokens: "default" | "user";
        readonly compactAtTokens: "default" | "user";
      };
      readonly diagnostic: { readonly code: string; readonly message: string } | null;
    };
    const projectConfiguredTargetContexts = async (
      preferencesSnapshot: ConfiguredPreferences | undefined,
    ): Promise<ReadonlyMap<string, ConfiguredTargetContext>> => {
      const contexts = new Map<string, ConfiguredTargetContext>();
      if (preferencesSnapshot === undefined || options.preferences === undefined) {
        return contexts;
      }
      for (const target of modelTargetSnapshot?.targets ?? []) {
        let effective: ModelTargetSnapshot["targets"][number]["contextProfile"] | null = null;
        let diagnostic: { readonly code: string; readonly message: string } | null =
          preferencesSnapshot.diagnostic;
        if (diagnostic === null) {
          try {
            effective = await options.preferences.resolveContextProfile(target.contextProfile);
          } catch {
            diagnostic = {
              code: "user_model_configuration_invalid",
              message: "The saved model configuration is incompatible with this target.",
            };
          }
        }
        contexts.set(target.identity.targetId, {
          official: target.contextProfile,
          effective,
          source: {
            contextWindowTokens:
              preferencesSnapshot.modelPolicy.contextWindowTokens !== null ||
              (effective !== null &&
                effective.contextWindowTokens !== target.contextProfile.contextWindowTokens)
                ? "user"
                : "default",
            maximumOutputTokens:
              preferencesSnapshot.modelPolicy.maximumOutputTokens !== null ||
              (effective !== null &&
                effective.maximumOutputTokens !== target.contextProfile.maximumOutputTokens)
                ? "user"
                : "default",
            compactAtTokens:
              preferencesSnapshot.modelPolicy.automaticCompactionWindowTokens !== null ||
              (effective !== null &&
                effective.compactAtTokens !== target.contextProfile.compactAtTokens)
                ? "user"
                : "default",
          },
          diagnostic,
        });
      }
      return contexts;
    };
    const resolvePreferenceDiagnostic = (
      preferencesSnapshot: ConfiguredPreferences | undefined,
    ): { readonly code: string; readonly message: string } | null => {
      if (preferencesSnapshot === undefined) {
        return null;
      }
      const configuredTarget = modelTargetSnapshot?.targets.find(
        (target) => target.identity.targetId === preferencesSnapshot.defaultTargetId,
      );
      return (
        preferencesSnapshot.diagnostic ??
        (preferencesSnapshot.defaultTargetId !== null && configuredTarget === undefined
          ? {
              code: "target_configuration_invalid",
              message: "The saved default target is not in the current target catalog.",
            }
          : configuredTarget?.readiness.status === "missing"
            ? {
                code: "target_configuration_invalid",
                message: "The saved default target is missing its required credential.",
              }
            : null)
      );
    };
    let configuredPreferences = await options.preferences?.load();
    let configuredWebSearch = await webSearchConfiguration?.load();
    let configuredTargetContexts = await projectConfiguredTargetContexts(configuredPreferences);
    let preferenceDiagnostic = resolvePreferenceDiagnostic(configuredPreferences);
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
    const workspaceTrustSnapshot = await options.lifecycle.inspectWorkspaceTrust();
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
    const initialManagedAgents =
      created === undefined
        ? { counts: { active: 0, terminal: 0, attention: 0 }, agents: [] }
        : await options.lifecycle.inspectManagedAgents({ sessionId: created.sessionId });
    const initialRecovery =
      created?.status !== "interrupted"
        ? null
        : await options.lifecycle.inspectInterruptedSession({ sessionId: created.sessionId });
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
      project: {
        id: workspaceTrustSnapshot.projectId ?? catalogPage.projectId,
        label: workspaceTrustSnapshot.projectLabel,
        workspaceTrust: {
          status: workspaceTrustSnapshot.status,
          diagnostic: workspaceTrustSnapshot.diagnostic,
        },
      },
      targets: {
        items: (modelTargetSnapshot?.targets ?? []).map((target) => {
          const context = configuredTargetContexts.get(target.identity.targetId);
          const catalog = target.catalog ?? {
            displayName: "Unknown model target",
            summary: "No catalog description is available.",
            capabilities: [],
            modalities: [],
            recommended: false,
          };
          return {
            targetId: target.identity.targetId,
            label: target.identity.modelId,
            provider: target.identity.vendor,
            displayName: catalog.displayName,
            summary: catalog.summary,
            capabilities: catalog.capabilities,
            modalities: catalog.modalities,
            recommended: catalog.recommended,
            route: target.identity.route,
            certification:
              target.identity.certification === "certified" ? "Certified" : "Experimental",
            ...(target.upstreamLifecycle === undefined
              ? {}
              : {
                  upstreamLifecycle:
                    target.upstreamLifecycle === "experimental" ? "Experimental" : "Stable",
                }),
            ...(target.connectionTest === undefined
              ? {}
              : {
                  connection: {
                    configured:
                      target.readiness.status === "available"
                        ? ("Configured" as const)
                        : ("Not configured" as const),
                    reachability: "Not tested" as const,
                    checkedAt: null,
                    diagnostic: null,
                  },
                }),
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
            ...(context === undefined ? {} : { context }),
          };
        }),
        defaultTargetId: configuredPreferences?.defaultTargetId ?? null,
        diagnostic: preferenceDiagnostic,
        ...(configuredPreferences === undefined && configuredWebSearch === undefined
          ? {}
          : {
              configuration: {
                modelPolicy: configuredPreferences?.modelPolicy ?? emptyUserModelPolicyDisplay(),
                ...(configuredWebSearch === undefined
                  ? {}
                  : { webSearch: projectWebSearchConfiguration(configuredWebSearch) }),
              },
            }),
      },
      sessions: {
        items: initialCatalogItems,
        nextCursor: catalogPage.nextCursor,
        diagnostics: projectSessionHistoryDiagnostics(catalogPage.diagnostics),
      },
      managedAgents: initialManagedAgents,
      active:
        created === undefined || summary === undefined
          ? null
          : {
              session: summary,
              ...(initialRecovery === null ? {} : { recovery: initialRecovery }),
              transcript: transcriptPage(transcript, loadedTranscriptStart, created.sessionId),
              linkedOperations: projectedOperations.map(({ display }) => display),
              linkedOperationsTruncated: initialOperationProjection.truncated,
              context: projectSessionContext(created, initialContextUsage, modelTargetSnapshot),
              pendingInteractions: withManagedPermissionInteractions(
                await projectPendingInteractions(records, options),
              ),
              repositoryInstructions: projectRepositoryInstructions(created),
              skills: projectSkills(created),
              projectPaths,
              mcp: projectMcp(created),
              ...(created.todo === undefined ? {} : { todo: created.todo }),
              ...(created.plan === undefined ? {} : { plan: created.plan }),
            },
    };
    let attachmentAvailable = initialDraft !== null || sessionSupportsInputResources(created);
    let attachmentUnavailableReason = attachmentAvailable
      ? null
      : "New session required for attachments";
    let planRevisionIntent: PresentationDisplayState["composer"]["revisionIntent"] = null;
    let state: PresentationDisplayState = {
      revision: 1,
      authoritative,
      draft:
        initialDraft === null
          ? null
          : {
              targetId: initialDraft.targetIdentity.targetId,
              mode: "default",
              skills: projectSkillContext(initialDraft.skillContext, false),
              projectPaths,
            },
      composer: {
        attachmentAvailable,
        draftRevision: 0,
        elements: [],
        renderedText: "",
        unavailableReason: attachmentUnavailableReason,
        sealed: false,
        revisionIntent: planRevisionIntent,
        resources: [],
        pastedTexts: [],
      },
      transient: null,
    };
    let managedAgentActivity: NonNullable<PresentationDisplayState["managedAgentActivity"]> = [];
    let draftTargetIdentity: ModelTargetIdentity | null = initialDraft?.targetIdentity ?? null;
    const metadataThrough = new Map<string, number>();
    if (created !== undefined) {
      metadataThrough.set(`session_naming_changed:${created.sessionId}`, created.lastSequence);
      metadataThrough.set(`mcp_configuration_changed:${created.sessionId}`, created.lastSequence);
    }
    const listeners = new Set<() => void>();
    let closed = false;
    const publishStateChange = (): void => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Presentation observers cannot change authoritative command or refresh outcomes.
        }
      }
    };
    type TargetConnection = NonNullable<
      AuthoritativePresentationSnapshot["targets"]["items"][number]["connection"]
    >;
    const activeConnectionTests = new Map<
      string,
      {
        readonly controller: AbortController;
        readonly previous: TargetConnection;
        settlement?: Promise<CommandReceipt>;
      }
    >();
    let activeWebSearchTest:
      | {
          readonly controller: AbortController;
          settlement?: Promise<CommandReceipt>;
        }
      | undefined;
    const publishTargetConnection = (targetId: string, connection: TargetConnection): boolean => {
      if (closed) {
        return false;
      }
      const target = state.authoritative.targets.items.find(
        (candidate) => candidate.targetId === targetId,
      );
      if (target?.connection === undefined) {
        return false;
      }
      state = {
        revision: state.revision + 1,
        authoritative: {
          ...state.authoritative,
          targets: {
            ...state.authoritative.targets,
            items: state.authoritative.targets.items.map((candidate) =>
              candidate.targetId === targetId ? { ...candidate, connection } : candidate,
            ),
          },
        },
        draft: state.draft,
        composer: state.composer,
        transient: state.transient,
      };
      publishStateChange();
      return true;
    };
    let turnComposer: TurnComposer;
    const projectTurnComposer = (
      skillCatalogOverride?: SkillCatalogDisplay | null,
    ): PresentationDisplayState["composer"] => {
      const snapshot = turnComposer?.snapshot() ?? {
        sealed: false,
        resources: [],
        pastedTexts: [],
      };
      const skillCatalog =
        skillCatalogOverride === undefined
          ? (state.authoritative.active?.skills ?? state.draft?.skills ?? null)
          : skillCatalogOverride;
      return {
        attachmentAvailable,
        draftRevision: snapshot.revision,
        elements: snapshot.elements.map((element) =>
          element.type === "skill"
            ? {
                ...element,
                available:
                  skillCatalog?.items.some(
                    (skill) =>
                      skill.qualifiedId === element.qualifiedId && skill.name === element.name,
                  ) ?? false,
              }
            : element,
        ),
        renderedText: snapshot.renderedText,
        unavailableReason: attachmentUnavailableReason,
        sealed: snapshot.sealed,
        revisionIntent: planRevisionIntent,
        resources: snapshot.resources,
        pastedTexts: snapshot.pastedTexts,
      };
    };
    turnComposer = await createTurnComposer({
      onChange() {
        if (closed) {
          return;
        }
        state = {
          ...state,
          revision: state.revision + 1,
          composer: projectTurnComposer(),
        };
        publishStateChange();
      },
      stager: await createFileTurnComposerResourceStager({
        artifactRoot: join(effectiveSessionStateRoot(options.stateRoot), "artifacts"),
        ...(options[turnComposerStageBarrier] === undefined
          ? {}
          : { stageBarrier: options[turnComposerStageBarrier] }),
      }),
    });
    const recoverableDrafts: RecoverableTurnDraftRepository | null =
      options.draftPersistencePolicy === "process_only"
        ? null
        : await createRecoverableTurnDraftRepository({
            projectId: state.authoritative.project.id,
            stateRoot: effectiveSessionStateRoot(options.stateRoot),
          });
    const currentDraftScope = (): TurnDraftScopeV1 | null => {
      const active = state.authoritative.active;
      if (active !== null) {
        return { type: "session", sessionId: active.session.id };
      }
      return state.draft === null ? null : { type: "new_session" };
    };
    const persistCurrentTurnDraft = async (): Promise<void> => {
      const scope = currentDraftScope();
      if (recoverableDrafts === null || scope === null) {
        return;
      }
      const snapshot = turnComposer.snapshot();
      if (snapshot.elements.length === 0) {
        await recoverableDrafts.delete(scope);
        return;
      }
      await recoverableDrafts.save(
        await turnComposer.captureDraft(
          scope.type === "new_session"
            ? { type: "new_session", targetId: state.draft?.targetId ?? "" }
            : scope,
        ),
      );
    };
    const persistSettledCurrentTurnDraft = async (): Promise<void> => {
      if (
        turnComposer
          .snapshot()
          .resources.every(
            (resource) => resource.state === "ready" || resource.state === "failed",
          ) &&
        turnComposer
          .snapshot()
          .pastedTexts.every(
            (pastedText) => pastedText.state === "ready" || pastedText.state === "failed",
          )
      ) {
        await persistCurrentTurnDraft();
      }
    };
    const loadTurnDraft = async (scope: TurnDraftScopeV1, targetId?: string) => {
      const recovered = await recoverableDrafts?.load(scope);
      if (
        recovered === undefined ||
        recovered === null ||
        (recovered.scope.type === "new_session" && recovered.scope.targetId !== targetId)
      ) {
        return null;
      }
      return recovered;
    };
    const expandedDraftFitsExactTarget = (commandText: string): boolean => {
      if (state.composer.pastedTexts.length === 0) {
        return true;
      }
      const active = state.authoritative.active;
      const targetId = active?.session.targetId ?? state.draft?.targetId;
      const target = state.authoritative.targets.items.find(
        (candidate) => candidate.targetId === targetId,
      );
      const profile =
        active?.context?.profile ??
        target?.context?.effective ??
        target?.context?.official ??
        modelTargetSnapshot?.targets.find((candidate) => candidate.identity.targetId === targetId)
          ?.contextProfile;
      if (profile === undefined) {
        return false;
      }
      try {
        const literalText = state.composer.elements
          .flatMap((element) => (element.type === "text" ? [element.text] : []))
          .join("");
        const prospectiveBytes =
          Buffer.byteLength(turnComposer.readExpandedText(), "utf8") +
          (literalText === commandText ? 0 : Buffer.byteLength(commandText, "utf8"));
        const estimatedInputTokens = Math.ceil(prospectiveBytes / 4);
        return estimatedInputTokens + profile.maximumOutputTokens < profile.contextWindowTokens;
      } catch {
        return false;
      }
    };
    const draftImagesFitExactTarget = (): boolean => {
      if (!state.composer.resources.some((resource) => resource.kind === "image")) {
        return true;
      }
      const targetId = state.authoritative.active?.session.targetId ?? state.draft?.targetId;
      return (
        state.authoritative.targets.items
          .find((candidate) => candidate.targetId === targetId)
          ?.modalities.includes("image") === true
      );
    };
    const initialDraftScope = currentDraftScope();
    if (initialDraftScope !== null) {
      const recovered = await loadTurnDraft(initialDraftScope, state.draft?.targetId);
      if (recovered !== null) {
        await turnComposer.restoreDraft(recovered);
      }
    }
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
        composer: state.composer,
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
          composer: state.composer,
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
        composer: state.composer,
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
            composer: state.composer,
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
            composer: state.composer,
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
            composer: state.composer,
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
          composer: state.composer,
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
          settlement: Promise<void> | null;
          recovery?: boolean;
        }
      | undefined;
    let activePlanCommand:
      | {
          readonly key: string;
          readonly receipt: Promise<CommandReceipt>;
        }
      | undefined;
    let snapshotActivationQueue = Promise.resolve();
    let lastSnapshotActivation =
      created === undefined
        ? undefined
        : { sessionId: created.sessionId, throughSequence: created.lastSequence };
    const activateSnapshotNow = async (snapshot: CurrentSessionSnapshot): Promise<void> => {
      // Admission cleanup may finish after the same run's terminal projection.
      // A late snapshot must not rewind canonical Run/editor truth.
      if (
        state.authoritative.active?.session.id === snapshot.sessionId &&
        lastSnapshotActivation?.sessionId === snapshot.sessionId &&
        snapshot.lastSequence < lastSnapshotActivation.throughSequence
      ) {
        return;
      }
      const activatedRecovery =
        snapshot.status === "interrupted"
          ? await options.lifecycle.inspectInterruptedSession({
              sessionId: snapshot.sessionId,
            })
          : null;
      const activatedRecords = await readActiveBranchRecords(options, snapshot.sessionId);
      const activatedOperationProjection = await projectLinkedOperations(
        options.operations,
        activatedRecords,
      );
      const activatedOperations = activatedOperationProjection.items;
      const activatedContextUsage = await options.lifecycle.inspectContextUsage({
        sessionId: snapshot.sessionId,
      });
      const activatedManagedAgents = await options.lifecycle.inspectManagedAgents({
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
        activatedOperations.map(({ display }) => display),
        projectToolDisplays(activatedRecords, changePreviewCache),
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
      const activatedSkills = projectSkills(snapshot);
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
      attachmentAvailable = sessionSupportsInputResources(snapshot);
      attachmentUnavailableReason = attachmentAvailable
        ? null
        : "New session required for attachments";
      const revisionPlan = snapshot.plan;
      if (
        planRevisionIntent !== null &&
        (revisionPlan?.state !== "ready" ||
          planRevisionIntent.sessionId !== snapshot.sessionId ||
          planRevisionIntent.cycleId !== revisionPlan.cycleId ||
          planRevisionIntent.revision !== revisionPlan.revision ||
          planRevisionIntent.planId !== revisionPlan.submission.planId ||
          planRevisionIntent.contentDigest !== revisionPlan.submission.contentDigest)
      ) {
        planRevisionIntent = null;
      }
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
          managedAgents: activatedManagedAgents,
          active: {
            session: activatedSummary,
            ...(activatedRecovery === null ? {} : { recovery: activatedRecovery }),
            transcript: transcriptPage(transcript, loadedTranscriptStart, snapshot.sessionId),
            linkedOperations: activatedOperations.map((operation) => operation.display),
            linkedOperationsTruncated: activatedOperationProjection.truncated,
            context: projectSessionContext(snapshot, activatedContextUsage, modelTargetSnapshot),
            pendingInteractions: withManagedPermissionInteractions(activatedPendingInteractions),
            repositoryInstructions: projectRepositoryInstructions(snapshot),
            skills: activatedSkills,
            projectPaths,
            mcp: projectMcp(snapshot),
            ...(snapshot.todo === undefined ? {} : { todo: snapshot.todo }),
            ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
          },
        },
        draft: null,
        composer: projectTurnComposer(activatedSkills),
        transient:
          activeRun === undefined
            ? null
            : (state.transient ?? { activity: "working", assistant: null, reasoning: null }),
      };
      draftTargetIdentity = null;
      lastSnapshotActivation = {
        sessionId: snapshot.sessionId,
        throughSequence: snapshot.lastSequence,
      };
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
    const recoverAdmittedRunSnapshot = async (sessionId: string): Promise<void> => {
      if (closed) {
        return;
      }
      try {
        const inspected = await options.lifecycle.inspect({ sessionId });
        if (inspected.schemaVersion === 3) {
          await activateSnapshot(inspected);
        }
      } catch {
        const activeSessionId = state.authoritative.active?.session.id;
        if (closed || (activeSessionId !== undefined && activeSessionId !== sessionId)) {
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
          composer: state.composer,
          transient: null,
        };
        publishStateChange();
      }
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
        composer: state.composer,
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
        composer: state.composer,
        transient: state.transient,
      };
      publishStateChange();
    };
    let runtimeRefresh = Promise.resolve();
    let managedAgentRefresh = Promise.resolve();
    let metadataRefresh = Promise.resolve();
    const seenRuntimeNotificationIds = new Set<string>();
    const runtimeNotificationOrder: string[] = [];
    const refreshManagedAgents = (parentSessionId: string) => {
      managedAgentRefresh = managedAgentRefresh
        .catch(() => undefined)
        .then(async () => {
          const active = state.authoritative.active;
          if (closed || active === null || active.session.id !== parentSessionId) {
            return;
          }
          const managedAgents = await options.lifecycle.inspectManagedAgents({
            sessionId: parentSessionId,
          });
          const current = state.authoritative.active;
          if (closed || current === null || current.session.id !== parentSessionId) {
            return;
          }
          managedAgentActivity = managedAgentActivity.filter((activity) =>
            managedAgents.agents.some(
              (agent) =>
                agent.agentId === activity.agentId &&
                agent.attemptId === activity.attemptId &&
                agent.phase !== "terminal",
            ),
          );
          state = {
            ...state,
            revision: state.revision + 1,
            authoritative: { ...state.authoritative, managedAgents },
          };
          publishStateChange();
        });
      void managedAgentRefresh.catch(() => undefined);
    };
    handleManagedAgentEvent = (notification) => {
      const { parentSessionId } = notification;
      const active = state.authoritative.active;
      if (closed || active === null || active.session.id !== parentSessionId) {
        return;
      }
      refreshManagedAgents(parentSessionId);
      if (notification.type === "state_changed") {
        return;
      }
      if (notification.type === "child_runtime_event") {
        const { agentId, attemptId, childSessionId, event } = notification;
        const current = managedAgentActivity.find(
          (activity) => activity.agentId === agentId && activity.attemptId === attemptId,
        );
        let projected = current;
        if (event.type === "model_message_started") {
          projected = {
            agentId,
            attemptId,
            childSessionId,
            activity: "replying",
            assistant: { itemId: `${attemptId}:assistant`, text: "" },
          };
        } else if (event.type === "model_message_delta") {
          projected = {
            agentId,
            attemptId,
            childSessionId,
            activity: "replying",
            assistant: {
              itemId: current?.assistant?.itemId ?? `${attemptId}:assistant`,
              text: boundedManagedAgentActivityText(
                `${current?.assistant?.text ?? ""}${event.text}`,
                16 * 1024,
              ),
            },
          };
        } else if (event.type === "model_reasoning_started") {
          projected = {
            agentId,
            attemptId,
            childSessionId,
            activity: "thinking",
            reasoning: { itemId: event.id, status: "active", hasContent: false },
          };
        } else if (event.type === "model_reasoning_updated") {
          projected = {
            agentId,
            attemptId,
            childSessionId,
            activity: "thinking",
            reasoning: { itemId: event.id, status: "active", hasContent: event.text.length > 0 },
          };
        } else if (event.type === "model_reasoning_settled") {
          projected = undefined;
        } else if (event.type === "tool_requested" || event.type === "tool_started") {
          projected = {
            agentId,
            attemptId,
            childSessionId,
            activity: "using_tool",
            tool: {
              callId: event.callId,
              name: event.name,
              status: event.type === "tool_started" ? "running" : "requested",
            },
          };
        } else if (
          event.type === "model_message_completed" ||
          event.type === "tool_completed" ||
          event.type === "tool_failed" ||
          event.type === "session_settled"
        ) {
          projected = undefined;
        }
        if (projected !== current) {
          managedAgentActivity = [
            ...managedAgentActivity.filter(
              (activity) => activity.agentId !== agentId || activity.attemptId !== attemptId,
            ),
            ...(projected === undefined ? [] : [projected]),
          ];
          state = {
            ...state,
            revision: state.revision + 1,
          };
          publishStateChange();
        }
        return;
      }
      const { event } = notification;
      if (
        event.type === "tool_permission_requested" &&
        event.subject.type === "managed_agent_web_request"
      ) {
        if (
          active.pendingInteractions.some(
            (interaction) => interaction.requestId === event.requestId,
          )
        ) {
          return;
        }
        const interaction = {
          type: "permission" as const,
          requestId: event.requestId,
          callId: event.callId,
          effect: event.effect,
          subject: {
            type: "generic" as const,
            value: `${event.subject.agentId} (${event.subject.profile}) · ${event.subject.providerOrigin} · ${event.subject.operation} ${JSON.stringify(event.subject.queryOrUrl)}`,
          },
          warning: `Allow ${event.subject.agentId} (${event.subject.profile}) to send this exact Web request to ${event.subject.providerOrigin}: ${event.subject.queryOrUrl}?`,
          canAllow: true,
          changePreviewRef: null,
        };
        managedPermissionInteractions.set(event.requestId, interaction);
        state = {
          ...state,
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            active: {
              ...active,
              pendingInteractions: [...active.pendingInteractions, interaction],
            },
          },
        };
        publishStateChange();
        return;
      }
      if (event.type === "tool_permission_decided" && event.requestId !== undefined) {
        managedPermissionInteractions.delete(event.requestId);
        const pendingInteractions = active.pendingInteractions.filter(
          (interaction) => interaction.requestId !== event.requestId,
        );
        if (pendingInteractions.length === active.pendingInteractions.length) {
          return;
        }
        state = {
          ...state,
          revision: state.revision + 1,
          authoritative: {
            ...state.authoritative,
            active: { ...active, pendingInteractions },
          },
        };
        publishStateChange();
      }
    };
    for (const event of bufferedManagedAgentEvents.splice(0)) {
      handleManagedAgentEvent(event);
    }
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
                composer: state.composer,
                transient: { activity: "working", assistant: null, reasoning: null },
              };
              publishStateChange();
            } else if (event.type === "tool_requested" || event.type === "tool_started") {
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                draft: state.draft,
                composer: state.composer,
                transient: { activity: "using_tool", assistant: null, reasoning: null },
              };
              publishStateChange();
            } else if (event.type === "model_reasoning_started") {
              const target = knownTargets.get(active.session.targetId);
              state = {
                revision: state.revision + 1,
                authoritative: state.authoritative,
                draft: state.draft,
                composer: state.composer,
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
                  composer: state.composer,
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
                  composer: state.composer,
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
                composer: state.composer,
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
              refreshedOperations.map(({ display }) => display),
              projectToolDisplays(refreshedRecords, changePreviewCache),
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
                composer: state.composer,
                transient: null,
              };
              publishStateChange();
            }
            const pendingInteractions = withManagedPermissionInteractions(
              await projectPendingInteractions(refreshedRecords, options),
            );
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
            const refreshedTodo =
              latest.todo === undefined
                ? undefined
                : todoSummaryV1(
                    todoStoreSnapshotFromRecordsV1(
                      refreshedRecords.flatMap((record) =>
                        record.sessionId === active.session.id ? [record.entry] : [],
                      ),
                    ),
                  );
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
                  ...(refreshedTodo === undefined ? {} : { todo: refreshedTodo }),
                },
              },
              draft: state.draft,
              composer: state.composer,
              transient: isAssistantTerminalEvent(event)
                ? activeRun === undefined
                  ? null
                  : (state.transient ?? {
                      activity: "working",
                      assistant: null,
                      reasoning: null,
                    })
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
              composer: state.composer,
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
            composer: state.composer,
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

    const refreshConfiguredTargets = async (): Promise<
      AuthoritativePresentationSnapshot["targets"]
    > => {
      configuredPreferences = await options.preferences?.load();
      configuredWebSearch = await webSearchConfiguration?.load();
      configuredTargetContexts = await projectConfiguredTargetContexts(configuredPreferences);
      preferenceDiagnostic = resolvePreferenceDiagnostic(configuredPreferences);
      return {
        ...state.authoritative.targets,
        items: state.authoritative.targets.items.map((target) => {
          const context = configuredTargetContexts.get(target.targetId);
          return context === undefined ? target : { ...target, context };
        }),
        defaultTargetId: configuredPreferences?.defaultTargetId ?? null,
        diagnostic: preferenceDiagnostic,
        ...(configuredPreferences === undefined && configuredWebSearch === undefined
          ? {}
          : {
              configuration: {
                modelPolicy: configuredPreferences?.modelPolicy ?? emptyUserModelPolicyDisplay(),
                ...(configuredWebSearch === undefined
                  ? {}
                  : { webSearch: projectWebSearchConfiguration(configuredWebSearch) }),
              },
            }),
      };
    };

    const configurationMutationConflict = (): CommandReceipt | null =>
      activeRun !== undefined ||
      activeWebSearchTest !== undefined ||
      (state.authoritative.active?.pendingInteractions.length ?? 0) > 0
        ? {
            status: "rejected",
            code: "conflict",
            message: "User configuration can be changed only while the session is idle.",
          }
        : null;

    const continueApprovedPlan = (
      command: Extract<PresentationCommand, { readonly type: "approve_plan" | "continue_plan" }>,
      failureMessage: string,
    ): Promise<CommandReceipt> => {
      const commandKey = [
        command.sessionId,
        command.commandId,
        command.cycleId,
        command.revision,
        command.planId,
        command.contentDigest,
      ].join(":");
      if (activePlanCommand?.key === commandKey) {
        return activePlanCommand.receipt;
      }
      if (activeRun !== undefined) {
        return Promise.resolve({
          status: "rejected",
          code: "conflict",
          message: "The active session already has a running command.",
        });
      }
      const controller = new AbortController();
      const runState = {
        sessionId: command.sessionId,
        controller,
        settlement: null as Promise<void> | null,
      };
      activeRun = runState;
      state = {
        ...state,
        revision: state.revision + 1,
        transient: { activity: "working", assistant: null, reasoning: null },
      };
      publishStateChange();
      const operation = (async (): Promise<CommandReceipt> => {
        try {
          const continued = await options.lifecycle.continue({
            sessionId: command.sessionId,
            signal: controller.signal,
            planApproval: {
              commandId: command.commandId,
              cycleId: command.cycleId,
              revision: command.revision,
              planId: command.planId,
              contentDigest: command.contentDigest,
            },
          });
          if (!closed) {
            await activateSnapshot(continued.snapshot);
          }
          return { status: "admitted", commandId: command.commandId, resource: null };
        } catch {
          if (!closed) {
            try {
              const inspected = await options.lifecycle.inspect({ sessionId: command.sessionId });
              if (inspected.schemaVersion === 3) {
                await activateSnapshot(inspected);
              }
            } catch {
              // The command receipt remains fail-closed when refresh is also unavailable.
            }
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: failureMessage,
          };
        } finally {
          if (activePlanCommand?.key === commandKey) {
            activePlanCommand = undefined;
          }
          if (activeRun === runState) {
            activeRun = undefined;
          }
          if (!closed && state.transient !== null) {
            state = { ...state, revision: state.revision + 1, transient: null };
            publishStateChange();
          }
        }
      })();
      activePlanCommand = { key: commandKey, receipt: operation };
      runState.settlement = operation.then(() => undefined);
      return operation;
    };

    const dispatch = async (command: PresentationCommand): Promise<CommandReceipt> => {
      if (closed) {
        return {
          status: "rejected",
          code: "presentation_closed",
          message: "The presentation session is closed.",
        };
      }
      if (
        command.type === "refresh_managed_agents" ||
        command.type === "cancel_managed_agent" ||
        command.type === "send_managed_agent_message" ||
        command.type === "follow_up_managed_agent" ||
        command.type === "recover_managed_agent"
      ) {
        if (state.authoritative.active?.session.id !== command.sessionId) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const commandId = `presentation:${createHash("sha256")
            .update(JSON.stringify(command))
            .digest("hex")}`;
          let managedAgents: AuthoritativePresentationSnapshot["managedAgents"];
          let managedAgentControl: ManagedAgentControlReceipt | undefined;
          if (command.type === "refresh_managed_agents") {
            managedAgents = await options.lifecycle.inspectManagedAgents({
              sessionId: command.sessionId,
            });
          } else if (command.type === "cancel_managed_agent") {
            const result = await options.lifecycle.cancelManagedAgent(command);
            managedAgents = result.snapshot;
            managedAgentControl = result.receipt;
          } else if (command.type === "send_managed_agent_message") {
            const result = await options.lifecycle.sendManagedAgentMessage({
              ...command,
              callId: commandId,
            });
            managedAgents = result.snapshot;
            managedAgentControl = result.receipt;
          } else if (command.type === "follow_up_managed_agent") {
            const result = await options.lifecycle.followUpManagedAgent({
              ...command,
              callId: commandId,
              signal: new AbortController().signal,
            });
            managedAgents = result.snapshot;
            managedAgentControl = result.receipt;
          } else {
            const result = await options.lifecycle.recoverManagedAgent({
              ...command,
              callId: commandId,
              signal: new AbortController().signal,
            });
            managedAgents = result.snapshot;
            managedAgentControl = result.receipt;
          }
          state = {
            ...state,
            revision: state.revision + 1,
            authoritative: { ...state.authoritative, managedAgents },
          };
          publishStateChange();
          return {
            status: "admitted",
            commandId,
            resource: null,
            ...(managedAgentControl === undefined ? {} : { managedAgentControl }),
          };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "Managed-child state changed or became unavailable.",
          };
        }
      }
      if (command.type === "read_managed_agent_transcript") {
        const agent = state.authoritative.managedAgents.agents.find(
          (candidate) => candidate.agentId === command.agentId,
        );
        if (
          state.authoritative.active?.session.id !== command.sessionId ||
          agent === undefined ||
          agent.attemptId !== command.attemptId ||
          agent.revision !== command.expectedRevision ||
          agent.transcript.throughSequence !== command.expectedThroughSequence
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected managed-child transcript is no longer current.",
          };
        }
        try {
          const child = await options.lifecycle[sessionManagedAgentTranscriptReader](command);
          const projected = projectManagedAgentTranscript(child);
          const cursorPrefix = `managed-agent-transcript:${command.attemptId}:${command.expectedThroughSequence}:`;
          const end =
            command.cursor === null
              ? projected.length
              : command.cursor.startsWith(cursorPrefix) &&
                  /^\d+$/u.test(command.cursor.slice(cursorPrefix.length))
                ? Number(command.cursor.slice(cursorPrefix.length))
                : -1;
          if (!Number.isSafeInteger(end) || end < 0 || end > projected.length) {
            return {
              status: "rejected",
              code: "invalid_command",
              message: "The managed-child transcript cursor is invalid.",
            };
          }
          const start = Math.max(0, end - managedAgentTranscriptPageSize);
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: null,
            managedAgentTranscript: {
              type: "managed_agent_transcript_page",
              agentId: command.agentId,
              attemptId: command.attemptId,
              childSessionId: child.childSessionId,
              throughSequence: child.records.at(-1)?.sequence ?? 0,
              items: projected.slice(start, end),
              olderCursor: start === 0 ? null : `${cursorPrefix}${start}`,
            },
          };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The managed-child transcript changed or became unavailable.",
          };
        }
      }
      if (command.type === "read_managed_agent_artifact") {
        const agent = state.authoritative.managedAgents.agents.find(
          (candidate) => candidate.agentId === command.agentId,
        );
        if (
          state.authoritative.active?.session.id !== command.sessionId ||
          agent === undefined ||
          agent.attemptId !== command.attemptId ||
          agent.revision !== command.expectedRevision ||
          agent.transcript.throughSequence !== command.expectedThroughSequence
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected managed-child artifact is no longer current.",
          };
        }
        const { range } = command;
        if (options.stateRoot === undefined || !isBoundedPresentationArtifactRange(range)) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The managed-child artifact range is unavailable.",
          };
        }
        try {
          const child = await options.lifecycle[sessionManagedAgentTranscriptReader](command);
          const projected = projectManagedAgentTranscript(child);
          if (!managedTranscriptContainsArtifact(projected, command.artifact)) {
            return {
              status: "rejected",
              code: "stale_interaction",
              message: "The requested artifact is not part of the managed-child transcript.",
            };
          }
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: await readPresentationArtifact({
              artifact: command.artifact,
              barrier: options[presentationArtifactReadBarrier],
              range,
              stateRoot: options.stateRoot,
            }),
          };
        } catch {
          return {
            status: "rejected",
            code: "not_available",
            message: "The managed-child artifact could not be read safely.",
          };
        }
      }
      if (command.type === "list_todos") {
        const active = state.authoritative.active;
        if (command.sessionId !== active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        if (active.todo === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "Todo is unavailable in this historical Tool Profile. Start a new session to use Todo.",
          };
        }
        if (command.expectedStoreRevision !== active.todo.storeRevision) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Todo store revision is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.listTodos({
            sessionId: command.sessionId,
            expectedStoreRevision: command.expectedStoreRevision,
            ...(command.filter.status === null ? {} : { status: command.filter.status }),
            ...(command.filter.titleContains === null
              ? {}
              : { titleContains: command.filter.titleContains }),
            limit: command.limit,
            ...(command.cursor === null ? {} : { cursor: command.cursor }),
          });
          if (result.status === "stale" || result.status === "failed") {
            return {
              status: "rejected",
              code:
                result.status === "stale" || result.error.code === "todo_cursor_stale"
                  ? "stale_interaction"
                  : "invalid_command",
              message:
                result.status === "stale"
                  ? "The selected Todo store revision is no longer current."
                  : result.error.message,
            };
          }
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: null,
            todo: { type: "todo_page", ...result.output },
          };
        } catch (error) {
          return {
            status: "rejected",
            code:
              error instanceof SessionLifecycleError && error.code === "session_todo_unavailable"
                ? "not_available"
                : "authority_rejected",
            message: "The Todo page could not be read safely.",
          };
        }
      }
      if (command.type === "get_todo") {
        const active = state.authoritative.active;
        if (command.sessionId !== active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        if (active.todo === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "Todo is unavailable in this historical Tool Profile. Start a new session to use Todo.",
          };
        }
        if (command.expectedStoreRevision !== active.todo.storeRevision) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Todo store revision is no longer current.",
          };
        }
        try {
          const result = await options.lifecycle.getTodo(command);
          if (result.status === "stale" || result.status === "failed") {
            return {
              status: "rejected",
              code:
                result.status === "stale"
                  ? "stale_interaction"
                  : result.error.code === "not_found"
                    ? "not_available"
                    : "invalid_command",
              message:
                result.status === "stale"
                  ? "The selected Todo store revision is no longer current."
                  : result.error.message,
            };
          }
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: null,
            todo: { type: "todo_entity", ...result.output },
          };
        } catch (error) {
          return {
            status: "rejected",
            code:
              error instanceof SessionLifecycleError && error.code === "session_todo_unavailable"
                ? "not_available"
                : "authority_rejected",
            message: "The Todo entity could not be read safely.",
          };
        }
      }
      if (command.type === "cancel_target_connection_test") {
        const active = activeConnectionTests.get(command.targetId);
        if (active === undefined) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected target has no active connection test.",
          };
        }
        active.controller.abort(new DOMException("Connection test cancelled.", "AbortError"));
        await active.settlement;
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "test_target_connection") {
        const target = state.authoritative.targets.items.find(
          (candidate) => candidate.targetId === command.targetId,
        );
        const testConnection = options.modelTargets?.testConnection;
        if (
          target?.connection === undefined ||
          target.connection.configured !== "Configured" ||
          testConnection === undefined
        ) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The selected target connection test is not available.",
          };
        }
        if (activeConnectionTests.has(command.targetId)) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The selected target already has an active connection test.",
          };
        }
        const entry = {
          controller: new AbortController(),
          previous: target.connection,
        } as {
          readonly controller: AbortController;
          readonly previous: TargetConnection;
          settlement?: Promise<CommandReceipt>;
        };
        activeConnectionTests.set(command.targetId, entry);
        publishTargetConnection(command.targetId, {
          ...target.connection,
          reachability: "Testing",
          diagnostic: null,
        });
        const settlement: Promise<CommandReceipt> = (async () => {
          try {
            const result = await testConnection({
              targetId: command.targetId,
              signal: entry.controller.signal,
            });
            entry.controller.signal.throwIfAborted();
            publishTargetConnection(command.targetId, {
              configured: "Configured",
              reachability: result.status === "reachable" ? "Reachable" : "Unreachable",
              checkedAt: new Date().toISOString(),
              diagnostic: result.diagnostic,
            });
            return { status: "admitted", commandId: randomUUID(), resource: null };
          } catch {
            if (entry.controller.signal.aborted) {
              publishTargetConnection(command.targetId, entry.previous);
              return {
                status: "rejected",
                code: "authority_rejected",
                message: "The selected target connection test was cancelled.",
              };
            }
            publishTargetConnection(command.targetId, {
              configured: "Configured",
              reachability: "Unreachable",
              checkedAt: new Date().toISOString(),
              diagnostic: {
                code: "connection_request_failed",
                message: "The selected target connection test failed.",
              },
            });
            return { status: "admitted", commandId: randomUUID(), resource: null };
          } finally {
            if (activeConnectionTests.get(command.targetId) === entry) {
              activeConnectionTests.delete(command.targetId);
            }
          }
        })();
        entry.settlement = settlement;
        return settlement;
      }
      if (command.type === "set_workspace_trust") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        if (command.projectId !== state.authoritative.project.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The workspace trust command targets a stale project identity.",
          };
        }
        try {
          const result = await options.lifecycle.configureWorkspaceTrust({
            type: command.trusted ? "grant" : "revoke",
            projectId: command.projectId,
          });
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              project: {
                id: result.snapshot.projectId ?? state.authoritative.project.id,
                label: result.snapshot.projectLabel,
                workspaceTrust: {
                  status: result.snapshot.status,
                  diagnostic: result.snapshot.diagnostic,
                },
              },
            },
            draft: state.draft,
            composer: state.composer,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The workspace trust configuration could not be saved.",
          };
        }
      }
      if (command.type === "set_default_target") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        const target =
          command.targetId === null
            ? null
            : state.authoritative.targets.items.find(
                (candidate) =>
                  candidate.targetId === command.targetId &&
                  candidate.readiness.status === "available",
              );
        if (
          (command.targetId !== null && target === undefined) ||
          options.preferences === undefined
        ) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The exact target cannot be saved as the default.",
          };
        }
        try {
          await options.preferences.setDefaultTarget(command.targetId);
          const targets = await refreshConfiguredTargets();
          state = {
            revision: state.revision + 1,
            authoritative: {
              ...state.authoritative,
              targets,
            },
            draft: state.draft,
            composer: state.composer,
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
      if (command.type === "set_model_policy") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        if (options.preferences === undefined) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "User model configuration is not available in this Presentation session.",
          };
        }
        try {
          await options.preferences.setModelPolicy({ field: command.field, value: command.value });
          const targets = await refreshConfiguredTargets();
          state = {
            revision: state.revision + 1,
            authoritative: { ...state.authoritative, targets },
            draft: state.draft,
            composer: state.composer,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The model configuration could not be saved.",
          };
        }
      }
      if (command.type === "cancel_web_search_test") {
        const active = activeWebSearchTest;
        if (active === undefined) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "There is no active Web Search connection test.",
          };
        }
        active.controller.abort(new DOMException("Web Search test cancelled.", "AbortError"));
        await active.settlement;
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "test_and_set_web_search") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        if (webSearchConfiguration === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "Web Search configuration is not available in this Presentation session.",
          };
        }
        const entry: {
          readonly controller: AbortController;
          settlement?: Promise<CommandReceipt>;
        } = { controller: new AbortController() };
        activeWebSearchTest = entry;
        const settlement: Promise<CommandReceipt> = (async () => {
          try {
            await webSearchConfiguration.testAndActivateSearxng({
              endpoint: command.endpoint,
              http: webHttp,
              signal: entry.controller.signal,
            });
            if (!closed) {
              const targets = await refreshConfiguredTargets();
              if (!closed) {
                state = {
                  revision: state.revision + 1,
                  authoritative: { ...state.authoritative, targets },
                  draft: state.draft,
                  composer: state.composer,
                  transient: state.transient,
                };
                publishStateChange();
              }
            }
            return { status: "admitted", commandId: randomUUID(), resource: null };
          } catch {
            return {
              status: "rejected",
              code: "authority_rejected",
              message: "The SearXNG connection test failed; the prior configuration is unchanged.",
            };
          } finally {
            if (activeWebSearchTest === entry) {
              activeWebSearchTest = undefined;
            }
          }
        })();
        entry.settlement = settlement;
        return settlement;
      }
      if (command.type === "clear_web_search") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        if (webSearchConfiguration === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "Web Search configuration is not available in this Presentation session.",
          };
        }
        try {
          await webSearchConfiguration.clear();
          const targets = await refreshConfiguredTargets();
          state = {
            revision: state.revision + 1,
            authoritative: { ...state.authoritative, targets },
            draft: state.draft,
            composer: state.composer,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The Web Search configuration could not be cleared.",
          };
        }
      }
      if (command.type === "set_web_synthetic_dns_range") {
        const conflict = configurationMutationConflict();
        if (conflict !== null) {
          return conflict;
        }
        if (webSearchConfiguration === undefined) {
          return {
            status: "rejected",
            code: "not_available",
            message: "Web transport configuration is not available in this Presentation session.",
          };
        }
        if (command.range !== null && normalizeWebSyntheticDnsRange(command.range) === undefined) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The synthetic DNS range must be an IPv4 CIDR subnet inside 198.18.0.0/15.",
          };
        }
        try {
          await webSearchConfiguration.setSyntheticDnsRange(command.range);
          const targets = await refreshConfiguredTargets();
          state = {
            revision: state.revision + 1,
            authoritative: { ...state.authoritative, targets },
            draft: state.draft,
            composer: state.composer,
            transient: state.transient,
          };
          publishStateChange();
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The Web synthetic DNS configuration could not be saved.",
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
        await persistSettledCurrentTurnDraft();
        const recovered = await loadTurnDraft({ type: "new_session" }, targetIdentity.targetId);
        await turnComposer.clear({ preserveRetained: true });
        attachmentAvailable = true;
        attachmentUnavailableReason = null;
        const draftMode =
          state.authoritative.active === null ? (state.draft?.mode ?? "default") : "default";
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
            mode: draftMode,
            skills: projectSkillContext(preview.skillContext, false),
            projectPaths,
          },
          composer: projectTurnComposer(),
          transient: null,
        };
        draftTargetIdentity = targetIdentity;
        if (recovered !== null) {
          await turnComposer.restoreDraft(recovered);
        }
        publishStateChange();
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "set_draft_mode") {
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The active session already has a running command.",
          };
        }
        if (state.authoritative.active !== null || state.draft === null) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The new-session draft is no longer active.",
          };
        }
        state = {
          ...state,
          revision: state.revision + 1,
          draft: { ...state.draft, mode: command.mode },
        };
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
            const resumed = await options.lifecycle.resume({
              sessionId: command.sessionId,
              preserveInterruptedEffects: true,
            });
            if (resumed.status === "rejected") {
              throw new TypeError(resumed.error.message);
            }
            snapshot = resumed.snapshot;
          }
          await persistSettledCurrentTurnDraft();
          const recovered = await loadTurnDraft({
            type: "session",
            sessionId: command.sessionId,
          });
          await turnComposer.clear({ preserveRetained: true });
          await activateSnapshot(snapshot);
          if (recovered !== null) {
            await turnComposer.restoreDraft(recovered);
          }
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The session could not be selected.",
          };
        }
      }
      if (command.type === "stage_input_resource") {
        if (!attachmentAvailable) {
          return {
            status: "rejected",
            code: "not_available",
            message: attachmentUnavailableReason ?? "Input resources are not available.",
          };
        }
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "An input resource cannot be staged while the current turn is sealed.",
          };
        }
        try {
          await turnComposer.stage(command.path, command.mutation, persistCurrentTurnDraft);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "not_available",
            message: "The selected input resource could not be staged.",
          };
        }
      }
      if (command.type === "stage_pasted_text") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "Pasted text cannot be staged while the current turn is sealed.",
          };
        }
        try {
          await turnComposer.stagePastedText(
            command.text,
            command.mutation,
            persistCurrentTurnDraft,
          );
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch (error) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              error instanceof Error
                ? error.message
                : "The pasted text could not be staged safely.",
          };
        }
      }
      if (command.type === "replace_draft_text") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The current turn cannot change while it is sealed.",
          };
        }
        try {
          return (await turnComposer.replaceText(command, persistCurrentTurnDraft))
            ? { status: "admitted", commandId: randomUUID(), resource: null }
            : {
                status: "rejected",
                code: "stale_interaction",
                message: "The structured draft no longer matches the current composer revision.",
              };
        } catch (error) {
          return {
            status: "rejected",
            code: error instanceof TurnComposerError ? "not_available" : "persistence_failed",
            message:
              error instanceof TurnComposerError
                ? error.message
                : "The recoverable structured draft could not be saved.",
          };
        }
      }
      if (command.type === "remove_draft_element") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The current turn cannot change while it is sealed.",
          };
        }
        const snapshot = turnComposer.snapshot();
        const element = snapshot.elements.find(
          (candidate) => candidate.elementId === command.elementId,
        );
        if (
          command.baseRevision !== snapshot.revision ||
          element?.type === "text" ||
          element === undefined
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The draft element is no longer present in the current composer.",
          };
        }
        try {
          const removed =
            element.type === "resource"
              ? await turnComposer.remove(element.resourceId, persistCurrentTurnDraft)
              : element.type === "pasted_text"
                ? await turnComposer.removePastedText(element.pastedTextId, persistCurrentTurnDraft)
                : element.type === "path"
                  ? await turnComposer.removePath(element.elementId, persistCurrentTurnDraft)
                  : await turnComposer.removeSkill(element.elementId, persistCurrentTurnDraft);
          return removed
            ? { status: "admitted", commandId: randomUUID(), resource: null }
            : {
                status: "rejected",
                code: "stale_interaction",
                message: "The draft element is no longer present in the current composer.",
              };
        } catch (error) {
          return {
            status: "rejected",
            code: error instanceof TurnComposerError ? "not_available" : "persistence_failed",
            message:
              error instanceof TurnComposerError
                ? error.message
                : "The recoverable turn draft could not be saved.",
          };
        }
      }
      if (command.type === "read_expanded_draft") {
        try {
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: null,
            draftText: turnComposer.readExpandedText(),
          };
        } catch (error) {
          return {
            status: "rejected",
            code: "not_available",
            message: error instanceof Error ? error.message : "The expanded draft is unavailable.",
          };
        }
      }
      if (command.type === "undo_draft") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The current turn cannot be undone while it is sealed.",
          };
        }
        try {
          return (await turnComposer.undo(command.baseRevision, persistCurrentTurnDraft))
            ? { status: "admitted", commandId: randomUUID(), resource: null }
            : {
                status: "rejected",
                code: "stale_interaction",
                message: "The draft undo no longer targets the current composer revision.",
              };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The restored turn draft could not be saved.",
          };
        }
      }
      if (command.type === "clear_draft") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The current turn cannot be cleared while it is sealed.",
          };
        }
        try {
          return (await turnComposer.reset(command.baseRevision, persistCurrentTurnDraft))
            ? { status: "admitted", commandId: randomUUID(), resource: null }
            : {
                status: "rejected",
                code: "stale_interaction",
                message: "The draft clear no longer targets the current settled composer revision.",
              };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The cleared turn draft could not be saved.",
          };
        }
      }
      if (command.type === "update_draft_text") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The current turn text cannot change while the turn is sealed.",
          };
        }
        try {
          await turnComposer.commitText(command.text, persistCurrentTurnDraft);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch (error) {
          return {
            status: "rejected",
            code: error instanceof TurnComposerError ? "not_available" : "persistence_failed",
            message:
              error instanceof TurnComposerError
                ? error.message
                : "The recoverable turn draft could not be saved.",
          };
        }
      }
      if (command.type === "remove_input_resource") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "An input resource cannot be removed while the current turn is sealed.",
          };
        }
        try {
          return (await turnComposer.remove(command.resourceId, persistCurrentTurnDraft))
            ? { status: "admitted", commandId: randomUUID(), resource: null }
            : {
                status: "rejected",
                code: "stale_interaction",
                message: "The input resource is no longer present in the current composer.",
              };
        } catch {
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The recoverable turn draft could not be saved.",
          };
        }
      }
      if (command.type === "cancel_input_resource") {
        if (activeRun !== undefined || state.composer.sealed) {
          return {
            status: "rejected",
            code: "conflict",
            message: "An input resource cannot be cancelled while the current turn is sealed.",
          };
        }
        return (await turnComposer.cancel(command.resourceId))
          ? { status: "admitted", commandId: randomUUID(), resource: null }
          : {
              status: "rejected",
              code: "stale_interaction",
              message: "The input resource is no longer cancellable in the current composer.",
            };
      }
      if (command.type === "submit_prompt") {
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          (command.text.trim().length === 0 &&
            state.composer.pastedTexts.length === 0 &&
            !state.composer.elements.some((element) => element.type === "skill"))
        ) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "The prompt does not target the active session or is blank.",
          };
        }
        if (state.authoritative.continuity.status !== "current") {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The active session boundary is no longer available for this command.",
          };
        }
        if (activeRun !== undefined) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The active session already has a running command.",
          };
        }
        if (state.authoritative.active.session.status === "interrupted") {
          return {
            status: "rejected",
            code: "not_available",
            message: "Resolve interrupted work before sending another turn.",
          };
        }
        const activePlan = state.authoritative.active.plan;
        const revisionIntent = state.composer.revisionIntent;
        if (activePlan?.state === "approved_not_started") {
          return {
            status: "rejected",
            code: "conflict",
            message: "Continue the approved Plan implementation before sending another turn.",
          };
        }
        if (activePlan?.state === "ready") {
          if (
            revisionIntent === null ||
            revisionIntent.sessionId !== command.sessionId ||
            revisionIntent.cycleId !== activePlan.cycleId ||
            revisionIntent.revision !== activePlan.revision ||
            revisionIntent.planId !== activePlan.submission?.planId ||
            revisionIntent.contentDigest !== activePlan.submission?.contentDigest
          ) {
            return {
              status: "rejected",
              code: "conflict",
              message: "Review the current Plan artifact before sending another turn.",
            };
          }
        }
        const skillResolution = preflightSubmittedSkills({
          text: command.text,
          explicitQualifiedIds: command.skills,
          catalog: state.authoritative.active.skills,
          elements: state.composer.elements,
        });
        if (skillResolution.status === "rejected") {
          return skillResolution.receipt;
        }
        if (!draftImagesFitExactTarget()) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "The exact target does not support images. Switch targets or remove the Image atom.",
          };
        }
        if (!expandedDraftFitsExactTarget(command.text)) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "The expanded draft cannot fit the exact target context. Remove or split Text atoms, or switch targets.",
          };
        }
        const submittedScope = currentDraftScope();
        const controller = new AbortController();
        const commandId = randomUUID();
        const runState = {
          sessionId: command.sessionId,
          controller,
          settlement: null as Promise<void> | null,
        };
        activeRun = runState;
        state = {
          ...state,
          revision: state.revision + 1,
          transient: { activity: "working", assistant: null, reasoning: null },
        };
        publishStateChange();
        let sealedDraft: Awaited<ReturnType<TurnComposer["seal"]>>;
        try {
          turnComposer.setText(command.text);
          sealedDraft = await turnComposer.seal(controller.signal);
          await persistCurrentTurnDraft();
        } catch (error) {
          if (activeRun === runState) {
            activeRun = undefined;
          }
          state = { ...state, revision: state.revision + 1, transient: null };
          publishStateChange();
          return {
            status: "rejected",
            code: "not_available",
            message:
              error instanceof TurnComposerError
                ? error.message
                : "The current turn could not be sealed safely.",
          };
        }
        const resolvedSkillIds = [
          ...new Set([
            ...sealedDraft.skillOccurrences.map((occurrence) => occurrence.qualifiedId),
            ...skillResolution.compatibilityQualifiedIds,
          ]),
        ];
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
            notification.event.text === sealedDraft.text
          ) {
            admission.resolve();
          }
        });
        let admissionFailure: unknown;
        const continuation = options.lifecycle.continue({
          sessionId: command.sessionId,
          input: {
            text: sealedDraft.text,
            ...(resolvedSkillIds.length === 0 ? {} : { skills: resolvedSkillIds }),
          },
          runId: commandId,
          signal: controller.signal,
          ...(sealedDraft.selections.length === 0
            ? {}
            : { resourceSelections: sealedDraft.selections }),
          ...(sealedDraft.pastedTextSelections.length === 0
            ? {}
            : { pastedTextSelections: sealedDraft.pastedTextSelections }),
          ...(sealedDraft.selections.length === 0 && sealedDraft.pastedTextSelections.length === 0
            ? {}
            : { structuredContent: sealedDraft.structuredContent }),
          ...(command.thinkingSelection === null
            ? {}
            : { thinkingSelection: command.thinkingSelection }),
          ...(activePlan?.state !== "ready" || revisionIntent === null
            ? {}
            : {
                planRevision: {
                  cycleId: revisionIntent.cycleId,
                  revision: revisionIntent.revision,
                  planId: revisionIntent.planId,
                  contentDigest: revisionIntent.contentDigest,
                },
              }),
        });
        const settlement = continuation
          .then(async (continued) => {
            if (!closed) {
              await activateSnapshot(continued.snapshot);
            }
          })
          .catch(() => recoverAdmittedRunSnapshot(command.sessionId))
          .finally(() => {
            if (activeRun === runState) {
              activeRun = undefined;
              if (!closed && state.transient !== null) {
                state = { ...state, revision: state.revision + 1, transient: null };
                publishStateChange();
              }
            }
          });
        runState.settlement = settlement;
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
          turnComposer.unseal();
          return (
            thinkingPolicyAdmissionRejection(admissionFailure) ?? {
              status: "rejected",
              code: "not_available",
              message: "The prompt could not be admitted to durable session history.",
            }
          );
        }
        planRevisionIntent = null;
        if (recoverableDrafts !== null && submittedScope !== null) {
          await recoverableDrafts.delete(submittedScope);
        }
        await turnComposer.clear();
        return { status: "admitted", commandId, resource: null };
      }
      if (command.type === "submit_draft_prompt") {
        const draft = state.draft;
        if (
          draft === null ||
          (command.text.trim().length === 0 &&
            state.composer.pastedTexts.length === 0 &&
            !state.composer.elements.some((element) => element.type === "skill"))
        ) {
          return {
            status: "rejected",
            code: "invalid_command",
            message: "A non-empty prompt and exact draft target are required.",
          };
        }
        if (state.authoritative.continuity.status !== "current") {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The active session boundary is no longer available for this command.",
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
        const skillResolution = preflightSubmittedSkills({
          text: command.text,
          explicitQualifiedIds: command.skills,
          catalog: draft.skills,
          elements: state.composer.elements,
        });
        if (skillResolution.status === "rejected") {
          return skillResolution.receipt;
        }
        if (!draftImagesFitExactTarget()) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "The exact target does not support images. Switch targets or remove the Image atom.",
          };
        }
        if (!expandedDraftFitsExactTarget(command.text)) {
          return {
            status: "rejected",
            code: "not_available",
            message:
              "The expanded draft cannot fit the exact target context. Remove or split Text atoms, or switch targets.",
          };
        }
        const submittedScope = currentDraftScope();
        const controller = new AbortController();
        const commandId = randomUUID();
        const runState = {
          sessionId: null as string | null,
          controller,
          settlement: null as Promise<void> | null,
        };
        activeRun = runState;
        state = {
          ...state,
          revision: state.revision + 1,
          transient: { activity: "working", assistant: null, reasoning: null },
        };
        publishStateChange();
        let sealedDraft: Awaited<ReturnType<TurnComposer["seal"]>>;
        try {
          turnComposer.setText(command.text);
          sealedDraft = await turnComposer.seal(controller.signal);
          await persistCurrentTurnDraft();
        } catch (error) {
          if (activeRun === runState) {
            activeRun = undefined;
          }
          state = { ...state, revision: state.revision + 1, transient: null };
          publishStateChange();
          return {
            status: "rejected",
            code: "not_available",
            message:
              error instanceof TurnComposerError
                ? error.message
                : "The current turn could not be sealed safely.",
          };
        }
        const resolvedSkillIds = [
          ...new Set([
            ...sealedDraft.skillOccurrences.map((occurrence) => occurrence.qualifiedId),
            ...skillResolution.compatibilityQualifiedIds,
          ]),
        ];
        const admission = Promise.withResolvers<string>();
        let admittedSessionId: string | null = null;
        const continuation = options.lifecycle.admit({
          targetIdentity,
          input: {
            text: sealedDraft.text,
            ...(resolvedSkillIds.length === 0 ? {} : { skills: resolvedSkillIds }),
          },
          runId: commandId,
          signal: controller.signal,
          ...(draft.mode === "plan" ? { mode: "plan" as const } : {}),
          ...(sealedDraft.selections.length === 0
            ? {}
            : { resourceSelections: sealedDraft.selections }),
          ...(sealedDraft.pastedTextSelections.length === 0
            ? {}
            : { pastedTextSelections: sealedDraft.pastedTextSelections }),
          ...(sealedDraft.selections.length === 0 && sealedDraft.pastedTextSelections.length === 0
            ? {}
            : { structuredContent: sealedDraft.structuredContent }),
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
          .catch(() => {
            const sessionId = admittedSessionId;
            if (closed || sessionId === null) {
              return;
            }
            return recoverAdmittedRunSnapshot(sessionId);
          })
          .finally(() => {
            if (activeRun === runState) {
              activeRun = undefined;
              if (!closed && state.transient !== null) {
                state = { ...state, revision: state.revision + 1, transient: null };
                publishStateChange();
              }
            }
          });
        runState.settlement = settlement;
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
          turnComposer.unseal();
          return draftAdmissionRejection(admissionFailure);
        }
        if (activeRun === runState) {
          runState.sessionId = admitted.sessionId;
        }
        let admittedSnapshot: Awaited<ReturnType<SessionLifecycle["inspect"]>>;
        try {
          admittedSnapshot = await options.lifecycle.inspect({ sessionId: admitted.sessionId });
        } catch {
          await settlement;
          turnComposer.unseal();
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The admitted draft session could not be read from durable history.",
          };
        }
        if (admittedSnapshot.schemaVersion !== 3) {
          await settlement;
          turnComposer.unseal();
          return {
            status: "rejected",
            code: "persistence_failed",
            message: "The admitted draft session could not be read from durable history.",
          };
        }
        await options[presentationHydrationBarrier]?.afterAdmissionSnapshot?.();
        if (recoverableDrafts !== null && submittedScope !== null) {
          await recoverableDrafts.delete(submittedScope);
        }
        await turnComposer.clear();
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
          await persistSettledCurrentTurnDraft();
          const snapshot = await options.lifecycle.branch({
            parentSessionId: command.parentSessionId,
            ...(command.sourceBoundary === undefined
              ? { atSequence: command.atSequence }
              : { sourceBoundary: command.sourceBoundary }),
            ...(command.targetId === null ? {} : { targetId: command.targetId }),
          });
          await turnComposer.clear({ preserveRetained: true });
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
          pending.changePreviewRef !== null &&
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
      if (
        command.type === "resume_interrupted_session" ||
        command.type === "cancel_interrupted_session"
      ) {
        if (
          activeRun !== undefined ||
          state.authoritative.active?.session.id !== command.sessionId ||
          state.authoritative.continuity.status !== "current"
        ) {
          return {
            status: "rejected",
            code: "conflict",
            message: "The interrupted session is no longer available.",
          };
        }
        const recovery = await options.lifecycle.inspectInterruptedSession({
          sessionId: command.sessionId,
        });
        if (
          activeRun !== undefined ||
          state.authoritative.active?.session.id !== command.sessionId ||
          recovery?.runId !== command.runId ||
          (command.type === "resume_interrupted_session" && !recovery.canResume)
        ) {
          return {
            status: "rejected",
            code: "not_available",
            message: "This interrupted effect cannot be replayed safely.",
          };
        }
        const controller = new AbortController();
        const runState = {
          sessionId: command.sessionId,
          controller,
          settlement: null as Promise<void> | null,
          recovery: true,
        };
        activeRun = runState;
        if (command.type === "cancel_interrupted_session") controller.abort();
        state = {
          ...state,
          revision: state.revision + 1,
          transient: { activity: "working", assistant: null, reasoning: null },
        };
        publishStateChange();
        const operation = (async (): Promise<CommandReceipt> => {
          try {
            const snapshot =
              command.type === "cancel_interrupted_session"
                ? await options.lifecycle.cancelInterruptedSession(command)
                : (
                    await options.lifecycle.continue({
                      sessionId: command.sessionId,
                      interruptedRunId: command.runId,
                      signal: controller.signal,
                    })
                  ).snapshot;
            await activateSnapshot(snapshot);
            return { status: "admitted", commandId: randomUUID(), resource: null };
          } catch {
            await recoverAdmittedRunSnapshot(command.sessionId);
            return {
              status: "rejected",
              code: "authority_rejected",
              message: "Interrupted work could not be recovered. Inspect durable state.",
            };
          } finally {
            if (activeRun === runState) activeRun = undefined;
            state = { ...state, revision: state.revision + 1, transient: null };
            publishStateChange();
          }
        })();
        runState.settlement = operation.then(() => undefined);
        return operation;
      }
      if (command.type === "cancel_run") {
        if (
          activeRun === undefined ||
          (state.authoritative.active?.session.id ?? null) !== command.sessionId
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The requested run is no longer active.",
          };
        }
        activeRun.controller.abort();
        state = { ...state, revision: state.revision + 1 };
        publishStateChange();
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
                  composer: state.composer,
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
          composer: state.composer,
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
                diagnostics: projectSessionHistoryDiagnostics(page.diagnostics),
              },
            },
            draft: state.draft,
            composer: state.composer,
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
          (command.artifact.source === "plan" && command.artifact.byteCount <= 64 * 1024) ||
          (command.artifact.source === "model_response" &&
            command.artifact.byteCount <= maximumModelResponseContentBytes);
        if (
          options.stateRoot === undefined ||
          (range === null && !completeReadAvailable) ||
          (range !== null && !isBoundedPresentationArtifactRange(range))
        ) {
          return {
            status: "rejected",
            code: "not_available",
            message: "The artifact is not available through this Presentation session.",
          };
        }
        try {
          return {
            status: "admitted",
            commandId: randomUUID(),
            resource: await readPresentationArtifact({
              artifact: command.artifact,
              barrier: options[presentationArtifactReadBarrier],
              range,
              stateRoot: options.stateRoot,
            }),
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
      if (command.type === "enter_plan") {
        if (command.sessionId !== state.authoritative.active?.session.id) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected session is no longer active.",
          };
        }
        try {
          const snapshot = await options.lifecycle.enterPlan(command);
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch (error) {
          if (error instanceof SessionLifecycleError && error.code === "session_plan_unavailable") {
            return {
              status: "rejected",
              code: "not_available",
              message: error.message,
            };
          }
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "Plan could not be entered from the current session state.",
          };
        }
      }
      if (command.type === "revise_plan") {
        const plan = state.authoritative.active?.plan;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          plan?.state !== "ready" ||
          command.cycleId !== plan.cycleId ||
          command.revision !== plan.revision ||
          command.planId !== plan.submission?.planId ||
          command.contentDigest !== plan.submission?.contentDigest
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Plan artifact is no longer current.",
          };
        }
        planRevisionIntent = {
          sessionId: command.sessionId,
          cycleId: command.cycleId,
          revision: command.revision,
          planId: command.planId,
          contentDigest: command.contentDigest,
        };
        state = {
          ...state,
          revision: state.revision + 1,
          composer: projectTurnComposer(),
        };
        publishStateChange();
        return { status: "admitted", commandId: randomUUID(), resource: null };
      }
      if (command.type === "approve_plan") {
        const plan = state.authoritative.active?.plan;
        const exactReady =
          plan?.state === "ready" &&
          command.cycleId === plan.cycleId &&
          command.revision === plan.revision &&
          command.planId === plan.submission?.planId &&
          command.contentDigest === plan.submission?.contentDigest;
        const exactDurableReplay =
          plan?.state === "approved_not_started" &&
          plan.approval !== undefined &&
          command.commandId === plan.approval.commandId &&
          command.cycleId === plan.cycleId &&
          command.revision === plan.revision &&
          command.planId === plan.submission?.planId &&
          command.contentDigest === plan.submission?.contentDigest;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          (!exactReady && !exactDurableReplay)
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Plan artifact is no longer current.",
          };
        }
        return continueApprovedPlan(
          command,
          "The approved Plan implementation could not be started.",
        );
      }
      if (command.type === "continue_plan") {
        const plan = state.authoritative.active?.plan;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          plan?.state !== "approved_not_started" ||
          plan.approval === undefined ||
          plan.submission === undefined ||
          command.commandId !== plan.approval.commandId ||
          command.cycleId !== plan.cycleId ||
          command.revision !== plan.revision ||
          command.planId !== plan.submission.planId ||
          command.contentDigest !== plan.submission.contentDigest
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Plan implementation intent is no longer current.",
          };
        }
        return continueApprovedPlan(
          command,
          "The approved Plan implementation could not be continued.",
        );
      }
      if (command.type === "cancel_plan") {
        const plan = state.authoritative.active?.plan;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          plan?.state !== "ready" ||
          plan.submission === undefined ||
          command.cycleId !== plan.cycleId ||
          command.revision !== plan.revision ||
          command.planId !== plan.submission.planId ||
          command.contentDigest !== plan.submission.contentDigest
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Plan artifact is no longer current.",
          };
        }
        try {
          const snapshot = await options.lifecycle.cancelPlan(command);
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The current Plan artifact could not be cancelled.",
          };
        }
      }
      if (command.type === "exit_plan") {
        const plan = state.authoritative.active?.plan;
        if (
          command.sessionId !== state.authoritative.active?.session.id ||
          command.cycleId !== plan?.cycleId ||
          command.revision !== plan.revision
        ) {
          return {
            status: "rejected",
            code: "stale_interaction",
            message: "The selected Plan cycle is no longer current.",
          };
        }
        try {
          const snapshot = await options.lifecycle.exitPlan(command);
          await activateSnapshot(snapshot);
          return { status: "admitted", commandId: randomUUID(), resource: null };
        } catch {
          return {
            status: "rejected",
            code: "authority_rejected",
            message: "The current Plan cycle could not be exited.",
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
      getState: () => {
        const active = state.authoritative.active;
        const phase =
          activeRun !== undefined
            ? activeRun.controller.signal.aborted
              ? ("cancelling" as const)
              : activeRun.recovery
                ? ("recovering" as const)
                : ("running" as const)
            : active?.session.status === "interrupted"
              ? ("interrupted" as const)
              : ("ready" as const);
        return {
          ...state,
          ...(managedAgentActivity.length === 0 ? {} : { managedAgentActivity }),
          authoritative: {
            ...state.authoritative,
            active:
              active === null
                ? null
                : {
                    ...active,
                    parentRun: {
                      phase,
                      editor:
                        phase === "ready" && active.plan?.state !== "approved_not_started"
                          ? ("ready" as const)
                          : ("blocked" as const),
                    },
                  },
          },
        };
      },
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
        await persistSettledCurrentTurnDraft();
        closed = true;
        activeRun?.controller.abort();
        const connectionSettlements = [...activeConnectionTests.values()].flatMap((active) =>
          active.settlement === undefined ? [] : [active.settlement],
        );
        const webSearchSettlement = activeWebSearchTest?.settlement;
        for (const active of activeConnectionTests.values()) {
          active.controller.abort(new DOMException("Presentation session closed.", "AbortError"));
        }
        activeWebSearchTest?.controller.abort(
          new DOMException("Presentation session closed.", "AbortError"),
        );
        await turnComposer.close();
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
        unsubscribeManagedAgentEvents();
        await activeRun?.settlement;
        await Promise.all(connectionSettlements);
        await webSearchSettlement;
        await runtimeRefresh;
        await metadataRefresh;
        await Promise.all(operationRefreshes);
        listeners.clear();
        managedAgentActivity = [];
        state = { ...state, transient: null };
        bufferedEvents.length = 0;
        bufferedManagedAgentEvents.length = 0;
      },
    };
  } catch (error) {
    unsubscribeLifecycle();
    unsubscribeMetadata();
    unsubscribeManagedAgentEvents();
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

function sessionSupportsInputResources(snapshot: CurrentSessionSnapshot | undefined): boolean {
  return (
    snapshot?.promptContext?.toolProfile.definitions.some(
      (definition) => definition.name === "read_input_resource",
    ) === true
  );
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

function isBoundedPresentationArtifactRange(range: ArtifactRange): boolean {
  return (
    Number.isSafeInteger(range.offset) &&
    range.offset >= 0 &&
    Number.isSafeInteger(range.maximumBytes) &&
    range.maximumBytes > 0 &&
    range.maximumBytes <= presentationArtifactPageMaximumBytes
  );
}

async function readPresentationArtifact(input: {
  readonly artifact: ArtifactReference;
  readonly barrier: PresentationArtifactReadBarrier | undefined;
  readonly range: ArtifactRange | null;
  readonly stateRoot: string;
}): Promise<ArtifactChunk> {
  await input.barrier?.beforeRead();
  const page =
    input.range === null
      ? await readFileArtifact({
          root: join(input.stateRoot, "artifacts"),
          id: input.artifact.id,
          maximumBytes: input.artifact.byteCount,
        }).then((bytes) =>
          bytes === undefined ? undefined : { bytes, totalByteCount: bytes.byteLength, eof: true },
        )
      : await readFileArtifactRange({
          root: join(input.stateRoot, "artifacts"),
          id: input.artifact.id,
          expectedByteCount: input.artifact.byteCount,
          offset: input.range.offset,
          maximumBytes: input.range.maximumBytes,
        });
  if (page === undefined || page.totalByteCount !== input.artifact.byteCount) {
    throw new TypeError("The artifact bytes are unavailable.");
  }
  const decoded = decodeArtifactPage(page.bytes, page.eof);
  const eof = page.eof && decoded.byteCount === page.bytes.byteLength;
  if (!eof && decoded.byteCount === 0) {
    throw new TypeError("The artifact page did not make UTF-8 progress.");
  }
  await input.barrier?.afterRead?.();
  return {
    mediaType: input.artifact.mediaType,
    offset: input.range?.offset ?? 0,
    byteCount: decoded.byteCount,
    totalByteCount: page.totalByteCount,
    eof,
    nextRange:
      input.range === null || eof
        ? null
        : {
            offset: input.range.offset + decoded.byteCount,
            maximumBytes: presentationArtifactPageMaximumBytes,
          },
    text: decoded.text,
  };
}

function projectManagedAgentTranscript(child: ManagedAgentTranscriptRecords): TranscriptItem[] {
  const history = child.records.map((entry) => ({
    sessionId: child.childSessionId,
    entry,
  }));
  const projected: TranscriptItem[] = [];
  for (const item of projectTranscript(history, [], projectToolDisplays(history, new Map()))) {
    if (item.type === "user_message") {
      continue;
    }
    if (item.type === "reasoning_block") {
      projected.push({ ...item, text: null, artifact: null });
      continue;
    }
    projected.push(item);
  }
  const { partialOutput } = child;
  if (partialOutput !== undefined) {
    const terminalNoticeIndex = projected.findIndex((item) => item.type === "session_notice");
    projected.splice(terminalNoticeIndex < 0 ? projected.length : terminalNoticeIndex, 0, {
      type: "assistant_message",
      id: `${child.childSessionId}:partial:${child.records.at(-1)?.sequence ?? 0}`,
      sequence: child.records.at(-1)?.sequence ?? 0,
      sourceSessionId: child.childSessionId,
      branchBoundary: null,
      text: partialOutput.text,
      artifact: null,
    });
  }
  return projected;
}

function managedTranscriptContainsArtifact(
  items: readonly TranscriptItem[],
  artifact: ArtifactReference,
): boolean {
  return transcriptArtifactReferences(items).some((candidate) =>
    sameArtifactReference(candidate, artifact),
  );
}

function isKnownArtifact(
  active: import("@adam-agent/presentation").ActiveSessionDisplay,
  artifact: ArtifactReference,
): boolean {
  const candidates = [
    ...(active.plan?.submission === undefined
      ? []
      : [
          {
            id: active.plan.submission.artifact.id,
            mediaType: active.plan.submission.artifact.mediaType,
            byteCount: active.plan.submission.artifact.byteCount,
            source: "plan" as const,
          },
        ]),
    ...active.linkedOperations.flatMap((operation) =>
      operation.artifacts.map((artifact) => artifact.reference),
    ),
    ...active.pendingInteractions.flatMap((interaction) =>
      interaction.changePreviewRef === null ? [] : [interaction.changePreviewRef],
    ),
    ...transcriptArtifactReferences(active.transcript.items),
  ];
  return candidates.some((candidate) => sameArtifactReference(candidate, artifact));
}

function transcriptArtifactReferences(
  items: readonly TranscriptItem[],
): readonly ArtifactReference[] {
  return items.flatMap((item) => {
    if (item.type === "assistant_message" || item.type === "reasoning_block") {
      return item.artifact === null ? [] : [item.artifact];
    }
    if (item.type === "tool_call") {
      return [
        ...item.artifacts,
        ...(item.changePreviewRef === null ? [] : [item.changePreviewRef]),
      ];
    }
    if (item.type === "plan_submission") {
      return [
        {
          id: item.submission.artifact.id,
          mediaType: item.submission.artifact.mediaType,
          byteCount: item.submission.artifact.byteCount,
          source: "plan" as const,
        },
      ];
    }
    return [];
  });
}

function sameArtifactReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.id === right.id &&
    left.mediaType === right.mediaType &&
    left.byteCount === right.byteCount &&
    left.source === right.source
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

function boundedManagedAgentActivityText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let bounded = "";
  for (const character of value) {
    if (Buffer.byteLength(bounded + character, "utf8") > maximumBytes) {
      break;
    }
    bounded += character;
  }
  return bounded;
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

function projectSessionHistoryDiagnostics(
  diagnostics: SessionHistoryDiagnostics,
): SessionHistoryDiagnosticsDisplay {
  return {
    items: diagnostics.items.map((item) => ({
      sessionId: item.sessionId,
      stage: item.stage,
      code: item.code,
      retained: true,
      message: item.message,
    })),
    totalCount: diagnostics.totalCount,
    truncated: diagnostics.truncated,
  };
}

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

function preflightSubmittedSkills(input: {
  readonly text: string;
  readonly explicitQualifiedIds: readonly string[];
  readonly catalog: SkillCatalogDisplay | null;
  readonly elements: PresentationDisplayState["composer"]["elements"];
}):
  | { readonly status: "resolved"; readonly compatibilityQualifiedIds: readonly string[] }
  | {
      readonly status: "rejected";
      readonly receipt: Extract<CommandReceipt, { readonly status: "rejected" }>;
    } {
  const unavailableSkill = input.elements.find(
    (element) => element.type === "skill" && !element.available,
  );
  if (unavailableSkill?.type === "skill") {
    return {
      status: "rejected",
      receipt: {
        status: "rejected",
        code: "not_available",
        message: `Skill $${unavailableSkill.name} is unavailable; delete it or choose a current Skill.`,
      },
    };
  }
  const exactQualifiedIds = input.elements.flatMap((element) =>
    element.type === "skill" ? [element.qualifiedId] : [],
  );
  const resolution = resolveSkillMentions({
    text: input.text,
    explicitQualifiedIds: [...exactQualifiedIds, ...input.explicitQualifiedIds],
    catalog: input.catalog,
  });
  return resolution.status === "ambiguous"
    ? { status: "rejected", receipt: ambiguousSkillMentionRejection(resolution) }
    : {
        status: "resolved",
        compatibilityQualifiedIds: resolution.qualifiedIds.filter(
          (qualifiedId) => !exactQualifiedIds.includes(qualifiedId),
        ),
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
  if (code === "session_workspace_untrusted") {
    return {
      status: "rejected",
      code: "authority_rejected",
      message:
        "This workspace is not trusted. Run adam-agent --trust-workspace in this project, then retry.",
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

function emptyUserModelPolicyDisplay() {
  return {
    contextWindowTokens: null,
    maximumOutputTokens: null,
    automaticCompactionWindowTokens: null,
  } as const;
}

function projectWebSearchConfiguration(snapshot: WebSearchConfigurationSnapshot) {
  return {
    status:
      snapshot.status === "configured"
        ? ("Configured" as const)
        : snapshot.status === "invalid"
          ? ("Invalid" as const)
          : snapshot.status === "unsafe"
            ? ("Unsafe" as const)
            : ("Unconfigured" as const),
    endpoint: snapshot.provider?.endpoint ?? null,
    syntheticDnsRange: snapshot.syntheticDnsRange ?? null,
    diagnostic: snapshot.diagnostic,
  };
}
