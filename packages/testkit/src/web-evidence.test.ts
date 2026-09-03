import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  type AgentSessionDependencies,
  type ArtifactStore,
  createFileArtifactStore,
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelDriver,
  type ModelRequest,
  type ModelTargets,
} from "@adam-agent/agent";
import {
  createInMemorySessionStore,
  createInMemoryWebEvidenceStore,
  createSafeWebHttpAdapter,
  createSearxngAdapterForTesting,
  createTrustedWorkspaceTrustForTesting,
  createWebEvidenceProduction,
  createWebEvidenceToolRegistry,
  createWebSearchConfigurationWithStorageForTesting,
  extractWebTextForTesting,
  resolveWebTargetForTesting,
  SafeWebHttpError,
  type SessionEventRecord,
  type SessionStore,
  sessionToolProfileNames,
  type WebHttpAdapter,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

const contextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 32_000,
  retainedTargetTokens: 8_000,
  estimatorVersion: 1,
} as const;

function createInMemoryArtifactStoreForWebTest(): ArtifactStore {
  const artifacts = new Map<string, Uint8Array>();
  return {
    async write(input) {
      const id = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
      artifacts.set(id, input.bytes);
      return {
        id,
        mediaType: input.mediaType,
        byteCount: input.bytes.byteLength,
        source: input.source,
      };
    },
    async read(id) {
      return artifacts.get(id);
    },
  };
}

test("AgentSession fetches one approved Web source before opening its next immutable page", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-evidence-"));
  const artifactRoot = join(testRoot, "artifacts");
  const url = "https://example.com/evidence.txt";
  const firstPage = "a".repeat(12 * 1024);
  const secondPage = "bounded second page".repeat(256);
  const body = Buffer.from(`${firstPage}${secondPage}`, "utf8");
  const artifactId = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const order: string[] = [];
  const storedArtifacts = createFileArtifactStore({ root: artifactRoot });
  const artifactStore: ArtifactStore = {
    async write(input) {
      const store = await storedArtifacts;
      const reference = await store.write(input);
      order.push("artifact-written");
      return reference;
    },
    async read(id, options) {
      const store = await storedArtifacts;
      return store.read(id, options);
    },
  };
  const http: WebHttpAdapter = {
    async fetch(input) {
      expect(input).toMatchObject({ url, maximumBytes: 5 * 1024 * 1024 });
      return {
        status: 200,
        url,
        mediaType: "text/plain; charset=utf-8",
        body,
      };
    },
  };
  const requests: ModelRequest[] = [];
  let call = 0;
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "fetch-source", name: "web_fetch" };
        yield { type: "tool_call_delta", id: "fetch-source", json: JSON.stringify({ url }) };
        yield { type: "tool_call_end", id: "fetch-source" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (call === 2) {
        const fetched = request.messages.findLast(
          (message) => message.role === "tool" && message.name === "web_fetch",
        );
        if (fetched?.role === "tool" && fetched.result.status === "failed") {
          throw new Error(JSON.stringify(fetched.result.error));
        }
        order.push("artifact-reference-observed");
        expect(fetched).toMatchObject({
          result: {
            status: "completed",
            output: {
              artifactId,
              byteCount: body.byteLength,
              mediaType: "text/plain",
              text: firstPage,
              nextCursor: "12288",
              truncated: true,
              url,
              citation: { artifactId, url, robotsPolicy: "not_evaluated" },
            },
          },
        });
        yield { type: "tool_call_start", id: "open-source", name: "web_open" };
        yield {
          type: "tool_call_delta",
          id: "open-source",
          json: JSON.stringify({ artifactId, cursor: "12288" }),
        };
        yield { type: "tool_call_end", id: "open-source" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "The immutable Web source was opened." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const tools = await createWebEvidenceToolRegistry({ artifactStore, http });
  const baseStore = createInMemorySessionStore<SessionEventRecord>();
  let rejectedRecord: unknown;
  const store: SessionStore<SessionEventRecord> = {
    async append(record) {
      try {
        await baseStore.append(record);
      } catch (error) {
        rejectedRecord = record;
        throw error;
      }
    },
    async appendBatch(records) {
      try {
        await baseStore.appendBatch(records);
      } catch (error) {
        rejectedRecord = records;
        throw error;
      }
    },
    read: () => baseStore.read(),
  };
  const dependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["network"] }),
    store,
    tools,
    [sessionToolProfileNames]: ["web_fetch", "web_open", "web_find"],
  };
  const session = new AgentSession(dependencies);
  const permissionSubjects: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissionSubjects.push(event.subject);
      session.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    const runResult = await session.run({ text: "Fetch and inspect the Web evidence." });
    if (runResult.status === "failed" && runResult.error.code === "session_persistence_failed") {
      throw new Error(JSON.stringify(rejectedRecord));
    }
    expect(runResult).toEqual({
      status: "completed",
      answer: "The immutable Web source was opened.",
    });
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "web_fetch",
      "web_open",
      "web_find",
    ]);
    expect(permissionSubjects).toEqual([
      {
        type: "web_request",
        operation: "fetch",
        providerOrigin: "https://example.com",
        url,
      },
    ]);
    expect(requests[2]?.messages.findLast((message) => message.role === "tool")).toMatchObject({
      name: "web_open",
      result: {
        status: "completed",
        output: {
          artifactId,
          cursor: "12288",
          text: secondPage,
          nextCursor: null,
          truncated: false,
        },
      },
    });
    expect(order).toEqual(["artifact-written", "artifact-reference-observed"]);
    await expect((await storedArtifacts).read(artifactId)).resolves.toEqual(body);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("a configured SearchProvider exposes one exact-call web_search with durable source IDs", async () => {
  const artifactStore: ArtifactStore = {
    async write() {
      throw new Error("Search snippets must not be published as fetched artifacts.");
    },
    async read() {
      return undefined;
    },
  };
  const store = createInMemoryWebEvidenceStore();
  const searches: unknown[] = [];
  const searchProvider = {
    kind: "searxng" as const,
    origin: "https://search.example.test",
    async search(input: {
      readonly query: string;
      readonly limit: number;
      readonly language?: string;
      readonly timeRange?: "day" | "week" | "month" | "year";
      readonly signal: AbortSignal;
    }) {
      searches.push(input);
      return {
        results: [
          {
            url: "https://docs.example.test/guide",
            title: "Example Guide",
            snippet: "Provider snippet is untrusted evidence.",
            publishedAt: "2026-08-31T00:00:00.000Z",
            engines: ["fixture"],
          },
          {
            url: "not a URL",
            title: "Invalid provider result",
            snippet: "This entry must be omitted without failing the valid result.",
            engines: ["fixture"],
          },
        ],
        partial: false,
      };
    },
  };
  const http: WebHttpAdapter = {
    async fetch() {
      throw new Error("Search must use only its configured provider port.");
    },
  };
  let call = 0;
  let toolResult: unknown;
  const model: ModelDriver = {
    async *stream(request) {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "search-web", name: "web_search" };
        yield {
          type: "tool_call_delta",
          id: "search-web",
          json: '{"query":"exact evidence","limit":5,"language":"en"}',
        };
        yield { type: "tool_call_end", id: "search-web" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      toolResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "Search complete." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const tools = await createWebEvidenceToolRegistry({
    artifactStore,
    http,
    now: () => "2026-09-01T08:00:00.000Z",
    searchProvider,
    store,
  });
  const dependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["network"] }),
    store: createInMemorySessionStore(),
    tools,
    [sessionToolProfileNames]: ["web_search", "web_fetch", "web_open", "web_find"],
  };
  const session = new AgentSession(dependencies);
  const permissionSubjects: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissionSubjects.push(event.subject);
      session.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  await expect(session.run({ text: "Search for exact evidence." })).resolves.toEqual({
    status: "completed",
    answer: "Search complete.",
  });
  expect(tools.definitions().map((definition) => definition.name)).toEqual([
    "web_search",
    "web_fetch",
    "web_open",
    "web_find",
  ]);
  expect(permissionSubjects).toEqual([
    {
      type: "web_request",
      operation: "search",
      providerOrigin: "https://search.example.test",
      query: "exact evidence",
      limit: 5,
      language: "en",
    },
  ]);
  expect(searches).toHaveLength(1);
  expect(toolResult).toMatchObject({
    result: {
      status: "completed",
      output: {
        partial: true,
        omittedResults: 1,
        results: [
          {
            rank: 1,
            sourceId: expect.stringMatching(/^sha256:/u),
            url: "https://docs.example.test/guide",
            title: "Example Guide",
            snippet: "Provider snippet is untrusted evidence.",
            retrievedAt: "2026-09-01T08:00:00.000Z",
            robotsPolicy: "not_evaluated",
            provider: { kind: "searxng", origin: "https://search.example.test" },
          },
        ],
      },
    },
  });
});

