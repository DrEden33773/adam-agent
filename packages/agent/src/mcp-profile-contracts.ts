import {
  canonicalMcpJson,
  digestCanonicalMcpJson,
  type McpSha256Digest,
} from "./mcp-canonical-identity.js";
import type { ToolEffect } from "./tool-runtime.js";

const maximumMcpToolProfileDefinitionBytes = 64 * 1024;

export type McpSettledServerIdentity = {
  readonly serverId: string;
  readonly definitionDigest: McpSha256Digest;
  readonly protocolVersion: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly capabilityDigest: McpSha256Digest;
  readonly launchIdentityDigest: McpSha256Digest;
};

export type McpToolProfileV1 = {
  readonly version: 1;
  readonly generationId: string;
  readonly sdk: {
    readonly package: "@modelcontextprotocol/client";
    readonly version: "2.0.0";
  };
  readonly projectorVersion: 1;
  readonly servers: readonly McpSettledServerIdentity[];
  readonly tools: readonly {
    readonly serverId: string;
    readonly serverDefinitionDigest: McpSha256Digest;
    readonly originalName: string;
    readonly qualifiedName: string;
    readonly definitionDigest: McpSha256Digest;
    readonly modelDescription: string;
    readonly rawSchema: {
      readonly dialect: "unstamped" | "2020-12" | "2019-09" | "draft-07" | "draft-06";
      readonly provenance: "tools/list";
      readonly value: Readonly<Record<string, unknown>>;
      readonly digest: McpSha256Digest;
    };
    readonly modelProjection: {
      readonly version: 1;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly digest: McpSha256Digest;
    };
    readonly effect: ToolEffect;
    readonly replay: "never";
    readonly cancellation: "abort_signal";
    readonly outputPolicy: {
      readonly version: 1;
      readonly maximumInlineBytes: 65_536;
      readonly maximumRawBytes: 8_388_608;
      readonly supportedContent: readonly ["text", "structured_json"];
    };
  }[];
  readonly digest: McpSha256Digest;
};

export type McpToolProfileSnapshot = {
  readonly version: 1;
  readonly digest: McpSha256Digest;
  readonly projectorVersion: 1;
  readonly tools: readonly {
    readonly serverId: string;
    readonly originalName: string;
    readonly qualifiedName: string;
    readonly definitionDigest: McpSha256Digest;
    readonly rawSchemaDigest: McpSha256Digest;
    readonly modelProjectionDigest: McpSha256Digest;
    readonly effect: ToolEffect;
  }[];
};

export function createMcpToolProfileV1(input: {
  readonly generationId: string;
  readonly servers: readonly McpSettledServerIdentity[];
  readonly tools: McpToolProfileV1["tools"];
}): McpToolProfileV1 | undefined {
  const modelDefinitions = input.tools.map((tool) => ({
    name: tool.qualifiedName,
    description: tool.modelDescription,
    inputSchema: tool.modelProjection.schema,
  }));
  if (
    Buffer.byteLength(canonicalMcpJson(modelDefinitions), "utf8") >
    maximumMcpToolProfileDefinitionBytes
  ) {
    return undefined;
  }
  const profileWithoutDigest = {
    version: 1,
    generationId: input.generationId,
    sdk: { package: "@modelcontextprotocol/client", version: "2.0.0" },
    projectorVersion: 1,
    servers: input.servers,
    tools: input.tools,
  } as const;
  return {
    ...profileWithoutDigest,
    digest: digestCanonicalMcpJson(profileWithoutDigest),
  };
}

export function mcpToolProfileSnapshot(profile: McpToolProfileV1): McpToolProfileSnapshot {
  return {
    version: 1,
    digest: profile.digest,
    projectorVersion: profile.projectorVersion,
    tools: profile.tools.map((tool) => ({
      serverId: tool.serverId,
      originalName: tool.originalName,
      qualifiedName: tool.qualifiedName,
      definitionDigest: tool.definitionDigest,
      rawSchemaDigest: tool.rawSchema.digest,
      modelProjectionDigest: tool.modelProjection.digest,
      effect: tool.effect,
    })),
  };
}

export function isMcpToolProfileV1Valid(profile: McpToolProfileV1): boolean {
  const { digest, ...withoutDigest } = profile;
  return (
    profile.version === 1 &&
    profile.sdk.package === "@modelcontextprotocol/client" &&
    profile.sdk.version === "2.0.0" &&
    profile.projectorVersion === 1 &&
    profile.tools.length >= 1 &&
    profile.tools.length <= 20 &&
    new Set(profile.tools.map((tool) => tool.qualifiedName)).size === profile.tools.length &&
    profile.tools.every(
      (tool) =>
        profile.servers.some(
          (server) =>
            server.serverId === tool.serverId &&
            server.definitionDigest === tool.serverDefinitionDigest,
        ) &&
        tool.rawSchema.digest === digestCanonicalMcpJson(tool.rawSchema.value) &&
        tool.modelProjection.digest ===
          digestCanonicalMcpJson({ version: 1, schema: tool.modelProjection.schema }) &&
        tool.modelDescription.length <= 2 * 1024,
    ) &&
    digest === digestCanonicalMcpJson(withoutDigest)
  );
}
