import { createHash } from "node:crypto";

import {
  EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES,
  type ExtensionJsonValue,
  type ExtensionProjectChangeSnapshot,
  extensionProjectChangeSnapshotCodec,
} from "@adam-agent/extension-api";

export type ProjectChangeRawBase =
  | {
      readonly commit: string;
      readonly kind: "head";
      readonly tree: string;
    }
  | {
      readonly kind: "unborn";
      readonly tree: string;
    };

export type ProjectChangeCapturedEntry = {
  readonly binary?: boolean;
  readonly content?: Uint8Array;
  readonly mode: string;
  readonly path: Uint8Array;
  readonly side: "base" | "head";
};

export type ProjectChangeRawCapture = {
  readonly base: ProjectChangeRawBase;
  readonly candidateTree: string;
  readonly entries: readonly ProjectChangeCapturedEntry[];
  readonly objectFormat: "sha1" | "sha256";
  readonly unifiedDiff: Uint8Array;
};

export interface ProjectChangeCaptureAdapter {
  capture(input: { readonly canonicalProjectRoot: string }): Promise<ProjectChangeRawCapture>;
}

export interface ProjectChangeMaterializer {
  materialize(input: {
    readonly canonicalProjectRoot: string;
  }): Promise<ExtensionProjectChangeSnapshot>;
}

export class ProjectChangeMaterializerError extends Error {
  readonly code:
    | "capture_inconsistent"
    | "content_invalid_utf8"
    | "limit_exceeded"
    | "mode_invalid"
    | "no_changes"
    | "path_invalid";

  constructor(code: ProjectChangeMaterializerError["code"], options?: { readonly cause: unknown }) {
    super(projectChangeErrorMessage(code), options);
    this.name = "ProjectChangeMaterializerError";
    this.code = code;
  }
}

export function createProjectChangeMaterializer(
  adapter: ProjectChangeCaptureAdapter,
): ProjectChangeMaterializer {
  return {
    async materialize({ canonicalProjectRoot }) {
      const capture = await adapter.capture({ canonicalProjectRoot });
      if (capture.base.tree === capture.candidateTree) {
        throw new ProjectChangeMaterializerError("no_changes");
      }
      if (capture.unifiedDiff.byteLength > EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES) {
        throw new ProjectChangeMaterializerError("limit_exceeded");
      }
      const unifiedDiff = decodeUtf8(capture.unifiedDiff, "content_invalid_utf8");
      if (unifiedDiff.length === 0 || capture.entries.length === 0) {
        throw new ProjectChangeMaterializerError("capture_inconsistent");
      }
      const sources: ExtensionProjectChangeSnapshot["sources"][number][] = [];
      const unavailable: ExtensionProjectChangeSnapshot["unavailable"][number][] = [];
      let sourceBytes = 0;
      for (const entry of capture.entries) {
        const path = decodeUtf8(entry.path, "path_invalid");
        if (entry.mode === "100644" || entry.mode === "100755") {
          if (entry.binary === true) {
            if (entry.content !== undefined) {
              throw new ProjectChangeMaterializerError("capture_inconsistent");
            }
            unavailable.push({
              mode: entry.mode,
              path,
              reason: "binary",
              side: entry.side,
            });
            continue;
          }
          if (entry.content === undefined) {
            throw new ProjectChangeMaterializerError("capture_inconsistent");
          }
          if (entry.content.byteLength > EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES) {
            throw new ProjectChangeMaterializerError("limit_exceeded");
          }
          if (entry.content.includes(0)) {
            unavailable.push({
              mode: entry.mode,
              path,
              reason: "binary",
              side: entry.side,
            });
            continue;
          }
          sourceBytes += entry.content.byteLength;
          if (sourceBytes > EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES) {
            throw new ProjectChangeMaterializerError("limit_exceeded");
          }
          const content = decodeUtf8(entry.content, "content_invalid_utf8");
          sources.push({
            content,
            contentDigest: digestBytes(entry.content),
            mode: entry.mode,
            path,
            side: entry.side,
          });
          continue;
        }
        if (entry.mode === "120000" || entry.mode === "160000") {
          if (entry.content !== undefined) {
            throw new ProjectChangeMaterializerError("capture_inconsistent");
          }
          unavailable.push({
            mode: entry.mode,
            path,
            reason: entry.mode === "120000" ? "symlink" : "gitlink",
            side: entry.side,
          });
          continue;
        }
        throw new ProjectChangeMaterializerError("mode_invalid");
      }
      sources.sort(compareProjectChangeEntries);
      unavailable.sort(compareProjectChangeEntries);
      const core = {
        base: capture.base,
        candidateTree: capture.candidateTree,
        capturePolicy: {
          id: "adam.git-project-changes" as const,
          objectFormat: capture.objectFormat,
          version: 1 as const,
        },
        kind: "adam.project-change-snapshot" as const,
        schemaVersion: 1 as const,
        sources,
        unavailable,
        unifiedDiff,
      };
      const candidate = {
        ...core,
        digest: digestBytes(Buffer.from(JSON.stringify(canonicalize(core)), "utf8")),
      };
      const decoded = extensionProjectChangeSnapshotCodec.decode(candidate);
      if (!decoded.ok) {
        const issueCodes = new Set(decoded.issues.map((issue) => issue.code));
        if (issueCodes.has("max-bytes") || issueCodes.has("max-entries")) {
          throw new ProjectChangeMaterializerError("limit_exceeded");
        }
        if (issueCodes.has("invalid-path") || issueCodes.has("invalid-unicode")) {
          throw new ProjectChangeMaterializerError("path_invalid");
        }
        throw new ProjectChangeMaterializerError("capture_inconsistent");
      }
      return decoded.value;
    },
  };
}

function canonicalize(value: ExtensionJsonValue): ExtensionJsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: ExtensionJsonValue };
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key] as ExtensionJsonValue)]),
    );
  }
  return value;
}

function compareProjectChangeEntries(
  left: { readonly path: string; readonly side: "base" | "head" },
  right: { readonly path: string; readonly side: "base" | "head" },
): number {
  return left.side === right.side
    ? Buffer.from(left.path).compare(Buffer.from(right.path))
    : left.side === "base"
      ? -1
      : 1;
}

function decodeUtf8(value: Uint8Array, code: "content_invalid_utf8" | "path_invalid"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new ProjectChangeMaterializerError(code, { cause: error });
  }
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function projectChangeErrorMessage(code: ProjectChangeMaterializerError["code"]): string {
  switch (code) {
    case "capture_inconsistent":
      return "The captured Git project-change evidence is inconsistent.";
    case "content_invalid_utf8":
      return "The captured project-change content is not strict UTF-8.";
    case "limit_exceeded":
      return "The captured project-change evidence exceeds its limit.";
    case "mode_invalid":
      return "The captured project-change entry has an unsupported Git mode.";
    case "no_changes":
      return "The project has no captured changes.";
    case "path_invalid":
      return "The captured project-change path is invalid.";
  }
}
