import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ContextEvidenceV1,
  mergeContextEvidence,
  reduceContextEvidence,
} from "./durable-context.js";
import {
  isCompleteBranchBoundary,
  isGenesisRecord,
  planCycleSnapshotFromRecords,
  promptContextRecordFromRecords,
} from "./session-history-folds.js";
import { validateCurrentSessionHistory } from "./session-history-validation.js";
import { SessionLifecycleError } from "./session-lifecycle-error.js";
import type { SessionGenesisRecord, SessionRecord } from "./session-store.js";

export type SessionLineageRecordReader = (sessionId: string) => Promise<readonly SessionRecord[]>;

export type ValidatedLineagePrefix = {
  readonly parentGenesis: SessionGenesisRecord;
  readonly prefixRecords: readonly SessionRecord[];
};

export type SessionLineageTraversal = {
  readonly createInheritedContextEvidence: (
    records: readonly SessionRecord[],
  ) => Promise<ContextEvidenceV1 | undefined>;
  readonly readValidatedLineagePrefix: (
    childGenesis: SessionGenesisRecord,
  ) => Promise<ValidatedLineagePrefix>;
  readonly sessionInheritsSourceBoundary: (
    sessionGenesis: SessionGenesisRecord,
    sourceSessionId: string,
    sourceEventPosition: number,
  ) => Promise<boolean>;
  readonly validateSessionLineage: (
    genesis: SessionGenesisRecord,
    records: readonly SessionRecord[],
  ) => Promise<void>;
};

