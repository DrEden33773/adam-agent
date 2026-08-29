import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";
import {
  type ArtifactReference,
  type ArtifactStore,
  type InputResourceArtifactSourceV1,
  publishFileArtifactStage,
  type StagedArtifactReference,
} from "./artifact-store.js";
import { sniffExplicitUserImageMediaTypeV1 } from "./image-input.js";

export const inputResourceLimitsV1 = {
  maximumOccurrencesPerRun: 8,
  maximumOccurrencesPerLineage: 64,
  maximumSelectedPathBytes: 4_096,
  maximumDisplayNameBytes: 255,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumAggregateBytesPerRun: 16 * 1024 * 1024,
  maximumAggregateBytesPerLineage: 64 * 1024 * 1024,
  defaultReadPageBytes: 16 * 1024,
  maximumReadPageBytes: 64 * 1024,
  maximumMaterializedBytesPerRun: 1024 * 1024,
  maximumMaterializedBytesPerLineage: 8 * 1024 * 1024,
} as const;

export type LocalInputResourceSelectionV1 = {
  readonly type: "local_file";
  readonly path: string;
};

export type StagedInputResourceSelectionV1 = {
  readonly type: "staged_artifact";
  readonly staged: StagedArtifactReference;
  readonly displayName: string;
  readonly digest: `sha256:${string}`;
  readonly mediaHint: "binary" | "image" | "text";
  readonly support: "image" | "unsupported_binary" | "utf8_text";
};

export type InputResourceSelectionV1 =
  | LocalInputResourceSelectionV1
  | StagedInputResourceSelectionV1;

export type InputResourceOccurrenceV1 = {
  readonly occurrenceId: string;
  readonly displayName: string;
  readonly artifact: {
    readonly id: `sha256:${string}`;
    readonly mediaType:
      | "application/octet-stream"
      | "image/jpeg"
      | "image/png"
      | "text/plain; charset=utf-8";
    readonly byteCount: number;
  };
  readonly digest: `sha256:${string}`;
  readonly mediaHint: "binary" | "image" | "text";
  readonly provenance: "user_local_file";
  readonly support: "image" | "unsupported_binary" | "utf8_text";
  readonly mode: "link";
};

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u) as z.ZodType<`sha256:${string}`>;

export const inputResourceOccurrenceV1Schema: z.ZodType<InputResourceOccurrenceV1> = z.strictObject(
  {
    occurrenceId: z.string().min(1).max(256),
    displayName: z
      .string()
      .min(1)
      .max(inputResourceLimitsV1.maximumDisplayNameBytes)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= inputResourceLimitsV1.maximumDisplayNameBytes,
      ),
    artifact: z.strictObject({
      id: digestSchema,
      mediaType: z.enum([
        "application/octet-stream",
        "image/jpeg",
        "image/png",
        "text/plain; charset=utf-8",
      ]),
      byteCount: z.number().int().nonnegative().max(inputResourceLimitsV1.maximumFileBytes),
    }),
    digest: digestSchema,
    mediaHint: z.enum(["binary", "image", "text"]),
    provenance: z.literal("user_local_file"),
    support: z.enum(["image", "unsupported_binary", "utf8_text"]),
    mode: z.literal("link"),
  },
);

export class InputResourceError extends Error {
  readonly code:
    | "input_resource_aggregate_too_large"
    | "input_resource_count_exceeded"
    | "input_resource_corrupt"
    | "input_resource_cursor_invalid"
    | "input_resource_invalid_selection"
    | "input_resource_io_failed"
    | "input_resource_not_visible"
    | "input_resource_too_large"
    | "input_resource_unsupported";

  constructor(code: InputResourceError["code"], message: string) {
    super(message);
    this.name = "InputResourceError";
    this.code = code;
  }
}

