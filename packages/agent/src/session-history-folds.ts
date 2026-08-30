import type { ContextUsageTotals } from "./agent-session-contracts.js";
import { createContextProjectionMessage, estimateActiveContextTokens } from "./durable-context.js";
import { createInputResourceProjectionMessageV1 } from "./input-resources.js";
import type { ModelTargetIdentity } from "./model-targets.js";
import type { PlanCycleSnapshot } from "./plan-mode.js";
import {
  commitMcpToolProfileV3,
  hasSkillPromptContext,
  isPromptContextRecordValid,
  type PromptContextRecordV2,
  type PromptContextRecordV3,
  type PromptContextSnapshot,
  promptContextSnapshot,
  replacePromptRepositoryV1,
  replacePromptSkillsV2,
} from "./prompt-assembly.js";
import { modelMessagesFromCanonicalRecords } from "./session-history-replay.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import { sessionTitleFallback } from "./session-naming.js";
import type {
  CurrentSessionSnapshot,
  SessionContextSnapshot,
  SessionContextUsageSnapshot,
} from "./session-snapshot-contracts.js";
import type {
  SessionGenesisRecord,
  SessionLogicalRunStartedRecord,
  SessionRecord,
  SessionSkillActivationBatchCommittedRecord,
} from "./session-store.js";
import {
  isSkillContextRecordV1Valid,
  type SkillContextRecordV1,
  skillContextSnapshot,
} from "./skills.js";
import { hasTodoToolProfileV1, todoStoreSnapshotFromRecordsV1, todoSummaryV1 } from "./todo.js";

export function isSkillContextCatalogSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
): boolean {
  return (
    next.registry.revision === previous.registry.revision + 1 &&
    next.catalog.revision === next.registry.revision &&
    JSON.stringify(next.budget) === JSON.stringify(previous.budget) &&
    JSON.stringify(next.activeProjectScopes) === JSON.stringify(previous.activeProjectScopes) &&
    next.activationCounter === previous.activationCounter &&
    JSON.stringify(next.active) ===
      JSON.stringify(
        previous.active.filter((activation) =>
          next.active.some((entry) => entry.activationIndex === activation.activationIndex),
        ),
      ) &&
    JSON.stringify(next.revocations.slice(0, previous.revocations.length)) ===
      JSON.stringify(previous.revocations) &&
    previous.active
      .filter(
        (activation) =>
          !next.active.some((entry) => entry.activationIndex === activation.activationIndex),
      )
      .every((activation) =>
        next.revocations
          .slice(previous.revocations.length)
          .some(
            (revocation) =>
              revocation.activationIndex === activation.activationIndex &&
              revocation.qualifiedId === activation.qualifiedId &&
              revocation.revokedAtRevision === next.registry.revision,
          ),
      )
  );
}

export function isSkillContextPathSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
): boolean {
  return (
    next.registry.revision === previous.registry.revision + 1 &&
    next.catalog.revision === next.registry.revision &&
    JSON.stringify(next.budget) === JSON.stringify(previous.budget) &&
    JSON.stringify(next.active) === JSON.stringify(previous.active) &&
    next.activationCounter === previous.activationCounter &&
    JSON.stringify(next.revocations) === JSON.stringify(previous.revocations) &&
    JSON.stringify(next.extensionSources) === JSON.stringify(previous.extensionSources) &&
    previous.activeProjectScopes.every((scope) => next.activeProjectScopes.includes(scope)) &&
    next.activeProjectScopes.length > previous.activeProjectScopes.length
  );
}

function isSkillContextActivationSuccessor(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  runId: string,
): boolean {
  const staticPrevious = {
    recordVersion: previous.recordVersion,
    profileVersion: previous.profileVersion,
    budget: previous.budget,
    sourceRoots: previous.sourceRoots,
    extensionSources: previous.extensionSources,
    registry: previous.registry,
    catalog: previous.catalog,
    revocations: previous.revocations,
  };
  const staticNext = {
    recordVersion: next.recordVersion,
    profileVersion: next.profileVersion,
    budget: next.budget,
    sourceRoots: next.sourceRoots,
    extensionSources: next.extensionSources,
    registry: next.registry,
    catalog: next.catalog,
    revocations: next.revocations,
  };
  if (
    JSON.stringify(staticPrevious) !== JSON.stringify(staticNext) ||
    next.activationCounter <= previous.activationCounter ||
    next.activationCounter - previous.activationCounter !==
      next.active.length - previous.active.length ||
    next.active.length <= previous.active.length ||
    JSON.stringify(next.active.slice(0, previous.active.length)) !== JSON.stringify(previous.active)
  ) {
    return false;
  }
  const seen = new Set(previous.active.map((activation) => activation.qualifiedId));
  return next.active.slice(previous.active.length).every((activation, offset) => {
    const candidate = next.registry.candidates.find(
      (entry) => entry.qualifiedId === activation.qualifiedId,
    );
    const valid =
      activation.activationIndex === previous.activationCounter + offset + 1 &&
      activation.catalogRevision === next.catalog.revision &&
      activation.runId === runId &&
      !seen.has(activation.qualifiedId) &&
      candidate !== undefined &&
      candidate.skillMdDigest === activation.skillMdDigest &&
      candidate.byteCount === activation.byteCount &&
      candidate.estimatedTokens === activation.estimatedTokens &&
      JSON.stringify(candidate.artifact) === JSON.stringify(activation.artifact);
    seen.add(activation.qualifiedId);
    return valid;
  });
}

