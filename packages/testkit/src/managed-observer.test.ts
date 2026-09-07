import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileArtifactStore,
  createPermissionPolicy,
  type ModelDriver,
  type RuntimeEvent,
} from "@adam-agent/agent";
import {
  createAgentManager,
  createInMemoryManagedAgentStore,
  createInMemorySessionStoreDirectory,
  createProjectExecutionDomain,
  createWebEvidenceToolRegistry,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { withManagedFailureGuard } from "./managed-agent-test-support.js";

type PermissionRequest = Extract<RuntimeEvent, { readonly type: "tool_permission_requested" }>;

test.each(["throw", "reject"] as const)(
  "default managed observers that %s cannot strand permission queues or child cleanup",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "adam-managed-observers-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const artifactStore = await createFileArtifactStore({ root: join(root, "artifacts") });
    let httpCalls = 0;
    const researchTools = await createWebEvidenceToolRegistry({
      artifactStore,
      http: {
        async fetch() {
          httpCalls += 1;
          throw new Error("Denied child network work cannot dispatch HTTP.");
        },
      },
    });
    const visiblePermissions = [
      Promise.withResolvers<PermissionRequest>(),
      Promise.withResolvers<PermissionRequest>(),
      Promise.withResolvers<PermissionRequest>(),
    ] as const;
    const bothRequested = Promise.withResolvers<void>();
    const runtimeRequests = new Set<string>();
    const decisions: string[] = [];
    const feedback: string[] = [];
    let visibleCount = 0;
    let stateObserved = false;
    const badObserver = () => {
      const error = new Error("Ordinary managed observer failed.");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    };
    const childModel: ModelDriver = {
      async *stream(request) {
        const last = request.messages.at(-1);
        if (last?.role === "tool") {
          expect(last.result).toMatchObject({
            status: "failed",
            error: { code: "permission_denied" },
          });
          feedback.push(last.callId);
          yield { type: "text_delta", text: "Child permission denial handled." };
          yield { type: "usage", inputTokens: 20, outputTokens: 10 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool_call_start", id: "observer-web", name: "web_fetch" };
        yield {
          type: "tool_call_delta",
          id: "observer-web",
          json: '{"url":"https://example.com/observer-evidence"}',
        };
        yield { type: "tool_call_end", id: "observer-web" };
        yield { type: "usage", inputTokens: 20, outputTokens: 10 };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    const domain = createProjectExecutionDomain({
      lifecycleOwner: {
        async acquire() {
          return { async release() {} };
        },
        async run(operation) {
          return operation();
        },
      },
    });
    const parentRoot = await domain.claimRoot({ rootId: "managed-observer-parent" });
    const manager = createAgentManager({
      childContextProfile: {
        version: 1,
        contextWindowTokens: 128_000,
        maximumOutputTokens: 4096,
        compactAtTokens: 96_000,
        postCompactTargetTokens: 32_000,
        retainedTargetTokens: 8000,
        estimatorVersion: 1,
      },
      childModel,
      childSessionStores: createInMemorySessionStoreDirectory<SessionRecord>(),
      managedStore: createInMemoryManagedAgentStore(),
      parentPermissions: createPermissionPolicy({
        allowedEffects: ["read"],
        askedEffects: ["network"],
      }),
      parentCoordination: { interactive: true },
      researchTools,
      artifactStore,
      parentRoot,
      projectId: `sha256:${"d".repeat(64)}`,
      targetIdentity: {
        targetId: "deepseek-v4-flash.direct",
        vendor: "deepseek",
        modelId: "deepseek-v4-flash",
        route: "direct",
        profileVersion: 1,
        certification: "certified",
      },
      workspaceRoot,
      builtInProfileVersion: 2,
      onChildRuntimeEvent({ event }) {
        if (event.type === "tool_permission_requested") {
          runtimeRequests.add(event.requestId);
          if (runtimeRequests.size === 2) bothRequested.resolve();
        }
        return badObserver();
      },
      onChildPermissionEvent(event) {
        if (event.type === "tool_permission_requested") {
          visiblePermissions[visibleCount]?.resolve(event);
          visibleCount += 1;
        } else if (event.type === "tool_permission_decided" && event.requestId !== undefined) {
          decisions.push(event.requestId);
        }
        return badObserver();
      },
      onManagedAgentStateChanged() {
        stateObserved = true;
        return badObserver();
      },
    });
    const spawn = (callId: string) =>
      manager.spawnBackground({
        callId,
        parentSessionId: manager.parentSessionId,
        profile: "research.v2",
        signal: new AbortController().signal,
        task: "Request one exact Web permission, then report the result.",
      });
    try {
      await expect(spawn("first-observer-child")).resolves.toMatchObject({ status: "completed" });
      await expect(spawn("second-observer-child")).resolves.toMatchObject({ status: "completed" });
      await withManagedFailureGuard(
        bothRequested.promise,
        "Both children must reach their real permission boundary.",
      );
      const waiting = await manager.snapshot();
      expect(waiting.agents).toHaveLength(2);
      for (const child of waiting.agents)
        expect(child).toMatchObject({
          status: "permission_required",
          watchdog: { state: "paused_permission" },
        });
      const first = await withManagedFailureGuard(
        visiblePermissions[0].promise,
        "First visible permission",
      );
      expect(manager.decidePermission({ requestId: first.requestId, decision: "deny" })).toEqual({
        status: "accepted",
      });
      const second = await withManagedFailureGuard(
        visiblePermissions[1].promise,
        "Queued permission must follow a failed outward decision notification.",
      );
      expect(second.requestId).not.toBe(first.requestId);
      expect(manager.decidePermission({ requestId: second.requestId, decision: "deny" })).toEqual({
        status: "accepted",
      });
      await withManagedFailureGuard(
        manager.waitForIdle(),
        "Both denied children must settle normally.",
      );
      const completed = await manager.snapshot();
      expect(completed.agents.map((child) => child.status)).toEqual(["completed", "completed"]);
      expect(feedback).toEqual(["observer-web", "observer-web"]);
      expect(decisions).toEqual([first.requestId, second.requestId]);
      expect(stateObserved).toBe(true);
      expect(httpCalls).toBe(0);

      await expect(spawn("closing-observer-child")).resolves.toMatchObject({ status: "completed" });
      await withManagedFailureGuard(
        visiblePermissions[2].promise,
        "Permission must be active before close.",
      );
      await withManagedFailureGuard(
        manager.close(),
        "Failed permission observers must not block child release.",
      );
      const closed = await manager.snapshot();
      expect(closed.counts.active).toBe(0);
      expect(closed.agents.map((child) => child.status).sort()).toEqual([
        "cancelled",
        "completed",
        "completed",
      ]);
      expect(httpCalls).toBe(0);
    } finally {
      await manager.close();
      await parentRoot.release();
      await domain.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
