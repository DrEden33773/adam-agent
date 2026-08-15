import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename as renamePath,
  rmdir,
  unlink as unlinkPath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type PatchRecoveryBundle,
  type PatchRecoveryReference,
  type PatchRecoveryStore,
  PatchRecoveryStoreError,
} from "./patch-recovery-store.js";

export type ExactTextEdit = {
  readonly oldText: string;
  readonly newText: string;
};

export type NormalizedPatchOperation =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "move";
      readonly from: string;
      readonly to: string;
      readonly edits?: readonly ExactTextEdit[];
    }
  | { readonly kind: "update"; readonly path: string; readonly edits: readonly ExactTextEdit[] };

export type PatchSuccess = {
  readonly operations: readonly (
    | { readonly kind: "create"; readonly path: string; readonly bytesWritten: number }
    | { readonly kind: "delete"; readonly path: string }
    | {
        readonly kind: "move";
        readonly from: string;
        readonly to: string;
        readonly replacements: number;
        readonly bytesWritten: number;
      }
    | {
        readonly kind: "update";
        readonly path: string;
        readonly replacements: number;
        readonly bytesWritten: number;
      }
  )[];
};

export class PatchTransactionError extends Error {
  readonly code:
    | "outside_workspace"
    | "not_found"
    | "already_exists"
    | "ambiguous_match"
    | "binary_file"
    | "file_too_large"
    | "no_match"
    | "overlapping_edits"
    | "patch_recovery_cleanup_failed"
    | "patch_state_uncertain"
    | "tool_io_failed";
  readonly affectedPaths: readonly string[] | undefined;
  readonly settlement: "committed" | "rolled_back" | undefined;
  readonly recoveryReference: PatchRecoveryReference | undefined;

  constructor(
    code: PatchTransactionError["code"],
    message: string,
    details?:
      | {
          readonly affectedPaths: readonly string[];
          readonly recoveryReference: PatchRecoveryReference;
        }
      | {
          readonly settlement: "committed" | "rolled_back";
          readonly recoveryReference: PatchRecoveryReference;
        },
  ) {
    super(message);
    this.name = "PatchTransactionError";
    this.code = code;
    this.affectedPaths =
      details !== undefined && "affectedPaths" in details ? details.affectedPaths : undefined;
    this.settlement =
      details !== undefined && "settlement" in details ? details.settlement : undefined;
    this.recoveryReference = details?.recoveryReference;
  }
}

export type PatchTransaction = {
  execute(input: {
    readonly digest: string;
    readonly operations: readonly NormalizedPatchOperation[];
  }): Promise<PatchSuccess>;
};

export type PatchFileSystem = {
  /** Resolve only after the namespace effect; rejection guarantees that no effect occurred. */
  rename(source: string, destination: string): Promise<void>;
  /** Resolve only after the namespace effect; rejection guarantees that no effect occurred. */
  unlink(path: string): Promise<void>;
};

type ExistingSnapshot = {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
};

type PlannedOperation =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly absolutePath: string;
      readonly bytes: Buffer;
      readonly mode: number;
      temporaryPath?: string;
      createdDirectories?: readonly string[];
      targetWritten?: boolean;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly absolutePath: string;
      readonly originalBytes: Buffer;
      readonly originalMode: number;
      sourceRemoved?: boolean;
    }
  | {
      readonly kind: "move";
      readonly from: string;
      readonly to: string;
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly bytes: Buffer;
      readonly originalBytes: Buffer;
      readonly mode: number;
      readonly replacements: number;
      temporaryPath?: string;
      createdDirectories?: readonly string[];
      destinationWritten?: boolean;
      sourceRemoved?: boolean;
    }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly absolutePath: string;
      readonly bytes: Buffer;
      readonly originalBytes: Buffer;
      readonly mode: number;
      readonly replacements: number;
      temporaryPath?: string;
      createdDirectories?: readonly string[];
      targetWritten?: boolean;
    };

const maximumFileBytes = 1024 * 1024;
const maximumAggregateStagedBytes = 8 * 1024 * 1024;