export function isSkillActivationBatchTransitionValid(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  record: SessionSkillActivationBatchCommittedRecord["record"],
): boolean {
  const newActivations = next.active.slice(previous.active.length);
  const activatedOutcomes = record.outcomes.filter((outcome) => outcome.status === "activated");
  const unchanged = JSON.stringify(previous) === JSON.stringify(next);
  if (
    (!unchanged && !isSkillContextActivationSuccessor(previous, next, record.runId)) ||
    (unchanged && activatedOutcomes.length > 0) ||
    activatedOutcomes.length !== newActivations.length ||
    new Set(record.outcomes.map((outcome) => outcome.requestId)).size !== record.outcomes.length
  ) {
    return false;
  }
  let activatedOffset = 0;
  return record.outcomes.every((outcome, outcomeIndex) => {
    const activation = next.active.find(
      (entry) => entry.activationIndex === outcome.activationIndex,
    );
    if (activation?.qualifiedId !== outcome.qualifiedId) {
      return false;
    }
    if (outcome.status === "activated") {
      const newActivation = newActivations[activatedOffset];
      activatedOffset += 1;
      return (
        newActivation?.qualifiedId === outcome.qualifiedId &&
        newActivation.requestId === outcome.requestId &&
        newActivation.activationIndex === outcome.activationIndex
      );
    }
    if (outcome.status === "already_active") {
      return previous.active.some(
        (entry) =>
          entry.qualifiedId === outcome.qualifiedId &&
          entry.activationIndex === outcome.activationIndex,
      );
    }
    return record.outcomes
      .slice(0, outcomeIndex)
      .some((entry) => entry.qualifiedId === outcome.qualifiedId);
  });
}

export function isSkillActivationBatchValid(
  previous: SkillContextRecordV1,
  next: SkillContextRecordV1,
  record: SessionSkillActivationBatchCommittedRecord["record"],
  run: SessionLogicalRunStartedRecord["record"],
): boolean {
  if (!isSkillActivationBatchTransitionValid(previous, next, record)) {
    return false;
  }
  const explicitSelections = run.skills ?? [];
  const explicitRequestIds = new Set(explicitSelections.map((selection) => selection.requestId));
  const isExplicitBatch = record.outcomes.some((outcome) =>
    explicitRequestIds.has(outcome.requestId),
  );
  if (!isExplicitBatch) {
    return record.outcomes.length === 1 && record.outcomes[0]?.status === "activated";
  }
  return (
    record.outcomes.length === explicitSelections.length &&
    record.outcomes.every(
      (outcome, index) =>
        outcome.requestId === explicitSelections[index]?.requestId &&
        outcome.selection === explicitSelections[index]?.selection &&
        resolvePersistedSkillSelection(previous, outcome.selection) === outcome.qualifiedId,
    )
  );
}

function resolvePersistedSkillSelection(
  context: SkillContextRecordV1,
  selection: string,
): string | undefined {
  const exact = context.registry.candidates.find(
    (candidate) => candidate.qualifiedId === selection,
  );
  if (exact !== undefined) {
    return exact.qualifiedId;
  }
  const shortMatches = context.registry.candidates.filter(
    (candidate) => candidate.name === selection,
  );
  return shortMatches.length === 1 ? shortMatches[0]?.qualifiedId : undefined;
}

export type ModelResponseArtifactDegradation = NonNullable<CurrentSessionSnapshot["degradation"]>;

export type ModelResponseArtifactInspection = {
  readonly contents: ReadonlyMap<number, { readonly text: string; readonly reasoning?: string }>;
  readonly degradation?: ModelResponseArtifactDegradation;
  readonly logicalReferencedBytes: number;
  readonly records: readonly SessionRecord[];
};

export function isGenesisRecord(record: SessionRecord): record is SessionGenesisRecord {
  return record.schemaVersion === 3 && record.record.type === "session_genesis";
}

