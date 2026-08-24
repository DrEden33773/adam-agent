import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE,
  EXTENSION_PROJECT_CHANGE_PATH_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES,
  EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES,
} from "@adam-agent/extension-api";
import type {
  ProjectChangeCaptureAdapter,
  ProjectChangeCapturedEntry,
  ProjectChangeRawBase,
  ProjectChangeRawCapture,
} from "./project-change-materializer.js";

export class GitProjectChangeCaptureError extends Error {
  readonly code:
    | "capture_inconsistent"
    | "cleanup_failed"
    | "git_command_failed"
    | "limit_exceeded"
    | "repository_state_unsupported"
    | "repository_unavailable";

  constructor(code: GitProjectChangeCaptureError["code"], options?: { readonly cause: unknown }) {
    super(gitCaptureErrorMessage(code), options);
    this.name = "GitProjectChangeCaptureError";
    this.code = code;
  }
}

type GitCaptureObserver = {
  afterCandidateTree?(candidateTree: string): Promise<void> | void;
};

export function createGitProjectChangeCaptureAdapter(): ProjectChangeCaptureAdapter {
  return createGitProjectChangeCaptureAdapterWithObserver({});
}

/** Tests only. This internal causal-observation surface has no compatibility promise. */
export function createObservedGitProjectChangeCaptureAdapter(
  observer: GitCaptureObserver,
): ProjectChangeCaptureAdapter {
  return createGitProjectChangeCaptureAdapterWithObserver(observer);
}

function createGitProjectChangeCaptureAdapterWithObserver(
  observer: GitCaptureObserver,
): ProjectChangeCaptureAdapter {
  return {
    async capture({ canonicalProjectRoot }) {
      const repositoryRoot = await canonicalRepositoryRoot(canonicalProjectRoot);
      await assertSupportedRepository(repositoryRoot);
      const objectFormat = await readObjectFormat(repositoryRoot);
      const gitDirectory = await readGitDirectory(repositoryRoot);
      const repositoryObjectDirectory = await readGitObjectDirectory(repositoryRoot);
      const excludes = await readEffectiveGlobalExcludes(repositoryRoot);
      let temporaryRoot: string;
      try {
        temporaryRoot = await mkdtemp(join(gitDirectory, "adam-agent-project-changes-"));
      } catch (error) {
        throw new GitProjectChangeCaptureError("repository_unavailable", { cause: error });
      }
      let capture: ProjectChangeRawCapture | undefined;
      let captureFailure: unknown;
      try {
        await chmod(temporaryRoot, 0o700);
        const hooksPath = join(temporaryRoot, "hooks");
        const objectDirectory = join(temporaryRoot, "objects");
        await mkdir(hooksPath, { mode: 0o700 });
        await mkdir(objectDirectory, { mode: 0o700 });
        const metadataDirectory = join(temporaryRoot, "git-metadata");
        await runGit(repositoryRoot, [
          "init",
          "--bare",
          "--quiet",
          `--object-format=${objectFormat}`,
          metadataDirectory,
        ]);
        const attributesPath = join(temporaryRoot, "attributes");
        await writeFile(attributesPath, new Uint8Array(), { mode: 0o600 });
        const excludesPath = join(temporaryRoot, "excludes");
        await writeFile(excludesPath, excludes ?? new Uint8Array(), { mode: 0o600 });
        const captureEnvironment = {
          GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjectDirectory,
          GIT_INDEX_FILE: join(temporaryRoot, "index"),
          GIT_OBJECT_DIRECTORY: objectDirectory,
        };
        const evidenceEnvironment = {
          ...captureEnvironment,
          GIT_DIR: metadataDirectory,
          GIT_WORK_TREE: repositoryRoot,
        };
        capture = await captureFromTemporaryIndex({
          attributesPath,
          captureEnvironment,
          excludesPath,
          evidenceEnvironment,
          hooksPath,
          objectFormat,
          observer,
          repositoryRoot,
        });
      } catch (error) {
        captureFailure =
          error instanceof GitProjectChangeCaptureError
            ? error
            : new GitProjectChangeCaptureError("git_command_failed", { cause: error });
      }
      let cleanupFailure: unknown;
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure = error;
      }
      if (cleanupFailure !== undefined) {
        throw new GitProjectChangeCaptureError("cleanup_failed", {
          cause:
            captureFailure === undefined
              ? cleanupFailure
              : new AggregateError([captureFailure, cleanupFailure]),
        });
      }
      if (captureFailure !== undefined) {
        throw captureFailure;
      }
      if (capture === undefined) {
        throw new GitProjectChangeCaptureError("capture_inconsistent");
      }
      return capture;
    },
  };
}

