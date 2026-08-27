import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModelTargets,
  createPermissionPolicy,
  createPresentationPreferences,
  createWorkspaceTrust,
} from "@adam-agent/agent";
import { expect, test } from "vitest";
import { createProductionProjectRuntime } from "./project-runtime.js";
import { removeTuiFixtureRoot as rm } from "./tui-filesystem.test-support.js";

test("the project runtime owns only one Presentation across a concurrent close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-project-runtime-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  await mkdir(workspaceRoot);

  try {
    const environment = {
      DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
      XDG_CONFIG_HOME: join(testRoot, "config"),
    };
    const runtime = await createProductionProjectRuntime({
      environment,
      extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      modelTargets: createModelTargets({ environment }),
      permissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["write", "execute", "network", "delegate", "administrative"],
      }),
      preferences: createPresentationPreferences({ environment }),
      projectLabel: "runtime-fixture",
      reservedCommandNames: [],
      stateRoot,
      workspaceRoot,
      workspaceTrust: createWorkspaceTrust({ environment, workspaceRoot }),
    });

    const presentation = runtime.createPresentation({ openProject: true });
    await expect(runtime.createPresentation({ openProject: true })).rejects.toThrow(
      "The production project runtime already owns its Presentation.",
    );
    const closing = runtime.close();
    await expect(runtime.createPresentation({ openProject: true })).rejects.toThrow(
      "The production project runtime is closing or closed.",
    );
    await expect(presentation).resolves.toBeDefined();
    await expect(closing).resolves.toBeUndefined();
    await expect(runtime.createPresentation({ openProject: true })).rejects.toThrow(
      "The production project runtime is closing or closed.",
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
