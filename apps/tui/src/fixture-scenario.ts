export const fixtureScenarios = [
  "cancellation",
  "clipboard-timeout",
  "clipboard-success",
  "deadline",
  "history",
  "mcp-close-unconfirmed",
  "mutation",
  "mutation-after-release",
  "mutation-delayed-preview",
  "read",
  "resume",
  "session-selection-history",
  "shell",
  "skill-selection",
  "streaming",
  "target-navigation",
  "unsafe-history",
  "unsafe-output",
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number];

export function isFixtureScenario(value: string): value is FixtureScenario {
  return (fixtureScenarios as readonly string[]).includes(value);
}
