/** Adam-owned DNS/IP binding and HTTP transport for immutable Web evidence. */
import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

import ipaddr from "ipaddr.js";

import type { WebHttpAdapter } from "./web-evidence.js";

export type WebDnsResolver = {
  lookup(
    hostname: string,
  ): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
};

export class SafeWebHttpError extends Error {
  constructor(
    readonly code:
      | "web_address_disallowed"
      | "web_dns_failed"
      | "web_body_too_large"
      | "web_cancelled"
      | "web_deadline_exceeded"
      | "web_redirect_limit"
      | "web_request_failed"
      | "web_url_invalid",
    message: string,
  ) {
    super(message);
    this.name = "SafeWebHttpError";
  }
}

export function createSafeWebHttpAdapter(
  options: {
    readonly deadlineSignal?: AbortSignal;
    readonly requestHttp?: typeof requestHttp;
    readonly requestHttps?: typeof requestHttps;
    readonly resolver?: WebDnsResolver;
  } = {},
): WebHttpAdapter {
  const fetchWithRedirects = async (
    input: Parameters<WebHttpAdapter["fetch"]>[0],
    redirects: number,
    deadlineSignal: AbortSignal,
  ): ReturnType<WebHttpAdapter["fetch"]> => {
    const signal = AbortSignal.any([input.signal, deadlineSignal]);
    const target = await raceWebAbort(
      resolveWebTarget({
        url: input.url,
        ...(input.allowedLoopbackOrigin === undefined
          ? {}
          : { allowedLoopbackOrigin: input.allowedLoopbackOrigin }),
        ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      }),
      input.signal,
      deadlineSignal,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const makeRequest =
        target.url.protocol === "https:"
          ? (options.requestHttps ?? requestHttps)
          : (options.requestHttp ?? requestHttp);
      const request = makeRequest(
        target.url,
        {
          headers: { accept: "text/plain, text/html, application/json" },
          lookup(_hostname, _options, callback) {
            callback(null, target.address, target.family);
          },
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = headerValue(response.headers.location);
          if ([301, 302, 303, 307, 308].includes(status) && location !== undefined) {
            let redirectUrl: URL;
            try {
              redirectUrl = new URL(location, target.url);
            } catch {
              settled = true;
              response.destroy();
              reject(new SafeWebHttpError("web_url_invalid", "The Web redirect URL is invalid."));
              return;
            }
            settled = true;
            response.destroy();
            const maximumRedirects = input.maximumRedirects ?? 5;
            if (redirectUrl.origin !== target.url.origin || maximumRedirects === 0) {
              resolve({
                status,
                url: target.url.href,
                redirectUrl: redirectUrl.href,
                mediaType: "application/octet-stream",
                body: Buffer.alloc(0),
              });
              return;
            }
            if (redirects >= maximumRedirects) {
              reject(
                new SafeWebHttpError(
                  "web_redirect_limit",
                  "The Web response exceeded the same-origin redirect limit.",
                ),
              );
              return;
            }
            void fetchWithRedirects(
              { ...input, url: redirectUrl.href },
              redirects + 1,
              deadlineSignal,
            ).then(resolve, reject);
            return;
          }
          const chunks: Buffer[] = [];
          let byteCount = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) {
              return;
            }
            byteCount += chunk.byteLength;
            if (byteCount > input.maximumBytes) {
              settled = true;
              const error = new SafeWebHttpError(
                "web_body_too_large",
                "The Web response exceeded its maximum body size.",
              );
              response.destroy();
              request.destroy();
              reject(error);
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({
              status,
              url: target.url.href,
              mediaType:
                headerValue(response.headers["content-type"]) ?? "application/octet-stream",
              body: Buffer.concat(chunks),
            });
          });
          response.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
        },
      );
      request.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          error instanceof SafeWebHttpError
            ? error
            : input.signal.aborted
              ? new SafeWebHttpError("web_cancelled", "The Web request was cancelled.")
              : deadlineSignal.aborted
                ? new SafeWebHttpError(
                    "web_deadline_exceeded",
                    "The Web request exceeded its deadline.",
                  )
                : new SafeWebHttpError("web_request_failed", "The Web request failed."),
        );
      });
      request.end();
    });
  };
  return {
    fetch: (input) =>
      fetchWithRedirects(input, 0, options.deadlineSignal ?? AbortSignal.timeout(30_000)),
  };
}

