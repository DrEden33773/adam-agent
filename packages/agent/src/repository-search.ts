import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";

import type { ToolAdapter } from "./tool-runtime.js";

const searchPolicyVersion = "search-repository.v1" as const;
const maximumPageBytes = 16 * 1024;
const maximumContentResults = 50;
const defaultContentResults = 20;
const defaultPathResults = 30;
const maximumMatchesPerFilePerPage = 5;
const maximumSnippetCharacters = 500;
const binaryProbeBytes = 8 * 1_024;
const maximumSnapshots = 8;
const maximumAggregateSnapshotBytes = 16 * 1024 * 1024;
const maximumSnapshotBytes = 4 * 1024 * 1024;
const maximumSnapshotResults = 4_096;
const maximumRankedCandidates = 16_384;
const maximumRawParsedBytes = 64 * 1_024 * 1_024;
const maximumRawRecords = 100_000;
const maximumWorkRecords = 200_000;
const snapshotIdleMilliseconds = 10 * 60 * 1_000;
const searchProcessTerminationGraceMilliseconds = 100;
const searchGlobSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0") && !value.startsWith("!"));

const searchRepositoryInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("content"),
    query: z.string().min(1).max(4_096),
    mode: z.enum(["literal", "regex"]).optional(),
    case: z.enum(["smart", "sensitive", "insensitive"]).optional(),
    include: z.array(searchGlobSchema).max(16).optional(),
    exclude: z.array(searchGlobSchema).max(16).optional(),
    context: z.number().int().min(0).max(3).optional(),
    path: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(maximumContentResults).optional(),
    cursor: z.string().min(1).max(1_024).optional(),
  }),
  z.strictObject({
    kind: z.literal("path"),
    query: z.string().min(1).max(4_096),
    mode: z.enum(["fuzzy", "glob"]).optional(),
    path: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(maximumContentResults).optional(),
    cursor: z.string().min(1).max(1_024).optional(),
  }),
]);

const contextLineSchema = z.strictObject({
  line: z.number().int().positive(),
  snippet: z.string().max(maximumSnippetCharacters),
});
const contentMatchSchema = z.strictObject({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  snippet: z.string().max(maximumSnippetCharacters),
  rankReason: z.enum(["literal", "regex"]),
  contextBefore: z.array(contextLineSchema).max(3),
  contextAfter: z.array(contextLineSchema).max(3),
});
const contentGroupSchema = z.strictObject({
  path: z.string(),
  matches: z.array(contentMatchSchema).max(maximumMatchesPerFilePerPage),
});
const pathEntrySchema = z.strictObject({
  path: z.string(),
  rankReason: z.enum([
    "exact_basename",
    "prefix_basename",
    "literal_substring",
    "all_tokens",
    "fuzzy_subsequence",
    "glob",
  ]),
});
const omissionSchema = z.strictObject({
  reason: z.enum([
    "page_limit",
    "page_byte_limit",
    "per_file_page_limit",
    "snapshot_result_limit",
    "ranked_candidate_limit",
    "binary",
    "non_ordinary",
    "unreadable",
    "changed",
  ]),
  path: z.string(),
  count: z.number().int().positive(),
});
const contentSearchOutputShape = {
  schemaVersion: z.literal(1),
  policyVersion: z.literal(searchPolicyVersion),
  kind: z.literal("content"),
  mode: z.enum(["literal", "regex"]),
  case: z.enum(["smart", "sensitive", "insensitive"]),
  context: z.number().int().min(0).max(3),
  query: z.string(),
  path: z.string(),
  resultCount: z.number().int().nonnegative().max(maximumContentResults),
  snapshotResultCount: z.number().int().nonnegative().max(maximumSnapshotResults),
  pageIndex: z.number().int().nonnegative(),
  remainingResultCount: z.number().int().nonnegative().max(maximumSnapshotResults),
  currentContentMustBeReread: z.literal(true),
  groups: z.array(contentGroupSchema),
  omissions: z.array(omissionSchema),
} as const;
const pathSearchOutputShape = {
  schemaVersion: z.literal(1),
  policyVersion: z.literal(searchPolicyVersion),
  kind: z.literal("path"),
  mode: z.enum(["fuzzy", "glob"]),
  query: z.string(),
  path: z.string(),
  resultCount: z.number().int().nonnegative().max(maximumContentResults),
  snapshotResultCount: z.number().int().nonnegative().max(maximumSnapshotResults),
  pageIndex: z.number().int().nonnegative(),
  remainingResultCount: z.number().int().nonnegative().max(maximumSnapshotResults),
  currentContentMustBeReread: z.literal(true),
  entries: z.array(pathEntrySchema),
  omissions: z.array(omissionSchema),
} as const;
const repositorySearchOutputSchema = z.union([
  z.strictObject(contentSearchOutputShape),
  z.strictObject({ ...contentSearchOutputShape, nextCursor: z.string().max(1_024) }),
  z.strictObject(pathSearchOutputShape),
  z.strictObject({ ...pathSearchOutputShape, nextCursor: z.string().max(1_024) }),
]);

type ContentMatch = z.infer<typeof contentMatchSchema>;
type RankedContentMatch = ContentMatch & { readonly path: string };
type ContentPage = {
  readonly matches: readonly RankedContentMatch[];
  readonly omissions: readonly z.infer<typeof omissionSchema>[];
};
type PathEntry = z.infer<typeof pathEntrySchema>;
type PathPage = {
  readonly entries: readonly PathEntry[];
  readonly omissions: readonly z.infer<typeof omissionSchema>[];
};
type SearchSnapshotBase = {
  readonly id: string;
  readonly sessionId: string;
  readonly toolProfileDigest: string;
  readonly requestKey: string;
  readonly query: string;
  readonly path: string;
  readonly resultCount: number;
  readonly byteCount: number;
  lastAccessedAt: number;
  lastAccessOrder: number;
};
type ContentSearchSnapshot = SearchSnapshotBase & {
  readonly kind: "content";
  readonly mode: "literal" | "regex";
  readonly case: "smart" | "sensitive" | "insensitive";
  readonly context: number;
  readonly pages: readonly ContentPage[];
};
type PathSearchSnapshot = SearchSnapshotBase & {
  readonly kind: "path";
  readonly mode: "fuzzy" | "glob";
  readonly pages: readonly PathPage[];
};
type SearchSnapshot = ContentSearchSnapshot | PathSearchSnapshot;

class BoundedBestCandidates<T> {
  readonly #values: T[] = [];