test("web_search bounds aggregate serialized results and reports omitted provider evidence", async () => {
  const searchProvider = {
    kind: "searxng" as const,
    origin: "https://search.example.test",
    async search() {
      return {
        results: Array.from({ length: 10 }, (_, index) => ({
          url: `https://docs.example.test/result-${index}`,
          title: `Result ${index}`,
          snippet: "s".repeat(4 * 1024),
          engines: ["fixture"],
        })),
        partial: false,
      };
    },
  };
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("Search metadata must not publish a fetched artifact.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("Search must use only its provider port.");
      },
    },
    now: () => "2026-09-01T08:00:00.000Z",
    searchProvider,
  });
  const search = registry.resolve("web_search");
  const prepared = search?.prepare('{"query":"bounded","limit":10}');
  if (prepared?.status !== "ready") {
    throw new Error("The web_search input was unexpectedly rejected.");
  }
  const result = await prepared.execute({
    callId: "bounded-search",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    signal: new AbortController().signal,
    toolName: "web_search",
    toolProfileDigest: `sha256:${"9".repeat(64)}`,
  });

  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
  expect(result).toMatchObject({
    status: "completed",
    output: { partial: true, omittedResults: expect.any(Number) },
  });
  if (
    result.status !== "completed" ||
    typeof result.output !== "object" ||
    result.output === null
  ) {
    throw new Error("The bounded Web search did not complete.");
  }
  expect((result.output as { readonly omittedResults: number }).omittedResults).toBeGreaterThan(0);
});

test("web_search reports per-field truncation without splitting UTF-8", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: createInMemoryArtifactStoreForWebTest(),
    http: {
      async fetch() {
        throw new Error("Search must use only its provider port.");
      },
    },
    now: () => "2026-09-01T08:00:00.000Z",
    searchProvider: {
      kind: "searxng",
      origin: "https://search.example.test",
      async search() {
        return {
          results: [
            {
              url: "https://docs.example.test/truncated",
              title: "T".repeat(513),
              snippet: `${"s".repeat(4095)}€`,
              publishedAt: "p".repeat(129),
              engines: [
                "😀".repeat(129),
                ...Array.from({ length: 15 }, (_, index) => `engine-${index}`),
                "extra",
              ],
            },
          ],
          partial: false,
        };
      },
    },
  });
  const prepared = registry.resolve("web_search")?.prepare('{"query":"truncate","limit":1}');
  if (prepared?.status !== "ready") {
    throw new Error("The truncation web_search input was unexpectedly rejected.");
  }
  const result = await prepared.execute({
    callId: "truncated-search",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    signal: new AbortController().signal,
    toolName: "web_search",
    toolProfileDigest: `sha256:${"c".repeat(64)}`,
  });

  expect(result).toMatchObject({
    status: "completed",
    output: {
      partial: true,
      results: [
        {
          truncation: { title: true, snippet: true, engines: true, publishedAt: true },
          title: "T".repeat(512),
        },
      ],
    },
  });
  if (result.status !== "completed") {
    throw new Error("The truncation Web search did not complete.");
  }
  const projected = (
    result.output as {
      readonly results: readonly {
        readonly snippet: string;
        readonly engines: readonly string[];
      }[];
    }
  ).results[0];
  const snippet = projected?.snippet;
  expect(snippet).toBe("s".repeat(4095));
  expect(Buffer.byteLength(snippet ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
  expect(snippet).not.toContain("�");
  expect(projected?.engines[0]).toBe("😀".repeat(128));
});

test("web_fetch resolves one durable search source before requesting exact URL permission", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-source-fetch-"));
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const store = createInMemoryWebEvidenceStore();
  const url = "https://docs.example.test/source";
  const sourceId = `sha256:${createHash("sha256").update(url).digest("hex")}` as const;
  await store.appendSearchSource({
    recordType: "search_source",
    schemaVersion: 1,
    sourceId,
    rank: 1,
    url,
    title: "Durable source",
    snippet: "Untrusted snippet",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    robotsPolicy: "not_evaluated",
    engines: ["fixture"],
    providerKind: "searxng",
    providerOrigin: "https://search.example.test",
    queryDigest: `sha256:${"6".repeat(64)}`,
    truncation: { title: false, snippet: false, engines: false, publishedAt: false },
  });
  const fetchedUrls: string[] = [];
  const http: WebHttpAdapter = {
    async fetch(input) {
      fetchedUrls.push(input.url);
      return {
        status: 200,
        url,
        mediaType: "text/plain",
        body: Buffer.from("source body", "utf8"),
      };
    },
  };
  let call = 0;
  let toolResult: unknown;
  const model: ModelDriver = {
    async *stream(request) {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call_start", id: "fetch-source-id", name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: "fetch-source-id",
          json: JSON.stringify({ sourceId }),
        };
        yield { type: "tool_call_end", id: "fetch-source-id" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      toolResult = request.messages.findLast((message) => message.role === "tool");
      yield { type: "text_delta", text: "Fetched durable source." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const tools = await createWebEvidenceToolRegistry({ artifactStore, http, store });
  const dependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["network"] }),
    store: createInMemorySessionStore(),
    tools,
    [sessionToolProfileNames]: ["web_fetch", "web_open", "web_find"],
  };
  const session = new AgentSession(dependencies);
  const permissionSubjects: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissionSubjects.push(event.subject);
      session.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  try {
    await session.run({ text: "Fetch the exact durable source." });
    expect(permissionSubjects).toEqual([
      {
        type: "web_request",
        operation: "fetch",
        providerOrigin: "https://docs.example.test",
        url,
      },
    ]);
    expect(fetchedUrls).toEqual([url]);
    expect(toolResult).toMatchObject({
      result: { status: "completed", output: { sourceId, url, text: "source body" } },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("web_fetch rejects an unknown durable source ID without throwing or requesting permission", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("An unknown source must not publish an artifact.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("An unknown source must not reach the HTTP Adapter.");
      },
    },
  });
  const sourceId = `sha256:${"1".repeat(64)}`;

  expect(() => registry.resolve("web_fetch")?.prepare(JSON.stringify({ sourceId }))).not.toThrow();
  expect(registry.resolve("web_fetch")?.prepare(JSON.stringify({ sourceId }))).toEqual({
    status: "failed",
    error: { code: "web_source_unavailable", message: "The durable Web source is unavailable." },
  });
});

test("Web query and find limits count UTF-8 bytes rather than UTF-16 code units", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("The byte-bound test does not execute tools.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("The byte-bound test does not execute tools.");
      },
    },
    searchProvider: {
      kind: "searxng",
      origin: "https://search.example.test",
      async search() {
        return { results: [], partial: false };
      },
    },
  });

  expect(
    registry.resolve("web_search")?.prepare(JSON.stringify({ query: "😀".repeat(1025) })),
  ).toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
  expect(
    registry
      .resolve("web_find")
      ?.prepare(JSON.stringify({ artifactId: `sha256:${"2".repeat(64)}`, text: "😀".repeat(257) })),
  ).toMatchObject({ status: "failed", error: { code: "invalid_tool_input" } });
});