async function captureFromTemporaryIndex(options: {
  readonly attributesPath: string;
  readonly captureEnvironment: Readonly<Record<string, string>>;
  readonly excludesPath: string;
  readonly evidenceEnvironment: Readonly<Record<string, string>>;
  readonly hooksPath: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly observer: GitCaptureObserver;
  readonly repositoryRoot: string;
}): Promise<ProjectChangeRawCapture> {
  await preflightCandidate(options);
  const base = await readBase(
    options.repositoryRoot,
    options.objectFormat,
    options.captureEnvironment,
    options.hooksPath,
    options.attributesPath,
    options.excludesPath,
  );
  await runGit(
    options.repositoryRoot,
    withCaptureConfiguration(options, ["add", "-A", "--", "."]),
    {
      environment: options.captureEnvironment,
    },
  );
  const candidateTree = decodeLine(
    (
      await runGit(options.repositoryRoot, withCaptureConfiguration(options, ["write-tree"]), {
        environment: options.captureEnvironment,
      })
    ).stdout,
  );
  await options.observer.afterCandidateTree?.(candidateTree);
  if (candidateTree === base.tree) {
    return {
      base,
      candidateTree,
      entries: [],
      objectFormat: options.objectFormat,
      unifiedDiff: new Uint8Array(),
    };
  }
  const unifiedDiff = (
    await runGit(
      options.repositoryRoot,
      withCaptureConfiguration(options, [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "-p",
        "--binary",
        "--full-index",
        "--default-prefix",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--diff-algorithm=myers",
        "--find-renames=50%",
        `-l${EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE}`,
        base.tree,
        candidateTree,
      ]),
      {
        environment: {
          ...options.evidenceEnvironment,
          GIT_ATTR_SOURCE: candidateTree,
        },
        maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_DIFF_MAX_BYTES,
      },
    )
  ).stdout;
  const raw = (
    await runGit(
      options.repositoryRoot,
      withCaptureConfiguration(options, [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
        `-l${EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE}`,
        base.tree,
        candidateTree,
      ]),
      { environment: options.evidenceEnvironment, maximumStdoutBytes: 512 * 1024 },
    )
  ).stdout;
  return {
    base,
    candidateTree,
    entries: await materializeRawEntries({ ...options, candidateTree, raw }),
    objectFormat: options.objectFormat,
    unifiedDiff,
  };
}

async function canonicalRepositoryRoot(canonicalProjectRoot: string): Promise<string> {
  try {
    const expected = await realpath(canonicalProjectRoot);
    const reported = decodeLine((await runGit(expected, ["rev-parse", "--show-toplevel"])).stdout);
    if ((await realpath(reported)) !== expected) {
      throw new GitProjectChangeCaptureError("repository_state_unsupported");
    }
    return expected;
  } catch (error) {
    if (error instanceof GitProjectChangeCaptureError) {
      throw error;
    }
    throw new GitProjectChangeCaptureError("repository_unavailable", { cause: error });
  }
}

