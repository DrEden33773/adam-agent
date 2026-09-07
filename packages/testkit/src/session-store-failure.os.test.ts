import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  createCodingToolRegistry,
  createJsonlSessionStore,
  createPermissionPolicy,
  type SessionRecord,
  SessionStoreError,
} from "@adam-agent/agent";
import {
  openJsonlSessionStore,
  type SessionLogFileSystem,
  sessionLogFileSystem,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const firstRecord: SessionRecord = {
  schemaVersion: 3,
  sequence: 1,
  record: {
    type: "runtime_event",
    runId,
    event: { type: "user_message", text: "Keep the real write facts." },
  },
};
const secondRecord: SessionRecord = {
  schemaVersion: 3,
  sequence: 2,
  record: { type: "runtime_event", runId, event: { type: "model_message_started" } },
};

test.each(["write", "sync", "close"] as const)(
  "JSONL %s failure preserves known bytes and fences uncertainty without duplicate writes",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "adam-log-failure-stage-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let filePath = "";
    let injected = false;
    const fileSystem: SessionLogFileSystem = {
      async openAppend(path) {
        filePath = path;
        const file = await open(path, "a", 0o600);
        return {
          chmod: (mode) => file.chmod(mode),
          async writeFile(data, encoding) {
            if (stage === "write" && !injected) {
              injected = true;
              await file.writeFile(data.slice(0, Math.floor(data.length / 2)), encoding);
              throw Object.assign(new Error("private disk detail"), { code: "ENOSPC" });
            }
            await file.writeFile(data, encoding);
          },
          async sync() {
            if (stage === "sync" && !injected) {
              injected = true;
              throw Object.assign(new Error("private sync detail"), { code: "EIO" });
            }
            await file.sync();
          },
          async close() {
            await file.close();
            if (stage === "close" && !injected) {
              injected = true;
              throw Object.assign(new Error("private close detail"), { code: "EIO" });
            }
          },
        };
      },
    };
    const options = {
      workspaceRoot,
      stateRoot: join(root, "state"),
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
    };
    try {
      const store = await createJsonlSessionStore({
        ...options,
        [sessionLogFileSystem]: fileSystem,
      });
      await expect(store.append(firstRecord)).rejects.toMatchObject({
        code: "session_log_io_failed",
        appendFailure: {
          stage,
          category: stage === "close" ? "storage_io_failed" : "append_outcome_uncertain",
          writeOutcome: stage === "close" ? "committed" : "uncertain",
          reason: stage === "write" ? "storage_full" : "io_error",
        },
      });
      const bytes = await readFile(filePath);
      expect(bytes.byteLength).toBeGreaterThan(0);
      if (stage === "close") {
        await expect(store.append(firstRecord)).rejects.toMatchObject({
          code: "session_log_invalid",
          appendFailure: { category: "encoding_rejected", reason: "sequence_mismatch" },
        });
        expect(await readFile(filePath)).toEqual(bytes);
        await store.append(secondRecord);
        expect(await store.read()).toEqual([firstRecord, secondRecord]);
      } else {
        await expect(store.append(secondRecord)).rejects.toMatchObject({
          appendFailure: {
            category: "storage_io_failed",
            stage: "admission",
            writeOutcome: "not_written",
          },
        });
        expect(await readFile(filePath)).toEqual(bytes);
        if (stage === "write") {
          await expect(openJsonlSessionStore(options)).rejects.toMatchObject({
            code: "session_log_invalid",
          });
        } else {
          const reopened = await openJsonlSessionStore(options);
          expect(await reopened.read()).toEqual([firstRecord]);
          await reopened.append(secondRecord);
          expect(await reopened.read()).toEqual([firstRecord, secondRecord]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("known committed close failure advances the bare runtime cursor without repeating a terminal or tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-committed-runtime-fault-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  let failClose = true;
  const fileSystem: SessionLogFileSystem = {
    async openAppend(path) {
      const file = await open(path, "a", 0o600);
      let toolResult = false;
      return {
        chmod: (mode) => file.chmod(mode),
        async writeFile(data, encoding) {
          toolResult = data.includes('"type":"tool_failed"');
          await file.writeFile(data, encoding);
        },
        sync: () => file.sync(),
        async close() {
          await file.close();
          if (toolResult && failClose) {
            failClose = false;
            throw Object.assign(new Error("private committed close detail"), { code: "EIO" });
          }
        },
      };
    },
  };
  try {
    const store = await createJsonlSessionStore({
      workspaceRoot,
      stateRoot: join(root, "state"),
      sessionId: "123e4567-e89b-42d3-a456-426614174002",
      [sessionLogFileSystem]: fileSystem,
    });
    let modelCalls = 0;
    const callId = "呼".repeat(200);
    const model = new FakeModelDriver(() => {
      modelCalls += 1;
      return modelCalls === 1
        ? [
            { type: "tool_call_start", id: callId, name: "search_repository" },
            {
              type: "tool_call_delta",
              id: callId,
              json: '{"kind":"path","query":"private-argument-canary","cursor":"invalid"}',
            },
            { type: "tool_call_end", id: callId },
            { type: "finish", reason: "tool_calls" },
          ]
        : [
            { type: "text_delta", text: "Next run used a fresh sequence." },
            { type: "finish", reason: "stop" },
          ];
    });
    const session = new AgentSession({
      model,
      store,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      maximumOutputTokens: 4096,
    });
    const failed = await session.run({ text: "Search once." });
    expect(failed).toMatchObject({
      status: "failed",
      executionFailure: {
        category: "storage_io_failed",
        stage: "close",
        phase: "tool_result",
        writeOutcome: "committed",
        sessionId: null,
        callId,
        message: "Session record was saved, but storage cleanup failed.",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("private-");
    const before = await store.read();
    expect(before.at(-1)).toMatchObject({
      record: { type: "runtime_event", event: { type: "tool_failed", callId } },
    });
    expect(modelCalls).toBe(1);
    await expect(session.run({ text: "Start the next explicit run." })).resolves.toEqual({
      status: "completed",
      answer: "Next run used a fresh sequence.",
    });
    const after = await store.read();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toMatchObject({
      sequence: before.length + 1,
      record: {
        type: "runtime_event",
        event: { type: "user_message", text: "Start the next explicit run." },
      },
    });
    expect(after.at(-1)).toMatchObject({
      record: {
        type: "runtime_event",
        event: { type: "session_settled", result: { status: "completed" } },
      },
    });
    expect(modelCalls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONL warm reads detect rewritten prefixes, gaps and partial tails", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-warm-log-"));
  const stateRoot = join(testRoot, "state");
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const store = await createJsonlSessionStore({ stateRoot, workspaceRoot, sessionId: "warm-log" });
  const record: SessionRecord = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    event: { type: "user_message", text: "before" },
  };
  try {
    await store.append(record);
    expect(await store.read()).toEqual([record]);
    const relative = (await readdir(stateRoot, { recursive: true })).find((path) =>
      path.endsWith(".jsonl"),
    );
    if (relative === undefined) throw new Error("Missing session log.");
    const path = join(stateRoot, relative);
    const replacement = { ...record, event: { type: "user_message", text: "after!" } };
    const prefix = `${JSON.stringify(replacement)}\n`;
    await writeFile(path, prefix);
    expect(await store.read()).toEqual([replacement]);
    const second = { ...record, sequence: 2 };
    await writeFile(path, `${prefix}${JSON.stringify(second)}\n`);
    expect(await store.read()).toEqual([replacement, second]);
    await writeFile(path, `${prefix}${JSON.stringify({ ...second, sequence: 3 })}\n`);
    await expect(store.read()).rejects.toBeInstanceOf(SessionStoreError);
    await writeFile(path, `${prefix}{`);
    await expect(store.read()).rejects.toBeInstanceOf(SessionStoreError);
    await writeFile(path, prefix);
    expect(await store.read()).toEqual([replacement]);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
