import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionPolicy, type ModelDriver, type ModelRequest } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createWebSearchConfigurationWithStorageForTesting,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test("cold Research resumes a committed Skill resource boundary with frozen Skills and Web authority", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adam-role-recovery-"));
  const skillRoot = join(workspaceRoot, ".agents", "skills", "procedure");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: procedure\ndescription: Inspect evidence.\n---\nFROZEN PROCEDURE BODY\n",
  );
  await writeFile(join(skillRoot, "evidence.md"), "COMMITTED RESOURCE EVIDENCE\n");
  const boundary = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  let restoring = false;
  const driver: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      const call =
        !restoring && requests.length === 1
          ? {
              name: "read_skill_resource",
              json: '{"qualifiedId":"skill:v1:project:.:procedure","path":"evidence.md"}',
            }
          : restoring && !JSON.stringify(request.messages).includes("COLD WEB EVIDENCE")
            ? { name: "web_fetch", json: '{"url":"https://example.com/cold.txt"}' }
            : undefined;
      if (call !== undefined) {
        yield { type: "tool_call_start", id: `call-${requests.length}`, name: call.name };
        yield { type: "tool_call_delta", id: `call-${requests.length}`, json: call.json };
        yield { type: "tool_call_end", id: `call-${requests.length}` };
      } else yield { type: "text_delta", text: "Cold role evidence complete." };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: call === undefined ? "stop" : "tool_calls" };
    },
  };
  const configuration = createWebSearchConfigurationWithStorageForTesting({
    async read() {
      return { status: "missing" };
    },
    async write() {},
  });
  const fetched: string[] = [];
  const options = {
    workspaceRoot,
    permissions: createPermissionPolicy({ allowedEffects: ["read", "delegate", "network"] }),
    webSearchConfiguration: configuration,
    webHttp: {
      async fetch(input: { url: string }) {
        fetched.push(input.url);
        return {
          status: 200,
          url: input.url,
          mediaType: "text/plain",
          body: Buffer.from("COLD WEB EVIDENCE"),
        };
      },
    },
  };
  const h = await startManagedTui(driver, {
    ...options,
    async childRecordBarrier(record) {
      if (
        record.schemaVersion === 3 &&
        record.record.type === "runtime_event" &&
        record.record.event.type === "tool_completed" &&
        record.record.event.name === "read_skill_resource"
      ) {
        boundary.resolve();
        await release.promise;
      }
    },
  });
  let cold: Awaited<ReturnType<typeof startManagedTui>> | undefined;
  try {
    await h.presentation.dispatch({
      type: "managed_control",
      commandId: "cold-skill",
      command: {
        type: "spawn_agents",
        parentSessionId: h.parent.sessionId,
        entries: [
          {
            role: "builtin:research",
            task: "Inspect exact evidence.",
            description: "Cold evidence",
            skills: ["skill:v1:project:.:procedure"],
          },
        ],
      },
    });
    await boundary.promise;
    const sessions = createInMemorySessionStoreDirectory<SessionRecord>();
    const children = createInMemorySessionStoreDirectory<SessionRecord>();
    for (const [source, destination] of [
      [h.sessions, sessions],
      [h.children, children],
    ] as const) {
      for (const id of await source.listSessionIds()) {
        const records = await (await source.open(id))?.read();
        await (await destination.create(id)).appendBatch(records ?? []);
      }
    }
    const store = createInMemoryManagedAgentControlStore();
    for (const record of await h.store.read()) await store.append(record);
    release.resolve();
    await h.stop();
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: procedure\ndescription: Changed procedure.\n---\nLATER PROCEDURE BODY\n",
    );
    const before = requests.length;
    restoring = true;
    cold = await startManagedTui(driver, {
      ...options,
      restore: { ...h.storage, sessions, children, store },
    });
    expect(requests).toHaveLength(before);
    await cold.press("/agents\r", "Agents workspace");
    await cold.press("u", "u again to resume 1");
    await cold.press("u", "Completed");
    expect(fetched).toEqual(["https://example.com/cold.txt"]);
    expect(JSON.stringify(requests[before]?.messages)).toContain("FROZEN PROCEDURE BODY");
    expect(JSON.stringify(requests[before]?.messages)).toContain("COMMITTED RESOURCE EVIDENCE");
    expect(JSON.stringify(requests[before]?.messages)).not.toContain("LATER PROCEDURE BODY");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("COLD WEB EVIDENCE");
    expect(requests[before]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["activate_skill", "read_skill_resource", "web_fetch"]),
    );
    const childId = (await children.listSessionIds())[0];
    const records = childId === undefined ? [] : await (await children.open(childId))?.read();
    expect(
      records?.filter(
        (record) =>
          record.schemaVersion === 3 && record.record.type === "skill_resource_read_committed",
      ),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await (cold ?? h).close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
