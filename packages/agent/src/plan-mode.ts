import { createHash } from "node:crypto";

import type { ArtifactReference, PlanArtifactSourceV1 } from "./artifact-store.js";
import type { PlanShellPolicyVersion } from "./plan-command-assessment.js";
import type { PlanGitAttestationV1 } from "./plan-git-policy.js";
import type { PlanShellEnvironmentV1 } from "./plan-shell-environment.js";
import type { ModelToolDefinition, ToolEffect } from "./tool-runtime.js";

export const planPolicyVersions = ["plan-policy.read-v1", "plan-policy.hybrid-v1"] as const;

export const submitPlanToolDefinitionV1: ModelToolDefinition = {
  name: "submit_plan",
  description:
    "Publish the exact completed Markdown plan for external review. This ends the current Plan run.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["markdown"],
    properties: {
      title: { type: "string" },
      markdown: { type: "string" },
    },
  },
};

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
    readonly mcp?:
      | {
          readonly serverId: string;
          readonly originalName: string;
          readonly serverDefinitionDigest: `sha256:${string}`;
        }
      | undefined;
  }[];
  readonly digest: `sha256:${string}`;
};

type PlanCycleSnapshotBase = {
  readonly cycleId: string;
  readonly revision: number;
  readonly policyVersion: PlanPolicyVersion;
  readonly shellPolicyVersion?: PlanShellPolicyVersion;
  readonly shellEnvironment?: PlanShellEnvironmentV1;
  readonly gitPolicyVersion?: "git-auto-policy.v1";
  readonly gitPolicyDigest?: `sha256:${string}`;
  readonly gitAttestation?: PlanGitAttestationV1;
  readonly eligibleToolProfile: PlanEligibleToolProfileV1;
};

export type PlanSubmissionSnapshotV1 = {
  readonly planId: string;
  readonly revision: number;
  readonly contentDigest: `sha256:${string}`;
  readonly title?: string;
  readonly artifact: ArtifactReference<PlanArtifactSourceV1>;
  readonly policyVersion: PlanPolicyVersion;
  readonly toolProfileDigest: `sha256:${string}`;
};

export type PlanRevisionIntentV1 = {
  readonly cycleId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly planId: string;
  readonly contentDigest: `sha256:${string}`;
};

export type PlanApprovalIntentV1 = {
  readonly sessionId: string;
  readonly commandId: string;
  readonly kickoffRunId: string;
  readonly cycleId: string;
  readonly revision: number;
  readonly planId: string;
  readonly contentDigest: `sha256:${string}`;
  readonly policyVersion: PlanPolicyVersion;
  readonly toolProfileDigest: `sha256:${string}`;
};

export type ApprovedPlanProjectionV1 = PlanApprovalIntentV1 & {
  readonly version: 1;
  readonly title?: string;
  readonly markdown: string;
};

export function digestApprovedPlanProjectionV1(
  input: Omit<ApprovedPlanProjectionV1, "markdown">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        version: input.version,
        sessionId: input.sessionId,
        commandId: input.commandId,
        kickoffRunId: input.kickoffRunId,
        cycleId: input.cycleId,
        revision: input.revision,
        planId: input.planId,
        contentDigest: input.contentDigest,
        title: input.title ?? null,
        policyVersion: input.policyVersion,
        toolProfileDigest: input.toolProfileDigest,
      }),
    )
    .digest("hex")}`;
}

export type PlanCycleSnapshot = PlanCycleSnapshotBase &
  (
    | { readonly state: "exploring" }
    | { readonly state: "ready"; readonly submission: PlanSubmissionSnapshotV1 }
    | {
        readonly state: "approved_not_started";
        readonly submission: PlanSubmissionSnapshotV1;
        readonly approval: PlanApprovalIntentV1;
      }
  );

export function createPlanToolProfileV1(
  input: Omit<PlanEligibleToolProfileV1, "digest" | "version">,
): PlanEligibleToolProfileV1 {
  const profile = {
    version: 1 as const,
    source: input.source,
    definitions: input.definitions,
  };
  return { ...profile, digest: digestPlanProfile(profile) };
}

export function isPlanToolProfileV1Valid(
  profile: PlanEligibleToolProfileV1,
  policyVersion: PlanPolicyVersion,
): boolean {
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
        (definition.effect === "read" ||
          (policyVersion === "plan-policy.hybrid-v1" &&
            ((definition.source === "builtin" &&
              definition.name === "run_shell" &&
              definition.effect === "execute") ||
              (definition.source === "mcp" &&
                (definition.effect === "execute" || definition.effect === "network"))))) &&
        (definition.source === "builtin" || definition.source === "mcp") &&
        (definition.source === "builtin"
          ? definition.mcp === undefined
          : (definition.mcp === undefined && policyVersion === "plan-policy.read-v1") ||
            (definition.mcp !== undefined &&
              definition.mcp.serverId.length > 0 &&
              definition.mcp.serverId.length <= 128 &&
              definition.mcp.originalName.length > 0 &&
              definition.mcp.originalName.length <= 256 &&
              /^sha256:[0-9a-f]{64}$/u.test(definition.mcp.serverDefinitionDigest))),
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
