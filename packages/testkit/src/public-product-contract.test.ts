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
    createInheritedContextEvidence: ["session-lineage.ts"],
    createSessionLineageTraversal: ["session-lineage.ts"],
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
    readValidatedLineagePrefix: ["session-lineage.ts"],
    sessionNamingStateFromRecords: ["session-history-folds.ts"],
    sessionInheritsSourceBoundary: ["session-lineage.ts"],
    skillContextRecordFromRecords: ["session-history-folds.ts"],
    snapshotFromGenesis: ["session-history-folds.ts"],
    snapshotFromRecords: ["session-history-folds.ts"],
    validateCurrentSessionHistory: ["session-history-validation.ts"],
    validateSessionLineage: ["session-lineage.ts"],
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
    SessionLineageRecordReader: ["session-lineage.ts"],
    SessionLineageTraversal: ["session-lineage.ts"],
    SessionNamingHistoryState: ["session-history-folds.ts"],
    SessionContextSnapshot: ["session-snapshot-contracts.ts"],
    SessionContextUsageSnapshot: ["session-snapshot-contracts.ts"],
    SessionResumeResult: ["session-snapshot-contracts.ts"],
    SessionSnapshot: ["session-snapshot-contracts.ts"],
    ValidatedLineagePrefix: ["session-lineage.ts"],
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
      "session-lineage.ts",
      "session-snapshot-contracts.ts",
    ].includes(path),
  );
  const forbiddenImports = extractedSources.flatMap(({ path, source }) =>
    moduleSpecifiers(source)
      .filter(
        (specifier) =>
          specifier.startsWith("./presentation-") ||
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
  const lineageSource = sources.find(({ path }) => path === "session-lineage.ts")?.source ?? "";
  const presentationSource =
    sources.find(({ path }) => path === "presentation-session.ts")?.source ?? "";
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
                ) || /session-(?:lineage|snapshot-contracts)\.js$/u.test(specifier),
            )
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(forbiddenImports).toEqual([]);
  expect
    .soft(
      moduleSpecifiers(lineageSource).filter((specifier) =>
        [
          "./agent-session.js",
          "./artifact-store.js",
          "./extension-host.js",
          "./index.js",
          "./mcp-host.js",
          "./session-lifecycle.js",
          "@adam-agent/agent",
          "@adam-agent/presentation",
          "node:child_process",
          "node:fs",
          "node:fs/promises",
          "node:process",
        ].includes(specifier),
      ),
    )
    .toEqual([]);
  expect
    .soft({
      storeSpecifierReferences: moduleSpecifiers(lineageSource).filter(
        (specifier) => specifier === "./session-store.js",
      ).length,
      storeRuntimeImport: /import\s+(?!type\b)[^;]*from\s+"\.\/session-store\.js";/su.test(
        lineageSource,
      ),
      storeTypeImport: /import\s+type\s+\{[^}]*\}\s+from\s+"\.\/session-store\.js";/su.test(
        lineageSource,
      ),
    })
    .toEqual({ storeSpecifierReferences: 1, storeRuntimeImport: false, storeTypeImport: true });
  expect.soft(directTestImports).toEqual([]);
  expect
    .soft({
      historyImport: moduleSpecifiers(presentationSource).includes("./session-history-folds.js"),
      namingStateConsumers: sources
        .filter(
          ({ path, source }) =>
            path !== "session-history-folds.ts" &&
            /\bsessionNamingStateFromRecords\b/u.test(source),
        )
        .map(({ path }) => path),
      legacyDisplayLabelOwners: sources
        .filter(({ source }) => /\bfunction\s+sessionDisplayLabelFromRecords\s*\(/u.test(source))
        .map(({ path }) => path),
      legacyPresentationNamingOwners: sources
        .filter(({ source }) => /\bfunction\s+sessionNamingFromRecords\s*\(/u.test(source))
        .map(({ path }) => path),
    })
    .toEqual({
      historyImport: true,
      namingStateConsumers: ["presentation-session.ts", "session-lifecycle.ts"],
      legacyDisplayLabelOwners: [],
      legacyPresentationNamingOwners: [],
    });
  expect
    .soft({
      errorImport: lifecycleSource.includes('from "./session-lifecycle-error.js"'),
      errorReexport: lifecycleSource.includes(
        'export { SessionLifecycleError } from "./session-lifecycle-error.js";',
      ),
      lineageImport: lifecycleSource.includes('from "./session-lineage.js"'),
      replayImport: lifecycleSource.includes('from "./session-history-replay.js"'),
      snapshotContractReferences: moduleSpecifiers(lifecycleSource).filter(
        (specifier) => specifier === "./session-snapshot-contracts.js",
      ).length,
      validationImport: lifecycleSource.includes('from "./session-history-validation.js"'),
    })
    .toEqual({
      errorImport: true,
      errorReexport: true,
      lineageImport: true,
      replayImport: true,
      snapshotContractReferences: 2,
      validationImport: true,
    });
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-folds.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-replay.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-history-validation.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-lifecycle-error.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-lineage.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./session-snapshot-contracts.js");
  }
});

