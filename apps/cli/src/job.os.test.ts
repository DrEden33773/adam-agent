import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
type Frame = {
  version: number;
  sequence: number;
  type: string;
  value: {
    type?: unknown;
    requestId?: unknown;
    usage?: unknown;
    receipt?: unknown;
    text?: unknown;
    id?: unknown;
    startSequence?: unknown;
  } & Record<string, unknown>;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adam-job-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "This is the isolated job repository.\n");
  await writeFile(join(workspace, "demo.txt"), "before\n");
  return {
    root,
    workspace,
    config: {
      version: 1,
      prompt: "Update the demo file and verify it",
      target: "fake.local",
      stateRoot: join(root, "state"),
      configurationRoot: join(root, "config"),
      trustWorkspace: true,
      maxTurns: 12,
      timeoutMs: 30_000,
    },
  };
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  patch: Record<string, unknown> = {},
  respond: (frame: Frame, child: ChildProcessWithoutNullStreams) => void = approve,
  environment: NodeJS.ProcessEnv = {},
) {
  const config = join(f.root, "job.json");
  await writeFile(config, JSON.stringify({ ...f.config, ...patch }));
  const { PATH } = process.env;
  const child = spawn(process.execPath, [cli, "--job", config], {
    cwd: f.workspace,
    env: { PATH, HOME: f.root, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: Frame[] = [];
  let buffer = "";
  let stderr = "";
  let parseFailure: unknown;
  let processError: unknown;
  child.once("error", (error) => {
    processError = error;
  });
  let didClose = false;
  const closed = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("close", (code, signal) => {
      didClose = true;
      resolve([code, signal]);
    }),
  );
  let guard: ReturnType<typeof setTimeout> | undefined;
  const failed = new Promise<never>((_, reject) => {
    guard = setTimeout(
      () => reject(new Error("Job fixture did not produce process close.")),
      40_000,
    );
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        respond(frame, child);
      } catch (error) {
        parseFailure = error;
        child.kill("SIGTERM");
      }
      end = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    const [code, signal] = await Promise.race([closed, failed]);
    if (processError) throw processError;
    if (parseFailure) throw parseFailure;
    expect(buffer).toBe("");
    expect(signal).toBe(null);
    expect(frames.map((frame) => frame.sequence)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.filter((frame) => frame.type === "result")).toHaveLength(1);
    return { code, frames, final: frames.at(-1)?.value, stderr };
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    child.stdin.destroy();
    if (!didClose) {
      child.kill("SIGTERM");
      const killGuard = setTimeout(() => child.kill("SIGKILL"), 1_000);
      let closeGuard: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            closeGuard = setTimeout(
              () => reject(new Error("Job fixture process did not close after TERM/KILL.")),
              3_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(killGuard);
        if (closeGuard !== undefined) clearTimeout(closeGuard);
      }
    }
  }
}

function approve(frame: Frame, child: ChildProcessWithoutNullStreams) {
  if (frame.type === "event" && frame.value.type === "tool_permission_requested") {
    child.stdin.write(
      `${JSON.stringify({ type: "permission", requestId: frame.value.requestId, decision: "allow" })}\n`,
    );
  }
}

test("job uses real edits, exact permissions, shell verification and durable state from caller cwd", async () => {
  const f = await fixture();
  try {
    // Job startup must not load a project .env, unlike the ordinary interactive CLI.
    await mkdir(join(f.workspace, ".env"));
    const result = await run(f);
    expect(result.code, JSON.stringify(result.final)).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.final, JSON.stringify(result.final)).toMatchObject({
      result: { status: "completed" },
      closeStatus: "closed",
      stopReason: null,
      failure: null,
      usage: { unknownCalls: 4 },
    });
    expect(result.frames.filter((frame) => frame.type === "control_result")).toHaveLength(2);
    expect(await readFile(join(f.workspace, "demo.txt"), "utf8")).toBe("after\n");
    expect(result.frames.find((frame) => frame.type === "admitted")?.value).toMatchObject({
      sessionId: expect.any(String),
      runId: expect.any(String),
    });
    expect(await readdir(f.config.stateRoot)).not.toHaveLength(0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);

test("job keeps denial authoritative and exposes a configured turn limit", async () => {
  const f = await fixture();
  try {
    const result = await run(f, { maxTurns: 1 }, (frame, child) => {
      if (frame.type === "event" && frame.value.type === "tool_permission_requested") {
        child.stdin.write(
          `${JSON.stringify({ type: "permission", requestId: frame.value.requestId, decision: "deny" })}\n`,
        );
      }
    });
    expect(result.code).toBe(1);
    expect(result.final, JSON.stringify(result.final)).toMatchObject({
      result: { status: "failed", error: { code: "turn_limit_exceeded" } },
      closeStatus: "closed",
    });
    expect(await readFile(join(f.workspace, "demo.txt"), "utf8")).toBe("before\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);

test("controller EOF cancels an outstanding permission without executing the edit", async () => {
  const f = await fixture();
  try {
    const result = await run(f, {}, (frame, child) => {
      if (frame.type === "event" && frame.value.type === "tool_permission_requested")
        child.stdin.end();
    });
    expect(result.code).toBe(1);
    expect(result.final, JSON.stringify(result.final)).toMatchObject({
      stopReason: "controller_closed",
      result: { status: "cancelled" },
      closeStatus: "closed",
    });
    expect(await readFile(join(f.workspace, "demo.txt"), "utf8")).toBe("before\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);

test.each(["cancel", "signal", "invalid"])(
  "job settles %s control at a pending effect",
  async (action) => {
    const f = await fixture();
    try {
      const result = await run(f, {}, (frame, child) => {
        if (frame.type !== "event" || frame.value.type !== "tool_permission_requested") return;
        if (action === "signal") child.kill("SIGTERM");
        else
          child.stdin.write(
            action === "cancel"
              ? '{"type":"cancel"}\n'
              : '{"type":"permission","requestId":"stale","decision":"allow"}\n',
          );
      });
      expect(result.code).toBe(1);
      expect(result.final).toMatchObject({
        result: { status: "cancelled" },
        closeStatus: "closed",
        stopReason:
          action === "signal"
            ? "signal"
            : action === "cancel"
              ? "controller_cancelled"
              : "control_invalid",
      });
      expect(await readFile(join(f.workspace, "demo.txt"), "utf8")).toBe("before\n");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  45_000,
);

test("malformed job configuration produces one failure before creating session state", async () => {
  const f = await fixture();
  try {
    const result = await run(f, { maxTurns: 0 });
    expect(result.code).toBe(1);
    expect(result.final, JSON.stringify(result.final)).toMatchObject({
      receipt: null,
      result: null,
      failure: { code: "job_failed" },
      closeStatus: "not_started",
    });
    await expect(readdir(f.config.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);

test.each([100, -1])(
  "job relay validates and accounts provider input usage %s",
  async (inputTokens) => {
    const f = await fixture();
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
      body: Record<string, unknown>;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Recorded answer."}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":INPUT_TOKENS,"output_tokens":30,"input_tokens_details":{"cached_tokens":40},"output_tokens_details":{"reasoning_tokens":20}}}}\n\n'.replace(
          "INPUT_TOKENS",
          String(inputTokens),
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing fixture address.");
      const result = await run(
        f,
        {
          target: "deepseek-flash.direct",
          modelRelay: `http://127.0.0.1:${address.port}`,
          thinking: "high",
        },
        approve,
        { ADAM_AGENT_RELAY_TOKEN: "fixture-relay-token" },
      );
      if (inputTokens < 0) {
        expect(result.code).toBe(1);
        expect(result.final).toMatchObject({
          result: { status: "failed", error: { code: "model_protocol_invalid" } },
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        expect(
          Number((result.final?.usage as { unknownCalls: number } | undefined)?.unknownCalls),
        ).toBeGreaterThan(0);
        return;
      }
      expect(result.code, JSON.stringify(result.final)).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        url: "/responses",
        authorization: "Bearer fixture-relay-token",
        body: { model: "deepseek-flash", stream: true, reasoning: { effort: "high" } },
      });
      expect(JSON.stringify(result.frames)).not.toContain("fixture-relay-token");
      expect(result.final, JSON.stringify(result.final)).toMatchObject({
        usage: {
          calls: 2,
          unknownCalls: 0,
          inputTokens: 200,
          outputTokens: 60,
          cachedInputTokens: 80,
          reasoningTokens: 40,
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  },
  45_000,
);

function sse(event: { type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const completed = () =>
  sse({
    type: "response.completed",
    response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  });

test("two real relay jobs read, edit, verify and retain independent durable results", async () => {
  const fixtures = await Promise.all([fixture(), fixture()]);
  const turns = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { name: string }[];
      input: unknown[];
    };
    const label = request.headers.authorization === "Bearer relay-a" ? "alpha" : "beta";
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (!body.tools?.length) {
      response.end(
        sse({ type: "response.output_text.delta", delta: `Title ${label}` }) + completed(),
      );
      return;
    }
    expect(body.tools.map((tool) => tool.name)).not.toContain("spawn_agents");
    const turn = turns.get(label) ?? 0;
    turns.set(label, turn + 1);
    const calls = [
      { name: "read_file", arguments: { path: "README.md" } },
      {
        name: "edit_file",
        arguments: {
          operations: [
            { kind: "update", path: "demo.txt", edits: [{ oldText: "before", newText: label }] },
          ],
        },
      },
      {
        name: "run_shell",
        arguments: { command: `test "$(cat demo.txt)" = ${label} && printf verified-${label}` },
      },
    ];
    const call = calls[turn];
    if (call)
      response.end(
        sse({
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: `item-${turn}`,
            call_id: `call-${turn}`,
            name: call.name,
          },
        }) +
          sse({
            type: "response.function_call_arguments.delta",
            item_id: `item-${turn}`,
            delta: JSON.stringify(call.arguments),
          }) +
          sse({
            type: "response.output_item.done",
            item: { type: "function_call", id: `item-${turn}` },
          }) +
          completed(),
      );
    else
      response.end(
        sse({ type: "response.output_text.delta", delta: `Verified ${label}` }) + completed(),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const results = await Promise.all(
      fixtures.map((f, i) =>
        run(
          f,
          {
            target: "deepseek-flash.direct",
            modelRelay: `http://127.0.0.1:${address.port}`,
            prompt: `Repair task ${i}`,
          },
          approve,
          { ADAM_AGENT_RELAY_TOKEN: i === 0 ? "relay-a" : "relay-b" },
        ),
      ),
    );
    for (const [i, f] of fixtures.entries()) {
      const result = results[i];
      if (!result) throw new Error("Missing result");
      const label = i === 0 ? "alpha" : "beta";
      expect(result.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "event",
            value: expect.objectContaining({
              type: "tool_completed",
              name: "read_file",
              output: expect.objectContaining({
                content: "This is the isolated job repository.\n",
              }),
            }),
          }),
          expect.objectContaining({
            type: "event",
            value: expect.objectContaining({ type: "tool_completed", name: "edit_file" }),
          }),
          expect.objectContaining({
            type: "event",
            value: expect.objectContaining({
              type: "tool_completed",
              name: "run_shell",
              output: expect.objectContaining({
                termination: { type: "exited", exitCode: 0 },
                stdout: expect.objectContaining({ tail: `verified-${label}` }),
              }),
            }),
          }),
        ]),
      );
      expect(result.code, JSON.stringify(result.final)).toBe(0);
      expect(await readFile(join(f.workspace, "demo.txt"), "utf8")).toBe(`${label}\n`);
      const receipt = result.final?.receipt as { sessionId: string };
      const store = await openJsonlSessionStore<SessionRecord>({
        stateRoot: f.config.stateRoot,
        workspaceRoot: f.workspace,
        sessionId: receipt.sessionId,
      });
      const records = await store.read();
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: 3,
            record: expect.objectContaining({
              type: "runtime_event",
              event: {
                type: "session_settled",
                result: { status: "completed", answer: `Verified ${label}` },
              },
            }),
          }),
        ]),
      );
      expect(JSON.stringify(records)).not.toContain(i === 0 ? "Verified beta" : "Verified alpha");
      expect(turns.get(label)).toBe(4);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(fixtures.map((f) => rm(f.root, { recursive: true, force: true })));
  }
}, 45_000);

test("job deadline aborts a held auxiliary provider request before reporting success", async () => {
  const f = await fixture();
  let held = false;
  let closed = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[] };
    if (!body.tools?.length) {
      held = true;
      response.on("close", () => {
        closed = true;
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ type: "response.output_text.delta", delta: "Main finished" }) + completed());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const result = await run(
      f,
      {
        target: "deepseek-flash.direct",
        modelRelay: `http://127.0.0.1:${address.port}`,
        timeoutMs: 3000,
      },
      approve,
      { ADAM_AGENT_RELAY_TOKEN: "held-title" },
    );
    expect(held).toBe(true);
    expect(closed).toBe(true);
    expect(result.code).toBe(1);
    expect(result.final).toMatchObject({
      stopReason: "deadline",
      closeStatus: "closed",
      usage: { unknownCalls: 1 },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);

test("job emits reasoning text once across streaming fragments", async () => {
  const f = await fixture();
  const fragments = Array.from({ length: 128 }, (_, i) => `fragment-${i}:猫🙂\n`);
  const expected = fragments.join("");
  let ordinaryCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (body.tools?.length) {
      ordinaryCalls++;
      for (const delta of fragments)
        response.write(sse({ type: "response.reasoning_text.delta", delta }));
      if (ordinaryCalls === 1) {
        response.end(
          sse({
            type: "response.output_item.added",
            item: {
              id: "read-item",
              call_id: "read-call",
              type: "function_call",
              name: "read_file",
            },
          }) +
            sse({
              type: "response.function_call_arguments.delta",
              item_id: "read-item",
              delta: '{"path":"README.md"}',
            }) +
            sse({
              type: "response.output_item.done",
              item: { id: "read-item", type: "function_call" },
            }) +
            completed(),
        );
        return;
      }
    }
    response.end(sse({ type: "response.output_text.delta", delta: "Finished" }) + completed());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const result = await run(
      f,
      { target: "deepseek-flash.direct", modelRelay: `http://127.0.0.1:${address.port}` },
      approve,
      { ADAM_AGENT_RELAY_TOKEN: "reasoning-fixture" },
    );
    expect(result.code, JSON.stringify(result.final)).toBe(0);
    const reasoningFrames = result.frames.filter(
      (frame) =>
        frame.type === "reasoning_delta" ||
        (frame.type === "event" && frame.value.type === "model_reasoning_updated"),
    );
    const texts = reasoningFrames.map((frame) => String(frame.value.text));
    expect(texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBe(
      2 * Buffer.byteLength(expected),
    );
    expect(texts.join("")).toBe(expected + expected);
    expect(reasoningFrames.every((frame) => frame.type === "reasoning_delta")).toBe(true);
    const starts = result.frames.filter(
      (frame) => frame.type === "event" && frame.value.type === "model_reasoning_started",
    );
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(
        reasoningFrames
          .filter((frame) => frame.value.startSequence === start.sequence)
          .map((frame) => frame.value.text)
          .join(""),
      ).toBe(expected);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
}, 45_000);
