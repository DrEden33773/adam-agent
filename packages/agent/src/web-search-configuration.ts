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
  readonly syntheticDnsRange?: string | null;
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
  setSyntheticDnsRange(range: string | null): Promise<WebSearchConfigurationSnapshot>;
};

type WebConfigurationStorage = UserConfigurationStorage & {
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
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
  storage: WebConfigurationStorage,
): WebSearchConfigurationController {
  return createWebSearchConfigurationFromStorage(storage);
}

function createWebSearchConfigurationFromStorage(
  storage: WebConfigurationStorage,
): WebSearchConfigurationController {
  let mutationTail: Promise<unknown> = Promise.resolve();
  const runMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (storage.runExclusive !== undefined) {
      return storage.runExclusive(operation);
    }
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
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
    return runMutation(async () => {
      const current = await load();
      const syntheticDnsRange = current.syntheticDnsRange ?? null;
      const serialized = serializeWebSearchConfiguration(provider, syntheticDnsRange);
      if (Buffer.byteLength(serialized, "utf8") > maximumWebConfigurationBytes) {
        throw new TypeError("The Web Search configuration exceeds its byte limit.");
      }
      await storage.write(serialized, { beforeCommit });
      return { status: "configured", provider, syntheticDnsRange, diagnostic: null };
    });
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
      return runMutation(async () => {
        const current = await load();
        await storage.write(
          serializeWebSearchConfiguration(null, current.syntheticDnsRange ?? null),
        );
        return unconfiguredSnapshot(current.syntheticDnsRange ?? null);
      });
    },
    async setSyntheticDnsRange(range) {
      const normalized = range === null ? null : normalizeWebSyntheticDnsRange(range);
      if (range !== null && normalized === undefined) {
        throw new TypeError(
          "The synthetic DNS range must be an IPv4 CIDR subnet inside 198.18.0.0/15.",
        );
      }
      const admittedRange = normalized ?? null;
      return runMutation(async () => {
        const current = await load();
        const provider = current.status === "configured" ? current.provider : null;
        await storage.write(serializeWebSearchConfiguration(provider, admittedRange));
        return provider === null
          ? unconfiguredSnapshot(admittedRange)
          : { status: "configured", provider, syntheticDnsRange: admittedRange, diagnostic: null };
      });
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
  const { schemaVersion, searchProvider, syntheticDnsRange: storedSyntheticDnsRange } = parsed;
  let syntheticDnsRange: string | null;
  if (schemaVersion === 1 && Object.keys(parsed).length === 2) {
    syntheticDnsRange = null;
  } else if (
    schemaVersion === 2 &&
    Object.keys(parsed).length === 3 &&
    (storedSyntheticDnsRange === null || typeof storedSyntheticDnsRange === "string")
  ) {
    syntheticDnsRange =
      storedSyntheticDnsRange === null
        ? null
        : (normalizeWebSyntheticDnsRange(storedSyntheticDnsRange) ?? null);
    if (storedSyntheticDnsRange !== null && syntheticDnsRange !== storedSyntheticDnsRange) {
      return invalidSnapshot();
    }
  } else {
    return invalidSnapshot();
  }
  if (searchProvider === null) {
    return unconfiguredSnapshot(syntheticDnsRange);
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
    syntheticDnsRange,
    diagnostic: null,
  };
}

export function normalizeWebSyntheticDnsRange(value: string): string | undefined {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > 64 || !ipaddr.IPv4.isValidCIDRFourPartDecimal(trimmed)) {
    return undefined;
  }
  const [, prefix] = ipaddr.IPv4.parseCIDR(trimmed);
  if (prefix < 15) {
    return undefined;
  }
  const network = ipaddr.IPv4.networkAddressFromCIDR(trimmed);
  if (!network.match(ipaddr.IPv4.parseCIDR("198.18.0.0/15"))) {
    return undefined;
  }
  return `${network.toString()}/${prefix}`;
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

function serializeWebSearchConfiguration(
  provider: SearxngSearchConfigurationV1 | null,
  syntheticDnsRange: string | null,
): string {
  return `${JSON.stringify({ schemaVersion: 2, searchProvider: provider, syntheticDnsRange })}\n`;
}

function unconfiguredSnapshot(
  syntheticDnsRange: string | null = null,
): WebSearchConfigurationSnapshot {
  return { status: "unconfigured", provider: null, syntheticDnsRange, diagnostic: null };
}

function invalidSnapshot(): WebSearchConfigurationSnapshot {
  return {
    status: "invalid",
    provider: null,
    syntheticDnsRange: null,
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
    syntheticDnsRange: null,
    diagnostic: {
      code: "web_search_configuration_unsafe",
      message: "The saved Web Search configuration is not an owner-only ordinary file.",
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
