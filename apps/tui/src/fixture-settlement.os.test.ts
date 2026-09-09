import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresentationSession } from "@adam-agent/presentation";
import { expect, test } from "vitest";
import { awaitEveReceipt as awaitReceipt } from "./public-eve.test-support.js";
import { runTuiFixture } from "./test-fixture.js";
import {
  readFilesRecursively,
  removeTuiFixtureRoot as rm,
  waitForFileContents,
} from "./tui-filesystem.test-support.js";
import { VirtualTerminal } from "./virtual-terminal.test-support.js";

test.each(["completed", "failed"] as const)(
  "reasoning storage baseline waits for naming to settle as %s without requiring a title",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "adam-fixture-settlement-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    const controlRoot = join(root, "control");
    await mkdir(workspaceRoot);
    await mkdir(controlRoot);
    const terminal = new VirtualTerminal();
    const titleStarted = Promise.withResolvers<void>();
    const releaseTitle = Promise.withResolvers<void>();
    const mainReady = Promise.withResolvers<void>();
    const namingSettled = Promise.withResolvers<string>();
    let presentation: PresentationSession | undefined;
    let unsubscribe: (() => void) | undefined;
    const execution = runTuiFixture({
      scenario: "reasoning-artifact",
      workspaceRoot,
      stateRoot,
      controlRoot,
      terminal,
      async titleResponse() {
        titleStarted.resolve();
        await releaseTitle.promise;
        return outcome === "completed" ? "Fixture title" : "";
      },
      onPresentationReady(current) {
        presentation = current;
        unsubscribe = current.subscribe(() => {
          const state = current.getState();
          const active = state.authoritative.active;
          if (
            active?.parentRun?.phase === "ready" &&
            active.transcript.items.some((item) => item.type === "reasoning_block")
          )
            mainReady.resolve();
          if (
            active?.session.naming.generation.status === outcome &&
            state.authoritative.continuity.status === "current"
          )
            namingSettled.resolve(
              `${JSON.stringify({
                sessionId: active.session.id,
                throughSequence: state.authoritative.continuity.sessionThroughSequence,
                naming: outcome,
              })}\n`,
            );
        });
      },
    });
    try {
      await terminal.waitForScreen("Adam · New session");
      const beforePrompt = terminal.output().length;
      terminal.input("Freeze a completed reasoning view\r");
      await awaitReceipt(titleStarted.promise, "held title producer");
      await awaitReceipt(mainReady.promise, "Main ready with title still held");
      expect(presentation?.getState().authoritative.active?.session.naming.generation.status).toBe(
        "in_progress",
      );
      await expect(access(join(controlRoot, "reasoning-session-settled"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      releaseTitle.resolve();
      const marker = await awaitReceipt(namingSettled.promise, "settled title projection");
      await waitForFileContents(join(controlRoot, "reasoning-session-settled"), marker);
      await terminal.waitForFrameAfter("Thinking done · adam", beforePrompt);
      const baseline = await readFilesRecursively(stateRoot);
      const beforeExpand = terminal.output().length;
      terminal.input("\u0014");
      await waitForFileContents(join(controlRoot, "artifact-read-1-range"), "0:16384\n");
      await terminal.waitForFrameAfter("Large reasoning · plain view", beforeExpand);
      expect(await readFilesRecursively(stateRoot)).toBe(baseline);
      expect(presentation?.getState().authoritative.active?.session.naming.generation.status).toBe(
        outcome,
      );
    } finally {
      releaseTitle.resolve();
      unsubscribe?.();
      if (terminal.running()) terminal.input("\u0011");
      await execution;
      await rm(root, { recursive: true, force: true });
    }
  },
);