export type SessionNamingHistoryState = {
  readonly manualName: string | null;
  readonly generatedTitle: string | null;
  readonly fallbackTitle: string | null;
  readonly displayLabel: string;
  readonly generation:
    | { readonly status: "not_started" }
    | { readonly status: "in_progress"; readonly generationId: string }
    | {
        readonly status: "completed";
        readonly generationId: string;
        readonly usage:
          | { readonly status: "unknown" }
          | {
              readonly status: "known";
              readonly inputTokens: number;
              readonly outputTokens: number;
            };
      }
    | {
        readonly status: "failed";
        readonly generationId: string;
        readonly reason: "model_request_failed" | "invalid_title" | "process_restart";
      }
    | { readonly status: "skipped_manual" };
};

export function sessionNamingStateFromRecords(
  records: readonly SessionRecord[],
): SessionNamingHistoryState {
  const genesis = records[0];
  let fallbackTitle =
    genesis?.schemaVersion === 3 && genesis.record.type === "session_genesis"
      ? (genesis.record.naming?.fallbackTitle ?? null)
      : null;
  let manualName: string | null = null;
  let generatedTitle: string | null = null;
  let generation: SessionNamingHistoryState["generation"] = { status: "not_started" };
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "logical_run_started" && fallbackTitle === null) {
      fallbackTitle =
        entry.record.naming?.fallbackTitle ?? sessionTitleFallback(entry.record.userMessage);
    } else if (entry.record.type === "session_manual_name_set") {
      manualName = entry.record.name;
    } else if (entry.record.type === "session_manual_name_cleared") {
      manualName = null;
    } else if (entry.record.type === "session_title_generation_started") {
      generation = { status: "in_progress", generationId: entry.record.generationId };
    } else if (entry.record.type === "session_title_generation_completed") {
      generatedTitle = entry.record.title;
      generation = {
        status: "completed",
        generationId: entry.record.generationId,
        usage: entry.record.usage,
      };
    } else if (entry.record.type === "session_title_generation_skipped_manual") {
      generation = { status: "skipped_manual" };
    } else if (entry.record.type === "session_title_generation_failed") {
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

export function attemptStatus(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
  attempt: {
    readonly runId: string;
    readonly turn: number;
    readonly attempt: number;
  },
): "started" | "interrupted" | "completed" {
  const matching = records.filter(
    (record) =>
      "runId" in record.record &&
      record.record.runId === attempt.runId &&
      "turn" in record.record &&
      record.record.turn === attempt.turn &&
      "attempt" in record.record &&
      record.record.attempt === attempt.attempt,
  );
  if (matching.some((record) => record.record.type === "model_response_completed")) {
    return "completed";
  }
  if (matching.some((record) => record.record.type === "provider_attempt_interrupted")) {
    return "interrupted";
  }
  return "started";
}

export function isCompleteBranchBoundary(records: readonly SessionRecord[]): boolean {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (currentRecords.length !== records.length || currentRecords.length === 0) {
    return false;
  }
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun === undefined) {
    const first = records[0];
    return (
      first !== undefined &&
      isGenesisRecord(first) &&
      currentRecords
        .slice(1)
        .every(
          (entry) =>
            ((entry.record.type === "repository_instructions_committed" ||
              entry.record.type === "repository_instructions_failed") &&
              entry.record.trigger === undefined) ||
            entry.record.type === "skill_catalog_committed" ||
            entry.record.type === "skill_catalog_failed" ||
            entry.record.type === "skill_revoked" ||
            entry.record.type === "mcp_workspace_confirmed" ||
            entry.record.type === "mcp_server_definition_approved" ||
            entry.record.type === "mcp_activation_started" ||
            entry.record.type === "mcp_activation_settled" ||
            entry.record.type === "mcp_tool_profile_committed" ||
            entry.record.type === "plan_cycle_entered" ||
            entry.record.type === "plan_cycle_exited" ||
            entry.record.type === "plan_cycle_inherited",
        )
    );
  }
  if (latestRun.record.type !== "logical_run_started") {
    return false;
  }
  const runId = latestRun.record.runId;
  const lastAttempt = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  if (
    lastAttempt?.record.type === "provider_attempt_started" &&
    attemptStatus(currentRecords, lastAttempt.record) === "started"
  ) {
    return false;
  }
  const lastResponse = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  if (
    lastResponse?.record.type !== "model_response_completed" ||
    lastResponse.record.response.finishReason !== "tool_calls"
  ) {
    return true;
  }
  return lastResponse.record.response.toolCalls.every((call) =>
    currentRecords.some(
      (candidate) =>
        candidate.sequence > lastResponse.sequence &&
        candidate.record.type === "runtime_event" &&
        candidate.record.runId === runId &&
        (candidate.record.event.type === "tool_completed" ||
          candidate.record.event.type === "tool_failed") &&
        candidate.record.event.callId === call.id &&
        candidate.record.event.name === call.name,
    ),
  );
}

