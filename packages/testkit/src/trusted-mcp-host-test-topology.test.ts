import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const behaviorSuitePath = fileURLToPath(new URL("./trusted-mcp-host.test.ts", import.meta.url));
const operatingSystemSuitePath = fileURLToPath(
  new URL("./trusted-mcp-host.os.test.ts", import.meta.url),
);
const supportPath = fileURLToPath(new URL("./trusted-mcp-host.test-support.ts", import.meta.url));
const packagePath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const qualityWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/quality.yml", import.meta.url),
);
const vitestConfigurationPath = fileURLToPath(
  new URL("../../../vitest.config.ts", import.meta.url),
);

const operatingSystemTestNames = [
  "SessionLifecycle bootstraps one exact package and invokes its resolved MCP bin",
  "SessionLifecycle removes its session-scoped package installation after causal close",
  "SessionLifecycle retains one exact package cache across idle reactivation",
  "SessionLifecycle rejects changed package bytes behind the same exact version on cold reactivation",
  "SessionLifecycle rejects a package whose transitive tarball escapes the approved registry",
  "SessionLifecycle aborts a held package bootstrap through a deterministic total deadline",
  "SessionLifecycle causally reaps a package-bootstrap process group after its leader exits",
  "SessionLifecycle starts the initialize and discovery budget only after package bootstrap",
  "SessionLifecycle activates an approved stdio server and discovers every tool page",
  "SessionLifecycle receives a real stdio list_changed after one completed tool response",
  "SessionLifecycle treats malformed MCP stdout as fatal and reaps the server",
  "SessionLifecycle aborts an MCP frame while it exceeds the 64 MiB accumulation bound",
  "SessionLifecycle drains bounded-private MCP stderr without blocking activation",
  "SessionLifecycle fences an unexpectedly exited MCP generation without automatic restart",
  "SessionLifecycle distinguishes post-dispatch 'malformed JSON' protocol output from disconnect",
  "SessionLifecycle distinguishes post-dispatch 'invalid UTF-8' protocol output from disconnect",
  "SessionLifecycle distinguishes post-dispatch 'partial-frame EOF' protocol output from disconnect",
  "SessionLifecycle close interrupts an in-progress activation and waits for causal process close",
  "SessionLifecycle close causally reaps the MCP process group descendants",
] as const;

test("MCP deterministic and operating-system contracts keep separate harness ownership", async () => {
  const [behaviorSource, operatingSystemSource, supportSource] = await Promise.all([
    readFile(behaviorSuitePath, "utf8"),
    readOptional(operatingSystemSuitePath),
    readOptional(supportPath),
  ]);

  expect.soft(operatingSystemSource.length).toBeGreaterThan(0);
  expect.soft(supportSource.length).toBeGreaterThan(0);
  expect
    .soft(runtimeModuleSpecifiers(behaviorSource).sort())
    .toEqual([
      "./index.js",
      "./trusted-mcp-host.test-support.js",
      "@adam-agent/agent",
      "@adam-agent/agent/internal-testing",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
      "vitest",
    ]);
  expect
    .soft(runtimeModuleSpecifiers(operatingSystemSource).sort())
    .toEqual([
      "./index.js",
      "./local-npm-registry.fixture.js",
      "./trusted-mcp-host.test-support.js",
      "@adam-agent/agent",
      "@adam-agent/agent/internal-testing",
      "node:fs",
      "node:fs/promises",
      "node:net",
      "node:os",
      "node:path",
      "node:url",
      "vitest",
    ]);
  expect
    .soft(runtimeImportedBindings(operatingSystemSource, "./index.js"))
    .toEqual(["FakeModelDriver", "createSessionLifecycleForTesting"]);
  expect.soft(runtimeImportedBindings(behaviorSource, "vitest")).toEqual(["expect", "test"]);
  expect.soft(runtimeImportedBindings(operatingSystemSource, "vitest")).toEqual(["expect", "test"]);
  expect
    .soft(runtimeImportedBindings(operatingSystemSource, "@adam-agent/agent/internal-testing"))
    .toEqual([
      "mcpBootstrapScheduler",
      "mcpCatalogStaleDurableBarrier",
      "mcpCatalogStaleObservationBarrier",
      "mcpDiscoveryScheduler",
      "mcpIdleScheduler",
      "mcpPackageManagerCliPath",
      "mcpPackageRegistryUrl",
    ]);
  expect.soft(runtimeModuleSpecifiers(supportSource)).toEqual([]);
  expect
    .soft(topLevelValueDeclarations(supportSource))
    .toEqual([
      "const:trustedMcpTargetIdentity: ModelTargetIdentity=ObjectLiteralExpression",
      "const:trustedMcpContextProfile: ContextProfile=ObjectLiteralExpression",
      "function:withFailureGuard",
      "function:createManualMcpIdleScheduler",
      "function:commitFixtureEchoTool",
    ]);
  expect.soft(behaviorSource).not.toContain("beforeAll(");
  expect.soft(operatingSystemSource).not.toContain("beforeAll(");
  expect.soft(supportSource).not.toContain("beforeAll(");

  const behaviorNames = declaredTestNames(behaviorSource);
  const operatingSystemNames = declaredTestNames(operatingSystemSource);
  expect.soft(behaviorNames).toHaveLength(79);
  expect.soft(operatingSystemNames).toHaveLength(19);
  expect.soft(operatingSystemNames).toEqual([...operatingSystemTestNames].sort());
  expect.soft(operatingSystemTestNames.filter((name) => behaviorNames.includes(name))).toEqual([]);
  const combinedNames = [...behaviorNames, ...operatingSystemNames];
  expect.soft(new Set(combinedNames).size).toBe(combinedNames.length);
});

