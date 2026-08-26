import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const productRoot = fileURLToPath(new URL("../../..", import.meta.url));
const forbiddenPublicClaimPatterns: readonly RegExp[] = [
  /\bproduction[- ]ready(?:\s+(?:agent|product|release))?\b/iu,
  /\b(?:provides|includes|enforces|uses)\s+(?:an?\s+)?(?:OS(?:-level)?|process|network)\s+sandbox\b/iu,
  /\bAdam (?:provides|includes|enforces|uses|offers|has) (?:an?\s+)?OS(?:-level)?,\s*process,\s*(?:and|or)\s+network sandbox\b/iu,
  /\bnetwork[- ]isolated\b/iu,
  /\bAdam (?:provides|includes|enforces|uses|offers|has) network isolation\b/iu,
  /\b(?:supports|runs on)\s+(?:macOS|Windows)\b/iu,
  /\bAdam (?:is|provides|offers|supports) (?:a )?cross[- ]platform\b/iu,
  /\b(?:npm (?:install|i)(?: -g)?|npx)\s+adam-agent\b/iu,
  /\b(?:full|complete)\s+(?:Pi|Codex|Claude Code)\s+parity\b/iu,
  /\bAdam (?:provides|offers|has|achieves) (?:full |complete )?(?:Pi|Codex|Claude Code)(?:[- ]level)? parity\b/iu,
  /\bexactly[- ]once effects (?:are|is) guaranteed\b/iu,
  /\bAdam (?:provides|offers|has|guarantees) exactly[- ]once (?:external )?effects\b/iu,
  /\bAdam (?:contains|confines|protects against) (?:a )?(?:hostile|untrusted) workspace\b/iu,
  /\bAdam makes unreviewed shell (?:execution )?safe\b/iu,
  /\bAdam (?:provides|offers|has) stable public (?:app|application) APIs?\b/iu,
  /\bAdam (?:improves|increases|guarantees) (?:model|provider) quality\b/iu,
  /\bAdam (?:ships|provides|offers) (?:an? )?installable (?:npm )?(?:CLI|application|app)\b/iu,
];

test("the public entry describes a source-checkout portfolio checkpoint", async () => {
  const [readme, rootPackage, cliPackage, tuiPackage] = await Promise.all([
    readFile(join(productRoot, "README.md"), "utf8"),
    readPackageJson(join(productRoot, "package.json")),
    readPackageJson(join(productRoot, "apps", "cli", "package.json")),
    readPackageJson(join(productRoot, "apps", "tui", "package.json")),
  ]);

  expect({ rootPackage, cliPackage, tuiPackage }).toMatchObject({
    rootPackage: { private: true, version: "0.0.0" },
    cliPackage: { private: true, version: "0.0.0" },
    tuiPackage: { private: true, version: "0.0.0" },
  });
  expect(readme).toContain("Linux-supported source-checkout portfolio checkpoint");
  expect(readme).toContain("not an npm package, standalone binary, or production release");
  expect(readme).toContain("pnpm install --frozen-lockfile");
  expect(readme).toContain("pnpm tui");
  expect(readme).toContain("pnpm tui --target deepseek-v4-flash.direct");
  expect(readme).not.toContain("pnpm tui --target fake.local");
  expect(readme).not.toMatch(/npm (?:install|i) (?:-g )?adam-agent/u);
  expect(readme).not.toContain("npx adam-agent");
});

