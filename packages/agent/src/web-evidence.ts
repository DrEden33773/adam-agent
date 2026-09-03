import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import ipaddr from "ipaddr.js";
import { z } from "zod";

import type { ArtifactStore, WebEvidenceArtifactSourceV1 } from "./artifact-store.js";
import { hasDuplicateJsonObjectKey } from "./secure-user-configuration.js";
import {
  createInternalToolAdapter,
  createInternalToolRegistry,
  type JsonValue,
  type ToolAdapter,
  type ToolRegistry,
  type ToolResult,
} from "./tool-runtime.js";
import { extractWebText } from "./web-content-extraction.js";

const maximumFetchedBodyBytes = 5 * 1024 * 1024;
const maximumPageTextBytes = 12 * 1024;
const maximumSerializedToolResultBytes = 16 * 1024;
const artifactIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const cursorSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const webUrlSchema = z.url().refine((value) => Buffer.byteLength(value, "utf8") <= 4 * 1024);
const engineHintSchema = z
  .string()
  .max(256)
  .refine((value) => Array.from(value).length <= 128);
const fetchInputSchema = z.union([
  z.strictObject({ url: webUrlSchema }),
  z.strictObject({ sourceId: artifactIdSchema }),
]);
const openInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  cursor: cursorSchema.optional(),
});
const findInputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  text: boundedUtf8String(1_024),
  cursor: cursorSchema.optional(),
});
const searchInputSchema = z.strictObject({
  query: boundedUtf8String(4 * 1024),
  limit: z.number().int().min(1).max(10).optional(),
  language: z.string().min(1).max(32).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
});
const pageOutputShape = {
  artifactId: artifactIdSchema,
  cursor: cursorSchema,
  text: z.string(),
  nextCursor: cursorSchema.nullable(),
  truncated: z.boolean(),
} as const;
const fetchOutputSchema = z.union([
  z.strictObject({
    ...pageOutputShape,
    fetchId: artifactIdSchema,
    sourceId: artifactIdSchema,
    url: webUrlSchema,
    finalUrl: webUrlSchema.optional(),
    mediaType: z.literal("text/plain"),
    byteCount: z.number().int().nonnegative(),
    retrievedAt: z.string().max(128),
    citation: z.strictObject({
      artifactId: artifactIdSchema,
      url: webUrlSchema,
      robotsPolicy: z.literal("not_evaluated"),
    }),
  }),
  z.strictObject({
    status: z.literal("redirect"),
    url: webUrlSchema,
    redirectUrl: webUrlSchema,
    requiresApproval: z.literal(true),
  }),
]);
const openOutputSchema = z.strictObject(pageOutputShape);
const findOutputSchema = z.strictObject({
  artifactId: artifactIdSchema,
  cursor: cursorSchema,
  matches: z.array(
    z.strictObject({
      offset: z.number().int().nonnegative(),
      text: z.string(),
    }),
  ),
  nextCursor: cursorSchema.nullable(),
  truncated: z.boolean(),
});
const searchOutputSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      sourceId: artifactIdSchema,
      rank: z.number().int().positive().max(10),
      url: webUrlSchema,
      title: z.string().max(2 * 1024),
      snippet: z.string().max(8 * 1024),
      retrievedAt: z.string().max(128),
      robotsPolicy: z.literal("not_evaluated"),
      provider: z.strictObject({ kind: z.literal("searxng"), origin: z.url().max(4 * 1024) }),
      queryDigest: artifactIdSchema,
      truncation: z.strictObject({
        title: z.boolean(),
        snippet: z.boolean(),
        engines: z.boolean(),
        publishedAt: z.boolean(),
      }),
      publishedAt: z.string().max(128).optional(),
      engines: z.array(engineHintSchema).max(16),
    }),
  ),
  partial: z.boolean(),
  omittedResults: z.number().int().nonnegative(),
});
const webEvidenceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fetchId: artifactIdSchema,
  artifactId: artifactIdSchema,
  byteCount: z.number().int().nonnegative().max(maximumFetchedBodyBytes),
  mediaType: z.literal("text/plain"),
  sourceId: artifactIdSchema,
  url: webUrlSchema,
  finalUrl: webUrlSchema.optional(),
  retrievedAt: z.string().max(128),
  provenance: z.enum(["web_fetch", "web_search_result"]),
});
const webSearchSourceRecordSchema = z.strictObject({
  recordType: z.literal("search_source"),
  schemaVersion: z.literal(1),
  sourceId: artifactIdSchema,
  rank: z.number().int().positive().max(10),
  url: webUrlSchema,
  title: z.string().max(2 * 1024),
  snippet: z.string().max(8 * 1024),
  retrievedAt: z.string().max(128),
  robotsPolicy: z.literal("not_evaluated"),
  publishedAt: z.string().max(128).optional(),
  engines: z.array(engineHintSchema).max(16),
  providerKind: z.literal("searxng"),
  providerOrigin: webUrlSchema,
  queryDigest: artifactIdSchema,
  truncation: z.strictObject({
    title: z.boolean(),
    snippet: z.boolean(),
    engines: z.boolean(),
    publishedAt: z.boolean(),
  }),
});

