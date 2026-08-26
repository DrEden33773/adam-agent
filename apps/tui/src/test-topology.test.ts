import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const behaviorSuitePath = fileURLToPath(new URL("./main.test.ts", import.meta.url));
const operatingSystemSuitePath = fileURLToPath(new URL("./main.os.test.ts", import.meta.url));
const tuiSourceRoot = fileURLToPath(new URL(".", import.meta.url));
const productionEntryPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const productionTuiPath = fileURLToPath(new URL("./tui-app.ts", import.meta.url));
const cliEntryPath = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const packagePath = fileURLToPath(new URL("../../../package.json", import.meta.url));
const qualityWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/quality.yml", import.meta.url),
);
const vitestConfigurationPath = fileURLToPath(
  new URL("../../../vitest.config.ts", import.meta.url),
);

test("TUI behavior and operating-system contracts keep separate harness ownership", async () => {
  const [behaviorSource, operatingSystemSource] = await Promise.all([
    readFile(behaviorSuitePath, "utf8"),
    readFile(operatingSystemSuitePath, "utf8"),
  ]);

  expect(behaviorSource).not.toContain("node:child_process");
  expect(behaviorSource).not.toContain("external: true");
  expect(behaviorSource).not.toMatch(/\bprogram\s*:/u);
  expect(behaviorSource).not.toContain("setTimeout(");
  expect(operatingSystemSource).not.toContain("setTimeout(");
  expect(`${behaviorSource}\n${operatingSystemSource}`).not.toContain("vi.mock(");

  const operatingSystemCases = topLevelTestBlocks(operatingSystemSource);
  expect(operatingSystemCases.length).toBeGreaterThan(0);
  for (const testCase of operatingSystemCases) {
    expect(testCase).toMatch(/external:\s*true|\bprogram\s*[:,]/u);
  }

  const names = [...topLevelTestBlocks(behaviorSource), ...operatingSystemCases].map(
    (testCase) => testCase.match(/^test\("([^"]+)"/u)?.[1],
  );
  expect(names.every((name) => name !== undefined)).toBe(true);
  expect(new Set(names).size).toBe(names.length);
});

test("Quality keeps every semantic and OS suite in one required Linux regression job", async () => {
  const [packageSource, qualityWorkflow, vitestConfiguration] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(qualityWorkflowPath, "utf8"),
    readFile(vitestConfigurationPath, "utf8"),
  ]);
  const packageManifest = JSON.parse(packageSource) as {
    readonly scripts?: { readonly test?: string };
  };

  expect(packageManifest.scripts?.test).toBe("tsc -b && vitest run");
  expect(vitestConfiguration).toContain('"apps/**/src/**/*.test.ts"');
  expect(qualityWorkflow).toContain("runs-on: ubuntu-24.04");
  expect(qualityWorkflow).toContain("run: pnpm quality:check");
  expect(qualityWorkflow).not.toMatch(/^\s+paths(?:-ignore)?:/gmu);
  expect(qualityWorkflow).not.toContain("continue-on-error");
  expect([...qualityWorkflow.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n {4}runs-on:/gmu)]).toHaveLength(
    1,
  );
});

test("every production overlay family enters Pi through the shared Adam frame", async () => {
  const source = await readFile(productionTuiPath, "utf8");

  expect([...source.matchAll(/\btui\.showOverlay\(/gu)]).toHaveLength(1);
  expect(source).toContain("new OverlayFrame(component, theme");
  expect([...source.matchAll(/\bshowOverlay\(/gu)].length).toBeGreaterThanOrEqual(12);
  for (const family of [
    "SessionPicker",
    "TargetPicker",
    "PermissionOverlay",
    "SkillPalette",
    "ProjectPathPicker",
    "ArtifactNavigator",
    "ChronologyPicker",
    "SessionInspector",
    "ResourceReloadPicker",
    "McpWizard",
    "HelpNavigator",
    "ThinkingPicker",
  ]) {
    expect(source).toContain(`new ${family}`);
  }
});

test("the production TUI has one app-private project runtime composition owner", async () => {
  const [productionSources, entrySource, rendererSource, cliSource] = await Promise.all([
    readProductionTuiSources(tuiSourceRoot),
    readFile(productionEntryPath, "utf8"),
    readFile(productionTuiPath, "utf8"),
    readFile(cliEntryPath, "utf8"),
  ]);
  const runtimeSource = productionSources.get("project-runtime.ts");
  expect(runtimeSource).toBeDefined();

  for (const assemblyCall of [
    "createExtensionHost",
    "createFileArtifactStore",
    "createJsonlOperationStore",
    "createSessionLifecycle",
    "createPresentationSession",
  ]) {
    expect(
      [...productionSources]
        .filter(([, source]) => importsFactoryFromAgent(source, assemblyCall))
        .map(([path]) => path),
    ).toEqual(["project-runtime.ts"]);
  }
  expect(
    importsFactoryFromAgent(
      'import { createExtensionHost as buildHost } from "@adam-agent/agent";',
      "createExtensionHost",
    ),
  ).toBe(true);
  expect(
    importsFactoryFromAgent(
      'import * as agent from "@adam-agent/agent";',
      "createSessionLifecycle",
    ),
  ).toBe(true);
  expect([...entrySource.matchAll(/\bcreateProductionProjectRuntime\(/gu)]).toHaveLength(1);
  expect([...entrySource.matchAll(/\btuiProcessFailureMessage\(error\)/gu)]).toHaveLength(1);
  expect(rendererSource).not.toContain("options.presentation.close()");
  expect(rendererSource).toContain("options.closeRuntime()");
  expect(cliSource).not.toContain("project-runtime.js");
  const presentationClose = (runtimeSource as string).indexOf("await presentation.close();");
  const lifecycleClose = (runtimeSource as string).indexOf(
    "requireConfirmedLifecycleClose(await lifecycle.close());",
  );
  expect(presentationClose).toBeGreaterThan(-1);
  expect(lifecycleClose).toBeGreaterThan(presentationClose);
});

async function readProductionTuiSources(root: string): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  await visit(root);
  return new Map([...sources].sort(([left], [right]) => left.localeCompare(right)));

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && isProductionTuiSource(entry.name)) {
        sources.set(relative(root, path), await readFile(path, "utf8"));
      }
    }
  }
}

function isProductionTuiSource(filename: string): boolean {
  return (
    filename.endsWith(".ts") &&
    !filename.endsWith(".test.ts") &&
    !filename.endsWith(".test-support.ts") &&
    !filename.endsWith(".fixture.ts") &&
    filename !== "fixture-scenario.ts" &&
    filename !== "test-fixture.ts"
  );
}

function importsFactoryFromAgent(source: string, factory: string): boolean {
  if (/import\s+\*\s+as\s+\w+\s+from\s+["']@adam-agent\/agent["']/u.test(source)) {
    return true;
  }
  for (const declaration of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']@adam-agent\/agent["']/gu,
  )) {
    const bindings = declaration[1] ?? "";
    const importedNames = bindings.split(",").map((binding) =>
      binding
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        ?.trim(),
    );
    if (importedNames.includes(factory)) {
      return true;
    }
  }
  return false;
}

function topLevelTestBlocks(source: string): readonly string[] {
  const starts = [...source.matchAll(/^test\(/gmu)].map((match) => match.index);
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
}
