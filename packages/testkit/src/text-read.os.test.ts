import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  type ModelEvent,
  type ModelRequest,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import {
  createSessionLifecycleForTests as createSessionLifecycle,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test("read_file reaches a bounded line range after 64 KiB through durable model feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-text-range-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const prefix = Array.from(
    { length: 3500 },
    (_, index) => `prefix-${index} ${"x".repeat(24)}\n`,
  ).join("");
  expect(Buffer.byteLength(prefix)).toBeGreaterThan(65536);
  await writeFile(
    join(workspaceRoot, "large.txt"),
    `${prefix}TARGET_AFTER_PREFIX\n最后证据🌱\nEnd of evidence.\n`,
  );
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    return requests.length === 1
      ? [
          { type: "tool_call_start", id: "range-read", name: "read_file" },
          {
            type: "tool_call_delta",
            id: "range-read",
            json: JSON.stringify({ path: "large.txt", startLine: 3501, maxLines: 2 }),
          },
          { type: "tool_call_end", id: "range-read" },
          { type: "finish", reason: "tool_calls" },
        ]
      : [
          { type: "text_delta", text: "The requested evidence was inspected." },
          { type: "finish", reason: "stop" },
        ];
  });
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read exactly the two evidence lines after the large prefix." },
    });
    expect(requests[1]?.messages.findLast((message) => message.role === "tool")).toMatchObject({
      result: {
        status: "completed",
        output: { content: "TARGET_AFTER_PREFIX\n最后证据🌱\n", truncated: true },
      },
    });
    const records = await (
      await openJsonlSessionStore<SessionRecord>({
        workspaceRoot,
        stateRoot,
        sessionId: created.sessionId,
      })
    ).read();
    expect(
      records.find(
        (entry) =>
          entry.schemaVersion === 3 &&
          entry.record.type === "runtime_event" &&
          entry.record.event.type === "tool_completed",
      ),
    ).toMatchObject({
      record: {
        event: { callId: "range-read", output: { content: "TARGET_AFTER_PREFIX\n最后证据🌱\n" } },
      },
    });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file continues a long Unicode line without gaps and rejects a changed continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-text-pages-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const content = `\uFEFF${"🌱\u0001汉\uFEFF".repeat(10000)}\nFinal evidence.\n`;
  await writeFile(join(workspaceRoot, "unicode.txt"), content);
  const pages: {
    content: string;
    nextRead: Record<string, unknown> | null;
    byteRange: { start: number; endExclusive: number };
    reason: string;
  }[] = [];
  let staleCursor: Record<string, unknown> | undefined;
  let changeRequested = false;
  const driver = new FakeModelDriver((request) => {
    const latest = request.messages.at(-1);
    if (latest?.role === "user") return readCall("page-0", { path: "unicode.txt", maxLines: 2 });
    if (latest?.role !== "tool") throw new Error("Expected tool feedback");
    if (changeRequested) {
      expect(latest.result).toMatchObject({
        status: "failed",
        error: { code: "invalid_tool_input", message: expect.stringContaining("file changed") },
      });
      return [
        { type: "text_delta", text: "Changed continuation rejected." },
        { type: "finish", reason: "stop" },
      ];
    }
    expect(latest.result.status).toBe("completed");
    if (latest.result.status !== "completed") throw new Error("Expected page");
    expect(Buffer.byteLength(JSON.stringify(latest.result.output))).toBeLessThanOrEqual(65536);
    const page = latest.result.output as unknown as (typeof pages)[number];
    expect(page.byteRange.start).toBe(pages.at(-1)?.byteRange.endExclusive ?? 0);
    pages.push(page);
    if (page.nextRead !== null) {
      staleCursor ??= page.nextRead;
      if (pages.length > 5) throw new Error("Unexpected pagination loop");
      return readCall(`page-${pages.length}`, page.nextRead);
    }
    expect(pages.map((entry) => entry.content).join("")).toBe(content);
    expect(page.byteRange.endExclusive).toBe(Buffer.byteLength(content));
    expect(page.reason).toBe("eof");
    changeRequested = true;
    // This is the external file producer, between two completed model requests.
    writeFileSync(join(workspaceRoot, "unicode.txt"), content.replace("Final", "Other"));
    return readCall("stale-page", staleCursor);
  });
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    const result = await lifecycle.continue({
      sessionId: created.sessionId,
      input: { text: "Read the Unicode file in bounded pages." },
    });
    expect(result.result).toMatchObject({
      status: "completed",
      answer: "Changed continuation rejected.",
    });
    expect(pages.length).toBeGreaterThan(1);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

function readCall(id: string, input: unknown): ModelEvent[] {
  return [
    { type: "tool_call_start", id, name: "read_file" },
    { type: "tool_call_delta", id, json: JSON.stringify(input) },
    { type: "tool_call_end", id },
    { type: "finish", reason: "tool_calls" },
  ];
}

