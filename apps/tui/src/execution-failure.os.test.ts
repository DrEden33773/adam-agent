import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPermissionPolicy,
  createPresentationSession,
  createSessionLifecycle,
  type ModelTargetIdentity,
  type ModelTargets,
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

const viewports = [
  {
    columns: 40,
    rows: 12,
    noColor: false,
    recovery: "resume",
    restart: true,
    tool: "search_repository",
  },
  {
    columns: 80,
    rows: 24,
    noColor: false,
    recovery: "resume",
    restart: false,
    tool: "search_repository",
  },
  {
    columns: 120,
    rows: 24,
    noColor: false,
    recovery: "cancel",
    restart: false,
    tool: "write_file",
  },
  {
    columns: 80,
    rows: 16,
    noColor: true,
    recovery: "cancel",
    restart: false,
    tool: "search_repository",
  },
] as const;

test.each(viewports)(
  "production TUI explains real storage failure at $columns columns, NO_COLOR=$noColor, then $recovery (restart=$restart, tool=$tool)",
  async (viewport) => {
    const root = await mkdtemp(join(tmpdir(), "adam-tui-execution-failure-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "source.ts"), "export const extension = true;\n");
    const identity: ModelTargetIdentity = {
      targetId: "deepseek-v4-flash.direct",
      vendor: "deepseek",
      modelId: "deepseek-v4-flash",
      route: "direct",
      profileVersion: 2,
      certification: "certified",
    };
    let providerCalls = 0;
    const modelTargets: ModelTargets = {
      async resolve() {
        return {
          identity,
          contextProfile: preparedDirectDeepSeekV2ContextProfile,
          driver: {
            async *stream(request) {
              if (request.purpose === "title") {
                yield { type: "text_delta", text: "Storage recovery fixture" };
                yield { type: "usage", inputTokens: 10, outputTokens: 10 };
                yield { type: "finish", reason: "stop" };
                return;
              }
              providerCalls += 1;
              if (providerCalls === 1) {
                yield { type: "tool_call_start", id: "fault-tool", name: viewport.tool };
                yield {
                  type: "tool_call_delta",
                  id: "fault-tool",
                  json: JSON.stringify(
                    viewport.tool === "write_file"
                      ? { path: "effect.txt", content: "one effect\n" }
                      : { kind: "content", query: "extension" },
                  ),
                };
                yield { type: "tool_call_end", id: "fault-tool" };
                yield { type: "usage", inputTokens: 100, outputTokens: 20 };
                yield { type: "finish", reason: "tool_calls" };
                return;
              }
              yield {
                type: "text_delta",
                text:
                  request.messages.at(-1)?.role === "tool"
                    ? "Safe search recovered."
                    : "Main after recovery completed.",
              };
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
    const makeLifecycle = () =>
      createSessionLifecycle({
        workspaceRoot,
        stateRoot,
        modelTargets,
        permissions: createPermissionPolicy({
          allowedEffects: viewport.tool === "write_file" ? ["read", "write"] : ["read"],
        }),
        workspaceTrust: createTrustedWorkspaceTrustForTesting(workspaceRoot),
      });
    const start = async (owner: ReturnType<typeof makeLifecycle>, sessionId: string) => {
      const presentation = await createPresentationSession({
        lifecycle: owner,
        modelTargets,
        workspaceRoot,
        stateRoot,
        sessionId,
        projectLabel: "workspace",
      });
      const terminal = new VirtualTerminal(viewport);
      const running = runTui({
        terminal,
        presentation,
        closeRuntime: async () => {
          await presentation.close();
          await owner.close();
        },
      });
      return { presentation, terminal, running };
    };
    const environment = process.env as NodeJS.ProcessEnv & { NO_COLOR?: string };
    const previousNoColor = environment.NO_COLOR;
    if (viewport.noColor) environment.NO_COLOR = "1";
    else delete environment.NO_COLOR;
    let lifecycle = makeLifecycle();
    let ui: Awaited<ReturnType<typeof start>> | undefined;
    let logPath: string | undefined;
    let unsubscribe: (() => void) | undefined;
    const idleFrame = viewport.columns === 40 ? "idle · ctx" : " · idle";
    try {
      const created = await lifecycle.create({ targetIdentity: identity });
      const logs = (await readdir(stateRoot, { recursive: true })).filter((path) =>
        path.endsWith(`/${created.sessionId}.jsonl`),
      );
      expect(logs).toHaveLength(1);
      logPath = join(stateRoot, logs[0] as string);
      let startedSequence: number | undefined;
      let failedRunId: string | undefined;
      unsubscribe = lifecycle.subscribeSessionEvents((notification) => {
        if (
          notification.event.type === "tool_started" &&
          notification.event.callId === "fault-tool" &&
          startedSequence === undefined
        ) {
          startedSequence = notification.throughSequence;
          failedRunId = notification.runId;
          // Change the external storage condition after a real durable event;
          // the next actual JSONL append must fail at open, before any write.
          chmodSync(logPath as string, 0o400);
        }
      });
      ui = await start(lifecycle, created.sessionId);
      await ui.terminal.waitForFrameAfter(idleFrame, 0);
      const draftOffset = ui.terminal.output().length;
      ui.terminal.input("Work before storage fails.");
      await ui.terminal.waitForFrameAfter("Work before storage fails.", draftOffset);
      const submitOffset = ui.terminal.output().length;
      ui.terminal.input("\r");
      await ui.terminal.waitForFrameAfter("Session storage unavailable.", submitOffset);
      expect(ui.presentation.getState()).toMatchObject({
        executionFailure: {
          category: "storage_io_failed",
          stage: "open",
          phase: "tool_result",
          writeOutcome: "not_written",
          reason: "permission_denied",
          sessionId: created.sessionId,
          runId: failedRunId,
          callId: "fault-tool",
          attemptedSequence: (startedSequence ?? 0) + 1,
        },
        authoritative: { active: { parentRun: { phase: "interrupted", editor: "blocked" } } },
      });
      expect(ui.terminal.lines().join(" ").replace(/\s+/gu, " ")).toContain(
        "The record was not written.",
      );
      expect(providerCalls).toBe(1);
      const store = await openJsonlSessionStore<SessionRecord>({
        workspaceRoot,
        stateRoot,
        sessionId: created.sessionId,
      });
      const interrupted = await store.read();
      expect(interrupted.at(-1)).toMatchObject({
        sequence: startedSequence,
        record: { type: "runtime_event", event: { type: "tool_started", callId: "fault-tool" } },
      });
      if (viewport.tool === "write_file") {
        expect(await readFile(join(workspaceRoot, "effect.txt"), "utf8")).toBe("one effect\n");
        expect(ui.terminal.lines().join(" ")).toContain("cannot be replayed safely");
        await expect(
          ui.presentation.dispatch({
            type: "resume_interrupted_session",
            sessionId: created.sessionId,
            runId: failedRunId as string,
          }),
        ).resolves.toMatchObject({ status: "rejected", code: "not_available" });
        expect(await store.read()).toEqual(interrupted);
        expect(providerCalls).toBe(1);
      }
      if (viewport.restart) {
        unsubscribe();
        unsubscribe = undefined;
        ui.terminal.input("\u0011");
        await ui.running;
        lifecycle = makeLifecycle();
        ui = await start(lifecycle, created.sessionId);
        await ui.terminal.waitForFrameAfter("Interrupted session", 0);
        expect(ui.presentation.getState().executionFailure).toBeUndefined();
        expect(await store.read()).toEqual(interrupted);
        expect(providerCalls).toBe(1);
      }
      await chmod(logPath, 0o600);
      await ui.terminal.waitForScreen(
        viewport.recovery === "resume" ? "Resume safe work" : "Cancel interrupted work",
      );
      const recoveryOffset = ui.terminal.output().length;
      ui.terminal.input(viewport.recovery === "resume" ? "r" : "c");
      if (viewport.recovery === "resume")
        await ui.terminal.waitForFrameAfter("Safe search recovered.", recoveryOffset);
      else await ui.terminal.waitForFrameAfter(idleFrame, recoveryOffset);
      await ui.terminal.waitForScreen(idleFrame);
      expect(ui.presentation.getState().authoritative.active?.parentRun).toEqual({
        phase: "ready",
        editor: "ready",
      });
      const afterRecovery = await store.read();
      if (viewport.recovery === "cancel") {
        expect(afterRecovery.slice(interrupted.length)).toContainEqual(
          expect.objectContaining({
            record: expect.objectContaining({
              type: "runtime_event",
              event: { type: "session_interrupted", reason: "cancelled" },
            }),
          }),
        );
        expect(providerCalls).toBe(1);
      }
      if (viewport.tool === "write_file")
        expect(await readFile(join(workspaceRoot, "effect.txt"), "utf8")).toBe("one effect\n");
      const nextDraftOffset = ui.terminal.output().length;
      ui.terminal.input("Continue Main after recovery.");
      await ui.terminal.waitForFrameAfter("Continue Main after recovery.", nextDraftOffset);
      const nextSubmitOffset = ui.terminal.output().length;
      ui.terminal.input("\r");
      await ui.terminal.waitForFrameAfter("Main after recovery completed.", nextSubmitOffset);
      await ui.terminal.waitForScreen(idleFrame);
      const nextRecords = (await store.read()).slice(afterRecovery.length);
      expect(nextRecords).toContainEqual(
        expect.objectContaining({
          record: expect.objectContaining({
            type: "runtime_event",
            event: { type: "user_message", text: "Continue Main after recovery." },
          }),
        }),
      );
      expect(nextRecords).toContainEqual(
        expect.objectContaining({
          record: expect.objectContaining({
            type: "runtime_event",
            event: {
              type: "session_settled",
              result: { status: "completed", answer: "Main after recovery completed." },
            },
          }),
        }),
      );
      expect(ui.presentation.getState().executionFailure).toBeUndefined();
    } finally {
      unsubscribe?.();
      if (logPath !== undefined) await chmod(logPath, 0o600);
      if (ui?.terminal.running()) ui.terminal.input("\u0011");
      await ui?.running;
      await lifecycle.close();
      if (previousNoColor === undefined) delete environment.NO_COLOR;
      else environment.NO_COLOR = previousNoColor;
      await rm(root, { recursive: true, force: true });
    }
  },
);