export type WebHttpAdapter = {
  fetch(input: {
    readonly url: string;
    readonly allowedLoopbackOrigin?: string;
    readonly maximumRedirects?: 0 | 5;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: number;
    readonly url: string;
    readonly redirectUrl?: string;
    readonly mediaType: string;
    readonly body: Uint8Array;
  }>;
};

export type WebSearchProviderResult = {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publishedAt?: string;
  readonly engines: readonly string[];
};

export type WebSearchProvider = {
  readonly kind: "searxng";
  readonly origin: string;
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly language?: string;
    readonly timeRange?: "day" | "week" | "month" | "year";
    readonly signal: AbortSignal;
  }): Promise<{
    readonly results: readonly WebSearchProviderResult[];
    readonly partial: boolean;
  }>;
};

export type WebEvidenceRecordV1 = {
  readonly schemaVersion: 1;
  readonly fetchId: `sha256:${string}`;
  readonly artifactId: `sha256:${string}`;
  readonly byteCount: number;
  readonly mediaType: "text/plain";
  readonly sourceId: `sha256:${string}`;
  readonly url: string;
  readonly finalUrl?: string;
  readonly retrievedAt: string;
  readonly provenance: "web_fetch" | "web_search_result";
};

export type WebSearchSourceRecordV1 = {
  readonly recordType: "search_source";
  readonly schemaVersion: 1;
  readonly sourceId: `sha256:${string}`;
  readonly rank: number;
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly retrievedAt: string;
  readonly robotsPolicy: "not_evaluated";
  readonly publishedAt?: string;
  readonly engines: readonly string[];
  readonly providerKind: "searxng";
  readonly providerOrigin: string;
  readonly queryDigest: `sha256:${string}`;
  readonly truncation: {
    readonly title: boolean;
    readonly snippet: boolean;
    readonly engines: boolean;
    readonly publishedAt: boolean;
  };
};

export type WebEvidenceStore = {
  append(record: WebEvidenceRecordV1): Promise<void>;
  appendSearchSource(record: WebSearchSourceRecordV1): Promise<void>;
  get(artifactId: `sha256:${string}`): Promise<WebEvidenceRecordV1 | undefined>;
  getSearchSource(sourceId: `sha256:${string}`): Promise<WebSearchSourceRecordV1 | undefined>;
  listSearchSources(): Promise<readonly WebSearchSourceRecordV1[]>;
};