export function createPatchTransaction(options: {
  readonly workspaceRoot: string;
  readonly fileSystem?: PatchFileSystem;
  readonly recoveryStore: PatchRecoveryStore;
}): PatchTransaction {
  const workspaceRoot = resolve(options.workspaceRoot);
  const fileSystem = options.fileSystem ?? {
    rename: renamePath,
    unlink: unlinkPath,
  };

  return {
    async execute(input) {
      const canonicalRoot = await realpath(workspaceRoot);
      const planned = await Promise.all(
        input.operations.map((operation) => planOperation(canonicalRoot, workspaceRoot, operation)),
      );
      const aggregateBytes = planned.reduce(
        (total, operation) => total + ("bytes" in operation ? operation.bytes.byteLength : 0),
        0,
      );
      if (aggregateBytes > maximumAggregateStagedBytes) {
        throw new PatchTransactionError(
          "file_too_large",
          "The patch exceeds the eight MiB aggregate result limit.",
        );
      }

      let recoveryBundle: PatchRecoveryBundle;
      try {
        recoveryBundle = await options.recoveryStore.create({
          digest: input.digest,
          operations: input.operations.map(summarizeRecoveryOperation),
          preimages: planned.flatMap(recoveryPreimages),
        });
      } catch (error) {
        if (error instanceof PatchRecoveryStoreError) {
          throw recoveryCleanupError("rolled_back", error.reference);
        }
        throw error;
      }
      try {
        for (const operation of planned) {
          await stageOperation(canonicalRoot, operation);
        }
      } catch (error) {
        const affectedPaths = await cleanupStagedOperations(planned);
        if (affectedPaths.size > 0) {
          throw uncertainPatchError(affectedPaths, recoveryBundle.reference);
        }
        await removeRecoveryBundle(recoveryBundle, "rolled_back");
        throw error;
      }

      try {
        for (const operation of planned) {
          await commitOperation(operation, fileSystem);
        }
      } catch (error) {
        const affectedPaths = new Set<string>();
        for (const operation of [...planned].reverse()) {
          try {
            await rollbackOperation(canonicalRoot, operation, fileSystem);
          } catch {
            for (const path of affectedOperationPaths(operation)) {
              affectedPaths.add(path);
            }
          }
        }
        for (const path of await cleanupStagedOperations(planned)) {
          affectedPaths.add(path);
        }
        if (affectedPaths.size > 0) {
          throw uncertainPatchError(affectedPaths, recoveryBundle.reference);
        }
        await removeRecoveryBundle(recoveryBundle, "rolled_back");
        throw error;
      }
      await removeRecoveryBundle(recoveryBundle, "committed");

      return {
        operations: planned.map((operation) => {
          switch (operation.kind) {
            case "create":
              return {
                kind: operation.kind,
                path: operation.path,
                bytesWritten: operation.bytes.byteLength,
              };
            case "delete":
              return { kind: operation.kind, path: operation.path };
            case "move":
              return {
                kind: operation.kind,
                from: operation.from,
                to: operation.to,
                replacements: operation.replacements,
                bytesWritten: operation.bytes.byteLength,
              };
            case "update":
              return {
                kind: operation.kind,
                path: operation.path,
                replacements: operation.replacements,
                bytesWritten: operation.bytes.byteLength,
              };
          }
          return assertNever(operation);
        }),
      };
    },
  };
}

function summarizeRecoveryOperation(
  operation: NormalizedPatchOperation,
):
  | { readonly kind: "create" | "delete" | "update"; readonly path: string }
  | { readonly kind: "move"; readonly from: string; readonly to: string } {
  switch (operation.kind) {
    case "create":
    case "delete":
    case "update":
      return { kind: operation.kind, path: operation.path };
    case "move":
      return { kind: operation.kind, from: operation.from, to: operation.to };
  }
}

function recoveryPreimages(
  operation: PlannedOperation,
): readonly { readonly path: string; readonly bytes: Buffer; readonly mode: number }[] {
  switch (operation.kind) {
    case "create":
      return [];
    case "delete":
      return [
        { path: operation.path, bytes: operation.originalBytes, mode: operation.originalMode },
      ];
    case "move":
      return [{ path: operation.from, bytes: operation.originalBytes, mode: operation.mode }];
    case "update":
      return [{ path: operation.path, bytes: operation.originalBytes, mode: operation.mode }];
  }
}

