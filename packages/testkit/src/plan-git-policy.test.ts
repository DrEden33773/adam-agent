import { planGitAutomaticPolicyV1, planGitEnvironmentV1 } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

test("Plan Git automatic environment freezes every noninteractive override in order", () => {
  expect(planGitEnvironmentV1).toEqual({
    version: "git-auto-env.v1",
    variables: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_CONFIG_COUNT: "15",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "core.attributesFile",
      GIT_CONFIG_VALUE_2: "/dev/null",
      GIT_CONFIG_KEY_3: "core.excludesFile",
      GIT_CONFIG_VALUE_3: "/dev/null",
      GIT_CONFIG_KEY_4: "core.pager",
      GIT_CONFIG_VALUE_4: "cat",
      GIT_CONFIG_KEY_5: "diff.external",
      GIT_CONFIG_VALUE_5: "",
      GIT_CONFIG_KEY_6: "interactive.diffFilter",
      GIT_CONFIG_VALUE_6: "",
      GIT_CONFIG_KEY_7: "color.ui",
      GIT_CONFIG_VALUE_7: "false",
      GIT_CONFIG_KEY_8: "maintenance.auto",
      GIT_CONFIG_VALUE_8: "false",
      GIT_CONFIG_KEY_9: "gc.auto",
      GIT_CONFIG_VALUE_9: "0",
      GIT_CONFIG_KEY_10: "submodule.recurse",
      GIT_CONFIG_VALUE_10: "false",
      GIT_CONFIG_KEY_11: "status.submoduleSummary",
      GIT_CONFIG_VALUE_11: "false",
      GIT_CONFIG_KEY_12: "diff.ignoreSubmodules",
      GIT_CONFIG_VALUE_12: "all",
      GIT_CONFIG_KEY_13: "log.showSignature",
      GIT_CONFIG_VALUE_13: "false",
      GIT_CONFIG_KEY_14: "protocol.allow",
      GIT_CONFIG_VALUE_14: "never",
    },
    digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
  });
});

test("Plan Git automatic policy freezes the corpus and environment identity", () => {
  expect(planGitAutomaticPolicyV1).toEqual({
    version: "git-auto-policy.v1",
    commandCorpusVersion: "plan-git-corpus.v1",
    environmentVersion: "git-auto-env.v1",
    environmentDigest: planGitEnvironmentV1.digest,
    exactGitVersion: "git version 2.43.0",
    digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
  });
});