export function createInMemoryWebEvidenceStore(): WebEvidenceStore {
  const records = new Map<string, WebEvidenceRecordV1>();
  const sources = new Map<string, WebSearchSourceRecordV1>();
  return {
    async append(record) {
      const existing = records.get(record.fetchId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error("The immutable Web artifact metadata conflicts with its existing record.");
      }
      records.set(record.fetchId, structuredClone(record));
    },
    async appendSearchSource(record) {
      const existing = sources.get(record.sourceId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error("The immutable Web source conflicts with its existing record.");
      }
      sources.set(record.sourceId, structuredClone(record));
    },
    async get(artifactId) {
      const record = [...records.values()].findLast(
        (candidate) => candidate.artifactId === artifactId,
      );
      return record === undefined ? undefined : structuredClone(record);
    },
    async getSearchSource(sourceId) {
      const record = sources.get(sourceId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async listSearchSources() {
      return [...sources.values()].map((record) => structuredClone(record));
    },
  };
}

export function createJsonlWebEvidenceStore(options: {
  readonly filePath: string;
}): WebEvidenceStore {
  let mutation = Promise.resolve();
  const runMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutation.then(operation, operation);
    mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    append(record) {
      return runMutation(async () => {
        const validated = webEvidenceRecordSchema.parse(record) as WebEvidenceRecordV1;
        const records = await readJsonlWebEvidenceRecords(options.filePath);
        const existing = records.find(
          (entry): entry is WebEvidenceRecordV1 =>
            !("recordType" in entry) && entry.fetchId === validated.fetchId,
        );
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(validated)) {
            throw new Error("The immutable WebEvidence JSONL record conflicts with its artifact.");
          }
          return;
        }
        await appendJsonlWebEvidenceRecord(options.filePath, validated);
      });
    },
    appendSearchSource(record) {
      return runMutation(async () => {
        const validated = webSearchSourceRecordSchema.parse(record) as WebSearchSourceRecordV1;
        const records = await readJsonlWebEvidenceRecords(options.filePath);
        const existing = records.find(
          (entry): entry is WebSearchSourceRecordV1 =>
            "recordType" in entry && entry.sourceId === validated.sourceId,
        );
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(validated)) {
            throw new Error("The immutable WebEvidence JSONL source conflicts with its record.");
          }
          return;
        }
        await appendJsonlWebEvidenceRecord(options.filePath, validated);
      });
    },
    async get(artifactId) {
      const records = await readJsonlWebEvidenceRecords(options.filePath);
      return records.findLast(
        (record): record is WebEvidenceRecordV1 =>
          !("recordType" in record) && record.artifactId === artifactId,
      );
    },
    async getSearchSource(sourceId) {
      const records = await readJsonlWebEvidenceRecords(options.filePath);
      return records.findLast(
        (record): record is WebSearchSourceRecordV1 =>
          "recordType" in record && record.sourceId === sourceId,
      );
    },
    async listSearchSources() {
      const records = await readJsonlWebEvidenceRecords(options.filePath);
      return records.filter((record): record is WebSearchSourceRecordV1 => "recordType" in record);
    },
  };
}

async function appendJsonlWebEvidenceRecord(
  filePath: string,
  record: WebEvidenceRecordV1 | WebSearchSourceRecordV1,
): Promise<void> {
  const directoryPath = dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const file = await open(
    filePath,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJsonlWebEvidenceRecords(
  filePath: string,
): Promise<readonly (WebEvidenceRecordV1 | WebSearchSourceRecordV1)[]> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > 32 * 1024 * 1024 || (stats.mode & 0o077) !== 0) {
      throw new Error("The WebEvidence JSONL store is invalid.");
    }
    const text = await file.readFile("utf8");
    if (text.length > 0 && !text.endsWith("\n")) {
      throw new Error("The WebEvidence JSONL store is invalid.");
    }
    const records = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        if (Buffer.byteLength(line, "utf8") > 16 * 1024 || hasDuplicateJsonObjectKey(line)) {
          throw new Error("The WebEvidence JSONL store is invalid.");
        }
        try {
          return z
            .union([webEvidenceRecordSchema, webSearchSourceRecordSchema])
            .parse(JSON.parse(line)) as WebEvidenceRecordV1 | WebSearchSourceRecordV1;
        } catch {
          throw new Error("The WebEvidence JSONL store is invalid.");
        }
      });
    const identities = new Set<string>();
    for (const record of records) {
      const identity =
        "recordType" in record ? `source:${record.sourceId}` : `fetch:${record.fetchId}`;
      if (identities.has(identity)) {
        throw new Error("The WebEvidence JSONL store is invalid.");
      }
      identities.add(identity);
    }
    return records;
  } finally {
    await file.close();
  }
}