function affectedOperationPaths(operation: PlannedOperation): readonly string[] {
  switch (operation.kind) {
    case "create":
      return operation.targetWritten === true ? [operation.path] : [];
    case "delete":
      return operation.sourceRemoved === true ? [operation.path] : [];
    case "move":
      return [
        ...(operation.sourceRemoved === true ? [operation.from] : []),
        ...(operation.destinationWritten === true ? [operation.to] : []),
      ];
    case "update":
      return operation.targetWritten === true ? [operation.path] : [];
  }
}

function plannedOperationPaths(operation: PlannedOperation): readonly string[] {
  return operation.kind === "move" ? [operation.from, operation.to] : [operation.path];
}

function uncertainPatchError(
  affectedPaths: ReadonlySet<string>,
  recoveryReference: PatchRecoveryReference,
): PatchTransactionError {
  return new PatchTransactionError(
    "patch_state_uncertain",
    "The patch failed and automatic rollback could not confirm the workspace state.",
    {
      affectedPaths: [...affectedPaths].sort(),
      recoveryReference,
    },
  );
}

async function removeRecoveryBundle(
  recoveryBundle: {
    readonly reference: PatchRecoveryReference;
    remove(): Promise<void>;
  },
  settlement: "committed" | "rolled_back",
): Promise<void> {
  try {
    await recoveryBundle.remove();
  } catch {
    throw recoveryCleanupError(settlement, recoveryBundle.reference);
  }
}

function recoveryCleanupError(
  settlement: "committed" | "rolled_back",
  recoveryReference: PatchRecoveryReference,
): PatchTransactionError {
  return new PatchTransactionError(
    "patch_recovery_cleanup_failed",
    settlement === "committed"
      ? "The patch committed, but its recovery data could not be removed. Do not retry the patch automatically."
      : "The patch was rolled back, but its recovery data could not be removed. Inspect recovery data before retrying.",
    { settlement, recoveryReference },
  );
}

async function planOperation(
  canonicalRoot: string,
  workspaceRoot: string,
  operation: NormalizedPatchOperation,
): Promise<PlannedOperation> {
  switch (operation.kind) {
    case "create": {
      const absolutePath = resolveRelativePath(workspaceRoot, operation.path);
      await assertAbsentAndParentConfined(canonicalRoot, absolutePath);
      return {
        kind: operation.kind,
        path: operation.path,
        absolutePath,
        bytes: Buffer.from(operation.content, "utf8"),
        mode: 0o666 & ~process.umask(),
      };
    }
    case "delete": {
      const snapshot = await readExistingSnapshot(canonicalRoot, workspaceRoot, operation.path);
      return {
        kind: operation.kind,
        path: operation.path,
        absolutePath: snapshot.path,
        originalBytes: snapshot.bytes,
        originalMode: snapshot.mode,
      };
    }
    case "move": {
      const snapshot = await readExistingSnapshot(canonicalRoot, workspaceRoot, operation.from);
      const destinationPath = resolveRelativePath(workspaceRoot, operation.to);
      await assertAbsentAndParentConfined(canonicalRoot, destinationPath);
      const updated = applyEdits(snapshot.bytes, operation.edits ?? []);
      return {
        kind: operation.kind,
        from: operation.from,
        to: operation.to,
        sourcePath: snapshot.path,
        destinationPath,
        bytes: updated.bytes,
        originalBytes: snapshot.bytes,
        mode: snapshot.mode,
        replacements: operation.edits?.length ?? 0,
      };
    }
    case "update": {
      const snapshot = await readExistingSnapshot(canonicalRoot, workspaceRoot, operation.path);
      const updated = applyEdits(snapshot.bytes, operation.edits);
      return {
        kind: operation.kind,
        path: operation.path,
        absolutePath: snapshot.path,
        bytes: updated.bytes,
        originalBytes: snapshot.bytes,
        mode: snapshot.mode,
        replacements: operation.edits.length,
      };
    }
  }
}

