import type { OperationArtifactDisplay, OperationDisplay } from "@adam-agent/presentation";
import type { OperationSnapshot } from "./operation-host.js";

export type ProjectedOperation = {
  readonly display: OperationDisplay;
  readonly throughSequence: number;
};

export function projectLinkedOperation(snapshot: OperationSnapshot): ProjectedOperation | null {
  if (snapshot.origin === null) {
    return null;
  }
  const base = {
    artifacts: projectOperationArtifacts(snapshot),
    operationId: snapshot.operationId,
    origin: snapshot.origin,
    provenance: {
      contributionId: snapshot.contributionId,
      extensionId: snapshot.extensionId,
      extensionVersion: snapshot.extensionVersion,
      presentation: snapshot.presentation.kind,
      title: snapshot.presentation.title,
    },
    progress: projectOperationProgress(snapshot.progress),
  };
  const display: OperationDisplay =
    snapshot.status === "running"
      ? { ...base, status: "running", actions: ["cancel"], settlement: null }
      : snapshot.status === "cancel_requested"
        ? { ...base, status: "cancel_requested", actions: [], settlement: null }
        : snapshot.status === "completed"
          ? {
              ...base,
              status: "completed",
              actions: [],
              settlement: { summary: null },
            }
          : snapshot.status === "failed"
            ? {
                ...base,
                status: "failed",
                actions: [],
                settlement: snapshot.error,
              }
            : snapshot.status === "cancelled"
              ? {
                  ...base,
                  status: "cancelled",
                  actions: [],
                  settlement: { reason: snapshot.reason },
                }
              : snapshot.status === "inspection_required"
                ? {
                    ...base,
                    status: "inspection_required",
                    actions: [],
                    settlement: { message: snapshot.message },
                  }
                : projectRecoveryRequiredOperation(base, snapshot);
  return {
    display,
    throughSequence: snapshot.throughSequence,
  };
}

function projectOperationProgress(
  progress: OperationSnapshot["progress"],
): OperationDisplay["progress"] {
  if (progress === undefined || progress === null) {
    return null;
  }
  const serialized = typeof progress === "string" ? progress : JSON.stringify(progress);
  const maximumBytes = 240;
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.byteLength <= maximumBytes) {
    return { summary: serialized };
  }
  const prefix = encoded.subarray(0, maximumBytes - 3);
  for (let trim = 0; trim <= 3; trim += 1) {
    try {
      return {
        summary: `${new TextDecoder("utf-8", { fatal: true }).decode(
          prefix.subarray(0, prefix.byteLength - trim),
        )}…`,
      };
    } catch {
      // The byte bound may split one UTF-8 scalar; retry without its partial bytes.
    }
  }
  throw new TypeError("The operation progress summary could not be bounded.");
}

function projectOperationArtifacts(
  snapshot: OperationSnapshot,
): readonly OperationArtifactDisplay[] {
  const terminal = "artifacts" in snapshot ? (snapshot.artifacts ?? []) : [];
  const evidence =
    snapshot.status === "inspection_required"
      ? (snapshot.evidence ?? []).flatMap((reference) =>
          reference.type === "artifact" ? [reference.artifact] : [],
        )
      : [];
  const evidenceIds = new Set(evidence.map((artifact) => artifact.id));
  const unique = new Map([...terminal, ...evidence].map((artifact) => [artifact.id, artifact]));
  return [...unique.values()].map((artifact) => ({
    contract: artifact.contract,
    reference: {
      id: artifact.id,
      mediaType: artifact.mediaType,
      byteCount: artifact.byteCount,
      source: "operation",
    },
    role:
      artifact.contract.id === snapshot.presentation.report?.id &&
      artifact.contract.version === snapshot.presentation.report.version
        ? "report"
        : evidenceIds.has(artifact.id)
          ? "evidence"
          : "artifact",
  }));
}

function projectRecoveryRequiredOperation(
  base: Omit<
    Extract<OperationDisplay, { readonly status: "running" }>,
    "actions" | "settlement" | "status"
  >,
  snapshot: OperationSnapshot,
): OperationDisplay {
  if (snapshot.status !== "recovery_required") {
    throw new TypeError("The operation status could not be projected.");
  }
  return {
    ...base,
    status: "recovery_required",
    actions: snapshot.recoverable ? ["recover"] : [],
    settlement: snapshot.error,
  };
}
