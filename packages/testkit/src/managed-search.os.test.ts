import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPermissionPolicy, type JsonValue, type ModelDriver } from "@adam-agent/agent";
import {
  createInMemoryManagedAgentControlStore,
  createInMemorySessionStoreDirectory,
  createManagedAgentControl,
  createProjectExecutionDomain,
  createProjectLifecycleOwner,
  type SessionRecord,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import { requireSessionEvent } from "./session-event.test-support.js";

type ContentPage = {
  readonly kind: "content";
  readonly resultCount: number;
  readonly snapshotResultCount: number;
  readonly remainingResultCount: number;
  readonly pageIndex: number;
  readonly nextCursor?: string;
  readonly groups: readonly {
    readonly path: string;
    readonly matches: readonly { readonly line: number; readonly snippet: string }[];
  }[];
};

test("a real managed child pages search and handles typed failure despite a rejected runtime observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-managed-search-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await mkdir(join(workspaceRoot, "src"));
  await mkdir(join(workspaceRoot, "ignored"));
  const expectedPaths = Array.from(
    { length: 300 },
    (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`,
  );
  await Promise.all([
    writeFile(join(workspaceRoot, ".gitignore"), "ignored/\n"),
    writeFile(join(workspaceRoot, "ignored/private.ts"), "extension must remain ignored\n"),
    writeFile(join(workspaceRoot, ".hidden.ts"), "extension must remain hidden\n"),
    writeFile(join(workspaceRoot, "binary.ts"), "extension\0binary bytes\n"),
    writeFile(join(workspaceRoot, "src/AGENTS.md"), "HIT-SCOPE MUST REMAIN INACTIVE\n"),
    symlink("src/file-000.ts", join(workspaceRoot, "linked.ts")),
  ]);
  await Promise.all(
    expectedPaths.map((path, index) =>
      writeFile(join(workspaceRoot, path), `export const extension${index} = true;\n`),
    ),
  );
  const parentSessionId = "123e4567-e89b-42d3-a456-426614174010";
  const pages: ContentPage[] = [];
  const outputs: JsonValue[] = [];
  const failures: string[] = [];
  let invalidCursorTurn = false;
  let failedToolObserved = false;
  let providerRequests = 0;
  const model: ModelDriver = {
    async *stream(request) {
      providerRequests += 1;
      expect(JSON.stringify(request.messages)).not.toContain("HIT-SCOPE MUST REMAIN INACTIVE");
      const last = request.messages.at(-1);
      let cursor: string | undefined;
      if (last?.role === "tool") {
        if (last.result.status === "failed") {
          failures.push(last.result.error.code);
          yield { type: "text_delta", text: "Child cursor failure handled." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        outputs.push(last.result.output);
        const page = last.result.output as unknown as ContentPage;
        expect(page.kind).toBe("content");
        pages.push(page);
        if (page.nextCursor === undefined) {
          yield { type: "text_delta", text: "Child paged all 300 files." };
          yield { type: "usage", inputTokens: 100, outputTokens: 20 };
          yield { type: "finish", reason: "stop" };
          return;
        }
        cursor = page.nextCursor;
      } else if (invalidCursorTurn) cursor = "not-a-cursor";
      const callId = `child-search-${providerRequests}`;
      yield { type: "tool_call_start", id: callId, name: "search_repository" };
      yield {
        type: "tool_call_delta",
        id: callId,
        json: JSON.stringify({
          kind: "content",
          query: "extension",
          mode: "literal",
          case: "insensitive",
          include: ["*.ts"],
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      };
      yield { type: "tool_call_end", id: callId };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const domain = createProjectExecutionDomain({
    lifecycleOwner: createProjectLifecycleOwner({ workspaceRoot, stateRoot }),
  });
  const claim = await domain.claimRoot({ rootId: "project-runtime" });
  const childSessionStores = createInMemorySessionStoreDirectory<SessionRecord>();
  const control = createManagedAgentControl({
    parentSessionId,
    projectId: `sha256:${createHash("sha256").update(workspaceRoot).digest("hex")}`,
    workspaceRoot,
    targetIdentity: {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct",
      profileVersion: 1,
      certification: "certified",
    },
    contextProfile: {
      version: 1,
      contextWindowTokens: 128_000,
      maximumOutputTokens: 4096,
      compactAtTokens: 96_000,
      postCompactTargetTokens: 32_000,
      retainedTargetTokens: 8000,
      estimatorVersion: 1,
    },
    model,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    executionDomain: domain,
    store: createInMemoryManagedAgentControlStore(),
    childSessionStores,
    async onChildRuntimeEvent(_identity, event) {
      if (event.type === "tool_failed" && event.name === "search_repository")
        failedToolObserved = true;
      throw new Error("Ordinary managed runtime observer rejected.");
    },
  });
  const subscription = new AbortController();
  const settledAfter = async (previousTurnId?: string) => {
    for await (const frame of control.observe({ parentSessionId, signal: subscription.signal })) {
      const thread = frame.snapshot.threads[0];
      if (
        thread?.turn.phase === "idle" &&
        thread.turn.outcome !== undefined &&
        thread.turn.turnId !== previousTurnId
      )
        return thread;
    }
    throw new Error("The managed search did not publish its settled outcome.");
  };
  try {
    const firstSettlement = settledAfter();
    await control.dispatch({
      type: "start_thread",
      parentSessionId,
      role: "builtin:explore",
      task: "Page through every matching extension file.",
      description: "Search repository files",
    });
    const first = await withManagedFailureGuard(firstSettlement, "managed paginated search");
    expect(first.turn.outcome).toMatchObject({
      status: "completed",
      summary: "Child paged all 300 files.",
    });
    expect(failures).toEqual([]);
    expect(pages.map((page) => page.resultCount)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(pages.map((page) => page.remainingResultCount)).toEqual([250, 200, 150, 100, 50, 0]);
    expect(pages.map((page) => page.pageIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pages.every((page) => page.snapshotResultCount === 300)).toBe(true);
    expect(pages.flatMap((page) => page.groups.map((group) => group.path))).toEqual(expectedPaths);
    for (const output of outputs)
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16 * 1024);

    invalidCursorTurn = true;
    const nextSettlement = settledAfter(first.turn.turnId);
    await control.dispatch({
      type: "next_turn",
      parentSessionId,
      threadId: first.threadId,
      expectedTurnId: first.turn.turnId,
      task: "Handle this invalid cursor and report completion.",
    });
    const next = await withManagedFailureGuard(nextSettlement, "managed typed search feedback");
    expect(next.turn.outcome).toMatchObject({
      status: "completed",
      summary: "Child cursor failure handled.",
    });
    expect(failures).toEqual(["search_cursor_invalid"]);
    expect(failedToolObserved).toBe(true);
    const records = await (await childSessionStores.open(next.turn.childSessionId))?.read();
    const events = records
      ?.filter((record) => record.schemaVersion === 3 && record.record.type === "runtime_event")
      .map((record) => requireSessionEvent(record).event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        name: "search_repository",
        error: expect.objectContaining({ code: "search_cursor_invalid" }),
      }),
    );
    expect(events).toContainEqual({
      type: "session_settled",
      result: { status: "completed", answer: "Child cursor failure handled." },
    });
  } finally {
    subscription.abort();
    await control.dispatch({ type: "close", parentSessionId });
    await claim.release();
    await domain.close();
    await rm(root, { recursive: true, force: true });
  }
});