async function readExistingSnapshot(
  canonicalRoot: string,
  workspaceRoot: string,
  path: string,
): Promise<ExistingSnapshot> {
  const absolutePath = resolveRelativePath(workspaceRoot, path);
  try {
    const entryStats = await lstat(absolutePath);
    if (entryStats.isSymbolicLink()) {
      throw new PatchTransactionError(
        "outside_workspace",
        "The requested path resolves outside the workspace root.",
      );
    }
    if (!entryStats.isFile()) {
      throw new PatchTransactionError(
        "binary_file",
        "The requested path is not an ordinary UTF-8 text file.",
      );
    }
  } catch (error) {
    if (error instanceof PatchTransactionError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PatchTransactionError("not_found", "The requested path does not exist.");
    }
    throw error;
  }
  let file: FileHandle;
  try {
    file = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PatchTransactionError("not_found", "The requested path does not exist.");
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new PatchTransactionError(
        "outside_workspace",
        "The requested path resolves outside the workspace root.",
      );
    }
    throw error;
  }
  try {
    const [openedStats, canonicalPath] = await Promise.all([file.stat(), realpath(absolutePath)]);
    if (!openedStats.isFile()) {
      throw new PatchTransactionError(
        "binary_file",
        "The requested path is not an ordinary UTF-8 text file.",
      );
    }
    if (isOutside(canonicalRoot, canonicalPath)) {
      throw new PatchTransactionError(
        "outside_workspace",
        "The requested path resolves outside the workspace root.",
      );
    }
    if (openedStats.size > maximumFileBytes) {
      throw new PatchTransactionError(
        "file_too_large",
        "The requested file exceeds the one MiB edit limit.",
      );
    }
    const bytes = await readBytesFully(file, openedStats.size);
    assertTextBytes(bytes);
    return { path: absolutePath, bytes, mode: openedStats.mode & 0o7777 };
  } finally {
    await file.close();
  }
}

