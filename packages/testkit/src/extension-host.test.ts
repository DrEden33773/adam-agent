import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtensionHost } from "@adam-agent/agent";
import { afterEach, expect, test, vi } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a missing required capability rejects an extension before its runtime is imported", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = testRoot;
  const markerPath = join(testRoot, "runtime-imported.txt");
  await writeFile(
    join(testRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/requires-missing-capability",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.requires-missing-capability",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability.missing", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(testRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );

  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.requires-missing-capability",
        grants: [],
        packageName: "@fixture/requires-missing-capability",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            capabilityId: "fixture.capability.missing",
            code: "required_capability_unavailable",
            requestedVersion: "^1.0.0",
          },
        ],
        extensionId: "fixture.requires-missing-capability",
        packageName: "@fixture/requires-missing-capability",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a locked ESM extension with no capabilities or contributions activates", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-activated.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/empty-extension",
      version: "1.2.3",
      type: "module",
      adamAgent: {
        id: "fixture.empty-extension",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
export async function activate() {
  await writeFile(${JSON.stringify(markerPath)}, "activated", "utf8");
}
`,
    "utf8",
  );

  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.empty-extension",
        grants: [],
        packageName: "@fixture/empty-extension",
        packageRoot,
        packageVersion: "1.2.3",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [],
        extensionId: "fixture.empty-extension",
        packageName: "@fixture/empty-extension",
        packageVersion: "1.2.3",
        status: "active",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).resolves.toBe("activated");
});

test("a CommonJS runtime entry rejects before import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/commonjs-runtime",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.commonjs-runtime",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.cjs" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.cjs"),
    `const { writeFile } = require("node:fs/promises");
writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
exports.activate = async function activate() {};
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.commonjs-runtime",
        grants: [],
        packageName: "@fixture/commonjs-runtime",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ diagnostics: [{ code: "runtime_entry_invalid" }], status: "rejected" }],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a declared operation becomes visible only after its matching runtime registration", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/echo-extension",
      version: "2.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.echo-extension",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            kind: "operation",
            id: "fixture.echo",
            input: { id: "fixture.echo.input", version: 1 },
            output: { id: "fixture.echo.output", version: 1 },
            progress: { id: "fixture.echo.progress", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({
  id,
  version: 1,
  decode: (value) => ({ ok: true, value }),
  encode: (value) => ({ ok: true, value }),
});
export async function activate(context) {
  context.registerOperation({
    id: "fixture.echo",
    input: codec("fixture.echo.input"),
    output: codec("fixture.echo.output"),
    progress: codec("fixture.echo.progress"),
    execute: async (input) => input,
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.echo-extension",
        grants: [],
        packageName: "@fixture/echo-extension",
        packageRoot,
        packageVersion: "2.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ extensionId: "fixture.echo-extension", status: "active" }],
  });
  expect(host.listContributions()).toEqual([
    {
      extensionId: "fixture.echo-extension",
      id: "fixture.echo",
      input: { id: "fixture.echo.input", version: 1 },
      kind: "operation",
      output: { id: "fixture.echo.output", version: 1 },
      progress: { id: "fixture.echo.progress", version: 1 },
    },
  ]);
});

test("a missing runtime registration rejects the activation without publishing contributions", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/missing-registration",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.missing-registration",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            kind: "operation",
            id: "fixture.expected",
            input: { id: "fixture.expected.input", version: 1 },
            output: { id: "fixture.expected.output", version: 1 },
            progress: { id: "fixture.expected.progress", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.missing-registration",
        grants: [],
        packageName: "@fixture/missing-registration",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            code: "declared_contribution_missing",
            contributionId: "fixture.expected",
          },
        ],
        extensionId: "fixture.missing-registration",
        packageName: "@fixture/missing-registration",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("an activation failure discards registrations and becomes a bounded diagnostic", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/throwing-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.throwing-extension",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [
          {
            kind: "operation",
            id: "fixture.never-published",
            input: { id: "fixture.input", version: 1 },
            output: { id: "fixture.output", version: 1 },
            progress: { id: "fixture.progress", version: 1 },
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({
  id,
  version: 1,
  decode: (value) => ({ ok: true, value }),
  encode: (value) => ({ ok: true, value }),
});
export async function activate(context) {
  context.registerOperation({
    id: "fixture.never-published",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute: async (input) => input,
  });
  throw new Error("private activation detail");
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.throwing-extension",
        grants: [],
        packageName: "@fixture/throwing-extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "activation_failed" }],
        extensionId: "fixture.throwing-extension",
        packageName: "@fixture/throwing-extension",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("an unavailable optional capability reports a diagnostic without blocking activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-activated.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/optional-capability",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.optional-capability",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [],
          optional: [{ id: "fixture.capability.optional", version: "^1.0.0" }],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
export async function activate() {
  await writeFile(${JSON.stringify(markerPath)}, "activated", "utf8");
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.optional-capability",
        grants: [],
        packageName: "@fixture/optional-capability",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            capabilityId: "fixture.capability.optional",
            code: "optional_capability_unavailable",
            requestedVersion: "^1.0.0",
          },
        ],
        extensionId: "fixture.optional-capability",
        packageName: "@fixture/optional-capability",
        packageVersion: "1.0.0",
        status: "active",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).resolves.toBe("activated");
});

