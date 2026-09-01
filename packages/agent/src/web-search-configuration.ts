import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import ipaddr from "ipaddr.js";
import {
  createOwnerConfigurationFileStorage,
  hasDuplicateJsonObjectKey,
  type UserConfigurationStorage,
} from "./secure-user-configuration.js";
import type { WebHttpAdapter } from "./web-evidence.js";
import { testConfiguredSearxngConnection } from "./web-evidence-production.js";

const maximumWebConfigurationBytes = 8 * 1024;

export type SearxngSearchConfigurationV1 = {
  readonly kind: "searxng";
  readonly endpoint: string;
  readonly activation: {
    readonly protocol: "searxng-json.v1";
    readonly endpointDigest: `sha256:${string}`;
  };
};

export type WebSearchConfigurationSnapshot = {
  readonly status: "configured" | "invalid" | "unconfigured" | "unsafe";
  readonly provider: SearxngSearchConfigurationV1 | null;
  readonly diagnostic: {
    readonly code: "web_search_configuration_invalid" | "web_search_configuration_unsafe";
    readonly message: string;
  } | null;
};

export type WebSearchConfiguration = {
  load(): Promise<WebSearchConfigurationSnapshot>;
};

export type WebSearchConfigurationController = WebSearchConfiguration & {
  activateSearxng(endpoint: string): Promise<WebSearchConfigurationSnapshot>;
  testAndActivateSearxng(input: {
    readonly endpoint: string;
    readonly http: WebHttpAdapter;
    readonly signal: AbortSignal;
  }): Promise<WebSearchConfigurationSnapshot>;
  clear(): Promise<WebSearchConfigurationSnapshot>;
};

export function createWebSearchConfiguration(options: {
  readonly environment: NodeJS.ProcessEnv;
}): WebSearchConfiguration {
  const controller = createWebSearchConfigurationController(options);
  return { load: () => controller.load() };
}

export function createWebSearchConfigurationController(options: {
  readonly environment: NodeJS.ProcessEnv;
}): WebSearchConfigurationController {
  const { XDG_CONFIG_HOME: configuredRoot } = options.environment;
  const root =
    configuredRoot === undefined || configuredRoot.length === 0
      ? join(homedir(), ".config")
      : configuredRoot;
  const directoryPath = join(root, "adam-agent");
  return createWebSearchConfigurationFromStorage(
    createOwnerConfigurationFileStorage({
      configurationPath: join(directoryPath, "web.json"),
      directoryPath,
      maximumBytes: maximumWebConfigurationBytes,
      mutationLockName: ".web.lock",
      temporaryPrefix: ".web",
    }),
  );
}

/** Tests only through the internal-testing entry. */
export function createWebSearchConfigurationWithStorageForTesting(
  storage: UserConfigurationStorage,
): WebSearchConfigurationController {
  return createWebSearchConfigurationFromStorage(storage);
}

function createWebSearchConfigurationFromStorage(
  storage: UserConfigurationStorage,
): WebSearchConfigurationController {
  const load = async (): Promise<WebSearchConfigurationSnapshot> => {
    const stored = await storage.read().catch(() => ({ status: "unsafe" as const }));
    if (stored.status === "missing") {
      return unconfiguredSnapshot();
    }
    if (stored.status === "unsafe") {
      return unsafeSnapshot();
    }
    return parseWebSearchConfiguration(stored.text);
  };
  const activateSearxng = async (
    endpoint: string,
    beforeCommit?: () => void,
  ): Promise<WebSearchConfigurationSnapshot> => {
    const normalized = normalizeSearxngEndpoint(endpoint);
    if (normalized === undefined) {
      throw new TypeError("The SearXNG endpoint is not admitted by the Web policy.");
    }
    const provider: SearxngSearchConfigurationV1 = {
      kind: "searxng",
      endpoint: normalized,
      activation: {
        protocol: "searxng-json.v1",
        endpointDigest: endpointDigest(normalized),
      },
    };
    const serialized = serializeWebSearchConfiguration(provider);
    if (Buffer.byteLength(serialized, "utf8") > maximumWebConfigurationBytes) {
      throw new TypeError("The Web Search configuration exceeds its byte limit.");
    }
    await storage.write(serialized, { beforeCommit });
    return { status: "configured", provider, diagnostic: null };
  };
  return {
    load,
    activateSearxng,
    async testAndActivateSearxng(input) {
      const normalized = normalizeSearxngEndpoint(input.endpoint);
      if (normalized === undefined) {
        throw new TypeError("The SearXNG endpoint is not admitted by the Web policy.");
      }
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
      await testConfiguredSearxngConnection({
        endpoint: normalized,
        http: input.http,
        signal,
      });
      signal.throwIfAborted();
      return activateSearxng(normalized, () => signal.throwIfAborted());
    },
    async clear() {
      await storage.write(serializeWebSearchConfiguration(null));
      return unconfiguredSnapshot();
    },
  };
}

