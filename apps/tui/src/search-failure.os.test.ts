import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelTargetIdentity,
  type ModelTargets,
  type ToolResult,
} from "@adam-agent/agent";
import {
  createTrustedWorkspaceTrustForTesting,
  openJsonlSessionStore,
  preparedDirectDeepSeekV2ContextProfile,
  type SessionRecord,
  sessionAutomaticTitlesEnabled,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { runTui } from "./tui-app.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test("production TUI handles a wide search failure and durably accepts the next Main prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-search-tui-feedback-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      writeFile(
        join(workspaceRoot, `file-${String(index).padStart(3, "0")}.ts`),
        `export const extension${index} = true;\n`,
      ),
    ),
  );
  const identity: ModelTargetIdentity = {
    targetId: "deepseek-v4-flash.direct",
    vendor: "deepseek",
    modelId: "deepseek-v4-flash",
    route: "direct",
    profileVersion: 2,
    certification: "certified",
  };
  const releaseAnswer = Promise.withResolvers<void>();
  let feedback: ToolResult | undefined;
  const modelTargets: ModelTargets = {
    async resolve() {
      return {
        identity,
        contextProfile: preparedDirectDeepSeekV2ContextProfile,
        driver: {
          async *stream(request) {
            const last = request.messages.at(-1);
            if (last?.role === "user" && last.content === "Find all extensions.") {
              yield { type: "tool_call_start", id: "wide-search", name: "search_repository" };
              yield {
                type: "tool_call_delta",
                id: "wide-search",
                json: '{"kind":"content","query":"extension","mode":"literal","case":"insensitive","include":["*.ts"],"limit":50}',
              };
              yield { type: "tool_call_end", id: "wide-search" };
              yield { type: "usage", inputTokens: 100, outputTokens: 20 };
              yield { type: "finish", reason: "tool_calls" };
              return;
            }
            if (last?.role === "tool") {
              feedback = last.result;
              await releaseAnswer.promise;
              yield { type: "text_delta", text: "Search failure handled." };
            } else {
              yield { type: "text_delta", text: "Next Main prompt completed." };
            }
            yield { type: "usage", inputTokens: 100, outputTokens: 20 };
            yield { type: "finish", reason: "stop" };
          },
        },
      };
    },
    async snapshot() {
      return {
        targets: [
          {
            identity,
            contextProfile: preparedDirectDeepSeekV2ContextProfile,
            readiness: { status: "available", credentialSource: "test" },
          },
        ],
      };
    },
  };
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets,
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
    workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
    [sessionAutomaticTitlesEnabled]: false,
  });
  const terminal = new VirtualTerminal();
  let running: Promise<void> | undefined;
  try {
    const created = await lifecycle.create({ targetIdentity: identity });
    const presentation = await createPresentationSession({
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot,
      sessionId: created.sessionId,
      projectLabel: "workspace",
    });
    running = runTui({
      terminal,
      presentation,
      closeRuntime: async () => {
        await presentation.close();
        await lifecycle.close();
      },
    });
    await terminal.waitForFrameAfter(" · idle", 0);
    expect(presentation.getState().authoritative.active?.parentRun).toEqual({
      phase: "ready",
      editor: "ready",
    });
    const beforeDraft = terminal.output().length;
    terminal.input("Find all extensions.");
    await terminal.waitForFrameAfter("Find all extensions.", beforeDraft);
    const beforeSearch = terminal.output().length;
    terminal.input("\r");
    await terminal.waitForFrameAfter("search_quota_exceeded", beforeSearch);
    expect(terminal.lines().join("\n")).toContain("search_quota_exceeded");
    expect(terminal.lines().join("\n")).not.toContain("Interrupted session");
    releaseAnswer.resolve();
    await terminal.waitForFrameAfter("Search failure handled.", beforeSearch);
    await terminal.waitForScreen(" · idle");
    expect(feedback).toMatchObject({
      status: "failed",
      error: {
        code: "search_quota_exceeded",
        message: "The repository search page metadata exceeded its UTF-8 byte limit.",
      },
    });
    expect(presentation.getState().authoritative.active?.parentRun).toEqual({
      phase: "ready",
      editor: "ready",
    });

    const store = await openJsonlSessionStore<SessionRecord>({
      workspaceRoot,
      stateRoot,
      sessionId: created.sessionId,
    });
    const firstRun = await store.read();
    expect(firstRun).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "runtime_event",
          event: expect.objectContaining({
            type: "tool_failed",
            callId: "wide-search",
            error: expect.objectContaining({ code: "search_quota_exceeded" }),
          }),
        }),
      }),
    );
    const beforeNextDraft = terminal.output().length;
    terminal.input("Continue Main after search.");
    await terminal.waitForFrameAfter("Continue Main after search.", beforeNextDraft);
    const beforeNextPrompt = terminal.output().length;
    terminal.input("\r");
    await terminal.waitForFrameAfter("Next Main prompt completed.", beforeNextPrompt);
    await terminal.waitForScreen(" · idle");
    const nextRun = (await store.read()).slice(firstRun.length);
    expect(nextRun).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "runtime_event",
          event: { type: "user_message", text: "Continue Main after search." },
        }),
      }),
    );
    expect(nextRun).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          type: "runtime_event",
          event: {
            type: "session_settled",
            result: { status: "completed", answer: "Next Main prompt completed." },
          },
        }),
      }),
    );
    await expect(lifecycle.inspect({ sessionId: created.sessionId })).resolves.toMatchObject({
      status: "settled",
    });
  } finally {
    releaseAnswer.resolve();
    if (terminal.running()) terminal.input("\u0011");
    await running;
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