test("MCP configuration documents have one package-internal owner", async () => {
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
    inspectMcpConfigurationDocument: ["mcp-configuration-document.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) =>
          new RegExp(`\\bexport\\s+function\\s+${symbol}\\s*\\(`, "u").test(source),
        )
        .map(({ path }) => path),
    ]),
  );
  const expectedTypeOwners = {
    McpConfigurationDocument: ["mcp-configuration-document.ts"],
  } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const documentSource =
    sources.find(({ path }) => path === "mcp-configuration-document.ts")?.source ?? "";
  const mcpHostSource = sources.find(({ path }) => path === "mcp-host.ts")?.source ?? "";
  const documentConsumers = sources
    .filter(({ source }) => moduleSpecifiers(source).includes("./mcp-configuration-document.js"))
    .map(({ path }) => path);
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
            .filter((specifier) => /mcp-configuration-document\.js$/u.test(specifier))
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);
  expect.soft(documentConsumers).toEqual(["mcp-host.ts"]);
  expect
    .soft(
      runtimeModuleSpecifiers(mcpHostSource).filter(
        (specifier) => specifier === "./mcp-configuration-document.js",
      ),
    )
    .toEqual(["./mcp-configuration-document.js"]);
  expect.soft(mcpHostSource.match(/\binspectMcpConfigurationDocument\s*\(/gu)).toHaveLength(1);
  expect.soft(runtimeModuleSpecifiers(documentSource)).toEqual(["node:buffer", "node:crypto"]);
  expect.soft(typeOnlyImportSpecifiers(documentSource)).toEqual([]);
  expect.soft([...moduleSpecifiers(documentSource)].sort()).toEqual(["node:buffer", "node:crypto"]);
  const packageInternalSymbols = ["inspectMcpConfigurationDocument", "McpConfigurationDocument"];
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./mcp-configuration-document.js");
    expect
      .soft(packageInternalSymbols.filter((symbol) => facadeSource.includes(symbol)))
      .toEqual([]);
  }
  expect.soft(directTestImports).toEqual([]);
});

