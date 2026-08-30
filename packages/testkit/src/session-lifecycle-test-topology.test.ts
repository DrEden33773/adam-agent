import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const behaviorSuitePath = fileURLToPath(new URL("./session-lifecycle.test.ts", import.meta.url));
const operatingSystemSuitePath = fileURLToPath(
  new URL("./session-lifecycle.os.test.ts", import.meta.url),
);
const supportPath = fileURLToPath(new URL("./session-lifecycle.test-support.ts", import.meta.url));
const planRecoverySupportPath = fileURLToPath(
  new URL("./plan-shell-recovery.test-support.ts", import.meta.url),
);
const topologySuitePath = fileURLToPath(import.meta.url);
const testkitSourcePath = fileURLToPath(new URL(".", import.meta.url));

const operatingSystemTestNames = [
  "SessionLifecycle blocks a cold Vision Responses continuation when its JSONL image artifact is corrupt",
  "SessionLifecycle blocks a cold Vision Responses continuation when its JSONL image artifact is missing",
  "SessionLifecycle cold resume keeps a Direct DeepSeek v2 session on its historical profile",
  "SessionLifecycle cold resume reconstructs the exact historical Vision Chat image bytes",
  "SessionLifecycle cold resume reads an immutable input resource after its source is deleted",
  "SessionLifecycle follows one selected symlink without persisting its source path",
  "SessionLifecycle hybrid Plan asks before a workspace PATH shadow can execute",
  "SessionLifecycle hybrid Plan asks for a near miss from each mandatory Git family",
  "SessionLifecycle hybrid Plan asks once for one exact ambiguous diagnostic",
  "SessionLifecycle hybrid Plan binds repository Git automation to the frozen installed build",
  "SessionLifecycle hybrid Plan automatically executes one exact simple inspection",
  "SessionLifecycle hybrid Plan durably freezes its shell environment identity",
  "SessionLifecycle hybrid Plan executes an approved call with only its frozen environment",
  "SessionLifecycle hybrid Plan hard-denies one recognized shell mutation",
  "SessionLifecycle hybrid Plan recovery reuses 'the exact durable assessment' only before shell start",
  "SessionLifecycle rejects a competing project writer before model dispatch and takes over after owner death",
  "SessionLifecycle rejects a corrupt immutable input resource before cold provider projection",
  "SessionLifecycle rejects a dangling selected symlink before provider dispatch",
  "SessionLifecycle rejects a final symlink substituted after controlled resolution",
  "SessionLifecycle rejects a looping selected symlink before provider dispatch",
  "SessionLifecycle rejects a missing immutable input resource before cold provider projection",
  "SessionLifecycle rejects a selected FIFO without waiting for a writer",
  "SessionLifecycle rejects an input resource above the exact eight MiB file bound",
  "SessionLifecycle rejects input resources above the exact sixteen MiB run aggregate",
  "SessionLifecycle rejects input resources above the exact sixty-four MiB lineage aggregate",
  "SessionLifecycle real-process continuation preserves a completed safe read and starts a new attempt",
  "SessionLifecycle real-process restart marks a killed structured patch as indeterminate without replay",
  "SessionLifecycle real-process branch writes independently, survives restart, and stays project-scoped",
] as const;

