import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createOwnerConfigurationFileStorage,
  hasDuplicateJsonObjectKey,
} from "./secure-user-configuration.js";

const uuid = z.uuid();
const identitySchema = z.strictObject({
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  size: z.number().int().nonnegative().safe(),
  modifiedNanoseconds: z.string().regex(/^-?\d+$/u),
});
const fileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("main"), identity: identitySchema }),
  z.strictObject({ kind: z.literal("child"), sessionId: uuid, identity: identitySchema }),
  z.strictObject({ kind: z.literal("control"), identity: identitySchema }),
  z.strictObject({ kind: z.literal("capacity"), identity: identitySchema }),
  z.strictObject({ kind: z.literal("main_draft"), identity: identitySchema }),
  z.strictObject({ kind: z.literal("child_draft"), threadId: uuid, identity: identitySchema }),
]);
const unitSchema = z.strictObject({
  mainSessionId: uuid,
  label: z.string().min(1).max(1_024),
  children: z.array(z.strictObject({ sessionId: uuid, threadId: uuid })).max(10_000),
  threadIds: z.array(uuid).max(10_000),
  sourceSessionIds: z.array(uuid).max(10_000),
  archived: z.boolean(),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: uuid,
  projectId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  revision: z.number().int().nonnegative().safe(),
  phase: z.enum(["prepared", "trashing", "trashed", "restoring", "restored"]),
  unit: unitSchema,
  files: z.array(fileSchema).min(1).max(20_002),
  completedFiles: z.number().int().nonnegative().safe(),
});

export type SessionTrashUnit = z.infer<typeof unitSchema>;
export type SessionTrashFile = z.infer<typeof fileSchema>;
export type SessionTrashFileSpec = SessionTrashFile extends infer File
  ? File extends { identity: unknown }
    ? Omit<File, "identity">
    : never
  : never;
export type SessionTrashManifest = z.infer<typeof manifestSchema>;
export type SessionTrashCatalog = {
  readonly transactions: readonly SessionTrashManifest[];
  readonly diagnostics: readonly { readonly transactionId: string; readonly message: string }[];
};
export type SessionTrashResult =
  | { readonly status: "completed"; readonly manifest: SessionTrashManifest }
  | { readonly status: "stale" }
  | { readonly status: "conflict" | "unavailable"; readonly message: string }
  | { readonly status: "incomplete"; readonly transactionId: string; readonly message: string };

/** The actual filesystem boundary, including failures after an observable link/unlink effect. */
export type SessionTrashFileSystem = {
  readonly open: typeof open;
  readonly mkdir: typeof mkdir;
  readonly readdir: typeof readdir;
  readonly link: typeof link;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
  readonly rmdir: typeof rmdir;
};
export const sessionTrashFileSystem = Symbol("adam-agent.session-trash-file-system");
const nativeFileSystem: SessionTrashFileSystem = {
  open,
  mkdir,
  readdir,
  link,
  rename,
  unlink,
  rmdir,
};
const maximumManifestBytes = 8 * 1024 * 1024;

export class SessionTrashError extends Error {
  constructor(
    readonly code: "conflict" | "unavailable",
    message: string,
    readonly transactionId?: string,
  ) {
    super(message);
    this.name = "SessionTrashError";
  }
}