test("MCP canonical identity and durable Tool Profile contracts have package-internal owners", async () => {
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
    canonicalMcpJson: ["mcp-canonical-identity.ts"],
    createMcpToolProfileV1: ["mcp-profile-contracts.ts"],
    digestCanonicalMcpJson: ["mcp-canonical-identity.ts"],
    isMcpToolProfileV1Valid: ["mcp-profile-contracts.ts"],
    mcpToolProfileSnapshot: ["mcp-profile-contracts.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) =>
          new RegExp(`\\bexport\\s+function\\s+${symbol}\\s*\\(`, "u").test(source),
        )
        .map(({ path }) => path),
    ]),
  );
  const expectedTypeOwners = {
    McpSha256Digest: ["mcp-canonical-identity.ts"],
    McpSettledServerIdentity: ["mcp-profile-contracts.ts"],
    McpToolProfileSnapshot: ["mcp-profile-contracts.ts"],
    McpToolProfileV1: ["mcp-profile-contracts.ts"],
  } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const canonicalSource =
    sources.find(({ path }) => path === "mcp-canonical-identity.ts")?.source ?? "";
  const profileSource =
    sources.find(({ path }) => path === "mcp-profile-contracts.ts")?.source ?? "";
  const hostSource = sources.find(({ path }) => path === "mcp-host.ts")?.source ?? "";
  const historyValidationSource =
    sources.find(({ path }) => path === "session-history-validation.ts")?.source ?? "";
  const canonicalConsumers = sources
    .filter(({ source }) => runtimeModuleSpecifiers(source).includes("./mcp-canonical-identity.js"))
    .map(({ path }) => path);
  const profileConsumers = sources
    .filter(({ source }) => moduleSpecifiers(source).includes("./mcp-profile-contracts.js"))
    .map(({ path }) => path);
  const profileRuntimeConsumers = sources
    .filter(({ source }) => runtimeModuleSpecifiers(source).includes("./mcp-profile-contracts.js"))
    .map(({ path }) => path);
  const profileCompatibilityExports = [
    ...hostSource.matchAll(/export\s*\{([^}]*)\}\s*from\s+"\.\/mcp-profile-contracts\.js"/gu),
  ]
    .flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((entry) => entry.trim().replace(/\s+/gu, " "))
        .filter((entry) => entry.length > 0),
    )
    .sort();
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
            .filter((specifier) =>
              /mcp-(?:canonical-identity|profile-contracts)\.js$/u.test(specifier),
            )
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);
  expect
    .soft(canonicalConsumers)
    .toEqual(["mcp-host.ts", "mcp-profile-contracts.ts", "plan-mcp-permission-validation.ts"]);
  expect
    .soft(profileConsumers)
    .toEqual([
      "mcp-host.ts",
      "mcp-schema-admission.ts",
      "prompt-assembly.ts",
      "session-history-validation.ts",
      "session-lifecycle.ts",
      "session-store.ts",
    ]);
  expect.soft(profileRuntimeConsumers).toEqual(["mcp-host.ts", "session-history-validation.ts"]);
  expect.soft(moduleSpecifiers(canonicalSource)).toEqual(["node:crypto"]);
  expect.soft(runtimeModuleSpecifiers(canonicalSource)).toEqual(["node:crypto"]);
  expect.soft(typeOnlyImportSpecifiers(canonicalSource)).toEqual([]);
  expect
    .soft([...moduleSpecifiers(profileSource)].sort())
    .toEqual(["./mcp-canonical-identity.js", "./tool-runtime.js"]);
  expect.soft(runtimeModuleSpecifiers(profileSource)).toEqual(["./mcp-canonical-identity.js"]);
  expect.soft(typeOnlyImportSpecifiers(profileSource)).toEqual(["./tool-runtime.js"]);
  expect.soft(moduleSpecifiers(historyValidationSource)).not.toContain("./mcp-host.js");
  expect.soft(hostSource.match(/\bcreateMcpToolProfileV1\s*\(/gu)).toHaveLength(1);
  const legacyHostProfileOwnerFragments = [
    "maximumMcpToolProfileDefinitionBytes",
    "profileWithoutDigest",
    "canonicalMcpJson(modelDefinitions)",
  ];
  expect
    .soft(legacyHostProfileOwnerFragments.filter((fragment) => hostSource.includes(fragment)))
    .toEqual([]);
  expect
    .soft(profileCompatibilityExports)
    .toEqual([
      "isMcpToolProfileV1Valid",
      "mcpToolProfileSnapshot",
      "type McpToolProfileSnapshot",
      "type McpToolProfileV1",
    ]);
  const packagePrivateSymbols = [
    "McpSettledServerIdentity",
    "McpSha256Digest",
    "McpToolProfileSnapshot",
    "McpToolProfileV1",
    "canonicalMcpJson",
    "createMcpToolProfileV1",
    "digestCanonicalMcpJson",
    "isMcpToolProfileV1Valid",
    "mcpToolProfileSnapshot",
  ];
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./mcp-canonical-identity.js");
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./mcp-profile-contracts.js");
    expect
      .soft(packagePrivateSymbols.filter((symbol) => facadeSource.includes(symbol)))
      .toEqual([]);
  }
  expect.soft(directTestImports).toEqual([]);
});