export async function createWebEvidenceToolRegistry(options: {
  readonly artifactStore: ArtifactStore;
  readonly deadlineSignalFactory?: () => AbortSignal;
  readonly http: WebHttpAdapter;
  readonly now?: () => string;
  readonly searchProvider?: WebSearchProvider;
  readonly store?: WebEvidenceStore;
}): Promise<ToolRegistry> {
  const store = options.store ?? createInMemoryWebEvidenceStore();
  const now = options.now ?? (() => new Date().toISOString());
  const searchSources = new Map(
    (await store.listSearchSources()).map((source) => [source.sourceId, source]),
  );
  const searchAdapter =
    options.searchProvider === undefined
      ? undefined
      : createSearchAdapter(
          options.searchProvider,
          store,
          searchSources,
          now,
          options.deadlineSignalFactory,
        );
  const fetchAdapter = createInternalToolAdapter(
    {
      definition: {
        name: "web_fetch",
        description:
          "Fetch one approved public HTTP(S) source into an immutable Web artifact and return its first bounded text page.",
        inputSchema: z.toJSONSchema(fetchInputSchema),
      },
      outputSchema: fetchOutputSchema as z.ZodType<JsonValue>,
      effect: "network",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumSerializedToolResultBytes },
      prepare(argumentsJson) {
        const parsed = fetchInputSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return invalidToolInput();
        }
        const selectedSource =
          "sourceId" in parsed.data
            ? searchSources.get(parsed.data.sourceId as `sha256:${string}`)
            : undefined;
        if ("sourceId" in parsed.data && selectedSource === undefined) {
          return webFailure("web_source_unavailable", "The durable Web source is unavailable.");
        }
        const normalized = normalizeFetchUrl(
          "url" in parsed.data ? parsed.data.url : (selectedSource?.url ?? ""),
        );
        if (normalized === undefined) {
          return invalidToolInput();
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "web_request",
            operation: "fetch",
            providerOrigin: new URL(normalized).origin,
            url: normalized,
          },
          async execute(context) {
            const deadlineSignal = options.deadlineSignalFactory?.() ?? AbortSignal.timeout(30_000);
            const operationSignal = AbortSignal.any([context.signal, deadlineSignal]);
            try {
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              const response = await options.http.fetch({
                url: normalized,
                maximumRedirects: 5,
                maximumBytes: maximumFetchedBodyBytes,
                signal: operationSignal,
              });
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              if (
                response.redirectUrl !== undefined &&
                response.status >= 300 &&
                response.status < 400
              ) {
                const redirectUrl = normalizeFetchUrl(response.redirectUrl);
                if (
                  redirectUrl === undefined ||
                  new URL(redirectUrl).origin === new URL(normalized).origin
                ) {
                  return toolIoFailure("The Web redirect response is invalid.");
                }
                return {
                  status: "completed",
                  output: {
                    status: "redirect",
                    url: normalized,
                    redirectUrl,
                    requiresApproval: true,
                  },
                };
              }
              if (
                response.status < 200 ||
                response.status >= 300 ||
                response.body.byteLength > maximumFetchedBodyBytes
              ) {
                return toolIoFailure("The Web source could not be fetched safely.");
              }
              const finalUrl = normalizeFetchUrl(response.url);
              if (
                finalUrl === undefined ||
                new URL(finalUrl).origin !== new URL(normalized).origin
              ) {
                return webFailure(
                  "web_response_invalid",
                  "The Web source moved outside its approved origin.",
                );
              }
              const supportedMediaType = isSupportedWebTextMediaType(response.mediaType);
              if (!supportedMediaType) {
                return webFailure(
                  "web_response_invalid",
                  "The Web source media type is unsupported.",
                );
              }
              const extracted = extractWebText(response.mediaType, response.body);
              if (extracted === undefined) {
                return webFailure(
                  "web_response_invalid",
                  "The Web source is not valid UTF-8 text.",
                );
              }
              const { mediaType, text } = extracted;
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              const artifactBytes = Buffer.from(text, "utf8");
              if (artifactBytes.byteLength > maximumFetchedBodyBytes) {
                return webFailure(
                  "web_response_too_large",
                  "The extracted Web response exceeded its maximum artifact size.",
                );
              }
              const sourceId = selectedSource?.sourceId ?? sha256(normalized);
              const retrievedAt = now();
              const expectedArtifactId = sha256Bytes(artifactBytes);
              const fetchId = sha256(
                JSON.stringify({
                  version: 1,
                  sourceId,
                  artifactId: expectedArtifactId,
                  url: normalized,
                  finalUrl,
                  retrievedAt,
                }),
              );
              const reference = await options.artifactStore.write<WebEvidenceArtifactSourceV1>({
                bytes: artifactBytes,
                mediaType,
                source: {
                  type: "web_evidence",
                  schemaVersion: 1,
                  fetchId,
                  sourceId,
                  url: normalized,
                  ...(finalUrl === normalized ? {} : { finalUrl }),
                  provenance: selectedSource === undefined ? "web_fetch" : "web_search_result",
                },
              });
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              if (reference.id !== expectedArtifactId) {
                return webFailure(
                  "web_response_invalid",
                  "The immutable Web artifact did not match its content digest.",
                );
              }
              await store.append({
                schemaVersion: 1,
                fetchId,
                artifactId: reference.id as `sha256:${string}`,
                byteCount: reference.byteCount,
                mediaType,
                sourceId,
                url: normalized,
                ...(finalUrl === normalized ? {} : { finalUrl }),
                retrievedAt,
                provenance: selectedSource === undefined ? "web_fetch" : "web_search_result",
              });
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              const fetchMetadata = {
                artifactId: reference.id,
                fetchId,
                sourceId,
                url: normalized,
                ...(finalUrl === normalized ? {} : { finalUrl }),
                mediaType,
                byteCount: reference.byteCount,
                retrievedAt,
                citation: {
                  artifactId: reference.id,
                  url: normalized,
                  robotsPolicy: "not_evaluated" as const,
                },
              };
              const page = serializedPage(text, 0, fetchMetadata);
              return {
                status: "completed",
                output: {
                  ...page,
                  ...fetchMetadata,
                },
              };
            } catch (error) {
              return classifyWebFailure(
                error,
                context.signal,
                deadlineSignal,
                "The Web source could not be fetched safely.",
              );
            }
          },
        };
      },
    },
    "never",
  );
  const openAdapter = createArtifactOpenAdapter(options.artifactStore, store);
  const findAdapter = createArtifactFindAdapter(options.artifactStore, store);
  return createInternalToolRegistry([
    ...(searchAdapter === undefined ? [] : [searchAdapter]),
    fetchAdapter,
    openAdapter,
    findAdapter,
  ]);
}