async function assertSupportedRepository(repositoryRoot: string): Promise<void> {
  const inside = decodeLine(
    (await runGit(repositoryRoot, ["rev-parse", "--is-inside-work-tree"])).stdout,
  );
  const bare = decodeLine(
    (await runGit(repositoryRoot, ["rev-parse", "--is-bare-repository"])).stdout,
  );
  const sparse = await runGit(repositoryRoot, ["config", "--bool", "core.sparseCheckout"], {
    allowedExitCodes: [0, 1],
  });
  const filters = await runGit(
    repositoryRoot,
    ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"],
    { allowedExitCodes: [0, 1], maximumStdoutBytes: 64 * 1024 },
  );
  const filesystemMonitor = await runGit(
    repositoryRoot,
    ["config", "--bool", "--get", "core.fsmonitor"],
    { allowedExitCodes: [0, 1, 128] },
  );
  const filesystemMonitorDisabled =
    filesystemMonitor.exitCode === 1 ||
    (filesystemMonitor.exitCode === 0 && decodeLine(filesystemMonitor.stdout) === "false");
  if (!filesystemMonitorDisabled) {
    throw new GitProjectChangeCaptureError("repository_state_unsupported");
  }
  const unmerged = await runGit(repositoryRoot, ["ls-files", "-u", "-z"], {
    maximumStdoutBytes: 512 * 1024,
  });
  if (
    inside !== "true" ||
    bare !== "false" ||
    decodeOptionalLine(sparse.stdout) === "true" ||
    filters.stdout.byteLength > 0 ||
    unmerged.stdout.byteLength > 0
  ) {
    throw new GitProjectChangeCaptureError("repository_state_unsupported");
  }
}

async function readObjectFormat(repositoryRoot: string): Promise<"sha1" | "sha256"> {
  const value = decodeLine(
    (await runGit(repositoryRoot, ["rev-parse", "--show-object-format"])).stdout,
  );
  if (value !== "sha1" && value !== "sha256") {
    throw new GitProjectChangeCaptureError("repository_state_unsupported");
  }
  return value;
}

async function readGitDirectory(repositoryRoot: string): Promise<string> {
  const value = decodeLine(
    (await runGit(repositoryRoot, ["rev-parse", "--absolute-git-dir"])).stdout,
  );
  try {
    return await realpath(value);
  } catch (error) {
    throw new GitProjectChangeCaptureError("repository_unavailable", { cause: error });
  }
}

async function readGitObjectDirectory(repositoryRoot: string): Promise<string> {
  const value = decodeUtf8Line(
    (await runGit(repositoryRoot, ["rev-parse", "--git-path", "objects"])).stdout,
  );
  try {
    return await realpath(isAbsolute(value) ? value : resolve(repositoryRoot, value));
  } catch (error) {
    throw new GitProjectChangeCaptureError("repository_unavailable", { cause: error });
  }
}

async function readEffectiveGlobalExcludes(repositoryRoot: string): Promise<Buffer | undefined> {
  const repositoryConfigured = await runGit(
    repositoryRoot,
    ["config", "--path", "--get", "core.excludesFile"],
    { allowedExitCodes: [0, 1] },
  );
  let path =
    repositoryConfigured.exitCode === 0
      ? decodeUtf8Line(repositoryConfigured.stdout)
      : await readUserGlobalExcludesPath(repositoryRoot);
  path ??= defaultUserExcludesPath();
  if (path === undefined) {
    return undefined;
  }
  const absolutePath = isAbsolute(path) ? path : resolve(repositoryRoot, path);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw new GitProjectChangeCaptureError("repository_state_unsupported", { cause: error });
  }
  try {
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile() || metadata.size > EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES) {
      throw new GitProjectChangeCaptureError("repository_state_unsupported");
    }
    const value = await readFile(canonicalPath);
    if (value.byteLength !== metadata.size) {
      throw new GitProjectChangeCaptureError("repository_state_unsupported");
    }
    return value;
  } catch (error) {
    if (error instanceof GitProjectChangeCaptureError) {
      throw error;
    }
    throw new GitProjectChangeCaptureError("repository_state_unsupported", { cause: error });
  }
}

async function readUserGlobalExcludesPath(repositoryRoot: string): Promise<string | undefined> {
  const configured = await runGit(
    repositoryRoot,
    ["config", "--global", "--path", "--get", "core.excludesFile"],
    { allowedExitCodes: [0, 1], useUserGlobalConfig: true },
  );
  return configured.exitCode === 0 ? decodeUtf8Line(configured.stdout) : undefined;
}

