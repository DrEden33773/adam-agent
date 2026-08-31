import { createHash } from "node:crypto";
import { z } from "zod";

import type {
  ArtifactReference,
  ArtifactStore,
  PastedTextArtifactSourceV1,
  StagedArtifactReference,
} from "./artifact-store.js";
import { publishFileArtifactStage } from "./artifact-store.js";

export const pastedTextLimitsV1 = {
  largeLineThreshold: 10,
  largeScalarThreshold: 1_000,
  maximumAtomsPerTurn: 8,
  maximumTextBytesPerTurn: 1_024 * 1_024,
} as const;

export const pastedTextOrphanRetentionMillisecondsV1 = 7 * 24 * 60 * 60 * 1_000;

export function isPastedTextOrphanCleanupEligibleV1(input: {
  readonly referenced: boolean;
  readonly modifiedAtMilliseconds: number;
  readonly nowMilliseconds: number;
}): boolean {
  return (
    !input.referenced &&
    Number.isFinite(input.modifiedAtMilliseconds) &&
    Number.isFinite(input.nowMilliseconds) &&
    input.nowMilliseconds - input.modifiedAtMilliseconds >= pastedTextOrphanRetentionMillisecondsV1
  );
}

export type StagedPastedTextSelectionV1 = {
  readonly type: "staged_pasted_text";
  readonly staged: StagedArtifactReference;
  readonly digest: `sha256:${string}`;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly scalarCount: number;
};

export type PastedTextOccurrenceV1 = {
  readonly occurrenceId: string;
  readonly artifact: ArtifactReference<PastedTextArtifactSourceV1>;
  readonly digest: `sha256:${string}`;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly scalarCount: number;
};

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u) as z.ZodType<`sha256:${string}`>;

export const pastedTextOccurrenceV1Schema: z.ZodType<PastedTextOccurrenceV1> = z.strictObject({
  occurrenceId: z.string().min(1).max(256),
  artifact: z.strictObject({
    id: digestSchema,
    mediaType: z.literal("text/plain; charset=utf-8"),
    byteCount: z.number().int().positive().max(pastedTextLimitsV1.maximumTextBytesPerTurn),
    source: z.strictObject({
      type: z.literal("pasted_text"),
      schemaVersion: z.literal(1),
      projectId: digestSchema,
      sessionId: z.uuid(),
      runId: z.uuid(),
      occurrenceId: z.string().min(1).max(256),
      provenance: z.literal("user_paste"),
    }),
  }),
  digest: digestSchema,
  byteCount: z.number().int().positive().max(pastedTextLimitsV1.maximumTextBytesPerTurn),
  lineCount: z.number().int().positive().safe(),
  scalarCount: z.number().int().positive().safe(),
});

export function pastedTextMetricsV1(text: string): {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly scalarCount: number;
} {
  return {
    byteCount: Buffer.byteLength(text, "utf8"),
    lineCount: text.split("\n").length,
    scalarCount: Array.from(text).length,
  };
}

export function normalizePastedTextV1(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\t/gu, "    ");
}

export function isLargePastedTextV1(text: string): boolean {
  const metrics = pastedTextMetricsV1(text);
  return (
    metrics.lineCount > pastedTextLimitsV1.largeLineThreshold ||
    metrics.scalarCount > pastedTextLimitsV1.largeScalarThreshold
  );
}

export async function promotePastedTextSelectionsV1(input: {
  readonly artifactRoot: string;
  readonly artifactStore: ArtifactStore;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly selections: readonly StagedPastedTextSelectionV1[];
  readonly signal: AbortSignal;
}): Promise<{
  readonly occurrences: readonly PastedTextOccurrenceV1[];
  readonly contents: ReadonlyMap<string, string>;
}> {
  if (input.selections.length > pastedTextLimitsV1.maximumAtomsPerTurn) {
    throw new TypeError("The pasted-text atom count exceeds the v1 turn limit.");
  }
  const occurrences: PastedTextOccurrenceV1[] = [];
  const contents = new Map<string, string>();
  let aggregateBytes = 0;
  for (const [index, selection] of input.selections.entries()) {
    input.signal.throwIfAborted();
    if (
      selection.type !== "staged_pasted_text" ||
      selection.staged.mediaType !== "text/plain; charset=utf-8" ||
      selection.staged.id !== selection.digest ||
      selection.staged.byteCount !== selection.byteCount ||
      selection.byteCount <= 0
    ) {
      throw new TypeError("The provisional pasted-text selection is invalid.");
    }
    aggregateBytes += selection.byteCount;
    if (aggregateBytes > pastedTextLimitsV1.maximumTextBytesPerTurn) {
      throw new TypeError("The pasted-text payload exceeds the v1 turn limit.");
    }
    const occurrenceId = `${input.runId}:pasted-text:${index + 1}`;
    const source: PastedTextArtifactSourceV1 = {
      type: "pasted_text",
      schemaVersion: 1,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      occurrenceId,
      provenance: "user_paste",
    };
    const artifact = await publishFileArtifactStage({
      artifactStore: input.artifactStore,
      root: input.artifactRoot,
      source,
      staged: selection.staged,
    });
    const bytes = await input.artifactStore.read(artifact.id, {
      maximumBytes: pastedTextLimitsV1.maximumTextBytesPerTurn,
    });
    if (
      bytes === undefined ||
      bytes.byteLength !== selection.byteCount ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== selection.digest
    ) {
      throw new TypeError("The immutable pasted-text artifact is unavailable or corrupt.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const metrics = pastedTextMetricsV1(text);
    if (
      metrics.byteCount !== selection.byteCount ||
      metrics.lineCount !== selection.lineCount ||
      metrics.scalarCount !== selection.scalarCount ||
      !isLargePastedTextV1(text)
    ) {
      throw new TypeError("The immutable pasted-text artifact does not match its descriptor.");
    }
    occurrences.push({
      occurrenceId,
      artifact,
      digest: selection.digest,
      ...metrics,
    });
    contents.set(occurrenceId, text);
  }
  return { occurrences, contents };
}