function createSearchAdapter(
  provider: WebSearchProvider,
  store: WebEvidenceStore,
  searchSources: Map<string, WebSearchSourceRecordV1>,
  now: () => string,
  deadlineSignalFactory: (() => AbortSignal) | undefined,
): ToolAdapter {
  return createInternalToolAdapter(
    {
      definition: {
        name: "web_search",
        description:
          "Search the exact configured SearXNG provider after call-scoped network approval and return bounded untrusted source metadata.",
        inputSchema: z.toJSONSchema(searchInputSchema),
      },
      outputSchema: searchOutputSchema as z.ZodType<JsonValue>,
      effect: "network",
      cancellation: "abort_signal",
      maximumResult: { maximumBytes: maximumSerializedToolResultBytes },
      prepare(argumentsJson) {
        const parsed = searchInputSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return invalidToolInput();
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "web_request",
            operation: "search",
            providerOrigin: provider.origin,
            query: parsed.data.query,
            limit: parsed.data.limit ?? 5,
            ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
            ...(parsed.data.timeRange === undefined ? {} : { timeRange: parsed.data.timeRange }),
          },
          async execute(context) {
            const deadlineSignal = deadlineSignalFactory?.() ?? AbortSignal.timeout(30_000);
            try {
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              const response = await provider.search({
                query: parsed.data.query,
                limit: parsed.data.limit ?? 5,
                ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
                ...(parsed.data.timeRange === undefined
                  ? {}
                  : { timeRange: parsed.data.timeRange }),
                signal: AbortSignal.any([context.signal, deadlineSignal]),
              });
              throwIfWebOperationAborted(context.signal, deadlineSignal);
              const projectedResults: JsonValue[] = [];
              const retrievedAt = now();
              let omittedResults = 0;
              let truncatedResults = false;
              const queryDigest = sha256(parsed.data.query);
              for (const [index, candidate] of response.results
                .slice(0, parsed.data.limit ?? 5)
                .entries()) {
                const normalized = normalizeSearchResult(
                  candidate,
                  index + 1,
                  provider,
                  retrievedAt,
                  queryDigest,
                );
                if (normalized === undefined) {
                  omittedResults += 1;
                  continue;
                }
                const projected = projectSearchSource(normalized);
                const tentative = {
                  status: "completed",
                  output: {
                    results: [...projectedResults, projected],
                    partial: true,
                    omittedResults: omittedResults + 1,
                  },
                };
                if (
                  Buffer.byteLength(JSON.stringify(tentative), "utf8") >
                  maximumSerializedToolResultBytes
                ) {
                  omittedResults += 1;
                  continue;
                }
                await store.appendSearchSource(normalized);
                throwIfWebOperationAborted(context.signal, deadlineSignal);
                searchSources.set(normalized.sourceId, normalized);
                projectedResults.push(projected);
                truncatedResults ||= Object.values(normalized.truncation).some(Boolean);
              }
              return {
                status: "completed",
                output: {
                  results: projectedResults,
                  partial: response.partial || omittedResults > 0 || truncatedResults,
                  omittedResults,
                },
              };
            } catch (error) {
              return classifyWebFailure(
                error,
                context.signal,
                deadlineSignal,
                "The configured Web Search provider failed.",
              );
            }
          },
        };
      },
    },
    "never",
  );
}

