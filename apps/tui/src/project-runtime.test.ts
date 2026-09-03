import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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

test("the production runtime activates the exact public Eve managed-review contribution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-project-runtime-eve-"));
  const workspaceRoot = join(testRoot, "workspace");
  const stateRoot = join(testRoot, "state");
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  await mkdir(workspaceRoot);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const evePackageRoot = await realpath(
    join(process.cwd(), "node_modules", "@eve-reviewer", "adam-extension"),
  );
  await writeFile(
    join(configDirectory, "extensions.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          enabled: true,
          extensionId: "eve-reviewer",
          grants: [
            { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
            { id: "adam.artifact.publish@1", version: "1.0.0" },
            { id: "adam.storage.records@1", version: "1.0.0" },
            { id: "adam.managed-session@2", version: "2.0.0" },
          ],
          packageName: "@eve-reviewer/adam-extension",
          packageRoot: evePackageRoot,
          packageVersion: "0.5.0",
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  const environment = {
    DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
    XDG_CONFIG_HOME: configRoot,
  };
  const runtime = await createProductionProjectRuntime({
    environment,
    extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
    modelTargets: createModelTargets({ environment }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    preferences: createPresentationPreferences({ environment }),
    projectLabel: "eve-runtime-fixture",
    reservedCommandNames: [],
    stateRoot,
    workspaceRoot,
    workspaceTrust: createWorkspaceTrust({ environment, workspaceRoot }),
  });

  try {
    expect(runtime.extensionAvailability).toEqual({
      configurationUnavailable: false,
      rejectedCount: 0,
    });
    expect(runtime.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: "eve-reviewer",
          id: "eve-reviewer.local-worktree-review@1",
          managedOutput: { id: "eve-reviewer.model-review-candidates", version: 1 },
        }),
      ]),
    );
  } finally {
    await runtime.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});
