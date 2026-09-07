import { execFileSync, spawnSync } from "node:child_process";
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
  createPresentationSession,
} from "@adam-agent/agent";
import {
  createCodingToolRegistryForTesting,
  createRepositorySearchToolAdapterForTesting,
  openJsonlSessionStore,
  repositorySearchBackendForTesting,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { createInMemorySessionLifecycleHarness, FakeModelDriver } from "./index.js";
import { requireSessionEvent } from "./session-event.test-support.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity,
} from "./session-lifecycle.test-support.js";

test("wide search returns every bounded page and leaves Main ready after JSONL restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-page-feedback-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      writeFile(
        join(workspaceRoot, `file-${String(index).padStart(3, "0")}.ts`),
        `export const extension${index} = true;\n`,
      ),
    ),
  );
  const pages: Array<{
    resultCount: number;
    snapshotResultCount: number;
    remainingResultCount: number;
    pageIndex: number;
    groups: Array<{ path: string; matches: unknown[] }>;
    omissions: Array<{ reason: string; path: string; count: number }>;
    nextCursor?: string;
  }> = [];
  let feedback: unknown;
  const driver = new FakeModelDriver((request) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      feedback ??= last.result;
      if (last.result.status === "completed")
        pages.push(last.result.output as (typeof pages)[number]);
    }
    const cursor = pages.at(-1)?.nextCursor;
    if (
      last?.role === "user" ||
      (last?.role === "tool" && last.result.status === "completed" && cursor !== undefined)
    ) {
      const id = `wide-search-${pages.length}`;
      return [
        { type: "tool_call_start", id, name: "search_repository" },
        {
          type: "tool_call_delta",
          id,
          json: JSON.stringify({
            kind: "content",
            query: "extension",
            mode: "literal",
            case: "insensitive",
            include: ["*.ts"],
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        },
        { type: "tool_call_end", id },
        { type: "finish", reason: "tool_calls" },
      ];
    }
    return [
      { type: "text_delta", text: "Wide search completed." },
      { type: "finish", reason: "stop" },
    ];
  });
  const modelTargets = modelTargetsWithDriver(driver);
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  const lifecycle = createSessionLifecycleForTests(options);
  let cold: ReturnType<typeof createSessionLifecycleForTests> | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    const continued = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Find all extensions." },
    });
    const store = await openJsonlSessionStore<SessionRecord>({
      workspaceRoot,
      stateRoot,
      sessionId: created.sessionId,
    });
    const records = await store.read();
    const presentation = await createPresentationSession({
      ...options,
      lifecycle,
      sessionId: created.sessionId,
      projectLabel: "workspace",
    });
    const phase = presentation.getState().authoritative.active?.parentRun?.phase;
    await presentation.close();
    const lastRecord = records.at(-1);
    expect({
      result: continued.result,
      snapshotStatus: continued.snapshot.status,
      phase,
      lastRecord: lastRecord?.schemaVersion === 3 ? lastRecord.record : undefined,
    }).toMatchObject({
      result: { status: "completed", answer: "Wide search completed." },
      snapshotStatus: "settled",
      phase: "ready",
      lastRecord: { type: "runtime_event", event: { type: "session_settled" } },
    });
    expect(feedback).toMatchObject({
      status: "completed",
      output: { resultCount: 50, snapshotResultCount: 300 },
    });
    expect(pages).toHaveLength(6);
    for (const [index, page] of pages.entries()) {
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(page).toMatchObject({
        pageIndex: index,
        resultCount: 50,
        snapshotResultCount: 300,
        remainingResultCount: 250 - index * 50,
      });
      expect(page.groups.every((group) => group.matches.length === 1)).toBe(true);
      expect(page.omissions).toEqual(
        index === 5 ? [] : [{ reason: "page_limit", path: ".", count: 250 - index * 50 }],
      );
    }
    expect(pages.flatMap((page) => page.groups.map((group) => group.path))).toEqual(
      Array.from({ length: 300 }, (_, index) => `file-${String(index).padStart(3, "0")}.ts`),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "runtime_event",
          event: expect.objectContaining({ type: "tool_completed", callId: "wide-search-0" }),
        }),
      }),
    );
    await lifecycle.close();
    cold = createSessionLifecycleForTests(options);
    await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    await cold?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real invalid and restarted search cursors settle and reach the model through the current store", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-cursor-feedback-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "one.ts"), "needle one\nneedle two\n");
  const harness = createInMemorySessionLifecycleHarness();
  let cursor: string | undefined;
  let restarted = false;
  const feedback: unknown[] = [];
  const driver = new FakeModelDriver((request) => {
    const last = request.messages.at(-1);
    let input: Record<string, unknown> | undefined;
    if (last?.role === "user") {
      input = { kind: "content", query: "needle", limit: 1, ...(restarted ? { cursor } : {}) };
    } else if (last?.role === "tool") {
      if (last.result.status === "completed") {
        const output = last.result.output as { nextCursor?: string };
        cursor = output.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        input = { kind: "content", query: "changed", limit: 1, cursor };
      } else feedback.push(last.result);
    }
    if (input !== undefined)
      return [
        {
          type: "tool_call_start",
          id: `cursor-${restarted ? "cold" : cursor === undefined ? "first" : "invalid"}`,
          name: "search_repository",
        },
        {
          type: "tool_call_delta",
          id: `cursor-${restarted ? "cold" : cursor === undefined ? "first" : "invalid"}`,
          json: JSON.stringify(input),
        },
        {
          type: "tool_call_end",
          id: `cursor-${restarted ? "cold" : cursor === undefined ? "first" : "invalid"}`,
        },
        { type: "finish", reason: "tool_calls" },
      ];
    return [
      { type: "text_delta", text: "Cursor failure handled." },
      { type: "finish", reason: "stop" },
    ];
  });
  const options = {
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  let lifecycle = harness.createLifecycle(options);
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Try a changed request cursor." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Cursor failure handled." },
      snapshot: { status: "settled" },
    });
    expect(feedback).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "search_cursor_invalid" }),
      }),
    ]);
    await lifecycle.close();
    restarted = true;
    lifecycle = harness.createLifecycle(options);
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Try the cursor after runtime restart." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Cursor failure handled." },
      snapshot: { status: "settled" },
    });
    expect(feedback[1]).toMatchObject({ status: "failed", error: { code: "search_cursor_stale" } });
    const records = await (await harness.sessions.open(created.sessionId))?.read();
    const events = records?.flatMap((entry) =>
      entry.schemaVersion === 3 && entry.record.type === "runtime_event"
        ? [entry.record.event]
        : [],
    );
    expect(events?.filter((event) => event.type === "tool_failed")).toMatchObject([
      { callId: "cursor-invalid", error: { code: "search_cursor_invalid" } },
      { callId: "cursor-cold", error: { code: "search_cursor_stale" } },
    ]);
    expect(events?.filter((event) => event.type === "session_settled")).toMatchObject([
      { result: { status: "completed" } },
      { result: { status: "completed" } },
    ]);
    await lifecycle.close();
    lifecycle = harness.createLifecycle(options);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    expect(durable.map(requireSessionEvent)).toEqual(
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

test.each(["path", "content"] as const)(
  "%s pages budget long queries, paths, and context inside the complete envelope",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "adam-search-envelope-"));
    const folder = "directory-".repeat(15);
    await mkdir(join(root, folder));
    const expected = Array.from(
      { length: 60 },
      (_, index) => `${folder}/file-${String(index).padStart(3, "0")}-${"name".repeat(25)}.ts`,
    );
    try {
      await Promise.all(
        expected.map((path) =>
          writeFile(
            join(root, path),
            `${"before".repeat(70)}\nneedle match\n${"after".repeat(80)}\n`,
          ),
        ),
      );
      const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
      const input =
        kind === "path"
          ? {
              kind,
              mode: "glob",
              query: `{${Array.from({ length: 1800 }, () => "*").join(",")}}`,
              limit: 50,
            }
          : { kind, mode: "regex", query: `needle|${"界".repeat(3000)}`, context: 1, limit: 50 };
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await executeSearchPage(adapter, {
          ...input,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(result).toMatchObject({ status: "completed" });
        if (result.status !== "completed") throw new Error(result.error.message);
        expect(adapter.outputSchema.safeParse(result.output).success).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(
          16 * 1024,
        );
        const page = result.output as {
          entries?: Array<{ path: string }>;
          groups?: Array<{ path: string }>;
          nextCursor?: string;
          remainingResultCount: number;
        };
        paths.push(...(page.entries ?? page.groups ?? []).map((entry) => entry.path));
        expect(page.remainingResultCount).toBe(60 - paths.length);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(paths).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("dense content pages preserve per-file remainder and every normalized match", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-dense-pages-"));
  try {
    await writeFile(
      join(root, "a.ts"),
      Array.from({ length: 26 }, (_, index) => `needle a${index}\n`).join(""),
    );
    await writeFile(
      join(root, "b.ts"),
      Array.from({ length: 11 }, (_, index) => `needle b${index}\n`).join(""),
    );
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    const seen: string[] = [];
    const counts = new Map([
      ["a.ts", 0],
      ["b.ts", 0],
    ]);
    let cursor: string | undefined;
    do {
      const result = await executeSearchPage(adapter, {
        kind: "content",
        query: "needle",
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result).toMatchObject({ status: "completed" });
      if (result.status !== "completed") throw new Error(result.error.message);
      const page = result.output as {
        groups: Array<{ path: string; matches: Array<{ line: number }> }>;
        omissions: Array<{ path: string; count: number }>;
        nextCursor?: string;
        remainingResultCount: number;
      };
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(16 * 1024);
      for (const group of page.groups) {
        expect(group.matches.length).toBeLessThanOrEqual(5);
        counts.set(group.path, (counts.get(group.path) ?? 0) + group.matches.length);
        seen.push(...group.matches.map((match) => `${group.path}:${match.line}`));
        const remaining = (group.path === "a.ts" ? 26 : 11) - (counts.get(group.path) ?? 0);
        if (remaining > 0)
          expect(page.omissions).toContainEqual(
            expect.objectContaining({ path: group.path, count: remaining }),
          );
      }
      expect(page.remainingResultCount).toBe(37 - seen.length);
      expect(page.omissions.reduce((total, omission) => total + omission.count, 0)).toBe(
        page.remainingResultCount,
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen.length).toBe(37);
    expect(new Set(seen)).toEqual(
      new Set([
        ...Array.from({ length: 26 }, (_, index) => `a.ts:${index + 1}`),
        ...Array.from({ length: 11 }, (_, index) => `b.ts:${index + 1}`),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("many binary probe omissions retain an exact bounded aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-probe-accounting-"));
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(3, "0")}-${"binary".repeat(20)}.ts`),
          Buffer.from([0, 65, 66]),
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        writeFile(join(root, `file-text-${String(index).padStart(3, "0")}.ts`), "ordinary text\n"),
      ),
    );
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    const result = await executeSearchPage(adapter, { kind: "path", query: "file", limit: 50 });
    expect(result).toMatchObject({
      status: "completed",
      output: {
        resultCount: 50,
        snapshotResultCount: 60,
        remainingResultCount: 10,
        omissions: [
          { reason: "binary", path: ".", count: 300 },
          { reason: "page_limit", path: ".", count: 10 },
        ],
      },
    });
    if (result.status !== "completed") throw new Error(result.error.message);
    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(16 * 1024);
    const first = result.output as { nextCursor: string };
    await writeFile(join(root, "file-extra.ts"), "created after snapshot\n");
    const second = await executeSearchPage(adapter, {
      kind: "path",
      query: "file",
      limit: 50,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      status: "completed",
      output: {
        resultCount: 10,
        remainingResultCount: 0,
        omissions: [],
        entries: Array.from({ length: 10 }, (_, index) => ({
          path: `file-text-${String(index + 50).padStart(3, "0")}.ts`,
        })),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an impossible complete search envelope remains durable typed quota feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-impossible-envelope-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "large-context.ts"),
    [
      ...Array.from({ length: 3 }, () => "前".repeat(500)),
      "needle",
      ...Array.from({ length: 3 }, () => "後".repeat(500)),
    ].join("\n"),
  );
  const harness = createInMemorySessionLifecycleHarness();
  const driver = new FakeModelDriver((request) => {
    if (request.messages.at(-1)?.role === "user")
      return [
        { type: "tool_call_start", id: "quota-search", name: "search_repository" },
        {
          type: "tool_call_delta",
          id: "quota-search",
          json: JSON.stringify({
            kind: "content",
            mode: "regex",
            query: `needle|${"界".repeat(4000)}`,
            context: 3,
          }),
        },
        { type: "tool_call_end", id: "quota-search" },
        { type: "finish", reason: "tool_calls" },
      ];
    expect(request.messages.at(-1)).toMatchObject({
      role: "tool",
      result: { status: "failed", error: { code: "search_quota_exceeded" } },
    });
    return [
      { type: "text_delta", text: "Narrow the context or query." },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = harness.createLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Use this large query and context." },
      }),
    ).resolves.toMatchObject({
      result: { status: "completed", answer: "Narrow the context or query." },
      snapshot: { status: "settled" },
    });
    const records = await (await harness.sessions.open(created.sessionId))?.read();
    expect(records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "runtime_event",
          event: expect.objectContaining({
            type: "tool_failed",
            callId: "quota-search",
            error: expect.objectContaining({ code: "search_quota_exceeded" }),
          }),
        }),
      }),
    );
    expect(records?.at(-1)).toMatchObject({
      record: {
        type: "runtime_event",
        event: { type: "session_settled", result: { status: "completed" } },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function executeSearchPage(
  adapter: ReturnType<typeof createRepositorySearchToolAdapterForTesting>,
  input: Record<string, unknown>,
) {
  const prepared = adapter.prepare(JSON.stringify(input));
  if (prepared.status !== "ready") return prepared;
  return prepared.execute({
    signal: new AbortController().signal,
    callId: "search-page",
    toolName: "search_repository",
    sessionId: "search-page-session",
    toolProfileDigest: "sha256:search-page-profile",
  });
}

test.each(["界", "😀", "a😀"])(
  "search output schema counts Unicode characters consistently for matches and context: %s",
  async (unit) => {
    const root = await mkdtemp(join(tmpdir(), "adam-search-unicode-schema-"));
    try {
      await writeFile(
        join(root, "unicode.ts"),
        `${unit.repeat(600)}\nneedle${unit.repeat(600)}\n${unit.repeat(600)}\n`,
      );
      const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
      const result = await executeSearchPage(adapter, {
        kind: "content",
        query: "needle",
        context: 1,
      });
      expect(result).toMatchObject({ status: "completed" });
      if (result.status !== "completed") throw new Error(result.error.message);
      const parsed = adapter.outputSchema.safeParse(result.output);
      expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
      const output = result.output as {
        groups: Array<{
          matches: Array<{
            snippet: string;
            contextBefore: Array<{ snippet: string }>;
            contextAfter: Array<{ snippet: string }>;
          }>;
        }>;
      };
      const match = output.groups[0]?.matches[0];
      expect(match).toBeDefined();
      if (match === undefined) throw new Error("Expected the Unicode match.");
      for (const snippet of [
        match.snippet,
        ...match.contextBefore.map((line) => line.snippet),
        ...match.contextAfter.map((line) => line.snippet),
      ]) {
        expect(Array.from(snippet)).toHaveLength(500);
        expect(snippet.isWellFormed()).toBe(true);
      }
      expect(match.snippet.startsWith("needle")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["work", "raw"] as const)(
  "Git %s-budget rejection stays in the search Promise after process close",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "adam-search-git-work-"));
    const bin = join(root, "bin");
    const workspaceRoot = join(root, "workspace");
    await mkdir(bin);
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "needle.ts"), "needle\n");
    const git = join(bin, "git");
    const program =
      kind === "work"
        ? "process.stdout.write(' M needle.ts\\0'.repeat(200001));"
        : "const chunk=Buffer.alloc(8*1024*1024,65); let writes=0; function send(){if(writes++<9)process.stdout.write(chunk,send);} send();";
    await writeFile(git, `#!${process.execPath}\n${program}\n`);
    await chmod(git, 0o700);
    try {
      const moduleUrl = new URL("../../agent/dist/internal-testing.js", import.meta.url).href;
      const script = `import { createRepositorySearchToolAdapterForTesting } from ${JSON.stringify(moduleUrl)};
      let gitClosed = false;
      const adapter = createRepositorySearchToolAdapterForTesting({workspaceRoot: ${JSON.stringify(workspaceRoot)}, processObserver: {spawned(){},closed(){},gitClosed(){gitClosed=true;}}});
      const prepared = adapter.prepare(JSON.stringify({kind:'path',query:'needle'}));
      if(prepared.status !== 'ready') throw new Error('Not prepared');
      try {
        const result = await prepared.execute({signal:new AbortController().signal,callId:'git-work',toolName:'search_repository',sessionId:'git-work',toolProfileDigest:'sha256:git-work'});
        process.stdout.write(JSON.stringify({settled: true, gitClosed, result}));
      } catch (error) { process.stdout.write(JSON.stringify({caught: true, message: String(error)})); }
    `;
      const { PATH: inheritedPath } = process.env;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PATH: `${bin}:${inheritedPath ?? ""}` },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect({
        status: result.status,
        signal: result.signal,
        error: result.error,
        stderr: result.stderr,
      }).toEqual({ status: 0, signal: null, error: undefined, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        settled: true,
        gitClosed: true,
        result: { status: "failed", error: { code: "search_quota_exceeded" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("positive globs and explicit paths preserve the ordinary discovery boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-discovery-boundary-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  try {
    for (const directory of ["ignored", "localignored", "nested", "folder.ts", ".secret"])
      await mkdir(join(workspaceRoot, directory));
    await writeFile(join(workspaceRoot, ".gitignore"), "ignored/\n");
    await writeFile(join(workspaceRoot, ".ignore"), "localignored/\n");
    await writeFile(join(workspaceRoot, ".rgignore"), "extra.ts\n");
    for (const path of [
      "normal.ts",
      "nested/keep.ts",
      "folder.ts/keep.txt",
      "text.txt",
      "ignored/private.ts",
      "localignored/private.ts",
      "extra.ts",
      ".hidden.ts",
      ".secret/private.ts",
    ])
      await writeFile(join(workspaceRoot, path), "needle\n");
    await writeFile(join(workspaceRoot, "binary.ts"), "needle\0binary");
    await writeFile(join(root, "outside.ts"), "needle\n");
    await symlink(join(root, "outside.ts"), join(workspaceRoot, "linked.ts"));
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot });
    const all = ["folder.ts/keep.txt", "nested/keep.ts", "normal.ts", "text.txt"];
    const cases = [
      [{ kind: "path", mode: "glob", query: "*" }, all],
      [{ kind: "path", mode: "glob", query: "*.ts" }, ["nested/keep.ts", "normal.ts"]],
      [
        { kind: "path", mode: "fuzzy", query: "ts" },
        ["folder.ts/keep.txt", "nested/keep.ts", "normal.ts"],
      ],
      [{ kind: "content", query: "needle", include: ["*.ts"] }, ["nested/keep.ts", "normal.ts"]],
      [
        {
          kind: "content",
          mode: "regex",
          query: "need(le)",
          include: ["*.ts"],
          exclude: ["nested/**"],
        },
        ["normal.ts"],
      ],
      [{ kind: "content", query: "needle", path: "ignored" }, []],
      [{ kind: "content", query: "needle", path: "ignored/private.ts" }, []],
      [{ kind: "path", mode: "glob", query: "*", path: "ignored/private.ts" }, []],
      [{ kind: "content", query: "needle", path: "nested/keep.ts" }, ["nested/keep.ts"]],
    ] as const;
    for (const [input, expected] of cases) {
      const result = await executeSearchPage(adapter, input);
      expect(result, JSON.stringify(input)).toMatchObject({ status: "completed" });
      if (result.status !== "completed") throw new Error(result.error.message);
      const output = result.output as {
        entries?: Array<{ path: string }>;
        groups?: Array<{ path: string }>;
      };
      expect(
        (output.entries ?? output.groups ?? []).map((entry) => entry.path).sort(),
        JSON.stringify(input),
      ).toEqual(expected);
    }
    await expect(
      executeSearchPage(adapter, {
        kind: "content",
        mode: "regex",
        query: "[",
        include: ["*.missing"],
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "tool_io_failed" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ranked and snapshot result ceilings retain exact independent omission counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-result-ceilings-"));
  try {
    await writeFile(
      join(root, "many.ts"),
      Array.from({ length: 20_000 }, (_, index) => `needle ${index + 1}\n`).join(""),
    );
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    const first = await executeSearchPage(adapter, { kind: "content", query: "needle", limit: 50 });
    expect(first).toMatchObject({
      status: "completed",
      output: {
        resultCount: 5,
        snapshotResultCount: 4096,
        remainingResultCount: 4091,
        omissions: [
          { reason: "ranked_candidate_limit", path: ".", count: 3616 },
          { reason: "snapshot_result_limit", path: ".", count: 12288 },
          { reason: "per_file_page_limit", path: "many.ts", count: 4091 },
        ],
      },
    });
    if (first.status !== "completed") throw new Error(first.error.message);
    const output = first.output as { nextCursor?: string };
    expect(output.nextCursor).toEqual(expect.any(String));
    const second = await executeSearchPage(adapter, {
      kind: "content",
      query: "needle",
      limit: 50,
      cursor: output.nextCursor,
    });
    expect(second).toMatchObject({
      status: "completed",
      output: {
        pageIndex: 1,
        groups: [
          {
            path: "many.ts",
            matches: [{ line: 6 }, { line: 7 }, { line: 8 }, { line: 9 }, { line: 10 }],
          },
        ],
        omissions: [{ reason: "per_file_page_limit", path: "many.ts", count: 4086 }],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot byte pressure evicts old cursors and oversized replacement leaves recent snapshots immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-snapshot-bytes-"));
  const file = join(root, "context.ts");
  const beforeContext = `${"前".repeat(500)}\n`.repeat(3);
  const afterContext = `${"後".repeat(500)}\n`.repeat(3);
  const block = `${beforeContext}needle\n${afterContext}`;
  try {
    await writeFile(file, block.repeat(350));
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    const cursors: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await executeSearchPage(adapter, {
        kind: "content",
        mode: "regex",
        query: `needle|unused${index}`,
        context: 3,
      });
      expect(result, `snapshot ${index}`).toMatchObject({
        status: "completed",
        output: { snapshotResultCount: 350 },
      });
      if (result.status !== "completed") throw new Error(result.error.message);
      const output = result.output as { nextCursor: string };
      cursors.push(output.nextCursor);
    }
    await expect(
      executeSearchPage(adapter, {
        kind: "content",
        mode: "regex",
        query: "needle|unused0",
        context: 3,
        cursor: cursors[0],
      }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "search_cursor_stale" } });
    const recentInput = {
      kind: "content",
      mode: "regex",
      query: "needle|unused5",
      context: 3,
      cursor: cursors[5],
    };
    const before = await executeSearchPage(adapter, recentInput);
    expect(before).toMatchObject({
      status: "completed",
      output: { pageIndex: 1, groups: [{ matches: [{ snippet: "needle" }] }] },
    });
    await writeFile(file, block.replace("needle", "changed needle").repeat(600));
    await expect(
      executeSearchPage(adapter, { kind: "content", query: "needle", context: 3 }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "search_quota_exceeded" } });
    expect(await executeSearchPage(adapter, recentInput)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Main search hits keep instructions inactive until an explicit search path selects their scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-instruction-scope-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "nested"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "nested", "AGENTS.md"),
    "Use two-space indentation. NESTED_SCOPE_SENTINEL\n",
  );
  await writeFile(join(workspaceRoot, "nested", "match.ts"), "needle\n");
  let explicit = false;
  const driver = new FakeModelDriver((request) => {
    const last = request.messages.at(-1);
    if (last?.role === "user")
      return [
        {
          type: "tool_call_start",
          id: explicit ? "scoped-search" : "root-search",
          name: "search_repository",
        },
        {
          type: "tool_call_delta",
          id: explicit ? "scoped-search" : "root-search",
          json: JSON.stringify({
            kind: "content",
            query: "needle",
            include: ["*.ts"],
            ...(explicit ? { path: "nested" } : {}),
          }),
        },
        { type: "tool_call_end", id: explicit ? "scoped-search" : "root-search" },
        { type: "finish", reason: "tool_calls" },
      ];
    expect(last).toMatchObject({
      role: "tool",
      result: { status: "completed", output: { groups: [{ path: "nested/match.ts" }] } },
    });
    expect(JSON.stringify(request.messages).includes("NESTED_SCOPE_SENTINEL")).toBe(explicit);
    return [
      { type: "text_delta", text: "Search scope respected." },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  try {
    const created = await lifecycle.create({ targetIdentity: sessionLifecycleTargetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Discover a matching file." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
    explicit = true;
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Search the nested directory explicitly." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed" } });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adjacent matching Unicode lines remain present in requested context", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-adjacent-context-"));
  try {
    await writeFile(join(root, "adjacent.ts"), "needle 😀 one\nneedle 😀 two\nneedle 😀 three\n");
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    const result = await executeSearchPage(adapter, {
      kind: "content",
      query: "needle",
      context: 1,
    });
    expect(result).toMatchObject({
      status: "completed",
      output: {
        groups: [
          {
            path: "adjacent.ts",
            matches: [
              {
                line: 1,
                snippet: "needle 😀 one",
                contextBefore: [],
                contextAfter: [{ line: 2, snippet: "needle 😀 two" }],
              },
              {
                line: 2,
                snippet: "needle 😀 two",
                contextBefore: [{ line: 1, snippet: "needle 😀 one" }],
                contextAfter: [{ line: 3, snippet: "needle 😀 three" }],
              },
              {
                line: 3,
                snippet: "needle 😀 three",
                contextBefore: [{ line: 2, snippet: "needle 😀 two" }],
                contextAfter: [],
              },
            ],
          },
        ],
      },
    });
    if (result.status !== "completed") throw new Error(result.error.message);
    expect(adapter.outputSchema.safeParse(result.output).success).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["content", "path"] as const)(
  "%s pagination admits a complete page whose first prefix cannot fit",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "adam-search-nonmonotonic-page-"));
    const folder = Array.from(
      { length: kind === "content" ? 10 : 18 },
      (_, index) => `${String(index).padStart(2, "0")}${"d".repeat(217)}`,
    ).join("/");
    const path = `${folder}/hit.ts`;
    try {
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(join(root, path), "needle\nneedle\n");
      if (kind === "path") await writeFile(join(root, "z.ts"), "needle\n");
      const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
      const input =
        kind === "content"
          ? { kind, mode: "regex", query: `needle|${"界".repeat(4000)}`, limit: 50 }
          : { kind, mode: "glob", query: `{**/hit.ts,z.ts,${"界".repeat(4000)}}`, limit: 50 };
      const result = await executeSearchPage(adapter, input);
      expect(result).toMatchObject({
        status: "completed",
        output: {
          resultCount: 2,
          snapshotResultCount: 2,
          remainingResultCount: 0,
          omissions: [],
          ...(kind === "content"
            ? { groups: [{ path, matches: [{ line: 1 }, { line: 2 }] }] }
            : { entries: [{ path }, { path: "z.ts" }] }),
        },
      });
      if (result.status !== "completed") throw new Error(result.error.message);
      expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(
        16 * 1024,
      );
      expect(adapter.outputSchema.safeParse(result.output).success).toBe(true);
      expect(result.output).not.toHaveProperty("nextCursor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native glob blank handling preserves a literal BOM and Unicode whitespace no-ops", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-glob-blank-"));
  try {
    await writeFile(join(root, "a.ts"), "needle\n");
    await writeFile(join(root, "\ufeff"), "needle\n");
    const adapter = createRepositorySearchToolAdapterForTesting({ workspaceRoot: root });
    for (const [query, expected] of [
      ["\ufeff", ["\ufeff"]],
      ["\u0085", ["a.ts", "\ufeff"]],
      [" ", ["a.ts", "\ufeff"]],
    ] as const) {
      const result = await executeSearchPage(adapter, { kind: "path", mode: "glob", query });
      expect(result).toMatchObject({
        status: "completed",
        output: { entries: expected.map((path) => ({ path, rankReason: "glob" })) },
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long admitted parent and file arguments keep every result across native batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-argument-batches-"));
  const expected = Array.from(
    { length: 300 },
    (_, index) => `${String(index).padStart(3, "0")}-${"d".repeat(215)}/hit.ts`,
  );
  let started = 0;
  let closed = 0;
  try {
    await Promise.all(
      expected.map(async (path) => {
        await mkdir(join(root, path.slice(0, path.lastIndexOf("/"))));
        await writeFile(join(root, path), "needle\n");
      }),
    );
    const adapter = createRepositorySearchToolAdapterForTesting({
      workspaceRoot: root,
      processObserver: {
        spawned() {
          started += 1;
        },
        closed() {
          closed += 1;
        },
      },
    });
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await executeSearchPage(adapter, {
        kind: "content",
        query: "needle",
        include: ["*.ts"],
        limit: 50,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result).toMatchObject({ status: "completed" });
      if (result.status !== "completed") throw new Error(result.error.message);
      expect(closed).toBe(started);
      expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(
        16 * 1024,
      );
      const page = result.output as {
        groups: Array<{ path: string }>;
        nextCursor?: string;
        remainingResultCount: number;
      };
      paths.push(...page.groups.map((group) => group.path));
      expect(page.remainingResultCount).toBe(300 - paths.length);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(paths).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