test("web_open fits JSON-escaped control text inside the serialized result bound", async () => {
  const bytes = Buffer.from("\n".repeat(20 * 1024), "utf8");
  const artifactId = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const store = createInMemoryWebEvidenceStore();
  await store.append({
    schemaVersion: 1,
    fetchId: `sha256:${"8".repeat(64)}`,
    artifactId,
    byteCount: bytes.byteLength,
    mediaType: "text/plain",
    sourceId: `sha256:${"3".repeat(64)}`,
    url: "https://example.com/escaped",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    provenance: "web_fetch",
  });
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("The page test uses a pre-existing artifact.");
      },
      async read(id) {
        return id === artifactId ? bytes : undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("web_open must not perform network access.");
      },
    },
    store,
  });
  const prepared = registry.resolve("web_open")?.prepare(JSON.stringify({ artifactId }));
  if (prepared?.status !== "ready") {
    throw new Error("The escaped web_open input was unexpectedly rejected.");
  }
  const result = await prepared.execute({
    callId: "escaped-open",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    signal: new AbortController().signal,
    toolName: "web_open",
    toolProfileDigest: `sha256:${"4".repeat(64)}`,
  });

  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
  expect(result).toMatchObject({
    status: "completed",
    output: { nextCursor: expect.stringMatching(/^[1-9][0-9]*$/u), truncated: true },
  });
});

test("web_open recovers immutable source truth from the WebEvidence store without refetching", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-evidence-restart-"));
  const artifactStore = await createFileArtifactStore({ root: join(testRoot, "artifacts") });
  const webStore = createInMemoryWebEvidenceStore();
  const url = "https://example.com/restart.txt";
  const body = Buffer.from("durable Web evidence", "utf8");
  const artifactId = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  let httpCalls = 0;
  const http: WebHttpAdapter = {
    async fetch() {
      httpCalls += 1;
      return { status: 200, url, mediaType: "text/plain", body };
    },
  };
  const runWithTool = async (input: {
    readonly name: "web_fetch" | "web_open";
    readonly argumentsJson: string;
    readonly tools: Awaited<ReturnType<typeof createWebEvidenceToolRegistry>>;
  }) => {
    let call = 0;
    let result: unknown;
    const model: ModelDriver = {
      async *stream(request) {
        call += 1;
        if (call === 1) {
          yield { type: "tool_call_start", id: `restart-${input.name}`, name: input.name };
          yield {
            type: "tool_call_delta",
            id: `restart-${input.name}`,
            json: input.argumentsJson,
          };
          yield { type: "tool_call_end", id: `restart-${input.name}` };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        result = request.messages.findLast((message) => message.role === "tool");
        yield { type: "text_delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const dependencies: AgentSessionDependencies & {
      readonly [sessionToolProfileNames]: readonly string[];
    } = {
      contextProfile,
      model,
      permissions: createPermissionPolicy({ allowedEffects: ["read", "network"] }),
      store: createInMemorySessionStore(),
      tools: input.tools,
      [sessionToolProfileNames]: ["web_fetch", "web_open", "web_find"],
    };
    await new AgentSession(dependencies).run({ text: "Use the exact Web tool." });
    return result;
  };

  try {
    await runWithTool({
      name: "web_fetch",
      argumentsJson: JSON.stringify({ url }),
      tools: await createWebEvidenceToolRegistry({ artifactStore, http, store: webStore }),
    });
    const opened = await runWithTool({
      name: "web_open",
      argumentsJson: JSON.stringify({ artifactId }),
      tools: await createWebEvidenceToolRegistry({ artifactStore, http, store: webStore }),
    });
    expect(opened).toMatchObject({
      result: {
        status: "completed",
        output: { artifactId, text: "durable Web evidence", truncated: false },
      },
    });
    expect(httpCalls).toBe(1);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Web Search configuration fails closed for missing, null, unsafe, or invalid owner state", async () => {
  let stored:
    | { readonly status: "available"; readonly text: string }
    | { readonly status: "missing" }
    | { readonly status: "unsafe" } = { status: "missing" };
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return stored;
    },
    async write(text) {
      stored = { status: "available", text };
    },
  });

  await expect(configuration.load()).resolves.toEqual({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: null,
    diagnostic: null,
  });
  stored = { status: "available", text: '{"schemaVersion":1,"searchProvider":null}\n' };
  await expect(configuration.load()).resolves.toEqual({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: null,
    diagnostic: null,
  });
  stored = { status: "unsafe" };
  await expect(configuration.load()).resolves.toMatchObject({
    status: "unsafe",
    provider: null,
    diagnostic: { code: "web_search_configuration_unsafe" },
  });
  for (const text of [
    '{"schemaVersion":1,"searchProvider":null,"unknown":true}\n',
    '{"schemaVersion":1,"searchProvider":null,"searchProvider":null}\n',
    '{"schemaVersion":1,"searchProvider":{"kind":"searxng","endpoint":"http://search.example/search","activation":{"protocol":"searxng-json.v1","endpointDigest":"sha256:bad"}}}\n',
  ]) {
    stored = { status: "available", text };
    await expect(configuration.load()).resolves.toMatchObject({
      status: "invalid",
      provider: null,
      diagnostic: { code: "web_search_configuration_invalid" },
    });
  }
});