test("the public entry separates acceptance evidence from security guarantees", async () => {
  const [readme, acceptance, qualityWorkflow, cliEntry, tuiEntry, tuiHelp, tuiCommands] =
    await Promise.all([
      readFile(join(productRoot, "README.md"), "utf8"),
      readFile(join(productRoot, "docs", "portfolio-acceptance.md"), "utf8"),
      readFile(join(productRoot, ".github", "workflows", "quality.yml"), "utf8"),
      readFile(join(productRoot, "apps", "cli", "src", "main.ts"), "utf8"),
      readFile(join(productRoot, "apps", "tui", "src", "main.ts"), "utf8"),
      readFile(join(productRoot, "apps", "tui", "src", "help-navigator.ts"), "utf8"),
      readFile(join(productRoot, "apps", "tui", "src", "command-registry.ts"), "utf8"),
    ]);

  const evidenceIndex = readme.indexOf("## Evidence");
  const securityIndex = readme.indexOf("## Security model");
  const architectureIndex = readme.indexOf("## Architecture and behavior");
  expect(evidenceIndex).toBeGreaterThan(0);
  expect(securityIndex).toBeGreaterThan(evidenceIndex);
  expect(architectureIndex).toBeGreaterThan(securityIndex);
  expect(readme).toContain("[Portfolio acceptance and walkthrough](docs/portfolio-acceptance.md)");

  for (const evidenceClass of [
    "Deterministically tested",
    "Real OS/PTY tested",
    "Live-provider observed",
    "Human walkthrough observed",
  ]) {
    expect(acceptance).toContain(evidenceClass);
  }
  for (const command of ["pnpm quality:check", "pnpm test:tui:behavior", "pnpm test:tui:os"]) {
    expect(acceptance).toContain(command);
  }
  for (const boundary of [
    "Exact-call approval",
    "Built-in file path confinement",
    "Same-user shell and MCP processes",
    "Trusted in-process extensions",
    "External plaintext credentials",
    "Owner-only local state",
    "No OS, process, or network sandbox",
  ]) {
    expect(acceptance).toContain(boundary);
  }
  expect(acceptance).toContain(
    "Certified is an Adam code-level conformance status, not a provider endorsement.",
  );
  expect(acceptance).toContain(
    "| Claim | Certifying evidence | Supplementary evidence | Failure meaning |",
  );
  for (const acceptanceClaim of [
    "Source checkout builds and tests",
    "TUI terminal lifecycle is reliable",
    "Headless CLI is composable",
    "Permissions match the documented trust boundary",
    "Sessions resume without implicit continuation",
    "Live provider completes the bounded walkthrough",
    "Public claims remain bounded",
  ]) {
    expect(acceptance).toContain(acceptanceClaim);
  }
  expect(qualityWorkflow).toContain("ubuntu-24.04");
  const publicClaims = [readme, acceptance, cliEntry, tuiEntry, tuiHelp, tuiCommands].join("\n");
  expect(isForbiddenPublicClaim(publicClaims)).toBe(false);
});

test("the public claim guard recognizes representative positive inversions", () => {
  const representativeOverclaims = [
    "Adam is a production-ready product.",
    "Adam provides an OS, process, or network sandbox.",
    "Adam provides network isolation.",
    "Adam is network isolated.",
    "Adam is cross-platform.",
    "npm install -g adam-agent",
    "Adam has Codex parity.",
    "Adam guarantees exactly-once external effects.",
    "Adam contains a hostile workspace.",
    "Adam makes unreviewed shell execution safe.",
    "Adam provides stable public application APIs.",
    "Adam improves model quality.",
    "Adam ships an installable CLI.",
  ];

  expect(representativeOverclaims.filter((claim) => !isForbiddenPublicClaim(claim))).toEqual([]);
});

test("the public walkthrough fixture is structurally bounded", async () => {
  const fixtureRoot = join(productRoot, "examples", "portfolio-walkthrough");
  const [instructions, fixturePackage, fixtureEntries, fixtureIgnore, fixtureLock, acceptance] =
    await Promise.all([
      readFile(join(fixtureRoot, "AGENTS.md"), "utf8"),
      readPackageJson(join(fixtureRoot, "package.json")),
      readdir(fixtureRoot, { recursive: true }),
      readFile(join(fixtureRoot, ".gitignore"), "utf8"),
      readFile(join(fixtureRoot, "pnpm-lock.yaml"), "utf8"),
      readFile(join(productRoot, "docs", "portfolio-acceptance.md"), "utf8"),
    ]);

  expect(fixturePackage).toEqual({
    name: "adam-portfolio-walkthrough-fixture",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@11.21.0",
    engines: { node: ">=24.0.0 <25" },
    scripts: { test: "node test/order-total.test.ts" },
  });
  expect([...fixtureEntries].sort()).toEqual(
    [
      ".gitignore",
      "AGENTS.md",
      "package.json",
      "pnpm-lock.yaml",
      "src",
      "src/discounts.ts",
      "src/order-total.ts",
      "test",
      "test/order-total.test.ts",
    ].sort(),
  );
  expect(instructions).toContain("Change only `src/order-total.ts`");
  expect(instructions).toContain("Run `pnpm test`");
  expect(fixtureIgnore).toBe("node_modules/\n");
  expect(fixtureLock).toContain("lockfileVersion: '9.0'");
  expect(fixtureLock).toContain("  .: {}\n");
  expect(acceptance).toContain("examples/portfolio-walkthrough");
});

