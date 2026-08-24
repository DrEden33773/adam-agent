import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { loadExtensionConfiguration } from "./extension-configuration.js";

test("the optional Owner extension configuration accepts only an absent directory or file", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-configuration-optional-"));
  try {
    await expect(
      loadExtensionConfiguration(
        { XDG_CONFIG_HOME: join(testRoot, "missing") },
        { allowMissing: true },
      ),
    ).resolves.toEqual([]);
    const configDirectory = join(testRoot, "config", "adam-agent");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await chmod(configDirectory, 0o700);
    await expect(
      loadExtensionConfiguration(
        { XDG_CONFIG_HOME: join(testRoot, "config") },
        { allowMissing: true },
      ),
    ).resolves.toEqual([]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("an existing Owner configuration never swallows an unavailable package root", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-configuration-package-"));
  const configRoot = join(testRoot, "config");
  const configDirectory = join(configRoot, "adam-agent");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await writeFile(
    join(configDirectory, "extensions.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          configuration: null,
          enabled: true,
          extensionId: "fixture.missing",
          grants: [],
          packageName: "@fixture/missing",
          packageRoot: join(testRoot, "missing-package"),
          packageVersion: "1.0.0",
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    await expect(
      loadExtensionConfiguration({ XDG_CONFIG_HOME: configRoot }, { allowMissing: true }),
    ).rejects.toMatchObject({
      code: "extension_configuration_unavailable",
      name: "ExtensionConfigurationError",
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
