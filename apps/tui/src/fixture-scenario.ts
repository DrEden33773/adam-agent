export const fixtureScenarios = [
  "artifact-backed-assistant",
  "artifact-page-race",
  "artifact-history",
  "cancellation",
  "clipboard-timeout",
  "clipboard-success",
  "copy-large-assistant",
  "copy-older-assistant",
  "deadline",
  "history",
  "mcp-close-unconfirmed",
  "mutation",
  "mutation-after-release",
  "mutation-delayed-preview",
  "provider-no-usage",
  "provider-usage",
  "read",
  "resume",
  "session-selection-history",
  "shell",
  "skill-selection",
  "streaming",
  "target-navigation",
  "tool-artifact",
  "unsafe-history",
  "unsafe-output",
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number];

export function isFixtureScenario(value: string): value is FixtureScenario {
  return (fixtureScenarios as readonly string[]).includes(value);
}