test("an ungranted required capability rejects an extension before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/ungranted-capability",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.ungranted-capability",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability.required", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability.required", version: "1.4.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.ungranted-capability",
        grants: [],
        packageName: "@fixture/ungranted-capability",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            capabilityId: "fixture.capability.required",
            code: "required_capability_ungranted",
            requestedVersion: "^1.0.0",
          },
        ],
        extensionId: "fixture.ungranted-capability",
        packageName: "@fixture/ungranted-capability",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an incompatible required capability version rejects an extension before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/incompatible-capability",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.incompatible-capability",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability.required", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability.required", version: "2.1.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.incompatible-capability",
        grants: [{ id: "fixture.capability.required", version: "^2.0.0" }],
        packageName: "@fixture/incompatible-capability",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            availableVersion: "2.1.0",
            capabilityId: "fixture.capability.required",
            code: "required_capability_incompatible",
            requestedVersion: "^1.0.0",
          },
        ],
        extensionId: "fixture.incompatible-capability",
        packageName: "@fixture/incompatible-capability",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an incompatible Extension API range rejects an extension before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/incompatible-api",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.incompatible-api",
        apiVersion: "^0.2.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.incompatible-api",
        grants: [],
        packageName: "@fixture/incompatible-api",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            code: "extension_api_incompatible",
            hostVersion: "0.1.0",
            requestedVersion: "^0.2.0",
          },
        ],
        extensionId: "fixture.incompatible-api",
        packageName: "@fixture/incompatible-api",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a package version that differs from the Owner lock rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/version-mismatch",
      version: "1.0.1",
      type: "module",
      adamAgent: {
        id: "fixture.version-mismatch",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.version-mismatch",
        grants: [],
        packageName: "@fixture/version-mismatch",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            actual: "1.0.1",
            code: "package_identity_mismatch",
            expected: "1.0.0",
            field: "version",
          },
        ],
        extensionId: "fixture.version-mismatch",
        packageName: "@fixture/version-mismatch",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an invalid static manifest rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-manifest",
      version: "1.0.0",
      type: "module",
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-manifest",
        grants: [],
        packageName: "@fixture/invalid-manifest",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "manifest_invalid" }],
        extensionId: "fixture.invalid-manifest",
        packageName: "@fixture/invalid-manifest",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a runtime entry that resolves outside its package rejects before import", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const markerPath = join(testRoot, "outside-runtime-imported.txt");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/escaping-entry",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.escaping-entry",
        apiVersion: "^0.1.0",
        runtime: { entry: "../outside.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(testRoot, "outside.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.escaping-entry",
        grants: [],
        packageName: "@fixture/escaping-entry",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "runtime_entry_invalid" }],
        extensionId: "fixture.escaping-entry",
        packageName: "@fixture/escaping-entry",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an undeclared runtime contribution rejects the complete activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/undeclared-contribution",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.undeclared-contribution",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = { id: "fixture.value", version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } };
export async function activate(context) {
  context.registerOperation({ id: "fixture.operation", input: codec, output: codec, progress: codec, execute() {} });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.undeclared-contribution",
        grants: [],
        packageName: "@fixture/undeclared-contribution",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            code: "undeclared_contribution",
            contributionId: "fixture.operation",
          },
        ],
        extensionId: "fixture.undeclared-contribution",
        packageName: "@fixture/undeclared-contribution",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("a runtime contribution with a mismatched contract rejects the complete activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/contract-mismatch",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.contract-mismatch",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id, version) => ({ id, version, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.operation",
    input: codec("fixture.input", 1),
    output: codec("fixture.other-output", 2),
    progress: codec("fixture.progress", 1),
    execute() {},
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.contract-mismatch",
        grants: [],
        packageName: "@fixture/contract-mismatch",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            actual: { id: "fixture.other-output", version: 2 },
            code: "contribution_contract_mismatch",
            contract: "output",
            contributionId: "fixture.operation",
            expected: { id: "fixture.output", version: 1 },
          },
        ],
        extensionId: "fixture.contract-mismatch",
        packageName: "@fixture/contract-mismatch",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("duplicate runtime contribution IDs reject the complete activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.duplicate-operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/duplicate-contribution",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.duplicate-contribution",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
const operation = {
  id: "fixture.duplicate-operation",
  input: codec("fixture.input"),
  output: codec("fixture.output"),
  progress: codec("fixture.progress"),
  execute() {},
};
export async function activate(context) {
  context.registerOperation(operation);
  context.registerOperation(operation);
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.duplicate-contribution",
        grants: [],
        packageName: "@fixture/duplicate-contribution",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            code: "contribution_collision",
            contributionId: "fixture.duplicate-operation",
          },
        ],
        extensionId: "fixture.duplicate-contribution",
        packageName: "@fixture/duplicate-contribution",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("a contribution collision rejects only the later extension activation", async () => {
  const contribution = {
    kind: "operation",
    id: "fixture.shared-operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  const createPackage = async (extensionId: string) => {
    const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
    temporaryRoots.push(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: `@fixture/${extensionId}`,
        version: "1.0.0",
        type: "module",
        adamAgent: {
          id: extensionId,
          apiVersion: "^0.1.0",
          runtime: { entry: "./extension.js" },
          capabilities: { required: [], optional: [] },
          contributions: [contribution],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(packageRoot, "extension.js"),
      `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.shared-operation",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute() {},
  });
}
`,
      "utf8",
    );
    return packageRoot;
  };
  const firstRoot = await createPackage("fixture.first-extension");
  const secondRoot = await createPackage("fixture.second-extension");
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.first-extension",
        grants: [],
        packageName: "@fixture/fixture.first-extension",
        packageRoot: firstRoot,
        packageVersion: "1.0.0",
      },
      {
        enabled: true,
        extensionId: "fixture.second-extension",
        grants: [],
        packageName: "@fixture/fixture.second-extension",
        packageRoot: secondRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [],
        extensionId: "fixture.first-extension",
        packageName: "@fixture/fixture.first-extension",
        packageVersion: "1.0.0",
        status: "active",
      },
      {
        diagnostics: [
          {
            code: "contribution_collision",
            contributionId: "fixture.shared-operation",
          },
        ],
        extensionId: "fixture.second-extension",
        packageName: "@fixture/fixture.second-extension",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([
    { extensionId: "fixture.first-extension", ...contribution },
  ]);
});

test("an ungranted optional capability reports a diagnostic without blocking activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/optional-ungranted",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.optional-ungranted",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [],
          optional: [{ id: "fixture.capability.optional", version: "^1.0.0" }],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability.optional", version: "1.4.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.optional-ungranted",
        grants: [],
        packageName: "@fixture/optional-ungranted",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            capabilityId: "fixture.capability.optional",
            code: "optional_capability_ungranted",
            requestedVersion: "^1.0.0",
          },
        ],
        extensionId: "fixture.optional-ungranted",
        packageName: "@fixture/optional-ungranted",
        packageVersion: "1.0.0",
        status: "active",
      },
    ],
  });
});

test("an incompatible optional capability reports a diagnostic without blocking activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/optional-incompatible",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.optional-incompatible",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [],
          optional: [{ id: "fixture.capability.optional", version: "^2.0.0" }],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability.optional", version: "1.4.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.optional-incompatible",
        grants: [{ id: "fixture.capability.optional", version: "^1.0.0" }],
        packageName: "@fixture/optional-incompatible",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            availableVersion: "1.4.0",
            capabilityId: "fixture.capability.optional",
            code: "optional_capability_incompatible",
            requestedVersion: "^2.0.0",
          },
        ],
        extensionId: "fixture.optional-incompatible",
        packageName: "@fixture/optional-incompatible",
        packageVersion: "1.0.0",
        status: "active",
      },
    ],
  });
});

test("an Owner-disabled extension is not imported or published", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/disabled-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.disabled-extension",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: false,
        extensionId: "fixture.disabled-extension",
        grants: [],
        packageName: "@fixture/disabled-extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [],
        extensionId: "fixture.disabled-extension",
        packageName: "@fixture/disabled-extension",
        packageVersion: "1.0.0",
        status: "disabled",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(host.listContributions()).toEqual([]);
});

test("disabling an idle extension persists before contributions become unavailable", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const stateRoot = join(testRoot, "state");
  const contribution = {
    kind: "operation",
    id: "fixture.persisted-operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  const createPackage = async (directory: string, markerPath: string) => {
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@fixture/persisted-disable",
        version: "1.0.0",
        type: "module",
        adamAgent: {
          id: "fixture.persisted-disable",
          apiVersion: "^0.1.0",
          runtime: { entry: "./extension.js" },
          capabilities: { required: [], optional: [] },
          contributions: [contribution],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(directory, "extension.js"),
      `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.persisted-operation",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute() {},
  });
}
`,
      "utf8",
    );
  };
  const firstPackageRoot = join(testRoot, "first-package");
  const firstMarkerPath = join(testRoot, "first-imported.txt");
  await createPackage(firstPackageRoot, firstMarkerPath);
  const configuredExtension = {
    enabled: true,
    extensionId: "fixture.persisted-disable",
    grants: [],
    packageName: "@fixture/persisted-disable",
    packageRoot: firstPackageRoot,
    packageVersion: "1.0.0",
  };
  const firstHost = createExtensionHost({
    capabilities: [],
    extensions: [configuredExtension],
    stateRoot,
  });
  await firstHost.loadConfiguredExtensions();
  await expect(readFile(firstMarkerPath, "utf8")).resolves.toBe("imported");

  await expect(firstHost.disableExtension("fixture.persisted-disable")).resolves.toEqual({
    diagnostics: [],
    extensionId: "fixture.persisted-disable",
    packageName: "@fixture/persisted-disable",
    packageVersion: "1.0.0",
    status: "disabled",
  });
  expect(firstHost.listContributions()).toEqual([]);

  const secondPackageRoot = join(testRoot, "second-package");
  const secondMarkerPath = join(testRoot, "second-imported.txt");
  await createPackage(secondPackageRoot, secondMarkerPath);
  const secondHost = createExtensionHost({
    capabilities: [],
    extensions: [{ ...configuredExtension, packageRoot: secondPackageRoot }],
    stateRoot,
  });

  await expect(secondHost.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [],
        extensionId: "fixture.persisted-disable",
        packageName: "@fixture/persisted-disable",
        packageVersion: "1.0.0",
        status: "disabled",
      },
    ],
  });
  await expect(readFile(secondMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a disable persistence failure leaves the active contribution available", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const stateRoot = join(testRoot, "blocked-state-root");
  const contribution = {
    kind: "operation",
    id: "fixture.stays-active",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/disable-persistence-failure",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.disable-persistence-failure",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.stays-active",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute() {},
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.disable-persistence-failure",
        grants: [],
        packageName: "@fixture/disable-persistence-failure",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot,
  });
  await host.loadConfiguredExtensions();
  await writeFile(stateRoot, "not a directory", "utf8");

  await expect(host.disableExtension("fixture.disable-persistence-failure")).rejects.toMatchObject({
    code: "extension_state_persistence_failed",
    name: "ExtensionHostError",
  });
  expect(host.listContributions()).toEqual([
    { extensionId: "fixture.disable-persistence-failure", ...contribution },
  ]);
});

