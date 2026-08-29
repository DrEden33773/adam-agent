import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  AgentSession,
  createCodingToolRegistry,
  createInMemorySessionStore,
  createModelTargets,
  createPermissionPolicy,
  createReadToolRegistry,
  OpenAICompatibleModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import { expect, test } from "vitest";
import { createSessionLifecycleForTests as createSessionLifecycle } from "./session-lifecycle.test-support.js";

const {
  DEEPSEEK_API_KEY: apiKey,
  ADAM_AGENT_LIVE_TESTS: liveTestSelection,
  ADAM_AGENT_MODEL: configuredModel,
} = process.env;
const liveTestsEnabled = liveTestSelection === "1";
const liveTest = test.skipIf(!liveTestsEnabled || apiKey === undefined || apiKey.length === 0);
const liveApiKey = apiKey ?? "";
const model = configuredModel ?? "deepseek-v4-pro";

for (const targetId of ["deepseek-v4-flash.direct", "deepseek-v4-pro.direct"] as const) {
  liveTest(
    `completes one answer-only turn through the unified ${targetId} target`,
    async () => {
      const { driver } = await createModelTargets({
        environment: { DEEPSEEK_API_KEY: liveApiKey },
        deadlineMs: 90_000,
      }).resolve({
        targetId,
        allowExperimental: false,
        signal: new AbortController().signal,
      });
      const session = new AgentSession({
        maximumOutputTokens: 4_096,
        model: driver,
        store: createInMemorySessionStore(),
      });

      const result = await session.run({ text: "Reply with exactly: adam-unified-live-ok" });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.answer.trim()).toBe("adam-unified-live-ok");
      }
    },
    120_000,
  );
}

test.skipIf(!liveTestsEnabled)("requires DEEPSEEK_API_KEY for the live gate", () => {
  expect(liveApiKey.length).toBeGreaterThan(0);
});

