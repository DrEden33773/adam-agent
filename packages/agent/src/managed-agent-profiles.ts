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

const scoutManagedAgentProfileDefinitionV2 = {
  id: "scout.v2",
  version: 2,
  toolNames: ["read_file", "search_repository"],
  allowedEffects: ["read"],
  limits: {
    maximumCumulativeTokens: "inherited_context_window",
    maximumInactivityMilliseconds: 300_000 as const,
    maximumAttemptsPerAgent: 4 as const,
    maximumAttemptsPerParent: 16 as const,
  },
  capabilities: {
    background: false,
    selectedSkills: false,
    ambientExtensions: false,
    parentCoordination: false,
    nestedAgents: false,
  },
} as const;

export const scoutManagedAgentProfileV2 = {
  ...scoutManagedAgentProfileDefinitionV2,
  digest: `sha256:${createHash("sha256")
    .update(JSON.stringify(scoutManagedAgentProfileDefinitionV2))
    .digest("hex")}` as const,
};

export type ScoutManagedAgentProfileV2 = typeof scoutManagedAgentProfileV2;

const researchManagedAgentProfileDefinitionV2 = {
  id: "research.v2",
  version: 2,
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
    maximumCumulativeTokens: "inherited_context_window",
    maximumInactivityMilliseconds: 300_000 as const,
    maximumAttemptsPerAgent: 4 as const,
    maximumAttemptsPerParent: 16 as const,
  },
  capabilities: {
    background: true,
    selectedSkills: true,
    ambientExtensions: false,
    parentCoordination: true,
    nestedAgents: false,
  },
} as const;

export const researchManagedAgentProfileV2 = {
  ...researchManagedAgentProfileDefinitionV2,
  digest: `sha256:${createHash("sha256")
    .update(JSON.stringify(researchManagedAgentProfileDefinitionV2))
    .digest("hex")}` as const,
};

export type ResearchManagedAgentProfileV2 = typeof researchManagedAgentProfileV2;

const reviewerManagedAgentProfileDefinitionV1 = {
  id: "reviewer.v1",
  version: 1,
  toolNames: [],
  allowedEffects: [],
  limits: {
    maximumTurnsPerAttempt: 8,
    maximumCumulativeTokens: 128_000,
    maximumDeadlineMilliseconds: 300_000 as const,
  },
  capabilities: {
    background: false,
    selectedSkills: false,
    ambientExtensions: false,
    parentCoordination: false,
    nestedAgents: false,
  },
} as const;

export const reviewerManagedAgentProfileV1 = {
  ...reviewerManagedAgentProfileDefinitionV1,
  digest: `sha256:${createHash("sha256")
    .update(JSON.stringify(reviewerManagedAgentProfileDefinitionV1))
    .digest("hex")}` as const,
};

export type ReviewerManagedAgentProfileV1 = typeof reviewerManagedAgentProfileV1;