test("a tested SearXNG endpoint activates atomically for restart and clear writes exact null", async () => {
  let text: string | undefined;
  const storage = {
    async read() {
      return text === undefined
        ? ({ status: "missing" } as const)
        : ({ status: "available", text } as const);
    },
    async write(next: string) {
      text = next;
    },
  };
  const configuration = createWebSearchConfigurationWithStorageForTesting(storage);
  const endpoint = "https://search.example.test/search";

  const activated = await configuration.activateSearxng(endpoint);
  expect(activated).toEqual({
    status: "configured",
    provider: {
      kind: "searxng",
      endpoint,
      activation: {
        protocol: "searxng-json.v1",
        endpointDigest: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`,
      },
    },
    syntheticDnsRange: null,
    diagnostic: null,
  });
  await expect(createWebSearchConfigurationWithStorageForTesting(storage).load()).resolves.toEqual(
    activated,
  );
  expect(text).toBe(
    `${JSON.stringify({ schemaVersion: 2, searchProvider: activated.provider, syntheticDnsRange: null })}\n`,
  );

  await expect(configuration.clear()).resolves.toEqual({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: null,
    diagnostic: null,
  });
  expect(text).toBe('{"schemaVersion":2,"searchProvider":null,"syntheticDnsRange":null}\n');
});

test("owner Web configuration admits only a normalized 198.18/15 synthetic DNS subnet", async () => {
  let text: string | undefined;
  const storage = {
    async read() {
      return text === undefined
        ? ({ status: "missing" } as const)
        : ({ status: "available", text } as const);
    },
    async write(next: string) {
      text = next;
    },
  };
  const configuration = createWebSearchConfigurationWithStorageForTesting(storage);

  await expect(configuration.setSyntheticDnsRange("198.18.5.220/16")).resolves.toEqual({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: "198.18.0.0/16",
    diagnostic: null,
  });
  expect(text).toBe(
    '{"schemaVersion":2,"searchProvider":null,"syntheticDnsRange":"198.18.0.0/16"}\n',
  );
  await expect(createWebSearchConfigurationWithStorageForTesting(storage).load()).resolves.toEqual({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: "198.18.0.0/16",
    diagnostic: null,
  });
  const endpoint = "https://search.example.test/search";
  await expect(configuration.activateSearxng(endpoint)).resolves.toMatchObject({
    status: "configured",
    provider: { endpoint },
    syntheticDnsRange: "198.18.0.0/16",
  });
  await expect(configuration.clear()).resolves.toMatchObject({
    status: "unconfigured",
    provider: null,
    syntheticDnsRange: "198.18.0.0/16",
  });

  for (const range of [
    "198.18.0.0/14",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "0.0.0.0/0",
    "fd00::/8",
    "not-a-cidr",
  ]) {
    await expect(configuration.setSyntheticDnsRange(range), range).rejects.toThrow(
      "inside 198.18.0.0/15",
    );
  }
  await expect(configuration.setSyntheticDnsRange(null)).resolves.toMatchObject({
    syntheticDnsRange: null,
  });
});

test("concurrent Web provider activation cannot resurrect a revoked synthetic DNS range", async () => {
  let text = '{"schemaVersion":2,"searchProvider":null,"syntheticDnsRange":"198.18.0.0/16"}\n';
  let reads = 0;
  let exclusiveCalls = 0;
  let exclusiveTail: Promise<unknown> = Promise.resolve();
  const bothUnlockedReads = Promise.withResolvers<void>();
  const revokedWrite = Promise.withResolvers<void>();
  const storage = {
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      exclusiveCalls += 1;
      const result = exclusiveTail.then(operation, operation);
      exclusiveTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async read() {
      const captured = text;
      if (exclusiveCalls === 0) {
        reads += 1;
        if (reads === 2) {
          bothUnlockedReads.resolve();
        }
        await bothUnlockedReads.promise;
      }
      return { status: "available" as const, text: captured };
    },
    async write(next: string) {
      const parsed = JSON.parse(next) as {
        readonly searchProvider: unknown;
        readonly syntheticDnsRange: string | null;
      };
      if (exclusiveCalls === 0 && parsed.searchProvider !== null) {
        await revokedWrite.promise;
      }
      text = next;
      if (parsed.searchProvider === null && parsed.syntheticDnsRange === null) {
        revokedWrite.resolve();
      }
    },
  };
  const configuration = createWebSearchConfigurationWithStorageForTesting(storage);

  await Promise.all([
    configuration.activateSearxng("https://search.example.test/search"),
    configuration.setSyntheticDnsRange(null),
  ]);

  expect(exclusiveCalls).toBe(2);
  await expect(configuration.load()).resolves.toMatchObject({
    status: "configured",
    provider: { endpoint: "https://search.example.test/search" },
    syntheticDnsRange: null,
  });
});

test("SearXNG endpoint admission permits only public HTTPS or exact literal loopback HTTP", async () => {
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "missing" };
    },
    async write() {},
  });

  await expect(
    configuration.activateSearxng("http://127.0.0.1:8080/search"),
  ).resolves.toMatchObject({ provider: { endpoint: "http://127.0.0.1:8080/search" } });
  await expect(configuration.activateSearxng("http://[::1]:8080/search")).resolves.toMatchObject({
    provider: { endpoint: "http://[::1]:8080/search" },
  });
  for (const endpoint of [
    "http://search.example.test/search",
    "https://search.example.test:8443/search",
    "https://user@search.example.test/search",
    "http://localhost:8080/search",
    "http://127.0.0.1:8080/other",
    "https://10.0.0.1/search",
    "https://169.254.1.1/search",
    "https://[fc00::1]/search",
    "https://[fe80::1]/search",
    `https://search.example.test/${"é".repeat(3_000)}`,
  ]) {
    await expect(configuration.activateSearxng(endpoint), endpoint).rejects.toThrow(
      "not admitted by the Web policy",
    );
  }
});

test("the fixed SearXNG connection test commits only a valid successful candidate", async () => {
  const priorEndpoint = "https://prior-search.example.test/search";
  const priorDigest = `sha256:${createHash("sha256").update(priorEndpoint).digest("hex")}`;
  let text = `${JSON.stringify({
    schemaVersion: 1,
    searchProvider: {
      kind: "searxng",
      endpoint: priorEndpoint,
      activation: { protocol: "searxng-json.v1", endpointDigest: priorDigest },
    },
  })}\n`;
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "available", text };
    },
    async write(next) {
      text = next;
    },
  });
  const candidate = "https://candidate-search.example.test/search";
  const requests: string[] = [];
  let valid = false;
  const http: WebHttpAdapter = {
    async fetch(input) {
      requests.push(input.url);
      return {
        status: 200,
        url: input.url,
        mediaType: "application/json",
        body: Buffer.from(valid ? '{"results":[]}' : '{"invalid":true}', "utf8"),
      };
    },
  };
  const before = text;

  await expect(
    configuration.testAndActivateSearxng({
      endpoint: candidate,
      http,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "search_provider_invalid" });
  expect(text).toBe(before);
  valid = true;
  await expect(
    configuration.testAndActivateSearxng({
      endpoint: candidate,
      http,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ status: "configured", provider: { endpoint: candidate } });
  expect(requests).toEqual([
    `${candidate}?q=adam-agent-connection-test&format=json`,
    `${candidate}?q=adam-agent-connection-test&format=json`,
  ]);
  await expect(configuration.load()).resolves.toMatchObject({
    status: "configured",
    provider: { endpoint: candidate },
  });
});

test("a cancelled successful SearXNG connection response leaves prior configuration bytes unchanged", async () => {
  let text = '{"schemaVersion":1,"searchProvider":null}\n';
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "available", text };
    },
    async write(next) {
      text = next;
    },
  });
  const controller = new AbortController();
  const before = text;

  await expect(
    configuration.testAndActivateSearxng({
      endpoint: "https://cancelled-search.example.test/search",
      http: {
        async fetch(input) {
          controller.abort(new DOMException("Cancelled after response.", "AbortError"));
          return {
            status: 200,
            url: input.url,
            mediaType: "application/json",
            body: Buffer.from('{"results":[]}', "utf8"),
          };
        },
      },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(text).toBe(before);
});

test("SearXNG cancellation before atomic rename leaves prior bytes unchanged", async () => {
  let text = '{"schemaVersion":1,"searchProvider":null}\n';
  const writeStarted = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "available", text };
    },
    async write(next, options) {
      writeStarted.resolve();
      await releaseWrite.promise;
      options?.beforeCommit?.();
      text = next;
    },
  });
  const controller = new AbortController();
  const before = text;
  const result = configuration.testAndActivateSearxng({
    endpoint: "https://cancel-before-rename.example.test/search",
    http: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from('{"results":[]}', "utf8"),
        };
      },
    },
    signal: controller.signal,
  });
  await writeStarted.promise;
  controller.abort(new DOMException("Cancel before rename.", "AbortError"));
  releaseWrite.resolve();

  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(text).toBe(before);
});

test("SearXNG commit remains truthful when cancellation arrives after the rename point", async () => {
  let text = '{"schemaVersion":1,"searchProvider":null}\n';
  const commitStarted = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "available", text };
    },
    async write(next, options) {
      options?.beforeCommit?.();
      commitStarted.resolve();
      await releaseCommit.promise;
      text = next;
    },
  });
  const controller = new AbortController();
  const result = configuration.testAndActivateSearxng({
    endpoint: "https://commit-started.example.test/search",
    http: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from('{"results":[]}', "utf8"),
        };
      },
    },
    signal: controller.signal,
  });
  await commitStarted.promise;
  controller.abort(new DOMException("Cancel after commit point.", "AbortError"));
  releaseCommit.resolve();

  await expect(result).resolves.toMatchObject({ status: "configured" });
  await expect(configuration.load()).resolves.toMatchObject({
    status: "configured",
    provider: { endpoint: "https://commit-started.example.test/search" },
  });
});

