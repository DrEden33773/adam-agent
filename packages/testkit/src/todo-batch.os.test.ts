import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodingToolRegistry,
  createPermissionPolicy,
  type ModelEvent,
  type ModelMessage,
} from "@adam-agent/agent";
import { openJsonlSessionStore, type SessionRecord } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import {
  createSessionLifecycleForTests as createSessionLifecycle,
  modelTargetsWithDriver,
  sessionLifecycleContextProfile,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

function call(id: string, name: string, input: unknown): ModelEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, json: JSON.stringify(input) },
    { type: "tool_call_end", id },
  ];
}

test.each([false, true])(
  "four Todo updates use one authoritative snapshot (atomic=%s)",
  async (atomic) => {
    const root = await mkdtemp(join(tmpdir(), "adam-todo-batch-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    let requestNumber = 0;
    let compactions = 0;
    let feedback: readonly ModelMessage[] = [];
    const driver = new FakeModelDriver((request) => {
      if (request.tools.length === 0) {
        compactions++;
        return [
          {
            type: "text_delta",
            text: JSON.stringify({
              schemaVersion: 1,
              objective: "Preserve completed Todos",
              constraints: [],
              progress: ["Four tasks completed"],
              unresolvedQuestions: [],
              failures: [],
              remainingVerification: [],
              nextSafeAction: "Report the authoritative Todo state",
            }),
          },
          { type: "usage", inputTokens: 120, outputTokens: 30 },
          { type: "finish", reason: "stop" },
        ];
      }
      requestNumber++;
      if (requestNumber === 1)
        return [
          ...Array.from({ length: 4 }, (_, index) =>
            call(`create-${index}`, "create_todo", { title: `Task ${index}` }),
          ).flat(),
          { type: "finish", reason: "tool_calls" },
        ];
      if (requestNumber === 2) {
        const ids = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => {
            if (message.role !== "tool" || message.result.status !== "completed")
              throw new Error("Expected created Todo feedback");
            const output = message.result.output as { item: { id: string } };
            return output.item.id;
          });
        expect(ids).toHaveLength(4);
        const updates = ids.map((id) => ({
          id,
          expectedItemRevision: 1,
          status: "completed",
          ...(atomic ? { details: "e".repeat(4096) } : {}),
        }));
        return [
          ...(atomic
            ? call("update-all", "update_todos", { expectedStoreRevision: 4, updates })
            : updates.flatMap((update, index) =>
                call(`update-${index}`, "update_todo", { ...update, expectedStoreRevision: 4 }),
              )),
          { type: "usage", inputTokens: 5000, outputTokens: 10 },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      feedback = request.messages;
      return [
        { type: "text_delta", text: "Todo results inspected." },
        { type: "finish", reason: "stop" },
      ];
    });
    const baseTargets = modelTargetsWithDriver(driver);
    const compactProfile = {
      ...sessionLifecycleContextProfile,
      contextWindowTokens: 100000,
      maximumOutputTokens: 16000,
      compactAtTokens: 10000,
      postCompactTargetTokens: 8000,
      retainedTargetTokens: 1000,
    };
    const modelTargets = atomic
      ? {
          async resolve() {
            return { identity: targetIdentity, driver, contextProfile: compactProfile };
          },
          async snapshot() {
            const snapshot = await baseTargets.snapshot?.({ signal: new AbortController().signal });
            if (snapshot === undefined) throw new Error("Expected target snapshot");
            return {
              ...snapshot,
              targets: snapshot.targets.map((target) => ({
                ...target,
                contextProfile: compactProfile,
              })),
            };
          },
        }
      : baseTargets;
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      tools: createCodingToolRegistry({ workspaceRoot }),
      permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
    });
    try {
      const created = await lifecycle.create({ targetIdentity });
      await expect(
        lifecycle.continue({
          sessionId: created.sessionId,
          input: { text: "Complete the four independent tasks." },
        }),
      ).resolves.toMatchObject({ result: { status: "completed" } });
      const results = feedback.filter(
        (message) => message.role === "tool" && message.name.startsWith("update_todo"),
      );
      expect(
        results.map((message) => (message.role === "tool" ? message.result.status : "unexpected")),
      ).toEqual(atomic ? [] : ["completed", "failed", "failed", "failed"]);
      expect(compactions).toBe(atomic ? 1 : 0);
      const summary = feedback.find(
        (message) =>
          message.role === "assistant" && message.content.includes("Adam runtime Todo summary"),
      );
      expect(summary).toMatchObject({
        content: expect.stringContaining(atomic ? '"completed":4' : '"completed":1'),
      });
      const inspected = await lifecycle.inspect({ sessionId: created.sessionId });
      if (!("todo" in inspected)) throw new Error("Expected current Todo projection");
      expect(inspected.todo).toMatchObject({
        storeRevision: 5,
        counts: { pending: atomic ? 0 : 3, inProgress: 0, completed: atomic ? 4 : 1 },
      });
      const records = await (
        await openJsonlSessionStore<SessionRecord>({
          workspaceRoot,
          stateRoot,
          sessionId: created.sessionId,
        })
      ).read();
      if (atomic)
        expect(
          records.filter(
            (entry) =>
              entry.schemaVersion === 3 &&
              entry.record.type === "runtime_event" &&
              entry.record.event.type === "tool_completed" &&
              entry.record.event.name === "update_todos",
          ),
        ).toHaveLength(1);
      const branch = await lifecycle.branch({
        parentSessionId: created.sessionId,
        atSequence: inspected.lastSequence,
      });
      expect(await lifecycle.inspect({ sessionId: branch.sessionId })).toMatchObject({
        todo: inspected.todo,
      });
      if (atomic) {
        await lifecycle.close();
        const terminal = records.findIndex(
          (entry) =>
            entry.schemaVersion === 3 &&
            entry.record.type === "runtime_event" &&
            entry.record.event.type === "tool_completed" &&
            entry.record.event.name === "update_todos",
        );
        const sessionPath = join(
          stateRoot,
          "projects",
          created.projectId.replace(/^sha256:/u, ""),
          "sessions",
          `${created.sessionId}.jsonl`,
        );
        for (const corruption of ["missing-version", "missing-item", "wrong-revision"]) {
          const damaged = structuredClone(records);
          const entry = damaged[terminal];
          if (
            entry?.schemaVersion !== 3 ||
            entry.record.type !== "runtime_event" ||
            entry.record.event.type !== "tool_completed"
          )
            throw new Error("Expected canonical batch result");
          const output = entry.record.event.output as {
            batchVersion?: number;
            items: { itemRevision: number }[];
          };
          if (corruption === "missing-version") delete output.batchVersion;
          else if (corruption === "missing-item") output.items.pop();
          else Object.assign(output.items[0] ?? {}, { itemRevision: 99 });
          await writeFile(
            sessionPath,
            `${damaged.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          );
          const cold = createSessionLifecycle({
            workspaceRoot,
            stateRoot,
            modelTargets,
            tools: createCodingToolRegistry({ workspaceRoot }),
          });
          try {
            await expect(cold.inspect({ sessionId: created.sessionId })).rejects.toMatchObject({
              code: "session_invalid",
            });
          } finally {
            await cold.close();
          }
        }
        // A crash at either complete-record boundary cannot split success from Todo state.
        for (const committed of [false, true]) {
          const prefix = records.slice(0, terminal + (committed ? 1 : 0));
          await writeFile(
            sessionPath,
            `${prefix.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          );
          const cold = createSessionLifecycle({
            workspaceRoot,
            stateRoot,
            modelTargets,
            tools: createCodingToolRegistry({ workspaceRoot }),
            permissions: createPermissionPolicy({ allowedEffects: ["read", "write"] }),
          });
          try {
            await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
              todo: {
                storeRevision: committed ? 5 : 4,
                counts: { pending: committed ? 0 : 4, inProgress: 0, completed: committed ? 4 : 0 },
              },
            });
            await expect(
              cold.resume({ sessionId: created.sessionId }),
              `resume committed=${committed}`,
            ).resolves.toMatchObject({ status: "ready" });
            if (committed)
              await expect(cold.continue({ sessionId: created.sessionId })).resolves.toMatchObject({
                result: { status: "completed" },
              });
            else
              await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
                status: "settled",
                run: { result: { status: "failed", error: { code: "tool_effect_indeterminate" } } },
              });
            await expect(cold.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
              todo: {
                storeRevision: committed ? 5 : 4,
                counts: { pending: committed ? 0 : 4, inProgress: 0, completed: committed ? 4 : 0 },
              },
            });
          } finally {
            await cold.close();
          }
        }
      }
    } finally {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
