import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPermissionPolicy,
  createPresentationSession,
  createReadToolRegistry,
  type ProjectSessionCatalogSnapshot,
} from "@adam-agent/agent";
import { createJsonlManagedAgentControlStore } from "@adam-agent/agent/internal-testing";
import { expect, test } from "vitest";
import { FakeModelDriver } from "./index.js";
import { withManagedFailureGuard } from "./managed-agent-test-support.js";
import {
  createSessionLifecycleForTests,
  modelTargetsWithDriver,
  sessionLifecycleTargetIdentity as targetIdentity,
} from "./session-lifecycle.test-support.js";

test("archive CAS survives cold reopen without changing history and corrupt metadata remains read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-visibility-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(
      new FakeModelDriver(() => [
        { type: "text_delta", text: "Archived history remains readable." },
        { type: "finish", reason: "stop" },
      ]),
    ),
    tools: createReadToolRegistry({ workspaceRoot }),
    permissions: createPermissionPolicy({ allowedEffects: ["read"] }),
  };
  let lifecycle = createSessionLifecycleForTests(options);
  try {
    const first = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: first.sessionId, input: { text: "Keep this history" } });
    const project = createHash("sha256")
      .update(await realpath(workspaceRoot))
      .digest("hex");
    const log = join(stateRoot, "projects", project, "sessions", `${first.sessionId}.jsonl`);
    const metadata = join(stateRoot, "projects", project, "session-visibility", "index.json");
    const original = await readFile(log);
    const results = await Promise.all([
      lifecycle.setSessionVisibility({
        sessionId: first.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
      lifecycle.setSessionVisibility({
        sessionId: first.sessionId,
        visibility: "active",
        expectedRevision: 0,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["updated", "stale"]);
    expect(await readFile(log)).toEqual(original);
    expect((await stat(metadata)).mode & 0o777).toBe(0o600);
    expect((await lifecycle.listProjectSessionSummaries()).items).toEqual([]);
    await lifecycle.close();
    lifecycle = createSessionLifecycleForTests(options);
    const archived = await lifecycle.listProjectSessionSummaries({ view: "archived", limit: 1 });
    expect(archived.items.map((item) => item.sessionId)).toEqual([first.sessionId]);
    expect(archived.visibility).toEqual({
      status: "ready",
      revision: 1,
      archived: [first.sessionId],
    });
    expect((await lifecycle.inspect({ sessionId: first.sessionId })).status).toBe("settled");
    const source = await lifecycle.inspect({ sessionId: first.sessionId });
    const derived = await lifecycle.branch({
      parentSessionId: first.sessionId,
      atSequence: source.lastSequence,
    });
    expect((await lifecycle.inspect({ sessionId: derived.sessionId })).schemaVersion).toBe(3);
    expect(derived.lineage?.parentSessionId).toBe(first.sessionId);
    const previousIndex = await open(metadata, "r");
    try {
      expect(
        (
          await lifecycle.setSessionVisibility({
            sessionId: first.sessionId,
            visibility: "active",
            expectedRevision: 1,
          })
        ).status,
      ).toBe("updated");
      expect(JSON.parse(await previousIndex.readFile("utf8"))).toMatchObject({
        revision: 1,
        archived: [first.sessionId],
      });
      expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({
        revision: 2,
        archived: [],
      });
    } finally {
      await previousIndex.close();
    }
    expect(
      (await lifecycle.listProjectSessionSummaries()).items.map((item) => item.sessionId),
    ).toEqual([first.sessionId]);
    await writeFile(metadata, "{broken metadata", { mode: 0o600 });
    const recovery = await lifecycle.listProjectSessionSummaries();
    expect(recovery.visibility?.status).toBe("unknown");
    expect(recovery.items.map((item) => item.sessionId)).toEqual([first.sessionId]);
    expect(
      (
        await lifecycle.setSessionVisibility({
          sessionId: first.sessionId,
          visibility: "archived",
          expectedRevision: 2,
        })
      ).status,
    ).toBe("unavailable");
    expect(await readFile(metadata, "utf8")).toBe("{broken metadata");
    expect((await lifecycle.inspect({ sessionId: first.sessionId })).status).toBe("settled");
    expect(await readFile(log)).toEqual(original);
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Presentation archives the current idle session and restores its saved draft through Archived and Undo", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-archive-draft-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const modelTargets = modelTargetsWithDriver(
    new FakeModelDriver([
      { type: "text_delta", text: "Retained conversation" },
      { type: "finish", reason: "stop" },
    ]),
  );
  const lifecycle = createSessionLifecycleForTests({ workspaceRoot, stateRoot, modelTargets });
  let presentation: Awaited<ReturnType<typeof createPresentationSession>> | undefined;
  try {
    const session = await lifecycle.create({ targetIdentity });
    await lifecycle.continue({ sessionId: session.sessionId, input: { text: "Remember my work" } });
    presentation = await createPresentationSession({
      projectLabel: "Archive fixture",
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot,
      sessionId: session.sessionId,
    });
    expect(
      (await presentation.dispatch({ type: "update_draft_text", text: "Unsaved next question" }))
        .status,
    ).toBe("admitted");
    const receipt = await presentation.dispatch({
      type: "set_session_visibility",
      sessionId: session.sessionId,
      visibility: "archived",
      expectedRevision: 0,
    });
    expect(receipt).toMatchObject({ status: "admitted", sessionVisibility: { revision: 1 } });
    expect(presentation.getState().authoritative.active).toBeNull();
    expect(presentation.getState().authoritative.sessions.items).toEqual([]);
    expect(
      (await presentation.dispatch({ type: "set_session_view", view: "archived" })).status,
    ).toBe("admitted");
    expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
      session.sessionId,
    ]);
    expect(
      (await presentation.dispatch({ type: "select_session", sessionId: session.sessionId }))
        .status,
    ).toBe("admitted");
    expect(await presentation.dispatch({ type: "read_expanded_draft" })).toMatchObject({
      status: "admitted",
      draftText: "Unsaved next question",
    });
    expect(
      (
        await presentation.dispatch({
          type: "set_session_visibility",
          sessionId: session.sessionId,
          visibility: "active",
          expectedRevision: 1,
        })
      ).status,
    ).toBe("admitted");
    expect(presentation.getState().authoritative.sessions.items).toEqual([]);
    expect((await presentation.dispatch({ type: "set_session_view", view: "active" })).status).toBe(
      "admitted",
    );
    expect(presentation.getState().authoritative.sessions.items.map((item) => item.id)).toEqual([
      session.sessionId,
    ]);
    await presentation.close();
    presentation = await createPresentationSession({
      projectLabel: "Archive fixture",
      lifecycle,
      modelTargets,
      workspaceRoot,
      stateRoot,
      sessionId: session.sessionId,
    });
    expect(await presentation.dispatch({ type: "read_expanded_draft" })).toMatchObject({
      status: "admitted",
      draftText: "Unsaved next question",
    });
  } finally {
    await presentation?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native catalog filters archive metadata before paging and cold history inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-archive-pages-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const lifecycle = createSessionLifecycleForTests({
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(new FakeModelDriver([{ type: "finish", reason: "stop" }])),
  });
  let controller: ReturnType<typeof lifecycle.startProjectSessionCatalog> | undefined;
  try {
    const archivedIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const session = await lifecycle.create({ targetIdentity });
      await lifecycle.continue({
        sessionId: session.sessionId,
        input: { text: `History ${index}` },
      });
      if (index % 2 === 0) {
        expect(
          (
            await lifecycle.setSessionVisibility({
              sessionId: session.sessionId,
              visibility: "archived",
              expectedRevision: archivedIds.length,
            })
          ).status,
        ).toBe("updated");
        archivedIds.push(session.sessionId);
      }
    }
    const ready = Promise.withResolvers<ProjectSessionCatalogSnapshot>();
    const second = Promise.withResolvers<ProjectSessionCatalogSnapshot>();
    controller = lifecycle.startProjectSessionCatalog({
      view: "archived",
      limit: 1,
      onUpdate(snapshot) {
        if (snapshot.phase === "failed") {
          ready.reject(new Error("Catalog failed"));
          second.reject(new Error("Catalog failed"));
        }
        if (snapshot.phase === "ready" && snapshot.items.length === 1) ready.resolve(snapshot);
        if (snapshot.items.length === 2 && snapshot.health.status === "complete")
          second.resolve(snapshot);
      },
    });
    const firstPage = await withManagedFailureGuard(ready.promise, "archived native first page");
    expect(firstPage.items.every((item) => archivedIds.includes(item.sessionId))).toBe(true);
    expect(firstPage.visibility).toMatchObject({ status: "ready", revision: 2 });
    expect(firstPage.nextCursor).not.toBeNull();
    await controller.loadMore(firstPage.nextCursor as string);
    const finalPage = await withManagedFailureGuard(second.promise, "archived native second page");
    expect(finalPage.items.map((item) => item.sessionId).sort()).toEqual(archivedIds.sort());
    expect(finalPage.nextCursor).toBeNull();
  } finally {
    await controller?.close();
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cold archive detects durable Child permission work without a composed Control runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "adam-archive-cold-child-"));
  const workspaceRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(workspaceRoot);
  const options = {
    workspaceRoot,
    stateRoot,
    modelTargets: modelTargetsWithDriver(
      new FakeModelDriver(() => {
        throw new Error("Inspection must not start a provider.");
      }),
    ),
  };
  let lifecycle = createSessionLifecycleForTests(options);
  try {
    const parent = await lifecycle.create({ targetIdentity });
    const store = await createJsonlManagedAgentControlStore(options);
    await store.forParent(parent.sessionId).preflight?.();
    const identity = {
      schemaVersion: 3 as const,
      parentSessionId: parent.sessionId,
      threadId: randomUUID(),
      turnId: randomUUID(),
      attemptId: randomUUID(),
      childSessionId: randomUUID(),
    };
    await store.append({
      ...identity,
      sequence: 1,
      event: {
        type: "admitted",
        role: "builtin:explore",
        description: "Cold pending permission",
        task: "Inspect",
      },
    });
    await store.append({ ...identity, sequence: 2, event: { type: "started" } });
    await store.append({
      ...identity,
      sequence: 3,
      event: { type: "capacity_wait", reason: "permission" },
    });
    await lifecycle.close();
    lifecycle = createSessionLifecycleForTests(options);
    expect(
      await lifecycle.setSessionVisibility({
        sessionId: parent.sessionId,
        visibility: "archived",
        expectedRevision: 0,
      }),
    ).toMatchObject({ status: "blocked", message: expect.stringContaining("permission") });
    expect(await store.read()).toHaveLength(3);
  } finally {
    await lifecycle.close();
    await rm(root, { recursive: true, force: true });
  }
});
