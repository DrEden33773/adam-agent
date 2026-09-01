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