test("SessionLifecycle behavior and OS contracts keep separate environment ownership", async () => {
  const [behaviorSource, operatingSystemSource, supportSource, planRecoverySupportSource] =
    await Promise.all([
      readFile(behaviorSuitePath, "utf8"),
      readOptional(operatingSystemSuitePath),
      readOptional(supportPath),
      readOptional(planRecoverySupportPath),
    ]);

  expect.soft(operatingSystemSource.length).toBeGreaterThan(0);
  expect.soft(supportSource.length).toBeGreaterThan(0);
  expect.soft(planRecoverySupportSource.length).toBeGreaterThan(0);
  expect
    .soft(uniqueRuntimeModuleSpecifiers(behaviorSource))
    .toEqual([
      "./index.js",
      "./plan-shell-recovery.test-support.js",
      "./session-lifecycle.test-support.js",
      "@adam-agent/agent",
      "@adam-agent/agent/internal-testing",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
      "node:zlib",
      "vitest",
    ]);
  expect
    .soft(uniqueRuntimeModuleSpecifiers(operatingSystemSource))
    .toEqual([
      "./index.js",
      "./session-lifecycle.test-support.js",
      "@adam-agent/agent",
      "@adam-agent/agent/internal-testing",
      "node:child_process",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
      "node:url",
      "vitest",
    ]);
  expect.soft(runtimeImportedBindings(behaviorSource, "vitest")).toEqual(["expect", "test"]);
  expect.soft(runtimeImportedBindings(operatingSystemSource, "vitest")).toEqual(["expect", "test"]);
  expect
    .soft(runtimeImportedBindings(operatingSystemSource, "node:child_process"))
    .toEqual(["execFileSync", "spawn"]);
  expect
    .soft(uniqueRuntimeModuleSpecifiers(supportSource))
    .toEqual(["@adam-agent/agent", "@adam-agent/agent/internal-testing"]);
  expect
    .soft(runtimeImportedBindings(supportSource, "@adam-agent/agent"))
    .toEqual(["createSessionLifecycle"]);
  expect
    .soft(runtimeImportedBindings(supportSource, "@adam-agent/agent/internal-testing"))
    .toEqual([
      "createTrustedWorkspaceTrustForTesting",
      "createUnavailablePlanShellEnvironmentV1",
      "planShellEnvironmentFactory",
      "sessionAutomaticTitlesEnabled",
    ]);
  expect
    .soft(topLevelValueDeclarations(supportSource))
    .toEqual([
      "const:sessionLifecycleTargetIdentity: ModelTargetIdentity=ObjectLiteralExpression",
      "const:sessionLifecycleBasePrompt=StringLiteral",
      "const:sessionLifecycleSkillUsagePrompt=StringLiteral",
      "const:sessionLifecycleAnswerOnlyDeepSeekStream=TemplateLiteral",
      "function:createSessionLifecycleForTests",
    ]);
  expect
    .soft(uniqueRuntimeModuleSpecifiers(planRecoverySupportSource))
    .toEqual([
      "./index.js",
      "./session-lifecycle.test-support.js",
      "@adam-agent/agent",
      "@adam-agent/agent/internal-testing",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
    ]);
  expect
    .soft(topLevelValueDeclarations(planRecoverySupportSource))
    .toEqual([
      "const:contextProfile=ObjectLiteralExpression",
      "function:exercisePlanShellRecoveryFixture",
    ]);
  expect
    .soft(topLevelValueDeclarations(operatingSystemSource))
    .toEqual([
      "const:lifecycleOwnerFixturePath=CallExpression",
      "const:childObservations=NewExpression",
      "const:visionResponsesIdentity=ObjectLiteralExpression",
      "const:planTestContextProfile=ObjectLiteralExpression",
      "function:exerciseColdVisionResponsesArtifactFailure",
      "function:runGitFixtureCommand",
      "function:observeChild",
      "function:waitForChildMessage",
      "function:waitForFixtureRecord",
      "function:waitForChildClose",
      "function:requiredChildObservation",
      "function:isFixtureRecord",
    ]);
  expect
    .soft(
      await sourceOwnersOfRuntimeUrl(
        testkitSourcePath,
        "../dist/session-lifecycle-owner.fixture.js",
      ),
    )
    .toEqual(["session-lifecycle.os.test.ts"]);
  expect.soft(presentFragments(behaviorSource, ["beforeAll(", "afterAll("])).toEqual([]);
  expect.soft(presentFragments(operatingSystemSource, ["beforeAll(", "afterAll("])).toEqual([]);
  expect
    .soft(
      presentFragments(`${supportSource}\n${planRecoverySupportSource}`, [
        "beforeAll(",
        "afterAll(",
      ]),
    )
    .toEqual([]);
  expect
    .soft(
      presentFragments(
        `${behaviorSource}\n${operatingSystemSource}\n${supportSource}\n${planRecoverySupportSource}`,
        ["vi.mock("],
      ),
    )
    .toEqual([]);
  expect
    .soft(
      presentFragments(behaviorSource, [
        "session-lifecycle-owner.fixture.js",
        "lifecycleOwnerFixturePath",
        "process.execPath",
        '"SIGKILL"',
        "observeChild(",
        "waitForChildClose(",
        "session-lifecycle.os.test.js",
      ]),
    )
    .toEqual([]);
  expect.soft(presentFragments(operatingSystemSource, ["session-lifecycle.test.js"])).toEqual([]);
  expect
    .soft(
      presentFragments(`${supportSource}\n${planRecoverySupportSource}`, [
        "session-lifecycle.test.js",
        "session-lifecycle.os.test.js",
      ]),
    )
    .toEqual([]);

  const behaviorNames = declaredTestNames(behaviorSource);
  const operatingSystemNames = declaredTestNames(operatingSystemSource);
  expect.soft(behaviorNames).toHaveLength(96);
  expect.soft(operatingSystemNames).toEqual([...operatingSystemTestNames].sort());
  expect.soft(operatingSystemNames).toHaveLength(28);
  expect.soft(operatingSystemTestNames.filter((name) => behaviorNames.includes(name))).toEqual([]);
  const combinedNames = [...behaviorNames, ...operatingSystemNames];
  expect.soft(new Set(combinedNames).size).toBe(combinedNames.length);
});