test("new SessionLifecycle Tool Profiles reflect unconfigured, configured, then cleared Web Search", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-profile-lifecycle-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const endpoint = "https://search.example.test/search";
  const configuredProvider = {
    kind: "searxng",
    endpoint,
    activation: {
      protocol: "searxng-json.v1",
      endpointDigest: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`,
    },
  } as const;
  let configurationSnapshot:
    | { readonly status: "unconfigured"; readonly provider: null; readonly diagnostic: null }
    | {
        readonly status: "configured";
        readonly provider: typeof configuredProvider;
        readonly diagnostic: null;
      } = { status: "unconfigured", provider: null, diagnostic: null };
  let searchHistorical = false;
  let historicalCall = 0;
  let historicalTools: readonly string[] = [];
  let historicalToolResult: unknown;
  const model: ModelDriver = {
    async *stream(request) {
      if (searchHistorical && request.purpose !== "title") {
        historicalCall += 1;
        historicalTools = request.tools.map((tool) => tool.name);
        if (historicalCall === 1) {
          yield { type: "tool_call_start", id: "historical-search", name: "web_search" };
          yield {
            type: "tool_call_delta",
            id: "historical-search",
            json: '{"query":"historical endpoint"}',
          };
          yield { type: "tool_call_end", id: "historical-search" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        historicalToolResult = request.messages.findLast((message) => message.role === "tool");
        yield { type: "text_delta", text: "Historical search stayed bound." };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const targetIdentity = {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver: model, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "network"] }),
    stateRoot,
    webHttp: {
      async fetch() {
        throw new Error("Profile creation must not perform network access.");
      },
    },
    webSearchConfiguration: {
      async load() {
        return configurationSnapshot;
      },
    },
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });

  try {
    const unconfigured = await lifecycle.create({ targetIdentity });
    expect(
      unconfigured.promptContext?.toolProfile.definitions.map(({ name }) => name),
    ).not.toContain("web_search");
    configurationSnapshot = {
      status: "configured",
      provider: configuredProvider,
      diagnostic: null,
    };
    const configured = await lifecycle.create({ targetIdentity });
    expect(configured.promptContext?.toolProfile.definitions.map(({ name }) => name)).toContain(
      "web_search",
    );
    configurationSnapshot = { status: "unconfigured", provider: null, diagnostic: null };
    const cleared = await lifecycle.create({ targetIdentity });
    expect(cleared.promptContext?.toolProfile.definitions.map(({ name }) => name)).not.toContain(
      "web_search",
    );
    searchHistorical = true;
    await lifecycle.continue({
      sessionId: configured.sessionId,
      input: { text: "Use the historical Web Search profile." },
    });
    expect(historicalTools).toContain("web_search");
    expect(historicalToolResult).toMatchObject({
      result: { status: "failed", error: { code: "web_provider_unavailable" } },
    });
  } finally {
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation exposes Web Search configuration and commits only an explicit tested endpoint", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-presentation-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const environment = { XDG_CONFIG_HOME: join(testRoot, "config") };
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity: {
          targetId: "deepseek-v4-flash.direct",
          vendor: "deepseek",
          modelId: "deepseek-v4-flash",
          route: "direct",
          profileVersion: 1,
          certification: "certified",
        },
        driver: {
          async *stream() {
            yield { type: "finish", reason: "stop" };
          },
        },
        contextProfile,
      };
    },
    async snapshot() {
      return { targets: [] };
    },
  };
  const webConfiguration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "missing" };
    },
    async write() {},
  });
  const lifecycle = createSessionLifecycle({
    modelTargets,
    stateRoot,
    webSearchConfiguration: webConfiguration,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const endpoint = "https://search.example.test/search";
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    openProject: true,
    projectLabel: "Web project",
    stateRoot,
    webHttp: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from('{"results":[]}', "utf8"),
        };
      },
    },
    webSearchEnvironment: environment,
    workspaceRoot,
  });

  try {
    expect(presentation.getState().authoritative.targets.configuration?.webSearch).toMatchObject({
      status: "Unconfigured",
      endpoint: null,
      syntheticDnsRange: null,
    });
    await expect(
      presentation.dispatch({
        type: "set_web_synthetic_dns_range",
        range: "198.18.0.0/14",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "invalid_command",
      message: "The synthetic DNS range must be an IPv4 CIDR subnet inside 198.18.0.0/15.",
    });
    await expect(
      presentation.dispatch({
        type: "set_web_synthetic_dns_range",
        range: "198.18.0.0/16",
      }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.targets.configuration?.webSearch).toMatchObject({
      syntheticDnsRange: "198.18.0.0/16",
    });
    await expect(
      presentation.dispatch({ type: "test_and_set_web_search", endpoint }),
    ).resolves.toMatchObject({ status: "admitted" });
    expect(presentation.getState().authoritative.targets.configuration?.webSearch).toMatchObject({
      status: "Configured",
      endpoint,
      syntheticDnsRange: "198.18.0.0/16",
    });
    await expect(presentation.dispatch({ type: "clear_web_search" })).resolves.toMatchObject({
      status: "admitted",
    });
    expect(presentation.getState().authoritative.targets.configuration?.webSearch).toMatchObject({
      status: "Unconfigured",
      endpoint: null,
      syntheticDnsRange: "198.18.0.0/16",
    });
    await expect(
      presentation.dispatch({ type: "set_web_synthetic_dns_range", range: null }),
    ).resolves.toMatchObject({ status: "admitted" });
  } finally {
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("Presentation close aborts and joins a held Web Search connection test without persistence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-presentation-close-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const environment = { XDG_CONFIG_HOME: join(testRoot, "config") };
  await mkdir(workspaceRoot);
  const modelTargets: ModelTargets = {
    async resolve() {
      throw new Error("The close test does not create a model session.");
    },
    async snapshot() {
      return { targets: [] };
    },
  };
  const lifecycle = createSessionLifecycle({
    stateRoot,
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const requestStarted = Promise.withResolvers<void>();
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    openProject: true,
    projectLabel: "Web close project",
    stateRoot,
    webHttp: {
      fetch(input) {
        requestStarted.resolve();
        return new Promise((_, reject) => {
          const rejectAbort = () => reject(input.signal.reason);
          if (input.signal.aborted) {
            rejectAbort();
          } else {
            input.signal.addEventListener("abort", rejectAbort, { once: true });
          }
        });
      },
    },
    webSearchEnvironment: environment,
    workspaceRoot,
  });

  try {
    const command = presentation.dispatch({
      type: "test_and_set_web_search",
      endpoint: "https://held-search.example.test/search",
    });
    await requestStarted.promise;
    await presentation.close();
    await expect(command).resolves.toMatchObject({ status: "rejected" });
    await expect(
      readFile(join(environment.XDG_CONFIG_HOME, "adam-agent", "web.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("real Lifecycle and Presentation expose exact Web permission and settled search card", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-presentation-card-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);
  const endpoint = "https://search.example.test/search";
  const provider = {
    kind: "searxng",
    endpoint,
    activation: {
      protocol: "searxng-json.v1",
      endpointDigest: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`,
    },
  } as const;
  let ordinaryCall = 0;
  const driver: ModelDriver = {
    async *stream(request) {
      if (request.purpose === "title") {
        yield { type: "text_delta", text: "Web evidence" };
        yield { type: "finish", reason: "stop" };
        return;
      }
      ordinaryCall += 1;
      if (ordinaryCall === 1) {
        yield { type: "tool_call_start", id: "presentation-web-search", name: "web_search" };
        yield {
          type: "tool_call_delta",
          id: "presentation-web-search",
          json: '{"query":"exact card evidence","limit":1,"language":"en"}',
        };
        yield { type: "tool_call_end", id: "presentation-web-search" };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "The Web evidence card settled." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const targetIdentity = {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 1,
    certification: "certified",
  } as const;
  const modelTargets: ModelTargets = {
    async resolve() {
      return { identity: targetIdentity, driver, contextProfile };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity: targetIdentity,
            readiness: { status: "available", credentialSource: "deterministic test" },
            contextProfile,
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["network"] }),
    stateRoot,
    webHttp: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json",
          body: Buffer.from(
            JSON.stringify({
              results: [
                {
                  url: "https://docs.example.test/card",
                  title: "Card evidence",
                  content: "Untrusted card snippet",
                  publishedDate: null,
                  engines: ["fixture"],
                  score: 1,
                },
              ],
            }),
            "utf8",
          ),
        };
      },
    },
    webSearchConfiguration: {
      async load() {
        return { status: "configured", provider, diagnostic: null };
      },
    },
    workspaceRoot,
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
  });
  const created = await lifecycle.create({ targetIdentity });
  const presentation = await createPresentationSession({
    lifecycle,
    modelTargets,
    projectLabel: "Web card project",
    sessionId: created.sessionId,
    stateRoot,
    workspaceRoot,
  });
  const permissionSeen = Promise.withResolvers<void>();
  const unsubscribe = presentation.subscribe(() => {
    if ((presentation.getState().authoritative.active?.pendingInteractions.length ?? 0) > 0) {
      permissionSeen.resolve();
    }
  });

  try {
    const run = lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Search for exact card evidence." },
    });
    await permissionSeen.promise;
    const pending = presentation.getState().authoritative.active?.pendingInteractions[0];
    expect(pending).toMatchObject({
      type: "permission",
      effect: "network",
      subject: {
        value: expect.stringContaining(
          'https://search.example.test · query "exact card evidence" · limit 1 · language "en"',
        ),
      },
      warning: expect.stringContaining("public operator"),
    });
    if (pending?.type !== "permission") {
      throw new Error("The real Web permission interaction was unavailable.");
    }
    await presentation.dispatch({
      type: "decide_permission",
      requestId: pending.requestId,
      decision: "allow",
    });
    await run;
    const card = presentation
      .getState()
      .authoritative.active?.transcript.items.find(
        (item) => item.type === "tool_call" && item.qualifiedName === "web_search",
      );
    expect(card).toMatchObject({
      type: "tool_call",
      kind: "web",
      label: "web search",
      status: "completed",
      resultSummary: "1 Web source",
      subject: { value: expect.stringContaining("https://search.example.test") },
    });
  } finally {
    unsubscribe();
    await presentation.close();
    await lifecycle.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the SearXNG Adapter sends one bounded JSON request and normalizes partial engine results", async () => {
  const requests: unknown[] = [];
  const provider = createSearxngAdapterForTesting({
    endpoint: "https://search.example.test/search",
    http: {
      async fetch(input) {
        requests.push(input);
        return {
          status: 200,
          url: input.url,
          mediaType: "application/json; charset=utf-8",
          body: Buffer.from(
            JSON.stringify({
              results: [
                {
                  url: "https://docs.example.test/result",
                  title: "SearXNG result",
                  content: "Untrusted provider snippet",
                  publishedDate: null,
                  engines: ["fixture-engine"],
                  score: 1,
                  category: "general",
                  parsed_url: ["https", "docs.example.test", "/result", "", "", ""],
                  positions: [1],
                },
              ],
              unresponsive_engines: [["slow-engine", "timeout"]],
            }),
            "utf8",
          ),
        };
      },
    },
  });

  await expect(
    provider.search({
      query: "causal evidence",
      limit: 5,
      language: "en",
      timeRange: "week",
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    results: [
      {
        url: "https://docs.example.test/result",
        title: "SearXNG result",
        snippet: "Untrusted provider snippet",
        engines: ["fixture-engine"],
      },
    ],
    partial: true,
  });
  expect(requests).toEqual([
    expect.objectContaining({
      url: "https://search.example.test/search?q=causal+evidence&format=json&language=en&time_range=week",
      maximumBytes: 1024 * 1024,
      maximumRedirects: 0,
    }),
  ]);
});

