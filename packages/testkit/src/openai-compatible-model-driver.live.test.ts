import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createCodingToolRegistry,
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

liveTest(
  "applies one approved structured repository lifecycle patch",
  async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-live-patch-lifecycle-"));
    const workspaceRoot = join(testRoot, "workspace");
    const sourceRoot = join(workspaceRoot, "src");
    const events: RuntimeEvent[] = [];
    try {
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, "old.ts"), 'export const oldName = "ready";\n', "utf8");
      await writeFile(
        join(sourceRoot, "index.ts"),
        'export { oldName } from "./old.js";\n',
        "utf8",
      );
      await writeFile(join(workspaceRoot, "obsolete.txt"), "remove me\n", "utf8");
      const session = createLivePatchSession({
        liveApiKey,
        workspaceRoot,
        stateRoot: join(testRoot, "state"),
        events,
      });

      const result = await session.run(
        {
          text: `Use edit_file exactly once without calling read_file, write_file, run_shell, or any other tool. All required original contents are stated below:
- src/old.ts is exactly: export const oldName = "ready"; followed by one newline.
- src/index.ts is exactly: export { oldName } from "./old.js"; followed by one newline.
- obsolete.txt is exactly: remove me followed by one newline.
Apply one structured patch with these four operations:
1. Move src/old.ts to src/current.ts and replace oldName with currentName.
2. In src/index.ts replace the complete line export { oldName } from "./old.js"; with export { currentName } from "./current.js";.
3. Delete obsolete.txt.
4. Create migration.txt containing exactly migrated followed by one newline.
After the tool settles, reply briefly.`,
        },
        { limits: { maxTurns: 4 } },
      );

      expect({
        status: result.status,
        requestedTools: requestedToolNames(events),
        writeApprovals: events.filter((event) => event.type === "tool_permission_requested").length,
        current: await readFile(join(sourceRoot, "current.ts"), "utf8"),
        index: await readFile(join(sourceRoot, "index.ts"), "utf8"),
        migration: await readFile(join(workspaceRoot, "migration.txt"), "utf8"),
        oldExists: await fileExists(join(sourceRoot, "old.ts")),
        obsoleteExists: await fileExists(join(workspaceRoot, "obsolete.txt")),
      }).toEqual({
        status: "completed",
        requestedTools: ["edit_file"],
        writeApprovals: 1,
        current: 'export const currentName = "ready";\n',
        index: 'export { currentName } from "./current.js";\n',
        migration: "migrated\n",
        oldExists: false,
        obsoleteExists: false,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
);

liveTest(
  "applies one approved nested release patch",
  async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-live-patch-release-"));
    const workspaceRoot = join(testRoot, "workspace");
    const events: RuntimeEvent[] = [];
    try {
      await mkdir(workspaceRoot);
      await writeFile(
        join(workspaceRoot, "settings.txt"),
        "mode=development\nfeature=off\n",
        "utf8",
      );
      await writeFile(join(workspaceRoot, "legacy.md"), "# Legacy\n", "utf8");
      await writeFile(join(workspaceRoot, "remove.me"), "remove\n", "utf8");
      const session = createLivePatchSession({
        liveApiKey,
        workspaceRoot,
        stateRoot: join(testRoot, "state"),
        events,
      });

      const result = await session.run(
        {
          text: `Use edit_file exactly once without calling read_file, write_file, run_shell, or any other tool. All required original contents are stated below:
- settings.txt is exactly two lines: mode=development and feature=off, followed by one newline.
- legacy.md is exactly: # Legacy followed by one newline.
- remove.me is exactly: remove followed by one newline.
Apply one structured patch with these four operations:
1. Update settings.txt by replacing mode=development with mode=production and feature=off with feature=on.
2. Move legacy.md to archive/legacy.md without changing its content.
3. Delete remove.me.
4. Create release.txt containing exactly ready followed by one newline.
After the tool settles, reply briefly.`,
        },
        { limits: { maxTurns: 4 } },
      );

      expect({
        status: result.status,
        requestedTools: requestedToolNames(events),
        writeApprovals: events.filter((event) => event.type === "tool_permission_requested").length,
        toolFailureCodes: events
          .filter((event) => event.type === "tool_failed")
          .map((event) => event.error.code),
        settings: await readTextIfExists(join(workspaceRoot, "settings.txt")),
        archived: await readTextIfExists(join(workspaceRoot, "archive", "legacy.md")),
        release: await readTextIfExists(join(workspaceRoot, "release.txt")),
        legacyExists: await fileExists(join(workspaceRoot, "legacy.md")),
        removedExists: await fileExists(join(workspaceRoot, "remove.me")),
      }).toEqual({
        status: "completed",
        requestedTools: ["edit_file"],
        writeApprovals: 1,
        toolFailureCodes: [],
        settings: "mode=production\nfeature=on\n",
        archived: "# Legacy\n",
        release: "ready\n",
        legacyExists: false,
        removedExists: false,
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
);

function createLivePatchSession(options: {
  readonly liveApiKey: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly events: RuntimeEvent[];
}): AgentSession {
  const session = new AgentSession({
    model: createLiveDriver(options.liveApiKey),
    store: createInMemorySessionStore(),
    tools: createCodingToolRegistry({
      workspaceRoot: options.workspaceRoot,
      stateRoot: options.stateRoot,
    }),
    permissions: createPermissionPolicy({ allowedEffects: [], askedEffects: ["write"] }),
  });
  session.subscribe((event) => {
    options.events.push(event);
    if (event.type === "tool_permission_requested") {
      session.decidePermission({ requestId: event.requestId, decision: "allow" });
    }
  });
  return session;
}

function requestedToolNames(events: readonly RuntimeEvent[]): readonly string[] {
  return events.filter((event) => event.type === "tool_requested").map((event) => event.name);
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

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