export function areReplayProfilesCompatible(
  left: ModelTargetIdentity,
  right: ModelTargetIdentity,
): boolean {
  return (
    left.vendor === right.vendor &&
    left.route === right.route &&
    left.upstreamProviderId === right.upstreamProviderId &&
    left.profileVersion === right.profileVersion
  );
}

export function snapshotFromGenesis(
  genesis: SessionGenesisRecord,
  lastSequence: number,
): CurrentSessionSnapshot {
  const todo = hasTodoToolProfileV1(genesis.record.promptContext?.toolProfile.definitions ?? [])
    ? todoSummaryV1(todoStoreSnapshotFromRecordsV1([]))
    : undefined;
  return {
    schemaVersion: 3,
    sessionId: genesis.record.sessionId,
    projectId: genesis.record.projectId,
    targetIdentity: genesis.record.targetIdentity,
    status: "idle",
    lastSequence,
    ...(genesis.record.promptContext === undefined
      ? {}
      : { promptContext: promptContextSnapshot(genesis.record.promptContext) }),
    ...(genesis.record.skillContext === undefined
      ? {}
      : { skillContext: skillContextSnapshot(genesis.record.skillContext) }),
    ...(genesis.record.lineage === undefined ? {} : { lineage: genesis.record.lineage }),
    ...(todo === undefined ? {} : { todo }),
  };
}

function promptContextSnapshotFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): PromptContextSnapshot | undefined {
  const context = promptContextRecordFromRecords(genesis, records);
  if (context === undefined) {
    return undefined;
  }
  const snapshot = promptContextSnapshot(context);
  const latestProjection = records.findLast(
    (entry) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "provider_attempt_started" &&
      entry.record.promptProjection !== undefined,
  );
  return latestProjection?.schemaVersion === 3 &&
    latestProjection.record.type === "provider_attempt_started" &&
    latestProjection.record.promptProjection !== undefined
    ? {
        ...snapshot,
        lastRequestProjectionDigest:
          latestProjection.record.promptProjection.requestProjectionDigest,
      }
    : snapshot;
}

