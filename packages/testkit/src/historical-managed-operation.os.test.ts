import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExtensionHost,
  createFileArtifactStore,
  createJsonlOperationStore,
  type OperationEventRecord,
} from "@adam-agent/agent";
import type { ExtensionArtifactSummary } from "@adam-agent/extension-api";
import { expect, test } from "vitest";

// Released managed-session executions remain historical data after their runtime is removed.
// Literal records exercise the real JSONL decoder without recreating the obsolete executor.
test.each(["1", "2"] as const)(
  "completed managed-session @%s reports and artifacts survive cold reads without their extension",
  async (version) => {
    const fixture = await createHistoricalOperation(version);
    try {
      const events: OperationEventRecord[] = [...fixture.records];
      if (version === "2")
        events.push({
          schemaVersion: 2,
          operationId,
          sequence: events.length + 1,
          recordedAt: "2026-09-03T09:00:00.000Z",
          event: {
            type: "operation_managed_wait_settled",
            deadlineAt: "2026-09-03T09:00:50.000Z",
            remainingDeadlineMilliseconds: 50_000,
          },
        });
      events.push({
        schemaVersion: 2,
        operationId,
        sequence: events.length + 1,
        recordedAt: "2026-09-03T09:00:01.000Z",
        event: {
          type: "operation_completed",
          artifacts: [fixture.artifact],
          output: {
            report: "historical report",
            review: { capability: `adam.managed-session@${version}`, status: "completed" },
          },
        },
      });
      for (const record of events.slice(fixture.records.length)) await fixture.store.append(record);
      const reopened = await fixture.reopen();
      expect(await reopened.host.operations.query(operationId)).toMatchObject({
        status: "completed",
        artifacts: [fixture.artifact],
        output: {
          report: "historical report",
          review: { capability: `adam.managed-session@${version}`, status: "completed" },
        },
      });
      expect(await reopened.host.operations.recover(operationId)).toEqual(
        await reopened.host.operations.query(operationId),
      );
      expect(new TextDecoder().decode(await reopened.artifacts.read(fixture.artifact.id))).toBe(
        "historical report bytes",
      );
      expect(await reopened.store.read(operationId)).toEqual(events);
    } finally {
      await fixture.close();
    }
  },
);

test.each(["1", "2"] as const)(
  "interrupted managed-session @%s stays inspectable and accepts only outer cancellation intent",
  async (version) => {
    const fixture = await createHistoricalOperation(version);
    try {
      const reopened = await fixture.reopen();
      expect(await reopened.host.operations.query(operationId)).toMatchObject({
        status: "recovery_required",
        recoverable: false,
      });
      await expect(reopened.host.operations.recover(operationId)).rejects.toMatchObject({
        code: "operation_contribution_unavailable",
      });
      expect(await reopened.store.read(operationId)).toEqual(fixture.records);
      expect(new TextDecoder().decode(await reopened.artifacts.read(fixture.artifact.id))).toBe(
        "historical report bytes",
      );
      expect(await reopened.host.operations.cancel(operationId)).toMatchObject({
        status: "recovery_required",
        recoverable: false,
      });
      const cancelledRecords = await reopened.store.read(operationId);
      expect(cancelledRecords.slice(0, -1)).toEqual(fixture.records);
      expect(cancelledRecords.at(-1)?.event).toEqual({
        type: "operation_cancel_requested",
        reason: "caller",
      });
      await reopened.host.operations.cancel(operationId);
      await expect(reopened.host.operations.recover(operationId)).rejects.toMatchObject({
        code: "operation_contribution_unavailable",
      });
      expect(await reopened.store.read(operationId)).toEqual(cancelledRecords);
    } finally {
      await fixture.close();
    }
  },
);

const operationId = "123e4567-e89b-42d3-a456-426614174000";

async function createHistoricalOperation(version: "1" | "2") {
  const root = await mkdtemp(join(tmpdir(), "adam-historical-managed-operation-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  const artifactsRoot = join(root, "artifacts");
  await mkdir(workspaceRoot);
  const store = await createJsonlOperationStore({ stateRoot, workspaceRoot });
  const artifacts = await createFileArtifactStore({ root: artifactsRoot });
  if (store.projectId === undefined)
    throw new Error("Historical fixture needs a project-scoped store.");
  const provenance = {
    contributionId: "fixture.review",
    extensionId: "fixture.historical",
    extensionVersion: version === "1" ? "0.4.0" : "0.5.0",
    operationId,
    projectId: store.projectId,
  };
  const contract = { id: "fixture.review-report", version: 1 };
  const stored = await artifacts.write({
    bytes: new TextEncoder().encode("historical report bytes"),
    mediaType: "text/plain",
    source: { type: "extension_operation", contract, ...provenance },
  });
  const artifact: ExtensionArtifactSummary = {
    id: stored.id,
    byteCount: stored.byteCount,
    mediaType: stored.mediaType,
    contract,
    provenance,
  };
  const records: OperationEventRecord[] = [
    {
      schemaVersion: 3,
      operationId,
      sequence: 1,
      recordedAt: "2026-09-03T08:00:00.000Z",
      origin: {
        invocation: { id: "review", kind: "presentation_command", version: 1 },
        sessionId: "123e4567-e89b-42d3-a456-426614174010",
        sourceSequence: 3,
      },
      event: {
        type: "operation_started",
        contributionId: provenance.contributionId,
        extensionId: provenance.extensionId,
        extensionVersion: provenance.extensionVersion,
        projectId: provenance.projectId,
        deadlineAt: "2026-09-03T08:01:00.000Z",
        definitionDigest: `sha256:${"a".repeat(64)}`,
        idempotencyKey: "historical-managed-report",
        input: { revision: "abc123" },
        inputDigest: "sha256:2a55e3c07660886834b043483337c2143e50ea57313aa7e16b746cca55422ade",
      },
    },
    {
      schemaVersion: 2,
      operationId,
      sequence: 2,
      recordedAt: "2026-09-03T08:00:01.000Z",
      event: { type: "operation_artifact_published", artifact },
    },
  ];
  if (version === "2")
    records.push({
      schemaVersion: 2,
      operationId,
      sequence: 3,
      recordedAt: "2026-09-03T08:00:10.000Z",
      event: { type: "operation_managed_wait_started", remainingDeadlineMilliseconds: 50_000 },
    });
  for (const record of records) await store.append(record);
  return {
    artifact,
    records,
    store,
    async reopen() {
      const reopenedStore = await createJsonlOperationStore({ stateRoot, workspaceRoot });
      const reopenedArtifacts = await createFileArtifactStore({ root: artifactsRoot });
      const host = createExtensionHost({
        capabilities: [],
        extensions: [],
        operationStore: reopenedStore,
        artifactStore: reopenedArtifacts,
        projectRoot: workspaceRoot,
        stateRoot,
      });
      await host.loadConfiguredExtensions();
      return { host, store: reopenedStore, artifacts: reopenedArtifacts };
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
