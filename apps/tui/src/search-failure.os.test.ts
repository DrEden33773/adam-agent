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
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";

import { runTui } from "./tui-app.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test.each(["bounded results", "invalid cursor"] as const)(
  "production TUI handles %s and durably accepts the next Main prompt",
  async (scenario) => {
    const invalidCursor = scenario === "invalid cursor";
    const firstAnswer = invalidCursor ? "Search failure handled." : "Search results handled.";
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
              if (request.purpose === "title") {
                yield { type: "text_delta", text: "Search feedback fixture" };
                yield { type: "usage", inputTokens: 10, outputTokens: 10 };
                yield { type: "finish", reason: "stop" };
                return;
              }
              const last = request.messages.at(-1);
              if (last?.role === "user" && last.content === "Find all extensions.") {
                yield { type: "tool_call_start", id: "wide-search", name: "search_repository" };
                yield {
                  type: "tool_call_delta",
                  id: "wide-search",
                  json: JSON.stringify({
                    kind: "content",
                    query: "extension",
                    mode: "literal",
                    case: "insensitive",
                    include: ["*.ts"],
                    limit: 50,
                    ...(invalidCursor ? { cursor: "not-a-cursor" } : {}),
                  }),
                };
                yield { type: "tool_call_end", id: "wide-search" };
                yield { type: "usage", inputTokens: 100, outputTokens: 20 };
                yield { type: "finish", reason: "tool_calls" };
                return;
              }
              if (last?.role === "tool") {
                feedback = last.result;
                await releaseAnswer.promise;
                yield { type: "text_delta", text: firstAnswer };
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
      const toolSummary = invalidCursor ? "search_cursor_invalid" : "50 results";
      await terminal.waitForFrameAfter(toolSummary, beforeSearch);
      expect(terminal.lines().join("\n")).toContain(toolSummary);
      expect(terminal.lines().join("\n")).not.toContain("Interrupted session");
      releaseAnswer.resolve();
      await terminal.waitForFrameAfter(firstAnswer, beforeSearch);
      await terminal.waitForScreen(" · idle");
      expect(feedback).toMatchObject(
        invalidCursor
          ? {
              status: "failed",
              error: {
                code: "search_cursor_invalid",
                message: "The repository search cursor is malformed.",
              },
            }
          : {
              status: "completed",
              output: { resultCount: 50, snapshotResultCount: 300, remainingResultCount: 250 },
            },
      );
      if (feedback?.status === "completed") {
        expect(Buffer.byteLength(JSON.stringify(feedback.output), "utf8")).toBeLessThanOrEqual(
          16 * 1024,
        );
      }
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
              type: invalidCursor ? "tool_failed" : "tool_completed",
              callId: "wide-search",
              ...(invalidCursor
                ? { error: expect.objectContaining({ code: "search_cursor_invalid" }) }
                : {
                    output: expect.objectContaining({ resultCount: 50, snapshotResultCount: 300 }),
                  }),
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
  },
);
