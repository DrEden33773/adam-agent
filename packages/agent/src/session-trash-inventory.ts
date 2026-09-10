import {
  type ManagedControlRecord,
  type ManagedControlStore,
  managedTranscriptLink,
} from "./managed-agent-folds.js";
import { validateManagedChildGenesis } from "./managed-agent-recovery.js";
import { isGenesisRecord, sessionNamingStateFromRecords } from "./session-history-folds.js";
import {
  createSessionHistoryValidator,
  validateCurrentSessionHistory,
} from "./session-history-validation.js";
import type {
  SessionGenesisRecord,
  SessionRecord,
  SessionStoreDirectory,
} from "./session-store.js";
import {
  type SessionTrashCatalog,
  SessionTrashError,
  type SessionTrashFileSpec,
  type SessionTrashUnit,
} from "./session-trash.js";

export type SessionTrashBlocker = {
  readonly kind: "activity" | "dependency" | "ownership";
  readonly message: string;
  readonly sessionIds: readonly string[];
};

export async function readSessionTrashRecords(
  directory: SessionStoreDirectory,
  sessionId: string,
): Promise<readonly SessionRecord[]> {
  return directory.readRecords === undefined
    ? ((await (await directory.open(sessionId))?.read()) ?? [])
    : ((await directory.readRecords(sessionId)) ?? []);
}

function sources(genesis: SessionGenesisRecord): readonly string[] {
  const lineage = genesis.record.lineage;
  return lineage === undefined
    ? []
    : [
        ...new Set([
          lineage.parentSessionId,
          ...("sourceSessionId" in lineage ? [lineage.sourceSessionId] : []),
        ]),
      ];
}

/** Preview and Restore use the same proof, including cancellation before a log exists. */
export function validateTrashChildHistory(input: {
  readonly admission: ManagedControlRecord;
  readonly controls: readonly ManagedControlRecord[];
  readonly records: readonly SessionRecord[];
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly validateHistory?: ReturnType<typeof createSessionHistoryValidator>;
}): SessionGenesisRecord | undefined {
  const { admission, controls, records } = input;
  const outcome = controls.find(
    (record) =>
      record.parentSessionId === admission.parentSessionId &&
      record.turnId === admission.turnId &&
      record.event.type === "outcome",
  );
  if (
    outcome?.event.type !== "outcome" ||
    !controls.some(
      (record) =>
        record.parentSessionId === admission.parentSessionId &&
        record.turnId === admission.turnId &&
        record.event.type === "settled",
    )
  )
    throw new SessionTrashError(
      "conflict",
      `Child ${admission.childSessionId} has unfinished work or settlement. Open Agents to stop or recover it.`,
    );
  if (
    records.length === 0 &&
    outcome.event.status === "cancelled" &&
    outcome.event.transcript.sequence === 0 &&
    outcome.event.transcript.digest === managedTranscriptLink([]).digest
  )
    return undefined;
  const genesis = records[0];
  if (
    genesis === undefined ||
    !isGenesisRecord(genesis) ||
    admission.event.type !== "admitted" ||
    admission.event.frozen === undefined ||
    genesis.record.projectId !== input.projectId
  )
    throw new SessionTrashError(
      "conflict",
      `Child ${admission.childSessionId} has missing or unprovable historical ownership.`,
    );
  validateManagedChildGenesis(admission, genesis, records);
  if (input.validateHistory === undefined)
    validateCurrentSessionHistory(genesis, records, input.workspaceRoot);
  else input.validateHistory(genesis, records);
  if (
    outcome.event.transcript.sequence !== records.at(-1)?.sequence ||
    outcome.event.transcript.digest !== managedTranscriptLink(records).digest
  )
    throw new SessionTrashError(
      "conflict",
      `Child ${admission.childSessionId} does not match its settled transcript receipt.`,
    );
  return genesis;
}