function raceWebAbort<T>(
  operation: Promise<T>,
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
): Promise<T> {
  const signal = AbortSignal.any([callerSignal, deadlineSignal]);
  if (signal.aborted) {
    return Promise.reject(webAbortError(callerSignal, deadlineSignal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(webAbortError(callerSignal, deadlineSignal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? webAbortError(callerSignal, deadlineSignal) : error);
      },
    );
  });
}

function webAbortError(callerSignal: AbortSignal, deadlineSignal: AbortSignal): SafeWebHttpError {
  return callerSignal.aborted
    ? new SafeWebHttpError("web_cancelled", "The Web request was cancelled.")
    : deadlineSignal.aborted
      ? new SafeWebHttpError("web_deadline_exceeded", "The Web request exceeded its deadline.")
      : new SafeWebHttpError("web_request_failed", "The Web request failed.");
}

export async function resolveWebTarget(options: {
  readonly url: string;
  readonly allowedLoopbackOrigin?: string;
  readonly resolver?: WebDnsResolver;
}): Promise<{
  readonly url: URL;
  readonly origin: string;
  readonly address: string;
  readonly family: 4 | 6;
}> {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new SafeWebHttpError("web_url_invalid", "The Web URL is invalid.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new SafeWebHttpError("web_url_invalid", "The Web URL is not admitted.");
  }
  const literal = hostnameLiteral(url.hostname);
  const isLoopback = literal !== undefined && ipaddr.parse(literal).range() === "loopback";
  if (isLoopback) {
    if (
      options.allowedLoopbackOrigin === undefined ||
      url.origin !== options.allowedLoopbackOrigin ||
      url.protocol !== "http:" ||
      url.port === ""
    ) {
      throw new SafeWebHttpError(
        "web_address_disallowed",
        "Loopback Web access requires the exact configured provider origin.",
      );
    }
    return {
      url,
      origin: url.origin,
      address: literal,
      family: ipaddr.parse(literal).kind() === "ipv4" ? 4 : 6,
    };
  }
  if (
    (url.protocol === "https:" && url.port !== "" && url.port !== "443") ||
    (url.protocol === "http:" && url.port !== "" && url.port !== "80")
  ) {
    throw new SafeWebHttpError(
      "web_address_disallowed",
      "Public Web access requires the protocol default port.",
    );
  }
  if (literal !== undefined) {
    if (ipaddr.parse(literal).range() !== "unicast") {
      throw new SafeWebHttpError(
        "web_address_disallowed",
        "The literal Web address is not public unicast.",
      );
    }
    return {
      url,
      origin: url.origin,
      address: literal,
      family: ipaddr.parse(literal).kind() === "ipv4" ? 4 : 6,
    };
  }
  const resolver = options.resolver ?? productionWebDnsResolver;
  let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
  try {
    addresses = await resolver.lookup(url.hostname);
  } catch {
    throw new SafeWebHttpError("web_dns_failed", "The Web hostname could not be resolved.");
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address }) => !ipaddr.isValid(address) || ipaddr.parse(address).range() !== "unicast",
    )
  ) {
    throw new SafeWebHttpError(
      "web_address_disallowed",
      "Every resolved Web address must be public unicast.",
    );
  }
  const selected = addresses[0];
  if (selected === undefined) {
    throw new SafeWebHttpError("web_dns_failed", "The Web hostname had no usable address.");
  }
  return { url, origin: url.origin, address: selected.address, family: selected.family };
}

const productionWebDnsResolver: WebDnsResolver = {
  async lookup(hostname) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.flatMap(({ address, family }) =>
      family === 4 || family === 6 ? [{ address, family }] : [],
    );
  },
};

function hostnameLiteral(hostname: string): string | undefined {
  const candidate = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(candidate) ? candidate : undefined;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" || value === undefined ? value : value[0];
}