liveTest(
  "completes one answer-only DeepSeek turn",
  async () => {
    const session = new AgentSession({
      maximumOutputTokens: 4_096,
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
        maximumOutputTokens: 4_096,
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
  "current Direct DeepSeek Flash v3 completes one reasoning and read-tool round trip",
  async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-live-deepseek-v3-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    const events: RuntimeEvent[] = [];
    try {
      await mkdir(workspaceRoot);
      await writeFile(join(workspaceRoot, "README.md"), "# Aurora Compass\n", "utf8");
      const modelTargets = createModelTargets({
        environment: { DEEPSEEK_API_KEY: liveApiKey },
        deadlineMs: 90_000,
      });
      const target = (
        await modelTargets.snapshot({ signal: new AbortController().signal })
      ).targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash.direct");
      if (target === undefined) {
        throw new Error("Expected the current Direct DeepSeek Flash target.");
      }
      const lifecycle = createSessionLifecycle({
        modelTargets,
        permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
        stateRoot,
        tools: createReadToolRegistry({ workspaceRoot }),
        workspaceRoot,
      });
      lifecycle.subscribe((event) => events.push(event));

      try {
        const created = await lifecycle.create({ targetIdentity: target.identity });
        const continued = await lifecycle.continue({
          sessionId: created.sessionId,
          input: {
            text: "Use read_file to read README.md, then reply with only the H1 project name.",
          },
        });

        expect({
          result: continued.result,
          targetIdentity: continued.snapshot.targetIdentity,
        }).toEqual({
          result: { status: "completed", answer: expect.stringContaining("Aurora Compass") },
          targetIdentity: expect.objectContaining({
            targetId: "deepseek-v4-flash.direct",
            profileVersion: 3,
          }),
        });
        expect(events).toContainEqual({
          type: "tool_requested",
          callId: expect.any(String),
          name: "read_file",
        });
        expect(events).toContainEqual({
          type: "model_reasoning_started",
          id: expect.any(String),
          artifactType: "provider_reasoning",
        });
        expect(
          events.some(
            (event) => event.type === "model_reasoning_updated" && event.text.trim().length > 0,
          ),
        ).toBe(true);
        expect(events).toContainEqual({
          type: "model_reasoning_settled",
          id: expect.any(String),
          status: "completed",
        });
      } finally {
        await lifecycle.close();
      }
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
);

liveTest(
  "Vision Chat eager image observes one exact quadrant order and durable resource truth",
  async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "adam-agent-live-vision-chat-"));
    const stateRoot = join(testRoot, "state");
    const workspaceRoot = join(testRoot, "workspace");
    const imagePath = join(testRoot, "quadrants.png");
    const imageBytes = createQuadrantPng(128, 128);
    const imageDigest = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`;
    await mkdir(workspaceRoot);
    await writeFile(imagePath, imageBytes);
    const modelTargets = createModelTargets({
      environment: { DEEPSEEK_API_KEY: liveApiKey },
      connectionDeadlineMs: 15_000,
      deadlineMs: 90_000,
    });
    const target = (
      await modelTargets.snapshot({ signal: new AbortController().signal })
    ).targets.find(({ identity }) => identity.targetId === "deepseek-v4-flash-vision-exp.direct");
    if (target === undefined || modelTargets.testConnection === undefined) {
      throw new Error("Expected the exact Vision Chat target and connection test.");
    }
    const connection = await modelTargets.testConnection({
      targetId: target.identity.targetId,
      signal: new AbortController().signal,
    });
    expect(connection).toEqual({ status: "reachable", diagnostic: null });
    const lifecycle = createSessionLifecycle({
      modelTargets,
      stateRoot,
      workspaceRoot,
    });

    try {
      const created = await lifecycle.create({ targetIdentity: target.identity });
      const continued = await lifecycle.continue({
        sessionId: created.sessionId,
        input: {
          text: "Inspect the attached four equal color quadrants. Reply with only the top-left, top-right, bottom-left, and bottom-right colors in that order.",
        },
        resourceSelections: [{ type: "local_file", path: imagePath }],
      });
      expect(continued.result).toMatchObject({ status: "completed" });
      if (continued.result.status !== "completed") {
        throw new Error("Expected the Vision Chat image turn to complete.");
      }
      expect(continued.result.answer).toMatch(/red.*green.*blue.*white/isu);
      expect(continued.snapshot.targetIdentity).toMatchObject({
        targetId: "deepseek-v4-flash-vision-exp.direct",
        profileVersion: 1,
      });
      const records = await readJsonlRecords(stateRoot);
      expect(
        records.find(
          (record) =>
            isRecordType(record, "logical_run_started") && Array.isArray(record.inputResources),
        ),
      ).toMatchObject({
        inputResources: [
          {
            artifact: {
              id: imageDigest,
              byteCount: imageBytes.byteLength,
            },
            support: "image",
            mode: "link",
          },
        ],
      });
      expect(
        records.find((record) => isRecordType(record, "provider_attempt_started")),
      ).toMatchObject({
        targetIdentity: {
          targetId: "deepseek-v4-flash-vision-exp.direct",
          profileVersion: 1,
        },
        projectedContent: {
          version: 1,
          explicitUserImages: {
            count: 1,
            byteCount: imageBytes.byteLength,
            pixelCount: 128 * 128,
            maximumWidth: 128,
            maximumHeight: 128,
          },
        },
      });
    } finally {
      await lifecycle.close();
      await rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
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

function createQuadrantPng(width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const color =
        y < height / 2
          ? x < width / 2
            ? [255, 0, 0]
            : [0, 255, 0]
          : x < width / 2
            ? [0, 0, 255]
            : [255, 255, 255];
      pixels[offset] = color[0] as number;
      pixels[offset + 1] = color[1] as number;
      pixels[offset + 2] = color[2] as number;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: "IDAT" | "IEND" | "IHDR", data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type JsonlRecord = Readonly<Record<string, unknown>> & {
  readonly type?: unknown;
  readonly inputResources?: unknown;
};

async function readJsonlRecords(root: string): Promise<JsonlRecord[]> {
  const records: JsonlRecord[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
        for (const line of lines) {
          const decoded = JSON.parse(line) as { readonly record?: unknown };
          if (typeof decoded.record === "object" && decoded.record !== null) {
            records.push(decoded.record as JsonlRecord);
          }
        }
      }
    }
  };
  await visit(root);
  return records;
}

function isRecordType(record: JsonlRecord, type: string): boolean {
  return record.type === type;
}

function createLivePatchSession(options: {
  readonly liveApiKey: string;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly events: RuntimeEvent[];
}): AgentSession {
  const session = new AgentSession({
    maximumOutputTokens: 4_096,
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