test("MCP schema admission has one package-internal owner", async () => {
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
  const expectedOwners = { admitMcpSchema: ["mcp-schema-admission.ts"] } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) =>
          new RegExp(`\\bexport\\s+function\\s+${symbol}\\s*\\(`, "u").test(source),
        )
        .map(({ path }) => path),
    ]),
  );
  const expectedTypeOwners = { McpSchemaAdmission: ["mcp-schema-admission.ts"] } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const schemaSource = sources.find(({ path }) => path === "mcp-schema-admission.ts")?.source ?? "";
  const hostSource = sources.find(({ path }) => path === "mcp-host.ts")?.source ?? "";
  const expectedProjectorOwners = {
    projectMcpInputSchemaV1: ["mcp-host.ts"],
    projectMcpRootChoice: ["mcp-host.ts"],
  } as const;
  const actualProjectorOwners = Object.fromEntries(
    Object.keys(expectedProjectorOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bfunction\\s+${symbol}\\s*\\(`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const schemaConsumers = sources
    .filter(({ source }) => moduleSpecifiers(source).includes("./mcp-schema-admission.js"))
    .map(({ path }) => path);
  const schemaRuntimeConsumers = sources
    .filter(({ source }) => runtimeModuleSpecifiers(source).includes("./mcp-schema-admission.js"))
    .map(({ path }) => path);
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
            .filter((specifier) => /mcp-schema-admission\.js$/u.test(specifier))
            .map((specifier) => ({ path: relative(productRoot, testPath), specifier })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);
  expect.soft(actualProjectorOwners).toEqual(expectedProjectorOwners);
  expect.soft(schemaSource.match(/\bexport\s+/gu) ?? []).toHaveLength(2);
  expect
    .soft(
      [
        ...schemaSource.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class|enum)\s+(\w+)/gu),
      ].map((match) => match[1]),
    )
    .toEqual(["admitMcpSchema"]);
  expect
    .soft(
      [...schemaSource.matchAll(/\bexport\s+(?:type|interface)\s+(\w+)/gu)].map(
        (match) => match[1],
      ),
    )
    .toEqual(["McpSchemaAdmission"]);
  expect.soft(schemaConsumers).toEqual(["mcp-host.ts"]);
  expect.soft(schemaRuntimeConsumers).toEqual(["mcp-host.ts"]);
  expect.soft(moduleSpecifiers(schemaSource)).toEqual(["./mcp-profile-contracts.js"]);
  expect.soft(runtimeModuleSpecifiers(schemaSource)).toEqual([]);
  expect.soft(typeOnlyImportSpecifiers(schemaSource)).toEqual(["./mcp-profile-contracts.js"]);
  expect
    .soft(
      runtimeModuleSpecifiers(hostSource).filter(
        (specifier) => specifier === "./mcp-schema-admission.js",
      ),
    )
    .toEqual(["./mcp-schema-admission.js"]);
  expect.soft(hostSource.match(/\badmitMcpSchema\s*\(/gu) ?? []).toHaveLength(3);
  const legacyHostAdmissionOwnerFragments = [
    "const mcpSchemaLimits",
    "function assertMcpSchemaAdmissible",
    "function validateMcpReferenceGraph",
    "function resolveLocalSchemaReference",
    "function resolveMcpProjectionBranch",
    "function schemaDialect",
  ];
  expect
    .soft(legacyHostAdmissionOwnerFragments.filter((fragment) => hostSource.includes(fragment)))
    .toEqual([]);
  const forbiddenSchemaOwnerFragments = [
    "compatibilityHint",
    "digestCanonicalMcpJson",
    "truncateUtf8",
    "@modelcontextprotocol/sdk",
    "Ajv",
    "McpHostError",
    "McpTransportFactory",
  ];
  expect
    .soft(forbiddenSchemaOwnerFragments.filter((fragment) => schemaSource.includes(fragment)))
    .toEqual([]);
  const packageInternalSymbols = ["admitMcpSchema", "McpSchemaAdmission"];
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./mcp-schema-admission.js");
    expect
      .soft(packageInternalSymbols.filter((symbol) => facadeSource.includes(symbol)))
      .toEqual([]);
  }
  expect.soft(directTestImports).toEqual([]);
});

test("PresentationSession tool projection has one package-internal owner", async () => {
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
    collectChangePreviewRequests: ["presentation-tool-projection.ts"],
    projectChangePreviewPage: ["presentation-tool-projection.ts"],
    projectPendingPermissionCandidates: ["presentation-tool-projection.ts"],
    projectToolDisplays: ["presentation-tool-projection.ts"],
    resolveActionableChangePreviewReference: ["presentation-tool-projection.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bfunction\\s+${symbol}\\s*\\(`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const expectedTypeOwners = {
    ChangePreviewProjectionRequest: ["presentation-tool-projection.ts"],
  } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const projectionSource =
    sources.find(({ path }) => path === "presentation-tool-projection.ts")?.source ?? "";
  const projectionConsumers = sources
    .filter(({ source }) => moduleSpecifiers(source).includes("./presentation-tool-projection.js"))
    .map(({ path }) => path);
  const projectionDependencies = [...moduleSpecifiers(projectionSource)].sort();
  const projectionRuntimeImports = runtimeModuleSpecifiers(projectionSource);
  const projectionTypeImports = typeOnlyImportSpecifiers(projectionSource).sort();
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
            .filter((specifier) => /presentation-tool-projection\.js$/u.test(specifier))
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);
  expect.soft(projectionConsumers).toEqual(["presentation-session.ts"]);
  expect.soft(projectionRuntimeImports).toEqual([]);
  expect
    .soft(projectionTypeImports)
    .toEqual([
      "./artifact-store.js",
      "./session-store.js",
      "./tool-runtime.js",
      "@adam-agent/presentation",
    ]);
  expect
    .soft(projectionDependencies)
    .toEqual([
      "./artifact-store.js",
      "./session-store.js",
      "./tool-runtime.js",
      "@adam-agent/presentation",
    ]);
  const packageInternalSymbols = [
    "ChangePreviewProjectionRequest",
    "collectChangePreviewRequests",
    "projectChangePreviewPage",
    "projectPendingPermissionCandidates",
    "projectToolDisplays",
    "resolveActionableChangePreviewReference",
  ];
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect.soft(moduleSpecifiers(facadeSource)).not.toContain("./presentation-tool-projection.js");
    expect
      .soft(packageInternalSymbols.filter((symbol) => facadeSource.includes(symbol)))
      .toEqual([]);
  }
  expect.soft(directTestImports).toEqual([]);
});

