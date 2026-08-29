import { createHash } from "node:crypto";

import type { ToolEffect } from "./tool-runtime.js";

export const planPolicyVersions = ["plan-policy.read-v1"] as const;

export type PlanPolicyVersion = (typeof planPolicyVersions)[number];

export type PlanEligibleToolProfileV1 = {
  readonly version: 1;
  readonly source: {
    readonly version: 1;
    readonly digest: `sha256:${string}`;
  };
  readonly definitions: readonly {
    readonly name: string;
    readonly definitionDigest: `sha256:${string}`;
    readonly effect: ToolEffect;
    readonly source: "builtin" | "mcp";
  }[];
  readonly digest: `sha256:${string}`;
};

export type PlanCycleSnapshot = {
  readonly state: "exploring";
  readonly cycleId: string;
  readonly revision: number;
  readonly policyVersion: PlanPolicyVersion;
  readonly eligibleToolProfile: PlanEligibleToolProfileV1;
};

export function createReadOnlyPlanToolProfileV1(
  input: Omit<PlanEligibleToolProfileV1, "digest" | "version">,
): PlanEligibleToolProfileV1 {
  const profile = {
    version: 1 as const,
    source: input.source,
    definitions: input.definitions,
  };
  return { ...profile, digest: digestPlanProfile(profile) };
}

export function isReadOnlyPlanToolProfileV1Valid(profile: PlanEligibleToolProfileV1): boolean {
  const { digest, ...withoutDigest } = profile;
  return (
    profile.version === 1 &&
    /^sha256:[0-9a-f]{64}$/u.test(profile.source.digest) &&
    profile.definitions.length > 0 &&
    profile.definitions.length <= 64 &&
    new Set(profile.definitions.map((definition) => definition.name)).size ===
      profile.definitions.length &&
    profile.definitions.every(
      (definition) =>
        definition.name.length > 0 &&
        definition.name.length <= 256 &&
        /^sha256:[0-9a-f]{64}$/u.test(definition.definitionDigest) &&
        definition.effect === "read" &&
        (definition.source === "builtin" || definition.source === "mcp"),
    ) &&
    digest === digestPlanProfile(withoutDigest)
  );
}

function digestPlanProfile(input: Omit<PlanEligibleToolProfileV1, "digest">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
