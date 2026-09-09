import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createJsonlSessionStoreDirectory, type SessionRecord } from "@adam-agent/agent";
import { sessionCatalogWorkerFactory } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createPresentationSession,
  createSessionLifecycle,
  settledModelTargets,
  targetIdentity,
} from "./presentation-session.test-support.js";

test.each(["deleted", "invalid-beyond-display-cap", "renamed-at-same-sequence"] as const)(
  "background catalog reconciles a formerly selected session that is %s",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "adam-background-catalog-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const heldAuthority = Promise.withResolvers<() => void>();
    let hold = true;
    const lifecycle = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets: settledModelTargets(),
      [sessionCatalogWorkerFactory]: (url, options) => {
        const worker = new Worker(url, options);
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
          const message = args[0];
          if (hold && message?.type === "authority_result") {
            hold = false;
            heldAuthority.resolve(() => post(...args));
          } else post(...args);
        };
        return worker;
      },
    });
    let release: (() => void) | undefined;
    try {
      const previous = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: previous.sessionId,
        input: { text: "Previous session" },
      });
      await lifecycle.setSessionManualName({
        sessionId: previous.sessionId,
        name: "Previous session",
      });
      const current = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: current.sessionId,
        input: { text: "Current session" },
      });
      await lifecycle.setSessionManualName({
        sessionId: current.sessionId,
        name: "Current session",
      });
      const sessionRoot = join(
        stateRoot,
        "projects",
        previous.projectId.slice("sha256:".length),
        "sessions",
      );
      if (change === "invalid-beyond-display-cap") {
        // These valid v1 UUIDs sort before any randomUUID-created v4 session.
        for (let i = 0; i < 100; i++)
          await writeFile(
            join(sessionRoot, `00000000-0000-1000-8000-${String(i).padStart(12, "0")}.jsonl`),
            "{invalid}\n",
          );
      }
      const presentation = await createPresentationSession({
        lifecycle,
        workspaceRoot,
        stateRoot,
        projectLabel: "workspace",
        sessionId: previous.sessionId,
        backgroundStartup: true,
      });
      try {
        const complete = Promise.withResolvers<void>();
        const unsubscribe = presentation.subscribe(() => {
          if (presentation.getState().authoritative.sessions.health?.status === "complete")
            complete.resolve();
        });
        try {
          release = await withManagedFailureGuard(
            heldAuthority.promise,
            "held catalog authority response",
          );
          expect(
            presentation.getState().authoritative.sessions.items.map((item) => item.id),
          ).toContain(current.sessionId);
          await expect(
            presentation.dispatch({ type: "select_session", sessionId: current.sessionId }),
          ).resolves.toMatchObject({ status: "admitted" });
          const previousPath = join(sessionRoot, `${previous.sessionId}.jsonl`);
          if (change === "deleted") await unlink(previousPath);
          else if (change === "renamed-at-same-sequence") {
            const before = await readFile(previousPath, "utf8");
            const entries = before
              .trimEnd()
              .split("\n")
              .map((line) => JSON.parse(line) as SessionRecord);
            const after = `${entries
              .map((entry) =>
                JSON.stringify(
                  entry.schemaVersion === 3 && entry.record.type === "session_manual_name_set"
                    ? { ...entry, record: { ...entry.record, name: "External session" } }
                    : entry,
                ),
              )
              .join("\n")}\n`;
            expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
            await writeFile(previousPath, after);
          } else await writeFile(previousPath, "{invalid}\n");
          release();
          await withManagedFailureGuard(complete.promise, "complete background catalog");
          const state = presentation.getState();
          expect(state.authoritative.active?.session.id).toBe(current.sessionId);
          expect(state.authoritative.sessions.items.map((item) => item.id)).toEqual([
            current.sessionId,
            ...(change === "renamed-at-same-sequence" ? [previous.sessionId] : []),
          ]);
          if (change === "renamed-at-same-sequence")
            expect(
              state.authoritative.sessions.items.find((item) => item.id === previous.sessionId)
                ?.label,
            ).toBe("External session");
          if (change === "invalid-beyond-display-cap") {
            expect(state.authoritative.sessions.diagnostics).toMatchObject({
              totalCount: 101,
              truncated: true,
            });
            expect(state.authoritative.sessions.diagnostics?.items).toHaveLength(100);
            expect(
              state.authoritative.sessions.diagnostics?.items.some(
                (item) => item.sessionId === previous.sessionId,
              ),
            ).toBe(false);
          }
          const records = await createJsonlSessionStoreDirectory({
            workspaceRoot,
            stateRoot,
          }).readRecords?.(current.sessionId);
          expect(records?.length).toBeGreaterThan(0);
        } finally {
          unsubscribe();
        }
      } finally {
        release?.();
        await presentation.close();
      }
    } finally {
      release?.();
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
