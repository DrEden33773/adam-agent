import { z } from "zod";

import type { WebHttpAdapter, WebSearchProvider, WebSearchProviderResult } from "./web-evidence.js";

const maximumSearxngResponseBytes = 1024 * 1024;
const searxngResultSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4 * 1024),
    title: z
      .string()
      .max(8 * 1024)
      .default(""),
    content: z
      .string()
      .max(64 * 1024)
      .default(""),
    publishedDate: z.string().max(256).nullable().optional(),
    engines: z
      .array(z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1024))
      .max(64)
      .default([]),
  })
  .passthrough();
const searxngResponseSchema = z
  .object({
    results: z.array(searxngResultSchema).max(1_000),
    unresponsive_engines: z.array(z.array(z.unknown()).max(8)).max(256).optional(),
  })
  .passthrough();

export class SearxngSearchProviderError extends Error {
  constructor(
    readonly code:
      | "search_json_disabled"
      | "search_provider_invalid"
      | "search_provider_transient"
      | "search_provider_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SearxngSearchProviderError";
  }
}

export class SearxngSearchProvider implements WebSearchProvider {
  readonly kind = "searxng" as const;
  readonly origin: string;
  readonly #endpoint: string;
  readonly #http: WebHttpAdapter;

  constructor(options: { readonly endpoint: string; readonly http: WebHttpAdapter }) {
    this.#endpoint = options.endpoint;
    this.#http = options.http;
    this.origin = new URL(options.endpoint).origin;
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly language?: string;
    readonly timeRange?: "day" | "week" | "month" | "year";
    readonly signal: AbortSignal;
  }): Promise<{ readonly results: readonly WebSearchProviderResult[]; readonly partial: boolean }> {
    const requestUrl = new URL(this.#endpoint);
    requestUrl.searchParams.set("q", input.query);
    requestUrl.searchParams.set("format", "json");
    if (input.language !== undefined) {
      requestUrl.searchParams.set("language", input.language);
    }
    if (input.timeRange !== undefined) {
      requestUrl.searchParams.set("time_range", input.timeRange);
    }
    const response = await this.#http.fetch({
      url: requestUrl.href,
      ...(requestUrl.protocol === "http:" ? { allowedLoopbackOrigin: requestUrl.origin } : {}),
      maximumRedirects: 0,
      maximumBytes: maximumSearxngResponseBytes,
      signal: input.signal,
    });
    if (response.url !== requestUrl.href) {
      throw new SearxngSearchProviderError(
        "search_provider_invalid",
        "The configured SearXNG response did not retain its exact request URL.",
      );
    }
    if (response.status === 403) {
      throw new SearxngSearchProviderError(
        "search_json_disabled",
        "The configured SearXNG endpoint does not permit JSON search responses.",
      );
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new SearxngSearchProviderError(
        "search_provider_transient",
        "The configured SearXNG endpoint is temporarily unavailable.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SearxngSearchProviderError(
        "search_provider_unavailable",
        "The configured SearXNG endpoint rejected the search request.",
      );
    }
    if (response.mediaType.toLowerCase().split(";", 1)[0]?.trim() !== "application/json") {
      throw new SearxngSearchProviderError(
        "search_provider_invalid",
        "The configured SearXNG endpoint returned a non-JSON response.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    } catch {
      throw new SearxngSearchProviderError(
        "search_provider_invalid",
        "The configured SearXNG endpoint returned invalid JSON.",
      );
    }
    const validated = searxngResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new SearxngSearchProviderError(
        "search_provider_invalid",
        "The configured SearXNG endpoint returned an invalid response shape.",
      );
    }
    return {
      results: validated.data.results.slice(0, input.limit).map((result) => ({
        url: result.url,
        title: result.title,
        snippet: result.content,
        ...(result.publishedDate === undefined || result.publishedDate === null
          ? {}
          : { publishedAt: result.publishedDate }),
        engines: result.engines,
      })),
      partial: (validated.data.unresponsive_engines?.length ?? 0) > 0,
    };
  }
}

export function createSearxngAdapterForTesting(options: {
  readonly endpoint: string;
  readonly http: WebHttpAdapter;
}): WebSearchProvider {
  return new SearxngSearchProvider(options);
}