function defaultUserExcludesPath(): string | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const configurationRoot = process.env["XDG_CONFIG_HOME"];
  if (configurationRoot !== undefined && configurationRoot.length > 0) {
    return resolve(configurationRoot, "git", "ignore");
  }
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const home = process.env["HOME"];
  return home === undefined || home.length === 0 ? undefined : resolve(home, ".config/git/ignore");
}

async function preflightCandidate(options: {
  readonly attributesPath: string;
  readonly excludesPath: string;
  readonly hooksPath: string;
  readonly repositoryRoot: string;
}): Promise<void> {
  const head = await runGit(
    options.repositoryRoot,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    { allowedExitCodes: [0, 1] },
  );
  const configuredArguments = (arguments_: readonly string[]) =>
    withCaptureConfiguration(options, arguments_);
  const staged = await runGit(
    options.repositoryRoot,
    configuredArguments(
      head.exitCode === 0
        ? ["diff-index", "--name-only", "-z", decodeLine(head.stdout), "--"]
        : ["ls-files", "--cached", "-z"],
    ),
    { maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES * 2 },
  );
  const unstaged = await runGit(
    options.repositoryRoot,
    configuredArguments(["diff-files", "--name-only", "-z", "--"]),
    { maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES * 2 },
  );
  const untracked = await runGit(
    options.repositoryRoot,
    configuredArguments(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    { maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES * 2 },
  );
  const untrackedPaths = new Map(
    splitNul(untracked.stdout).map((path) => [path.toString("hex"), path]),
  );
  if (untrackedPaths.size > EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE) {
    throw new GitProjectChangeCaptureError("limit_exceeded");
  }
  const paths = new Map<string, Buffer>();
  for (const path of [
    ...splitNul(staged.stdout),
    ...splitNul(unstaged.stdout),
    ...splitNul(untracked.stdout),
  ]) {
    paths.set(path.toString("hex"), path);
  }
  if (paths.size > EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE * 2) {
    throw new GitProjectChangeCaptureError("limit_exceeded");
  }
  let pathBytes = 0;
  let sourceBytes = 0;
  const rootPrefix = Buffer.from(`${options.repositoryRoot}/`, "utf8");
  for (const path of paths.values()) {
    pathBytes += path.byteLength;
    if (
      path.byteLength === 0 ||
      path.byteLength > EXTENSION_PROJECT_CHANGE_PATH_MAX_BYTES ||
      pathBytes > EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES
    ) {
      throw new GitProjectChangeCaptureError("limit_exceeded");
    }
    try {
      const metadata = await lstat(Buffer.concat([rootPrefix, path]));
      if (metadata.isFile()) {
        sourceBytes += metadata.size;
        if (
          metadata.size > EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES ||
          sourceBytes > EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES
        ) {
          throw new GitProjectChangeCaptureError("limit_exceeded");
        }
      } else if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new GitProjectChangeCaptureError("repository_state_unsupported");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
}

async function readBase(
  repositoryRoot: string,
  objectFormat: "sha1" | "sha256",
  environment: Readonly<Record<string, string>>,
  hooksPath: string,
  attributesPath: string,
  excludesPath: string,
): Promise<ProjectChangeRawBase> {
  const head = await runGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowedExitCodes: [0, 1],
  });
  if (head.exitCode === 0) {
    const commit = decodeLine(head.stdout);
    const tree = decodeLine(
      (await runGit(repositoryRoot, ["rev-parse", `${commit}^{tree}`])).stdout,
    );
    await runGit(
      repositoryRoot,
      withCaptureConfiguration({ attributesPath, excludesPath, hooksPath }, ["read-tree", tree]),
      { environment },
    );
    return { commit, kind: "head", tree };
  }
  const symbolicHead = await runGit(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], {
    allowedExitCodes: [0, 1],
  });
  if (symbolicHead.exitCode !== 0) {
    throw new GitProjectChangeCaptureError("repository_state_unsupported");
  }
  await runGit(
    repositoryRoot,
    withCaptureConfiguration({ attributesPath, excludesPath, hooksPath }, ["read-tree", "--empty"]),
    { environment },
  );
  const tree = decodeLine(
    (
      await runGit(
        repositoryRoot,
        withCaptureConfiguration({ attributesPath, excludesPath, hooksPath }, ["write-tree"]),
        { environment },
      )
    ).stdout,
  );
  if (tree.length !== (objectFormat === "sha1" ? 40 : 64)) {
    throw new GitProjectChangeCaptureError("capture_inconsistent");
  }
  return { kind: "unborn", tree };
}

