import type {
  SessionLogicalRunStartedRecord,
  SessionSkillActivationBatchCommittedRecord,
} from "./session-store.js";
import type { SkillContextRecordV1 } from "./skills.js";

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
