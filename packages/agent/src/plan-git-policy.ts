import { createHash } from "node:crypto";

import { planGitAutomaticCommandCorpusVersion } from "./plan-command-assessment.js";
import type { PlanShellFileIdentityV1 } from "./plan-shell-environment.js";

const gitConfigurationOverrides = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["core.excludesFile", "/dev/null"],
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["interactive.diffFilter", ""],
  ["color.ui", "false"],
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["submodule.recurse", "false"],
  ["status.submoduleSummary", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["log.showSignature", "false"],
  ["protocol.allow", "never"],
] as const;

export type PlanGitEnvironmentV1 = {
  readonly version: "git-auto-env.v1";
  readonly variables: Readonly<Record<string, string>>;
  readonly digest: `sha256:${string}`;
};

export type PlanGitAutomaticPolicyV1 = {
  readonly version: "git-auto-policy.v1";
  readonly commandCorpusVersion: "plan-git-corpus.v1";
  readonly environmentVersion: "git-auto-env.v1";
  readonly environmentDigest: `sha256:${string}`;
  readonly exactGitVersion: "git version 2.43.0";
  readonly digest: `sha256:${string}`;
};

export type PlanGitAttestationV1 = {
  readonly version: "git-auto-attestation.v1";
  readonly gitVersion: "git version 2.43.0";
  readonly executable: PlanShellFileIdentityV1;
  readonly shellEnvironmentDigest: `sha256:${string}`;
  readonly gitEnvironmentDigest: `sha256:${string}`;
  readonly gitPolicyVersion: "git-auto-policy.v1";
  readonly gitPolicyDigest: `sha256:${string}`;
  readonly digest: `sha256:${string}`;
};

export const planGitEnvironmentV1: PlanGitEnvironmentV1 = (() => {
  const variables: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_COUNT: String(gitConfigurationOverrides.length),
  };
  gitConfigurationOverrides.forEach(([key, value], index) => {
    variables[`GIT_CONFIG_KEY_${index}`] = key;
    variables[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const identity = { version: "git-auto-env.v1" as const, variables };
  return { ...identity, digest: digest(identity) };
})();

export const planGitAutomaticPolicyV1: PlanGitAutomaticPolicyV1 = (() => {
  const identity = {
    version: "git-auto-policy.v1" as const,
    commandCorpusVersion: planGitAutomaticCommandCorpusVersion,
    environmentVersion: planGitEnvironmentV1.version,
    environmentDigest: planGitEnvironmentV1.digest,
    exactGitVersion: "git version 2.43.0" as const,
  };
  return { ...identity, digest: digest(identity) };
})();

export function createPlanGitAttestationV1(input: {
  readonly executable: PlanShellFileIdentityV1;
  readonly shellEnvironmentDigest: `sha256:${string}`;
}): PlanGitAttestationV1 {
  const identity = {
    version: "git-auto-attestation.v1" as const,
    gitVersion: "git version 2.43.0" as const,
    executable: input.executable,
    shellEnvironmentDigest: input.shellEnvironmentDigest,
    gitEnvironmentDigest: planGitEnvironmentV1.digest,
    gitPolicyVersion: planGitAutomaticPolicyV1.version,
    gitPolicyDigest: planGitAutomaticPolicyV1.digest,
  };
  return { ...identity, digest: digest(identity) };
}

export function isPlanGitAttestationV1Valid(attestation: PlanGitAttestationV1): boolean {
  const { digest: attestationDigest, ...identity } = attestation;
  return (
    attestation.version === "git-auto-attestation.v1" &&
    attestation.gitVersion === "git version 2.43.0" &&
    attestation.gitEnvironmentDigest === planGitEnvironmentV1.digest &&
    attestation.gitPolicyVersion === planGitAutomaticPolicyV1.version &&
    attestation.gitPolicyDigest === planGitAutomaticPolicyV1.digest &&
    attestationDigest === digest(identity)
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
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