function withCaptureConfiguration(
  options: {
    readonly attributesPath: string;
    readonly excludesPath: string;
    readonly hooksPath: string;
  },
  arguments_: readonly string[],
): readonly string[] {
  return [
    "-c",
    `core.attributesFile=${options.attributesPath}`,
    "-c",
    `core.excludesFile=${options.excludesPath}`,
    "-c",
    `core.hooksPath=${options.hooksPath}`,
    ...arguments_,
  ];
}

async function materializeRawEntries(options: {
  readonly attributesPath: string;
  readonly candidateTree: string;
  readonly captureEnvironment: Readonly<Record<string, string>>;
  readonly evidenceEnvironment: Readonly<Record<string, string>>;
  readonly excludesPath: string;
  readonly hooksPath: string;
  readonly raw: Buffer;
  readonly repositoryRoot: string;
}): Promise<readonly ProjectChangeCapturedEntry[]> {
  const records = parseRawDiff(options.raw);
  if (records.length > EXTENSION_PROJECT_CHANGE_MAX_ENTRIES_PER_SIDE) {
    throw new GitProjectChangeCaptureError("limit_exceeded");
  }
  const binaryPaths = await readAttributeBinaryPaths(options, records);
  const contentCache = new Map<string, Uint8Array>();
  const budget = { sourceBytes: 0 };
  const entries: ProjectChangeCapturedEntry[] = [];
  for (const record of records) {
    if (record.oldMode !== "000000") {
      entries.push(
        await readEntry(
          options.repositoryRoot,
          record.oldMode,
          record.oldObjectId,
          record.oldPath,
          "base",
          contentCache,
          options.evidenceEnvironment,
          budget,
          binaryPaths.has(record.oldPath.toString("hex")),
        ),
      );
    }
    if (record.newMode !== "000000") {
      entries.push(
        await readEntry(
          options.repositoryRoot,
          record.newMode,
          record.newObjectId,
          record.newPath,
          "head",
          contentCache,
          options.evidenceEnvironment,
          budget,
          binaryPaths.has(record.newPath.toString("hex")),
        ),
      );
    }
  }
  return entries;
}

async function readAttributeBinaryPaths(
  options: {
    readonly attributesPath: string;
    readonly candidateTree: string;
    readonly captureEnvironment: Readonly<Record<string, string>>;
    readonly evidenceEnvironment: Readonly<Record<string, string>>;
    readonly excludesPath: string;
    readonly hooksPath: string;
    readonly repositoryRoot: string;
  },
  records: readonly RawDiffRecord[],
): Promise<ReadonlySet<string>> {
  const paths = new Map<string, Buffer>();
  for (const record of records) {
    paths.set(record.oldPath.toString("hex"), record.oldPath);
    paths.set(record.newPath.toString("hex"), record.newPath);
  }
  const input = Buffer.concat([...paths.values()].flatMap((path) => [path, Buffer.of(0)]));
  const output = (
    await runGit(
      options.repositoryRoot,
      withCaptureConfiguration(options, [
        "check-attr",
        "-z",
        `--source=${options.candidateTree}`,
        "--stdin",
        "diff",
      ]),
      {
        environment: options.evidenceEnvironment,
        input,
        maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_PATHS_MAX_BYTES * 3,
      },
    )
  ).stdout;
  const fields = splitNul(output);
  if (fields.length !== paths.size * 3) {
    throw new GitProjectChangeCaptureError("capture_inconsistent");
  }
  const binaryPaths = new Set<string>();
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (
      path === undefined ||
      attribute === undefined ||
      value === undefined ||
      decodeAscii(attribute) !== "diff"
    ) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    if (decodeAscii(value) === "unset") {
      binaryPaths.add(path.toString("hex"));
    }
  }
  return binaryPaths;
}