test("the SearXNG Adapter rejects a response that moved away from its exact configured request", async () => {
  const provider = createSearxngAdapterForTesting({
    endpoint: "https://search.example.test/search",
    http: {
      async fetch() {
        return {
          status: 200,
          url: "https://other.example.test/search?q=evidence&format=json",
          mediaType: "application/json",
          body: Buffer.from('{"results":[]}', "utf8"),
        };
      },
    },
  });

  await expect(
    provider.search({
      query: "evidence",
      limit: 5,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "search_provider_invalid" });
});

test.each([
  { status: 403, body: '{"results":[]}', expectedCode: "search_json_disabled" },
  { status: 503, body: '{"results":[]}', expectedCode: "search_provider_transient" },
  { status: 200, body: '{"unexpected":[]}', expectedCode: "search_provider_invalid" },
] as const)(
  "the SearXNG Adapter classifies $status responses as $expectedCode",
  async ({ body, expectedCode, status }) => {
    const provider = createSearxngAdapterForTesting({
      endpoint: "https://search.example.test/search",
      http: {
        async fetch(input) {
          return {
            status,
            url: input.url,
            mediaType: "application/json",
            body: Buffer.from(body, "utf8"),
          };
        },
      },
    });

    await expect(
      provider.search({
        query: "evidence",
        limit: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: expectedCode });
  },
);

test("the production WebEvidence factory has one closed searxng branch and no implicit provider", async () => {
  const artifactStore: ArtifactStore = {
    async write() {
      throw new Error("The factory test does not execute a Web tool.");
    },
    async read() {
      return undefined;
    },
  };
  const http: WebHttpAdapter = {
    async fetch() {
      throw new Error("The factory test does not perform network access.");
    },
  };
  const unconfigured = await createWebEvidenceProduction({
    artifactStore,
    configuration: { status: "unconfigured", provider: null, diagnostic: null },
    http,
    store: createInMemoryWebEvidenceStore(),
  });
  expect(unconfigured.definitions().map((definition) => definition.name)).toEqual([
    "web_fetch",
    "web_open",
    "web_find",
  ]);
  const endpoint = "https://search.example.test/search";
  const configured = await createWebEvidenceProduction({
    artifactStore,
    configuration: {
      status: "configured",
      provider: {
        kind: "searxng",
        endpoint,
        activation: {
          protocol: "searxng-json.v1",
          endpointDigest: `sha256:${createHash("sha256").update(endpoint).digest("hex")}`,
        },
      },
      diagnostic: null,
    },
    http,
    store: createInMemoryWebEvidenceStore(),
  });
  expect(configured.definitions().map((definition) => definition.name)).toEqual([
    "web_search",
    "web_fetch",
    "web_open",
    "web_find",
  ]);
});

test("Web transport binds public DNS, explicit hostname-only synthetic DNS, or exact loopback", async () => {
  const lookups: string[] = [];
  const resolver = {
    async lookup(hostname: string) {
      lookups.push(hostname);
      return hostname === "mixed.example.test"
        ? [
            { address: "93.184.216.34", family: 4 as const },
            { address: "10.0.0.1", family: 4 as const },
          ]
        : [{ address: "93.184.216.34", family: 4 as const }];
    },
  };

  await expect(
    resolveWebTargetForTesting({ url: "https://public.example.test/evidence", resolver }),
  ).resolves.toMatchObject({
    address: "93.184.216.34",
    family: 4,
    origin: "https://public.example.test",
  });
  await expect(
    resolveWebTargetForTesting({ url: "https://mixed.example.test/evidence", resolver }),
  ).rejects.toMatchObject({ code: "web_address_disallowed" });
  await expect(
    resolveWebTargetForTesting({ url: "https://10.0.0.1/evidence", resolver }),
  ).rejects.toMatchObject({ code: "web_address_disallowed" });
  await expect(
    resolveWebTargetForTesting({ url: "http://127.0.0.1:8080/search", resolver }),
  ).rejects.toMatchObject({ code: "web_address_disallowed" });
  await expect(
    resolveWebTargetForTesting({
      url: "http://127.0.0.1:8080/search?q=test&format=json",
      allowedLoopbackOrigin: "http://127.0.0.1:8080",
      resolver,
    }),
  ).resolves.toMatchObject({ address: "127.0.0.1", family: 4 });
  expect(lookups).toEqual(["public.example.test", "mixed.example.test"]);

  const syntheticResolver = {
    async lookup() {
      return [{ address: "198.18.5.220", family: 4 as const }];
    },
  };
  await expect(
    resolveWebTargetForTesting({
      url: "https://synthetic.example.test/evidence",
      resolver: syntheticResolver,
    }),
  ).rejects.toMatchObject({ code: "web_synthetic_dns_unconfigured" });
  await expect(
    resolveWebTargetForTesting({
      url: "https://synthetic.example.test/evidence",
      allowedHostnameRanges: ["198.18.0.0/16"],
      resolver: syntheticResolver,
    }),
  ).resolves.toMatchObject({ address: "198.18.5.220", family: 4 });
  await expect(
    resolveWebTargetForTesting({
      url: "http://synthetic.example.test/evidence",
      allowedHostnameRanges: ["198.18.0.0/16"],
      resolver: syntheticResolver,
    }),
  ).rejects.toMatchObject({ code: "web_synthetic_dns_https_required" });
  await expect(
    resolveWebTargetForTesting({
      url: "https://198.18.5.220/evidence",
      allowedHostnameRanges: ["198.18.0.0/16"],
      resolver: syntheticResolver,
    }),
  ).rejects.toMatchObject({ code: "web_address_disallowed" });
});

test("web_fetch explains the exact synthetic DNS opt-in before making a request", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: createInMemoryArtifactStoreForWebTest(),
    http: createSafeWebHttpAdapter({
      resolver: {
        async lookup() {
          return [{ address: "198.18.5.220", family: 4 }];
        },
      },
    }),
  });
  const prepared = registry
    .resolve("web_fetch")
    ?.prepare(JSON.stringify({ url: "https://synthetic.example.test/evidence" }));
  if (prepared?.status !== "ready") {
    throw new Error("The synthetic-DNS URL did not reach Web transport execution.");
  }

  await expect(
    prepared.execute({
      callId: "synthetic-dns-guidance",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_fetch",
      toolProfileDigest: `sha256:${"c".repeat(64)}`,
    }),
  ).resolves.toEqual({
    status: "failed",
    error: {
      code: "web_response_invalid",
      message:
        "The Web target uses 198.18.0.0/15 synthetic DNS. If this host intentionally uses an Owner-trusted TUN/fake-IP proxy, configure its exact subnet from the TUI with /config web-fake-ip, then retry.",
    },
  });
});