test("enabling a persisted idle extension makes it eligible for activation again", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const stateRoot = join(testRoot, "state");
  const markerPath = join(testRoot, "runtime-imported.txt");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/reenabled-extension",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.reenabled-extension",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const options = {
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.reenabled-extension",
        grants: [],
        packageName: "@fixture/reenabled-extension",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot,
  };
  const disablingHost = createExtensionHost(options);
  await disablingHost.disableExtension("fixture.reenabled-extension");
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const enablingHost = createExtensionHost(options);
  await expect(enablingHost.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ status: "disabled" }],
  });

  await expect(enablingHost.enableExtension("fixture.reenabled-extension")).resolves.toEqual({
    diagnostics: [],
    extensionId: "fixture.reenabled-extension",
    packageName: "@fixture/reenabled-extension",
    packageVersion: "1.0.0",
    status: "active",
  });
  await expect(readFile(markerPath, "utf8")).resolves.toBe("imported");
});

test("enabling an already active extension is idempotent", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const activationCountKey = Symbol.for("adam-agent.test.idempotent-enable-count");
  Reflect.set(globalThis, activationCountKey, 0);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/idempotent-enable",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.idempotent-enable",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate() {
  const key = Symbol.for("adam-agent.test.idempotent-enable-count");
  globalThis[key] += 1;
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.idempotent-enable",
        grants: [],
        packageName: "@fixture/idempotent-enable",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot: join(packageRoot, "state"),
  });
  await host.loadConfiguredExtensions();

  await expect(host.enableExtension("fixture.idempotent-enable")).resolves.toMatchObject({
    diagnostics: [],
    status: "active",
  });
  expect(Reflect.get(globalThis, activationCountKey)).toBe(1);
  Reflect.deleteProperty(globalThis, activationCountKey);
});

test("disabling an idle extension invokes its optional deactivation hook", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const deactivatedMarker = join(testRoot, "deactivated.txt");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/deactivation",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.deactivation",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
export async function activate() {}
export async function deactivate() {
  await writeFile(${JSON.stringify(deactivatedMarker)}, "deactivated", "utf8");
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.deactivation",
        grants: [],
        packageName: "@fixture/deactivation",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot: join(testRoot, "state"),
  });
  await host.loadConfiguredExtensions();

  await expect(host.disableExtension("fixture.deactivation")).resolves.toMatchObject({
    status: "disabled",
  });
  await expect(readFile(deactivatedMarker, "utf8")).resolves.toBe("deactivated");
});