type RawDiffRecord = {
  readonly newMode: string;
  readonly newObjectId: string;
  readonly newPath: Buffer;
  readonly oldMode: string;
  readonly oldObjectId: string;
  readonly oldPath: Buffer;
};

function parseRawDiff(raw: Buffer): readonly RawDiffRecord[] {
  const fields = splitNul(raw);
  const records: RawDiffRecord[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index];
    const path = fields[index + 1];
    if (header === undefined || path === undefined) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])([0-9]{0,3})$/u.exec(
      decodeAscii(header),
    );
    if (match === null) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    const status = match[5];
    const renamedPath = status === "R" || status === "C" ? fields[index + 2] : undefined;
    if ((status === "R" || status === "C") && renamedPath === undefined) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    records.push({
      newMode: match[2] as string,
      newObjectId: match[4] as string,
      newPath: renamedPath ?? path,
      oldMode: match[1] as string,
      oldObjectId: match[3] as string,
      oldPath: path,
    });
    index += renamedPath === undefined ? 2 : 3;
  }
  return records;
}

async function readEntry(
  repositoryRoot: string,
  mode: string,
  objectId: string,
  path: Buffer,
  side: "base" | "head",
  contentCache: Map<string, Uint8Array>,
  environment: Readonly<Record<string, string>>,
  budget: { sourceBytes: number },
  binary: boolean,
): Promise<ProjectChangeCapturedEntry> {
  if (mode === "120000" || mode === "160000") {
    return { mode, path, side };
  }
  if (mode !== "100644" && mode !== "100755") {
    return { mode, path, side };
  }
  if (binary) {
    return { binary: true, mode, path, side };
  }
  let content = contentCache.get(objectId);
  if (content === undefined) {
    const type = decodeLine(
      (await runGit(repositoryRoot, ["cat-file", "-t", objectId], { environment })).stdout,
    );
    const sizeText = decodeLine(
      (await runGit(repositoryRoot, ["cat-file", "-s", objectId], { environment })).stdout,
    );
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    if (size > EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES) {
      throw new GitProjectChangeCaptureError("limit_exceeded");
    }
    budget.sourceBytes += size;
    if (budget.sourceBytes > EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES) {
      throw new GitProjectChangeCaptureError("limit_exceeded");
    }
    content = (
      await runGit(repositoryRoot, ["cat-file", "blob", objectId], {
        environment,
        maximumStdoutBytes: EXTENSION_PROJECT_CHANGE_ENTRY_MAX_BYTES,
      })
    ).stdout;
    if (content.byteLength !== size) {
      throw new GitProjectChangeCaptureError("capture_inconsistent");
    }
    contentCache.set(objectId, content);
  } else {
    budget.sourceBytes += content.byteLength;
    if (budget.sourceBytes > EXTENSION_PROJECT_CHANGE_SOURCES_MAX_BYTES) {
      throw new GitProjectChangeCaptureError("limit_exceeded");
    }
  }
  return { content, mode, path, side };
}

type GitCommandResult = {
  readonly exitCode: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
};