/** Ownership is proved from all journals, including histories hidden by visibility or Trash. */
export async function inspectSessionTrashUnit(input: {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly mainDirectory: SessionStoreDirectory;
  readonly childDirectory: SessionStoreDirectory;
  readonly controlStore: ManagedControlStore;
  readonly trash: SessionTrashCatalog;
  readonly archived: boolean;
  readonly draftThreadIds: readonly string[];
  readonly validateHistory?: ReturnType<typeof createSessionHistoryValidator>;
}): Promise<{
  readonly unit: SessionTrashUnit;
  readonly specs: readonly SessionTrashFileSpec[];
  readonly blockers: readonly SessionTrashBlocker[];
}> {
  const validateHistory =
    input.validateHistory ?? createSessionHistoryValidator(input.workspaceRoot);
  if (input.trash.diagnostics.length > 0)
    throw new SessionTrashError(
      "unavailable",
      "Trash metadata is unverified; dependency ownership cannot be proved.",
    );
  const records = await readSessionTrashRecords(input.mainDirectory, input.sessionId);
  const genesis = records[0];
  if (
    genesis === undefined ||
    !isGenesisRecord(genesis) ||
    genesis.record.managedParent !== undefined
  )
    throw new SessionTrashError(
      "conflict",
      "Select a current Main session whose ownership can be proved.",
    );
  validateHistory(genesis, records);
  const legacy = await input.controlStore.readLegacy();
  if (
    legacy.some(
      (record) => "parentSessionId" in record && record.parentSessionId === input.sessionId,
    )
  )
    throw new SessionTrashError(
      "conflict",
      "This Main has legacy shared Agent history. Its complete deletion ownership cannot be proved.",
    );
  const controls = await input.controlStore.read();
  const admissions = controls.filter((record) => record.event.type === "admitted");
  const childOwners = new Map<string, string>();
  for (const admission of admissions) {
    if (childOwners.has(admission.childSessionId))
      throw new SessionTrashError(
        "conflict",
        "Conflicting Child ownership prevents a safe Trash preview.",
      );
    childOwners.set(admission.childSessionId, admission.parentSessionId);
  }
  for (const transaction of input.trash.transactions) {
    if (transaction.phase === "restored") continue;
    for (const child of transaction.unit.children) {
      const prior = childOwners.get(child.sessionId);
      if (prior !== undefined && prior !== transaction.unit.mainSessionId)
        throw new SessionTrashError(
          "conflict",
          "Retained Trash and active history disagree on Child ownership.",
        );
      childOwners.set(child.sessionId, transaction.unit.mainSessionId);
    }
  }
  const owned = admissions.filter((record) => record.parentSessionId === input.sessionId);
  const members = new Set([input.sessionId, ...owned.map((record) => record.childSessionId)]);
  if (members.size !== owned.length + 1)
    throw new SessionTrashError("conflict", "The selected Main and Child identities overlap.");
  const specs: SessionTrashFileSpec[] = [
    { kind: "main" },
    { kind: "control" },
    { kind: "capacity" },
    { kind: "main_draft" },
  ];
  const unitSources = new Set(sources(genesis));
  const graph = new Map<string, readonly string[]>();
  const observedChildren = new Map<string, readonly SessionRecord[]>();
  for (const entry of await input.childDirectory.listSessionEntries()) {
    const history = await readSessionTrashRecords(input.childDirectory, entry.sessionId);
    // Unrelated histories contribute compact ownership edges, not retained full transcripts.
    if (members.has(entry.sessionId)) observedChildren.set(entry.sessionId, history);
    const admission = admissions.find((record) => record.childSessionId === entry.sessionId);
    const retained = input.trash.transactions.find(
      (transaction) =>
        transaction.phase !== "restored" &&
        transaction.unit.children.some((child) => child.sessionId === entry.sessionId),
    );
    if (admission === undefined && retained === undefined)
      throw new SessionTrashError(
        "conflict",
        `Child ${entry.sessionId} has no provable Control ownership. Retained history was not moved.`,
      );
    const first = history[0];
    if (first === undefined) {
      if (admission !== undefined)
        validateTrashChildHistory({
          admission,
          controls,
          records: history,
          projectId: genesis.record.projectId,
          workspaceRoot: input.workspaceRoot,
          validateHistory,
        });
      else if (
        !retained?.files.some(
          (file) =>
            file.kind === "child" && file.sessionId === entry.sessionId && file.identity.size === 0,
        )
      )
        throw new SessionTrashError(
          "conflict",
          "An empty Child file has no retained ownership proof.",
        );
      continue;
    }
    if (
      !isGenesisRecord(first) ||
      first.record.sessionId !== entry.sessionId ||
      first.record.projectId !== genesis.record.projectId ||
      first.record.managedParent?.version !== 3
    )
      throw new SessionTrashError(
        "conflict",
        `Child ${entry.sessionId} has invalid or unprovable ownership.`,
      );
    if (admission !== undefined) {
      if (admission.event.type !== "admitted" || admission.event.frozen === undefined)
        throw new SessionTrashError("conflict", "Historical Child ownership is not provable.");
      validateManagedChildGenesis(admission, first, history);
    } else if (
      first.record.managedParent.parentSessionId !== retained?.unit.mainSessionId ||
      !retained.unit.children.some(
        (child) =>
          child.sessionId === entry.sessionId &&
          child.threadId === first.record.managedParent?.threadId,
      )
    )
      throw new SessionTrashError(
        "conflict",
        "Retained Trash ownership conflicts with a Child file.",
      );
    graph.set(entry.sessionId, sources(first));
  }
  for (const admission of owned) {
    const history =
      observedChildren.get(admission.childSessionId) ??
      (await readSessionTrashRecords(input.childDirectory, admission.childSessionId));
    const childGenesis = validateTrashChildHistory({
      admission,
      controls,
      records: history,
      projectId: genesis.record.projectId,
      workspaceRoot: input.workspaceRoot,
      validateHistory,
    });
    if (childGenesis !== undefined)
      for (const source of sources(childGenesis)) if (!members.has(source)) unitSources.add(source);
    if (childGenesis !== undefined || observedChildren.has(admission.childSessionId))
      specs.push({ kind: "child", sessionId: admission.childSessionId });
  }
  const names = new Map<string, string>();
  for (const entry of await input.mainDirectory.listSessionEntries()) {
    let history: readonly SessionRecord[];
    try {
      history = await readSessionTrashRecords(input.mainDirectory, entry.sessionId);
    } catch {
      throw new SessionTrashError(
        "conflict",
        `Session ${entry.sessionId} is unreadable, so its dependencies cannot be proved.`,
      );
    }
    const first = history[0];
    if (first === undefined || first.schemaVersion !== 3) continue;
    if (
      !isGenesisRecord(first) ||
      first.record.sessionId !== entry.sessionId ||
      first.record.managedParent !== undefined ||
      first.record.projectId !== genesis.record.projectId ||
      childOwners.has(entry.sessionId)
    )
      throw new SessionTrashError(
        "conflict",
        `Session ${entry.sessionId} has invalid or overlapping Main ownership.`,
      );
    validateHistory(first, history);
    graph.set(entry.sessionId, sources(first));
    names.set(entry.sessionId, sessionNamingStateFromRecords(history).displayLabel);
  }
  for (const transaction of input.trash.transactions) {
    if (transaction.phase === "restored") continue;
    graph.set(transaction.unit.mainSessionId, transaction.unit.sourceSessionIds);
    names.set(transaction.unit.mainSessionId, transaction.unit.label);
  }
  const visiting = new Set<string>();
  const checked = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new SessionTrashError("conflict", "Cyclic source ownership prevents Trash.");
    if (checked.has(id)) return;
    visiting.add(id);
    for (const source of graph.get(id) ?? []) {
      if (!graph.has(source) && !childOwners.has(source))
        throw new SessionTrashError(
          "conflict",
          `Source ${source} is unavailable; dependency ownership cannot be proved.`,
        );
      visit(source);
    }
    visiting.delete(id);
    checked.add(id);
  };
  for (const id of graph.keys()) visit(id);
  const dependents = [...graph]
    .filter(([id, dependencies]) => !members.has(id) && dependencies.some((id) => members.has(id)))
    .map(([id]) => id);
  const threadIds = [...new Set(owned.map((record) => record.threadId))].sort();
  if (input.draftThreadIds.some((id) => !threadIds.includes(id)))
    throw new SessionTrashError(
      "conflict",
      "An owned Child draft has no matching Control admission. Its ownership must be recovered before Trash.",
    );
  specs.push(...threadIds.map((threadId) => ({ kind: "child_draft" as const, threadId })));
  return {
    unit: {
      mainSessionId: input.sessionId,
      label: sessionNamingStateFromRecords(records).displayLabel,
      children: owned
        .map((record) => ({ sessionId: record.childSessionId, threadId: record.threadId }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      threadIds,
      sourceSessionIds: [...unitSources].sort(),
      archived: input.archived,
    },
    specs,
    blockers: dependents.map((id) => ({
      kind: "dependency",
      message: `Derived session ${names.get(id) ?? id} (${id}) still depends on this unit.`,
      sessionIds: [id],
    })),
  };
}