  constructor(
    readonly limit: number,
    readonly compare: (left: T, right: T) => number,
  ) {}

  add(value: T) {
    if (this.#values.length < this.limit) {
      this.#values.push(value);
      this.#bubbleUp(this.#values.length - 1);
      return;
    }
    const worst = this.#values[0];
    if (worst === undefined || this.compare(value, worst) >= 0) {
      return;
    }
    this.#values[0] = value;
    this.#bubbleDown(0);
  }

  sorted(): readonly T[] {
    return [...this.#values].sort(this.compare);
  }

  #bubbleUp(start: number) {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const value = this.#values[index];
      const parentValue = this.#values[parent];
      if (
        value === undefined ||
        parentValue === undefined ||
        this.compare(value, parentValue) <= 0
      ) {
        return;
      }
      this.#values[index] = parentValue;
      this.#values[parent] = value;
      index = parent;
    }
  }

  #bubbleDown(start: number) {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (
        left < this.#values.length &&
        this.compare(this.#values[left] as T, this.#values[worst] as T) > 0
      ) {
        worst = left;
      }
      if (
        right < this.#values.length &&
        this.compare(this.#values[right] as T, this.#values[worst] as T) > 0
      ) {
        worst = right;
      }
      if (worst === index) {
        return;
      }
      const value = this.#values[index] as T;
      this.#values[index] = this.#values[worst] as T;
      this.#values[worst] = value;
      index = worst;
    }
  }
}

class SearchCursorError extends Error {
  constructor(
    readonly code: "search_cursor_invalid" | "search_cursor_stale" | "search_quota_exceeded",
    message: string,
  ) {
    super(message);
  }
}

class SearchRequestBudget {
  #rawBytes = 0;
  #workRecords = 0;

  consumeRawBytes(byteCount: number) {
    this.#rawBytes += byteCount;
    if (this.#rawBytes > maximumRawParsedBytes) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "Repository search exceeded the aggregate raw parsed byte limit.",
      );
    }
  }

  consumeWorkRecord() {
    this.#workRecords += 1;
    if (this.#workRecords > maximumWorkRecords) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "Repository search exceeded the aggregate parser work limit.",
      );
    }
  }
}

class SearchSnapshotRegistry {
  readonly #snapshots = new Map<string, SearchSnapshot>();
  #aggregateBytes = 0;
  #accessSequence = 0;

  createContent(input: {
    readonly sessionId: string;
    readonly toolProfileDigest: string;
    readonly requestKey: string;
    readonly query: string;
    readonly path: string;
    readonly mode: "literal" | "regex";
    readonly case: "smart" | "sensitive" | "insensitive";
    readonly context: number;
    readonly matches: readonly RankedContentMatch[];
    readonly omissions: readonly z.infer<typeof omissionSchema>[];
    readonly limit: number;
  }) {
    const boundedMatches = input.matches.slice(0, maximumSnapshotResults);
    const pages = createContentPages(
      boundedMatches,
      input.limit,
      input.matches.length,
      input.omissions,
    );
    const byteCount = Buffer.byteLength(JSON.stringify(pages), "utf8");
    if (byteCount > maximumSnapshotBytes) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "The normalized repository search snapshot exceeded its byte limit.",
      );
    }
    const now = Date.now();
    this.#pruneExpired(now);
    const snapshot: SearchSnapshot = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolProfileDigest: input.toolProfileDigest,
      requestKey: input.requestKey,
      kind: "content",
      query: input.query,
      path: input.path,
      mode: input.mode,
      case: input.case,
      context: input.context,
      pages,
      resultCount: boundedMatches.length,
      byteCount,
      lastAccessedAt: now,
      lastAccessOrder: ++this.#accessSequence,
    };
    return this.#admit(snapshot);
  }

  createPath(input: {
    readonly sessionId: string;
    readonly toolProfileDigest: string;
    readonly requestKey: string;
    readonly query: string;
    readonly path: string;
    readonly mode: "fuzzy" | "glob";
    readonly entries: readonly PathEntry[];
    readonly omissions: readonly z.infer<typeof omissionSchema>[];
    readonly limit: number;
  }) {
    const boundedEntries = input.entries.slice(0, maximumSnapshotResults);
    const pages = createPathPages(
      boundedEntries,
      input.limit,
      input.entries.length,
      input.omissions,
    );
    const byteCount = Buffer.byteLength(JSON.stringify(pages), "utf8");
    if (byteCount > maximumSnapshotBytes) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "The normalized repository search snapshot exceeded its byte limit.",
      );
    }
    const now = Date.now();
    this.#pruneExpired(now);
    const snapshot: PathSearchSnapshot = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolProfileDigest: input.toolProfileDigest,
      requestKey: input.requestKey,
      kind: "path",
      query: input.query,
      path: input.path,
      mode: input.mode,
      pages,
      resultCount: boundedEntries.length,
      byteCount,
      lastAccessedAt: now,
      lastAccessOrder: ++this.#accessSequence,
    };
    return this.#admit(snapshot);
  }

  page(input: {
    readonly cursor: string;
    readonly sessionId: string;
    readonly toolProfileDigest: string;
    readonly requestKey: string;
  }) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === undefined) {
      throw new SearchCursorError(
        "search_cursor_invalid",
        "The repository search cursor is malformed.",
      );
    }
    const now = Date.now();
    this.#pruneExpired(now);
    const snapshot = this.#snapshots.get(decoded.snapshotId);
    if (snapshot === undefined) {
      throw new SearchCursorError(
        "search_cursor_stale",
        "The repository search snapshot is no longer available; start a new search.",
      );
    }
    if (
      snapshot.sessionId !== input.sessionId ||
      snapshot.toolProfileDigest !== input.toolProfileDigest ||
      snapshot.requestKey !== input.requestKey
    ) {
      throw new SearchCursorError(
        "search_cursor_invalid",
        "The repository search cursor does not match this session, Tool Profile, or request.",
      );
    }
    if (decoded.pageIndex <= 0 || decoded.pageIndex >= snapshot.pages.length) {
      throw new SearchCursorError(
        "search_cursor_invalid",
        "The repository search cursor page is invalid.",
      );
    }
    snapshot.lastAccessedAt = now;
    snapshot.lastAccessOrder = ++this.#accessSequence;
    return this.#output(snapshot, decoded.pageIndex);
  }

  #output(snapshot: SearchSnapshot, pageIndex: number) {
    const nextPageIndex = pageIndex + 1;
    if (snapshot.kind === "path") {
      const page = snapshot.pages[pageIndex] ?? { entries: [], omissions: [] };
      const consumed = snapshot.pages
        .slice(0, nextPageIndex)
        .reduce((total, candidate) => total + candidate.entries.length, 0);
      return {
        schemaVersion: 1 as const,
        policyVersion: searchPolicyVersion,
        kind: "path" as const,
        mode: snapshot.mode,
        query: snapshot.query,
        path: snapshot.path,
        resultCount: page.entries.length,
        snapshotResultCount: snapshot.resultCount,
        pageIndex,
        remainingResultCount: snapshot.resultCount - consumed,
        ...(nextPageIndex < snapshot.pages.length
          ? { nextCursor: encodeCursor(snapshot.id, nextPageIndex) }
          : {}),
        currentContentMustBeReread: true as const,
        entries: page.entries,
        omissions: page.omissions,
      };
    }
    const page = snapshot.pages[pageIndex] ?? { matches: [], omissions: [] };
    const consumed = snapshot.pages
      .slice(0, nextPageIndex)
      .reduce((total, candidate) => total + candidate.matches.length, 0);
    const groups = new Map<string, ContentMatch[]>();
    for (const { path, ...match } of page.matches) {
      const grouped = groups.get(path) ?? [];
      grouped.push(match);
      groups.set(path, grouped);
    }
    return {
      schemaVersion: 1 as const,
      policyVersion: searchPolicyVersion,
      kind: "content" as const,
      mode: snapshot.mode,
      case: snapshot.case,
      context: snapshot.context,
      query: snapshot.query,
      path: snapshot.path,
      resultCount: page.matches.length,
      snapshotResultCount: snapshot.resultCount,
      pageIndex,
      remainingResultCount: snapshot.resultCount - consumed,
      ...(nextPageIndex < snapshot.pages.length
        ? { nextCursor: encodeCursor(snapshot.id, nextPageIndex) }
        : {}),
      currentContentMustBeReread: true as const,
      groups: [...groups].map(([path, matches]) => ({ path, matches })),
      omissions: page.omissions,
    };
  }

  #admit(snapshot: SearchSnapshot) {
    while (
      this.#snapshots.size >= maximumSnapshots ||
      this.#aggregateBytes + snapshot.byteCount > maximumAggregateSnapshotBytes
    ) {
      if (!this.#evictLeastRecentlyUsed()) {
        break;
      }
    }
    if (this.#aggregateBytes + snapshot.byteCount > maximumAggregateSnapshotBytes) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "The repository search snapshot registry is full.",
      );
    }
    for (let pageIndex = 0; pageIndex < snapshot.pages.length; pageIndex += 1) {
      if (
        Buffer.byteLength(JSON.stringify(this.#output(snapshot, pageIndex)), "utf8") >
        maximumPageBytes
      ) {
        throw new SearchCursorError(
          "search_quota_exceeded",
          "The repository search page metadata exceeded its UTF-8 byte limit.",
        );
      }
    }
    this.#snapshots.set(snapshot.id, snapshot);
    this.#aggregateBytes += snapshot.byteCount;
    return this.#output(snapshot, 0);
  }

  #pruneExpired(now: number) {
    for (const snapshot of this.#snapshots.values()) {
      if (now - snapshot.lastAccessedAt >= snapshotIdleMilliseconds) {
        this.#delete(snapshot.id);
      }
    }
  }

  #evictLeastRecentlyUsed(): boolean {
    const oldest = [...this.#snapshots.values()].sort(
      (left, right) =>
        left.lastAccessOrder - right.lastAccessOrder ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )[0];
    if (oldest === undefined) {
      return false;
    }
    this.#delete(oldest.id);
    return true;
  }

  #delete(snapshotId: string) {
    const snapshot = this.#snapshots.get(snapshotId);
    if (snapshot === undefined) {
      return;
    }
    this.#snapshots.delete(snapshotId);
    this.#aggregateBytes -= snapshot.byteCount;
  }
}