async function runGit(
  cwd: string,
  arguments_: readonly string[],
  options: {
    readonly allowedExitCodes?: readonly number[];
    readonly environment?: Readonly<Record<string, string>>;
    readonly input?: Uint8Array;
    readonly maximumStdoutBytes?: number;
    readonly useUserGlobalConfig?: boolean;
  } = {},
): Promise<GitCommandResult> {
  const maximumStdoutBytes = options.maximumStdoutBytes ?? 128 * 1024;
  const maximumStderrBytes = 64 * 1024;
  return new Promise((resolvePromise, rejectPromise) => {
    const userConfigurationEnvironment =
      options.useUserGlobalConfig === true ? createUserConfigurationEnvironment() : {};
    const child = spawn("git", arguments_, {
      cwd,
      detached: true,
      env: {
        ...(options.useUserGlobalConfig === true ? {} : { GIT_CONFIG_GLOBAL: "/dev/null" }),
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        LANG: "C",
        LC_ALL: "C",
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        ...userConfigurationEnvironment,
        ...options.environment,
      },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: GitProjectChangeCaptureError | undefined;
    const fail = (error: GitProjectChangeCaptureError) => {
      failure ??= error;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(
      () => fail(new GitProjectChangeCaptureError("git_command_failed")),
      30_000,
    );
    timeout.unref();
    if (options.input !== undefined) {
      child.stdin?.once("error", (error) =>
        fail(new GitProjectChangeCaptureError("git_command_failed", { cause: error })),
      );
      child.stdin?.end(options.input);
    }
    child.once("error", (error) =>
      fail(new GitProjectChangeCaptureError("git_command_failed", { cause: error })),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumStdoutBytes) {
        fail(new GitProjectChangeCaptureError("limit_exceeded"));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumStderrBytes) {
        fail(new GitProjectChangeCaptureError("git_command_failed"));
      } else {
        stderr.push(chunk);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure !== undefined) {
        rejectPromise(failure);
        return;
      }
      const exitCode = code ?? -1;
      if (!(options.allowedExitCodes ?? [0]).includes(exitCode)) {
        rejectPromise(new GitProjectChangeCaptureError("git_command_failed"));
        return;
      }
      resolvePromise({
        exitCode,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
  });
}

function createUserConfigurationEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const globalConfiguration = process.env["GIT_CONFIG_GLOBAL"];
  if (globalConfiguration !== undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed record access.
    environment["GIT_CONFIG_GLOBAL"] = globalConfiguration;
  }
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const home = process.env["HOME"];
  if (home !== undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed record access.
    environment["HOME"] = home;
  }
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed ProcessEnv access.
  const configurationRoot = process.env["XDG_CONFIG_HOME"];
  if (configurationRoot !== undefined) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires indexed record access.
    environment["XDG_CONFIG_HOME"] = configurationRoot;
  }
  return environment;
}

function decodeAscii(value: Uint8Array): string {
  if (value.some((byte) => byte > 0x7f)) {
    throw new GitProjectChangeCaptureError("capture_inconsistent");
  }
  return Buffer.from(value).toString("ascii");
}

function decodeLine(value: Uint8Array): string {
  const line = decodeAscii(value).trimEnd();
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new GitProjectChangeCaptureError("capture_inconsistent");
  }
  return line;
}

function decodeUtf8Line(value: Uint8Array): string {
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(value).trimEnd();
  } catch (error) {
    throw new GitProjectChangeCaptureError("repository_state_unsupported", { cause: error });
  }
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new GitProjectChangeCaptureError("repository_state_unsupported");
  }
  return line;
}

function decodeOptionalLine(value: Uint8Array): string {
  return value.byteLength === 0 ? "" : decodeLine(value);
}

function splitNul(value: Buffer): readonly Buffer[] {
  if (value.byteLength === 0) {
    return [];
  }
  if (value.at(-1) !== 0) {
    throw new GitProjectChangeCaptureError("capture_inconsistent");
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === 0) {
      fields.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  return fields;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function gitCaptureErrorMessage(code: GitProjectChangeCaptureError["code"]): string {
  switch (code) {
    case "capture_inconsistent":
      return "Git returned inconsistent project-change evidence.";
    case "cleanup_failed":
      return "The temporary Git capture resources could not be cleaned up.";
    case "git_command_failed":
      return "A Git project-change capture command failed.";
    case "limit_exceeded":
      return "The Git project-change capture exceeded its limit.";
    case "repository_state_unsupported":
      return "The Git repository state is unsupported for project-change capture.";
    case "repository_unavailable":
      return "The canonical Git repository is unavailable.";
  }
}
