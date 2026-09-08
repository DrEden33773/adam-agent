import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHost } from "@adam-agent/agent";
import { expect, test } from "vitest";

test.each([
  ["adam.managed-session@1", "1.0.0"],
  ["adam.managed-session@2", "2.0.0"],
])(
  "Host refuses obsolete capability %s even in stale explicit runtime configuration",
  (id, version) => {
    expect(() =>
      createExtensionHost({
        capabilities: [{ id, version }],
        extensions: [],
        // Simulate persisted caller configuration from a Host that supplied the removed runtime.
        ...{ managedSession: {} as never },
      }),
    ).toThrow(expect.objectContaining({ code: "extension_configuration_invalid" }));
  },
);

test("advertising managed-review requires its Host runtime", () => {
  expect(() =>
    createExtensionHost({
      capabilities: [{ id: "adam.managed-review@1", version: "1.0.0" }],
      extensions: [],
    }),
  ).toThrow(expect.objectContaining({ code: "extension_configuration_invalid" }));
});

test.each([
  ["^0.4.0", "adam.managed-session@1", "^1.0.0"],
  ["^0.5.0", "adam.managed-session@2", "^2.0.0"],
])(
  "literal API %s consumer requiring %s is refused before module import or execution",
  async (apiVersion, capability, version) => {
    const root = await mkdtemp(join(tmpdir(), "adam-obsolete-consumer-"));
    const marker = join(root, "executed");
    let providerResolutions = 0;
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "@fixture/obsolete-consumer",
          version: "1.0.0",
          type: "module",
          adamAgent: {
            id: "fixture.obsolete-consumer",
            apiVersion,
            runtime: { entry: "./runtime.js" },
            capabilities: { required: [{ id: capability, version }], optional: [] },
            contributions: [],
          },
        }),
      );
      await writeFile(
        join(root, "runtime.js"),
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export function activate() { writeFileSync(${JSON.stringify(marker)}, "activated"); }
`,
      );
      const host = createExtensionHost({
        capabilities: [{ id: "adam.managed-review@1", version: "1.0.0" }],
        managedReview: {
          resolveOrigin: async () => {
            providerResolutions += 1;
            throw new Error("Obsolete consumers cannot resolve a provider through managed-review.");
          },
        },
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.obsolete-consumer",
            grants: [{ id: capability, version }],
            packageName: "@fixture/obsolete-consumer",
            packageRoot: root,
            packageVersion: "1.0.0",
          },
        ],
      });
      expect(await host.loadConfiguredExtensions()).toMatchObject({
        extensions: [
          {
            status: "rejected",
            diagnostics: [
              {
                code: "required_capability_unavailable",
                capabilityId: capability,
                requestedVersion: version,
              },
            ],
          },
        ],
      });
      await expect(
        host.operations.start({
          contributionId: "fixture.obsolete-consumer",
          idempotencyKey: "refused",
          input: null,
        }),
      ).rejects.toMatchObject({ code: "operation_contribution_unavailable" });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(providerResolutions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  [">=0.6.0 <0.7.0", "adam.managed-review@1", "^1.0.0", "active"],
  [">=0.6.0 <0.7.0", "adam.managed-review@1", "^2.0.0", "rejected"],
  [">=0.6.0 <0.7.0", "adam.managed-review@2", "^1.0.0", "rejected"],
  [">=0.7.0 <0.8.0", "adam.managed-review@1", "^1.0.0", "rejected"],
  [">=0.5.0 <0.6.0", "adam.managed-review@1", "^1.0.0", "rejected"],
  [">=0.5.0 <0.6.0", "", "", "active"],
])(
  "Host negotiates API %s and exact capability %s at %s",
  async (apiVersion, capability, version, status) => {
    const root = await mkdtemp(join(tmpdir(), "adam-review-negotiation-"));
    const packageRoot = join(root, "extension");
    try {
      await mkdir(packageRoot);
      const requirements = capability === "" ? [] : [{ id: capability, version }];
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/negotiation",
          version: "1.0.0",
          type: "module",
          adamAgent: {
            id: "fixture.negotiation",
            apiVersion,
            runtime: { entry: "./runtime.js" },
            capabilities: { required: requirements, optional: [] },
            contributions: [],
          },
        }),
      );
      await writeFile(join(packageRoot, "runtime.js"), "export function activate() {}\n");
      const host = createExtensionHost({
        capabilities: [{ id: "adam.managed-review@1", version: "1.0.0" }],
        managedReview: {
          resolveOrigin: async () => {
            throw new Error("No review invocation in negotiation.");
          },
        },
        extensions: [
          {
            enabled: true,
            extensionId: "fixture.negotiation",
            grants: requirements,
            packageName: "@fixture/negotiation",
            packageRoot,
            packageVersion: "1.0.0",
          },
        ],
      });
      expect(await host.loadConfiguredExtensions()).toMatchObject({ extensions: [{ status }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
