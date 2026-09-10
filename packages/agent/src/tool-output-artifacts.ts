import type { ArtifactReference } from "./artifact-store.js";
import type { JsonValue } from "./tool-runtime.js";

type OutputRecord = Readonly<Record<string, JsonValue>> & {
  readonly artifact?: JsonValue;
  readonly stdout?: JsonValue;
  readonly stderr?: JsonValue;
  readonly id?: JsonValue;
  readonly mediaType?: JsonValue;
  readonly byteCount?: JsonValue;
};

function record(value: JsonValue | undefined): OutputRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OutputRecord)
    : undefined;
}

/** Canonical tool outputs expose direct, stdout or stderr artifact references. */
export function toolOutputArtifactReferences(
  output: JsonValue | undefined,
): readonly Pick<ArtifactReference, "id" | "mediaType" | "byteCount">[] {
  const value = record(output);
  return [
    record(value?.artifact),
    record(record(value?.stdout)?.artifact),
    record(record(value?.stderr)?.artifact),
  ].flatMap((candidate) =>
    typeof candidate?.id === "string" &&
    typeof candidate.mediaType === "string" &&
    typeof candidate.byteCount === "number"
      ? [{ id: candidate.id, mediaType: candidate.mediaType, byteCount: candidate.byteCount }]
      : [],
  );
}