export async function ingestLocalInputResourcesV1(input: {
  readonly artifactRoot?: string;
  readonly artifactStore: ArtifactStore;
  readonly afterResolved?: () => Promise<void> | void;
  readonly afterOpened?: () => Promise<void> | void;
  readonly runId: string;
  readonly selections: readonly InputResourceSelectionV1[];
  readonly signal: AbortSignal;
}): Promise<readonly InputResourceOccurrenceV1[]> {
  if (input.selections.length > inputResourceLimitsV1.maximumOccurrencesPerRun) {
    throw new InputResourceError(
      "input_resource_count_exceeded",
      "The selected input-resource count exceeds the v1 run limit.",
    );
  }
  const occurrences: InputResourceOccurrenceV1[] = [];
  let aggregateBytes = 0;
  for (const [index, selection] of input.selections.entries()) {
    input.signal.throwIfAborted();
    const occurrenceId = `${input.runId}:input:${index + 1}`;
    const ingested =
      selection.type === "staged_artifact"
        ? await promoteStagedInputResource({
            ...(input.afterOpened === undefined ? {} : { afterOpened: input.afterOpened }),
            artifactRoot: input.artifactRoot,
            artifactStore: input.artifactStore,
            occurrenceId,
            runId: input.runId,
            selection,
            signal: input.signal,
          })
        : await ingestSelectedLocalFile({
            artifactStore: input.artifactStore,
            ...(input.afterResolved === undefined ? {} : { afterResolved: input.afterResolved }),
            ...(input.afterOpened === undefined ? {} : { afterOpened: input.afterOpened }),
            occurrenceId,
            selection,
            runId: input.runId,
            signal: input.signal,
          });
    aggregateBytes += ingested.artifact.byteCount;
    if (aggregateBytes > inputResourceLimitsV1.maximumAggregateBytesPerRun) {
      throw new InputResourceError(
        "input_resource_aggregate_too_large",
        "The selected input resources exceed the v1 aggregate run limit.",
      );
    }
    occurrences.push(ingested);
  }
  return occurrences;
}