export function createRepositorySearchToolAdapter(options: {
  readonly workspaceRoot: string;
  readonly processObserver?: RepositorySearchProcessObserver;
  readonly rgPathOverrideForTesting?: string;
  readonly backendForTesting?: RepositorySearchBackend;
}): Omit<ToolAdapter, "definitionDigest" | "replay"> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const snapshots = new SearchSnapshotRegistry();
  const backend =
    options.backendForTesting ??
    createProcessRepositorySearchBackend({
      rgExecutablePath: options.rgPathOverrideForTesting ?? rgPath,
      ...(options.processObserver === undefined
        ? {}
        : { processObserver: options.processObserver }),
    });
  return {
    definition: {
      name: "search_repository",
      description:
        "Search repository content or paths with search-repository.v1. Results use ignore/hidden/symlink and 8 KiB binary rules, deterministic relevance plus same-tier Git ranking, at most 50 results per 16 KiB page, and runtime-local immutable cursors bounded to 8 live snapshots, 16 MiB aggregate, 4,096 results and 4 MiB each, 16,384 ranked candidates, 64 MiB raw bytes, 100,000 raw records, 200,000 work records, and 10 minutes idle. Results are discovery evidence; reread current content with read_file before relying on it.",
      inputSchema: z.toJSONSchema(searchRepositoryInputSchema),
    },
    outputSchema: repositorySearchOutputSchema,
    effect: "read",
    cancellation: "abort_signal",
    maximumResult: { maximumBytes: maximumPageBytes },
    prepare(argumentsJson) {
      const parsedArguments = searchRepositoryInputSchema.safeParse(parseJson(argumentsJson));
      if (!parsedArguments.success) {
        return invalidInput();
      }
      const requestedPath = parsedArguments.data.path ?? ".";
      if (isAbsolute(requestedPath)) {
        return outsideWorkspace();
      }
      let canonicalWorkspaceRoot: string;
      try {
        canonicalWorkspaceRoot = realpathSync(workspaceRoot);
      } catch {
        return {
          status: "failed",
          error: {
            code: "tool_io_failed",
            message: "The canonical workspace root is unavailable.",
          },
        };
      }
      const absolutePath = resolve(canonicalWorkspaceRoot, requestedPath);
      if (
        absolutePath !== canonicalWorkspaceRoot &&
        !absolutePath.startsWith(`${canonicalWorkspaceRoot}${sep}`)
      ) {
        return outsideWorkspace();
      }
      const normalizedPath =
        relative(canonicalWorkspaceRoot, absolutePath).split(sep).join("/") || ".";
      if (hasHiddenPathComponent(normalizedPath)) {
        return outsideWorkspace();
      }
      let instructionScopePath = ".";
      try {
        const requestedStat = lstatSync(absolutePath);
        if (
          requestedStat.isSymbolicLink() ||
          (!requestedStat.isDirectory() && !requestedStat.isFile()) ||
          realpathSync(absolutePath) !== absolutePath
        ) {
          return outsideWorkspace();
        }
        instructionScopePath = requestedStat.isDirectory()
          ? normalizedPath === "."
            ? "."
            : `${normalizedPath}/.`
          : normalizedPath;
      } catch {
        // An absent explicit path activates only the already eager root scope.
      }
      return {
        status: "ready",
        permissionSubject: { type: "workspace_path", path: instructionScopePath },
        async execute(context) {
          context.signal.throwIfAborted();
          try {
            const requestKey = JSON.stringify({
              kind: parsedArguments.data.kind,
              query: parsedArguments.data.query,
              mode:
                parsedArguments.data.mode ??
                (parsedArguments.data.kind === "content" ? "literal" : "fuzzy"),
              ...(parsedArguments.data.kind === "content"
                ? {
                    case: parsedArguments.data.case ?? "smart",
                    include: parsedArguments.data.include ?? [],
                    exclude: parsedArguments.data.exclude ?? [],
                    context: parsedArguments.data.context ?? 0,
                  }
                : {}),
              path: normalizedPath,
              limit:
                parsedArguments.data.limit ??
                (parsedArguments.data.kind === "content"
                  ? defaultContentResults
                  : defaultPathResults),
            });
            if (parsedArguments.data.kind === "path") {
              if (parsedArguments.data.cursor !== undefined) {
                return {
                  status: "completed",
                  output: snapshots.page({
                    cursor: parsedArguments.data.cursor,
                    sessionId: context.sessionId,
                    toolProfileDigest: context.toolProfileDigest,
                    requestKey,
                  }),
                };
              }
              const budget = new SearchRequestBudget();
              const mode = parsedArguments.data.mode ?? "fuzzy";
              const searchResult = await runPathSearch({
                workspaceRoot: canonicalWorkspaceRoot,
                path: normalizedPath,
                query: parsedArguments.data.query,
                mode,
                signal: context.signal,
                budget,
                backend,
              });
              const limit = parsedArguments.data.limit ?? defaultPathResults;
              return {
                status: "completed",
                output: snapshots.createPath({
                  sessionId: context.sessionId,
                  toolProfileDigest: context.toolProfileDigest,
                  requestKey,
                  query: parsedArguments.data.query,
                  path: normalizedPath,
                  mode,
                  entries: searchResult.entries,
                  omissions: searchResult.omissions,
                  limit,
                }),
              };
            }
            const budget = new SearchRequestBudget();
            if (parsedArguments.data.cursor !== undefined) {
              return {
                status: "completed",
                output: snapshots.page({
                  cursor: parsedArguments.data.cursor,
                  sessionId: context.sessionId,
                  toolProfileDigest: context.toolProfileDigest,
                  requestKey,
                }),
              };
            }
            const searchResult = await runContentSearch({
              workspaceRoot: canonicalWorkspaceRoot,
              path: normalizedPath,
              query: parsedArguments.data.query,
              mode: parsedArguments.data.mode ?? "literal",
              case: parsedArguments.data.case ?? "smart",
              include: parsedArguments.data.include ?? [],
              exclude: parsedArguments.data.exclude ?? [],
              context: parsedArguments.data.context ?? 0,
              signal: context.signal,
              budget,
              backend,
            });
            context.signal.throwIfAborted();
            return {
              status: "completed",
              output: snapshots.createContent({
                sessionId: context.sessionId,
                toolProfileDigest: context.toolProfileDigest,
                requestKey,
                matches: searchResult.matches,
                omissions: searchResult.omissions,
                path: normalizedPath,
                query: parsedArguments.data.query,
                mode: parsedArguments.data.mode ?? "literal",
                case: parsedArguments.data.case ?? "smart",
                context: parsedArguments.data.context ?? 0,
                limit: parsedArguments.data.limit ?? defaultContentResults,
              }),
            };
          } catch (error) {
            if (context.signal.aborted) {
              throw context.signal.reason;
            }
            return error instanceof SearchCursorError
              ? {
                  status: "failed",
                  error: { code: error.code, message: error.message },
                }
              : {
                  status: "failed",
                  error: {
                    code: "tool_io_failed",
                    message: error instanceof Error ? error.message : "Repository search failed.",
                  },
                };
          }
        },
      };
    },
  };
}

