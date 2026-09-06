import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@adam-agent/agent";
import { expect, test, vi } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("custom aggregate limits validate the visible range and persist the exact non-preset value", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Custom bounded evidence." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("@Explore", "A · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect a custom grant.\r", "Delegation");
    await h.press("\x1b[B\x1b[B\x1b[B\r", "Execution and limits");
    await h.press("\x1b[A\r", "Custom limits");
    await h.press("\r", "Custom aggregate tokens");
    await h.press("\x01\x0b0\r", "Enter an integer from 1 to 512000.");
    expect(requests).toHaveLength(0);
    expect(await h.store.read()).toHaveLength(0);
    await h.press("\x01\x0b123457\r", "Limits updated.");
    await h.press("\r", "Completed");
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({ envelope: { aggregateTokens: 123457 } });
    expect(requests).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("direct delegation reviews finite execution and token bounds before one exact grant", async () => {
  const requests: ModelRequest[] = [];
  const h = await startManagedTui({
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "Bounded foreground evidence." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "stop" };
    },
  });
  try {
    await h.press("@Explore", "A · Explore");
    await h.press("\t", "@Explore");
    await h.press(" Inspect bounded evidence", "Inspect bounded evidence");
    await h.press("\r", "Execution and limits");
    await h.press("\x1b[B\x1b[B\x1b[B\r", "Foreground");
    await h.press("\x1b[B\r", "Limits updated.");
    await h.press("\x1b[B\x1b[B\x1b[B\r", "Aggregate 1x");
    await h.press("\x1b[B\x1b[B\r", "128000 tokens · Current request");
    await h.press("\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r", "Enter apply");
    await h.press("\x01\x0bNamed evidence work\r", "Description updated.");
    expect(requests).toHaveLength(0);
    await h.press("\r", "@explore-1 · Explore · Completed");
    expect(requests).toHaveLength(1);
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      lane: "reserved",
      description: "Named evidence work",
      envelope: {
        mode: "foreground",
        threads: 1,
        running: 1,
        queued: 0,
        aggregateTokens: 128000,
        sessionTokens: 2048000,
        origin: { kind: "direct_request" },
      },
    });
  } finally {
    await h.close();
  }
});

test("a Main model delegation uses the exact editable grant in its pending permission", async () => {
  const h = await startManagedTui({
    async *stream(request) {
      if (JSON.stringify(request.messages).includes("MODEL CHILD TASK")) {
        yield { type: "text_delta", text: "Model child evidence." };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "stop" };
      } else {
        yield { type: "tool_call_start", id: "model-spawn", name: "spawn_agents" };
        yield {
          type: "tool_call_delta",
          id: "model-spawn",
          json: JSON.stringify({
            entries: [
              {
                role: "builtin:explore",
                task: "MODEL CHILD TASK",
                description: "Model requested evidence",
              },
            ],
          }),
        };
        yield { type: "tool_call_end", id: "model-spawn" };
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "finish", reason: "tool_calls" };
      }
    },
  });
  try {
    await h.press("Delegate evidence", "Delegate evidence");
    await h.press("\r", "Execution and limits");
    await h.press("\x1b[B\x1b[B\r", "Task only");
    await h.press("\x1b[B\r", "Context updated.");
    await h.press("\x1b[B\x1b[B\x1b[B\r", "Aggregate 1x");
    await h.press("\x1b[B\x1b[B\r", "128000 tokens · Task only");
    const pending = h.presentation.getState().authoritative.active?.pendingInteractions[0];
    if (pending?.delegation === undefined) throw new Error("No pending exact delegation.");
    expect(
      await h.presentation.dispatch({
        type: "decide_permission",
        requestId: pending.requestId,
        decision: "allow",
        delegation: { ...pending.delegation, aggregateTokens: Number.MAX_SAFE_INTEGER },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      (await h.store.read()).filter((record) => record.event.type === "admitted"),
    ).toHaveLength(0);
    await h.press("\r", "@explore-1 · Explore · Completed");
    const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
    expect(admission?.event).toMatchObject({
      context: { mode: "task" },
      envelope: {
        context: "task",
        aggregateTokens: 128000,
        origin: { kind: "main_run", callId: "model-spawn" },
      },
    });
    const records = await (await h.sessions.open(h.parent.sessionId))?.read();
    const decided = records?.findLast(
      (record) =>
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "tool_permission_decided" &&
        record.record.event.name === "spawn_agents",
    );
    expect(decided?.schemaVersion === 3 ? decided.record : undefined).toMatchObject({
      type: "runtime_event",
      event: {
        decision: "allow",
        subject: {
          envelope: admission?.event.type === "admitted" ? admission.event.envelope : undefined,
        },
      },
    });
  } finally {
    await h.close();
  }
});