export function promptContextRecordFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): SessionGenesisRecord["record"]["promptContext"] {
  let context = genesis.record.promptContext;
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "repository_instructions_committed") {
      if (
        context === undefined ||
        entry.record.previousRevision !== context.repository.revision ||
        entry.record.previousEffectiveDigest !== context.repository.effectiveDigest ||
        entry.record.repository.revision !== context.repository.revision + 1
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptRepositoryV1(context, entry.record.repository);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "mcp_tool_profile_committed") {
      if (
        context?.recordVersion !== 3 ||
        context.mcp !== undefined ||
        entry.record.previousAssemblyIdentityDigest !== context.assemblyIdentityDigest
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = commitMcpToolProfileV3(context, entry.record.profile);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "path_context_committed") {
      if (
        !hasSkillPromptContext(context) ||
        entry.record.previousRepositoryRevision !== context.repository.revision ||
        entry.record.previousRepositoryDigest !== context.repository.effectiveDigest ||
        entry.record.repository.revision !== context.repository.revision + 1
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      let next = replacePromptRepositoryV1(context, entry.record.repository) as
        | PromptContextRecordV2
        | PromptContextRecordV3;
      next = replacePromptSkillsV2(next, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
      continue;
    }
    if (entry.record.type === "skill_activation_batch_committed") {
      if (!hasSkillPromptContext(context)) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptSkillsV2(context, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
    }
    if (entry.record.type === "skill_catalog_committed") {
      if (!hasSkillPromptContext(context)) {
        throw new SessionLifecycleError("session_invalid");
      }
      const next = replacePromptSkillsV2(context, entry.record.skillContext);
      if (
        next.assemblyIdentityDigest !== entry.record.assemblyIdentityDigest ||
        !isPromptContextRecordValid(next)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = next;
    }
  }
  return context;
}

export function skillContextRecordFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
): SkillContextRecordV1 | undefined {
  let context = genesis.record.skillContext;
  for (const entry of records) {
    if (
      entry.schemaVersion !== 3 ||
      (entry.record.type !== "skill_activation_batch_committed" &&
        entry.record.type !== "skill_catalog_committed" &&
        entry.record.type !== "path_context_committed")
    ) {
      continue;
    }
    if (entry.record.type === "skill_catalog_committed") {
      if (
        context === undefined ||
        entry.record.previousRevision !== context.registry.revision ||
        entry.record.previousRegistryDigest !== context.registry.digest ||
        !isSkillContextRecordV1Valid(entry.record.skillContext) ||
        !isSkillContextCatalogSuccessor(context, entry.record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = entry.record.skillContext;
      continue;
    }
    if (entry.record.type === "path_context_committed") {
      if (
        context === undefined ||
        entry.record.previousSkillRevision !== context.registry.revision ||
        entry.record.previousSkillRegistryDigest !== context.registry.digest ||
        !isSkillContextRecordV1Valid(entry.record.skillContext) ||
        !isSkillContextPathSuccessor(context, entry.record.skillContext)
      ) {
        throw new SessionLifecycleError("session_invalid");
      }
      context = entry.record.skillContext;
      continue;
    }
    if (
      context === undefined ||
      entry.record.previousActivationDigest !== context.activationDigest ||
      !isSkillContextRecordV1Valid(entry.record.skillContext) ||
      !isSkillActivationBatchTransitionValid(context, entry.record.skillContext, entry.record)
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    context = entry.record.skillContext;
  }
  return context;
}

export function contextSnapshotFromRecords(
  records: readonly SessionRecord[],
): SessionContextSnapshot | undefined {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const checkpoint = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_committed",
  );
  const started = currentRecords.findLast(
    (record) => record.record.type === "context_compaction_started",
  );
  const checkpointRecord =
    checkpoint?.record.type === "context_compaction_committed" ? checkpoint.record : undefined;
  const startedRecord =
    started?.record.type === "context_compaction_started" ? started.record : undefined;
  if (checkpointRecord === undefined && startedRecord === undefined) {
    return undefined;
  }
  const compactionUsage = compactionContextUsageFromRecords(currentRecords);
  const ordinaryUsage = ordinaryContextUsageFromRecords(currentRecords);
  const lastTerminal =
    startedRecord === undefined
      ? undefined
      : currentRecords.findLast(
          (record) =>
            record.sequence > (started?.sequence ?? 0) &&
            (record.record.type === "context_compaction_committed" ||
              record.record.type === "context_compaction_failed" ||
              record.record.type === "context_compaction_interrupted") &&
            record.record.attemptId === startedRecord.attemptId,
        );
  const terminalRecord =
    lastTerminal?.record.type === "context_compaction_committed" ||
    lastTerminal?.record.type === "context_compaction_failed" ||
    lastTerminal?.record.type === "context_compaction_interrupted"
      ? lastTerminal.record
      : undefined;
  const lastAttemptUsage =
    terminalRecord?.usage === undefined ? ({ status: "unknown" } as const) : terminalRecord.usage;
  const lastAttemptStatus =
    terminalRecord?.type === "context_compaction_committed"
      ? ("committed" as const)
      : terminalRecord?.type === "context_compaction_failed"
        ? ("failed" as const)
        : terminalRecord?.type === "context_compaction_interrupted"
          ? ("interrupted" as const)
          : ("started" as const);
  const latestResponse = currentRecords.findLast(
    (record) =>
      record.sequence > (checkpoint?.sequence ?? Number.MAX_SAFE_INTEGER) &&
      record.record.type === "model_response_completed",
  );
  const active =
    latestResponse?.record.type === "model_response_completed" &&
    latestResponse.record.response.usage !== undefined
      ? {
          source: "provider_reported" as const,
          tokens: latestResponse.record.response.usage.inputTokens,
        }
      : checkpointRecord !== undefined
        ? {
            source: "estimated" as const,
            tokens: estimateActiveContextTokens(
              [
                createContextProjectionMessage(checkpointRecord.summary, checkpointRecord.evidence),
                ...(checkpointRecord.inputResources === undefined ||
                checkpointRecord.inputResources.length === 0
                  ? []
                  : [createInputResourceProjectionMessageV1(checkpointRecord.inputResources)]),
                ...modelMessagesFromCanonicalRecords(
                  currentRecords.filter(
                    (record) =>
                      record.sequence >= checkpointRecord.retainedFrom &&
                      record.sequence <= checkpointRecord.sourceThrough,
                  ),
                ),
              ],
              checkpointRecord.contextProfile,
            ),
          }
        : { source: "unknown" as const };
  return {
    profile:
      startedRecord?.contextProfile ??
      (checkpointRecord as NonNullable<typeof checkpointRecord>).contextProfile,
    ...(checkpointRecord === undefined || checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            checkpointId: checkpointRecord.checkpointId,
            sequence: checkpoint.sequence,
            windowNumber: checkpointRecord.windowNumber,
            status: "committed" as const,
            sourceThrough: checkpointRecord.sourceThrough,
            retainedFrom: checkpointRecord.retainedFrom,
          },
        }),
    lastAttempt: {
      attemptId:
        startedRecord?.attemptId ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).attemptId,
      attemptNumber:
        startedRecord?.attemptNumber ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).attemptNumber,
      windowNumber:
        startedRecord?.windowNumber ??
        (checkpointRecord as NonNullable<typeof checkpointRecord>).windowNumber,
      status: lastAttemptStatus,
      ...(terminalRecord?.type === "context_compaction_failed" ||
      terminalRecord?.type === "context_compaction_interrupted"
        ? { reason: terminalRecord.reason }
        : {}),
      usage: lastAttemptUsage,
    },
    ordinaryUsage,
    compactionUsage,
    active,
  };
}

export function contextUsageSnapshotFromRecords(
  records: readonly SessionRecord[],
): SessionContextUsageSnapshot | undefined {
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  if (
    !currentRecords.some(
      ({ record }) =>
        record.type === "provider_attempt_started" ||
        record.type === "context_compaction_started" ||
        record.type === "context_compaction_committed" ||
        record.type === "context_compaction_failed" ||
        record.type === "context_compaction_interrupted",
    )
  ) {
    return undefined;
  }
  const latestAttemptBoundary = currentRecords.findLast(
    ({ record }) =>
      record.type === "provider_attempt_started" ||
      record.type === "model_response_completed" ||
      record.type === "provider_attempt_interrupted",
  );
  return {
    ordinaryUsage: ordinaryContextUsageFromRecords(currentRecords),
    compactionUsage: compactionContextUsageFromRecords(currentRecords),
    active:
      latestAttemptBoundary?.record.type === "model_response_completed" &&
      latestAttemptBoundary.record.response.usage !== undefined
        ? {
            source: "provider_reported",
            tokens: latestAttemptBoundary.record.response.usage.inputTokens,
          }
        : { source: "unknown" },
  };
}

function compactionContextUsageFromRecords(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ContextUsageTotals {
  return records.reduce<ContextUsageTotals>((totals, entry) => {
    if (
      entry.record.type !== "context_compaction_committed" &&
      entry.record.type !== "context_compaction_failed" &&
      entry.record.type !== "context_compaction_interrupted"
    ) {
      return totals;
    }
    const usage = entry.record.usage;
    if (usage === undefined || "status" in usage) {
      return incrementUnknownContextUsage(totals);
    }
    return {
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + usage.outputTokens,
      reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
      cachedInputTokens: totals.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      cacheMissInputTokens: totals.cacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
      unknownCalls: totals.unknownCalls,
    };
  }, emptyContextUsageTotals());
}

export function addContextUsageTotals(
  left: ContextUsageTotals,
  right: ContextUsageTotals,
): ContextUsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheMissInputTokens: left.cacheMissInputTokens + right.cacheMissInputTokens,
    unknownCalls: left.unknownCalls + right.unknownCalls,
  };
}

