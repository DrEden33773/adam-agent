import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ModelTargetIdentity } from "./model-targets.js";

export type ThinkingPolicyMappingV1 =
  | {
      readonly requestPath: "provider_options.deepseek";
      readonly thinkingType: "disabled";
    }
  | {
      readonly requestPath: "provider_options.deepseek";
      readonly thinkingType: "enabled";
      readonly reasoningEffort: "low" | "high" | "max";
    };

export type ThinkingCapabilityV1 = {
  readonly schemaVersion: 1;
  readonly capabilityId: string;
  readonly capabilityVersion: 1;
  readonly capabilityDigest: `sha256:${string}`;
  readonly targetIdentity: ModelTargetIdentity;
  readonly providerProfile: {
    readonly id: "@ai-sdk/deepseek/chat";
    readonly version: "3.0.28";
    readonly requestPath: "provider_options.deepseek";
  };
  readonly supportsOff: true;
  readonly defaultLevelId: string;
  readonly providerDefault: {
    readonly effectiveLevelId: string;
    readonly mutable: true;
  };
  readonly levels: readonly {
    readonly id: string;
    readonly label: string;
    readonly effectiveLevelId: string;
    readonly mapping: ThinkingPolicyMappingV1;
  }[];
  readonly reasoningArtifact: "provider_reasoning";
};

export type ThinkingPolicySnapshotV1 = {
  readonly schemaVersion: 1;
  readonly requestedLevelId: string;
  readonly effectiveLevelId: string;
  readonly capability: {
    readonly id: string;
    readonly version: 1;
    readonly digest: `sha256:${string}`;
  };
  readonly mapping: ThinkingPolicyMappingV1;
  readonly reasoningArtifact: "provider_reasoning";
};

export type ThinkingPolicySelectionV1 = {
  readonly requestedLevelId: string;
  readonly capability: {
    readonly id: string;
    readonly version: 1;
    readonly digest: `sha256:${string}`;
  };
};

export class ThinkingPolicyError extends Error {
  readonly code: "capability_invalid" | "level_unsupported";
  readonly supportedLevelIds: readonly string[];

  constructor(
    code: "capability_invalid" | "level_unsupported",
    message: string,
    supportedLevelIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "ThinkingPolicyError";
    this.code = code;
    this.supportedLevelIds = supportedLevelIds;
  }
}

export function createDirectDeepSeekThinkingCapability(
  targetIdentity: ModelTargetIdentity,
): ThinkingCapabilityV1 {
  if (targetIdentity.vendor !== "deepseek" || targetIdentity.route !== "direct") {
    throw new TypeError("A Direct DeepSeek thinking capability requires a Direct DeepSeek target.");
  }
  const capability = {
    schemaVersion: 1 as const,
    capabilityId: `deepseek-chat-thinking:${targetIdentity.targetId}:target-profile-${targetIdentity.profileVersion}`,
    capabilityVersion: 1 as const,
    targetIdentity,
    providerProfile: {
      id: "@ai-sdk/deepseek/chat" as const,
      version: "3.0.28" as const,
      requestPath: "provider_options.deepseek" as const,
    },
    supportsOff: true as const,
    defaultLevelId: "high",
    providerDefault: { effectiveLevelId: "high", mutable: true as const },
    levels: [
      {
        id: "off",
        label: "Off",
        effectiveLevelId: "off",
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "disabled" as const,
        },
      },
      {
        id: "low",
        label: "Low",
        effectiveLevelId: "low",
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "enabled" as const,
          reasoningEffort: "low" as const,
        },
      },
      {
        id: "high",
        label: "High",
        effectiveLevelId: "high",
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "enabled" as const,
          reasoningEffort: "high" as const,
        },
      },
      {
        id: "max",
        label: "Max",
        effectiveLevelId: "max",
        mapping: {
          requestPath: "provider_options.deepseek" as const,
          thinkingType: "enabled" as const,
          reasoningEffort: "max" as const,
        },
      },
    ],
    reasoningArtifact: "provider_reasoning" as const,
  };
  return Object.freeze({
    ...capability,
    capabilityDigest: digestCapability(capability),
  });
}

export function resolveThinkingPolicy(
  capability: ThinkingCapabilityV1,
  requestedLevelId: string = capability.defaultLevelId,
  expectedTargetIdentity?: ModelTargetIdentity,
): ThinkingPolicySnapshotV1 {
  const supportedLevelIds = capability.levels.map((candidate) => candidate.id);
  if (
    expectedTargetIdentity !== undefined &&
    !isDeepStrictEqual(capability.targetIdentity, expectedTargetIdentity)
  ) {
    throw new ThinkingPolicyError(
      "capability_invalid",
      "The thinking capability does not apply to the exact model target.",
      supportedLevelIds,
    );
  }
  const { capabilityDigest: _digest, ...digestInput } = capability;
  if (digestCapability(digestInput) !== capability.capabilityDigest) {
    throw new ThinkingPolicyError(
      "capability_invalid",
      "The exact thinking capability profile is not supported by this runtime.",
      supportedLevelIds,
    );
  }
  const level = capability.levels.find((candidate) => candidate.id === requestedLevelId);
  if (level === undefined) {
    throw new ThinkingPolicyError(
      "level_unsupported",
      `Thinking level ${requestedLevelId} is unavailable. Choose ${supportedLevelIds.join(", ")}.`,
      supportedLevelIds,
    );
  }
  return {
    schemaVersion: 1,
    requestedLevelId: level.id,
    effectiveLevelId: level.effectiveLevelId,
    capability: {
      id: capability.capabilityId,
      version: capability.capabilityVersion,
      digest: capability.capabilityDigest,
    },
    mapping: level.mapping,
    reasoningArtifact: capability.reasoningArtifact,
  };
}

function digestCapability(input: object): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}