export type RepositorySearchProcessObserver = {
  spawned(): void;
  recorded?(): void;
  signalled?(signal: NodeJS.Signals): void;
  closed(): void;
};

export type RepositorySearchBackend = {
  readChangedPaths(input: {
    readonly workspaceRoot: string;
    readonly path: string;
    readonly signal: AbortSignal;
    readonly budget: RepositorySearchBackendBudget;
  }): Promise<ReadonlySet<string>>;
  runRecords(input: {
    readonly args: readonly string[];
    readonly workspaceRoot: string;
    readonly signal: AbortSignal;
    readonly separator: "\n" | "\0";
    readonly budget: RepositorySearchBackendBudget;
    accept(record: string): void;
  }): Promise<void>;
};

export type RepositorySearchBackendBudget = {
  consumeRawBytes(byteCount: number): void;
  consumeWorkRecord(): void;
};

function createProcessRepositorySearchBackend(options: {
  readonly rgExecutablePath: string;
  readonly processObserver?: RepositorySearchProcessObserver;
}): RepositorySearchBackend {
  return {
    readChangedPaths(input) {
      return readGitChangedPaths(input.workspaceRoot, input.path, input.signal, input.budget);
    },
    runRecords(input) {
      return runRipgrepRecords({
        ...input,
        executablePath: options.rgExecutablePath,
        ...(options.processObserver === undefined
          ? {}
          : { processObserver: options.processObserver }),
      });
    },
  };
}

function outsideWorkspace() {
  return {
    status: "failed" as const,
    error: {
      code: "outside_workspace" as const,
      message: "The requested path is outside the canonical workspace or crosses a symlink.",
    },
  };
}

