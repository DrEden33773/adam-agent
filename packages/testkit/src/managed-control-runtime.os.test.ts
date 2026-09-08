import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlManagedAgentStore,
  createJsonlSessionStoreDirectory,
  createPermissionPolicy,
  createProductionManagedControlComposition,
  createReadToolRegistry,
  type ModelDriver,
  type ModelRequest,
  type PermissionDecisionCommandResult,
  type SessionRecord,
  type ToolResult,
} from "@adam-agent/agent";
import {
  createPromptContextV1,
  scoutManagedAgentProfileV1,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
  sessionLifecycleContextProfile,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test("production lifecycle foreground uses durable Control and exact child permission without legacy execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-production-control-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "evidence.txt"), "Foreground evidence.");
  const requests: ModelRequest[] = [];
  const model: ModelDriver = {
    async *stream(request) {
      requests.push(request);
      const main = request.tools?.some((tool) => tool.name === "spawn_agents") === true;
      const result = request.messages.findLast((message) => message.role === "tool");
      if (result?.role !== "tool") {
        yield {
          type: "tool_call_start",
          id: main ? "foreground" : "child-read",
          name: main ? "spawn_agents" : "read_file",
        };
        yield {
          type: "tool_call_delta",
          id: main ? "foreground" : "child-read",
          json: JSON.stringify(
            main
              ? {
                  mode: "foreground",
                  entries: [
                    {
                      role: "builtin:explore",
                      task: "Read evidence.txt.",
                      description: "Inspect foreground evidence",
                    },
                  ],
                }
              : { path: "evidence.txt" },
          ),
        };
        yield { type: "tool_call_end", id: main ? "foreground" : "child-read" };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      expect(result.result.status).toBe("completed");
      yield {
        type: "text_delta",
        text: main ? "Main consumed foreground evidence." : "Foreground evidence.",
      };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "finish", reason: "stop" };
    },
  };
  const composition = await createProductionManagedControlComposition({ workspaceRoot, stateRoot });
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    managedControl: composition,
    modelTargets: modelTargetsWithDriver(model),
    permissions: createPermissionPolicy({ allowedEffects: ["delegate"], askedEffects: ["read"] }),
  });
  const permissions: Promise<PermissionDecisionCommandResult>[] = [];
  const unsubscribeMain = lifecycle.subscribe((event) => {
    if (event.type === "tool_permission_requested")
      lifecycle.decidePermission({ requestId: event.requestId, decision: "allow" });
  });
  const unsubscribe = lifecycle.subscribeManagedAgentEvents?.((notification) => {
    if (
      notification.type !== "child_runtime_event" ||
      notification.event.type !== "tool_permission_requested"
    )
      return;
    const command = {
      sessionId: notification.parentSessionId,
      threadId: notification.agentId,
      attemptId: notification.attemptId,
      requestId: notification.event.requestId,
      decision: "allow" as const,
    };
    permissions.push(
      (async () => {
        expect(
          await lifecycle.decideManagedAgentPermission({
            ...command,
            attemptId: "00000000-0000-4000-8000-000000000001",
          }),
        ).toMatchObject({ status: "rejected", error: { code: "permission_request_not_pending" } });
        return lifecycle.decideManagedAgentPermission(command);
      })(),
    );
  });
  try {
    const result = await withManagedFailureGuard(
      lifecycle.admit({ targetIdentity, input: { text: "Inspect foreground evidence." } }),
      "production foreground and child permission",
    );
    expect(result.result).toMatchObject({
      status: "completed",
      answer: "Main consumed foreground evidence.",
    });
    expect(await Promise.all(permissions)).toEqual([{ status: "accepted" }]);
    expect(requests).toHaveLength(4);
    const records = await composition.store.read();
    const admitted = records.find((record) => record.event.type === "admitted");
    expect(admitted?.event).toMatchObject({ lane: "reserved", role: "builtin:explore" });
    expect(records.filter((record) => record.event.type === "settled")).toHaveLength(1);
    expect(await composition.store.readLegacy()).toEqual([]);
    expect(
      requests.every((request) => request.tools?.every((tool) => tool.name !== "spawn_agent")),
    ).toBe(true);
    await lifecycle.close();
    const cold = await createProductionManagedControlComposition({ workspaceRoot, stateRoot });
    expect(await cold.store.read()).toEqual(records);
    if (admitted === undefined) throw new Error("Missing admitted child.");
    const childRecords = await (
      await cold.childSessionStores.open(admitted.childSessionId)
    )?.read();
    expect(childRecords?.[0]).toMatchObject({
      record: { type: "session_genesis", sessionId: admitted.childSessionId },
    });
  } finally {
    unsubscribe?.();
    unsubscribeMain();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "managed-agent-tools.a3-long-lived.v1",
  "managed-agent-tools.a3-long-lived.v2",
  "managed-agent-tools.a3-long-lived.v3",
] as const)(
  "historical Main %s lists retained child evidence without writing control history",
  async (profile) => {
    const root = await mkdtemp(join(tmpdir(), "adam-historical-list-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    let result: ToolResult | undefined;
    let calls = 0;
    const model: ModelDriver = {
      async *stream(request) {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool_call_start", id: "historical-list", name: "list_agents" };
          yield {
            type: "tool_call_delta",
            id: "historical-list",
            json: '{"status":"terminal","limit":1}',
          };
          yield { type: "tool_call_end", id: "historical-list" };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        const tool = request.messages.findLast((message) => message.role === "tool");
        if (tool?.role !== "tool") throw new Error("Missing historical list result.");
        result = tool.result;
        yield { type: "text_delta", text: "Historical evidence inspected." };
        yield { type: "finish", reason: "stop" };
      },
    };
    const historical = createSessionLifecycleForTests({
      workspaceRoot,
      stateRoot,
      managedAgentTools: profile,
    });
    const parent = await historical.create({ targetIdentity });
    await historical.close();
    const children = createJsonlSessionStoreDirectory<SessionRecord>({
      workspaceRoot,
      stateRoot: join(stateRoot, "managed-child-sessions"),
    });
    const childSessionId = "123e4567-e89b-42d3-a456-426614174153";
    const child = await children.create(childSessionId);
    await child.append({
      schemaVersion: 3,
      sequence: 1,
      record: {
        type: "session_genesis",
        recordVersion: 2,
        sessionId: childSessionId,
        projectId: parent.projectId as `sha256:${string}`,
        targetIdentity,
        contextProfile: sessionLifecycleContextProfile,
        promptContext: createPromptContextV1(createReadToolRegistry({ workspaceRoot })),
      },
    });
    const childRecords = await child.read();
    const task = "Read retained historical evidence.";
    const digest = (text: string) =>
      `sha256:${createHash("sha256").update(text).digest("hex")}` as const;
    const admission = {
      schemaVersion: 1,
      type: "managed_agent_admitted",
      sequence: 1,
      agentId: "123e4567-e89b-42d3-a456-426614174151",
      attemptId: "123e4567-e89b-42d3-a456-426614174152",
      childSessionId,
      parentSessionId: parent.sessionId,
      parentRootId: `session:${parent.sessionId}`,
      parentToolCallId: "recorded-spawn",
      projectId: parent.projectId as `sha256:${string}`,
      profile: "scout.v1",
      profileDigest: scoutManagedAgentProfileV1.digest,
      limits: { maximumTurns: 8, maximumTokens: 128000, maximumDeadlineMilliseconds: 600000 },
      taskDigest: digest(task),
      childInputDigest: digest(
        `${task}\n\nThis child reads the live workspace. Parent changes may alter what it observes; isolated transcript does not mean repository snapshot or sandbox.`,
      ),
      targetIdentity,
    } as const;
    const legacy = await createJsonlManagedAgentStore({ workspaceRoot, stateRoot });
    await legacy.append(admission);
    await legacy.append({
      schemaVersion: 1,
      type: "managed_agent_terminal",
      sequence: 2,
      agentId: admission.agentId,
      attemptId: admission.attemptId,
      childSessionId,
      status: "completed",
      result: { text: "Retained terminal evidence." },
      transcriptDigest: digest(JSON.stringify(childRecords)),
      throughSequence: 1,
      usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 },
      cost: { status: "unavailable" },
    });
    await legacy.append({
      ...admission,
      sequence: 3,
      agentId: "123e4567-e89b-42d3-a456-426614174161",
      attemptId: "123e4567-e89b-42d3-a456-426614174162",
      childSessionId: "123e4567-e89b-42d3-a456-426614174163",
      parentSessionId: "123e4567-e89b-42d3-a456-426614174164",
      parentRootId: "session:123e4567-e89b-42d3-a456-426614174164",
    });
    const before = await legacy.read();
    const composition = await createProductionManagedControlComposition({
      workspaceRoot,
      stateRoot,
    });
    const current = createSessionLifecycleForTests({
      workspaceRoot,
      stateRoot,
      managedControl: composition,
      modelTargets: modelTargetsWithDriver(model),
      permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    });
    try {
      expect(
        await current.continue({
          sessionId: parent.sessionId,
          input: { text: "List my retained terminal child." },
        }),
      ).toMatchObject({ result: { status: "completed" } });
      expect(result).toMatchObject({
        status: "completed",
        output: {
          counts: { active: 0, terminal: 1, attention: 0 },
          nextCursor: null,
          agents: [
            {
              agentId: admission.agentId,
              status: "completed",
              readOnly: true,
              result: { text: "Retained terminal evidence." },
            },
          ],
        },
      });
      expect(calls).toBe(2);
      expect(await legacy.read()).toEqual(before);
      expect(await composition.store.read()).toEqual([]);
      expect(await child.read()).toEqual(childRecords);
    } finally {
      await current.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