test("the retained H1 live evidence is bounded and reproducible", async () => {
  const acceptance = await readFile(join(productRoot, "docs", "portfolio-acceptance.md"), "utf8");
  const retainedEvidence = acceptance.match(
    /## Retained H1 live evidence\n\n([\s\S]*?)(?=\n## |\s*$)/u,
  )?.[1];

  expect(retainedEvidence).toBeDefined();
  for (const fact of [
    "65be417544cc8f47854e70cf19c0ba6ac7382e6e",
    "deepseek-v4-flash.direct",
    "profile version 2",
    "752dc75b-d9b5-4531-8960-4cc4db2eb70d",
    "2b20b5ba0fd374105e007bde095082cb42ea741282e07f97b9fadae17ef75962",
    "sha256:5bc729f1969ba9b9aedca25b5444818092d08b6084149d2baf781babe59fa882",
    "3bbe8cd1f77ee76b3b7889a159edc1754ffea175b7348c7ca721b0b52c87e7cc",
    "2,000 cents",
    "2,700 cents",
    "2 insertions, 1 deletion",
    "exit code 0",
    "cold hydration performed no model request or effect",
    "both TUI processes restored the terminal",
  ]) {
    expect(retainedEvidence).toContain(fact);
  }
  expect(retainedEvidence).not.toMatch(/\/(?:home|tmp)\//u);
});

test("agent source files do not import through their own public root facade", async () => {
  const agentSourceRoot = join(productRoot, "packages", "agent", "src");
  const sourceFiles = (await readdir(agentSourceRoot, { recursive: true }))
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  const backImports = (
    await Promise.all(
      sourceFiles.map(async (sourceFile) => {
        const sourcePath = join(agentSourceRoot, sourceFile);
        const source = await readFile(sourcePath, "utf8");
        return moduleSpecifiers(source)
          .filter((specifier) => isAgentRootFacadeSpecifier(sourcePath, specifier, agentSourceRoot))
          .map((specifier) => ({
            file: relative(productRoot, sourcePath),
            specifier,
          }));
      }),
    )
  ).flat();

  expect(backImports).toEqual([]);
});

test("the agent root facade detector covers relative and package self-references", () => {
  const sourcePath = join(productRoot, "packages", "agent", "src", "session-lifecycle.ts");
  const agentSourceRoot = join(productRoot, "packages", "agent", "src");

  expect(
    ["./index.js", "@adam-agent/agent"].filter((specifier) =>
      isAgentRootFacadeSpecifier(sourcePath, specifier, agentSourceRoot),
    ),
  ).toEqual(["./index.js", "@adam-agent/agent"]);
  expect(moduleSpecifiers('export * as facade from "./index.js";')).toEqual(["./index.js"]);
});

test("SessionLifecycle canonical history projections have package-internal owners", async () => {
  const agentSourceRoot = join(productRoot, "packages", "agent", "src");
  const sourceFiles = (await readdir(agentSourceRoot, { recursive: true }))
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  const sources = await Promise.all(
    sourceFiles.map(async (sourceFile) => ({
      path: sourceFile,
      source: await readFile(join(agentSourceRoot, sourceFile), "utf8"),
    })),
  );
  const expectedOwners = {
    SessionLifecycleError: ["session-lifecycle-error.ts"],
    addContextUsageTotals: ["session-history-folds.ts"],
    areReplayProfilesCompatible: ["session-history-folds.ts"],
    attemptStatus: ["session-history-folds.ts"],
    contextSnapshotFromRecords: ["session-history-folds.ts"],
    contextUsageSnapshotFromRecords: ["session-history-folds.ts"],
    hasSuccessfullySettledAssistant: ["session-history-validation.ts"],
    inlineModelResponseField: ["session-history-replay.ts"],
    isCompleteBranchBoundary: ["session-history-folds.ts"],
    isGenesisRecord: ["session-history-folds.ts"],
    isSkillActivationBatchValid: ["session-history-folds.ts"],
    isSkillActivationBatchTransitionValid: ["session-history-folds.ts"],
    isSkillContextCatalogSuccessor: ["session-history-folds.ts"],
    isSkillContextPathSuccessor: ["session-history-folds.ts"],
    modelMessagesFromCanonicalRecords: ["session-history-replay.ts"],
    modelMessagesFromCompleteRecords: ["session-history-replay.ts"],
    promptContextRecordFromRecords: ["session-history-folds.ts"],
    skillContextRecordFromRecords: ["session-history-folds.ts"],
    snapshotFromGenesis: ["session-history-folds.ts"],
    snapshotFromRecords: ["session-history-folds.ts"],
    validateCurrentSessionHistory: ["session-history-validation.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) =>
          new RegExp(
            symbol === "SessionLifecycleError"
              ? `\\bclass\\s+${symbol}\\b`
              : `\\bfunction\\s+${symbol}\\s*\\(`,
            "u",
          ).test(source),
        )
        .map(({ path }) => path),
    ]),
  );

  expect.soft(actualOwners).toEqual(expectedOwners);

  const expectedTypeOwners = {
    CurrentSessionSnapshot: ["session-snapshot-contracts.ts"],
    LegacySessionSnapshot: ["session-snapshot-contracts.ts"],
    ModelResponseArtifactDegradation: ["session-history-folds.ts"],
    ModelResponseArtifactInspection: ["session-history-folds.ts"],
    SessionContextSnapshot: ["session-snapshot-contracts.ts"],
    SessionContextUsageSnapshot: ["session-snapshot-contracts.ts"],
    SessionResumeResult: ["session-snapshot-contracts.ts"],
    SessionSnapshot: ["session-snapshot-contracts.ts"],
  } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );

  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);

  const extractedSources = sources.filter(({ path }) =>
    [
      "session-history-folds.ts",
      "session-history-replay.ts",
      "session-history-validation.ts",
      "session-lifecycle-error.ts",
      "session-snapshot-contracts.ts",
    ].includes(path),
  );
  const forbiddenImports = extractedSources.flatMap(({ path, source }) =>
    moduleSpecifiers(source)
      .filter((specifier) =>
        [
          "./agent-session.js",
          "./extension-host.js",
          "./index.js",
          "./session-lifecycle.js",
          "@adam-agent/agent",
          "@adam-agent/presentation",
          "node:child_process",
          "node:fs",
          "node:fs/promises",
        ].includes(specifier),
      )
      .map((specifier) => ({ path, specifier })),
  );
  const lifecycleSource = sources.find(({ path }) => path === "session-lifecycle.ts")?.source ?? "";
  const publicFacadeSource = sources.find(({ path }) => path === "index.ts")?.source ?? "";
  const testingFacadeSource =
    sources.find(({ path }) => path === "internal-testing.ts")?.source ?? "";
  const testSourceRoots = (
    await Promise.all(
      ["apps", "packages"].map(async (root) =>
        (
          await readdir(join(productRoot, root), { withFileTypes: true })
        )
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(productRoot, root, entry.name, "src")),
      ),
    )
  ).flat();
  const testSources = (
    await Promise.all(
      testSourceRoots.map(async (sourceRoot) => {
        try {
          return (await readdir(sourceRoot, { recursive: true }))
            .filter((entry) => entry.endsWith(".test.ts"))
            .map((entry) => join(sourceRoot, entry));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        }
      }),
    )
  ).flat();
  const directTestImports = (
    await Promise.all(
      testSources
        .filter((testPath) => testPath !== fileURLToPath(import.meta.url))
        .map(async (testPath) =>
          moduleSpecifiers(await readFile(testPath, "utf8"))
            .filter(
              (specifier) =>
                /(?:session-history-(?:folds|replay|validation)|session-lifecycle-error)\.js$/u.test(
                  specifier,
                ) || /session-snapshot-contracts\.js$/u.test(specifier),
            )
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(forbiddenImports).toEqual([]);
  expect.soft(directTestImports).toEqual([]);
  expect
    .soft({
      errorImport: lifecycleSource.includes('from "./session-lifecycle-error.js"'),
      errorReexport: lifecycleSource.includes(
        'export { SessionLifecycleError } from "./session-lifecycle-error.js";',
      ),
      replayImport: lifecycleSource.includes('from "./session-history-replay.js"'),
      snapshotContractReferences: moduleSpecifiers(lifecycleSource).filter(
        (specifier) => specifier === "./session-snapshot-contracts.js",
      ).length,
      validationImport: lifecycleSource.includes('from "./session-history-validation.js"'),
    })
    .toEqual({
      errorImport: true,
      errorReexport: true,
      replayImport: true,
      snapshotContractReferences: 2,
      validationImport: true,
    });
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-folds.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-replay.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-validation.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-lifecycle-error.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-snapshot-contracts.js");
  }
});

async function readPackageJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isForbiddenPublicClaim(text: string): boolean {
  return forbiddenPublicClaimPatterns.some((pattern) => pattern.test(text));
}

function isAgentRootFacadeSpecifier(
  sourcePath: string,
  specifier: string,
  agentSourceRoot: string,
): boolean {
  return (
    specifier === "@adam-agent/agent" ||
    (specifier.startsWith(".") &&
      resolve(dirname(sourcePath), specifier) === join(agentSourceRoot, "index.js"))
  );
}

function moduleSpecifiers(source: string): readonly string[] {
  const patterns = [
    /\bimport\s+[\s\S]*?\sfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\S+)?|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/gu,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
}