function projectSearchSource(result: WebSearchSourceRecordV1): JsonValue {
  return {
    sourceId: result.sourceId,
    rank: result.rank,
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
    engines: result.engines,
    retrievedAt: result.retrievedAt,
    robotsPolicy: result.robotsPolicy,
    provider: { kind: result.providerKind, origin: result.providerOrigin },
    queryDigest: result.queryDigest,
    truncation: result.truncation,
  };
}

function normalizeSearchResult(
  result: WebSearchProviderResult,
  rank: number,
  provider: WebSearchProvider,
  retrievedAt: string,
  queryDigest: `sha256:${string}`,
): WebSearchSourceRecordV1 | undefined {
  const url = normalizeFetchUrl(result.url);
  if (url === undefined || !Array.isArray(result.engines)) {
    return undefined;
  }
  const title = truncateScalars(result.title, 512);
  const snippet = truncateUtf8(result.snippet, 4 * 1024);
  const engines = result.engines.slice(0, 16).map((engine) => truncateScalars(engine, 128));
  const publishedAt = result.publishedAt?.slice(0, 128);
  const recordWithoutId = {
    recordType: "search_source" as const,
    schemaVersion: 1 as const,
    rank,
    url,
    title,
    snippet,
    retrievedAt,
    robotsPolicy: "not_evaluated" as const,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    engines,
    providerKind: provider.kind,
    providerOrigin: provider.origin,
    queryDigest,
    truncation: {
      title: title !== result.title,
      snippet: snippet !== result.snippet,
      engines:
        result.engines.length !== engines.length ||
        result.engines.some((engine, index) => engine !== engines[index]),
      publishedAt: publishedAt !== result.publishedAt,
    },
  };
  return { ...recordWithoutId, sourceId: sha256(JSON.stringify(recordWithoutId)) };
}

function createArtifactOpenAdapter(
  artifactStore: ArtifactStore,
  store: WebEvidenceStore,
): ToolAdapter {
  return createInternalToolAdapter(
    {
      definition: {
        name: "web_open",
        description: "Read one bounded page from an immutable Web artifact without network access.",
        inputSchema: z.toJSONSchema(openInputSchema),
      },
      outputSchema: openOutputSchema as z.ZodType<JsonValue>,
      effect: "read",
      cancellation: "unsupported",
      maximumResult: { maximumBytes: maximumSerializedToolResultBytes },
      prepare(argumentsJson) {
        const parsed = openInputSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return invalidToolInput();
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "web_artifact",
            operation: "open",
            artifactId: parsed.data.artifactId as `sha256:${string}`,
          },
          async execute() {
            const artifact = await store.get(parsed.data.artifactId as `sha256:${string}`);
            if (artifact === undefined) {
              return toolIoFailure("The Web artifact is unavailable.");
            }
            const bytes = await artifactStore.read(parsed.data.artifactId, {
              maximumBytes: maximumFetchedBodyBytes,
            });
            const text = bytes === undefined ? undefined : decodeUtf8(bytes);
            if (text === undefined) {
              return toolIoFailure("The Web artifact is unavailable.");
            }
            const cursor = Number(parsed.data.cursor ?? "0");
            if (
              !Number.isSafeInteger(cursor) ||
              cursor < 0 ||
              cursor > Buffer.byteLength(text) ||
              !isUtf8Boundary(Buffer.from(text, "utf8"), cursor)
            ) {
              return invalidToolInput();
            }
            return {
              status: "completed",
              output: {
                artifactId: parsed.data.artifactId,
                ...serializedPage(text, cursor, { artifactId: parsed.data.artifactId }),
              },
            };
          },
        };
      },
    },
    "safe",
  );
}

