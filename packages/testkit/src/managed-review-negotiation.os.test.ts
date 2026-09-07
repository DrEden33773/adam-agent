import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHost } from "@adam-agent/agent";
import { expect, test } from "vitest";

test("advertising managed-review requires its Host runtime", () => {
  expect(() =>
    createExtensionHost({
      capabilities: [{ id: "adam.managed-review@1", version: "1.0.0" }],
      extensions: [],
    }),
  ).toThrow(expect.objectContaining({ code: "extension_configuration_invalid" }));
});

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