function emptyContextUsageTotals(): ContextUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    unknownCalls: 0,
  };
}

function incrementUnknownContextUsage(totals: ContextUsageTotals): ContextUsageTotals {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheMissInputTokens: totals.cacheMissInputTokens,
    unknownCalls: totals.unknownCalls + 1,
  };
}

function ordinaryContextUsageFromRecords(
  records: readonly Extract<SessionRecord, { readonly schemaVersion: 3 }>[],
): ContextUsageTotals {
  let totals: ContextUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    unknownCalls: 0,
  };
  let attemptStarted = false;
  let usageSeen = false;
  for (const entry of records) {
    const record = entry.record;
    if (record.type === "provider_attempt_started") {
      attemptStarted = true;
      usageSeen = false;
      continue;
    }
    if (record.type === "runtime_event" && record.event.type === "model_usage" && attemptStarted) {
      usageSeen = true;
      totals = {
        inputTokens: totals.inputTokens + record.event.inputTokens,
        outputTokens: totals.outputTokens + record.event.outputTokens,
        reasoningTokens: totals.reasoningTokens + (record.event.reasoningTokens ?? 0),
        cachedInputTokens: totals.cachedInputTokens + (record.event.cachedInputTokens ?? 0),
        cacheMissInputTokens:
          totals.cacheMissInputTokens + (record.event.cacheMissInputTokens ?? 0),
        unknownCalls: totals.unknownCalls,
      };
      continue;
    }
    if (
      attemptStarted &&
      (record.type === "model_response_completed" || record.type === "provider_attempt_interrupted")
    ) {
      if (!usageSeen) {
        totals = incrementUnknownContextUsage(totals);
      }
      attemptStarted = false;
      usageSeen = false;
    }
  }
  return totals;
}