test("an interrupted frozen read_file definition resumes its original exact result and Plan identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-text-legacy-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "legacy.txt"), "Historical evidence.\n");
  const currentTools = createCodingToolRegistry({ workspaceRoot });
  const legacyRead = currentTools.resolve("read_file")?.retainedVersions?.[0];
  if (legacyRead === undefined) throw new Error("Expected retained read adapter");
  expect(legacyRead.definition).toEqual({
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
  });
  const oldTools = {
    definitions: () =>
      currentTools
        .definitions()
        .filter((entry) => entry.name !== "update_todos")
        .map((entry) => (entry.name === "read_file" ? legacyRead.definition : entry)),
    resolve: (name: string) =>
      name === "read_file"
        ? legacyRead
        : name === "update_todos"
          ? undefined
          : currentTools.resolve(name),
  };
  const requests: ModelRequest[] = [];
  const driver = new FakeModelDriver((request) => {
    requests.push(request);
    if (request.messages.at(-1)?.role === "user")
      return readCall("legacy-read", { path: "legacy.txt" });
    expect(request.tools?.find((entry) => entry.name === "read_file")).toEqual(
      legacyRead.definition,
    );
    expect(request.messages.findLast((message) => message.role === "tool")).toMatchObject({
      result: {
        status: "completed",
        output: { path: "legacy.txt", content: "Historical evidence.\n", truncated: false },
      },
    });
    const result = request.messages.findLast((message) => message.role === "tool");
    if (result?.role === "tool" && result.result.status === "completed")
      expect(Object.keys(result.result.output as object)).toEqual(["path", "content", "truncated"]);
    return [
      { type: "text_delta", text: "Historical result preserved." },
      { type: "finish", reason: "stop" },
    ];
  });
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(driver),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  const initial = createSessionLifecycle({ ...options, tools: oldTools });
  let restored: ReturnType<typeof createSessionLifecycle> | undefined;
  try {
    const created = await initial.create({ targetIdentity });
    await initial.enterPlan({ sessionId: created.sessionId });
    await initial.continue({
      sessionId: created.sessionId,
      input: { text: "Inspect historical evidence." },
    });
    await initial.close();
    const store = await openJsonlSessionStore<SessionRecord>({
      workspaceRoot,
      stateRoot,
      sessionId: created.sessionId,
    });
    const records = await store.read();
    const started = records.findIndex(
      (entry) =>
        entry.schemaVersion === 3 &&
        entry.record.type === "runtime_event" &&
        entry.record.event.type === "tool_started",
    );
    expect(started).toBeGreaterThan(0);
    const path = join(
      stateRoot,
      "projects",
      created.projectId.replace(/^sha256:/u, ""),
      "sessions",
      `${created.sessionId}.jsonl`,
    );
    await writeFile(
      path,
      `${records
        .slice(0, started + 1)
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    restored = createSessionLifecycle({ ...options, tools: currentTools });
    await expect(restored.resume({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "ready",
    });
    const continued = await restored.continue({ sessionId: created.sessionId });
    expect(continued.result).toEqual({
      status: "completed",
      answer: "Historical result preserved.",
    });
    expect(requests.at(-1)?.tools?.some((entry) => entry.name === "update_todos")).toBe(false);
    await expect(restored.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    await initial.close();
    await restored?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file bounds source scanning and reports a usable remaining line position", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-text-scan-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "scan.txt"),
    `${"x".repeat(8 * 1024 * 1024)}\nEvidence after bounded scan.\n`,
  );
  let requests = 0;
  const driver = new FakeModelDriver((request) => {
    requests++;
    if (requests === 1)
      return readCall("scan-first", { path: "scan.txt", startLine: 2, maxLines: 1 });
    const latest = request.messages.at(-1);
    if (latest?.role !== "tool" || latest.result.status !== "completed")
      throw new Error("Expected successful bounded scan feedback");
    if (requests === 2) {
      expect(latest.result.output).toMatchObject({
        content: "",
        reason: "scan_limit",
        truncated: true,
        lineRange: null,
        byteRange: { start: 8388608, endExclusive: 8388608 },
        nextRead: { byteOffset: 8388608, startLine: 2, maxLines: 1 },
      });
      return readCall("scan-next", (latest.result.output as { nextRead: unknown }).nextRead);
    }
    expect(latest.result.output).toMatchObject({
      content: "Evidence after bounded scan.\n",
      reason: "eof",
      truncated: false,
      nextRead: null,
    });
    return [
      { type: "text_delta", text: "Bounded scan resumed." },
      { type: "finish", reason: "stop" },
    ];
  });
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Locate the evidence line." },
      }),
    ).resolves.toMatchObject({ result: { status: "completed", answer: "Bounded scan resumed." } });
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file feedback screens invalid values and cancellation prevents a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-text-cancel-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "cancel.txt"), "Unconsumed evidence.");
  const controller = new AbortController();
  let requests = 0;
  const driver = new FakeModelDriver((request) => {
    requests++;
    if (requests === 1)
      return readCall("invalid", {
        path: "cancel.txt",
        maxLines: 0,
        PRIVATE_TOKEN_VALUE: "secret-that-must-not-appear",
      });
    const latest = request.messages.at(-1);
    expect(latest).toMatchObject({
      role: "tool",
      result: {
        status: "failed",
        error: {
          code: "invalid_tool_input",
          message: expect.stringContaining("maxLines: supply an integer from 1 to 2000"),
        },
      },
    });
    expect(JSON.stringify(latest)).not.toContain("secret-that-must-not-appear");
    expect(JSON.stringify(latest)).not.toContain("PRIVATE_TOKEN_VALUE");
    return readCall("cancelled", { path: "cancel.txt" });
  });
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot: join(root, "state"),
    modelTargets: modelTargetsWithDriver(driver),
    tools: createCodingToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  });
  const events: RuntimeEvent[] = [];
  lifecycle.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_started" && event.callId === "cancelled") controller.abort();
  });
  try {
    const created = await lifecycle.create({ targetIdentity });
    await expect(
      lifecycle.continue({
        sessionId: created.sessionId,
        input: { text: "Check range feedback then cancel." },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ result: { status: "cancelled" } });
    expect(events.some((event) => event.type === "tool_completed")).toBe(false);
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    controller.abort();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
