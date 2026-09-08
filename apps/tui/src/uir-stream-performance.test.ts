import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { expect, test } from "vitest";
import { type ManagedTuiFixture, startManagedTui } from "./agent-fleet.test-support.js";
import { awaitEveReceipt as awaitReceipt } from "./public-eve.test-support.js";

// Same production workload, with a separate short-ACK control. Timings are diagnostics only.
test.each(["saturated", "short_ack"] as const)(
  "16 admitted children retain bounded previews and Fleet input frames during %s output",
  async (workload) => {
    const waveCount = workload === "saturated" ? 12 : 1;
    const fragments = workload === "saturated" ? 20 : 1;
    const chunk = workload === "saturated" ? `${"x".repeat(80)}界🙂` : "ACK.";
    const waves = Array.from({ length: waveCount }, () => Promise.withResolvers<void>());
    const waveDone = Array.from({ length: waveCount }, () => Promise.withResolvers<void>());
    const waveCounts = Array.from({ length: waveCount }, () => 0);
    const finish = Promise.withResolvers<void>();
    const allStarted = Promise.withResolvers<void>();
    let requests = 0;
    const h = await startManagedTui(
      {
        async *stream(request) {
          const index = requests++;
          const cancelled = new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (requests === 8) allStarted.resolve();
          if (index < 8) {
            for (let wave = 0; wave < waveCount; wave += 1) {
              await Promise.race([waves[wave]?.promise, cancelled]);
              if (request.signal.aborted) return;
              for (let fragment = 0; fragment < fragments; fragment += 1)
                yield { type: "text_delta", text: chunk };
              waveCounts[wave] = (waveCounts[wave] ?? 0) + 1;
              if (waveCounts[wave] === 8) waveDone[wave]?.resolve();
            }
            await Promise.race([finish.promise, cancelled]);
          } else yield { type: "text_delta", text: "Queued ACK." };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { columns: 120, rows: 40 },
    );
    const completed = Promise.withResolvers<void>();
    const unsubscribe = h.presentation.subscribe(() => {
      const threads = h.presentation.getState().authoritative.managedControl?.threads ?? [];
      if (threads.length === 16 && threads.every((thread) => thread.turn.outcome !== undefined))
        completed.resolve();
    });
    const { ADAM_UIR_STREAM_REPORT: profilePath } = process.env;
    const profiler = profilePath === undefined ? undefined : new Session();
    const measurements: {
      wave: number;
      scheduledInputMilliseconds: number;
      frameMilliseconds: number;
      waveMilliseconds: number;
    }[] = [];
    let profile: unknown;
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: `stream-${workload}`,
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: Array.from({ length: 16 }, (_, index) => ({
              role: "builtin:explore",
              task: `Inspect wave evidence ${index}.`,
              description: `Wave ${index}`,
            })),
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await awaitReceipt(allStarted.promise, "Eight child providers started");
      await h.terminal.waitForScreen("Fleet");
      const threads = h.presentation.getState().authoritative.managedControl?.threads ?? [];
      expect(threads).toHaveLength(16);
      expect(threads.filter((thread) => thread.turn.phase === "executing")).toHaveLength(8);
      expect(threads.filter((thread) => thread.turn.phase === "queued")).toHaveLength(8);
      await h.press("\x1b[B", "● Main");
      if (profiler !== undefined) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      for (let wave = 0; wave < waveCount; wave += 1) {
        const waveStart = performance.now();
        const offset = h.terminal.output().length;
        const expected = wave % 2 === 0 ? "● @explore-1" : "● Main";
        const input = new Promise<{
          scheduledInputMilliseconds: number;
          frameMilliseconds: number;
        }>((resolve, reject) => {
          setImmediate(() => {
            const entry = performance.now();
            h.terminal.input(wave % 2 === 0 ? "\x1b[B" : "\x1b[A");
            h.terminal.waitForFrameAfter(expected, offset).then(
              () =>
                resolve({
                  scheduledInputMilliseconds: entry - waveStart,
                  frameMilliseconds: performance.now() - entry,
                }),
              reject,
            );
          });
        });
        waves[wave]?.resolve();
        await awaitReceipt(
          waveDone[wave]?.promise ?? Promise.reject(new Error("Missing wave")),
          `All eight children emitted wave ${wave}`,
        );
        const timing = await input;
        measurements.push({ wave, ...timing, waveMilliseconds: performance.now() - waveStart });
        const total = (wave + 1) * fragments * (workload === "saturated" ? 87 : 4);
        const full = chunk.repeat((wave + 1) * fragments);
        // 188 complete 87-byte fragments occupy 16,356 bytes; the next 28 ASCII bytes fill the prefix.
        const expectedPrefix = total <= 16384 ? full : `${chunk.repeat(188)}${"x".repeat(28)}`;
        const bytes = Math.min(total, 16384);
        const activity = h.presentation.getState().managedAgentActivity ?? [];
        expect(activity).toHaveLength(8);
        for (const child of activity)
          expect(child.assistant).toMatchObject({
            text: expectedPrefix,
            totalByteCount: total,
            omittedBytes: total - bytes,
          });
      }
      const wallMilliseconds = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      if (profiler !== undefined) profile = (await profiler.post("Profiler.stop")).profile;
      if (profilePath !== undefined) {
        await writeFile(
          `${profilePath}-${workload}.json`,
          JSON.stringify(
            {
              workload,
              waveCount,
              fragments,
              fragmentBytes: Buffer.byteLength(chunk),
              wallMilliseconds,
              cpu,
              measurements,
            },
            null,
            2,
          ),
        );
        await writeFile(`${profilePath}-${workload}.cpuprofile`, JSON.stringify(profile));
      }
      finish.resolve();
      await awaitReceipt(completed.promise, "All expected child outcomes completed");
      const fullOutput = chunk.repeat(waveCount * fragments);
      for (let index = 0; index < 8; index += 1)
        expect(await readCompletedOutput(h, index)).toBe(fullOutput);
      for (let index = 8; index < 16; index += 1)
        expect(await readCompletedOutput(h, index)).toBe("Queued ACK.");
    } finally {
      for (const wave of waves) wave.resolve();
      finish.resolve();
      unsubscribe();
      profiler?.disconnect();
      await h.close();
    }
  },
);

async function readCompletedOutput(h: ManagedTuiFixture, index: number): Promise<string> {
  const thread = h.presentation.getState().authoritative.managedControl?.threads[index];
  const artifact = thread?.turn.outcome?.artifact;
  if (thread === undefined) throw new Error("Missing completed child.");
  expect(thread.turn.outcome?.status).toBe("completed");
  if (artifact === undefined) {
    const receipt = await h.presentation.dispatch({
      type: "read_agent_conversation",
      sessionId: thread.parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      cursor: null,
    });
    if (receipt.status !== "admitted" || receipt.managedAgentTranscript === undefined)
      throw new Error("Completed child transcript is unavailable.");
    const messages = receipt.managedAgentTranscript.items.filter(
      (item) => item.type === "assistant_message",
    );
    expect(messages).toHaveLength(1);
    return messages[0]?.text ?? "";
  }
  let offset = 0;
  let text = "";
  for (;;) {
    const receipt = await h.presentation.dispatch({
      type: "read_agent_artifact",
      sessionId: thread.parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      artifact: { ...artifact, source: "model_response" },
      range: { offset, maximumBytes: 16384 },
    });
    if (receipt.status !== "admitted" || receipt.resource === null)
      throw new Error("Completed child output is unavailable.");
    const page = receipt.resource;
    expect(page.offset).toBe(offset);
    expect(page.byteCount).toBe(Buffer.byteLength(page.text));
    expect(page.totalByteCount).toBe(artifact.byteCount);
    expect(page.text).not.toContain("�");
    text += page.text;
    if (page.eof) break;
    if (page.nextRange === null || page.nextRange.offset <= offset)
      throw new Error("Artifact paging did not advance.");
    offset = page.nextRange.offset;
  }
  expect(Buffer.byteLength(text)).toBe(artifact.byteCount);
  return text;
}

test.each([
  {
    name: "omitted CJK cannot be skipped by later ASCII",
    chunks: [`${"x".repeat(16383)}中`, "!"],
    prefix: "x".repeat(16383),
    total: 16387,
    omitted: 4,
  },
  {
    name: "split emoji fits exactly",
    chunks: ["x".repeat(16380), "\ud83d", "\ude42"],
    prefix: `${"x".repeat(16380)}🙂`,
    total: 16384,
    omitted: 0,
  },
  {
    name: "overflowing split emoji freezes prefix before later ASCII",
    chunks: [`${"x".repeat(16381)}\ud83d`, "\ude42", "!"],
    prefix: "x".repeat(16381),
    total: 16386,
    omitted: 5,
  },
])(
  "Unicode preview keeps the exact stream prefix: $name",
  async ({ chunks, prefix, total, omitted }) => {
    const second = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const h = await startManagedTui({
      async *stream(request) {
        yield { type: "text_delta", text: chunks[0] ?? "" };
        await second.promise;
        for (const text of chunks.slice(1)) yield { type: "text_delta", text };
        await Promise.race([
          finish.promise,
          new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        yield { type: "finish", reason: "stop" };
      },
    });
    const unsubscribe = h.presentation.subscribe(() => {
      if (h.presentation.getState().managedAgentActivity?.[0]?.assistant?.totalByteCount === total)
        observed.resolve();
      if (
        h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.outcome !==
        undefined
      )
        completed.resolve();
    });
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "unicode-prefix",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              {
                role: "builtin:explore",
                task: "Inspect a Unicode boundary.",
                description: "Unicode prefix",
              },
            ],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      second.resolve();
      await awaitReceipt(observed.promise, "Exact Unicode preview byte total");
      const assistant = h.presentation.getState().managedAgentActivity?.[0]?.assistant;
      expect(assistant).toMatchObject({
        text: prefix,
        totalByteCount: total,
        omittedBytes: omitted,
      });
      finish.resolve();
      await awaitReceipt(completed.promise, "All expected child outcomes completed");
      expect(await readCompletedOutput(h, 0)).toBe(chunks.join(""));
    } finally {
      second.resolve();
      finish.resolve();
      unsubscribe();
      await h.close();
    }
  },
);
