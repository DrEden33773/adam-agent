import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

async function readPackageJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isForbiddenPublicClaim(text: string): boolean {
  return forbiddenPublicClaimPatterns.some((pattern) => pattern.test(text));
}
