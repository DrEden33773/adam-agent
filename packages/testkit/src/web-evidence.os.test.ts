import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request as nodeHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebSearchConfiguration } from "@adam-agent/agent";
import {
  createJsonlWebEvidenceStore,
  createSafeWebHttpAdapter,
  createWebSearchConfigurationController,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("web.json activation is owner-only, durable across restart, and rejects symlink replacement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-config-os-"));
  const configRoot = join(testRoot, "config");
  const environment = { XDG_CONFIG_HOME: configRoot };
  const controller = createWebSearchConfigurationController({ environment });
  const endpoint = "http://127.0.0.1:8888/search";

  try {
    const activated = await controller.activateSearxng(endpoint);
    const directoryPath = join(configRoot, "adam-agent");
    const configurationPath = join(directoryPath, "web.json");
    expect((await lstat(directoryPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(configurationPath)).mode & 0o777).toBe(0o600);
    await expect(createWebSearchConfiguration({ environment }).load()).resolves.toEqual(activated);

    const victimPath = join(testRoot, "victim.json");
    await writeFile(victimPath, "owner data\n", { encoding: "utf8", mode: 0o600 });
    await unlink(configurationPath);
    await symlink(victimPath, configurationPath);
    await expect(controller.clear()).rejects.toThrow("unsafe");
    await expect(readFile(victimPath, "utf8")).resolves.toBe("owner data\n");

    await unlink(configurationPath);
    await chmod(directoryPath, 0o755);
    await expect(controller.activateSearxng(endpoint)).rejects.toThrow("owner-only");
    await chmod(directoryPath, 0o700);
    await mkdir(directoryPath, { recursive: true });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("the real HTTP Adapter pins exact loopback origin and sends no ambient authority headers", async () => {
  let observed:
    | { readonly url: string | undefined; readonly headers: Readonly<Record<string, unknown>> }
    | undefined;
  let observeRequest: (() => void) | undefined;
  const requestObserved = new Promise<void>((resolve) => {
    observeRequest = resolve;
  });
  const server = createServer((request, response) => {
    observed = { url: request.url, headers: request.headers };
    observeRequest?.();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"results":[]}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The HTTP fixture did not expose a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/search?q=connection&format=json`;
  const adapter = createSafeWebHttpAdapter();

  try {
    await expect(
      adapter.fetch({
        url,
        allowedLoopbackOrigin: origin,
        maximumBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 200,
      url,
      mediaType: "application/json",
      body: Buffer.from('{"results":[]}'),
    });
    await requestObserved;
    expect(observed).toMatchObject({
      url: "/search?q=connection&format=json",
      headers: { host: `127.0.0.1:${address.port}` },
    });
    expect(observed?.headers).not.toHaveProperty("authorization");
    expect(observed?.headers).not.toHaveProperty("cookie");
    expect(observed?.headers).not.toHaveProperty("referer");
    await expect(
      adapter.fetch({
        url,
        maximumBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "web_address_disallowed" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("the HTTP transport passes its validated public address into the real request lookup seam", async () => {
  const observedHosts: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    observedHosts.push(request.headers.host);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned public evidence");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The pinned-lookup fixture did not expose a TCP address.");
  }
  const localUrl = `http://127.0.0.1:${address.port}/bound`;
  const pinned: Array<{ readonly address: string; readonly family: number }> = [];
  const requestHttps = ((
    url: URL,
    requestOptions: Record<string, unknown>,
    onResponse: unknown,
  ) => {
    const { headers, lookup: requestLookup, signal } = requestOptions;
    const lookup = requestLookup as
      | ((
          hostname: string,
          options: Record<string, unknown>,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => void)
      | undefined;
    if (lookup === undefined) {
      throw new Error("The production request omitted its pinned lookup callback.");
    }
    lookup(url.hostname, {}, (error, selectedAddress, family) => {
      if (error !== null) {
        throw error;
      }
      pinned.push({ address: selectedAddress, family });
    });
    return nodeHttpRequest(
      localUrl,
      {
        headers: {
          ...(headers as Record<string, string>),
          host: url.host,
        },
        signal: signal as AbortSignal,
      },
      onResponse as Parameters<typeof nodeHttpRequest>[2],
    );
  }) as unknown as typeof import("node:https").request;
  const adapter = createSafeWebHttpAdapter({
    requestHttps,
    resolver: {
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    },
  });

  try {
    await expect(
      adapter.fetch({
        url: "https://public.example.test/evidence",
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 200, body: Buffer.from("pinned public evidence") });
    expect(pinned).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(observedHosts).toEqual(["public.example.test"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("the real HTTP Adapter revalidates same-origin redirects and stops before a cross-origin target", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/start") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    if (request.url === "/cross") {
      response.writeHead(302, { location: "https://other.example.test/next" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("redirected evidence");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The redirect fixture did not expose a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = createSafeWebHttpAdapter();

  try {
    await expect(
      adapter.fetch({
        url: `${origin}/start`,
        allowedLoopbackOrigin: origin,
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 200,
      url: `${origin}/final`,
      body: Buffer.from("redirected evidence"),
    });
    await expect(
      adapter.fetch({
        url: `${origin}/cross`,
        allowedLoopbackOrigin: origin,
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 302,
      url: `${origin}/cross`,
      redirectUrl: "https://other.example.test/next",
      body: Buffer.alloc(0),
    });
    await expect(
      adapter.fetch({
        url: `${origin}/start`,
        allowedLoopbackOrigin: origin,
        maximumRedirects: 0,
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 302,
      url: `${origin}/start`,
      redirectUrl: `${origin}/final`,
    });
    expect(paths).toEqual(["/start", "/final", "/cross", "/start"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("an invalid redirect target causally closes its response without draining the body", async () => {
  const responseClosed = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.once("close", () => responseClosed.resolve());
    response.writeHead(302, { location: "http://[" });
    response.write("body must not be drained");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The invalid-redirect fixture did not expose a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = createSafeWebHttpAdapter();

  try {
    await expect(
      adapter.fetch({
        url: `${origin}/invalid-location`,
        allowedLoopbackOrigin: origin,
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "web_url_invalid" });
    await responseClosed.promise;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("the real HTTP Adapter rejects oversized bodies and settles cancellation from the request boundary", async () => {
  const heldRequest = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(2 * 1024));
      return;
    }
    heldRequest.resolve();
    request.once("close", () => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The limit fixture did not expose a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = createSafeWebHttpAdapter();

  try {
    await expect(
      adapter.fetch({
        url: `${origin}/large`,
        allowedLoopbackOrigin: origin,
        maximumBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "web_body_too_large" });
    const controller = new AbortController();
    const cancelled = adapter.fetch({
      url: `${origin}/hold`,
      allowedLoopbackOrigin: origin,
      maximumBytes: 1024,
      signal: controller.signal,
    });
    await heldRequest.promise;
    controller.abort(new DOMException("Fixture cancellation.", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ code: "web_cancelled" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("the real HTTP Adapter classifies a fake deadline only after the request boundary", async () => {
  const requestReceived = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    requestReceived.resolve();
    request.once("close", () => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The deadline fixture did not expose a TCP address.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const deadline = new AbortController();
  const adapter = createSafeWebHttpAdapter({ deadlineSignal: deadline.signal });

  try {
    const result = adapter.fetch({
      url: `${origin}/hold`,
      allowedLoopbackOrigin: origin,
      maximumBytes: 1024,
      signal: new AbortController().signal,
    });
    await requestReceived.promise;
    deadline.abort(new DOMException("Fixture deadline.", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ code: "web_deadline_exceeded" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

test("the JSONL WebEvidence store fsyncs immutable metadata and fails closed on corrupt restart", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-web-store-os-"));
  const filePath = join(testRoot, "web-evidence.jsonl");
  const record = {
    schemaVersion: 1,
    fetchId: `sha256:${"e".repeat(64)}`,
    artifactId: `sha256:${"a".repeat(64)}`,
    byteCount: 18,
    mediaType: "text/plain",
    sourceId: `sha256:${"b".repeat(64)}`,
    url: "https://example.com/evidence.txt",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    provenance: "web_fetch",
  } as const;
  const source = {
    recordType: "search_source",
    schemaVersion: 1,
    sourceId: `sha256:${"c".repeat(64)}`,
    rank: 1,
    url: "https://example.com/search-result",
    title: "Search result",
    snippet: "Untrusted snippet",
    retrievedAt: "2026-09-01T08:00:00.000Z",
    robotsPolicy: "not_evaluated",
    engines: ["fixture"],
    providerKind: "searxng",
    providerOrigin: "https://search.example.test",
    queryDigest: `sha256:${"d".repeat(64)}`,
    truncation: { title: false, snippet: false, engines: false, publishedAt: false },
  } as const;

  try {
    const store = createJsonlWebEvidenceStore({ filePath });
    await store.append(record);
    await store.appendSearchSource(source);
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    await expect(createJsonlWebEvidenceStore({ filePath }).get(record.artifactId)).resolves.toEqual(
      record,
    );
    await expect(
      createJsonlWebEvidenceStore({ filePath }).getSearchSource(source.sourceId),
    ).resolves.toEqual(source);
    const validText = `${JSON.stringify(record)}\n${JSON.stringify(source)}\n`;
    expect(await readFile(filePath, "utf8")).toBe(validText);

    await appendFile(
      filePath,
      `${JSON.stringify({ ...record, url: "https://other.example/evidence.txt" })}\n`,
      "utf8",
    );
    await expect(createJsonlWebEvidenceStore({ filePath }).get(record.artifactId)).rejects.toThrow(
      "invalid",
    );
    await writeFile(filePath, validText, { encoding: "utf8", mode: 0o600 });
    await appendFile(
      filePath,
      `${JSON.stringify({ ...source, title: "Conflicting search result" })}\n`,
      "utf8",
    );
    await expect(createJsonlWebEvidenceStore({ filePath }).listSearchSources()).rejects.toThrow(
      "invalid",
    );
    await writeFile(filePath, validText, { encoding: "utf8", mode: 0o600 });

    await appendFile(filePath, '{"schemaVersion":1,"artifactId":"corrupt"}\n', "utf8");
    await expect(createJsonlWebEvidenceStore({ filePath }).get(record.artifactId)).rejects.toThrow(
      "invalid",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
