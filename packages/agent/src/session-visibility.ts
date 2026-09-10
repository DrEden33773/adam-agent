import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createOwnerConfigurationFileStorage,
  hasDuplicateJsonObjectKey,
} from "./secure-user-configuration.js";

export type SessionVisibility = "active" | "archived";
export type SessionVisibilitySnapshot =
  | { readonly status: "ready"; readonly revision: number; readonly archived: readonly string[] }
  | { readonly status: "unknown"; readonly message: string };

export type SessionVisibilityResult =
  | {
      readonly status: "updated";
      readonly snapshot: Extract<SessionVisibilitySnapshot, { status: "ready" }>;
    }
  | { readonly status: "stale" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "blocked"; readonly message: string };

export function sessionMatchesVisibilityView(
  sessionId: string,
  visibility: SessionVisibilitySnapshot | undefined,
  view: SessionVisibility | "trash" = "active",
): boolean {
  if (view === "trash") return false;
  return (
    visibility?.status !== "ready" ||
    visibility.archived.includes(sessionId) === (view === "archived")
  );
}

const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    archived: z.array(z.uuid()),
  })
  .strict();

/** Visibility is independent of the append-only session log and its source lineage. */
export function createSessionVisibilityRepository(input: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly storage?: ReturnType<typeof createOwnerConfigurationFileStorage>;
}) {
  let storagePromise: Promise<ReturnType<typeof createOwnerConfigurationFileStorage>> | undefined;
  const storage = () =>
    (storagePromise ??=
      input.storage === undefined
        ? realpath(input.workspaceRoot).then((root) => {
            const project = createHash("sha256").update(root).digest("hex");
            const directoryPath = join(input.stateRoot, "projects", project, "session-visibility");
            return createOwnerConfigurationFileStorage({
              directoryPath,
              configurationPath: join(directoryPath, "index.json"),
              maximumBytes: 8 * 1024 * 1024,
              mutationLockName: ".mutation.lock",
              temporaryPrefix: ".visibility",
            });
          })
        : Promise.resolve(input.storage));
  const load = async (): Promise<SessionVisibilitySnapshot> => {
    try {
      const record = await (await storage()).read();
      if (record.status === "missing") return { status: "ready", revision: 0, archived: [] };
      if (record.status === "available" && !hasDuplicateJsonObjectKey(record.text)) {
        const parsed = metadataSchema.safeParse(JSON.parse(record.text));
        if (parsed.success && new Set(parsed.data.archived).size === parsed.data.archived.length)
          return {
            status: "ready",
            revision: parsed.data.revision,
            archived: parsed.data.archived,
          };
      }
    } catch {
      /* A broken index never becomes an empty, writable catalog. */
    }
    return {
      status: "unknown",
      message:
        "Archive state is unknown. History is read-only for archive actions; inspect or resume by exact session ID remains available.",
    };
  };
  return {
    load,
    async update(input: {
      readonly sessionId: string;
      readonly visibility: SessionVisibility;
      readonly expectedRevision: number;
    }): Promise<SessionVisibilityResult> {
      if (!z.uuid().safeParse(input.sessionId).success)
        return { status: "blocked", message: "The session identity is invalid." };
      try {
        const owner = await storage();
        const operation = async (): Promise<SessionVisibilityResult> => {
          const current = await load();
          if (current.status !== "ready")
            return { status: "unavailable", message: current.message };
          if (current.revision !== input.expectedRevision) return { status: "stale" };
          if (current.revision === Number.MAX_SAFE_INTEGER)
            return { status: "unavailable", message: "The archive revision limit was reached." };
          const archived = new Set(current.archived);
          if (input.visibility === "archived") archived.add(input.sessionId);
          else archived.delete(input.sessionId);
          const snapshot = {
            status: "ready" as const,
            revision: current.revision + 1,
            archived: [...archived].sort(),
          };
          await owner.write(
            JSON.stringify({
              schemaVersion: 1,
              revision: snapshot.revision,
              archived: snapshot.archived,
            }),
          );
          return { status: "updated", snapshot };
        };
        return await (owner.runExclusive?.(operation) ?? operation());
      } catch {
        // Rename may have succeeded before directory sync failed. Never invent a rollback receipt.
        return {
          status: "unavailable",
          message: "Archive update could not be confirmed. Reload history before retrying.",
        };
      }
    },
  };
}