test("a deactivation failure does not reverse the persisted disabled state or leak its cause", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const stateRoot = join(testRoot, "state");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/deactivation-failure",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.deactivation-failure",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate() {}
export async function deactivate() {
  throw new Error("private deactivation details");
}
`,
    "utf8",
  );
  const options = {
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.deactivation-failure",
        grants: [],
        packageName: "@fixture/deactivation-failure",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot,
  };
  const host = createExtensionHost(options);
  await host.loadConfiguredExtensions();

  const disabled = await host.disableExtension("fixture.deactivation-failure");
  expect(disabled).toEqual({
    diagnostics: [{ code: "deactivation_failed" }],
    extensionId: "fixture.deactivation-failure",
    packageName: "@fixture/deactivation-failure",
    packageVersion: "1.0.0",
    status: "disabled",
  });
  expect(JSON.stringify(disabled)).not.toContain("private deactivation details");
  await expect(createExtensionHost(options).loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ status: "disabled" }],
  });
});

test("an activation that exceeds its deadline publishes nothing", async () => {
  vi.useFakeTimers();
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const activationEnteredKey = Symbol.for("adam-agent.test.activation-entered");
  let signalActivationEntered: (() => void) | undefined;
  const activationEntered = new Promise<void>((resolve) => {
    signalActivationEntered = resolve;
  });
  Reflect.set(globalThis, activationEnteredKey, signalActivationEntered);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/activation-timeout",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.activation-timeout",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate() {
  globalThis[Symbol.for("adam-agent.test.activation-entered")]();
  await new Promise(() => {});
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.activation-timeout",
        grants: [],
        packageName: "@fixture/activation-timeout",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  const loading = host.loadConfiguredExtensions();
  await activationEntered;
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(loading).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "activation_timed_out" }],
        extensionId: "fixture.activation-timeout",
        packageName: "@fixture/activation-timeout",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
  Reflect.deleteProperty(globalThis, activationEnteredKey);
});

test("activation receives immutable identity, configuration, compatibility, and diagnostics", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contextPath = join(packageRoot, "activation-context.json");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/activation-context",
      version: "1.2.3",
      type: "module",
      adamAgent: {
        id: "fixture.activation-context",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.required", version: "^1.0.0" }],
          optional: [{ id: "fixture.optional-missing", version: "^1.0.0" }],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
export async function activate(context) {
  await writeFile(${JSON.stringify(contextPath)}, JSON.stringify({
    extension: context.extension,
    configuration: context.configuration,
    compatibility: context.compatibility,
    diagnostics: context.diagnostics,
    frozen: {
      context: Object.isFrozen(context),
      extension: Object.isFrozen(context.extension),
      configuration: Object.isFrozen(context.configuration),
      compatibility: Object.isFrozen(context.compatibility),
      required: Object.isFrozen(context.compatibility?.capabilities.required),
      optional: Object.isFrozen(context.compatibility?.capabilities.optional),
      diagnostics: Object.isFrozen(context.diagnostics),
    },
  }), "utf8");
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.required", version: "1.4.0" }],
    extensions: [
      {
        configuration: { profile: "fixture" },
        enabled: true,
        extensionId: "fixture.activation-context",
        grants: [{ id: "fixture.required", version: "^1.0.0" }],
        packageName: "@fixture/activation-context",
        packageRoot,
        packageVersion: "1.2.3",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ status: "active" }],
  });
  await expect(readFile(contextPath, "utf8").then(JSON.parse)).resolves.toEqual({
    extension: {
      id: "fixture.activation-context",
      packageName: "@fixture/activation-context",
      version: "1.2.3",
    },
    configuration: { profile: "fixture" },
    compatibility: {
      api: { hostVersion: "0.1.0", requestedVersion: "^0.1.0" },
      capabilities: {
        optional: [
          {
            granted: false,
            id: "fixture.optional-missing",
            requestedVersion: "^1.0.0",
          },
        ],
        required: [
          {
            availableVersion: "1.4.0",
            granted: true,
            id: "fixture.required",
            requestedVersion: "^1.0.0",
          },
        ],
      },
    },
    diagnostics: [
      {
        capabilityId: "fixture.optional-missing",
        code: "optional_capability_unavailable",
        requestedVersion: "^1.0.0",
      },
    ],
    frozen: {
      compatibility: true,
      configuration: true,
      context: true,
      diagnostics: true,
      extension: true,
      optional: true,
      required: true,
    },
  });
});

test("an undeclared Owner capability grant rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/undeclared-grant",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.undeclared-grant",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.undeclared", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.undeclared-grant",
        grants: [{ id: "fixture.undeclared", version: "^1.0.0" }],
        packageName: "@fixture/undeclared-grant",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            capabilityId: "fixture.undeclared",
            code: "capability_grant_invalid",
          },
        ],
        extensionId: "fixture.undeclared-grant",
        packageName: "@fixture/undeclared-grant",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("duplicate capability declarations make the static manifest invalid", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/duplicate-capability",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.duplicate-capability",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [
            { id: "fixture.capability", version: "^1.0.0" },
            { id: "fixture.capability", version: "^1.0.0" },
          ],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.duplicate-capability",
        grants: [{ id: "fixture.capability", version: "^1.0.0" }],
        packageName: "@fixture/duplicate-capability",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "manifest_invalid" }],
        extensionId: "fixture.duplicate-capability",
        packageName: "@fixture/duplicate-capability",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an invalid operation handler rejects the complete activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.invalid-handler",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-handler",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-handler",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.invalid-handler",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute: "not-a-function",
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-handler",
        grants: [],
        packageName: "@fixture/invalid-handler",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [
          {
            code: "contribution_handler_invalid",
            contributionId: "fixture.invalid-handler",
          },
        ],
        extensionId: "fixture.invalid-handler",
        packageName: "@fixture/invalid-handler",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("duplicate contribution declarations make the static manifest invalid", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  const contribution = {
    kind: "operation",
    id: "fixture.duplicate-declaration",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/duplicate-declaration",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.duplicate-declaration",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution, contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.duplicate-declaration",
        grants: [],
        packageName: "@fixture/duplicate-declaration",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "manifest_invalid" }],
        extensionId: "fixture.duplicate-declaration",
        packageName: "@fixture/duplicate-declaration",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("loading configured extensions repeatedly is idempotent", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.idempotent-operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/idempotent-load",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.idempotent-load",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.idempotent-operation",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute() {},
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.idempotent-load",
        grants: [],
        packageName: "@fixture/idempotent-load",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  const first = await host.loadConfiguredExtensions();
  await expect(host.loadConfiguredExtensions()).resolves.toEqual(first);
  expect(first.extensions).toEqual([
    {
      diagnostics: [],
      extensionId: "fixture.idempotent-load",
      packageName: "@fixture/idempotent-load",
      packageVersion: "1.0.0",
      status: "active",
    },
  ]);
  expect(host.listContributions()).toEqual([
    { extensionId: "fixture.idempotent-load", ...contribution },
  ]);
});

test("an unavailable configured package root becomes a bounded rejection", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.missing-package",
        grants: [],
        packageName: "@fixture/missing-package",
        packageRoot: join(testRoot, "missing-package"),
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "package_unavailable" }],
        extensionId: "fixture.missing-package",
        packageName: "@fixture/missing-package",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
});

test("an invalid semantic-version range makes the static manifest invalid", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-semver",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-semver",
        apiVersion: "not a semantic version range",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-semver",
        grants: [],
        packageName: "@fixture/invalid-semver",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "manifest_invalid" }],
        extensionId: "fixture.invalid-semver",
        packageName: "@fixture/invalid-semver",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("standard npm package metadata does not invalidate the Adam manifest", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/npm-metadata",
      version: "1.0.0",
      type: "module",
      description: "A literal extension fixture.",
      license: "MIT",
      exports: { ".": "./extension.js" },
      dependencies: { "fixture-dependency": "1.0.0" },
      adamAgent: {
        id: "fixture.npm-metadata",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.npm-metadata",
        grants: [],
        packageName: "@fixture/npm-metadata",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [],
        extensionId: "fixture.npm-metadata",
        packageName: "@fixture/npm-metadata",
        packageVersion: "1.0.0",
        status: "active",
      },
    ],
  });
});

test("a non-semantic package version makes the static manifest invalid", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-package-version",
      version: "not-semver",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-package-version",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-package-version",
        grants: [],
        packageName: "@fixture/invalid-package-version",
        packageRoot,
        packageVersion: "not-semver",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ diagnostics: [{ code: "manifest_invalid" }], status: "rejected" }],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an invalid capability range makes the static manifest invalid", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-capability-range",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-capability-range",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability", version: "not a range" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-capability-range",
        grants: [{ id: "fixture.capability", version: "^1.0.0" }],
        packageName: "@fixture/invalid-capability-range",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ diagnostics: [{ code: "manifest_invalid" }], status: "rejected" }],
  });
});

test("an exact prerelease capability grant containing x activates", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/prerelease-grant",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.prerelease-grant",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability", version: "1.0.0-x" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.0.0-x" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.prerelease-grant",
        grants: [{ id: "fixture.capability", version: "1.0.0-x" }],
        packageName: "@fixture/prerelease-grant",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ diagnostics: [], status: "active" }],
  });
});

test("an implicit partial-version capability grant rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/partial-grant",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.partial-grant",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.2.3" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.partial-grant",
        grants: [{ id: "fixture.capability", version: "1" }],
        packageName: "@fixture/partial-grant",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ capabilityId: "fixture.capability", code: "capability_grant_invalid" }],
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a wildcard capability grant rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/wildcard-grant",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.wildcard-grant",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.0.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.wildcard-grant",
        grants: [{ id: "fixture.capability", version: "*" }],
        packageName: "@fixture/wildcard-grant",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ capabilityId: "fixture.capability", code: "capability_grant_invalid" }],
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a capability grant spanning multiple major versions rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/multi-major-grant",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.multi-major-grant",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: {
          required: [{ id: "fixture.capability", version: "^1.0.0" }],
          optional: [],
        },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [{ id: "fixture.capability", version: "1.4.0" }],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.multi-major-grant",
        grants: [{ id: "fixture.capability", version: ">=1.0.0 <3.0.0" }],
        packageName: "@fixture/multi-major-grant",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ capabilityId: "fixture.capability", code: "capability_grant_invalid" }],
        status: "rejected",
      },
    ],
  });
});

test("an oversized package manifest rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  const manifest = JSON.stringify({
    name: "@fixture/oversized-manifest",
    version: "1.0.0",
    type: "module",
    adamAgent: {
      id: "fixture.oversized-manifest",
      apiVersion: "^0.1.0",
      runtime: { entry: "./extension.js" },
      capabilities: { required: [], optional: [] },
      contributions: [],
    },
  }).padEnd(1024 * 1024 + 1, " ");
  await writeFile(join(packageRoot, "package.json"), manifest, "utf8");
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.oversized-manifest",
        grants: [],
        packageName: "@fixture/oversized-manifest",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ diagnostics: [{ code: "manifest_invalid" }], status: "rejected" }],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a non-JSON Owner configuration rejects before runtime import", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const markerPath = join(packageRoot, "runtime-imported.txt");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-configuration",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-configuration",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        configuration: { invalid: undefined } as never,
        enabled: true,
        extensionId: "fixture.invalid-configuration",
        grants: [],
        packageName: "@fixture/invalid-configuration",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ code: "configuration_invalid" }],
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("duplicate configured extension IDs fail closed at Host construction", () => {
  const configured = {
    enabled: false,
    extensionId: "fixture.duplicate-config",
    grants: [],
    packageName: "@fixture/duplicate-config",
    packageRoot: "/not-observed",
    packageVersion: "1.0.0",
  };

  expect(() =>
    createExtensionHost({
      capabilities: [],
      extensions: [configured, { ...configured, packageRoot: "/also-not-observed" }],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "extension_configuration_invalid",
      name: "ExtensionHostError",
    }),
  );
});

test("duplicate available capability IDs fail closed at Host construction", () => {
  expect(() =>
    createExtensionHost({
      capabilities: [
        { id: "fixture.duplicate-capability", version: "1.0.0" },
        { id: "fixture.duplicate-capability", version: "2.0.0" },
      ],
      extensions: [],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "extension_configuration_invalid",
      name: "ExtensionHostError",
    }),
  );
});

test("a non-semantic available capability version fails closed at Host construction", () => {
  expect(() =>
    createExtensionHost({
      capabilities: [{ id: "fixture.invalid-version", version: "not-semver" }],
      extensions: [],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "extension_configuration_invalid",
      name: "ExtensionHostError",
    }),
  );
});

test("an unreadable lifecycle truth rejects before runtime import", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const stateRoot = join(testRoot, "state");
  const markerPath = join(testRoot, "runtime-imported.txt");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/corrupt-lifecycle",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.corrupt-lifecycle",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "imported", "utf8");
export async function activate() {}
`,
    "utf8",
  );
  const options = {
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.corrupt-lifecycle",
        grants: [],
        packageName: "@fixture/corrupt-lifecycle",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot,
  };
  await createExtensionHost(options).disableExtension("fixture.corrupt-lifecycle");
  const lifecycleDirectory = join(stateRoot, "extensions");
  const [lifecycleFilename] = await readdir(lifecycleDirectory);
  if (lifecycleFilename === undefined) {
    throw new Error("The lifecycle fixture was not persisted.");
  }
  await writeFile(join(lifecycleDirectory, lifecycleFilename), "not-json\n", "utf8");

  await expect(createExtensionHost(options).loadConfiguredExtensions()).resolves.toEqual({
    extensions: [
      {
        diagnostics: [{ code: "extension_state_unavailable" }],
        extensionId: "fixture.corrupt-lifecycle",
        packageName: "@fixture/corrupt-lifecycle",
        packageVersion: "1.0.0",
        status: "rejected",
      },
    ],
  });
  await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("a lifecycle symlink cannot redirect enable persistence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(testRoot);
  const packageRoot = join(testRoot, "package");
  const stateRoot = join(testRoot, "state");
  const victimPath = join(testRoot, "victim.txt");
  await mkdir(packageRoot);
  await writeFile(victimPath, "unchanged", "utf8");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/lifecycle-symlink",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.lifecycle-symlink",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    "export async function activate() {}\n",
    "utf8",
  );
  const options = {
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.lifecycle-symlink",
        grants: [],
        packageName: "@fixture/lifecycle-symlink",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot,
  };
  await createExtensionHost(options).disableExtension("fixture.lifecycle-symlink");
  const lifecycleDirectory = join(stateRoot, "extensions");
  const [lifecycleFilename] = await readdir(lifecycleDirectory);
  if (lifecycleFilename === undefined) {
    throw new Error("The lifecycle fixture was not persisted.");
  }
  const lifecyclePath = join(lifecycleDirectory, lifecycleFilename);
  await unlink(lifecyclePath);
  await symlink(victimPath, lifecyclePath);

  await expect(
    createExtensionHost(options).enableExtension("fixture.lifecycle-symlink"),
  ).rejects.toMatchObject({
    code: "extension_state_persistence_failed",
    name: "ExtensionHostError",
  });
  await expect(readFile(victimPath, "utf8")).resolves.toBe("unchanged");
});

