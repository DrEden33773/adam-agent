import type { ContextProfile, ModelTargetIdentity, ToolEffect } from "@adam-agent/agent";
import type { McpIdleScheduler } from "@adam-agent/agent/internal-testing";

import type { createSessionLifecycleForTesting } from "./index.js";

export const trustedMcpTargetIdentity: ModelTargetIdentity = {
  targetId: "deepseek-v4-flash.direct",
  vendor: "deepseek",
  modelId: "deepseek-v4-flash",
  route: "direct",
  profileVersion: 1,
  certification: "certified",
};

export const trustedMcpContextProfile: ContextProfile = {
  version: 1,
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  compactAtTokens: 96_000,
  postCompactTargetTokens: 48_000,
  retainedTargetTokens: 16_000,
  estimatorVersion: 1,
};

export function withFailureGuard<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(guard);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(guard);
        reject(error);
      },
    );
  });
}

export function createManualMcpIdleScheduler(): {
  readonly scheduler: McpIdleScheduler;
  readonly advanceBy: (milliseconds: number) => Promise<void>;
} {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, { readonly due: number; readonly task: () => Promise<void> }>();
  return {
    scheduler: {
      schedule(delayMilliseconds, task) {
        const id = nextId;
        nextId += 1;
        tasks.set(id, { due: now + delayMilliseconds, task });
        return { cancel: () => tasks.delete(id) };
      },
    },
    async advanceBy(milliseconds) {
      now += milliseconds;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, scheduled]) => scheduled.due <= now)
          .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
        if (due === undefined) {
          return;
        }
        tasks.delete(due[0]);
        await due[1].task();
      }
    },
  };
}

export async function commitFixtureEchoTool(
  lifecycle: ReturnType<typeof createSessionLifecycleForTesting>,
  effect: ToolEffect = "read",
): Promise<{
  readonly sessionId: string;
  readonly qualifiedName: string;
  readonly definitionDigest: `sha256:${string}`;
}> {
  const created = await lifecycle.create({ targetIdentity: trustedMcpTargetIdentity });
  if (created.mcp === undefined) {
    throw new Error("The fixture requires an MCP configuration snapshot.");
  }
  const confirmed = await lifecycle.configureMcp({
    type: "confirm_workspace",
    sessionId: created.sessionId,
    sourceDigest: created.mcp.source.digest,
  });
  const preview = confirmed.snapshot.mcp?.servers[0];
  if (preview === undefined) {
    throw new Error("The fixture requires one MCP server preview.");
  }
  await lifecycle.configureMcp({
    type: "approve_server",
    sessionId: created.sessionId,
    serverId: preview.serverId,
    definitionDigest: preview.definitionDigest,
  });
  const activated = await lifecycle.configureMcp({
    type: "activate_servers",
    sessionId: created.sessionId,
    servers: [{ serverId: preview.serverId, definitionDigest: preview.definitionDigest }],
  });
  const activeMcp = activated.snapshot.mcp;
  if (activeMcp?.status !== "tool_selection_required") {
    throw new Error("The fixture requires a discovered MCP catalog.");
  }
  const echo = activeMcp.catalog?.tools.find((tool) => tool.originalName === "echo");
  const generationId = activeMcp.activation?.generationId;
  if (echo === undefined || generationId === undefined) {
    throw new Error("The fixture requires the discovered echo tool and generation.");
  }
  await lifecycle.configureMcp({
    type: "commit_tool_profile",
    sessionId: created.sessionId,
    generationId,
    selections: [
      {
        qualifiedName: echo.qualifiedName,
        definitionDigest: echo.definitionDigest,
        effect,
      },
    ],
  });
  return {
    sessionId: created.sessionId,
    qualifiedName: echo.qualifiedName,
    definitionDigest: echo.definitionDigest,
  };
}