test("MCP topology detectors cover aliased imports and top-level value owners", () => {
  const source = `
    import { spawn as hiddenChild } from "node:child_process";
    import type { Socket } from "node:net";
    const dynamicOwner = import("dynamic-owner");
    export { runtimeOwner as renamedOwner } from "runtime-owner";
    export type { OwnerShape } from "type-owner";
const hiddenLifecycle = hiddenChild;
export const { promise: hiddenWaiter } = Promise.withResolvers<void>();
export async function createFixture(): Promise<void> {}
  `;

  expect(runtimeModuleSpecifiers(source).sort()).toEqual([
    "dynamic-owner",
    "node:child_process",
    "runtime-owner",
  ]);
  expect(runtimeImportedBindings(source, "node:child_process")).toEqual(["spawn"]);
  expect(topLevelValueDeclarations(source)).toEqual([
    "const:hiddenLifecycle=Identifier",
    "const:{ promise: hiddenWaiter }=CallExpression",
    "function:createFixture",
  ]);
});

test("MCP behavior and OS suites remain in one required Linux Quality job", async () => {
  const [packageSource, qualityWorkflow, vitestConfiguration] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(qualityWorkflowPath, "utf8"),
    readFile(vitestConfigurationPath, "utf8"),
  ]);
  const packageManifest = JSON.parse(packageSource) as {
    readonly scripts?: { readonly test?: string };
  };

  expect(packageManifest.scripts?.test).toBe("tsc -b && vitest run");
  expect(vitestConfiguration).toContain('"packages/**/src/**/*.test.ts"');
  expect(qualityWorkflow).toContain("runs-on: ubuntu-24.04");
  expect(qualityWorkflow).toContain("run: pnpm quality:check");
  expect(qualityWorkflow).not.toMatch(/^\s+paths(?:-ignore)?:/gmu);
  expect(qualityWorkflow).not.toContain("continue-on-error");
  expect([...qualityWorkflow.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n {4}runs-on:/gmu)]).toHaveLength(
    1,
  );
});

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function declaredTestNames(source: string): string[] {
  const direct = [...source.matchAll(/^test\(\s*"([^"]+)"/gmu)].map((match) => match[1] ?? "");
  const parameterized = [
    ...source.matchAll(/^test\.each\(\[\n([\s\S]*?)^\] as const\)\(\s*\n?\s*"([^"]+)"/gmu),
  ].flatMap((match) => {
    const rows = match[1] ?? "";
    const template = match[2] ?? "";
    return [...rows.matchAll(/^\s*\{([^}]+)\},?$/gmu)].map((row) => {
      const values = Object.fromEntries(
        [...(row[1] ?? "").matchAll(/([a-zA-Z][a-zA-Z0-9]*):\s*"([^"]*)"/gu)].map((property) => [
          property[1] ?? "",
          property[2] ?? "",
        ]),
      );
      return template.replace(/\$([a-zA-Z][a-zA-Z0-9]*)/gu, (_, key: string) => {
        const value = values[key];
        if (value === undefined) {
          throw new Error(`Missing test.each value for $${key}.`);
        }
        return `'${value}'`;
      });
    });
  });
  return [...direct, ...parameterized].sort();
}

function runtimeModuleSpecifiers(source: string): string[] {
  const patterns = [
    /\bimport\s+(?!type\b)[^;]*?\sfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bexport\s+(?!type\b)(?:\*(?:\s+as\s+\S+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
}

function runtimeImportedBindings(source: string, moduleSpecifier: string): string[] {
  const imports = [...source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu)];
  return imports
    .filter((match) => match[2] === moduleSpecifier)
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0 && !binding.startsWith("type "))
    .map((binding) => binding.split(/\s+as\s+/u)[0] ?? "")
    .sort();
}

function topLevelValueDeclarations(source: string): string[] {
  const variables = [
    ...source.matchAll(/^(?:export\s+)?(const|let|var)\s+(.+?)\s*=\s*([^\n]*)/gmu),
  ].map((match) => ({
    index: match.index,
    value: `${match[1] ?? ""}:${(match[2] ?? "").trim()}=${initializerShape(match[3] ?? "")}`,
  }));
  const declarations = [
    ...source.matchAll(
      /^(?:export\s+)?(?:async\s+)?(function|class|enum)\s+([a-zA-Z][a-zA-Z0-9]*)/gmu,
    ),
  ].map((match) => ({
    index: match.index,
    value: `${match[1] ?? ""}:${match[2] ?? ""}`,
  }));
  return [...variables, ...declarations]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((entry) => entry.value);
}

function initializerShape(initializer: string): string {
  const trimmed = initializer.trim();
  if (trimmed.startsWith("{")) {
    return "ObjectLiteralExpression";
  }
  if (trimmed.startsWith("[")) {
    return "ArrayLiteralExpression";
  }
  if (/^(?:new\s+)?[a-zA-Z][a-zA-Z0-9.]*\s*(?:<[^>]+>)?\s*\(/u.test(trimmed)) {
    return trimmed.startsWith("new ") ? "NewExpression" : "CallExpression";
  }
  if (/^[a-zA-Z][a-zA-Z0-9]*\s*;?$/u.test(trimmed)) {
    return "Identifier";
  }
  return "OtherExpression";
}