test("the aggregate Web deadline includes DNS resolution before any connection", async () => {
  const lookupStarted = Promise.withResolvers<void>();
  const lookup =
    Promise.withResolvers<readonly { readonly address: string; readonly family: 4 }[]>();
  const deadline = new AbortController();
  const adapter = createSafeWebHttpAdapter({
    deadlineSignal: deadline.signal,
    resolver: {
      lookup() {
        lookupStarted.resolve();
        return lookup.promise;
      },
    },
  });
  const result = adapter.fetch({
    url: "https://dns-deadline.example.test/evidence",
    maximumBytes: 1024,
    signal: new AbortController().signal,
  });
  await lookupStarted.promise;
  deadline.abort(new DOMException("Fixture DNS deadline.", "TimeoutError"));
  lookup.reject(new Error("Resolver released after deadline."));

  await expect(result).rejects.toMatchObject({ code: "web_deadline_exceeded" });
});

test("HTML extraction decodes text while excluding active and non-content elements", () => {
  const html = Buffer.from(
    [
      "<!doctype html><html><head><title>Evidence title</title>",
      "<style>.secret{display:none}</style><script>steal()</script></head>",
      "<body><main><h1>Evidence</h1><p>Alpha &amp; beta</p>",
      "<p>Second <strong>line</strong></p></main><noscript>fallback</noscript></body></html>",
    ].join(""),
    "utf8",
  );

  expect(extractWebTextForTesting("text/html; charset=utf-8", html)).toEqual({
    mediaType: "text/plain",
    text: "Evidence title\nEvidence\nAlpha & beta\nSecond line",
  });
});

test("web_open cursors never split a UTF-8 scalar between immutable pages", async () => {
  const text = `${"a".repeat(12 * 1024 - 1)}😀tail`;
  const bytes = Buffer.from(text, "utf8");
  const artifactId = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const artifactStore: ArtifactStore = {
    async write() {
      throw new Error("The paging test uses one pre-existing immutable artifact.");
    },
    async read(id) {
      return id === artifactId ? bytes : undefined;
    },
  };
  const store = createInMemoryWebEvidenceStore();
  await store.append({
    schemaVersion: 1,
    fetchId: `sha256:${"9".repeat(64)}`,
    artifactId,
    byteCount: bytes.byteLength,
    mediaType: "text/plain",
    sourceId: `sha256:${"c".repeat(64)}`,
    url: "https://example.com/unicode",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    provenance: "web_fetch",
  });
  const registry = await createWebEvidenceToolRegistry({
    artifactStore,
    http: {
      async fetch() {
        throw new Error("web_open must not perform network access.");
      },
    },
    store,
  });
  const open = registry.resolve("web_open");
  if (open === undefined) {
    throw new Error("The Web registry omitted web_open.");
  }
  const executeOpen = async (cursor?: string) => {
    const prepared = open.prepare(
      JSON.stringify({ artifactId, ...(cursor === undefined ? {} : { cursor }) }),
    );
    if (prepared.status !== "ready") {
      throw new Error("The web_open input was unexpectedly rejected.");
    }
    return prepared.execute({
      callId: `open-${cursor ?? "start"}`,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_open",
      toolProfileDigest: `sha256:${"d".repeat(64)}`,
    });
  };

  await expect(executeOpen()).resolves.toMatchObject({
    status: "completed",
    output: {
      text: "a".repeat(12 * 1024 - 1),
      nextCursor: String(12 * 1024 - 1),
      truncated: true,
    },
  });
  await expect(executeOpen(String(12 * 1024 - 1))).resolves.toMatchObject({
    status: "completed",
    output: { text: "😀tail", nextCursor: null, truncated: false },
  });
});

test("web_find pages fifty exact contexts with a durable byte cursor", async () => {
  const text = Array.from({ length: 60 }, (_, index) =>
    index === 0 ? "needle first\n" : `line ${index} needle\n`,
  ).join("");
  const bytes = Buffer.from(text, "utf8");
  const artifactId = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  const artifactStore: ArtifactStore = {
    async write() {
      throw new Error("The find test uses one pre-existing immutable artifact.");
    },
    async read(id) {
      return id === artifactId ? bytes : undefined;
    },
  };
  const store = createInMemoryWebEvidenceStore();
  await store.append({
    schemaVersion: 1,
    fetchId: `sha256:${"a".repeat(64)}`,
    artifactId,
    byteCount: bytes.byteLength,
    mediaType: "text/plain",
    sourceId: `sha256:${"e".repeat(64)}`,
    url: "https://example.com/find",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    provenance: "web_fetch",
  });
  const registry = await createWebEvidenceToolRegistry({
    artifactStore,
    http: {
      async fetch() {
        throw new Error("web_find must not perform network access.");
      },
    },
    store,
  });
  const find = registry.resolve("web_find");
  if (find === undefined) {
    throw new Error("The Web registry omitted web_find.");
  }
  const executeFind = async (cursor?: string) => {
    const prepared = find.prepare(
      JSON.stringify({ artifactId, text: "needle", ...(cursor === undefined ? {} : { cursor }) }),
    );
    if (prepared.status !== "ready") {
      throw new Error("The web_find input was unexpectedly rejected.");
    }
    return prepared.execute({
      callId: `find-${cursor ?? "start"}`,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_find",
      toolProfileDigest: `sha256:${"f".repeat(64)}`,
    });
  };

  const first = await executeFind();
  expect(first).toMatchObject({
    status: "completed",
    output: {
      matches: expect.arrayContaining([{ offset: 0, text: "needle first" }]),
      nextCursor: expect.stringMatching(/^[1-9][0-9]*$/u),
      truncated: true,
    },
  });
  if (first.status !== "completed" || typeof first.output !== "object" || first.output === null) {
    throw new Error("The first web_find page did not complete.");
  }
  const firstOutput = first.output as {
    readonly matches: readonly unknown[];
    readonly nextCursor: string;
  };
  expect(firstOutput.matches).toHaveLength(50);
  await expect(executeFind(firstOutput.nextCursor)).resolves.toMatchObject({
    status: "completed",
    output: { matches: expect.any(Array), nextCursor: null, truncated: false },
  });
  const second = await executeFind(firstOutput.nextCursor);
  if (
    second.status !== "completed" ||
    typeof second.output !== "object" ||
    second.output === null
  ) {
    throw new Error("The second web_find page did not complete.");
  }
  expect((second.output as { readonly matches: readonly unknown[] }).matches).toHaveLength(10);
});