test("SessionLifecycle topology detectors cover parameterized names and aliased owners", () => {
  const source = `
    import { beforeAll as shareFixture, expect, test } from "vitest";
    import { spawn as hiddenProcessOwner } from "node:child_process";
    import * as hiddenProcessNamespace from "node:child_process";
    import hiddenDefault, * as hiddenNamespace from "node:fs";
    import type { ChildProcess } from "node:child_process";
const hiddenOwner = hiddenProcessOwner;
export const { promise: hiddenWaiter } = Promise.withResolvers<void>();
test.each(["failed", "interrupted"] as const)("primitive %s", () => undefined);
test.each([
  { label: "object row" },
])("object $label", () => undefined);
  `;

  expect(uniqueRuntimeModuleSpecifiers(source)).toEqual([
    "node:child_process",
    "node:fs",
    "vitest",
  ]);
  expect(runtimeImportedBindings(source, "node:child_process")).toEqual(["*", "spawn"]);
  expect(runtimeImportedBindings(source, "node:fs")).toEqual(["*", "default"]);
  expect(runtimeImportedBindings(source, "vitest")).toEqual(["beforeAll", "expect", "test"]);
  expect(topLevelValueDeclarations(source)).toEqual([
    "const:hiddenOwner=Identifier",
    "const:{ promise: hiddenWaiter }=CallExpression",
  ]);
  expect(declaredTestNames(source)).toEqual([
    "object 'object row'",
    "primitive failed",
    "primitive interrupted",
  ]);
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
  const primitive = [
    ...source.matchAll(/^test\.each\(\[([^\]\n]*)\] as const\)\(\s*\n?\s*"([^"]+)"/gmu),
  ].flatMap((match) => {
    const rows = match[1] ?? "";
    const template = match[2] ?? "";
    return [...rows.matchAll(/"([^"]*)"/gu)].map((row) => template.replace(/%s/u, row[1] ?? ""));
  });
  const object = [
    ...source.matchAll(/^test\.each\(\[\n([\s\S]*?)^\]\)\(\s*\n?\s*"([^"]+)"/gmu),
  ].flatMap((match) => {
    const rows = match[1] ?? "";
    const template = match[2] ?? "";
    return [...rows.matchAll(/\{([\s\S]*?)\},?/gu)].map((row) => {
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
  return [...direct, ...primitive, ...object].sort();
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

function uniqueRuntimeModuleSpecifiers(source: string): string[] {
  return [...new Set(runtimeModuleSpecifiers(source))].sort();
}

function presentFragments(source: string, fragments: readonly string[]): string[] {
  return fragments.filter((fragment) => source.includes(fragment));
}

function runtimeImportedBindings(source: string, moduleSpecifier: string): string[] {
  const imports = [...source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["'];/gu)];
  return imports
    .filter((match) => match[2] === moduleSpecifier)
    .flatMap((match) => {
      const clause = (match[1] ?? "").trim();
      if (clause.startsWith("type ")) {
        return [];
      }
      const bindings: string[] = [];
      const named = clause.match(/\{([\s\S]*?)\}/u)?.[1];
      if (named !== undefined) {
        bindings.push(
          ...named
            .split(",")
            .map((binding) => binding.trim())
            .filter((binding) => binding.length > 0 && !binding.startsWith("type "))
            .map((binding) => binding.split(/\s+as\s+/u)[0] ?? ""),
        );
      }
      if (/\*\s+as\s+/u.test(clause)) {
        bindings.push("*");
      }
      const firstBinding = clause.split(",", 1)[0]?.trim() ?? "";
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(firstBinding)) {
        bindings.push("default");
      }
      return bindings;
    })
    .sort();
}

async function sourceOwnersOfRuntimeUrl(
  rootPath: string,
  moduleSpecifier: string,
  directoryPath = rootPath,
): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const owners = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return sourceOwnersOfRuntimeUrl(rootPath, moduleSpecifier, path);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || path === topologySuitePath) {
        return [];
      }
      const source = await readFile(path, "utf8");
      return source.includes(`new URL("${moduleSpecifier}", import.meta.url)`)
        ? [relative(rootPath, path)]
        : [];
    }),
  );
  return owners.flat().sort();
}

function topLevelValueDeclarations(source: string): string[] {
  const variables = [
    ...source.matchAll(/^(?:export\s+)?(const|let|var)\s+(.+?)\s*=\s*([\s\S]*?);$/gmu),
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
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return "StringLiteral";
  }
  if (trimmed.startsWith("`")) {
    return "TemplateLiteral";
  }
  if (/^(?:new\s+)?[a-zA-Z][a-zA-Z0-9.]*\s*(?:<[^>]+>)?\s*\(/u.test(trimmed)) {
    return trimmed.startsWith("new ") ? "NewExpression" : "CallExpression";
  }
  if (/^[a-zA-Z][a-zA-Z0-9]*\s*;?$/u.test(trimmed)) {
    return "Identifier";
  }
  return "OtherExpression";
}
