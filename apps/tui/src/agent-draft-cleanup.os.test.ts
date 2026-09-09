import { chmod, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startManagedTui } from "./agent-fleet.test-support.js";

test.each(["message", "role"] as const)(
  "accepted %s survives a draft cleanup failure without losing its draft or receipt",
  async (kind) => {
    let draftsRoot: string | undefined;
    let armed = false;
    const started = Promise.withResolvers<void>();
    const h = await startManagedTui(
      {
        async *stream(request) {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "finish", reason: "stop" };
        },
      },
      {
        draftPersistencePolicy: "recoverable",
        controlRecordBarrier: async (record) => {
          if (armed && record.event.type === (kind === "message" ? "input_accepted" : "admitted")) {
            if (draftsRoot === undefined) throw new Error("Missing owned draft directory.");
            await chmod(draftsRoot, 0o500);
          }
        },
      },
    );
    try {
      if (kind === "message") {
        expect(
          await h.presentation.dispatch({
            type: "managed_control",
            commandId: "cleanup-fixture",
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
      }
      const recipient = kind === "message" ? "@explore-1" : "@Explore";
      await h.press(recipient, kind === "message" ? "> explore-1" : "New agent · Explore");
      await h.press("\t", recipient);
      await h.press(" Keep this draft.", "Keep this draft.");
      await h.press("\r", kind === "message" ? "Send to @explore-1" : "Delegation");
      const projects = await readdir(join(h.storage.stateRoot, "drafts"));
      expect(projects).toHaveLength(1);
      draftsRoot = join(h.storage.stateRoot, "drafts", projects[0] as string);
      const files = await readdir(draftsRoot);
      const before = await Promise.all(
        files.map((name) => readFile(join(draftsRoot as string, name), "utf8")),
      );
      expect(before.join("\n")).toContain("Keep this draft.");
      armed = true;
      await h.press("\r", "Draft cleanup failed");
      expect(h.presentation.getState().composer.renderedText).toBe(`${recipient} Keep this draft.`);
      expect(h.terminal.lines().join("\n")).toContain("Keep this draft.");
      expect(h.terminal.lines().join("\n")).not.toContain("could not be accepted");
      expect(
        (await h.store.read()).filter(
          (record) => record.event.type === (kind === "message" ? "input_accepted" : "admitted"),
        ),
      ).toHaveLength(1);
      expect(
        await Promise.all(files.map((name) => readFile(join(draftsRoot as string, name), "utf8"))),
      ).toEqual(before);
    } finally {
      armed = false;
      if (draftsRoot !== undefined) await chmod(draftsRoot, 0o700);
      await h.close();
    }
  },
);
