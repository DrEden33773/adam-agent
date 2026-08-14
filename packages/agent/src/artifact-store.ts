import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ArtifactSource = {
  readonly type: "tool_output";
  readonly callId: string;
  readonly toolName: string;
  readonly stream: "stdout" | "stderr";
  readonly totalBytes: number;
  readonly truncated: boolean;
};

export type ArtifactReference = {
  readonly id: string;
  readonly mediaType: string;
  readonly byteCount: number;
  readonly source: ArtifactSource;
};

export type ArtifactStore = {
  write(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly source: ArtifactSource;
  }): Promise<ArtifactReference>;
  read(id: string): Promise<Uint8Array | undefined>;
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
        await temporaryFile.writeFile(bytes);
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      try {
        try {
          await link(temporaryPath, targetPath);
          await syncDirectory(root);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") {
            throw error;
          }
          const existingBytes = await readFile(targetPath);
          if (!existingBytes.equals(bytes)) {
            throw new Error("The content-addressed artifact does not match its ID.");
          }
        }
      } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      await chmod(targetPath, 0o400);
      return {
        id,
        mediaType: input.mediaType,
        byteCount: bytes.byteLength,
        source: input.source,
      };
    },
    async read(id) {
      const digest = parseArtifactId(id);
      try {
        const bytes = await readFile(join(root, digest));
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
    },
  };
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