function createArtifactFindAdapter(
  artifactStore: ArtifactStore,
  store: WebEvidenceStore,
): ToolAdapter {
  return createInternalToolAdapter(
    {
      definition: {
        name: "web_find",
        description: "Find bounded exact-text contexts in an immutable Web artifact.",
        inputSchema: z.toJSONSchema(findInputSchema),
      },
      outputSchema: findOutputSchema as z.ZodType<JsonValue>,
      effect: "read",
      cancellation: "unsupported",
      maximumResult: { maximumBytes: maximumSerializedToolResultBytes },
      prepare(argumentsJson) {
        const parsed = findInputSchema.safeParse(parseJson(argumentsJson));
        if (!parsed.success) {
          return invalidToolInput();
        }
        return {
          status: "ready",
          permissionSubject: {
            type: "web_artifact",
            operation: "find",
            artifactId: parsed.data.artifactId as `sha256:${string}`,
          },
          async execute() {
            const artifact = await store.get(parsed.data.artifactId as `sha256:${string}`);
            const artifactBytes =
              artifact === undefined
                ? undefined
                : await artifactStore.read(parsed.data.artifactId, {
                    maximumBytes: maximumFetchedBodyBytes,
                  });
            const text = artifactBytes === undefined ? undefined : decodeUtf8(artifactBytes);
            if (text === undefined) {
              return toolIoFailure("The Web artifact is unavailable.");
            }
            const cursor = Number(parsed.data.cursor ?? "0");
            const bytes = Buffer.from(text, "utf8");
            const needle = Buffer.from(parsed.data.text, "utf8");
            if (
              !Number.isSafeInteger(cursor) ||
              cursor < 0 ||
              cursor > bytes.byteLength ||
              !isUtf8Boundary(bytes, cursor)
            ) {
              return invalidToolInput();
            }
            const matches: Array<{ readonly offset: number; readonly text: string }> = [];
            let searchOffset = cursor;
            while (matches.length < 50) {
              const offset = bytes.indexOf(needle, searchOffset);
              if (offset < 0) {
                break;
              }
              const lineStart = offset === 0 ? 0 : bytes.lastIndexOf(0x0a, offset - 1) + 1;
              const lineEndCandidate = bytes.indexOf(0x0a, offset + needle.byteLength);
              const lineEnd = lineEndCandidate < 0 ? bytes.byteLength : lineEndCandidate;
              const surroundingBytes = Math.max(0, 2 * 1024 - needle.byteLength);
              let contextStart = Math.max(lineStart, offset - Math.floor(surroundingBytes / 2));
              let contextEnd = Math.min(
                lineEnd,
                offset + needle.byteLength + Math.ceil(surroundingBytes / 2),
              );
              while (contextStart < offset && (bytes[contextStart] ?? 0) >> 6 === 0b10) {
                contextStart += 1;
              }
              while (
                contextEnd > offset + needle.byteLength &&
                contextEnd < bytes.byteLength &&
                (bytes[contextEnd] ?? 0) >> 6 === 0b10
              ) {
                contextEnd -= 1;
              }
              const candidate = {
                offset,
                text: bytes.subarray(contextStart, contextEnd).toString("utf8"),
              };
              const nextSearchOffset = offset + needle.byteLength;
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    status: "completed",
                    output: {
                      artifactId: parsed.data.artifactId,
                      cursor: String(cursor),
                      matches: [...matches, candidate],
                      nextCursor: String(nextSearchOffset),
                      truncated: true,
                    },
                  }),
                  "utf8",
                ) > maximumSerializedToolResultBytes
              ) {
                break;
              }
              matches.push(candidate);
              searchOffset = nextSearchOffset;
            }
            const truncated = bytes.indexOf(needle, searchOffset) >= 0;
            return {
              status: "completed",
              output: {
                artifactId: parsed.data.artifactId,
                cursor: String(cursor),
                matches,
                nextCursor: truncated ? String(searchOffset) : null,
                truncated,
              },
            };
          },
        };
      },
    },
    "safe",
  );
}