test("disable wins over an activation already in progress", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const activationEnteredKey = Symbol.for("adam-agent.test.serialized-activation-entered");
  const releaseActivationKey = Symbol.for("adam-agent.test.release-serialized-activation");
  let signalActivationEntered: (() => void) | undefined;
  const activationEntered = new Promise<void>((resolve) => {
    signalActivationEntered = resolve;
  });
  let releaseActivation: (() => void) | undefined;
  const activationRelease = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  Reflect.set(globalThis, activationEnteredKey, signalActivationEntered);
  Reflect.set(globalThis, releaseActivationKey, activationRelease);
  const contribution = {
    kind: "operation",
    id: "fixture.serialized-operation",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/serialized-disable",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.serialized-disable",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const codec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  globalThis[Symbol.for("adam-agent.test.serialized-activation-entered")]();
  await globalThis[Symbol.for("adam-agent.test.release-serialized-activation")];
  context.registerOperation({
    id: "fixture.serialized-operation",
    input: codec("fixture.input"),
    output: codec("fixture.output"),
    progress: codec("fixture.progress"),
    execute() {},
  });
}
`,
    "utf8",
  );
  const options = {
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.serialized-disable",
        grants: [],
        packageName: "@fixture/serialized-disable",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
    stateRoot: join(packageRoot, "state"),
  };
  const host = createExtensionHost(options);

  const loading = host.loadConfiguredExtensions();
  await activationEntered;
  await expect(host.disableExtension("fixture.serialized-disable")).resolves.toMatchObject({
    status: "disabled",
  });
  releaseActivation?.();
  await expect(loading).resolves.toMatchObject({ extensions: [{ status: "disabled" }] });
  expect(host.listContributions()).toEqual([]);
  await expect(createExtensionHost(options).loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [{ status: "disabled" }],
  });
  Reflect.deleteProperty(globalThis, activationEnteredKey);
  Reflect.deleteProperty(globalThis, releaseActivationKey);
});

test("concurrent loads share one activation transaction", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const activationEnteredKey = Symbol.for("adam-agent.test.shared-activation-entered");
  const releaseActivationKey = Symbol.for("adam-agent.test.release-shared-activation");
  const activationCountKey = Symbol.for("adam-agent.test.shared-activation-count");
  let signalActivationEntered: (() => void) | undefined;
  const activationEntered = new Promise<void>((resolve) => {
    signalActivationEntered = resolve;
  });
  let releaseActivation: (() => void) | undefined;
  const activationRelease = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  Reflect.set(globalThis, activationEnteredKey, signalActivationEntered);
  Reflect.set(globalThis, releaseActivationKey, activationRelease);
  Reflect.set(globalThis, activationCountKey, 0);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/concurrent-load",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.concurrent-load",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate() {
  const countKey = Symbol.for("adam-agent.test.shared-activation-count");
  globalThis[countKey] += 1;
  globalThis[Symbol.for("adam-agent.test.shared-activation-entered")]();
  await globalThis[Symbol.for("adam-agent.test.release-shared-activation")];
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.concurrent-load",
        grants: [],
        packageName: "@fixture/concurrent-load",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  const firstLoad = host.loadConfiguredExtensions();
  await activationEntered;
  const secondLoad = host.loadConfiguredExtensions();
  releaseActivation?.();
  const firstSnapshot = await firstLoad;
  await expect(secondLoad).resolves.toEqual(firstSnapshot);
  expect(Reflect.get(globalThis, activationCountKey)).toBe(1);
  Reflect.deleteProperty(globalThis, activationEnteredKey);
  Reflect.deleteProperty(globalThis, releaseActivationKey);
  Reflect.deleteProperty(globalThis, activationCountKey);
});

test("a malformed runtime registration becomes a bounded activation rejection", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.malformed-registration",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/malformed-registration",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.malformed-registration",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate(context) {
  context.registerOperation(null);
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.malformed-registration",
        grants: [],
        packageName: "@fixture/malformed-registration",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ code: "contribution_registration_invalid" }],
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("a throwing runtime registration accessor becomes a bounded activation rejection", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/throwing-registration",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.throwing-registration",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `export async function activate(context) {
  context.registerOperation(new Proxy({}, {
    has() { return true; },
    get() { throw new Error("private cause"); },
  }));
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.throwing-registration",
        grants: [],
        packageName: "@fixture/throwing-registration",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [{ code: "contribution_registration_invalid" }],
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});

