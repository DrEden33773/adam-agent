import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";
import { terminalObservationTimeoutMilliseconds } from "./virtual-terminal.test-support.js";

const filesystem = vi.hoisted(() => ({
  beforeUnlink: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      await filesystem.beforeUnlink?.(String(path));
      return actual.unlink(path);
    },
  };
});

test.each(["success", "failure"] as const)(
  "a newer Main draft survives accepted-input cleanup %s while filesystem deletion is pending",
  async (outcome) => {
    const started = Promise.withResolvers<void>();
    const deleting = Promise.withResolvers<void>();
    const releaseDelete = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<never>();
    let calls = 0;
    const h = await startManagedTui(
      {
        async *stream(request) {
          calls += 1;
          started.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "finish", reason: "stop" };
        },
      },
      { draftPersistencePolicy: "recoverable" },
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    let edit: ReturnType<typeof h.presentation.dispatch> | undefined;
    try {
      expect(
        await h.presentation.dispatch({
          type: "managed_control",
          commandId: "cleanup-overlap-fixture",
          command: {
            type: "spawn_agents",
            parentSessionId: h.parent.sessionId,
            entries: [
              { role: "builtin:explore", task: "Original work.", description: "Original work" },
            ],
          },
        }),
      ).toMatchObject({ status: "admitted" });
      await started.promise;
      await h.press("@explore-1", "> [Agent] @explore-1");
      await h.press("\t", "@explore-1");
      await h.press(" Accepted original input.", "Accepted original input.");
      await h.press("\r", "Send to @explore-1");
      const projects = await readdir(join(h.storage.stateRoot, "drafts"));
      expect(projects).toHaveLength(1);
      const draftsRoot = join(h.storage.stateRoot, "drafts", projects[0] as string);
      const manifest = join(draftsRoot, `session-${h.parent.sessionId}.json`);
      filesystem.beforeUnlink = async (path) => {
        if (path !== manifest) return;
        filesystem.beforeUnlink = undefined;
        deleting.resolve();
        await releaseDelete.promise;
        if (outcome === "failure")
          throw Object.assign(new Error("The held draft deletion failed."), { code: "EACCES" });
      };
      guard = setTimeout(
        () => failure.reject(new Error("Accepted-input draft cleanup did not reach unlink.")),
        terminalObservationTimeoutMilliseconds,
      );
      h.terminal.input("\r");
      await Promise.race([deleting.promise, failure.promise]);
      const beforeEdit = h.terminal.output().length;
      edit = h.presentation.dispatch({ type: "update_draft_text", text: " Newer Main draft." });
      // The public read proves the newer mutation reached the composer before deletion resumes.
      expect(await h.presentation.dispatch({ type: "read_expanded_draft" })).toMatchObject({
        status: "admitted",
        draftText: expect.stringContaining("Newer Main draft."),
      });
      releaseDelete.resolve();
      expect(await edit).toMatchObject({ status: "admitted" });
      await h.terminal.waitForFrameAfter("Input accepted for @explore-1", beforeEdit);
      expect(h.presentation.getState().composer.renderedText).toBe("@explore-1 Newer Main draft.");
      await h.terminal.waitForFrameAfter("Newer Main draft.", beforeEdit);
      expect(h.terminal.lines().join("\n")).not.toContain("Accepted original input.");
      expect(await readFile(manifest, "utf8")).toContain("Newer Main draft.");
      expect(
        (await h.store.read()).filter((record) => record.event.type === "input_accepted"),
      ).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ mode: "cooperative", text: "Accepted original input." }),
        }),
      ]);
      expect(calls).toBe(1);
    } finally {
      clearTimeout(guard);
      filesystem.beforeUnlink = undefined;
      releaseDelete.resolve();
      await edit?.catch(() => undefined);
      await h.close();
    }
  },
);