export function snapshotFromRecords(
  genesis: SessionGenesisRecord,
  records: readonly SessionRecord[],
  artifactInspection?: ModelResponseArtifactInspection,
): CurrentSessionSnapshot {
  if (records.some((record) => record.schemaVersion !== 3)) {
    throw new SessionLifecycleError("session_invalid");
  }
  const currentRecords = records.filter((record) => record.schemaVersion === 3);
  const context = contextSnapshotFromRecords(records);
  const plan = planCycleSnapshotFromRecords(records);
  const todo = hasTodoToolProfileV1(genesis.record.promptContext?.toolProfile.definitions ?? [])
    ? todoSummaryV1(todoStoreSnapshotFromRecordsV1(records))
    : undefined;
  const latestRun = currentRecords.findLast(
    (record) => record.record.type === "logical_run_started",
  );
  if (latestRun === undefined || latestRun.record.type !== "logical_run_started") {
    const promptContext = promptContextSnapshotFromRecords(genesis, records);
    const skillContext = skillContextRecordFromRecords(genesis, records);
    return {
      ...snapshotFromGenesis(genesis, records.length),
      ...(promptContext === undefined ? {} : { promptContext }),
      ...(skillContext === undefined ? {} : { skillContext: skillContextSnapshot(skillContext) }),
      ...(context === undefined ? {} : { context }),
      ...(plan === undefined ? {} : { plan }),
      ...(todo === undefined ? {} : { todo }),
      ...(artifactInspection?.degradation === undefined
        ? {}
        : { degradation: artifactInspection.degradation }),
    };
  }
  const runId = latestRun.record.runId;
  const lastResponse = currentRecords.findLast(
    (record) => record.record.type === "model_response_completed" && record.record.runId === runId,
  );
  const settlement = currentRecords.findLast(
    (record) =>
      record.record.type === "runtime_event" &&
      record.record.runId === runId &&
      record.record.event.type === "session_settled",
  );
  const linkedSettlement = currentRecords.findLast(
    (record) => record.record.type === "run_settled" && record.record.runId === runId,
  );
  const lastAttemptStarted = currentRecords.findLast(
    (record) => record.record.type === "provider_attempt_started" && record.record.runId === runId,
  );
  const lastAttempt =
    lastAttemptStarted?.record.type !== "provider_attempt_started"
      ? undefined
      : {
          turn: lastAttemptStarted.record.turn,
          attempt: lastAttemptStarted.record.attempt,
          status: attemptStatus(currentRecords, lastAttemptStarted.record),
        };
  const result =
    settlement?.record.type === "runtime_event" &&
    settlement.record.event.type === "session_settled"
      ? settlement.record.event.result
      : linkedSettlement?.record.type === "run_settled"
        ? artifactInspection?.contents.get(linkedSettlement.record.responseSequence) === undefined
          ? undefined
          : linkedSettlement.record.status === "completed"
            ? {
                status: "completed" as const,
                answer: artifactInspection.contents.get(linkedSettlement.record.responseSequence)
                  ?.text as string,
              }
            : {
                status: "incomplete" as const,
                reason: linkedSettlement.record.reason,
                answer: artifactInspection.contents.get(linkedSettlement.record.responseSequence)
                  ?.text as string,
              }
        : undefined;
  const isSettled = settlement !== undefined || linkedSettlement !== undefined;
  const promptContext = promptContextSnapshotFromRecords(genesis, records);
  const skillContext = skillContextRecordFromRecords(genesis, records);
  return {
    ...snapshotFromGenesis(genesis, records.length),
    ...(promptContext === undefined ? {} : { promptContext }),
    ...(skillContext === undefined ? {} : { skillContext: skillContextSnapshot(skillContext) }),
    ...(context === undefined ? {} : { context }),
    ...(plan === undefined ? {} : { plan }),
    ...(todo === undefined ? {} : { todo }),
    ...(artifactInspection?.degradation === undefined
      ? {}
      : { degradation: artifactInspection.degradation }),
    status: isSettled ? "settled" : "interrupted",
    run: {
      runId,
      status: isSettled ? "settled" : "interrupted",
      ...(result === undefined ? {} : { result }),
      ...(lastAttempt === undefined ? {} : { lastAttempt }),
      ...(lastResponse?.record.type !== "model_response_completed"
        ? {}
        : {
            lastCompletedResponse: {
              turn: lastResponse.record.turn,
              attempt: lastResponse.record.attempt,
              finishReason: lastResponse.record.response.finishReason,
            },
          }),
    },
  };
}

