import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ModelTargetIdentity } from "./model-targets.js";

export type ToolArtifactSource = {
  readonly type: "tool_output";
  readonly callId: string;
  readonly toolName: string;
  readonly stream: "stdout" | "stderr";
  readonly totalBytes: number;
  readonly truncated: boolean;
};

export type McpToolResultArtifactSourceV1 = {
  readonly type: "mcp_tool_result";
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly toolName: string;
  readonly serverId: string;
  readonly originalName: string;
  readonly definitionDigest: string;
};

export type ExtensionArtifactSource = {
  readonly type: "extension_operation";
  readonly contract: { readonly id: string; readonly version: number };
  readonly contributionId: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly operationId: string;
  readonly projectId: string;
};

export type ModelResponseArtifactSource = {
  readonly type: "model_response";
  readonly schemaVersion: 1;
  readonly field: "text" | "reasoning";
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  readonly attempt: number;
  readonly targetIdentity: ModelTargetIdentity;
  readonly provenance: "provider_model_response";
};

export type ChangePreviewArtifactSource = {
  readonly type: "change_preview";
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolName: "write_file" | "edit_file";
  readonly argumentsDigest: string;
  readonly provenance: "prepared_tool_change";
};

export type SkillArtifactSource = {
  readonly type: "skill";
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly catalogRevision: number;
  readonly qualifiedId: string;
  readonly skillMdDigest: string;
  readonly provenance: "skill_ingestion";
};

export type InputResourceArtifactSourceV1 = {
  readonly type: "input_resource";
  readonly schemaVersion: 1;
  readonly occurrenceId: string;
  readonly runId: string;
  readonly provenance: "user_local_file";
};

export type ArtifactSource =
  | ChangePreviewArtifactSource
  | ExtensionArtifactSource
  | InputResourceArtifactSourceV1
  | McpToolResultArtifactSourceV1
  | ModelResponseArtifactSource
  | SkillArtifactSource
  | ToolArtifactSource;

export type ArtifactReference<TSource extends ArtifactSource = ArtifactSource> = {
  readonly id: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly source: TSource;
};

export type ArtifactStore = {
  write<TSource extends ArtifactSource>(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly source: TSource;
  }): Promise<ArtifactReference<TSource>>;
  read(id: string, options?: { readonly maximumBytes?: number }): Promise<Uint8Array | undefined>;
};

export async function createFileArtifactStore(options: {
  readonly root: string;
}): Promise<ArtifactStore> {
  const root = resolve(options.root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  return {
    async write(input) {
      const bytes = Buffer.from(input.bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const id = `sha256:${digest}`;
      const targetPath = join(root, digest);
      const temporaryPath = join(root, `.${digest}.${randomUUID()}.tmp`);
      const temporaryFile = await open(temporaryPath, "wx", 0o600);
      try {
        try {
          await temporaryFile.writeFile(bytes);
          await temporaryFile.chmod(0o400);
          await temporaryFile.sync();
        } finally {
          await temporaryFile.close();
        }
        try {
          await link(temporaryPath, targetPath);
          await syncDirectory(root);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") {
            throw error;
          }
          const existingBytes = await readFileArtifact({
            root,
            id,
            maximumBytes: bytes.byteLength,
          });
          if (existingBytes === undefined || !Buffer.from(existingBytes).equals(bytes)) {
            throw new Error("The content-addressed artifact does not match its ID.");
          }
          await chmod(targetPath, 0o400);
        }
      } finally {
        await unlinkTemporary(temporaryPath);
      }
      return {
        id,
        mediaType: input.mediaType,
        byteCount: bytes.byteLength,
        source: input.source,
      };
    },
    async read(id, readOptions) {
      return readFileArtifact({
        root,
        id,
        ...(readOptions?.maximumBytes === undefined
          ? {}
          : { maximumBytes: readOptions.maximumBytes }),
      });
    },
  };
}

export async function readFileArtifact(options: {
  readonly root: string;
  readonly id: string;
  readonly maximumBytes?: number;
}): Promise<Uint8Array | undefined> {
  const root = resolve(options.root);
  if (!root.startsWith("/")) {
    throw new TypeError("The artifact root must resolve to an absolute path.");
  }
  const digest = parseArtifactId(options.id);
  try {
    const artifactPath = join(root, digest);
    const bytes =
      options.maximumBytes === undefined
        ? await readFile(artifactPath)
        : await readFileWithinLimit(artifactPath, options.maximumBytes);
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== digest) {
      throw new Error("The content-addressed artifact does not match its ID.");
    }
    return bytes;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readFileArtifactRange(options: {
  readonly root: string;
  readonly id: string;
  readonly expectedByteCount: number;
  readonly offset: number;
  readonly maximumBytes: number;
}): Promise<
  | {
      readonly bytes: Uint8Array;
      readonly totalByteCount: number;
      readonly eof: boolean;
    }
  | undefined
> {
  const root = resolve(options.root);
  if (!root.startsWith("/")) {
    throw new TypeError("The artifact root must resolve to an absolute path.");
  }
  if (
    !Number.isSafeInteger(options.expectedByteCount) ||
    options.expectedByteCount < 0 ||
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes <= 0
  ) {
    throw new RangeError("The artifact range must use bounded nonnegative safe integers.");
  }
  const digest = parseArtifactId(options.id);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(join(root, digest), "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (
      !Number.isSafeInteger(size) ||
      size !== options.expectedByteCount ||
      options.offset > size
    ) {
      throw new Error("The artifact size does not match its reference.");
    }
    const hash = createHash("sha256");
    const retained: Buffer[] = [];
    const retainedEnd = Math.min(size, options.offset + options.maximumBytes);
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await file.read(
        readBuffer,
        0,
        Math.min(readBuffer.length, size - position),
        position,
      );
      if (bytesRead === 0) {
        throw new Error("The artifact ended before its recorded byte count.");
      }
      const bytes = readBuffer.subarray(0, bytesRead);
      hash.update(bytes);
      const overlapStart = Math.max(position, options.offset);
      const overlapEnd = Math.min(position + bytesRead, retainedEnd);
      if (overlapStart < overlapEnd) {
        retained.push(Buffer.from(bytes.subarray(overlapStart - position, overlapEnd - position)));
      }
      position += bytesRead;
    }
    if (hash.digest("hex") !== digest) {
      throw new Error("The content-addressed artifact does not match its ID.");
    }
    const bytes = Buffer.concat(retained);
    return {
      bytes,
      totalByteCount: size,
      eof: options.offset + bytes.byteLength >= size,
    };
  } finally {
    await file.close();
  }
}

async function readFileWithinLimit(path: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("The artifact read limit must be a nonnegative safe integer.");
  }
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size > maximumBytes) {
      throw new Error("The artifact exceeds its bounded read limit.");
    }
    const chunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await file.read(readBuffer, 0, readBuffer.length, totalBytes);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        throw new Error("The artifact exceeds its bounded read limit.");
      }
      chunks.push(Buffer.from(readBuffer.subarray(0, bytesRead)));
    }
  } finally {
    await file.close();
  }
}

async function unlinkTemporary(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseArtifactId(id: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(id);
  if (match?.[1] === undefined) {
    throw new Error("The artifact ID is invalid.");
  }
  return match[1];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