function pageFromText(text: string, cursor: number, maximumBytes = maximumPageTextBytes) {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.byteLength, cursor + maximumBytes);
  while (end < bytes.byteLength && end > cursor && (bytes[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  const pageBytes = bytes.subarray(cursor, end);
  const page = pageBytes.toString("utf8");
  const nextOffset = end;
  return {
    cursor: String(cursor),
    text: page,
    nextCursor: nextOffset < Buffer.byteLength(text) ? String(nextOffset) : null,
    truncated: nextOffset < Buffer.byteLength(text),
  };
}

function serializedPage(text: string, cursor: number, metadata: JsonValue) {
  let lower = 1;
  let upper = maximumPageTextBytes;
  let selected = pageFromText(text, cursor, 1);
  while (lower <= upper) {
    const candidateBytes = Math.floor((lower + upper) / 2);
    const candidate = pageFromText(text, cursor, candidateBytes);
    const serializedBytes = Buffer.byteLength(
      JSON.stringify({
        status: "completed",
        output: { ...(metadata as Record<string, JsonValue>), ...candidate },
      }),
      "utf8",
    );
    if (serializedBytes <= maximumSerializedToolResultBytes) {
      selected = candidate;
      lower = candidateBytes + 1;
    } else {
      upper = candidateBytes - 1;
    }
  }
  return selected;
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  return offset === bytes.byteLength || (bytes[offset] ?? 0) >> 6 !== 0b10;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeFetchUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  if (
    (url.protocol === "https:" && url.port !== "" && url.port !== "443") ||
    (url.protocol === "http:" && url.port !== "" && url.port !== "80")
  ) {
    return undefined;
  }
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(literal) && ipaddr.parse(literal).range() !== "unicast") {
    return undefined;
  }
  return Buffer.byteLength(url.href, "utf8") <= 4 * 1024 ? url.href : undefined;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function truncateScalars(value: string, maximumScalars: number): string {
  return Array.from(value).slice(0, maximumScalars).join("");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
}

function boundedUtf8String(maximumBytes: number) {
  return z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumBytes);
}

function invalidToolInput(): Extract<ToolResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    error: { code: "invalid_tool_input", message: "The Web tool input is invalid." },
  };
}

function toolIoFailure(message: string): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code: "tool_io_failed", message } };
}

function webFailure(
  code:
    | "web_cancelled"
    | "web_deadline_exceeded"
    | "web_provider_invalid"
    | "web_provider_unavailable"
    | "web_response_invalid"
    | "web_response_too_large"
    | "web_source_unavailable",
  message: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  return { status: "failed", error: { code, message } };
}

function isSupportedWebTextMediaType(value: string): boolean {
  const essence = value.toLowerCase().split(";", 1)[0]?.trim();
  return essence === "text/plain" || essence === "text/html" || essence === "application/json";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function classifyWebFailure(
  error: unknown,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
  fallbackMessage: string,
): Extract<ToolResult, { readonly status: "failed" }> {
  if (callerSignal.aborted) {
    return webFailure("web_cancelled", "The Web request was cancelled.");
  }
  if (deadlineSignal.aborted) {
    return webFailure("web_deadline_exceeded", "The Web request exceeded its deadline.");
  }
  switch (errorCode(error)) {
    case "web_body_too_large":
      return webFailure(
        "web_response_too_large",
        "The Web response exceeded its maximum body size.",
      );
    case "web_deadline_exceeded":
      return webFailure("web_deadline_exceeded", "The Web request exceeded its deadline.");
    case "search_json_disabled":
    case "search_provider_invalid":
    case "web_redirect_limit":
    case "web_url_invalid":
      return webFailure("web_provider_invalid", "The Web provider returned invalid evidence.");
    case "search_provider_transient":
    case "search_provider_unavailable":
    case "web_dns_failed":
    case "web_request_failed":
      return webFailure("web_provider_unavailable", "The Web provider is unavailable.");
    case "web_address_disallowed":
      return webFailure("web_response_invalid", "The Web target address is not admitted.");
    case "web_synthetic_dns_unconfigured":
      return webFailure(
        "web_response_invalid",
        "The Web target uses 198.18.0.0/15 synthetic DNS. If this host intentionally uses an Owner-trusted TUN/fake-IP proxy, configure its exact subnet from the TUI with /config web-fake-ip, then retry.",
      );
    case "web_synthetic_dns_https_required":
      return webFailure(
        "web_response_invalid",
        "Synthetic DNS admission is restricted to HTTPS hostname URLs.",
      );
    default:
      return toolIoFailure(fallbackMessage);
  }
}

function throwIfWebOperationAborted(callerSignal: AbortSignal, deadlineSignal: AbortSignal): void {
  if (callerSignal.aborted) {
    throw Object.assign(new Error("The Web request was cancelled."), { code: "web_cancelled" });
  }
  if (deadlineSignal.aborted) {
    throw Object.assign(new Error("The Web request exceeded its deadline."), {
      code: "web_deadline_exceeded",
    });
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
