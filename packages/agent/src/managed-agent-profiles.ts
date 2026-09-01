export const scoutManagedAgentProfileV1 = {
  id: "scout.v1",
  version: 1,
  toolNames: ["read_file", "search_repository"],
  allowedEffects: ["read"],
  limits: {
    maximumTurnsPerAttempt: 8,
    maximumCumulativeTokens: 128_000,
    maximumDeadlineMilliseconds: 10 * 60 * 1_000,
  },
  capabilities: {
    background: false,
    selectedSkills: false,
    ambientExtensions: false,
    parentCoordination: false,
    nestedAgents: false,
  },
} as const;

export type ScoutManagedAgentProfileV1 = typeof scoutManagedAgentProfileV1;
