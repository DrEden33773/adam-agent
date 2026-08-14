import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createInMemorySessionStore,
  createPermissionPolicy,
  createReadToolRegistry,
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";

const {
  DEEPSEEK_API_KEY: apiKey,
  ADAM_AGENT_LIVE_TESTS: liveTestSelection,
  ADAM_AGENT_MODEL: configuredModel,
} = process.env;
const liveTestsEnabled = liveTestSelection === "1";
const liveTest = test.skipIf(!liveTestsEnabled || apiKey === undefined || apiKey.length === 0);
const liveApiKey = apiKey ?? "";
const model = configuredModel ?? "deepseek-v4-pro";

test.skipIf(!liveTestsEnabled)("requires DEEPSEEK_API_KEY for the live gate", () => {
  expect(liveApiKey.length).toBeGreaterThan(0);
});

liveTest(
  "completes one answer-only DeepSeek turn",
  async () => {
    const session = new AgentSession({
      model: createLiveDriver(liveApiKey),
      store: createInMemorySessionStore(),
    });

    const result = await session.run({ text: "Reply with exactly: adam-live-ok" });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.answer.trim()).toBe("adam-live-ok");
    }
  },
  120_000,
);

liveTest(
  "completes one real read-tool DeepSeek round trip",
  async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-agent-live-deepseek-"));
    const events: RuntimeEvent[] = [];
    try {
      await writeFile(join(workspaceRoot, "README.md"), "# Nebula Orchard\n", "utf8");
      const session = new AgentSession({
        model: createLiveDriver(liveApiKey),
        store: createInMemorySessionStore(),
        tools: createReadToolRegistry({ workspaceRoot }),
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
      });
      session.subscribe((event) => events.push(event));

      const result = await session.run({
        text: "Use the read_file tool to read README.md, then reply with only the H1 project name.",
      });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.answer).toContain("Nebula Orchard");
      }
      expect(events).toContainEqual({
        type: "tool_requested",
        callId: expect.any(String),
        name: "read_file",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
  120_000,
);

function createLiveDriver(liveApiKey: string): OpenAICompatibleModelDriver {
  return new OpenAICompatibleModelDriver({
    profile: "deepseek",
    apiKey: liveApiKey,
    baseURL: "https://api.deepseek.com",
    model,
    maximumOutputTokens: 2_048,
    deadlineMs: 90_000,
  });
}
