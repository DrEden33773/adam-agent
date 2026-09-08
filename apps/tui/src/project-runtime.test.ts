import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

test.each([
  { configuration: "enabled", rejectedCount: 0, available: true },
  { configuration: "disabled", rejectedCount: 0, available: false },
  { configuration: "absent", rejectedCount: 0, available: false },
  { configuration: "missing-package", rejectedCount: 0, available: false },
  { configuration: "wrong-version", rejectedCount: 1, available: false },
  { configuration: "missing-grant", rejectedCount: 1, available: false },
] as const)(
  "ordinary production exact public Eve configuration $configuration preserves admission and Main availability",
  async (scenario) => {
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
    if (scenario.available) {
      const manifest = JSON.parse(await readFile(join(evePackageRoot, "package.json"), "utf8"));
      expect(manifest).toMatchObject({
        name: "@eve-reviewer/adam-extension",
        version: "0.6.0",
        dependencies: { "@eve-reviewer/core": "0.4.0" },
        peerDependencies: { "@adam-agent/extension-api": "0.6.0" },
        adamAgent: {
          id: "eve-reviewer",
          apiVersion: ">=0.6.0 <0.7.0",
          capabilities: {
            required: [
              { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
              { id: "adam.artifact.publish@1", version: "1.0.0" },
              { id: "adam.storage.records@1", version: "1.0.0" },
              { id: "adam.managed-review@1", version: "1.0.0" },
            ],
            optional: [],
          },
        },
      });
      const require = createRequire(join(evePackageRoot, "package.json"));
      for (const [name, version] of [
        ["@eve-reviewer/core", "0.4.0"],
        ["@adam-agent/extension-api", "0.6.0"],
      ] as const) {
        const entry = await realpath(require.resolve(name));
        const dependency = JSON.parse(
          await readFile(join(dirname(dirname(entry)), "package.json"), "utf8"),
        );
        expect(dependency).toMatchObject({ name, version });
      }
    }
    if (scenario.configuration !== "absent")
      await writeFile(
        join(configDirectory, "extensions.json"),
        JSON.stringify({
          schemaVersion: 1,
          extensions: [
            {
              enabled: scenario.configuration !== "disabled",
              extensionId: "eve-reviewer",
              grants: [
                { id: "adam.analyzer-execution.biome@1", version: "1.0.0" },
                { id: "adam.artifact.publish@1", version: "1.0.0" },
                { id: "adam.storage.records@1", version: "1.0.0" },
                ...(scenario.configuration === "missing-grant"
                  ? []
                  : [{ id: "adam.managed-review@1", version: "1.0.0" }]),
              ],
              packageName: "@eve-reviewer/adam-extension",
              packageRoot:
                scenario.configuration === "missing-package"
                  ? join(testRoot, "missing-extension")
                  : evePackageRoot,
              packageVersion: scenario.configuration === "wrong-version" ? "0.5.0" : "0.6.0",
            },
          ],
        }),
        { encoding: "utf8", mode: 0o600 },
      );
    const environment = {
      DEEPSEEK_API_KEY: "deterministic-non-network-fixture",
      XDG_CONFIG_HOME: configRoot,
    };
    let providerCalls = 0;
    const runtime = await createProductionProjectRuntime({
      environment,
      extensionPermissions: createPermissionPolicy({ allowedEffects: ["execute"] }),
      modelTargets: createModelTargets({
        environment,
        fetch: async () => {
          providerCalls += 1;
          throw new Error("Configuring extensions and opening Main must not call the provider.");
        },
      }),
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
        configurationUnavailable: scenario.configuration === "missing-package",
        rejectedCount: scenario.rejectedCount,
      });
      if (scenario.available)
        expect(runtime.contributions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              extensionId: "eve-reviewer",
              id: "eve-reviewer.local-worktree-review@1",
              managedOutput: { id: "eve-reviewer.model-review-candidates", version: 1 },
            }),
          ]),
        );
      else expect(runtime.contributions).toEqual([]);
      const presentation = await runtime.createPresentation({ openProject: true });
      expect(
        await presentation.dispatch({
          type: "create_session",
          targetId: "deepseek-v4-flash-vision-exp.direct",
        }),
      ).toMatchObject({ status: "admitted" });
      expect(presentation.getState().draft?.targetId).toBe("deepseek-v4-flash-vision-exp.direct");
      expect(providerCalls).toBe(0);
    } finally {
      await runtime.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
);
