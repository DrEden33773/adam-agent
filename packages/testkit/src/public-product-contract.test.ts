import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebSearchConfiguration } from "@adam-agent/agent";
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

test("application package metadata keeps the source checkout private", async () => {
  const [rootPackage, cliPackage, tuiPackage] = await Promise.all([
    readPackageJson(join(productRoot, "package.json")),
    readPackageJson(join(productRoot, "apps", "cli", "package.json")),
    readPackageJson(join(productRoot, "apps", "tui", "package.json")),
  ]);

  expect({ rootPackage, cliPackage, tuiPackage }).toMatchObject({
    rootPackage: { private: true, version: "0.0.0" },
    cliPackage: { private: true, version: "0.0.0" },
    tuiPackage: { private: true, version: "0.0.0" },
  });
});

test("the public entry separates acceptance evidence from security guarantees", async () => {
  const [readme, acceptance, cliEntry, tuiEntry, tuiHelp, tuiCommands] = await Promise.all([
    readFile(join(productRoot, "README.md"), "utf8"),
    readFile(join(productRoot, "docs", "portfolio-acceptance.md"), "utf8"),
    readFile(join(productRoot, "apps", "cli", "src", "main.ts"), "utf8"),
    readFile(join(productRoot, "apps", "tui", "src", "main.ts"), "utf8"),
    readFile(join(productRoot, "apps", "tui", "src", "help-navigator.ts"), "utf8"),
    readFile(join(productRoot, "apps", "tui", "src", "command-registry.ts"), "utf8"),
  ]);

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

async function readPackageJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("the public headless Web Search configuration capability is runtime read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-agent-public-web-config-"));
  try {
    const reader = createWebSearchConfiguration({ environment: { XDG_CONFIG_HOME: root } });
    expect(Object.keys(reader)).toEqual(["load"]);
    expect(reader).not.toHaveProperty("activateSearxng");
    expect(reader).not.toHaveProperty("testAndActivateSearxng");
    expect(reader).not.toHaveProperty("clear");
    await expect(reader.load()).resolves.toMatchObject({ status: "unconfigured" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