test.each([40, 80, 120])(
  "delegation exposes its complete grant at %i columns with NO_COLOR",
  async (columns) => {
    vi.stubEnv("NO_COLOR", "1");
    const h = await startManagedTui(
      {
        stream() {
          throw new Error("A preview or denial must not start a provider.");
        },
      },
      { columns },
    );
    try {
      await h.press("@Explore", columns === 40 ? "A @Explore" : "A · Explore");
      await h.press("\t", "@Explore");
      await h.press(" Inspect bounds", "Inspect bounds");
      await h.press("\r", "Delegation");
      await h.press("\x1b[B\x1b[B\x1b[B\x1b[B\r", "ID:");
      const compact = h.terminal.lines().join("").replace(/[\s│]/gu, "");
      expect(compact).toMatch(
        /ID:[a-f0-9-]{36}Digest:sha256:[a-f0-9]{64}Policy:sha256:[a-f0-9]{64}/u,
      );
      await h.press("\x1b", "Delegation");
      await h.press("\x1b", "@Explore");
      expect(
        (await h.store.read()).filter((record) => record.event.type === "admitted"),
      ).toHaveLength(0);
      expect(
        h.presentation
          .getState()
          .composer?.elements.some(
            (element) => element.type === "mention" && element.kind === "role",
          ),
      ).toBe(true);
    } finally {
      await h.close();
      vi.unstubAllEnvs();
    }
  },
);

test.each([
  ["direct", "keep"],
  ["direct", "remove"],
  ["model", "keep"],
  ["model", "remove"],
] as const)(
  "the %s delegation overlay can %s a requested Skill preactivation",
  async (source, choice) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-delegation-skill-"));
    const directory = join(workspaceRoot, ".agents", "skills", "requested");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: requested\ndescription: Inspect requested evidence.\n---\nREQUESTED CHILD SKILL BODY\n",
    );
    const requests: ModelRequest[] = [];
    const h = await startManagedTui(
      {
        async *stream(request) {
          if (source === "model" && request.tools.some((tool) => tool.name === "spawn_agents")) {
            if (!request.messages.some((message) => message.role === "tool")) {
              yield { type: "tool_call_start", id: "skill-spawn", name: "spawn_agents" };
              yield {
                type: "tool_call_delta",
                id: "skill-spawn",
                json: JSON.stringify({
                  entries: [
                    {
                      role: "builtin:explore",
                      task: "Inspect evidence",
                      description: "Requested Skill evidence",
                      skills: ["skill:v1:project:.:requested"],
                    },
                  ],
                }),
              };
              yield { type: "tool_call_end", id: "skill-spawn" };
              yield { type: "usage", inputTokens: 100, outputTokens: 20 };
              yield { type: "finish", reason: "tool_calls" };
              return;
            }
            yield { type: "text_delta", text: "Main delegation recorded." };
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "stop" };
            return;
          }
          requests.push(request);
          yield { type: "text_delta", text: "Selected Skill choice inspected." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
        },
      },
      { workspaceRoot },
    );
    try {
      if (source === "direct") {
        await h.press("@Explore", "A · Explore");
        await h.press("\t", "@Explore");
        await h.press(" Inspect evidence with $requested", "Inspect requested evidence.");
        await h.press("\t", "$requested");
      } else await h.press("Delegate Skill evidence", "Delegate Skill evidence");
      await h.press("\r", "Skill: skill:v1:project:.:requested");
      if (choice === "remove") {
        await h.press("\x1b[B\x1b[B\r", "Use selected Skills");
        await h.press("\x1b[B\r", "0 pre-activations");
        await h.press("\x1b[A\r", "Context updated.");
      }
      expect(requests).toHaveLength(0);
      await h.press("\r", "@explore-1 · Explore · Completed");
      expect(requests).toHaveLength(1);
      const text = JSON.stringify(requests[0]?.messages);
      if (choice === "keep") expect(text).toContain("REQUESTED CHILD SKILL BODY");
      else expect(text).not.toContain("REQUESTED CHILD SKILL BODY");
      const admission = (await h.store.read()).find((record) => record.event.type === "admitted");
      expect(admission?.event).toMatchObject({
        skills: choice === "keep" ? ["skill:v1:project:.:requested"] : [],
        envelope: { skills: choice === "keep" ? ["skill:v1:project:.:requested"] : [] },
      });
    } finally {
      await h.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
