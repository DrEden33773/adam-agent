import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PatchRecoveryReference = {
  readonly id: string;
};

export type PatchRecoveryStore = {
  create(input: {
    readonly digest: string;
    readonly operations: readonly (
      | { readonly kind: "create" | "delete" | "update"; readonly path: string }
      | { readonly kind: "move"; readonly from: string; readonly to: string }
    )[];
    readonly preimages: readonly {
      readonly path: string;
      readonly bytes: Buffer;
      readonly mode: number;
    }[];
  }): Promise<PatchRecoveryBundle>;
};

export type PatchRecoveryBundle = {
  readonly reference: PatchRecoveryReference;
  remove(): Promise<void>;
};

export class PatchRecoveryStoreError extends Error {
  readonly code = "recovery_cleanup_failed";
  readonly reference: PatchRecoveryReference;

  constructor(reference: PatchRecoveryReference, options: { readonly cause: unknown }) {
    super("Recovery data could not be removed after bundle creation failed.", options);
    this.name = "PatchRecoveryStoreError";
    this.reference = reference;
  }
}

export function createPatchRecoveryStore(options: { readonly root: string }): PatchRecoveryStore {
  const root = resolve(options.root);

  return {
    async create(input) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
      const id = randomUUID();
      const reference = { id };
      const bundlePath = join(root, id);
      await mkdir(bundlePath, { mode: 0o700 });
      await chmod(bundlePath, 0o700);
      try {
        const preimages = [];
        for (const [index, preimage] of input.preimages.entries()) {
          const filename = `preimage-${index}.bin`;
          await writeOwnerOnlyFile(join(bundlePath, filename), preimage.bytes);
          preimages.push({ path: preimage.path, filename, mode: preimage.mode });
        }
        await writeOwnerOnlyFile(
          join(bundlePath, "manifest.json"),
          Buffer.from(
            `${JSON.stringify({
              schemaVersion: 1,
              digest: input.digest,
              operations: input.operations,
              preimages,
            })}\n`,
            "utf8",
          ),
        );
      } catch (error) {
        try {
          await rm(bundlePath, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new PatchRecoveryStoreError(reference, { cause: cleanupError });
        }
        throw error;
      }

      return {
        reference,
        async remove() {
          await chmod(root, 0o700);
          await chmod(bundlePath, 0o700);
          await rm(bundlePath, { recursive: true, force: true });
        },
      };
    },
  };
}

async function writeOwnerOnlyFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}