function parseWebSearchConfiguration(text: string): WebSearchConfigurationSnapshot {
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > maximumWebConfigurationBytes ||
    hasDuplicateJsonObjectKey(text)
  ) {
    return invalidSnapshot();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidSnapshot();
  }
  if (!isPlainRecord(parsed)) {
    return invalidSnapshot();
  }
  const { schemaVersion, searchProvider } = parsed;
  if (Object.keys(parsed).length !== 2 || schemaVersion !== 1) {
    return invalidSnapshot();
  }
  if (searchProvider === null) {
    return unconfiguredSnapshot();
  }
  if (!isPlainRecord(searchProvider) || Object.keys(searchProvider).length !== 3) {
    return invalidSnapshot();
  }
  const { activation, endpoint, kind } = searchProvider;
  if (
    kind !== "searxng" ||
    typeof endpoint !== "string" ||
    !isPlainRecord(activation) ||
    Object.keys(activation).length !== 2
  ) {
    return invalidSnapshot();
  }
  const { endpointDigest: activatedEndpointDigest, protocol } = activation;
  if (protocol !== "searxng-json.v1" || typeof activatedEndpointDigest !== "string") {
    return invalidSnapshot();
  }
  const normalized = normalizeSearxngEndpoint(endpoint);
  if (
    normalized === undefined ||
    normalized !== endpoint ||
    activatedEndpointDigest !== endpointDigest(normalized)
  ) {
    return invalidSnapshot();
  }
  return {
    status: "configured",
    provider: {
      kind,
      endpoint: normalized,
      activation: {
        protocol,
        endpointDigest: activatedEndpointDigest as `sha256:${string}`,
      },
    },
    diagnostic: null,
  };
}

export function normalizeSearxngEndpoint(value: string): string | undefined {
  if (Buffer.byteLength(value, "utf8") > 4 * 1024) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.pathname.length === 0
  ) {
    return undefined;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (loopback) {
    if (url.protocol !== "http:" || url.port === "" || url.pathname !== "/search") {
      return undefined;
    }
  } else {
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
      return undefined;
    }
    const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (ipaddr.isValid(literal) && ipaddr.parse(literal).range() !== "unicast") {
      return undefined;
    }
  }
  return Buffer.byteLength(url.href, "utf8") <= 4 * 1024 ? url.href : undefined;
}

function endpointDigest(endpoint: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(endpoint).digest("hex")}`;
}

function serializeWebSearchConfiguration(provider: SearxngSearchConfigurationV1 | null): string {
  return `${JSON.stringify({ schemaVersion: 1, searchProvider: provider })}\n`;
}

function unconfiguredSnapshot(): WebSearchConfigurationSnapshot {
  return { status: "unconfigured", provider: null, diagnostic: null };
}

function invalidSnapshot(): WebSearchConfigurationSnapshot {
  return {
    status: "invalid",
    provider: null,
    diagnostic: {
      code: "web_search_configuration_invalid",
      message: "The saved Web Search configuration is invalid.",
    },
  };
}

function unsafeSnapshot(): WebSearchConfigurationSnapshot {
  return {
    status: "unsafe",
    provider: null,
    diagnostic: {
      code: "web_search_configuration_unsafe",
      message: "The saved Web Search configuration is not an owner-only ordinary file.",
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
