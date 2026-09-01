import type { ArtifactStore } from "./artifact-store.js";
import { SearxngSearchProvider } from "./searxng-search-provider.js";
import type { ToolRegistry } from "./tool-runtime.js";
import {
  createWebEvidenceToolRegistry,
  type WebEvidenceStore,
  type WebHttpAdapter,
  type WebSearchProvider,
} from "./web-evidence.js";
import type { WebSearchConfigurationSnapshot } from "./web-search-configuration.js";

export async function createWebEvidenceProduction(options: {
  readonly artifactStore: ArtifactStore;
  readonly configuration: WebSearchConfigurationSnapshot;
  readonly http: WebHttpAdapter;
  readonly searchAvailable?: boolean;
  readonly store: WebEvidenceStore;
}): Promise<ToolRegistry> {
  const providerConfiguration = options.configuration.provider;
  let searchProvider: WebSearchProvider | undefined;
  if (options.configuration.status === "configured" && providerConfiguration !== null) {
    switch (providerConfiguration.kind) {
      case "searxng":
        searchProvider =
          options.searchAvailable === false
            ? unavailableSearxngSearchProvider(providerConfiguration.endpoint)
            : new SearxngSearchProvider({
                endpoint: providerConfiguration.endpoint,
                http: options.http,
              });
        break;
      default:
        assertNever(providerConfiguration.kind);
    }
  }
  return createWebEvidenceToolRegistry({
    artifactStore: options.artifactStore,
    http: options.http,
    ...(searchProvider === undefined ? {} : { searchProvider }),
    store: options.store,
  });
}

export async function testConfiguredSearxngConnection(options: {
  readonly endpoint: string;
  readonly http: WebHttpAdapter;
  readonly signal: AbortSignal;
}): Promise<void> {
  await new SearxngSearchProvider({ endpoint: options.endpoint, http: options.http }).search({
    query: "adam-agent-connection-test",
    limit: 1,
    signal: options.signal,
  });
}

function unavailableSearxngSearchProvider(endpoint: string): WebSearchProvider {
  return {
    kind: "searxng",
    origin: new URL(endpoint).origin,
    async search() {
      throw Object.assign(new Error("The historical Web Search provider is unavailable."), {
        code: "search_provider_unavailable",
      });
    },
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported Web Search provider: ${String(value)}`);
}