test("PresentationSession transcript projection has one package-internal owner", async () => {
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
    projectActiveReasoningSnapshot: ["presentation-transcript-projection.ts"],
    projectTranscript: ["presentation-transcript-projection.ts"],
    providerDisplayName: ["presentation-transcript-projection.ts"],
    reasoningDisplayId: ["presentation-transcript-projection.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bfunction\\s+${symbol}\\s*\\(`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const projectionSource =
    sources.find(({ path }) => path === "presentation-transcript-projection.ts")?.source ?? "";
  const projectionConsumers = sources
    .filter(({ source }) =>
      moduleSpecifiers(source).includes("./presentation-transcript-projection.js"),
    )
    .map(({ path }) => path);
  const projectionDependencies = [...moduleSpecifiers(projectionSource)].sort();
  const projectionRuntimeImports = runtimeModuleSpecifiers(projectionSource);
  const projectionTypeImports = typeOnlyImportSpecifiers(projectionSource).sort();
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
            .filter((specifier) => /presentation-transcript-projection\.js$/u.test(specifier))
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(projectionConsumers).toEqual(["presentation-session.ts"]);
  expect.soft(projectionRuntimeImports).toEqual([]);
  expect
    .soft(projectionTypeImports)
    .toEqual(["./agent-session-contracts.js", "./session-store.js", "@adam-agent/presentation"]);
  expect
    .soft(projectionDependencies)
    .toEqual(["./agent-session-contracts.js", "./session-store.js", "@adam-agent/presentation"]);
  const packageInternalSymbols = Object.keys(expectedOwners);
  for (const facadeSource of [publicFacadeSource, testingFacadeSource]) {
    expect
      .soft(moduleSpecifiers(facadeSource))
      .not.toContain("./presentation-transcript-projection.js");
    expect
      .soft(packageInternalSymbols.filter((symbol) => facadeSource.includes(symbol)))
      .toEqual([]);
  }
  expect.soft(directTestImports).toEqual([]);
});

test("the runtime module detector covers every value-bearing module form", () => {
  expect(
    runtimeModuleSpecifiers(`
      import { staticValue } from "static-module";
      import "side-effect-module";
      const dynamicValue = import("dynamic-module");
      export { runtimeValue } from "runtime-reexport-module";
      export * from "star-reexport-module";
      import type { StaticType } from "type-module";
      export type { ReexportedType } from "type-reexport-module";
    `),
  ).toEqual([
    "static-module",
    "side-effect-module",
    "dynamic-module",
    "runtime-reexport-module",
    "star-reexport-module",
  ]);
});

test("PresentationSession linked-operation projection has one package-internal owner", async () => {
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
    projectLinkedOperation: ["presentation-operation-projection.ts"],
  } as const;
  const actualOwners = Object.fromEntries(
    Object.keys(expectedOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bfunction\\s+${symbol}\\s*\\(`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const expectedTypeOwners = {
    ProjectedOperation: ["presentation-operation-projection.ts"],
  } as const;
  const actualTypeOwners = Object.fromEntries(
    Object.keys(expectedTypeOwners).map((symbol) => [
      symbol,
      sources
        .filter(({ source }) => new RegExp(`\\bexport\\s+type\\s+${symbol}\\b`, "u").test(source))
        .map(({ path }) => path),
    ]),
  );
  const projectionSource =
    sources.find(({ path }) => path === "presentation-operation-projection.ts")?.source ?? "";
  const projectionConsumers = sources
    .filter(({ source }) =>
      moduleSpecifiers(source).includes("./presentation-operation-projection.js"),
    )
    .map(({ path }) => path);
  const projectionDependencies = [...moduleSpecifiers(projectionSource)].sort();
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
            .filter((specifier) => /presentation-operation-projection\.js$/u.test(specifier))
            .map((specifier) => ({
              path: relative(productRoot, testPath),
              specifier,
            })),
        ),
    )
  ).flat();

  expect.soft(actualOwners).toEqual(expectedOwners);
  expect.soft(actualTypeOwners).toEqual(expectedTypeOwners);
  expect.soft(projectionConsumers).toEqual(["presentation-session.ts"]);
  expect.soft(projectionDependencies).toEqual(["./operation-host.js", "@adam-agent/presentation"]);
  expect
    .soft({
      operationHostReferences: moduleSpecifiers(projectionSource).filter(
        (specifier) => specifier === "./operation-host.js",
      ).length,
      operationHostTypeImport:
        /import\s+type\s+\{[^}]*OperationSnapshot[^}]*\}\s+from\s+"\.\/operation-host\.js";/su.test(
          projectionSource,
        ),
      presentationReferences: moduleSpecifiers(projectionSource).filter(
        (specifier) => specifier === "@adam-agent/presentation",
      ).length,
      presentationTypeImport:
        /import\s+type\s+\{[^}]*OperationDisplay[^}]*\}\s+from\s+"@adam-agent\/presentation";/su.test(
          projectionSource,
        ),
    })
    .toEqual({
      operationHostReferences: 1,
      operationHostTypeImport: true,
      presentationReferences: 1,
      presentationTypeImport: true,
    });
  expect.soft(directTestImports).toEqual([]);
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

function runtimeModuleSpecifiers(source: string): readonly string[] {
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

function typeOnlyImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport\s+type\s+[^;]*?\sfrom\s*["']([^"']+)["']/gu)].map(
    (match) => match[1] ?? "",
  );
}