function hasHiddenPathComponent(path: string): boolean {
  return path !== "." && path.split("/").some((component) => component.startsWith("."));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function invalidInput() {
  return {
    status: "failed" as const,
    error: {
      code: "invalid_tool_input" as const,
      message: "The tool input did not match its schema.",
    },
  };
}

async function runContentSearch(options: {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly query: string;
  readonly mode: "literal" | "regex";
  readonly case: "smart" | "sensitive" | "insensitive";
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly context: number;
  readonly signal: AbortSignal;
  readonly budget: SearchRequestBudget;
  readonly backend: RepositorySearchBackend;
}): Promise<{
  readonly matches: readonly RankedContentMatch[];
  readonly omissions: readonly z.infer<typeof omissionSchema>[];
}> {
  const args = [
    "--json",
    ...(options.mode === "literal" ? ["--fixed-strings"] : []),
    ...(options.case === "smart"
      ? ["--smart-case"]
      : options.case === "sensitive"
        ? ["--case-sensitive"]
        : ["--ignore-case"]),
    "--color",
    "never",
    ...options.include.flatMap((glob) => ["--glob", glob]),
    ...options.exclude.flatMap((glob) => ["--glob", `!${glob}`]),
    ...(options.context === 0 ? [] : ["--context", String(options.context)]),
    "--",
    options.query,
    options.path,
  ];
  const changedPaths = await options.backend.readChangedPaths({
    workspaceRoot: options.workspaceRoot,
    path: options.path,
    signal: options.signal,
    budget: options.budget,
  });
  try {
    const collector = new ContentMatchCollector(
      options.mode,
      options.context,
      changedPaths,
      options.budget,
      options.workspaceRoot,
    );
    await options.backend.runRecords({
      args,
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      separator: "\n",
      accept: (record) => collector.accept(record),
      budget: options.budget,
    });
    const parsed = collector.finish();
    const probed = await probeCandidatePaths(
      options.workspaceRoot,
      [...new Set(parsed.matches.map((match) => match.path))],
      options.budget,
      parsed.initialFileIdentities,
    );
    const accepted = new Set(probed.paths);
    return {
      matches: parsed.matches.filter((match) => accepted.has(match.path)),
      omissions: [
        ...probed.omissions,
        ...(parsed.omittedCandidateCount > 0
          ? [
              {
                reason: "ranked_candidate_limit" as const,
                path: ".",
                count: parsed.omittedCandidateCount,
              },
            ]
          : []),
      ],
    };
  } catch (error) {
    if (error instanceof SearchCursorError) {
      throw error;
    }
    throw new Error("The repository search backend returned invalid output.");
  }
}

async function runPathSearch(options: {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly query: string;
  readonly mode: "fuzzy" | "glob";
  readonly signal: AbortSignal;
  readonly budget: SearchRequestBudget;
  readonly backend: RepositorySearchBackend;
}): Promise<{
  readonly entries: readonly { readonly path: string; readonly rankReason: PathRankReason }[];
  readonly omissions: readonly z.infer<typeof omissionSchema>[];
}> {
  const changedPaths = await options.backend.readChangedPaths({
    workspaceRoot: options.workspaceRoot,
    path: options.path,
    signal: options.signal,
    budget: options.budget,
  });
  let rawRecordCount = 0;
  let rankedCandidateCount = 0;
  const initialFileIdentities = new Map<string, FileIdentity | undefined>();
  const candidates = new BoundedBestCandidates<{
    readonly path: string;
    readonly tier: number;
    readonly rankReason: PathRankReason;
  }>(maximumRankedCandidates, (left, right) => {
    return left.tier - right.tier || compareChangedThenPath(left.path, right.path, changedPaths);
  });
  await options.backend.runRecords({
    args: [
      "--files",
      "--null",
      ...(options.mode === "glob" ? ["--glob", options.query] : []),
      "--",
      options.path,
    ],
    workspaceRoot: options.workspaceRoot,
    signal: options.signal,
    separator: "\0",
    budget: options.budget,
    accept(record) {
      options.budget.consumeWorkRecord();
      rawRecordCount += 1;
      if (rawRecordCount > maximumRawRecords || rawRecordCount > maximumWorkRecords) {
        throw new SearchCursorError(
          "search_quota_exceeded",
          "Repository path search exceeded its record limit.",
        );
      }
      const path = record.split(sep).join("/").replace(/^\.\//u, "");
      initialFileIdentities.set(path, captureFileIdentity(options.workspaceRoot, path));
      const rank =
        options.mode === "glob"
          ? { tier: 0, rankReason: "glob" as const }
          : fuzzyPathRank(options.query, path);
      if (rank !== undefined) {
        rankedCandidateCount += 1;
        candidates.add({ path, ...rank });
      }
    },
  });
  const ranked = candidates.sorted();
  const probed = await probeCandidatePaths(
    options.workspaceRoot,
    ranked.map((candidate) => candidate.path),
    options.budget,
    initialFileIdentities,
  );
  const accepted = new Set(probed.paths);
  const candidateOmissions =
    rankedCandidateCount > ranked.length
      ? [
          {
            reason: "ranked_candidate_limit" as const,
            path: ".",
            count: rankedCandidateCount - ranked.length,
          },
        ]
      : [];
  const entries = ranked
    .filter((candidate) => accepted.has(candidate.path))
    .map(({ path, rankReason }) => ({ path, rankReason }));
  return { entries, omissions: [...probed.omissions, ...candidateOmissions] };
}

function compareChangedThenPath(left: string, right: string, changedPaths: ReadonlySet<string>) {
  const changedDifference = Number(changedPaths.has(right)) - Number(changedPaths.has(left));
  return changedDifference || (left < right ? -1 : left > right ? 1 : 0);
}

function readGitChangedPaths(
  workspaceRoot: string,
  path: string,
  signal: AbortSignal,
  budget: RepositorySearchBackendBudget,
): Promise<ReadonlySet<string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "submodule.recurse=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--",
          path,
        ],
        {
          cwd: workspaceRoot,
          env: frozenGitEnvironment(),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.end();
    } catch {
      resolvePromise(new Set());
      return;
    }
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;
    let terminalError = false;
    const termination = createBoundedChildTermination(child);
    const abort = () => termination.start();
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        budget.consumeRawBytes(chunk.length);
      } catch {
        byteCount = maximumRawParsedBytes + 1;
        termination.start();
        return;
      }
      byteCount += chunk.length;
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      if (settled) {
        return;
      }
      terminalError = true;
      termination.start();
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      termination.closed();
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        rejectPromise(signal.reason);
        return;
      }
      if (byteCount > maximumRawParsedBytes) {
        rejectPromise(
          new SearchCursorError(
            "search_quota_exceeded",
            "Repository Git status exceeded the raw byte limit.",
          ),
        );
        return;
      }
      if (terminalError || exitCode !== 0) {
        resolvePromise(new Set());
        return;
      }
      const fields = Buffer.concat(chunks).toString("utf8").split("\0");
      const paths = new Set<string>();
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === undefined || field.length < 4) {
          continue;
        }
        budget.consumeWorkRecord();
        paths.add(field.slice(3).split(sep).join("/"));
        if (field[0] === "R" || field[1] === "R" || field[0] === "C" || field[1] === "C") {
          const source = fields[index + 1];
          if (source !== undefined) {
            paths.add(source.split(sep).join("/"));
            index += 1;
          }
        }
      }
      resolvePromise(paths);
    });
  });
}

