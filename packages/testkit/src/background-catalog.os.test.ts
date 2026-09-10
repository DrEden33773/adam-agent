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

async function waitForCatalog(
  presentation: Awaited<ReturnType<typeof createPresentationSession>>,
  predicate: () => boolean,
  missing: string,
) {
  const ready = Promise.withResolvers<void>();
  const observe = () => {
    if (predicate()) ready.resolve();
  };
  const unsubscribe = presentation.subscribe(observe);
  try {
    observe();
    await withManagedFailureGuard(ready.promise, missing);
  } finally {
    unsubscribe();
  }
}

test("an external archive revision invalidates an in-progress catalog without retaining rows in the wrong view", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-visibility-generation-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  let hold = true;
  const held = Promise.withResolvers<() => void>();
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
    [sessionCatalogWorkerFactory]: (url, options) => {
      const worker = new Worker(url, options);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (...args: Parameters<Worker["postMessage"]>) => {
        if (hold && args[0]?.type === "authority_result") {
          hold = false;
          held.resolve(() => post(...args));
        } else post(...args);
      };
      return worker;
    },
  });
  const other = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  let release: (() => void) | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "External archive" } });
    await lifecycle.setSessionManualName({
      sessionId: session.sessionId,
      name: "External archive",
    });
    presentation = await createPresentationSession({
      lifecycle,
      workspaceRoot,
      stateRoot,
      openProject: true,
      projectLabel: "workspace",
      backgroundStartup: true,
    });
    const current = presentation;
    release = await withManagedFailureGuard(held.promise, "held background inspection authority");
    expect(current.getState().authoritative.sessions.items.map((item) => item.id)).toContain(
      session.sessionId,
    );
    expect(
      await other.setSessionVisibility({
        sessionId: session.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: "updated" });
    release();
    await waitForCatalog(
      current,
      () => current.getState().authoritative.sessions.health?.status === "failed",
      "changed visibility invalidates catalog",
    );
    expect(current.getState().authoritative.sessions).toMatchObject({
      view: "active",
      items: [],
      loading: false,
      visibility: { status: "ready", revision: 1, archived: [session.sessionId] },
    });
    await current.dispatch({ type: "set_session_view", view: "archived" });
    await waitForCatalog(
      current,
      () => current.getState().authoritative.sessions.health?.status === "complete",
      "fresh Archived catalog",
    );
    expect(current.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
      session.sessionId,
    ]);
  } finally {
    release?.();
    await presentation?.close();
    await other.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("late catalog frames cannot overwrite an archive receipt or the user's newer page", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-late-view-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const held = Promise.withResolvers<void>();
  const deliveries: Array<() => void> = [];
  let first = true;
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
    [sessionCatalogWorkerFactory]: (url, options) => {
      const worker = new Worker(url, options);
      if (first) {
        first = false;
        const emit = worker.emit.bind(worker);
        worker.emit = (...args: Parameters<Worker["emit"]>) => {
          const [event, message] = args;
          if (
            event === "message" &&
            message?.type === "update" &&
            message.snapshot.phase !== "loading"
          ) {
            deliveries.push(() => {
              emit(...args);
            });
            held.resolve();
            return true;
          }
          return emit(...args);
        };
      }
      return worker;
    },
  });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "Late archive" } });
    await lifecycle.setSessionManualName({ sessionId: session.sessionId, name: "Late archive" });
    presentation = await createPresentationSession({
      lifecycle,
      workspaceRoot,
      stateRoot,
      sessionId: session.sessionId,
      projectLabel: "workspace",
      backgroundStartup: true,
    });
    const current = presentation;
    await withManagedFailureGuard(held.promise, "old native catalog frame");
    expect(
      await current.dispatch({
        type: "set_session_visibility",
        sessionId: session.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: "admitted" });
    await current.dispatch({ type: "set_session_view", view: "archived" });
    await waitForCatalog(
      current,
      () => current.getState().authoritative.sessions.health?.status === "complete",
      "new archived generation",
    );
    for (const deliver of deliveries) deliver();
    expect(current.getState().authoritative.sessions).toMatchObject({
      view: "archived",
      visibility: { status: "ready", revision: 1 },
      items: [{ id: session.sessionId, label: "Late archive" }],
    });
    await current.dispatch({ type: "set_session_view", view: "trash" });
    for (const deliver of deliveries) deliver();
    expect(current.getState().authoritative.sessions).toMatchObject({ view: "trash", items: [] });
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