function assertTextBytes(bytes: Buffer): void {
  if (bytes.includes(0)) {
    throw new PatchTransactionError(
      "binary_file",
      "The requested file is not supported UTF-8 text.",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PatchTransactionError(
      "binary_file",
      "The requested file is not supported UTF-8 text.",
    );
  }
}

async function assertAbsentAndParentConfined(
  canonicalRoot: string,
  absolutePath: string,
): Promise<void> {
  try {
    await lstat(absolutePath);
    throw new PatchTransactionError("already_exists", "The requested file already exists.");
  } catch (error) {
    if (error instanceof PatchTransactionError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const canonicalParent = await resolveNearestExistingParent(dirname(absolutePath));
  if (isOutside(canonicalRoot, canonicalParent)) {
    throw new PatchTransactionError(
      "outside_workspace",
      "The requested path resolves outside the workspace root.",
    );
  }
}

async function resolveNearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function applyEdits(
  originalBytes: Buffer,
  edits: readonly ExactTextEdit[],
): { readonly bytes: Buffer } {
  if (originalBytes.includes(0)) {
    throw new PatchTransactionError(
      "binary_file",
      "The requested file is not supported UTF-8 text.",
    );
  }
  let originalContent: string;
  try {
    originalContent = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
    if (originalBytes[0] === 0xef && originalBytes[1] === 0xbb && originalBytes[2] === 0xbf) {
      originalContent = `\uFEFF${originalContent}`;
    }
  } catch {
    throw new PatchTransactionError(
      "binary_file",
      "The requested file is not supported UTF-8 text.",
    );
  }
  const lineEnding = detectLineEnding(originalContent);
  const replacements = edits.map((edit) => {
    const firstMatch = originalContent.indexOf(edit.oldText);
    if (firstMatch === -1) {
      throw new PatchTransactionError("no_match", "The edit text was not found in the file.");
    }
    if (originalContent.indexOf(edit.oldText, firstMatch + 1) !== -1) {
      throw new PatchTransactionError(
        "ambiguous_match",
        "The edit text matched more than one location.",
      );
    }
    return {
      start: firstMatch,
      end: firstMatch + edit.oldText.length,
      newText:
        lineEnding === undefined ? edit.newText : edit.newText.replace(/\r\n|\r|\n/gu, lineEnding),
    };
  });
  replacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index += 1) {
    const prior = replacements[index - 1];
    const current = replacements[index];
    if (prior !== undefined && current !== undefined && current.start < prior.end) {
      throw new PatchTransactionError(
        "overlapping_edits",
        "The requested edits overlap in the original file.",
      );
    }
  }
  let updatedContent = "";
  let originalOffset = 0;
  for (const replacement of replacements) {
    updatedContent += originalContent.slice(originalOffset, replacement.start);
    updatedContent += replacement.newText;
    originalOffset = replacement.end;
  }
  updatedContent += originalContent.slice(originalOffset);
  const bytes = Buffer.from(updatedContent, "utf8");
  if (bytes.byteLength > maximumFileBytes) {
    throw new PatchTransactionError(
      "file_too_large",
      "The updated file exceeds the one MiB edit limit.",
    );
  }
  return { bytes };
}

async function stageBytes(
  canonicalRoot: string,
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<{
  readonly temporaryPath: string;
  readonly createdDirectories: readonly string[];
}> {
  const createdDirectories = await findMissingParentDirectories(dirname(path));
  let temporaryPath: string | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    if (isOutside(canonicalRoot, await realpath(dirname(path)))) {
      throw new PatchTransactionError(
        "outside_workspace",
        "The requested path resolves outside the workspace root.",
      );
    }
    temporaryPath = temporarySiblingPath(path);
    const file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await writeBytesFully(file, bytes);
      await file.chmod(mode);
    } finally {
      await file.close();
    }
    return { temporaryPath, createdDirectories };
  } catch (error) {
    if (temporaryPath !== undefined) {
      await unlinkPath(temporaryPath).catch(() => undefined);
    }
    await removeDirectoryPaths(createdDirectories);
    throw error;
  }
}

async function stageOperation(canonicalRoot: string, operation: PlannedOperation): Promise<void> {
  if (!("bytes" in operation)) {
    return;
  }
  const path = "absolutePath" in operation ? operation.absolutePath : operation.destinationPath;
  operation.createdDirectories = await findMissingParentDirectories(dirname(path));
  await mkdir(dirname(path), { recursive: true });
  if (isOutside(canonicalRoot, await realpath(dirname(path)))) {
    throw new PatchTransactionError(
      "outside_workspace",
      "The requested path resolves outside the workspace root.",
    );
  }
  operation.temporaryPath = temporarySiblingPath(path);
  const file = await open(
    operation.temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    operation.mode,
  );
  try {
    await writeBytesFully(file, operation.bytes);
    await file.chmod(operation.mode);
  } finally {
    await file.close();
  }
}

async function findMissingParentDirectories(path: string): Promise<readonly string[]> {
  const missing: string[] = [];
  let candidate = path;
  while (true) {
    try {
      await realpath(candidate);
      return missing;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      missing.push(candidate);
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function temporarySiblingPath(path: string): string {
  return join(dirname(path), `.adam-agent-${randomUUID()}.tmp`);
}

async function cleanupStagedOperations(
  operations: readonly PlannedOperation[],
): Promise<ReadonlySet<string>> {
  const affectedPaths = new Set<string>();
  for (const operation of operations) {
    if ("temporaryPath" in operation && operation.temporaryPath !== undefined) {
      try {
        await unlinkPath(operation.temporaryPath);
        delete operation.temporaryPath;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          delete operation.temporaryPath;
        } else {
          for (const path of plannedOperationPaths(operation)) {
            affectedPaths.add(path);
          }
        }
      }
    }
  }
  for (const operation of [...operations].reverse()) {
    if (!("createdDirectories" in operation) || operation.createdDirectories === undefined) {
      continue;
    }
    try {
      await removeDirectoryPaths(operation.createdDirectories);
      operation.createdDirectories = [];
    } catch {
      for (const path of plannedOperationPaths(operation)) {
        affectedPaths.add(path);
      }
    }
  }
  return affectedPaths;
}

async function removeDirectoryPaths(paths: readonly string[]): Promise<void> {
  const directories = [...paths].sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    await rmdir(directory).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function commitOperation(
  operation: PlannedOperation,
  fileSystem: PatchFileSystem,
): Promise<void> {
  switch (operation.kind) {
    case "create":
      await fileSystem.rename(requireTemporaryPath(operation), operation.absolutePath);
      delete operation.temporaryPath;
      operation.targetWritten = true;
      return;
    case "update":
      await fileSystem.rename(requireTemporaryPath(operation), operation.absolutePath);
      delete operation.temporaryPath;
      operation.targetWritten = true;
      return;
    case "delete":
      await fileSystem.unlink(operation.absolutePath);
      operation.sourceRemoved = true;
      return;
    case "move":
      await fileSystem.rename(requireTemporaryPath(operation), operation.destinationPath);
      delete operation.temporaryPath;
      operation.destinationWritten = true;
      await fileSystem.unlink(operation.sourcePath);
      operation.sourceRemoved = true;
      return;
  }
}

async function rollbackOperation(
  canonicalRoot: string,
  operation: PlannedOperation,
  fileSystem: PatchFileSystem,
): Promise<void> {
  switch (operation.kind) {
    case "create":
      if (operation.targetWritten === true) {
        await fileSystem.unlink(operation.absolutePath);
        operation.targetWritten = false;
      }
      return;
    case "delete":
      if (operation.sourceRemoved === true) {
        await restoreBytes(
          canonicalRoot,
          operation.absolutePath,
          operation.originalBytes,
          operation.originalMode,
          fileSystem,
        );
        operation.sourceRemoved = false;
      }
      return;
    case "move":
      if (operation.sourceRemoved === true) {
        await restoreBytes(
          canonicalRoot,
          operation.sourcePath,
          operation.originalBytes,
          operation.mode,
          fileSystem,
        );
        operation.sourceRemoved = false;
      }
      if (operation.destinationWritten === true) {
        await fileSystem.unlink(operation.destinationPath);
        operation.destinationWritten = false;
      }
      return;
    case "update":
      if (operation.targetWritten === true) {
        await restoreBytes(
          canonicalRoot,
          operation.absolutePath,
          operation.originalBytes,
          operation.mode,
          fileSystem,
        );
        operation.targetWritten = false;
      }
      return;
  }
}

async function restoreBytes(
  canonicalRoot: string,
  path: string,
  bytes: Buffer,
  mode: number,
  fileSystem: PatchFileSystem,
): Promise<void> {
  const staged = await stageBytes(canonicalRoot, path, bytes, mode);
  try {
    await fileSystem.rename(staged.temporaryPath, path);
  } finally {
    await unlinkPath(staged.temporaryPath).catch(() => undefined);
  }
}

function requireTemporaryPath(operation: PlannedOperation & { temporaryPath?: string }): string {
  if (operation.temporaryPath === undefined) {
    throw new Error("The patch operation was not staged.");
  }
  return operation.temporaryPath;
}

async function readBytesFully(file: FileHandle, byteCount: number): Promise<Buffer> {
  const bytes = Buffer.alloc(byteCount);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function writeBytesFully(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten === 0) {
      throw new Error("The filesystem made no progress while writing.");
    }
    offset += result.bytesWritten;
  }
}

function resolveRelativePath(workspaceRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) {
    throw new PatchTransactionError(
      "outside_workspace",
      "The requested path must be relative to the workspace root.",
    );
  }
  const path = resolve(workspaceRoot, requestedPath);
  if (isOutside(workspaceRoot, path)) {
    throw new PatchTransactionError(
      "outside_workspace",
      "The requested path is outside the workspace root.",
    );
  }
  return path;
}

function isOutside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function detectLineEnding(content: string): "\n" | "\r" | "\r\n" | undefined {
  const firstCarriageReturn = content.indexOf("\r");
  const firstLineFeed = content.indexOf("\n");
  if (firstCarriageReturn === -1 && firstLineFeed === -1) {
    return undefined;
  }
  if (firstCarriageReturn !== -1 && (firstLineFeed === -1 || firstCarriageReturn < firstLineFeed)) {
    return content[firstCarriageReturn + 1] === "\n" ? "\r\n" : "\r";
  }
  return "\n";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected patch operation: ${String(value)}`);
}