export function planCycleSnapshotFromRecords(
  records: readonly SessionRecord[],
): PlanCycleSnapshot | undefined {
  let active: PlanCycleSnapshot | undefined;
  for (const entry of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (
      entry.record.type === "plan_cycle_entered" ||
      entry.record.type === "plan_cycle_inherited"
    ) {
      active = {
        state: "exploring",
        cycleId: entry.record.cycleId,
        revision: entry.record.revision,
        policyVersion: entry.record.policyVersion,
        ...(entry.record.shellPolicyVersion === undefined
          ? {}
          : { shellPolicyVersion: entry.record.shellPolicyVersion }),
        ...(entry.record.shellEnvironment === undefined
          ? {}
          : { shellEnvironment: entry.record.shellEnvironment }),
        ...(entry.record.gitPolicyVersion === undefined
          ? {}
          : { gitPolicyVersion: entry.record.gitPolicyVersion }),
        ...(entry.record.gitPolicyDigest === undefined
          ? {}
          : { gitPolicyDigest: entry.record.gitPolicyDigest }),
        ...("gitAttestation" in entry.record && entry.record.gitAttestation !== undefined
          ? { gitAttestation: entry.record.gitAttestation }
          : {}),
        eligibleToolProfile: entry.record.eligibleToolProfile,
      };
      if (
        entry.record.type === "plan_cycle_inherited" &&
        entry.record.state === "ready" &&
        entry.record.submission !== undefined
      ) {
        active = { ...active, state: "ready", submission: entry.record.submission };
      }
    } else if (
      entry.record.type === "plan_git_attested" &&
      entry.record.cycleId === active?.cycleId
    ) {
      active = { ...active, gitAttestation: entry.record.attestation };
    } else if (
      entry.record.type === "plan_submitted" &&
      active?.state === "exploring" &&
      entry.record.cycleId === active.cycleId &&
      entry.record.revision === active.revision + 1
    ) {
      active = {
        ...active,
        state: "ready",
        revision: entry.record.revision,
        submission: {
          planId: entry.record.planId,
          revision: entry.record.revision,
          contentDigest: entry.record.contentDigest,
          ...(entry.record.title === undefined ? {} : { title: entry.record.title }),
          artifact: entry.record.artifact,
          policyVersion: entry.record.policyVersion,
          toolProfileDigest: entry.record.toolProfileDigest,
        },
      };
    } else if (
      entry.record.type === "plan_approval_intent" &&
      active?.state === "ready" &&
      entry.record.cycleId === active.cycleId &&
      entry.record.revision === active.revision &&
      entry.record.planId === active.submission.planId &&
      entry.record.contentDigest === active.submission.contentDigest &&
      entry.record.policyVersion === active.policyVersion &&
      entry.record.toolProfileDigest === active.eligibleToolProfile.digest
    ) {
      active = {
        ...active,
        state: "approved_not_started",
        approval: {
          sessionId: entry.record.sessionId,
          commandId: entry.record.commandId,
          kickoffRunId: entry.record.kickoffRunId,
          cycleId: entry.record.cycleId,
          revision: entry.record.revision,
          planId: entry.record.planId,
          contentDigest: entry.record.contentDigest,
          policyVersion: entry.record.policyVersion,
          toolProfileDigest: entry.record.toolProfileDigest,
        },
      };
    } else if (
      entry.record.type === "logical_run_started" &&
      entry.record.planKickoff !== undefined &&
      active?.state === "approved_not_started" &&
      entry.record.runId === active.approval.kickoffRunId &&
      entry.record.planKickoff.commandId === active.approval.commandId &&
      entry.record.planKickoff.planId === active.submission.planId &&
      entry.record.planKickoff.contentDigest === active.submission.contentDigest
    ) {
      active = undefined;
    } else if (
      entry.record.type === "logical_run_started" &&
      entry.record.planRevision !== undefined &&
      active?.state === "ready" &&
      entry.record.planRevision.cycleId === active.cycleId &&
      entry.record.planRevision.fromRevision === active.revision &&
      entry.record.planRevision.planId === active.submission.planId &&
      entry.record.planRevision.contentDigest === active.submission.contentDigest
    ) {
      const { submission: _submission, ...withoutSubmission } = active;
      active = {
        ...withoutSubmission,
        state: "exploring",
        revision: entry.record.planRevision.toRevision,
      };
    } else if (
      entry.record.type === "plan_cycle_exited" &&
      entry.record.cycleId === active?.cycleId &&
      entry.record.revision === active.revision + 1
    ) {
      active = undefined;
    }
  }
  return active;
}