function frozenGitEnvironment(): NodeJS.ProcessEnv {
  const { PATH: inheritedPath } = process.env;
  return {
    ...(inheritedPath === undefined ? {} : { PATH: inheritedPath }),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

async function probeCandidatePaths(
  workspaceRoot: string,
  paths: readonly string[],
  budget: SearchRequestBudget,
  initialFileIdentities?: ReadonlyMap<string, FileIdentity | undefined>,
): Promise<{
  readonly paths: string[];
  readonly omissions: z.infer<typeof omissionSchema>[];
}> {
  const accepted: string[] = [];
  const omissions: z.infer<typeof omissionSchema>[] = [];
  for (const path of paths) {
    budget.consumeWorkRecord();
    const omission = await probeCandidatePath(
      workspaceRoot,
      path,
      initialFileIdentities === undefined
        ? undefined
        : {
            observed: initialFileIdentities.has(path),
            identity: initialFileIdentities.get(path),
          },
    );
    if (omission === undefined) {
      accepted.push(path);
    } else {
      omissions.push({ reason: omission, path, count: 1 });
    }
  }
  return { paths: accepted, omissions };
}

async function probeCandidatePath(
  workspaceRoot: string,
  path: string,
  initial?: { readonly observed: boolean; readonly identity: FileIdentity | undefined },
): Promise<"binary" | "non_ordinary" | "unreadable" | "changed" | undefined> {
  const absolutePath = resolve(workspaceRoot, path);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${sep}`)) {
    return "non_ordinary";
  }
  try {
    const before = await lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return "non_ordinary";
    }
    if (
      initial !== undefined &&
      (!initial.observed ||
        initial.identity === undefined ||
        !sameFileIdentity(initial.identity, before))
    ) {
      return "changed";
    }
    const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs
      ) {
        return "changed";
      }
      const prefix = Buffer.allocUnsafe(Math.min(binaryProbeBytes, opened.size));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      const after = await handle.stat();
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs
      ) {
        return "changed";
      }
      return prefix.subarray(0, bytesRead).includes(0) ? "binary" : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return "unreadable";
  }
}

type FileIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

function captureFileIdentity(workspaceRoot: string, path: string): FileIdentity | undefined {
  const absolutePath = resolve(workspaceRoot, path);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${sep}`)) {
    return undefined;
  }
  try {
    const current = lstatSync(absolutePath);
    return {
      dev: current.dev,
      ino: current.ino,
      mode: current.mode,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
    };
  } catch {
    return undefined;
  }
}

function sameFileIdentity(identity: FileIdentity, current: FileIdentity): boolean {
  return (
    identity.dev === current.dev &&
    identity.ino === current.ino &&
    identity.mode === current.mode &&
    identity.size === current.size &&
    identity.mtimeMs === current.mtimeMs &&
    identity.ctimeMs === current.ctimeMs
  );
}

type PathRankReason =
  | "exact_basename"
  | "prefix_basename"
  | "literal_substring"
  | "all_tokens"
  | "fuzzy_subsequence"
  | "glob";

function fuzzyPathRank(
  query: string,
  path: string,
): { readonly tier: number; readonly rankReason: Exclude<PathRankReason, "glob"> } | undefined {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const normalizedPath = path.toLocaleLowerCase("en-US");
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (basename === normalizedQuery) {
    return { tier: 0, rankReason: "exact_basename" };
  }
  if (basename.startsWith(normalizedQuery)) {
    return { tier: 1, rankReason: "prefix_basename" };
  }
  if (normalizedPath.includes(normalizedQuery)) {
    return { tier: 2, rankReason: "literal_substring" };
  }
  const tokens = normalizedQuery.split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length > 0 && tokens.every((token) => normalizedPath.includes(token))) {
    return { tier: 3, rankReason: "all_tokens" };
  }
  if (tokens.length > 0 && tokens.every((token) => isSubsequence(token, normalizedPath))) {
    return { tier: 4, rankReason: "fuzzy_subsequence" };
  }
  return undefined;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let needleIndex = 0;
  for (const character of haystack) {
    if (character === needle[needleIndex]) {
      needleIndex += 1;
      if (needleIndex === needle.length) {
        return true;
      }
    }
  }
  return needle.length === 0;
}

function runRipgrepRecords(options: {
  readonly args: readonly string[];
  readonly executablePath: string;
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly separator: "\n" | "\0";
  readonly budget: RepositorySearchBackendBudget;
  readonly processObserver?: RepositorySearchProcessObserver;
  accept(record: string): void;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executablePath, options.args, {
        cwd: options.workspaceRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
    } catch {
      rejectPromise(new Error("The application-local repository search process could not start."));
      return;
    }
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let stderrByteCount = 0;
    let terminalError: unknown;
    let settled = false;
    const termination = createBoundedChildTermination(child, options.processObserver);
    const abort = () => termination.start();
    if (options.signal.aborted) {
      abort();
    } else {
      options.signal.addEventListener("abort", abort, { once: true });
    }
    options.processObserver?.spawned();
    const acceptText = (text: string) => {
      remainder += text;
      while (terminalError === undefined) {
        const boundary = remainder.indexOf(options.separator);
        if (boundary < 0) {
          return;
        }
        const record = remainder.slice(0, boundary);
        remainder = remainder.slice(boundary + 1);
        if (record.length > 0) {
          options.accept(record);
          options.processObserver?.recorded?.();
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalError !== undefined) {
        return;
      }
      try {
        options.budget.consumeRawBytes(chunk.length);
      } catch (error) {
        terminalError = error;
        termination.start();
        return;
      }
      try {
        acceptText(decoder.write(chunk));
      } catch (error) {
        terminalError = error;
        termination.start();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrByteCount += chunk.length;
    });
    child.once("error", () => {
      if (settled) {
        return;
      }
      terminalError = new Error("The application-local repository search process could not start.");
      termination.start();
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      termination.closed();
      options.signal.removeEventListener("abort", abort);
      options.processObserver?.closed();
      if (options.signal.aborted) {
        rejectPromise(options.signal.reason);
        return;
      }
      if (terminalError !== undefined) {
        rejectPromise(terminalError);
        return;
      }
      try {
        acceptText(decoder.end());
        if (remainder.length > 0) {
          options.accept(remainder);
          remainder = "";
        }
      } catch (error) {
        rejectPromise(error);
        return;
      }
      if (exitCode !== 0 && exitCode !== 1) {
        rejectPromise(
          new Error(
            stderrByteCount === 0
              ? "Repository search failed."
              : "The repository search backend rejected the request.",
          ),
        );
        return;
      }
      resolvePromise();
    });
  });
}

