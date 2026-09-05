import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  AgentSession,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createJsonlSessionStore,
  createPermissionPolicy,
} from "@adam-agent/agent";
import {
  createCodingToolRegistryForTesting,
  createRepositorySearchToolAdapterForTesting,
  repositorySearchBackendForTesting,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { FakeModelDriver } from "./index.js";

test("literal repository search keeps relevant files on the first grouped bounded page", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-repository-"));
  const sourceRoot = join(workspaceRoot, "src");

  try {
    await mkdir(sourceRoot);
    await writeFile(
      join(sourceRoot, "00-noise.ts"),
      Array.from({ length: 25 }, (_unused, index) => `// needle noise ${index + 1}`).join("\n"),
      "utf8",
    );
    await writeFile(
      join(sourceRoot, "10-relevant.ts"),
      'export const relevantNeedle = "needle";\n',
      "utf8",
    );
    await writeFile(
      join(sourceRoot, "20-also-relevant.ts"),
      'export function findNeedle() { return "needle"; }\n',
      "utf8",
    );
    let searchOutput: unknown;
    const model = new FakeModelDriver((request) => {
      const latestMessage = request.messages.at(-1);
      if (latestMessage?.role === "user") {
        expect(request.tools.find((tool) => tool.name === "search_repository")).toMatchObject({
          name: "search_repository",
        });
        return [
          { type: "tool_call_start", id: "search-literal", name: "search_repository" },
          {
            type: "tool_call_delta",
            id: "search-literal",
            json: JSON.stringify({ kind: "content", query: "needle" }),
          },
          { type: "tool_call_end", id: "search-literal" },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (
        latestMessage?.role === "tool" &&
        latestMessage.name === "search_repository" &&
        latestMessage.result.status === "completed"
      ) {
        searchOutput = latestMessage.result.output;
      }
      return [
        { type: "text_delta", text: "The relevant repository files remain visible." },
        { type: "finish", reason: "stop" },
      ];
    });
    const session = new AgentSession({
      model,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      maximumOutputTokens: 4_096,
      store: createInMemorySessionStore(),
    });

    await expect(session.run({ text: "Find the relevant needle locations." })).resolves.toEqual({
      status: "completed",
      answer: "The relevant repository files remain visible.",
    });
    expect(searchOutput).toMatchObject({
      schemaVersion: 1,
      policyVersion: "search-repository.v1",
      kind: "content",
      query: "needle",
      currentContentMustBeReread: true,
      groups: expect.arrayContaining([
        expect.objectContaining({ path: "src/10-relevant.ts" }),
        expect.objectContaining({ path: "src/20-also-relevant.ts" }),
      ]),
    });
    const output = searchOutput as {
      readonly groups: readonly {
        readonly path: string;
        readonly matches: readonly unknown[];
      }[];
    };
    expect(output.groups.flatMap((group) => group.matches)).toHaveLength(9);
    expect(output.groups.find((group) => group.path === "src/00-noise.ts")?.matches).toHaveLength(
      5,
    );
    expect(Buffer.byteLength(JSON.stringify(searchOutput), "utf8")).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("repository search rejects an explicit hidden path before starting a child process", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-hidden-root-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(join(workspaceRoot, ".github"), { recursive: true });
  await writeFile(join(workspaceRoot, ".github", "private.txt"), "needle\n", "utf8");
  let spawned = 0;
  const adapter = createRepositorySearchToolAdapterForTesting({
    workspaceRoot,
    processObserver: {
      spawned() {
        spawned += 1;
      },
      closed() {},
    },
  });

  try {
    for (const input of [
      { kind: "content", query: "needle", path: ".github" },
      { kind: "path", query: "private", path: ".github" },
    ]) {
      const prepared = adapter.prepare(JSON.stringify(input));
      expect(prepared).toMatchObject({
        status: "failed",
        error: { code: "outside_workspace" },
      });
    }
    expect(spawned).toBe(0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search normalizes every same-line ripgrep submatch to character columns", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-columns-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "unicode.txt"), "界needle + needle\n", "utf8");
  const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot });

  try {
    const prepared = adapter.prepare(
      JSON.stringify({ kind: "content", query: "needle", case: "sensitive" }),
    );
    if (prepared.status !== "ready") {
      throw new TypeError("The repository search call was not prepared.");
    }
    const result = await prepared.execute({
      signal: new AbortController().signal,
      callId: "search-unicode-columns",
      toolName: "search_repository",
      sessionId: "search-unicode-columns-session",
      toolProfileDigest: "sha256:search-unicode-columns-profile",
    });

    expect(result).toMatchObject({
      status: "completed",
      output: {
        snapshotResultCount: 2,
        groups: [
          {
            path: "unicode.txt",
            matches: [{ column: 2 }, { column: 11 }],
          },
        ],
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search Git ranking never invokes repository-configured fsmonitor code", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-git-config-"));
  const workspaceRoot = join(testRoot, "workspace");
  const markerPath = join(testRoot, "fsmonitor-invoked");
  const monitorPath = join(testRoot, "fsmonitor.sh");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "candidate.txt"), "needle\n", "utf8");
  await writeFile(monitorPath, `#!/bin/sh\nprintf invoked > "${markerPath}"\n`, "utf8");
  await chmod(monitorPath, 0o700);
  execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "core.fsmonitor", monitorPath], { cwd: workspaceRoot });
  const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot });

  try {
    const prepared = adapter.prepare(JSON.stringify({ kind: "path", query: "candidate" }));
    if (prepared.status !== "ready") {
      throw new TypeError("The repository search call was not prepared.");
    }
    await prepared.execute({
      signal: new AbortController().signal,
      callId: "search-frozen-git-config",
      toolName: "search_repository",
      sessionId: "search-frozen-git-config-session",
      toolProfileDigest: "sha256:search-frozen-git-config-profile",
    });

    await expect(
      import("node:fs/promises").then(({ readFile }) => readFile(markerPath, "utf8")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search cancellation escalates TERM to KILL and settles only after child close", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-kill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const backendPath = join(testRoot, "ignore-term-rg.sh");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "candidate.txt"), "needle\n", "utf8");
  await writeFile(
    backendPath,
    "#!/bin/sh\ntrap '' TERM\nprintf 'candidate.txt\\000'\nwhile :; do :; done\n",
    "utf8",
  );
  await chmod(backendPath, 0o700);
  const controller = new AbortController();
  const cancellation = new Error("cancel repository search after one record");
  const signals: string[] = [];
  let closed = false;
  let settled = false;
  let settledAtClose: boolean | undefined;
  const adapterOptions = {
    workspaceRoot,
    rgPathOverrideForTesting: backendPath,
    processObserver: {
      spawned() {},
      recorded() {
        controller.abort(cancellation);
      },
      signalled(signal: string) {
        signals.push(signal);
      },
      closed() {
        settledAtClose = settled;
        closed = true;
      },
    },
  };
  const adapter = createRepositorySearchToolAdapterForTesting(adapterOptions);

  try {
    const prepared = adapter.prepare(JSON.stringify({ kind: "path", query: "candidate" }));
    if (prepared.status !== "ready") {
      throw new TypeError("The repository search call was not prepared.");
    }
    const execution = prepared.execute({
      signal: controller.signal,
      callId: "search-kill-after-term",
      toolName: "search_repository",
      sessionId: "search-kill-after-term-session",
      toolProfileDigest: "sha256:search-kill-after-term-profile",
    });
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await expect(execution).rejects.toBe(cancellation);
    expect({ signals, closed, settledAtClose }).toEqual({
      signals: ["SIGTERM", "SIGKILL"],
      closed: true,
      settledAtClose: false,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search parser failure escalates through the same TERM to KILL owner", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-parser-kill-"));
  const workspaceRoot = join(testRoot, "workspace");
  const backendPath = join(testRoot, "invalid-rg");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "candidate.txt"), "needle\n", "utf8");
  await writeFile(
    backendPath,
    "#!/usr/bin/env node\nconst { writeSync } = require('node:fs');\nprocess.on('SIGTERM', () => {});\nwriteSync(1, '{\\\"type\\\":\\\"match\\\"}\\n');\nsetInterval(() => {}, 1_000);\n",
    "utf8",
  );
  await chmod(backendPath, 0o700);
  const signals: string[] = [];
  let closed = false;
  const adapter = createRepositorySearchToolAdapterForTesting({
    workspaceRoot,
    rgPathOverrideForTesting: backendPath,
    processObserver: {
      spawned() {},
      signalled(signal) {
        signals.push(signal);
      },
      closed() {
        closed = true;
      },
    },
  });

  try {
    const result = await executeSearch(adapter, { kind: "content", query: "needle" });
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_io_failed",
        message: "The repository search backend returned invalid output.",
      },
    });
    expect({ signals, closed }).toEqual({ signals: ["SIGTERM", "SIGKILL"], closed: true });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search omits a content candidate changed after the backend begins reading it", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-changed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const candidatePath = join(workspaceRoot, "candidate.txt");
  const backendPath = join(testRoot, "scripted-rg.sh");
  await mkdir(workspaceRoot);
  await writeFile(candidatePath, "needle before\n", "utf8");
  const records = [
    { type: "begin", data: { path: { text: "candidate.txt" } } },
    {
      type: "match",
      data: {
        path: { text: "candidate.txt" },
        lines: { text: "needle before\n" },
        line_number: 1,
        absolute_offset: 0,
        submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
      },
    },
    { type: "end", data: {} },
    { type: "summary", data: {} },
  ];
  await writeFile(
    backendPath,
    `#!/bin/sh\nprintf '%s\\n' ${records.map((record) => `'${JSON.stringify(record)}'`).join(" ")}\n`,
    "utf8",
  );
  await chmod(backendPath, 0o700);
  let recordCount = 0;
  const adapter = createRepositorySearchToolAdapterForTesting({
    workspaceRoot,
    rgPathOverrideForTesting: backendPath,
    processObserver: {
      spawned() {},
      recorded() {
        recordCount += 1;
        if (recordCount === 1) {
          writeFileSync(candidatePath, "replacement after begin\n", "utf8");
        }
      },
      closed() {},
    },
  });

  try {
    const prepared = adapter.prepare(JSON.stringify({ kind: "content", query: "needle" }));
    if (prepared.status !== "ready") {
      throw new TypeError("The repository search call was not prepared.");
    }
    const result = await prepared.execute({
      signal: new AbortController().signal,
      callId: "search-changed-after-begin",
      toolName: "search_repository",
      sessionId: "search-changed-after-begin-session",
      toolProfileDigest: "sha256:search-changed-after-begin-profile",
    });

    expect(result).toMatchObject({
      status: "completed",
      output: {
        groups: [],
        omissions: [{ reason: "changed", path: "candidate.txt", count: 1 }],
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository path search omits a candidate changed after its backend record", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-path-changed-"));
  const workspaceRoot = join(testRoot, "workspace");
  const candidatePath = join(workspaceRoot, "candidate.txt");
  const backendPath = join(testRoot, "scripted-path-rg.sh");
  await mkdir(workspaceRoot);
  await writeFile(candidatePath, "before\n", "utf8");
  await writeFile(backendPath, "#!/bin/sh\nprintf 'candidate.txt\\000'\n", "utf8");
  await chmod(backendPath, 0o700);
  const adapter = createRepositorySearchToolAdapterForTesting({
    workspaceRoot,
    rgPathOverrideForTesting: backendPath,
    processObserver: {
      spawned() {},
      recorded() {
        writeFileSync(candidatePath, "after backend record\n", "utf8");
      },
      closed() {},
    },
  });

  try {
    const result = await executeSearch(adapter, { kind: "path", query: "candidate" });
    expect(result).toMatchObject({
      status: "completed",
      output: {
        entries: [],
        omissions: [{ reason: "changed", path: "candidate.txt", count: 1 }],
      },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search excludes ignored, hidden, binary, and symlink candidates", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-exclusions-"));
  const workspaceRoot = join(testRoot, "workspace");
  const sourceRoot = join(workspaceRoot, "src");

  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(workspaceRoot, "generated"));
    await mkdir(join(workspaceRoot, ".hidden"));
    await writeFile(join(workspaceRoot, ".gitignore"), "generated/\n", "utf8");
    await writeFile(join(sourceRoot, "visible-needle.ts"), "const value = 'needle';\n", "utf8");
    await writeFile(
      join(workspaceRoot, "generated", "ignored-needle.ts"),
      "const value = 'needle';\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, ".hidden", "secret-needle.ts"),
      "const value = 'needle';\n",
      "utf8",
    );
    await writeFile(join(sourceRoot, "binary-needle.bin"), Buffer.from("needle\0private"));
    const externalPath = join(testRoot, "external-needle.ts");
    await writeFile(externalPath, "const value = 'needle';\n", "utf8");
    await symlink(externalPath, join(sourceRoot, "external-needle.ts"));
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot });

    const pathResult = await executeSearch(adapter, { kind: "path", query: "needle" });
    const contentResult = await executeSearch(adapter, { kind: "content", query: "needle" });

    expect(pathResult).toMatchObject({
      status: "completed",
      output: {
        entries: [{ path: "src/visible-needle.ts" }],
        omissions: [{ reason: "binary", path: "src/binary-needle.bin", count: 1 }],
      },
    });
    expect(contentResult).toMatchObject({
      status: "completed",
      output: { groups: [{ path: "src/visible-needle.ts" }] },
    });
    expect(JSON.stringify([pathResult, contentResult])).not.toMatch(
      /ignored-needle|secret-needle|external-needle/u,
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search rejects an explicit symlink path before execution", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-explicit-symlink-"));
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const externalPath = join(testRoot, "external.txt");
  await writeFile(externalPath, "private needle\n", "utf8");
  await symlink(externalPath, join(workspaceRoot, "linked.txt"));

  try {
    await expect(
      executeSearch(createRepositorySearchToolAdapterForTesting({ workspaceRoot }), {
        kind: "content",
        query: "needle",
        path: "linked.txt",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "outside_workspace" },
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("repository search resolves the pinned absolute application-local Linux backend", () => {
  const backend = repositorySearchBackendForTesting();
  const version = execFileSync(backend.rgPath, ["--version"], { encoding: "utf8" });

  expect({ absolute: isAbsolute(backend.rgPath), version: version.split("\n")[0] }).toEqual({
    absolute: true,
    version: "ripgrep 15.0.0 (rev 3a612f88b8)",
  });
});

test("large-tree search cancellation closes ripgrep before durable AgentSession cancellation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-large-tree-cancel-"));
  const controller = new AbortController();
  let records = 0;
  let closed = false;
  let providerCalls = 0;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
    await mkdir(join(workspaceRoot, "large"));
    await Promise.all(
      Array.from({ length: 1024 }, (_value, index) =>
        writeFile(join(workspaceRoot, "large", `${index}.txt`), "bounded candidate\n"),
      ),
    );
    const backend = repositorySearchBackendForTesting();
    const store = await createJsonlSessionStore({
      workspaceRoot,
      stateRoot: join(workspaceRoot, ".state"),
      sessionId: "123e4567-e89b-42d3-a456-426614174099",
    });
    const session = new AgentSession({
      model: new FakeModelDriver(() => {
        providerCalls += 1;
        return [
          { type: "tool_call_start", id: "large-search", name: "search_repository" },
          {
            type: "tool_call_delta",
            id: "large-search",
            json: '{"kind":"path","mode":"glob","query":"*"}',
          },
          { type: "tool_call_end", id: "large-search" },
          { type: "finish", reason: "tool_calls" },
        ];
      }),
      tools: createCodingToolRegistryForTesting({
        workspaceRoot,
        repositorySearchBackend: backend.create({
          rgExecutablePath: backend.rgPath,
          processObserver: {
            spawned() {},
            recorded() {
              if (++records === 32) controller.abort();
            },
            closed() {
              closed = true;
            },
          },
        }),
      }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      maximumOutputTokens: 4096,
      store,
    });
    session.subscribe((event) => {
      if (event.type === "session_settled") expect(closed).toBe(true);
    });
    await expect(
      session.run({ text: "Search large tree" }, { signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(closed).toBe(true);
    expect(providerCalls).toBe(1);
    const durable = await store.read();
    expect(durable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "tool_failed", name: "search_repository" }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "session_settled",
            result: expect.objectContaining({ status: "cancelled" }),
          }),
        }),
      ]),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("repository search aborts candidate probing after the first opened file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-search-probe-cancel-"));
  const controller = new AbortController();
  const cancellation = new Error("Cancel during candidate open");
  let opened = 0;
  try {
    await writeFile(join(workspaceRoot, "a.txt"), "first\n");
    await writeFile(join(workspaceRoot, "b.txt"), "second\n");
    const adapter = createRepositorySearchToolAdapterForTesting({
      workspaceRoot,
      probeFileSystemForTesting: {
        lstat,
        async open(path, flags, mode) {
          const handle = await open(path, flags, mode);
          opened += 1;
          controller.abort(cancellation);
          return handle;
        },
      },
    });
    await expect(
      executeSearch(adapter, { kind: "path", mode: "glob", query: "*" }, controller.signal),
    ).rejects.toBe(cancellation);
    expect(opened).toBe(1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("repository search cancellation settles only after the owned ripgrep child closes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-search-cancel-close-"));
  const controller = new AbortController();
  const cancellation = new Error("cancel repository search");
  let childClosed = false;

  try {
    await writeFile(join(workspaceRoot, "search.txt"), "needle\n".repeat(10_000), "utf8");
    const adapter = createRepositorySearchToolAdapterForTesting({
      workspaceRoot,
      processObserver: {
        spawned() {
          controller.abort(cancellation);
        },
        closed() {
          childClosed = true;
        },
      },
    });

    await expect(
      executeSearch(adapter, { kind: "content", query: "needle" }, controller.signal),
    ).rejects.toBe(cancellation);
    expect(childClosed).toBe(true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function executeSearch(
  adapter: ReturnType<typeof createRepositorySearchToolAdapterForTesting>,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal = new AbortController().signal,
) {
  const prepared = adapter.prepare(JSON.stringify(input));
  if (prepared.status !== "ready") {
    return prepared;
  }
  return prepared.execute({
    signal,
    callId: "repository-search-os-contract",
    toolName: "search_repository",
    sessionId: "repository-search-os-contract-session",
    toolProfileDigest: "sha256:repository-search-os-contract-profile",
  });
}