export function createSessionTrashRepository(input: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly fileSystem?: SessionTrashFileSystem;
}) {
  const io = input.fileSystem ?? nativeFileSystem;
  const stateRoot = resolve(input.stateRoot);
  let locationPromise: Promise<{ projectId: string; project: string; root: string }> | undefined;
  const location = () =>
    (locationPromise ??= realpath(input.workspaceRoot).then((workspace) => {
      const project = createHash("sha256").update(workspace).digest("hex");
      return {
        project,
        projectId: `sha256:${project}`,
        root: join(stateRoot, "projects", project, "session-trash"),
      };
    }));
  const ownerId = () => {
    const id = process.geteuid?.();
    if (id === undefined)
      throw new SessionTrashError(
        "unavailable",
        "Session Trash requires the supported Linux owner boundary.",
      );
    return BigInt(id);
  };
  const isMissing = (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT";
  const checkedDirectory = async (path: string, create: boolean): Promise<boolean> => {
    const suffix = relative(stateRoot, path);
    if (suffix === ".." || suffix.startsWith("../"))
      throw new SessionTrashError("unavailable", "Trash path escaped its state root.");
    let current = stateRoot;
    for (const part of ["", ...suffix.split("/").filter(Boolean)]) {
      if (part !== "") current = join(current, part);
      const created = create
        ? await io.mkdir(current, { recursive: true, mode: 0o700 })
        : undefined;
      let directory: Awaited<ReturnType<typeof open>>;
      try {
        directory = await io.open(
          current,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (!create && isMissing(error)) return false;
        throw error;
      }
      try {
        const stats = await directory.stat({ bigint: true });
        if (!stats.isDirectory() || stats.uid !== ownerId() || (stats.mode & 0o077n) !== 0n)
          throw new SessionTrashError(
            "unavailable",
            "Session Trash requires owner-private directories.",
          );
      } finally {
        await directory.close();
      }
      if (created !== undefined) {
        const parent = await io.open(
          dirname(current),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    }
    return true;
  };
  const syncDirectory = async (path: string) => {
    await checkedDirectory(path, false);
    const directory = await io.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  const identity = async (path: string): Promise<SessionTrashFile["identity"] | undefined> => {
    if (!(await checkedDirectory(dirname(path), false))) return undefined;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const stats = await file.stat({ bigint: true });
      if (
        !stats.isFile() ||
        stats.uid !== ownerId() ||
        (stats.mode & 0o077n) !== 0n ||
        stats.size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new SessionTrashError(
          "conflict",
          "A session file is not an owner-private regular file.",
        );
      return {
        device: String(stats.dev),
        inode: String(stats.ino),
        size: Number(stats.size),
        modifiedNanoseconds: String(stats.mtimeNs),
      };
    } finally {
      await file.close();
    }
  };
  const paths = async (
    unit: SessionTrashUnit,
    file: SessionTrashFileSpec,
    transactionId?: string,
  ) => {
    const { project, root } = await location();
    const projectRoot = join(stateRoot, "projects", project);
    const main = unit.mainSessionId;
    const name =
      file.kind === "child"
        ? `child-${file.sessionId}.jsonl`
        : file.kind === "child_draft"
          ? `draft-${file.threadId}.json`
          : `${file.kind}.${file.kind === "main" || file.kind === "control" ? "jsonl" : "json"}`;
    const source =
      file.kind === "main"
        ? join(projectRoot, "sessions", `${main}.jsonl`)
        : file.kind === "child"
          ? join(
              stateRoot,
              "managed-agent-sessions",
              "projects",
              project,
              "sessions",
              `${file.sessionId}.jsonl`,
            )
          : file.kind === "control"
            ? join(projectRoot, "managed-agents", `events-v3-${main}.jsonl`)
            : file.kind === "capacity"
              ? join(projectRoot, "managed-agents", `capacity-${main}.json`)
              : file.kind === "main_draft"
                ? join(stateRoot, "drafts", project, `session-${main}.json`)
                : join(stateRoot, "drafts", project, `managed-${main}-${file.threadId}.json`);
    return {
      source,
      destination:
        transactionId === undefined ? undefined : join(root, transactionId, "files", name),
    };
  };
  const manifestStorage = async (transactionId: string, unpublished = false) => {
    if (!uuid.safeParse(transactionId).success)
      throw new SessionTrashError("unavailable", "The Trash transaction identity is invalid.");
    const { root } = await location();
    const directoryPath = join(root, unpublished ? `.preparing-${transactionId}` : transactionId);
    return createOwnerConfigurationFileStorage({
      directoryPath,
      configurationPath: join(directoryPath, "manifest.json"),
      maximumBytes: maximumManifestBytes,
      temporaryPrefix: ".manifest",
    });
  };
  const readManifest = async (transactionId: string): Promise<SessionTrashManifest> => {
    const { root, projectId } = await location();
    await checkedDirectory(join(root, transactionId), false);
    const read = await (await manifestStorage(transactionId)).read();
    if (read.status !== "available" || hasDuplicateJsonObjectKey(read.text))
      throw new SessionTrashError(
        "unavailable",
        "The retained Trash manifest is missing, unsafe or invalid.",
      );
    const parsed = manifestSchema.parse(JSON.parse(read.text));
    if (
      parsed.transactionId !== transactionId ||
      parsed.projectId !== projectId ||
      parsed.completedFiles > parsed.files.length
    )
      throw new SessionTrashError("unavailable", "The Trash manifest identity is invalid.");
    const members = [
      parsed.unit.mainSessionId,
      ...parsed.unit.children.map((child) => child.sessionId),
    ];
    const slots = parsed.files.map((file) =>
      file.kind === "child"
        ? `child:${file.sessionId}`
        : file.kind === "child_draft"
          ? `draft:${file.threadId}`
          : file.kind,
    );
    if (
      new Set(members).size !== members.length ||
      new Set(parsed.unit.threadIds).size !== parsed.unit.threadIds.length ||
      new Set(slots).size !== slots.length ||
      !parsed.files.some((file) => file.kind === "main") ||
      parsed.files.some((file) =>
        file.kind === "child"
          ? !members.includes(file.sessionId) || file.sessionId === parsed.unit.mainSessionId
          : file.kind === "child_draft" && !parsed.unit.threadIds.includes(file.threadId),
      )
    )
      throw new SessionTrashError(
        "unavailable",
        "The Trash manifest has conflicting file ownership.",
      );
    return parsed;
  };
  const list = async (): Promise<SessionTrashCatalog> => {
    const { root } = await location();
    let probe: Awaited<ReturnType<typeof open>>;
    try {
      probe = await io.open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isMissing(error)) return { transactions: [], diagnostics: [] };
      throw error;
    }
    await probe.close();
    await checkedDirectory(root, false);
    const entries = await io.readdir(root, { withFileTypes: true });
    const transactions: SessionTrashManifest[] = [];
    const diagnostics: Array<{ transactionId: string; message: string }> = [];
    for (const entry of entries) {
      if (entry.name === ".mutation.lock") continue;
      if (
        entry.isDirectory() &&
        entry.name.startsWith(".preparing-") &&
        uuid.safeParse(entry.name.slice(".preparing-".length)).success
      )
        continue;
      try {
        if (!entry.isDirectory() || !uuid.safeParse(entry.name).success)
          throw new Error("Unknown transaction entry");
        transactions.push(await readManifest(entry.name));
      } catch {
        diagnostics.push({
          transactionId: entry.name,
          message: "Trash metadata could not be verified. Retained files were not changed.",
        });
      }
    }
    const reserved = new Set<string>();
    for (const transaction of transactions) {
      if (transaction.phase === "restored") continue;
      for (const member of [
        transaction.unit.mainSessionId,
        ...transaction.unit.children.map((child) => child.sessionId),
      ]) {
        if (reserved.has(member))
          diagnostics.push({
            transactionId: transaction.transactionId,
            message: "More than one Trash transaction claims this session.",
          });
        reserved.add(member);
      }
    }
    return { transactions, diagnostics };
  };
  const writeManifest = async (manifest: SessionTrashManifest, unpublished = false) => {
    const validated = manifestSchema.parse(manifest);
    const { root } = await location();
    const directory = join(
      root,
      unpublished ? `.preparing-${manifest.transactionId}` : manifest.transactionId,
    );
    await checkedDirectory(directory, true);
    await (await manifestStorage(manifest.transactionId, unpublished)).write(
      `${JSON.stringify(validated)}\n`,
    );
    if (unpublished) await io.rename(directory, join(root, manifest.transactionId));
    // The first manifest's containing directory must also survive loss of the process.
    await syncDirectory(root);
  };
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const { root } = await location();
    await checkedDirectory(root, true);
    const lock = createOwnerConfigurationFileStorage({
      directoryPath: root,
      configurationPath: join(root, ".unused"),
      maximumBytes: 1,
      mutationLockName: ".mutation.lock",
      temporaryPrefix: ".unused",
    });
    if (lock.runExclusive === undefined)
      throw new SessionTrashError("unavailable", "The Trash lock is unavailable.");
    return lock.runExclusive(operation);
  };
  const inspectFiles = async (
    unit: SessionTrashUnit,
    specs: readonly SessionTrashFileSpec[],
  ): Promise<readonly SessionTrashFile[]> => {
    unitSchema.parse(unit);
    const files: SessionTrashFile[] = [];
    for (const spec of specs) {
      // Validate generated slots before deriving any path from external manifest data.
      fileSchema.parse({
        ...spec,
        identity: { device: "0", inode: "0", size: 0, modifiedNanoseconds: "0" },
      });
      const observed = await identity((await paths(unit, spec)).source);
      if (observed === undefined) {
        if (spec.kind === "main" || spec.kind === "child")
          throw new SessionTrashError("conflict", "A required session history file is missing.");
      } else files.push({ ...spec, identity: observed } as SessionTrashFile);
    }
    return files;
  };
  const move = async (manifest: SessionTrashManifest, file: SessionTrashFile, restore: boolean) => {
    const path = await paths(manifest.unit, file, manifest.transactionId);
    const from = restore ? (path.destination as string) : path.source;
    const to = restore ? path.source : (path.destination as string);
    await checkedDirectory(dirname(to), true);
    const fromIdentity = await identity(from);
    let toIdentity = await identity(to);
    if (
      (fromIdentity !== undefined && !isDeepStrictEqual(fromIdentity, file.identity)) ||
      (toIdentity !== undefined && !isDeepStrictEqual(toIdentity, file.identity)) ||
      (fromIdentity === undefined && toIdentity === undefined)
    )
      throw new SessionTrashError(
        "conflict",
        "A retained session file is missing or a destination conflicts. No file was overwritten.",
      );
    if (toIdentity === undefined) {
      await io.link(from, to);
      toIdentity = await identity(to);
      if (!isDeepStrictEqual(toIdentity, file.identity))
        throw new SessionTrashError("conflict", "The moved file identity changed.");
    }
    // This also repairs a crash between link() and its directory sync.
    await syncDirectory(dirname(to));
    if (fromIdentity !== undefined) {
      if (!isDeepStrictEqual(await identity(from), file.identity))
        throw new SessionTrashError(
          "conflict",
          "The source file changed before movement completed.",
        );
      await io.unlink(from);
    }
    if (await checkedDirectory(dirname(from), false)) await syncDirectory(dirname(from));
  };
  const execute = async (
    transactionId: string,
    expectedRevision: number,
    restore: boolean,
    validate?: (manifest: SessionTrashManifest) => Promise<void>,
  ): Promise<SessionTrashResult> => {
    try {
      return await exclusive(async (): Promise<SessionTrashResult> => {
        let manifest = await readManifest(transactionId);
        if (manifest.revision !== expectedRevision) return { status: "stale" };
        if (manifest.phase === "restored" || (!restore && manifest.phase === "trashed"))
          return { status: "completed", manifest };
        if (!restore && manifest.phase === "restoring")
          return {
            status: "conflict",
            message: "This transaction is restoring. Continue Restore to finish it.",
          };
        // Check every destination before moving any file; link() also enforces this atomically.
        for (const file of manifest.files) {
          const path = await paths(manifest.unit, file, transactionId);
          const source = await identity(path.source);
          const destination = await identity(path.destination as string);
          if (
            (source !== undefined && !isDeepStrictEqual(source, file.identity)) ||
            (destination !== undefined && !isDeepStrictEqual(destination, file.identity)) ||
            (source === undefined && destination === undefined)
          )
            return {
              status: "conflict",
              message:
                "The session unit has a missing file or an occupied restore target. No file was overwritten.",
            };
        }
        manifest = {
          ...manifest,
          revision: manifest.revision + 1,
          phase: restore ? "restoring" : "trashing",
          completedFiles: 0,
        };
        await writeManifest(manifest);
        try {
          for (const file of manifest.files) {
            await move(manifest, file, restore);
            manifest = {
              ...manifest,
              revision: manifest.revision + 1,
              completedFiles: manifest.completedFiles + 1,
            };
            await writeManifest(manifest);
          }
          if (restore) {
            if (validate === undefined)
              throw new SessionTrashError(
                "unavailable",
                "Restore validation is required before the unit can become available.",
              );
            await validate(manifest);
          }
          manifest = {
            ...manifest,
            revision: manifest.revision + 1,
            phase: restore ? "restored" : "trashed",
          };
          await writeManifest(manifest);
          return { status: "completed", manifest };
        } catch (error) {
          return {
            status: "incomplete",
            transactionId,
            message:
              error instanceof SessionTrashError
                ? error.message
                : "The transaction did not finish. Inspect Trash and explicitly Continue or Restore.",
          };
        }
      });
    } catch (error) {
      return {
        status: "unavailable",
        message:
          error instanceof SessionTrashError
            ? error.message
            : "Trash metadata could not be updated safely. Inspect the retained transaction before retrying.",
      };
    }
  };
  return {
    list,
    readManifest,
    inspectFiles,
    async inspectDraftThreads(mainSessionId: string): Promise<readonly string[]> {
      if (!uuid.safeParse(mainSessionId).success)
        throw new SessionTrashError("conflict", "The Main identity is invalid.");
      const { project } = await location();
      const directory = join(stateRoot, "drafts", project);
      if (!(await checkedDirectory(directory, false))) return [];
      const prefix = `managed-${mainSessionId}-`;
      const threads: string[] = [];
      for (const entry of await io.readdir(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith(prefix)) continue;
        const id = entry.name.slice(prefix.length, -".json".length);
        if (!entry.isFile() || !entry.name.endsWith(".json") || !uuid.safeParse(id).success)
          throw new SessionTrashError("conflict", "An owned Child draft has an invalid identity.");
        threads.push(id);
      }
      return threads.sort();
    },
    async assertAccessible(sessionId: string): Promise<void> {
      const catalog = await list();
      if (catalog.diagnostics.length > 0)
        throw new SessionTrashError(
          "unavailable",
          "Trash metadata is unverified; session mutations require recovery.",
        );
      if (
        catalog.transactions.some(
          (entry) =>
            entry.phase !== "restored" &&
            (entry.unit.mainSessionId === sessionId ||
              entry.unit.children.some((child) => child.sessionId === sessionId)),
        )
      )
        throw new SessionTrashError(
          "conflict",
          "This session belongs to Trash or an unfinished transaction. Restore the complete unit first.",
        );
    },
    async prepare(
      unit: SessionTrashUnit,
      files: readonly SessionTrashFile[],
    ): Promise<SessionTrashManifest> {
      return exclusive(async () => {
        const catalog = await list();
        if (catalog.diagnostics.length > 0)
          throw new SessionTrashError(
            "unavailable",
            "Existing Trash metadata requires inspection.",
          );
        const members = new Set([
          unit.mainSessionId,
          ...unit.children.map((child) => child.sessionId),
        ]);
        if (
          catalog.transactions.some(
            (entry) =>
              entry.phase !== "restored" &&
              [
                entry.unit.mainSessionId,
                ...entry.unit.children.map((child) => child.sessionId),
              ].some((id) => members.has(id)),
          )
        )
          throw new SessionTrashError(
            "conflict",
            "A Trash transaction already reserves this session unit.",
          );
        const observed = await inspectFiles(
          unit,
          files.map(({ identity: _identity, ...spec }) => spec),
        );
        if (!isDeepStrictEqual(observed, files))
          throw new SessionTrashError("conflict", "Session files changed after preview.");
        const directory = await io.open(
          (await location()).root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const device = String((await directory.stat({ bigint: true })).dev);
          if (files.some((file) => file.identity.device !== device))
            throw new SessionTrashError(
              "conflict",
              "The session unit is not on the Trash filesystem.",
            );
        } finally {
          await directory.close();
        }
        const manifest: SessionTrashManifest = {
          schemaVersion: 1,
          transactionId: randomUUID(),
          projectId: (await location()).projectId,
          revision: 0,
          phase: "prepared",
          unit,
          files: [...files],
          completedFiles: 0,
        };
        try {
          await writeManifest(manifest, true);
        } catch {
          const storage = await manifestStorage(manifest.transactionId);
          const read = await storage.read().catch(() => undefined);
          if (read?.status === "missing") {
            await io
              .rmdir(join((await location()).root, manifest.transactionId))
              .catch(() => undefined);
          }
          throw new SessionTrashError(
            "unavailable",
            "Trash preparation could not be confirmed. Inspect Trash before retrying.",
            manifest.transactionId,
          );
        }
        return manifest;
      });
    },
    execute,
  };
}