function createBoundedChildTermination(
  child: ChildProcessWithoutNullStreams,
  observer?: RepositorySearchProcessObserver,
): { readonly start: () => void; readonly closed: () => void } {
  let started = false;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    start() {
      if (started || closed) {
        return;
      }
      started = true;
      observer?.signalled?.("SIGTERM");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (closed) {
          return;
        }
        observer?.signalled?.("SIGKILL");
        child.kill("SIGKILL");
      }, searchProcessTerminationGraceMilliseconds);
      killTimer.unref();
    },
    closed() {
      closed = true;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
    },
  };
}

class ContentMatchCollector {
  readonly #candidates: BoundedBestCandidates<
    Omit<RankedContentMatch, "contextBefore" | "contextAfter">
  >;
  readonly #contextLines = new Map<string, { readonly line: number; readonly snippet: string }>();
  readonly #initialFileIdentities = new Map<string, FileIdentity | undefined>();
  #rawMatchCount = 0;
  #workRecordCount = 0;

  constructor(
    readonly mode: "literal" | "regex",
    readonly context: number,
    readonly changedPaths: ReadonlySet<string>,
    readonly budget: SearchRequestBudget,
    readonly workspaceRoot: string,
  ) {
    this.#candidates = new BoundedBestCandidates(maximumRankedCandidates, (left, right) => {
      return (
        compareChangedThenPath(left.path, right.path, changedPaths) ||
        left.line - right.line ||
        left.column - right.column
      );
    });
  }

  accept(line: string) {
    this.budget.consumeWorkRecord();
    this.#workRecordCount += 1;
    if (this.#workRecordCount > maximumWorkRecords) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "Repository content search exceeded the parser work limit.",
      );
    }
    const event = ripgrepEventSchema.parse(JSON.parse(line));
    if (event.type === "begin") {
      const path = event.data.path.text.split(sep).join("/").replace(/^\.\//u, "");
      this.#initialFileIdentities.set(path, captureFileIdentity(this.workspaceRoot, path));
      return;
    }
    if (event.type !== "match" && event.type !== "context") {
      return;
    }
    const path = event.data.path.text.split(sep).join("/").replace(/^\.\//u, "");
    const snippet = truncateDisplayedCharacters(event.data.lines.text.replace(/[\r\n]+$/u, ""));
    if (event.type === "context") {
      this.#contextLines.set(`${path}\0${event.data.line_number}`, {
        line: event.data.line_number,
        snippet,
      });
      return;
    }
    this.#rawMatchCount += event.data.submatches.length;
    if (this.#rawMatchCount > maximumRawRecords) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "Repository content search exceeded the raw match limit.",
      );
    }
    if (event.data.submatches.length === 0) {
      throw new Error("The repository search backend returned an invalid match boundary.");
    }
    for (const submatch of event.data.submatches) {
      const column = characterColumnFromUtf8Boundary(
        event.data.lines.text,
        submatch.start,
        submatch.end,
        submatch.match.text,
      );
      this.#candidates.add({
        path,
        line: event.data.line_number,
        column,
        snippet,
        rankReason: this.mode,
      });
    }
  }

  finish(): {
    readonly matches: readonly RankedContentMatch[];
    readonly omittedCandidateCount: number;
    readonly initialFileIdentities: ReadonlyMap<string, FileIdentity | undefined>;
  } {
    const matches = this.#candidates.sorted().map((match) => ({
      ...match,
      contextBefore: Array.from({ length: this.context }, (_unused, offset) =>
        this.#contextLines.get(`${match.path}\0${match.line - this.context + offset}`),
      ).filter(
        (line): line is { readonly line: number; readonly snippet: string } => line !== undefined,
      ),
      contextAfter: Array.from({ length: this.context }, (_unused, offset) =>
        this.#contextLines.get(`${match.path}\0${match.line + offset + 1}`),
      ).filter(
        (line): line is { readonly line: number; readonly snippet: string } => line !== undefined,
      ),
    }));
    return {
      matches,
      omittedCandidateCount: Math.max(0, this.#rawMatchCount - matches.length),
      initialFileIdentities: this.#initialFileIdentities,
    };
  }
}

function characterColumnFromUtf8Boundary(
  line: string,
  start: number,
  end: number,
  match: string,
): number {
  const bytes = Buffer.from(line, "utf8");
  if (start > end || end > bytes.length) {
    throw new Error("The repository search backend returned an invalid match boundary.");
  }
  const prefix = bytes.subarray(0, start).toString("utf8");
  const matched = bytes.subarray(start, end).toString("utf8");
  if (
    Buffer.byteLength(prefix, "utf8") !== start ||
    Buffer.byteLength(matched, "utf8") !== end - start ||
    matched !== match
  ) {
    throw new Error("The repository search backend returned an invalid UTF-8 match boundary.");
  }
  return Array.from(prefix).length + 1;
}

