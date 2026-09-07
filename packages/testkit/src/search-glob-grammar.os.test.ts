import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createReadToolRegistry } from "@adam-agent/agent";
import { createRepositorySearchToolAdapterForTesting } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

const legalPaths = [
  "#file.ts",
  "*.ts",
  "@(a).ts",
  "a.ts",
  "a[.ts",
  "b.txt",
  "file-1.ts",
  "file-{1..3}.ts",
  "foo/bar.ts",
  "space .ts",
  "src/a.ts",
  "src/b.txt",
  "src/foo",
  "src/sub/a.ts",
  "é.ts",
  "😀.ts",
] as const;
const typescriptPaths = [
  "#file.ts",
  "*.ts",
  "@(a).ts",
  "a.ts",
  "a[.ts",
  "file-1.ts",
  "file-{1..3}.ts",
  "foo/bar.ts",
  "space .ts",
  "src/a.ts",
  "src/sub/a.ts",
  "é.ts",
  "😀.ts",
] as const;
const cases: readonly { readonly query: string; readonly expected: readonly string[] }[] = [
  { query: "*", expected: legalPaths },
  { query: "*.ts", expected: typescriptPaths },
  { query: "/a.ts", expected: ["a.ts"] },
  { query: "src/*.ts", expected: ["src/a.ts"] },
  { query: "src/**", expected: ["src/a.ts", "src/b.txt", "src/foo", "src/sub/a.ts"] },
  { query: "foo/", expected: [] },
  { query: "foo", expected: ["src/foo"] },
  { query: "*.{ts,txt}", expected: [...typescriptPaths, "b.txt", "src/b.txt"].sort() },
  { query: "{a,{b,c}}.ts", expected: ["a.ts", "src/a.ts", "src/sub/a.ts"] },
  { query: "\\*.ts", expected: ["*.ts"] },
  { query: "@(a).ts", expected: ["@(a).ts"] },
  { query: "file-{1..3}.ts", expected: [] },
  { query: "?.ts", expected: ["*.ts", "a.ts", "src/a.ts", "src/sub/a.ts"] },
  { query: "??.ts", expected: ["a[.ts", "é.ts"] },
  { query: "[é].ts", expected: [] },
  {
    query: "[!a]*.ts",
    expected: [
      "#file.ts",
      "*.ts",
      "@(a).ts",
      "file-1.ts",
      "file-{1..3}.ts",
      "foo/bar.ts",
      "space .ts",
      "é.ts",
      "😀.ts",
    ],
  },
  { query: "[*].ts", expected: ["*.ts"] },
  { query: "\\#file.ts", expected: ["#file.ts"] },
  { query: "#file.ts", expected: legalPaths },
  { query: " ", expected: legalPaths },
  {
    query: "!a.ts",
    expected: [
      "#file.ts",
      "*.ts",
      "@(a).ts",
      "a[.ts",
      "b.txt",
      "file-1.ts",
      "file-{1..3}.ts",
      "foo/bar.ts",
      "space .ts",
      "src/b.txt",
      "src/foo",
      "é.ts",
      "😀.ts",
    ],
  },
  {
    query: "!foo",
    expected: [
      "#file.ts",
      "*.ts",
      "@(a).ts",
      "a.ts",
      "a[.ts",
      "b.txt",
      "file-1.ts",
      "file-{1..3}.ts",
      "space .ts",
      "src/a.ts",
      "src/b.txt",
      "src/sub/a.ts",
      "é.ts",
      "😀.ts",
    ],
  },
];

test("repository path matching preserves native glob syntax over its admitted discovery set", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-search-native-globs-"));
  try {
    for (const path of [...legalPaths, ".hidden.ts", "ignored/private.ts"]) {
      await mkdir(join(workspaceRoot, dirname(path)), { recursive: true });
      await writeFile(join(workspaceRoot, path), "needle\n");
    }
    await writeFile(join(workspaceRoot, ".gitignore"), "ignored/\n");
    const adapter = createReadToolRegistry({ workspaceRoot }).resolve("search_repository");
    if (adapter === undefined) throw new Error("The public search tool was unavailable.");
    for (const { query, expected } of cases) {
      const result = await executeSearch(adapter, query);
      expect(result, query).toMatchObject({
        status: "completed",
        output: { resultCount: expected.length },
      });
      if (result.status !== "completed") throw new Error(`Search failed for ${query}.`);
      expect(adapter.outputSchema.safeParse(result.output).success, query).toBe(true);
      const output = result.output as { readonly entries: readonly { readonly path: string }[] };
      expect(
        output.entries.map((entry) => entry.path),
        query,
      ).toEqual(expected);
    }
    await expect(executeSearch(adapter, "a[.ts")).resolves.toMatchObject({
      status: "failed",
      error: { code: "tool_io_failed" },
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("an excluded-tree record flood cannot consume the admitted search budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-excluded-budget-"));
  const workspaceRoot = join(root, "workspace");
  const executable = join(root, "external-rg.mjs");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "normal.ts"), "needle\n");
  await writeFile(join(workspaceRoot, ".gitignore"), "ignored/\n");
  // External process input models ripgrep's override precedence without creating
  // 100,001 real files just to demonstrate a raw-record budget failure.
  await writeFile(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
const globs = [];
const nul = String.fromCharCode(0);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--glob' || args[index] === '-g') globs.push(args[++index]);
  else if (args[index].startsWith('--glob=')) globs.push(args[index].slice(7));
}
if (globs.some(glob => !glob.startsWith('!'))) {
  let output = '';
  for (let index = 0; index < 100001; index += 1) output += 'ignored/file-' + index + '.ts' + nul;
  process.stdout.write(output);
} else if (globs.includes('!*')) {
  process.exitCode = 1;
} else {
  process.stdout.write('normal.ts' + nul);
}
`,
  );
  await chmod(executable, 0o700);
  try {
    const adapter = createRepositorySearchToolAdapterForTesting({
      workspaceRoot,
      rgPathOverrideForTesting: executable,
    });
    await expect(executeSearch(adapter, "*")).resolves.toMatchObject({
      status: "completed",
      output: {
        resultCount: 1,
        snapshotResultCount: 1,
        entries: [{ path: "normal.ts", rankReason: "glob" }],
        omissions: [],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function executeSearch(
  adapter: ReturnType<typeof createRepositorySearchToolAdapterForTesting>,
  query: string,
) {
  const prepared = adapter.prepare(
    JSON.stringify({ kind: "path", mode: "glob", query, limit: 50 }),
  );
  if (prepared.status !== "ready") return prepared;
  return prepared.execute({
    signal: new AbortController().signal,
    callId: "glob-contract",
    toolName: "search_repository",
    sessionId: "glob-contract-session",
    toolProfileDigest: "sha256:glob-contract-profile",
  });
}
