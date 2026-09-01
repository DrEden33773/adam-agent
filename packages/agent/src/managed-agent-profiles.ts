import { createHash } from "node:crypto";

const scoutManagedAgentProfileDefinitionV1 = {
  id: "scout.v1",
  version: 1,
  toolNames: ["read_file", "search_repository"],
  allowedEffects: ["read"],
  limits: {
    maximumTurnsPerAttempt: 8,
    maximumCumulativeTokens: 128_000,
    maximumDeadlineMilliseconds: 600_000 as const,
  },
  capabilities: {
    background: false,
    selectedSkills: false,
    ambientExtensions: false,
    parentCoordination: false,
    nestedAgents: false,
  },
} as const;

export const scoutManagedAgentProfileV1 = {
  ...scoutManagedAgentProfileDefinitionV1,
  digest: `sha256:${createHash("sha256")
    .update(JSON.stringify(scoutManagedAgentProfileDefinitionV1))
    .digest("hex")}` as const,
};

export type ScoutManagedAgentProfileV1 = typeof scoutManagedAgentProfileV1;

const researchManagedAgentProfileDefinitionV1 = {
  id: "research.v1",
  version: 1,
  toolNames: [
    "read_file",
    "search_repository",
    "read_skill_resource",
    "web_search",
    "web_fetch",
    "web_open",
    "web_find",
    "report_to_parent",
    "request_parent_input",
  ],
  allowedEffects: ["read", "network", "delegate"],
  limits: {
    maximumTurnsPerAttempt: 8,
    maximumCumulativeTokens: 128_000,
    maximumDeadlineMilliseconds: 600_000 as const,
  },
  capabilities: {
    background: true,
    selectedSkills: true,
    ambientExtensions: false,
    parentCoordination: true,
    nestedAgents: false,
  },
} as const;

export const researchManagedAgentProfileV1 = {
  ...researchManagedAgentProfileDefinitionV1,
  digest: `sha256:${createHash("sha256")
    .update(JSON.stringify(researchManagedAgentProfileDefinitionV1))
    .digest("hex")}` as const,
};

export type ResearchManagedAgentProfileV1 = typeof researchManagedAgentProfileV1;