const ripgrepEventSchema = z.union([
  z.strictObject({
    type: z.literal("begin"),
    data: z.strictObject({ path: z.strictObject({ text: z.string() }) }),
  }),
  z.strictObject({ type: z.enum(["end", "summary"]), data: z.unknown() }),
  z.strictObject({
    type: z.enum(["match", "context"]),
    data: z.strictObject({
      path: z.strictObject({ text: z.string() }),
      lines: z.strictObject({ text: z.string() }),
      line_number: z.number().int().positive(),
      absolute_offset: z.number().int().nonnegative(),
      submatches: z.array(
        z.strictObject({
          match: z.strictObject({ text: z.string() }),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
      ),
    }),
  }),
]);

function truncateDisplayedCharacters(value: string): string {
  return Array.from(value).slice(0, maximumSnippetCharacters).join("");
}

function createPathPages(
  entries: readonly PathEntry[],
  limit: number,
  unboundedResultCount: number,
  initialOmissions: readonly z.infer<typeof omissionSchema>[],
): readonly PathPage[] {
  const pages: PathPage[] = [];
  let offset = 0;
  while (offset < entries.length) {
    const accepted: PathEntry[] = [];
    const omissions = pages.length === 0 ? [...initialOmissions] : [];
    while (accepted.length < limit && offset + accepted.length < entries.length) {
      const entry = entries[offset + accepted.length];
      if (entry === undefined) {
        break;
      }
      const remaining = entries.length - offset - accepted.length - 1;
      const candidateOmissions =
        remaining > 0
          ? [...omissions, { reason: "page_byte_limit" as const, path: ".", count: remaining }]
          : omissions;
      if (
        Buffer.byteLength(
          JSON.stringify({ entries: [...accepted, entry], omissions: candidateOmissions }),
          "utf8",
        ) >
        12 * 1_024
      ) {
        break;
      }
      accepted.push(entry);
    }
    if (accepted.length === 0) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "One normalized repository path result exceeded the page byte limit.",
      );
    }
    offset += accepted.length;
    if (offset < entries.length) {
      omissions.push({
        reason: accepted.length === limit ? "page_limit" : "page_byte_limit",
        path: ".",
        count: entries.length - offset,
      });
    }
    if (pages.length === 0 && unboundedResultCount > entries.length) {
      omissions.push({
        reason: "snapshot_result_limit",
        path: ".",
        count: unboundedResultCount - entries.length,
      });
    }
    pages.push({ entries: accepted, omissions });
  }
  return pages.length === 0 ? [{ entries: [], omissions: [...initialOmissions] }] : pages;
}

function createContentPages(
  matches: readonly RankedContentMatch[],
  limit: number,
  unboundedResultCount: number,
  initialOmissions: readonly z.infer<typeof omissionSchema>[],
): readonly ContentPage[] {
  let remaining = [...groupMatches(matches).entries()].map(([path, grouped]) => ({
    path,
    matches: grouped,
  }));
  const pages: ContentPage[] = [];
  while (remaining.length > 0) {
    const accepted: RankedContentMatch[] = [];
    const next: typeof remaining = [];
    const omissions: z.infer<typeof omissionSchema>[] =
      pages.length === 0 ? [...initialOmissions] : [];
    let byteLimited = false;
    for (let groupIndex = 0; groupIndex < remaining.length; groupIndex += 1) {
      const group = remaining[groupIndex] as (typeof remaining)[number];
      const available = limit - accepted.length;
      const maximumAcceptedCount = Math.min(
        group.matches.length,
        maximumMatchesPerFilePerPage,
        Math.max(0, available),
      );
      let acceptedCount = 0;
      while (acceptedCount < maximumAcceptedCount) {
        const match = group.matches[acceptedCount];
        if (match === undefined) {
          break;
        }
        const candidateMatches = [...accepted, match];
        const remainingCount =
          remaining
            .slice(groupIndex)
            .reduce((total, candidate) => total + candidate.matches.length, 0) -
          acceptedCount -
          1;
        const candidateOmissions =
          remainingCount > 0
            ? [
                ...omissions,
                {
                  reason: "page_byte_limit" as const,
                  path: ".",
                  count: remainingCount,
                },
              ]
            : omissions;
        if (contentPagePayloadBytes(candidateMatches, candidateOmissions) > 12 * 1_024) {
          byteLimited = true;
          break;
        }
        accepted.push(match);
        acceptedCount += 1;
      }
      const rest = group.matches.slice(acceptedCount);
      if (rest.length > 0) {
        next.push({ path: group.path, matches: rest });
        omissions.push({
          reason: byteLimited
            ? "page_byte_limit"
            : acceptedCount >= maximumMatchesPerFilePerPage
              ? "per_file_page_limit"
              : "page_limit",
          path: group.path,
          count: rest.length,
        });
      }
      if (byteLimited) {
        next.push(...remaining.slice(groupIndex + 1));
        break;
      }
    }
    if (accepted.length === 0) {
      throw new SearchCursorError(
        "search_quota_exceeded",
        "The repository search page could not make bounded progress.",
      );
    }
    if (pages.length === 0 && unboundedResultCount > matches.length) {
      omissions.push({
        reason: "snapshot_result_limit",
        path: ".",
        count: unboundedResultCount - matches.length,
      });
    }
    pages.push({ matches: accepted, omissions });
    remaining = next;
  }
  return pages.length === 0 ? [{ matches: [], omissions: [...initialOmissions] }] : pages;
}

function contentPagePayloadBytes(
  matches: readonly RankedContentMatch[],
  omissions: readonly z.infer<typeof omissionSchema>[],
): number {
  return Buffer.byteLength(
    JSON.stringify({
      groups: [...groupMatches(matches)].map(([path, grouped]) => ({
        path,
        matches: grouped.map(({ path: _path, ...match }) => match),
      })),
      omissions,
    }),
    "utf8",
  );
}

function groupMatches(
  matches: readonly RankedContentMatch[],
): ReadonlyMap<string, readonly RankedContentMatch[]> {
  const groups = new Map<string, RankedContentMatch[]>();
  for (const match of matches) {
    const grouped = groups.get(match.path) ?? [];
    grouped.push(match);
    groups.set(match.path, grouped);
  }
  return groups;
}

function encodeCursor(snapshotId: string, pageIndex: number): string {
  return `search-repository:v1:${Buffer.from(
    JSON.stringify({ snapshotId, pageIndex }),
    "utf8",
  ).toString("base64url")}`;
}

function decodeCursor(
  cursor: string,
): { readonly snapshotId: string; readonly pageIndex: number } | undefined {
  const prefix = "search-repository:v1:";
  if (!cursor.startsWith(prefix)) {
    return undefined;
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"),
    );
    return typeof value === "object" &&
      value !== null &&
      "snapshotId" in value &&
      typeof value.snapshotId === "string" &&
      /^[0-9a-f-]{36}$/u.test(value.snapshotId) &&
      "pageIndex" in value &&
      Number.isSafeInteger(value.pageIndex) &&
      (value.pageIndex as number) > 0
      ? { snapshotId: value.snapshotId, pageIndex: value.pageIndex as number }
      : undefined;
  } catch {
    return undefined;
  }
}

export function repositorySearchBackendForTesting() {
  return { rgPath } as const;
}