test("a registration codec without callable encode and decode rejects activation", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "adam-extension-host-"));
  temporaryRoots.push(packageRoot);
  const contribution = {
    kind: "operation",
    id: "fixture.invalid-codec",
    input: { id: "fixture.input", version: 1 },
    output: { id: "fixture.output", version: 1 },
    progress: { id: "fixture.progress", version: 1 },
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@fixture/invalid-codec",
      version: "1.0.0",
      type: "module",
      adamAgent: {
        id: "fixture.invalid-codec",
        apiVersion: "^0.1.0",
        runtime: { entry: "./extension.js" },
        capabilities: { required: [], optional: [] },
        contributions: [contribution],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "extension.js"),
    `const validCodec = (id) => ({ id, version: 1, decode(value) { return { ok: true, value }; }, encode(value) { return { ok: true, value }; } });
export async function activate(context) {
  context.registerOperation({
    id: "fixture.invalid-codec",
    input: { id: "fixture.input", version: 1 },
    output: validCodec("fixture.output"),
    progress: validCodec("fixture.progress"),
    execute() {},
  });
}
`,
    "utf8",
  );
  const host = createExtensionHost({
    capabilities: [],
    extensions: [
      {
        enabled: true,
        extensionId: "fixture.invalid-codec",
        grants: [],
        packageName: "@fixture/invalid-codec",
        packageRoot,
        packageVersion: "1.0.0",
      },
    ],
  });

  await expect(host.loadConfiguredExtensions()).resolves.toMatchObject({
    extensions: [
      {
        diagnostics: [
          {
            code: "contribution_codec_invalid",
            contract: "input",
            contributionId: "fixture.invalid-codec",
          },
        ],
        status: "rejected",
      },
    ],
  });
  expect(host.listContributions()).toEqual([]);
});