test("a cross-origin redirect stops and requires a second exact web_fetch approval", async () => {
  const sourceUrl = "https://first.example.test/start";
  const redirectUrl = "https://second.example.test/final";
  const writes: string[] = [];
  const bytesById = new Map<string, Uint8Array>();
  const artifactStore: ArtifactStore = {
    async write(input) {
      const id = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
      writes.push(id);
      bytesById.set(id, input.bytes);
      return {
        id,
        mediaType: input.mediaType,
        byteCount: input.bytes.byteLength,
        source: input.source,
      };
    },
    async read(id) {
      return bytesById.get(id);
    },
  };
  const fetchedUrls: string[] = [];
  const http: WebHttpAdapter = {
    async fetch(input) {
      fetchedUrls.push(input.url);
      return input.url === sourceUrl
        ? {
            status: 302,
            url: sourceUrl,
            redirectUrl,
            mediaType: "application/octet-stream",
            body: Buffer.alloc(0),
          }
        : {
            status: 200,
            url: redirectUrl,
            mediaType: "text/plain",
            body: Buffer.from("redirect evidence", "utf8"),
          };
    },
  };
  let call = 0;
  let redirectResult: unknown;
  const model: ModelDriver = {
    async *stream(request) {
      call += 1;
      if (call === 1 || call === 2) {
        if (call === 2) {
          redirectResult = request.messages.findLast((message) => message.role === "tool");
        }
        const url = call === 1 ? sourceUrl : redirectUrl;
        yield { type: "tool_call_start", id: `fetch-redirect-${call}`, name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: `fetch-redirect-${call}`,
          json: JSON.stringify({ url }),
        };
        yield { type: "tool_call_end", id: `fetch-redirect-${call}` };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "Redirect approved separately." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const tools = await createWebEvidenceToolRegistry({ artifactStore, http });
  const dependencies: AgentSessionDependencies & {
    readonly [sessionToolProfileNames]: readonly string[];
  } = {
    contextProfile,
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"], askedEffects: ["network"] }),
    store: createInMemorySessionStore(),
    tools,
    [sessionToolProfileNames]: ["web_fetch", "web_open", "web_find"],
  };
  const session = new AgentSession(dependencies);
  const permissions: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_permission_requested") {
      permissions.push(event.subject);
      session.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });

  await session.run({ text: "Follow evidence only with exact approval." });
  expect(redirectResult).toMatchObject({
    result: {
      status: "completed",
      output: { status: "redirect", url: sourceUrl, redirectUrl, requiresApproval: true },
    },
  });
  expect(permissions).toEqual([
    {
      type: "web_request",
      operation: "fetch",
      providerOrigin: "https://first.example.test",
      url: sourceUrl,
    },
    {
      type: "web_request",
      operation: "fetch",
      providerOrigin: "https://second.example.test",
      url: redirectUrl,
    },
  ]);
  expect(fetchedUrls).toEqual([sourceUrl, redirectUrl]);
  expect(writes).toHaveLength(1);
});

test("web_fetch accepts a transport-revalidated same-origin redirect while citing the original URL", async () => {
  const sourceUrl = "https://docs.example.test/start";
  const finalUrl = "https://docs.example.test/final";
  const artifactStore = createInMemoryArtifactStoreForWebTest();
  const registry = await createWebEvidenceToolRegistry({
    artifactStore,
    http: {
      async fetch() {
        return {
          status: 200,
          url: finalUrl,
          mediaType: "text/plain",
          body: Buffer.from("same-origin evidence", "utf8"),
        };
      },
    },
  });
  const prepared = registry.resolve("web_fetch")?.prepare(JSON.stringify({ url: sourceUrl }));
  if (prepared?.status !== "ready") {
    throw new Error("The same-origin web_fetch input was unexpectedly rejected.");
  }
  const result = await prepared.execute({
    callId: "same-origin-fetch",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    signal: new AbortController().signal,
    toolName: "web_fetch",
    toolProfileDigest: `sha256:${"5".repeat(64)}`,
  });

  expect(result).toMatchObject({
    status: "completed",
    output: {
      url: sourceUrl,
      finalUrl,
      citation: { url: sourceUrl, robotsPolicy: "not_evaluated" },
    },
  });
});

test("two source URLs may cite the same content artifact through distinct immutable fetch IDs", async () => {
  const artifactStore = createInMemoryArtifactStoreForWebTest();
  const store = createInMemoryWebEvidenceStore();
  const registry = await createWebEvidenceToolRegistry({
    artifactStore,
    http: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "text/plain",
          body: Buffer.from("shared evidence", "utf8"),
        };
      },
    },
    now: () => "2026-09-01T08:00:00.000Z",
    store,
  });
  const fetch = async (url: string, callId: string) => {
    const prepared = registry.resolve("web_fetch")?.prepare(JSON.stringify({ url }));
    if (prepared?.status !== "ready") {
      throw new Error("The shared-content web_fetch input was unexpectedly rejected.");
    }
    return prepared.execute({
      callId,
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_fetch",
      toolProfileDigest: `sha256:${"b".repeat(64)}`,
    });
  };

  const first = await fetch("https://a.example.test/evidence", "fetch-a");
  const second = await fetch("https://b.example.test/evidence", "fetch-b");
  expect(first).toMatchObject({ status: "completed" });
  expect(second).toMatchObject({ status: "completed" });
  if (first.status !== "completed" || second.status !== "completed") {
    throw new Error("Both shared-content fetches must complete.");
  }
  const firstOutput = first.output as { readonly artifactId: string; readonly fetchId: string };
  const secondOutput = second.output as { readonly artifactId: string; readonly fetchId: string };
  expect(firstOutput.artifactId).toBe(secondOutput.artifactId);
  expect(firstOutput.fetchId).not.toBe(secondOutput.fetchId);
});

test("web_fetch classifies invalid UTF-8 before publishing any artifact", async () => {
  let writes = 0;
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        writes += 1;
        throw new Error("Invalid Web content must not reach the ArtifactStore.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch(input) {
        return {
          status: 200,
          url: input.url,
          mediaType: "text/plain; charset=utf-8",
          body: Uint8Array.from([0xc3, 0x28]),
        };
      },
    },
  });
  const fetch = registry.resolve("web_fetch");
  if (fetch === undefined) {
    throw new Error("The Web registry omitted web_fetch.");
  }
  const prepared = fetch.prepare('{"url":"https://example.com/invalid.txt"}');
  if (prepared.status !== "ready") {
    throw new Error("The web_fetch input was unexpectedly rejected.");
  }

  await expect(
    prepared.execute({
      callId: "invalid-utf8",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_fetch",
      toolProfileDigest: `sha256:${"a".repeat(64)}`,
    }),
  ).resolves.toEqual({
    status: "failed",
    error: { code: "web_response_invalid", message: "The Web source is not valid UTF-8 text." },
  });
  expect(writes).toBe(0);
});

test("web_fetch publishes no reference when cancellation arrives with the HTTP response", async () => {
  const controller = new AbortController();
  let artifactWrites = 0;
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        artifactWrites += 1;
        throw new Error("Cancelled Web content must not reach the ArtifactStore.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch(input) {
        controller.abort(new DOMException("Cancelled with response.", "AbortError"));
        return {
          status: 200,
          url: input.url,
          mediaType: "text/plain",
          body: Buffer.from("cancelled evidence", "utf8"),
        };
      },
    },
  });
  const prepared = registry
    .resolve("web_fetch")
    ?.prepare('{"url":"https://example.com/cancelled.txt"}');
  if (prepared?.status !== "ready") {
    throw new Error("The cancelled web_fetch input was unexpectedly rejected.");
  }

  await expect(
    prepared.execute({
      callId: "cancelled-web",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: controller.signal,
      toolName: "web_fetch",
      toolProfileDigest: `sha256:${"7".repeat(64)}`,
    }),
  ).resolves.toEqual({
    status: "failed",
    error: { code: "web_cancelled", message: "The Web request was cancelled." },
  });
  expect(artifactWrites).toBe(0);
});

test("web_fetch preserves the safe transport body-limit classification", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("An oversized Web response must not publish an artifact.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new SafeWebHttpError(
          "web_body_too_large",
          "The Web response exceeded its maximum body size.",
        );
      },
    },
  });
  const fetch = registry.resolve("web_fetch");
  const prepared = fetch?.prepare('{"url":"https://example.com/oversized.txt"}');
  if (prepared?.status !== "ready") {
    throw new Error("The web_fetch input was unexpectedly rejected.");
  }

  await expect(
    prepared.execute({
      callId: "oversized-web",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      signal: new AbortController().signal,
      toolName: "web_fetch",
      toolProfileDigest: `sha256:${"b".repeat(64)}`,
    }),
  ).resolves.toEqual({
    status: "failed",
    error: {
      code: "web_response_too_large",
      message: "The Web response exceeded its maximum body size.",
    },
  });
});

test("web_fetch rejects credentialed, private, reserved, or non-default-port URLs before permission", async () => {
  const registry = await createWebEvidenceToolRegistry({
    artifactStore: {
      async write() {
        throw new Error("Invalid URLs must not publish artifacts.");
      },
      async read() {
        return undefined;
      },
    },
    http: {
      async fetch() {
        throw new Error("Invalid URLs must not reach the HTTP Adapter.");
      },
    },
  });
  const fetch = registry.resolve("web_fetch");
  if (fetch === undefined) {
    throw new Error("The Web registry omitted web_fetch.");
  }
  for (const url of [
    "https://user@example.com/evidence",
    "https://example.com:8443/evidence",
    "https://10.0.0.1/evidence",
    "https://169.254.1.1/evidence",
    "http://127.0.0.1:8080/evidence",
    "file:///etc/passwd",
  ]) {
    expect(fetch.prepare(JSON.stringify({ url })), url).toMatchObject({
      status: "failed",
      error: { code: "invalid_tool_input" },
    });
  }
});
