import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStoreDirectory } from "@adam-agent/agent";
import {
  presentationCatalogPageSize,
  presentationSessionRecordReader,
  sessionStoreDirectory,
} from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createPresentationSession,
  createSessionLifecycle,
  settledModelTargets,
  targetIdentity,
} from "./presentation-session.test-support.js";

test("Presentation catalog names and pagination use Lifecycle's validated records without separate history reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-catalog-naming-"));
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycle({
    workspaceRoot,
    stateRoot,
    modelTargets: settledModelTargets(),
  });
  try {
    const sessions = [];
    for (const name of ["First named session", "Second named session"]) {
      const session = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({ sessionId: session.sessionId, input: { text: name } });
      await lifecycle.setSessionManualName({ sessionId: session.sessionId, name });
      sessions.push(session.sessionId);
    }
    const directory = createJsonlSessionStoreDirectory({ workspaceRoot, stateRoot });
    const presentationReads: string[] = [];
    const presentation = await createPresentationSession({
      lifecycle,
      workspaceRoot,
      stateRoot,
      projectLabel: "workspace",
      openProject: true,
      [presentationCatalogPageSize]: 1,
      [presentationSessionRecordReader]: async (sessionId) => {
        presentationReads.push(sessionId);
        return (await directory.open(sessionId))?.read() ?? [];
      },
    });
    try {
      expect(
        presentation.getState().authoritative.sessions.items.map(({ label }) => label),
      ).toEqual(["Second named session"]);
      const cursor = presentation.getState().authoritative.sessions.nextCursor;
      if (cursor === null) throw new Error("The first catalog page needs a continuation cursor.");
      await expect(
        presentation.dispatch({ type: "load_more_sessions", after: cursor }),
      ).resolves.toMatchObject({ status: "admitted" });
      expect(
        presentation
          .getState()
          .authoritative.sessions.items.map(({ id, label }) => ({ id, label })),
      ).toEqual([
        { id: sessions[1], label: "Second named session" },
        { id: sessions[0], label: "First named session" },
      ]);
      expect(presentationReads).toEqual([]);
    } finally {
      await presentation.close();
    }
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["rewrite", "append", "disappear", "genesis-only", "invalid-log"] as const)(
  "full catalog summaries observe %s after the admission read without mixing naming versions",
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), "adam-catalog-coherence-"));
    const workspaceRoot = join(root, "workspace");
    const stateRoot = join(root, "state");
    await mkdir(workspaceRoot);
    const modelTargets = settledModelTargets();
    const author = createSessionLifecycle({ workspaceRoot, stateRoot, modelTargets });
    const directory = createJsonlSessionStoreDirectory({ workspaceRoot, stateRoot });
    const readReady = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let holdNextRead = true;
    const reader = createSessionLifecycle({
      workspaceRoot,
      stateRoot,
      modelTargets,
      [sessionStoreDirectory]: {
        ...directory,
        async readRecords(sessionId) {
          const records = await directory.readRecords?.(sessionId);
          if (holdNextRead) {
            holdNextRead = false;
            readReady.resolve();
            await releaseRead.promise;
          }
          return records;
        },
      },
    });
    try {
      const session = await author.create({ targetIdentity });
      await author.continue({ sessionId: session.sessionId, input: { text: "Catalog coherence" } });
      const named = await author.setSessionManualName({
        sessionId: session.sessionId,
        name: "Before",
      });
      await author.close();
      const path = join(
        stateRoot,
        "projects",
        session.projectId.replace(/^sha256:/u, ""),
        "sessions",
        `${session.sessionId}.jsonl`,
      );
      const original = await readFile(path, "utf8");
      const pending = reader.listProjectSessionSummaries();
      await withManagedFailureGuard(readReady.promise, "catalog admission read");
      if (change === "disappear") {
        await rm(path);
      } else if (change === "genesis-only") {
        const records = original.trimEnd().split("\n");
        const admissionIndex = records.findIndex((line) =>
          line.includes('"type":"logical_run_started"'),
        );
        expect(admissionIndex).toBeGreaterThan(0);
        await writeFile(path, `${records.slice(0, admissionIndex).join("\n")}\n`, "utf8");
      } else if (change === "append") {
        const store = await directory.open(session.sessionId);
        if (store === undefined) throw new Error("Expected the catalog fixture log.");
        await store.append({
          schemaVersion: 3,
          sequence: named.snapshot.lastSequence + 1,
          record: { type: "session_manual_name_set", recordVersion: 1, name: "After!" },
        });
      } else {
        const rewritten =
          change === "rewrite"
            ? original.replace('"name":"Before"', '"name":"After!"')
            : original.replace('"name":"Before"', '"name":false   ');
        expect(rewritten).not.toBe(original);
        expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
        await writeFile(path, rewritten, "utf8");
      }
      releaseRead.resolve();
      const page = await withManagedFailureGuard(pending, "fresh catalog summary");
      if (change === "disappear" || change === "genesis-only") {
        expect(page.items).toEqual([]);
        expect(page.diagnostics).toEqual({ items: [], totalCount: 0, truncated: false });
        const full = await reader.listProjectSessions();
        expect(full.items).toEqual([]);
        expect(full.diagnostics).toEqual(page.diagnostics);
      } else if (change === "invalid-log") {
        expect(page.items).toEqual([]);
        expect(page.diagnostics).toMatchObject({
          totalCount: 1,
          items: [
            { sessionId: session.sessionId, code: "invalid_log", stage: "read", retained: true },
          ],
        });
      } else {
        expect(page.items).toMatchObject([
          {
            sessionId: session.sessionId,
            schemaVersion: 3,
            targetIdentity,
            status: named.snapshot.status,
            lastSequence: named.snapshot.lastSequence + (change === "append" ? 1 : 0),
            naming: { manualName: "After!", displayLabel: "After!" },
          },
        ]);
        const full = await reader.listProjectSessions();
        expect(full.items).toEqual([await reader.inspect({ sessionId: session.sessionId })]);
        expect(full.diagnostics).toEqual(page.diagnostics);
      }
    } finally {
      releaseRead.resolve();
      await reader.close();
      await author.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