async function ingestSelectedLocalFile(input: {
  readonly artifactStore: ArtifactStore;
  readonly afterResolved?: () => Promise<void> | void;
  readonly afterOpened?: () => Promise<void> | void;
  readonly occurrenceId: string;
  readonly selection: LocalInputResourceSelectionV1;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<InputResourceOccurrenceV1> {
  if (
    input.selection.path.length === 0 ||
    input.selection.path.includes("\0") ||
    Buffer.byteLength(input.selection.path, "utf8") > inputResourceLimitsV1.maximumSelectedPathBytes
  ) {
    throw new InputResourceError(
      "input_resource_invalid_selection",
      "The selected local input-resource path is invalid.",
    );
  }
  return ingestOneLocalFile({
    artifactStore: input.artifactStore,
    ...(input.afterResolved === undefined ? {} : { afterResolved: input.afterResolved }),
    ...(input.afterOpened === undefined ? {} : { afterOpened: input.afterOpened }),
    occurrenceId: input.occurrenceId,
    path: input.selection.path,
    runId: input.runId,
    signal: input.signal,
  });
}

async function promoteStagedInputResource(input: {
  readonly artifactRoot: string | undefined;
  readonly artifactStore: ArtifactStore;
  readonly afterOpened?: () => Promise<void> | void;
  readonly occurrenceId: string;
  readonly runId: string;
  readonly selection: StagedInputResourceSelectionV1;
  readonly signal: AbortSignal;
}): Promise<InputResourceOccurrenceV1> {
  const { selection } = input;
  const validMedia =
    (selection.support === "utf8_text" &&
      selection.mediaHint === "text" &&
      selection.staged.mediaType === "text/plain; charset=utf-8") ||
    (selection.support === "unsupported_binary" &&
      selection.mediaHint === "binary" &&
      selection.staged.mediaType === "application/octet-stream") ||
    (selection.support === "image" &&
      selection.mediaHint === "image" &&
      (selection.staged.mediaType === "image/jpeg" || selection.staged.mediaType === "image/png"));
  if (
    input.artifactRoot === undefined ||
    selection.displayName.length === 0 ||
    Buffer.byteLength(selection.displayName, "utf8") >
      inputResourceLimitsV1.maximumDisplayNameBytes ||
    selection.staged.id !== selection.digest ||
    selection.staged.byteCount > inputResourceLimitsV1.maximumFileBytes ||
    !validMedia
  ) {
    throw new InputResourceError(
      "input_resource_invalid_selection",
      "The provisional input-resource selection is invalid.",
    );
  }
  input.signal.throwIfAborted();
  await input.afterOpened?.();
  input.signal.throwIfAborted();
  const source: InputResourceArtifactSourceV1 = {
    type: "input_resource",
    schemaVersion: 1,
    occurrenceId: input.occurrenceId,
    runId: input.runId,
    provenance: "user_local_file",
  };
  try {
    await publishFileArtifactStage({
      artifactStore: input.artifactStore,
      root: input.artifactRoot,
      source,
      staged: selection.staged,
    });
  } catch {
    throw new InputResourceError(
      "input_resource_io_failed",
      "The provisional input resource could not be promoted safely.",
    );
  }
  input.signal.throwIfAborted();
  return {
    occurrenceId: input.occurrenceId,
    displayName: selection.displayName,
    artifact: {
      id: selection.digest,
      mediaType: selection.staged.mediaType as InputResourceOccurrenceV1["artifact"]["mediaType"],
      byteCount: selection.staged.byteCount,
    },
    digest: selection.digest,
    mediaHint: selection.mediaHint,
    provenance: "user_local_file",
    support: selection.support,
    mode: "link",
  };
}

async function ingestOneLocalFile(input: {
  readonly artifactStore: ArtifactStore;
  readonly afterResolved?: () => Promise<void> | void;
  readonly afterOpened?: () => Promise<void> | void;
  readonly occurrenceId: string;
  readonly path: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<InputResourceOccurrenceV1> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(input.path);
  } catch {
    throw new InputResourceError(
      "input_resource_invalid_selection",
      "The selected local input resource cannot be resolved.",
    );
  }
  if (Buffer.byteLength(resolvedPath, "utf8") > inputResourceLimitsV1.maximumSelectedPathBytes) {
    throw new InputResourceError(
      "input_resource_invalid_selection",
      "The resolved local input-resource path is too long.",
    );
  }
  await input.afterResolved?.();
  input.signal.throwIfAborted();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new InputResourceError(
      "input_resource_invalid_selection",
      "The selected local input resource cannot be opened safely.",
    );
  }
  try {
    const identity = await file.stat();
    if (!identity.isFile()) {
      throw new InputResourceError(
        "input_resource_invalid_selection",
        "The selected input resource is not an ordinary file.",
      );
    }
    if (!Number.isSafeInteger(identity.size) || identity.size < 0) {
      throw new InputResourceError(
        "input_resource_invalid_selection",
        "The selected input-resource size is invalid.",
      );
    }
    if (identity.size > inputResourceLimitsV1.maximumFileBytes) {
      throw new InputResourceError(
        "input_resource_too_large",
        "The selected input resource exceeds the v1 per-file byte limit.",
      );
    }
    await input.afterOpened?.();
    input.signal.throwIfAborted();
    const chunks: Buffer[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let strictUtf8 = true;
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < identity.size) {
      input.signal.throwIfAborted();
      const { bytesRead } = await file.read(
        readBuffer,
        0,
        Math.min(readBuffer.length, identity.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw new InputResourceError(
          "input_resource_io_failed",
          "The selected input resource ended before its validated size.",
        );
      }
      const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
      chunks.push(chunk);
      if (strictUtf8) {
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          strictUtf8 = false;
        }
      }
      position += bytesRead;
    }
    if (strictUtf8) {
      try {
        decoder.decode();
      } catch {
        strictUtf8 = false;
      }
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    if ((await file.read(overflowProbe, 0, 1, identity.size)).bytesRead !== 0) {
      throw new InputResourceError(
        "input_resource_io_failed",
        "The selected input resource changed beyond its validated size during ingest.",
      );
    }
    const bytes = Buffer.concat(chunks, identity.size);
    input.signal.throwIfAborted();
    const source: InputResourceArtifactSourceV1 = {
      type: "input_resource",
      schemaVersion: 1,
      occurrenceId: input.occurrenceId,
      runId: input.runId,
      provenance: "user_local_file",
    };
    const imageMediaType = strictUtf8 ? undefined : sniffExplicitUserImageMediaTypeV1(bytes);
    const mediaType = strictUtf8
      ? ("text/plain; charset=utf-8" as const)
      : (imageMediaType ?? ("application/octet-stream" as const));
    let artifact: ArtifactReference<InputResourceArtifactSourceV1>;
    try {
      artifact = await input.artifactStore.write({ bytes, mediaType, source });
    } catch {
      throw new InputResourceError(
        "input_resource_io_failed",
        "The selected input resource could not be published as an immutable artifact.",
      );
    }
    input.signal.throwIfAborted();
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    if (artifact.id !== digest || artifact.byteCount !== identity.size) {
      throw new InputResourceError(
        "input_resource_corrupt",
        "The published input-resource artifact does not match the accepted bytes.",
      );
    }
    return {
      occurrenceId: input.occurrenceId,
      displayName: safeInputResourceDisplayNameV1(input.path),
      artifact: { id: digest, mediaType, byteCount: identity.size },
      digest,
      mediaHint: strictUtf8 ? "text" : imageMediaType === undefined ? "binary" : "image",
      provenance: "user_local_file",
      support: strictUtf8
        ? "utf8_text"
        : imageMediaType === undefined
          ? "unsupported_binary"
          : "image",
      mode: "link",
    };
  } finally {
    await file.close();
  }
}

export function safeInputResourceDisplayNameV1(path: string): string {
  let retained = "";
  for (const character of basename(path)) {
    const codePoint = character.codePointAt(0) ?? 0;
    const displayCharacter =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? "�" : character;
    if (
      Buffer.byteLength(retained + displayCharacter, "utf8") >
      inputResourceLimitsV1.maximumDisplayNameBytes
    ) {
      break;
    }
    retained += displayCharacter;
  }
  return retained.length === 0 ? "input-resource" : retained;
}

export function projectInputResourcesV1(
  text: string,
  occurrences: readonly InputResourceOccurrenceV1[] | undefined,
): string {
  if (occurrences === undefined || occurrences.length === 0) {
    return text;
  }
  return `${text}\n\nLinked input resources (descriptor-only; use read_input_resource to read supported immutable content):\n${JSON.stringify(occurrences)}`;
}

export const inputResourceProjectionOccurrencesV1 = Symbol(
  "adam-agent.input-resource-projection-occurrences-v1",
);

export function createInputResourceUserMessageV1(
  text: string,
  occurrences: readonly InputResourceOccurrenceV1[] | undefined,
) {
  return {
    role: "user" as const,
    content: projectInputResourcesV1(text, occurrences),
    ...(occurrences === undefined || occurrences.length === 0
      ? {}
      : { [inputResourceProjectionOccurrencesV1]: occurrences }),
  };
}

export function authorizedInputResourceOccurrencesV1(
  message: object,
): readonly InputResourceOccurrenceV1[] | undefined {
  return (
    message as {
      readonly [inputResourceProjectionOccurrencesV1]?: readonly InputResourceOccurrenceV1[];
    }
  )[inputResourceProjectionOccurrencesV1];
}

export function parseInputResourceProjectionV1(content: string):
  | {
      readonly text: string;
      readonly occurrences: readonly InputResourceOccurrenceV1[];
    }
  | undefined {
  const separator =
    "\n\nLinked input resources (descriptor-only; use read_input_resource to read supported immutable content):\n";
  const separatorIndex = content.lastIndexOf(separator);
  if (separatorIndex < 0) {
    return undefined;
  }
  const text = content.slice(0, separatorIndex);
  let decoded: unknown;
  try {
    decoded = JSON.parse(content.slice(separatorIndex + separator.length));
  } catch {
    return undefined;
  }
  const occurrences = inputResourceOccurrenceV1Schema
    .array()
    .min(1)
    .max(inputResourceLimitsV1.maximumOccurrencesPerRun)
    .safeParse(decoded);
  if (!occurrences.success || projectInputResourcesV1(text, occurrences.data) !== content) {
    return undefined;
  }
  return { text, occurrences: occurrences.data };
}

export function createInputResourceProjectionMessageV1(
  occurrences: readonly InputResourceOccurrenceV1[],
) {
  return {
    role: "developer" as const,
    content: `<linked-input-resources schema-version="1">\n${JSON.stringify(occurrences)}\n</linked-input-resources>`,
  };
}

export type InputResourcePageV1 = {
  readonly occurrenceId: string;
  readonly displayName: string;
  readonly offset: number;
  readonly byteCount: number;
  readonly totalByteCount: number;
  readonly eof: boolean;
  readonly nextCursor: string | null;
  readonly digest: `sha256:${string}`;
  readonly pageDigest: `sha256:${string}`;
  readonly content: string;
};

export const inputResourcePageV1Schema: z.ZodType<InputResourcePageV1> = z.strictObject({
  occurrenceId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(inputResourceLimitsV1.maximumDisplayNameBytes),
  offset: z.number().int().nonnegative().max(inputResourceLimitsV1.maximumFileBytes),
  byteCount: z.number().int().nonnegative().max(inputResourceLimitsV1.maximumReadPageBytes),
  totalByteCount: z.number().int().nonnegative().max(inputResourceLimitsV1.maximumFileBytes),
  eof: z.boolean(),
  nextCursor: z.string().min(1).max(1_024).nullable(),
  digest: digestSchema,
  pageDigest: digestSchema,
  content: z.string().max(inputResourceLimitsV1.maximumReadPageBytes),
});

export async function readInputResourcePageV1(input: {
  readonly artifactStore: ArtifactStore;
  readonly cursor?: string;
  readonly maxByteCount?: number;
  readonly occurrence: InputResourceOccurrenceV1 | undefined;
  readonly occurrenceId: string;
}): Promise<InputResourcePageV1> {
  const occurrence = input.occurrence;
  if (occurrence === undefined || occurrence.occurrenceId !== input.occurrenceId) {
    throw new InputResourceError(
      "input_resource_not_visible",
      "The requested input-resource occurrence is not visible in this session history.",
    );
  }
  if (occurrence.support !== "utf8_text") {
    throw new InputResourceError(
      "input_resource_unsupported",
      "The requested input resource is not supported as strict UTF-8 text.",
    );
  }
  const maximumBytes = input.maxByteCount ?? inputResourceLimitsV1.defaultReadPageBytes;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > inputResourceLimitsV1.maximumReadPageBytes
  ) {
    throw new InputResourceError(
      "input_resource_cursor_invalid",
      "The input-resource page size is invalid.",
    );
  }
  const offset = decodeInputResourceCursorV1(input.cursor, occurrence.occurrenceId);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await input.artifactStore.read(occurrence.artifact.id, {
      maximumBytes: inputResourceLimitsV1.maximumFileBytes,
    });
  } catch {
    throw new InputResourceError(
      "input_resource_corrupt",
      "The immutable input-resource artifact failed integrity validation.",
    );
  }
  if (bytes === undefined) {
    throw new InputResourceError(
      "input_resource_corrupt",
      "The immutable input-resource artifact is unavailable.",
    );
  }
  const complete = Buffer.from(bytes);
  if (
    complete.byteLength !== occurrence.artifact.byteCount ||
    `sha256:${createHash("sha256").update(complete).digest("hex")}` !== occurrence.digest
  ) {
    throw new InputResourceError(
      "input_resource_corrupt",
      "The immutable input-resource artifact does not match its descriptor.",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(complete);
  } catch {
    throw new InputResourceError(
      "input_resource_unsupported",
      "The immutable input resource is not complete strict UTF-8 text.",
    );
  }
  if (offset > complete.byteLength) {
    throw new InputResourceError(
      "input_resource_cursor_invalid",
      "The input-resource cursor is outside the immutable content.",
    );
  }
  let end = Math.min(complete.byteLength, offset + maximumBytes);
  let content: string | undefined;
  while (end >= offset) {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(complete.subarray(offset, end));
      break;
    } catch {
      end -= 1;
    }
  }
  if (content === undefined || (end === offset && offset < complete.byteLength)) {
    throw new InputResourceError(
      "input_resource_cursor_invalid",
      "The input-resource page cannot begin or end at the requested UTF-8 boundary.",
    );
  }
  const page = complete.subarray(offset, end);
  return {
    occurrenceId: occurrence.occurrenceId,
    displayName: occurrence.displayName,
    offset,
    byteCount: page.byteLength,
    totalByteCount: complete.byteLength,
    eof: end === complete.byteLength,
    nextCursor:
      end === complete.byteLength
        ? null
        : encodeInputResourceCursorV1(occurrence.occurrenceId, end),
    digest: occurrence.digest,
    pageDigest: `sha256:${createHash("sha256").update(page).digest("hex")}`,
    content,
  };
}

export function encodeInputResourceCursorV1(occurrenceId: string, offset: number): string {
  return `input-resource:v1:${Buffer.from(JSON.stringify([occurrenceId, offset]), "utf8").toString("base64url")}`;
}

export function decodeInputResourceCursorV1(
  cursor: string | undefined,
  occurrenceId: string,
): number {
  if (cursor === undefined) {
    return 0;
  }
  const prefix = "input-resource:v1:";
  try {
    if (!cursor.startsWith(prefix) || cursor.length > 1_024) {
      throw new Error("invalid cursor");
    }
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded[0] !== occurrenceId ||
      !Number.isSafeInteger(decoded[1]) ||
      (decoded[1] as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return decoded[1] as number;
  } catch {
    throw new InputResourceError(
      "input_resource_cursor_invalid",
      "The input-resource continuation cursor is invalid for this occurrence.",
    );
  }
}