export function createSessionLineageTraversal(input: {
  readonly readRecords: SessionLineageRecordReader;
  readonly workspaceRoot: string;
}): SessionLineageTraversal {
  async function validateSessionLineage(
    genesis: SessionGenesisRecord,
    records: readonly SessionRecord[],
  ): Promise<void> {
    await validateSessionLineageAncestors(genesis, records, new Set([genesis.record.sessionId]));
    await validateInheritedContextEvidence(genesis, records);
  }

  async function validateSessionLineageAncestors(
    genesis: SessionGenesisRecord,
    records: readonly SessionRecord[],
    visited: ReadonlySet<string>,
  ): Promise<void> {
    const lineage = genesis.record.lineage;
    if (lineage === undefined) {
      return;
    }
    if (visited.has(lineage.parentSessionId)) {
      throw new SessionLifecycleError("session_invalid");
    }
    const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(genesis);
    validateInheritedPlanCycle(genesis, records, prefixRecords);
    const expectedPromptContext = promptContextRecordFromRecords(parentGenesis, prefixRecords);
    if (!isDeepStrictEqual(genesis.record.promptContext, expectedPromptContext)) {
      throw new SessionLifecycleError("session_invalid");
    }
    await validateInheritedContextEvidence(parentGenesis, prefixRecords);
    if ("recordVersion" in lineage) {
      const declaredParentRecords = await input.readRecords(lineage.parentSessionId);
      const declaredParentGenesis = declaredParentRecords[0];
      if (declaredParentGenesis === undefined || !isGenesisRecord(declaredParentGenesis)) {
        throw new SessionLifecycleError("session_invalid");
      }
      await validateSessionLineageAncestors(
        declaredParentGenesis,
        declaredParentRecords,
        new Set([...visited, lineage.parentSessionId]),
      );
      return;
    }
    await validateSessionLineageAncestors(
      parentGenesis,
      await input.readRecords(parentGenesis.record.sessionId),
      new Set([...visited, lineage.parentSessionId]),
    );
  }

  function validateInheritedPlanCycle(
    genesis: SessionGenesisRecord,
    records: readonly SessionRecord[],
    prefixRecords: readonly SessionRecord[],
  ): void {
    const lineage = genesis.record.lineage;
    if (lineage === undefined) {
      return;
    }
    const inherited = records.filter(
      (entry) => entry.schemaVersion === 3 && entry.record.type === "plan_cycle_inherited",
    );
    const sourcePlan = planCycleSnapshotFromRecords(prefixRecords);
    if (sourcePlan === undefined) {
      if (inherited.length > 0) {
        throw new SessionLifecycleError("session_invalid");
      }
      return;
    }
    const expected =
      sourcePlan.state === "approved_not_started"
        ? (() => {
            const { approval: _approval, ...withoutApproval } = sourcePlan;
            return { ...withoutApproval, state: "ready" as const };
          })()
        : sourcePlan;
    const actual = inherited[0];
    const sourceSessionId =
      "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
    const sourceEventPosition =
      "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
    if (
      inherited.length !== 1 ||
      actual?.schemaVersion !== 3 ||
      actual.sequence !== 2 ||
      actual.record.type !== "plan_cycle_inherited" ||
      actual.record.source.sessionId !== sourceSessionId ||
      actual.record.source.throughSequence !== sourceEventPosition ||
      !isDeepStrictEqual(
        {
          state: actual.record.state ?? "exploring",
          cycleId: actual.record.cycleId,
          revision: actual.record.revision,
          policyVersion: actual.record.policyVersion,
          ...(actual.record.shellPolicyVersion === undefined
            ? {}
            : { shellPolicyVersion: actual.record.shellPolicyVersion }),
          ...(actual.record.shellEnvironment === undefined
            ? {}
            : { shellEnvironment: actual.record.shellEnvironment }),
          ...(actual.record.gitPolicyVersion === undefined
            ? {}
            : { gitPolicyVersion: actual.record.gitPolicyVersion }),
          ...(actual.record.gitPolicyDigest === undefined
            ? {}
            : { gitPolicyDigest: actual.record.gitPolicyDigest }),
          ...(actual.record.gitAttestation === undefined
            ? {}
            : { gitAttestation: actual.record.gitAttestation }),
          eligibleToolProfile: actual.record.eligibleToolProfile,
          ...(actual.record.submission === undefined
            ? {}
            : { submission: actual.record.submission }),
        },
        expected,
      )
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
  }

  async function sessionInheritsSourceBoundary(
    sessionGenesis: SessionGenesisRecord,
    sourceSessionId: string,
    sourceEventPosition: number,
  ): Promise<boolean> {
    return sessionInheritsSourceBoundaryFrom(
      sessionGenesis,
      sourceSessionId,
      sourceEventPosition,
      new Set(),
    );
  }

  async function sessionInheritsSourceBoundaryFrom(
    sessionGenesis: SessionGenesisRecord,
    sourceSessionId: string,
    sourceEventPosition: number,
    visited: ReadonlySet<string>,
  ): Promise<boolean> {
    if (visited.has(sessionGenesis.record.sessionId)) {
      return false;
    }
    if (sessionGenesis.record.sessionId === sourceSessionId) {
      const ownRecords = await input.readRecords(sourceSessionId);
      return sourceEventPosition <= ownRecords.length;
    }
    const lineage = sessionGenesis.record.lineage;
    if (lineage === undefined) {
      return false;
    }
    const inheritedSessionId =
      "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
    const inheritedEventPosition =
      "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
    if (sourceSessionId === inheritedSessionId) {
      return sourceEventPosition <= inheritedEventPosition;
    }
    const inheritedRecords = await input.readRecords(inheritedSessionId);
    const inheritedGenesis = inheritedRecords[0];
    if (inheritedGenesis === undefined || !isGenesisRecord(inheritedGenesis)) {
      return false;
    }
    return sessionInheritsSourceBoundaryFrom(
      inheritedGenesis,
      sourceSessionId,
      sourceEventPosition,
      new Set([...visited, sessionGenesis.record.sessionId]),
    );
  }

  async function validateInheritedContextEvidence(
    genesis: SessionGenesisRecord,
    records: readonly SessionRecord[],
  ): Promise<void> {
    const expected = await createBranchEvidence(records);
    for (const entry of records) {
      if (entry.schemaVersion !== 3 || entry.record.type !== "context_compaction_committed") {
        continue;
      }
      const actual = inheritedContextEvidence(entry.record.evidence);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new SessionLifecycleError("session_invalid");
      }
    }
    if (genesis.record.lineage === undefined && hasContextEvidence(expected)) {
      throw new SessionLifecycleError("session_invalid");
    }
  }

  async function createBranchEvidence(
    records: readonly SessionRecord[],
  ): Promise<ContextEvidenceV1> {
    const genesis = records[0];
    if (genesis === undefined || !isGenesisRecord(genesis)) {
      throw new SessionLifecycleError("session_invalid");
    }
    if (genesis.record.lineage === undefined) {
      return emptyContextEvidence();
    }
    const { parentGenesis, prefixRecords } = await readValidatedLineagePrefix(genesis);
    const inherited = await createBranchEvidence(prefixRecords);
    const run = prefixRecords.findLast(
      (record) => record.schemaVersion === 3 && record.record.type === "logical_run_started",
    );
    if (run?.schemaVersion !== 3 || run.record.type !== "logical_run_started") {
      return inherited;
    }
    return mergeContextEvidence(
      inherited,
      reduceContextEvidence(
        prefixRecords,
        run.record.runId,
        prefixRecords.at(-1)?.sequence ?? 1,
        parentGenesis.record.sessionId,
      ),
    );
  }

  async function createInheritedContextEvidence(
    records: readonly SessionRecord[],
  ): Promise<ContextEvidenceV1 | undefined> {
    const evidence = await createBranchEvidence(records);
    return hasContextEvidence(evidence) ? evidence : undefined;
  }

  function inheritedContextEvidence(evidence: ContextEvidenceV1): ContextEvidenceV1 {
    return {
      schemaVersion: 1,
      modifiedFiles: evidence.modifiedFiles.filter((entry) => entry.sessionId !== undefined),
      permissions: evidence.permissions.filter((entry) => entry.sessionId !== undefined),
      toolResults: evidence.toolResults.filter((entry) => entry.sessionId !== undefined),
      failures: evidence.failures.filter((entry) => entry.sessionId !== undefined),
    };
  }

  function emptyContextEvidence(): ContextEvidenceV1 {
    return {
      schemaVersion: 1,
      modifiedFiles: [],
      permissions: [],
      toolResults: [],
      failures: [],
    };
  }

  function hasContextEvidence(evidence: ContextEvidenceV1): boolean {
    return (
      evidence.modifiedFiles.length > 0 ||
      evidence.permissions.length > 0 ||
      evidence.toolResults.length > 0 ||
      evidence.failures.length > 0
    );
  }

  async function readValidatedLineagePrefix(
    childGenesis: SessionGenesisRecord,
  ): Promise<ValidatedLineagePrefix> {
    const lineage = childGenesis.record.lineage;
    if (lineage === undefined) {
      throw new SessionLifecycleError("session_invalid");
    }
    let declaredParentRecords: readonly SessionRecord[];
    try {
      declaredParentRecords = await input.readRecords(lineage.parentSessionId);
    } catch {
      throw new SessionLifecycleError("session_invalid");
    }
    const declaredParentGenesis = declaredParentRecords[0];
    if (
      declaredParentGenesis === undefined ||
      !isGenesisRecord(declaredParentGenesis) ||
      declaredParentGenesis.record.sessionId !== lineage.parentSessionId ||
      declaredParentGenesis.record.projectId !== childGenesis.record.projectId
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const sourceSessionId =
      "recordVersion" in lineage ? lineage.sourceSessionId : lineage.parentSessionId;
    const sourceEventPosition =
      "recordVersion" in lineage ? lineage.sourceEventPosition : lineage.parentEventPosition;
    if (
      !(await sessionInheritsSourceBoundary(
        declaredParentGenesis,
        sourceSessionId,
        sourceEventPosition,
      ))
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const parentRecords =
      sourceSessionId === lineage.parentSessionId
        ? declaredParentRecords
        : await input.readRecords(sourceSessionId);
    const parentGenesis = parentRecords[0];
    if (
      parentGenesis === undefined ||
      !isGenesisRecord(parentGenesis) ||
      parentGenesis.record.projectId !== childGenesis.record.projectId ||
      sourceEventPosition > parentRecords.length
    ) {
      throw new SessionLifecycleError("session_invalid");
    }
    const prefixRecords = parentRecords.slice(0, sourceEventPosition);
    const prefix = `${prefixRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const digest = `sha256:${createHash("sha256").update(prefix).digest("hex")}`;
    const expectedDigest =
      "recordVersion" in lineage ? lineage.sourcePrefixDigest : lineage.prefixDigest;
    if (digest !== expectedDigest || !isCompleteBranchBoundary(prefixRecords)) {
      throw new SessionLifecycleError("session_invalid");
    }
    validateCurrentSessionHistory(parentGenesis, prefixRecords, input.workspaceRoot);
    return { parentGenesis, prefixRecords };
  }

  return {
    createInheritedContextEvidence,
    readValidatedLineagePrefix,
    sessionInheritsSourceBoundary,
    validateSessionLineage,
  };
}
