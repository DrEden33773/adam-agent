import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createPermissionPolicy } from "@adam-agent/agent";
import { expect, test } from "vitest";
import { AgentConversationViewer } from "./agent-conversation-viewer.js";
import { startManagedTui } from "./agent-fleet.test-support.js";
import { awaitEveReceipt as awaitReceipt } from "./public-eve.test-support.js";
import { TranscriptViewport } from "./transcript-viewport.js";

const document = Array.from(
  { length: 300 },
  (_, i) => `Line ${String(i).padStart(3, "0")} **stable Markdown** with 界🙂 text.  \n`,
).join("");
const samples = 12;
type Sample = {
  scheduledCallbackMilliseconds: number;
  inputFrameMilliseconds: number;
  transcriptDocumentRenderMilliseconds: number;
  childViewerRenderMilliseconds: number;
  outputBytes: number;
};

// Real runtime/Presentation/runTui owners; controlled provider waves, never latency thresholds.
test.each(["main", "todo", "static_widget", "eight_streaming"] as const)(
  "same long Main scroll workload with %s",
  async (workload) => {
    const waves = Array.from({ length: samples * 2 }, () => Promise.withResolvers<void>());
    const done = waves.map(() => Promise.withResolvers<void>());
    const counts = waves.map(() => 0);
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    let children = 0;
    let renderMilliseconds = 0;
    let restoreDocumentRender = () => {};
    const setScrollListener = TranscriptViewport.prototype.setScrollListener;
    // Observe the actual document instance through its public Component interface.
    // Both baseline Container and candidate TranscriptDocument use this exact boundary.
    TranscriptViewport.prototype.setScrollListener = function (listener) {
      const document = this.document;
      const render = document.render;
      document.render = function (width) {
        const start = performance.now();
        try {
          return render.call(this, width);
        } finally {
          renderMilliseconds += performance.now() - start;
        }
      };
      restoreDocumentRender = () => {
        document.render = render;
      };
      return setScrollListener.call(this, listener);
    };
    const h = await startManagedTui(
      {
        async *stream(request) {
          const call = calls++;
          if (call === 0 && workload !== "main") {
            for (let i = 0; i < 4; i++) {
              const id = `todo-${i}`;
              yield { type: "tool_call_start", id, name: "create_todo" };
              yield {
                type: "tool_call_delta",
                id,
                json: JSON.stringify({
                  title: `Scroll task ${i}`,
                  details: "Stable fixture Todo.",
                }),
              };
              yield { type: "tool_call_end", id };
            }
            yield { type: "finish", reason: "tool_calls" };
            return;
          }
          if (call === (workload === "main" ? 0 : 1)) {
            yield { type: "text_delta", text: `${document}\nMAIN-END` };
          } else {
            yield {
              type: "text_delta",
              text: `${document.split("\n").slice(0, 100).join("\n")}\nCHILD-END`,
            };
            children++;
            if (children === (workload === "eight_streaming" ? 8 : 1)) started.resolve();
            if (workload === "eight_streaming") {
              const cancelled = new Promise<void>((resolve) => {
                if (request.signal.aborted) resolve();
                else request.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              for (let wave = 0; wave < waves.length; wave++) {
                await Promise.race([waves[wave]?.promise, cancelled]);
                if (request.signal.aborted) return;
                for (let fragment = 0; fragment < 10; fragment++)
                  yield {
                    type: "text_delta",
                    text: `\nWave ${wave} fragment ${fragment} streaming child text.`,
                  };
                counts[wave] = (counts[wave] ?? 0) + 1;
                if (counts[wave] === 8) done[wave]?.resolve();
              }
              await Promise.race([finish.promise, cancelled]);
            }
          }
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        columns: 120,
        rows: 40,
        initialPrompt: "Prepare fixed long Main and four Todos.",
        permissions: createPermissionPolicy({ allowedEffects: ["read", "write", "delegate"] }),
      },
    ).finally(() => {
      TranscriptViewport.prototype.setScrollListener = setScrollListener;
    });
    const { ADAM_SCROLL_REPORT: reportPath } = process.env;
    const profiler = reportPath === undefined ? undefined : new Session();
    const measurements: Record<string, Sample[]> = { main: [], child: [] };
    let childRenderMilliseconds = 0;
    const childRender = AgentConversationViewer.prototype.render;
    AgentConversationViewer.prototype.render = function (width) {
      const start = performance.now();
      try {
        return childRender.call(this, width);
      } finally {
        childRenderMilliseconds += performance.now() - start;
      }
    };
    try {
      await h.terminal.waitForScreen("MAIN-END");
      if (workload !== "main") await h.terminal.waitForScreen("Todos (0/4)");
      if (workload === "static_widget" || workload === "eight_streaming") {
        expect(
          await h.presentation.dispatch({
            type: "managed_control",
            commandId: `scroll-${workload}`,
            command: {
              type: "spawn_agents",
              parentSessionId: h.parent.sessionId,
              entries: Array.from(
                { length: workload === "eight_streaming" ? 8 : 1 },
                (_, index) => ({
                  role: "builtin:explore",
                  task: `Read scroll evidence ${index}.`,
                  description: `Scroll ${index}`,
                }),
              ),
            },
          }),
        ).toMatchObject({ status: "admitted" });
        await awaitReceipt(started.promise, "Expected child providers entered");
        await h.terminal.waitForScreen("Fleet");
        if (workload === "static_widget") {
          const settled = Promise.withResolvers<void>();
          const check = () => {
            if (
              h.presentation.getState().authoritative.managedControl?.threads[0]?.turn.outcome
                ?.status === "completed"
            )
              settled.resolve();
          };
          const unsubscribe = h.presentation.subscribe(check);
          try {
            check();
            await awaitReceipt(settled.promise, "Static Widget completed outcome");
          } finally {
            unsubscribe();
          }
        }
      }
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      for (const view of workload === "eight_streaming" ? ["main", "child"] : ["main"]) {
        if (view === "child") {
          await h.openFirstAgent();
          await h.terminal.waitForScreen(`Wave ${samples - 1} fragment 9`);
          await h.terminal.waitForScreen("Following tail");
        }
        for (let index = 0; index < samples; index++) {
          const wave = index + (view === "child" ? samples : 0);
          const up = index % 2 === 0;
          const end = view === "main" ? "MAIN-END" : `Wave ${samples - 1} fragment 9`;
          let offset = h.terminal.output().length;
          const scheduled = performance.now();
          const beforeRender = renderMilliseconds;
          const beforeChildRender = childRenderMilliseconds;
          const input = new Promise<Sample>((resolve, reject) =>
            setImmediate(() => {
              offset = h.terminal.output().length;
              const entered = performance.now();
              h.terminal.input(up ? "\x1b[5~" : "\x1b[6~");
              h.terminal
                .waitForFrameAfter(
                  up
                    ? view === "main"
                      ? "deepseek-v4-flash.direct"
                      : "Conversation · @explore-1"
                    : end,
                  offset,
                  up
                    ? view === "main"
                      ? "MAIN-END"
                      : `Wave ${samples - 1} fragment 9`
                    : undefined,
                )
                .then(() => {
                  resolve({
                    scheduledCallbackMilliseconds: entered - scheduled,
                    inputFrameMilliseconds: performance.now() - entered,
                    transcriptDocumentRenderMilliseconds: renderMilliseconds - beforeRender,
                    childViewerRenderMilliseconds: childRenderMilliseconds - beforeChildRender,
                    outputBytes: Buffer.byteLength(h.terminal.output().slice(offset)),
                  });
                }, reject);
            }),
          );
          if (workload === "eight_streaming") waves[wave]?.resolve();
          const sample = await input;
          if (workload === "eight_streaming")
            await awaitReceipt(
              done[wave]?.promise ?? Promise.reject(new Error("Missing wave")),
              "All eight provider waves emitted",
            );
          measurements[view]?.push(sample);
        }
      }
      if (profiler) {
        const profile = (await profiler.post("Profiler.stop")).profile;
        await writeFile(`${reportPath}-${workload}.cpuprofile`, JSON.stringify(profile));
      }
      if (reportPath !== undefined)
        await writeFile(
          `${reportPath}-${workload}.json`,
          JSON.stringify(
            {
              workload,
              terminal: {
                columns: 120,
                rows: 40,
                adapter: "VirtualTerminal",
                node: process.version,
              },
              documentLines: 300,
              childInitialDocumentLines: 100,
              streamingWaves: workload === "eight_streaming" ? samples * 2 : 0,
              fragmentsPerChildPerWave: 10,
              scrollKeys:
                "Alternating PgUp and PgDown; Child manual page stays frozen at wave 11 while providers continue",
              documentBytes: Buffer.byteLength(document),
              samples,
              measurement:
                "Main transcript document.render elapsed time includes descendants and document geometry generation at the same public Component boundary in both revisions; excludes Pi layout traversal, overlay composition, terminal writes and Adam document construction. Child viewer.render is timed separately at its unchanged public Component boundary, excluding the surrounding overlay frame. Scheduled callback delay measures setImmediate queue entry during controlled provider waves.",
              measurements,
              distributions: Object.fromEntries(
                Object.entries(measurements).map(([view, rows]) => [
                  view,
                  Object.fromEntries(
                    (Object.keys(rows[0] ?? {}) as (keyof Sample)[]).map((key) => [
                      key,
                      distribution(rows.map((row) => row[key])),
                    ]),
                  ),
                ]),
              ),
            },
            null,
            2,
          ),
        );
    } finally {
      restoreDocumentRender();
      AgentConversationViewer.prototype.render = childRender;
      profiler?.disconnect();
      for (const wave of waves) wave.resolve();
      finish.resolve();
      await h.close();
    }
  },
);
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
